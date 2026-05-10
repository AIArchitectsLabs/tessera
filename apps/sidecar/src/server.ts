import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentProfile,
  AgentTurnRequestSchema,
  AuditRecordSchema,
  ClarifyRequestSchema,
  ClarifyResponseSchema,
  InboxCancelRequestSchema,
  InboxCreateRequestSchema,
  InboxListResultSchema,
  InboxMessageTypeSchema,
  InboxResolveRequestSchema,
  InboxSnoozeRequestSchema,
  InboxStatusSchema,
  NotifyRequestSchema,
  PlaybookDetailSchema,
  PlaybookListResultSchema,
  PlaybookRunDetailSchema,
  type PlaybookSummary,
  PlaybookSummarySchema,
  SidecarReadySchema,
  SpawnRequestSchema,
  type SpawnResult,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskListResultSchema,
  type TaskSkillActivation,
  TaskUpdateRequestSchema,
  TodoOperationSchema,
  type WorkflowDefinition,
  WorkflowResumeRequestSchema,
  WorkflowRunAssignmentPlanSchema,
  WorkflowRunListResultSchema,
  WorkflowRunRequestSchema,
  WorkflowRunStatusSchema,
  compileAgentRuntimeContext,
} from "@tessera/contracts";
import {
  AgentProfileCreateRequestSchema,
  AgentProfileUpdateRequestSchema,
} from "@tessera/contracts";
import {
  CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW,
  DEFAULT_AGENT_PROFILE,
  DEMO_WORKFLOW,
  SALES_MEETING_BRIEF_WORKFLOW,
  WEEKLY_STATUS_DIGEST_WORKFLOW,
  WEEKLY_UPDATE_WORKFLOW,
  executeAgentTurn,
  resolveSlashSkillInvocation,
  resumeWorkflowRun,
  runWorkflow,
} from "@tessera/core";
import { createAgentProfileStore } from "./agent-profile-store.js";
import {
  createPlaywrightBrowserExecutor,
  resolveBrowserRuntimeConfigFromEnv,
} from "./browser-runtime.js";
import { mergeDefaultAgentProfile } from "./default-agent-profile.js";
import { createInboxStore } from "./inbox-store.js";
import {
  buildLocalPlaybookCapabilityInventory,
  mergePlaybookRunMetadata,
  parsePlaybookRunCreateRequest,
  resolveCheckpointedPlaybookExecutionContext,
  resolvePlaybookExecutionContext,
} from "./playbook-routing.js";
import { createTesseraSkillRegistry } from "./skill-registry.js";
import { createTaskEventBus } from "./task-event-bus.js";
import { runTaskTurn } from "./task-runner.js";
import { createTaskStore } from "./task-store.js";
import { createWorkflowCheckpointStore } from "./workflow-store.js";
const TOKEN = randomBytes(32).toString("hex"); // 256-bit bearer token, rotates each launch
const TAURI_ORIGIN = "tauri://localhost";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1 MiB cap per stream
const WORKFLOW_DB_PATH =
  process.env.TESSERA_WORKFLOW_DB_PATH ?? join(homedir(), ".tessera", "workflow-runs.sqlite");
const TASK_DB_PATH =
  process.env.TESSERA_TASK_DB_PATH ?? join(homedir(), ".tessera", "tasks.sqlite");
const TESSERA_DATA_DIR = process.env.TESSERA_DATA_DIR ?? join(homedir(), ".tessera");
const browserExecutor = createPlaywrightBrowserExecutor({
  artifactDir: join(TESSERA_DATA_DIR, "browser-artifacts"),
  profileDir: join(TESSERA_DATA_DIR, "browser-profile"),
  recipeDir: join(TESSERA_DATA_DIR, "browser-recipes"),
  ...resolveBrowserRuntimeConfigFromEnv(),
});
const workflowStore = createWorkflowCheckpointStore(WORKFLOW_DB_PATH);
const taskStore = createTaskStore(TASK_DB_PATH);
const agentProfileStore = createAgentProfileStore(TASK_DB_PATH);
const inboxStore = createInboxStore(TASK_DB_PATH);
const taskEventBus = createTaskEventBus();
const workflowRegistry = new Map([
  [SALES_MEETING_BRIEF_WORKFLOW.id, SALES_MEETING_BRIEF_WORKFLOW],
  [CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW.id, CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW],
  [WEEKLY_STATUS_DIGEST_WORKFLOW.id, WEEKLY_STATUS_DIGEST_WORKFLOW],
  [DEMO_WORKFLOW.id, DEMO_WORKFLOW],
  [WEEKLY_UPDATE_WORKFLOW.id, WEEKLY_UPDATE_WORKFLOW],
]);

function profileForAgentId(agentId: string): AgentProfile {
  if (agentId === "default") return defaultAgentProfile();
  return agentProfileStore.get(agentId) ?? DEFAULT_AGENT_PROFILE;
}

function defaultAgentProfile(): AgentProfile {
  return mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, agentProfileStore.get("default"));
}

function allowedSkillIdsForAgent(agentId: string): string[] {
  return profileForAgentId(agentId).skills ?? [];
}

async function parseSkillInvocation(options: {
  text: string;
  workspaceRoot: string;
  agentId: string;
}): Promise<{
  originalContent: string;
  prompt: string;
  skill?: Omit<TaskSkillActivation, "activatedAt">;
}> {
  const registry = createTesseraSkillRegistry({ workspaceRoot: options.workspaceRoot });
  const allowedSkillIds = allowedSkillIdsForAgent(options.agentId);
  const invocation = await resolveSlashSkillInvocation(options.text, registry, { allowedSkillIds });
  if (!invocation) return { originalContent: options.text, prompt: options.text };
  const detail = await registry.loadSkill(invocation.skillId, { allowedSkillIds });
  return {
    originalContent: options.text,
    prompt: invocation.instruction,
    skill: {
      skillId: detail.id,
      name: detail.name,
      source: detail.source,
      ...(detail.externalProvider ? { externalProvider: detail.externalProvider } : {}),
    },
  };
}

const isWindows = process.platform === "win32";
const socketPath = isWindows ? undefined : join(tmpdir(), `tessera-${process.pid}.sock`);

process.on("exit", () => {
  if (socketPath && existsSync(socketPath)) unlinkSync(socketPath);
  void browserExecutor.dispose();
  workflowStore.close();
  taskStore.close();
  agentProfileStore.close();
  inboxStore.close();
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(0));
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function validateRequest(req: Request): Response | null {
  // Host header allowlist — defeats DNS rebinding
  const [hostname = ""] = (req.headers.get("host") ?? "").split(":");
  if (hostname && !ALLOWED_HOSTS.has(hostname)) return forbidden();

  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return unauthorized();
  return null;
}

function validateWebSocket(req: Request): Response | null {
  const base = validateRequest(req);
  if (base) return base;

  // Origin allowlist on WS upgrades — prevents cross-site WebSocket hijacking
  if (req.headers.get("origin") !== TAURI_ORIGIN) return forbidden();
  return null;
}

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated at 1 MiB]`;
}

function playbookSummary(definition: WorkflowDefinition): PlaybookSummary {
  const phases = definition.phaseOrder ?? [
    ...new Set(definition.steps.map((step) => step.phase ?? "Run")),
  ];
  return PlaybookSummarySchema.parse({
    id: definition.id,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    businessUseCase: definition.businessUseCase,
    requiredCapabilities: definition.requiredCapabilities,
    optionalCapabilities: definition.optionalCapabilities,
    outputs: definition.outputs,
    stepCount: definition.steps.length,
    phases,
  });
}

function playbookRunDetail(run: unknown): unknown {
  const parsed = PlaybookRunDetailSchema.parse(run);
  const definition = workflowRegistry.get(parsed.workflowId);
  return PlaybookRunDetailSchema.parse({
    ...parsed,
    ...(definition ? { playbook: playbookSummary(definition) } : {}),
  });
}

function currentCapabilityInventory() {
  return buildLocalPlaybookCapabilityInventory(agentProfileStore.list());
}

function resolvePlaybookExecutionState(options: {
  definition: WorkflowDefinition;
  capabilityInventory?: unknown;
  assignmentPlan?: unknown;
  existingAssignmentPlan?: unknown;
}) {
  const capabilityInventory =
    (options.capabilityInventory as ReturnType<typeof currentCapabilityInventory>) ??
    currentCapabilityInventory();

  if (options.existingAssignmentPlan) {
    const checkpointOptions: Parameters<typeof resolveCheckpointedPlaybookExecutionContext>[0] = {
      definition: options.definition,
      capabilityInventory,
      existingAssignmentPlan: WorkflowRunAssignmentPlanSchema.parse(options.existingAssignmentPlan),
    };
    if (options.assignmentPlan) {
      checkpointOptions.requestedAssignmentPlan = WorkflowRunAssignmentPlanSchema.parse(
        options.assignmentPlan
      );
    }
    return resolveCheckpointedPlaybookExecutionContext(checkpointOptions);
  }

  return resolvePlaybookExecutionContext({
    definition: options.definition,
    capabilityInventory,
    ...(options.assignmentPlan
      ? { assignmentPlan: WorkflowRunAssignmentPlanSchema.parse(options.assignmentPlan) }
      : {}),
  });
}

async function handleSpawn(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SpawnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  const request = parsed.data;

  try {
    const result = await runWorkspaceCli(request.args, request.timeoutMs);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "SPAWN_FAILED",
      },
      { status: 500 }
    );
  }
}

async function runWorkspaceCli(args: string[], timeoutMs = 10_000): Promise<SpawnResult> {
  // binary enum is validated by Zod; resolve to the path injected by Rust at launch
  const cliPath = process.env.TESSERA_CLI_PATH;
  if (!cliPath) {
    throw new Error("TESSERA_CLI_PATH not configured");
  }

  const startMs = Date.now();
  const proc = Bun.spawn([cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Kill the child on timeout; exited promise still resolves (with a non-zero code)
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [rawStdout, rawStderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const result: SpawnResult = {
    stdout: capOutput(rawStdout),
    stderr: capOutput(rawStderr),
    exitCode,
    signal: proc.signalCode ?? null,
    durationMs: Date.now() - startMs,
  };

  return result;
}

async function handleAgentTurn(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AgentTurnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Model test timed out after ${parsed.data.timeoutMs}ms`)),
        parsed.data.timeoutMs + 5_000
      );
    });
    const result = await Promise.race([
      executeAgentTurn({
        request: parsed.data,
        cli: {
          runWorkspaceCli,
        },
      }),
      timeout,
    ]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleWorkflowRun(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WorkflowRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const definition = workflowRegistry.get(parsed.data.workflowId);
  if (!definition) {
    return Response.json({ error: "Unknown workflow id" }, { status: 404 });
  }

  try {
    const playbookState = resolvePlaybookExecutionState({
      definition,
      capabilityInventory: parsed.data.capabilityInventory,
      assignmentPlan: parsed.data.assignmentPlan,
    });
    const result = await runWorkflow({
      definition,
      input: parsed.data.input,
      cli: {
        runWorkspaceCli,
      },
      ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
      ...(parsed.data.credential?.apiKey ? { agentCredential: parsed.data.credential.apiKey } : {}),
      onCheckpoint(run) {
        workflowStore.save(mergePlaybookRunMetadata(run, playbookState));
      },
    });
    const merged = mergePlaybookRunMetadata(result, playbookState);
    workflowStore.save(merged);
    ensureWorkflowApprovalInbox(merged);
    return Response.json(merged);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

function handleWorkflowRunList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const workflowId = searchParams.get("workflowId") ?? undefined;
  if (workflowId && !workflowRegistry.has(workflowId)) {
    return Response.json({ error: "Unknown workflow id" }, { status: 404 });
  }
  const parsedStatus = status ? WorkflowRunStatusSchema.safeParse(status) : undefined;
  if (parsedStatus && !parsedStatus.success) {
    return Response.json({ error: "Unsupported workflow status filter" }, { status: 400 });
  }

  const result = WorkflowRunListResultSchema.parse({
    runs: workflowStore.list({
      ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
      ...(workflowId ? { workflowId } : {}),
    }),
  });
  return Response.json(result);
}

function handleWorkflowRunGet(req: Request, runId: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const run = workflowStore.get(runId);
  if (!run) return Response.json({ error: "Unknown workflow run" }, { status: 404 });
  return Response.json(run);
}

function handlePlaybookList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  return Response.json(
    PlaybookListResultSchema.parse({
      playbooks: [...workflowRegistry.values()].map((definition) => playbookSummary(definition)),
    })
  );
}

function handlePlaybookGet(req: Request, playbookId: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const definition = workflowRegistry.get(playbookId);
  if (!definition) return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  return Response.json(
    PlaybookDetailSchema.parse({
      ...playbookSummary(definition),
      inputs: definition.inputs,
      steps: definition.steps,
    })
  );
}

async function handlePlaybookRunCreate(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const definition = workflowRegistry.get(playbookId);
  if (!definition) return Response.json({ error: "Unknown playbook id" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parsePlaybookRunCreateRequest(body, playbookId);

  try {
    const playbookState = resolvePlaybookExecutionState({
      definition,
      capabilityInventory: parsed.capabilityInventory,
      assignmentPlan: parsed.assignmentPlan,
    });
    const result = await runWorkflow({
      definition,
      input: parsed.input,
      cli: {
        runWorkspaceCli,
      },
      ...(parsed.agentProvider ? { agentProvider: parsed.agentProvider } : {}),
      ...(parsed.credential?.apiKey ? { agentCredential: parsed.credential.apiKey } : {}),
      onCheckpoint(run) {
        workflowStore.save(mergePlaybookRunMetadata(run, playbookState));
      },
    });
    const merged = mergePlaybookRunMetadata(result, playbookState);
    workflowStore.save(merged);
    ensureWorkflowApprovalInbox(merged);
    return Response.json(playbookRunDetail(merged));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

function handlePlaybookRunList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const playbookId = searchParams.get("playbookId") ?? undefined;
  if (playbookId && !workflowRegistry.has(playbookId)) {
    return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  }
  const parsedStatus = status ? WorkflowRunStatusSchema.safeParse(status) : undefined;
  if (parsedStatus && !parsedStatus.success) {
    return Response.json({ error: "Unsupported playbook run status filter" }, { status: 400 });
  }

  const runs = workflowStore.list({
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    ...(playbookId ? { workflowId: playbookId } : {}),
  });
  return Response.json({ runs: runs.map((run) => playbookRunDetail(run)) });
}

function handlePlaybookRunGet(req: Request, runId: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const run = workflowStore.get(runId);
  if (!run) return Response.json({ error: "Unknown playbook run" }, { status: 404 });
  return Response.json(playbookRunDetail(run));
}

function ensureWorkflowApprovalInbox(result: {
  runId: string;
  status: string;
  approval?:
    | {
        preview: string;
        risk: { destructive: boolean };
      }
    | undefined;
}): void {
  if (result.status !== "blocked" || !result.approval) return;
  const existing = inboxStore.list({
    workflowRunId: result.runId,
    type: "approval",
    status: "open",
  });
  if (existing.length > 0) return;

  inboxStore.create({
    workflowRunId: result.runId,
    source: "workflow",
    type: "approval",
    severity: result.approval.risk.destructive ? "critical" : "warning",
    title: "Workflow approval needed",
    body: result.approval.preview,
    context: { approval: result.approval },
    actions: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
  });
}

function handleInboxList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "open";
  const type = searchParams.get("type");
  const parsedStatus = InboxStatusSchema.safeParse(status);
  if (!parsedStatus.success) {
    return Response.json({ error: parsedStatus.error.message }, { status: 400 });
  }
  const parsedType = type ? InboxMessageTypeSchema.safeParse(type) : undefined;
  if (parsedType && !parsedType.success) {
    return Response.json({ error: parsedType.error.message }, { status: 400 });
  }

  const workspaceRoot = searchParams.get("workspaceRoot");
  const taskId = searchParams.get("taskId");
  const workflowRunId = searchParams.get("workflowRunId");
  const result = InboxListResultSchema.parse({
    messages: inboxStore.list({
      status: parsedStatus.data,
      ...(parsedType?.success ? { type: parsedType.data } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(taskId ? { taskId } : {}),
      ...(workflowRunId ? { workflowRunId } : {}),
    }),
  });
  return Response.json(result);
}

async function handleInboxCreate(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = InboxCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    return Response.json(inboxStore.create(parsed.data));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

function handleInboxGet(req: Request, messageId: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const message = inboxStore.get(messageId);
  if (!message) return Response.json({ error: "Unknown inbox message" }, { status: 404 });
  return Response.json(message);
}

async function handleInboxResolve(req: Request, messageId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = InboxResolveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const existing = inboxStore.get(messageId);
    if (!existing) return Response.json({ error: "Unknown inbox message" }, { status: 404 });

    if (
      existing.type === "approval" &&
      existing.source === "workflow" &&
      existing.workflowRunId &&
      (parsed.data.actionId === "approve" || parsed.data.actionId === "deny")
    ) {
      const run = workflowStore.get(existing.workflowRunId);
      if (!run) return Response.json({ error: "Unknown workflow run" }, { status: 404 });
      const definition = workflowRegistry.get(run.workflowId);
      if (!definition) return Response.json({ error: "Unknown workflow id" }, { status: 404 });
      const result = await resumeWorkflowRun({
        run,
        decision: parsed.data.actionId,
        definition,
        cli: {
          runWorkspaceCli,
        },
        onCheckpoint(checkpoint) {
          workflowStore.save(checkpoint);
        },
      });
      workflowStore.save(result);
      ensureWorkflowApprovalInbox(result);
    }

    const message = inboxStore.resolve(messageId, parsed.data);
    return Response.json(message);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}

async function handleInboxSnooze(req: Request, messageId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = InboxSnoozeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const message = inboxStore.snooze(messageId, parsed.data);
  if (!message) return Response.json({ error: "Unknown inbox message" }, { status: 404 });
  return Response.json(message);
}

async function handleInboxCancel(req: Request, messageId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = InboxCancelRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const message = inboxStore.cancel(messageId, parsed.data);
  if (!message) return Response.json({ error: "Unknown inbox message" }, { status: 404 });
  return Response.json(message);
}

async function handleWorkflowResume(req: Request, runId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WorkflowResumeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  if (parsed.data.runId !== runId) {
    return Response.json({ error: "Resume body runId does not match URL" }, { status: 400 });
  }

  const existing = workflowStore.get(runId);
  if (!existing) {
    return Response.json({ error: "Unknown workflow run" }, { status: 404 });
  }
  const definition = workflowRegistry.get(existing.workflowId);
  if (!definition) {
    return Response.json({ error: "Unknown workflow id" }, { status: 404 });
  }

  try {
    const playbookState = resolvePlaybookExecutionState({
      definition,
      capabilityInventory: parsed.data.capabilityInventory,
      assignmentPlan: parsed.data.assignmentPlan,
      existingAssignmentPlan: existing.assignmentPlan,
    });
    const result = await resumeWorkflowRun({
      run: existing,
      decision: parsed.data.decision,
      definition,
      assignmentPlan: playbookState.assignmentPlan,
      cli: {
        runWorkspaceCli,
      },
      ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
      ...(parsed.data.credential?.apiKey ? { agentCredential: parsed.data.credential.apiKey } : {}),
      onCheckpoint(checkpoint) {
        workflowStore.save(mergePlaybookRunMetadata(checkpoint, playbookState));
      },
    });
    const merged = mergePlaybookRunMetadata(result, playbookState);
    workflowStore.save(merged);
    ensureWorkflowApprovalInbox(merged);
    return Response.json(merged);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

function handleTaskList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceRoot = searchParams.get("workspaceRoot") ?? "";
  try {
    const result = TaskListResultSchema.parse({
      tasks: taskStore.listTasks({ workspaceRoot }),
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}

async function handleTaskCreate(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TaskCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const invocation = await parseSkillInvocation({
      text: parsed.data.initialInstruction,
      workspaceRoot: parsed.data.workspaceRoot,
      agentId: parsed.data.agentId,
    });
    const taskInput = {
      ...parsed.data,
      initialInstruction: invocation.originalContent,
    };
    let execution = parsed.data.execution;
    if (execution && taskInput.agentId !== "default") {
      const profile = agentProfileStore.get(taskInput.agentId);
      if (profile) {
        execution = {
          ...execution,
          agent: profile,
          runtime: compileAgentRuntimeContext(profile),
        };
      }
    } else if (execution) {
      const agent = defaultAgentProfile();
      execution = {
        ...execution,
        agent,
        runtime: compileAgentRuntimeContext(agent),
      };
    }

    const task = taskStore.createTask({
      ...taskInput,
      ...(execution?.runtime ? { agentContext: execution.runtime } : {}),
    });
    const userTurn = task.turns.at(-1);
    if (!userTurn) throw new Error("Created task has no user turn");
    if (invocation.skill) {
      taskStore.addActiveSkill(task.id, {
        ...invocation.skill,
        activatedByTurnId: userTurn.id,
      });
    }
    const agentTurn = taskStore.createQueuedAgentTurn(task.id);
    const snapshot = taskStore.getTask(task.id);
    const taskId = task.id;
    const agentTurnId = agentTurn.id;
    const userTurnId = userTurn.id;
    queueMicrotask(() => {
      void runTaskTurn({
        store: taskStore,
        taskId,
        userTurnId,
        agentTurnId,
        browser: browserExecutor,
        cli: { runWorkspaceCli },
        ...(execution ? { execution } : {}),
        promptOverride: invocation.prompt,
        publish: (e) => taskEventBus.publish(taskId, e),
      });
    });
    return Response.json(snapshot);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

function handleTaskGet(req: Request, taskId: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const task = taskStore.getTask(taskId);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  return Response.json(task);
}

async function handleTaskUpdate(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "PATCH") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TaskUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const task = taskStore.updateTask(taskId, parsed.data);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  return Response.json(task);
}

async function handleTaskCreateTurn(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TaskCreateTurnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const task = taskStore.getTask(taskId);
    if (!task) return Response.json({ error: "Unknown task" }, { status: 404 });
    const invocation = await parseSkillInvocation({
      text: parsed.data.content,
      workspaceRoot: task.workspaceRoot,
      agentId: parsed.data.agentId,
    });
    const turnInput = {
      ...parsed.data,
      content: invocation.originalContent,
    };
    let execution = parsed.data.execution;
    if (execution && turnInput.agentId !== "default") {
      const profile = agentProfileStore.get(turnInput.agentId);
      if (profile) {
        execution = {
          ...execution,
          agent: profile,
          runtime: compileAgentRuntimeContext(profile),
        };
      }
    } else if (execution) {
      const agent = defaultAgentProfile();
      execution = {
        ...execution,
        agent,
        runtime: compileAgentRuntimeContext(agent),
      };
    }

    const userTurn = taskStore.createUserTurn(taskId, turnInput.content);
    if (invocation.skill) {
      taskStore.addActiveSkill(taskId, {
        ...invocation.skill,
        activatedByTurnId: userTurn.id,
      });
    }
    const agentTurn = taskStore.createQueuedAgentTurn(taskId);
    const snapshot = taskStore.getTask(taskId);
    const userTurnId = userTurn.id;
    const agentTurnId = agentTurn.id;
    const updatedSummary = taskStore.getTaskSummary(taskId);
    taskEventBus.publish(taskId, {
      type: "turn.created",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: userTurn,
    });
    taskEventBus.publish(taskId, {
      type: "turn.created",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: agentTurn,
    });
    taskEventBus.publish(taskId, {
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: updatedSummary,
    });
    queueMicrotask(() => {
      void runTaskTurn({
        store: taskStore,
        taskId,
        userTurnId,
        agentTurnId,
        browser: browserExecutor,
        cli: { runWorkspaceCli },
        ...(execution ? { execution } : {}),
        promptOverride: invocation.prompt,
        publish: (e) => taskEventBus.publish(taskId, e),
      });
    });
    return Response.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Unknown task") ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}

async function handleTaskTodo(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TodoOperationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const task = taskStore.updateTodo(taskId, parsed.data);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  taskEventBus.publish(taskId, {
    type: "task.todo_updated",
    taskId,
    emittedAt: new Date().toISOString(),
    todo: task.todo,
  });
  return Response.json(task);
}

async function handleTaskClarifyRequest(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ClarifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const task = taskStore.requestClarify(taskId, parsed.data);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  inboxStore.create({
    workspaceRoot: task.workspaceRoot,
    taskId,
    source: "task",
    type: "input_required",
    severity: "warning",
    title: "Clarification needed",
    body: parsed.data.message,
    context: { clarify: parsed.data },
    actions: [{ id: "respond", label: "Respond", style: "primary" }],
  });
  taskEventBus.publish(taskId, {
    type: "task.clarify_requested",
    taskId,
    emittedAt: new Date().toISOString(),
    clarify: parsed.data,
  });
  return Response.json(task);
}

async function handleTaskClarifyResolve(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ClarifyResponseSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const task = taskStore.clearClarify(taskId, parsed.data);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  taskEventBus.publish(taskId, {
    type: "task.clarify_resolved",
    taskId,
    emittedAt: new Date().toISOString(),
    response: parsed.data,
  });
  return Response.json(task);
}

async function handleTaskNotification(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = NotifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const task = taskStore.addNotification(taskId, parsed.data);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  inboxStore.create({
    workspaceRoot: task.workspaceRoot,
    taskId,
    source: "task",
    type: "review",
    severity: "info",
    title: parsed.data.title,
    body: parsed.data.body,
    context: { notification: parsed.data },
    actions: [
      { id: "acknowledge", label: parsed.data.actionLabel ?? "Acknowledge", style: "secondary" },
    ],
  });
  taskEventBus.publish(taskId, {
    type: "task.notification",
    taskId,
    emittedAt: new Date().toISOString(),
    notification: parsed.data,
  });
  return Response.json(task);
}

async function handleTaskAudit(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AuditRecordSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const task = taskStore.appendAuditRecord(taskId, parsed.data);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  taskEventBus.publish(taskId, {
    type: "task.audit_recorded",
    taskId,
    emittedAt: new Date().toISOString(),
    auditRecord: parsed.data,
  });
  return Response.json(task);
}

async function handleTaskEvents(_req: Request, taskId: string): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      send(": open\n\n");

      const heartbeat = setInterval(() => {
        try {
          send(": ping\n\n");
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      const unsubscribe = taskEventBus.subscribe(taskId, (event) => {
        try {
          send(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      });

      // _cleanup is attached here so the cancel() hook can tear down the interval
      // and subscription without a class wrapper — standard workaround for
      // ReadableStreamController having no built-in cancellation state slot.
      (controller as unknown as { _cleanup: () => void })._cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      (this as unknown as { _cleanup?: () => void })._cleanup?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function handleAgentProfileList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const result = {
    profiles: [
      defaultAgentProfile(),
      ...agentProfileStore.list().filter((profile) => profile.id !== "default"),
    ],
  };
  return Response.json(result);
}

function handleAgentProfileGet(req: Request, id: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const profile = id === "default" ? defaultAgentProfile() : agentProfileStore.get(id);
  if (!profile) return Response.json({ error: "Unknown agent profile" }, { status: 404 });
  return Response.json(profile);
}

async function handleAgentProfileCreate(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AgentProfileCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const profile = agentProfileStore.create(parsed.data);
    return Response.json(profile);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

async function handleAgentProfileUpdate(req: Request, id: string): Promise<Response> {
  if (req.method !== "PATCH") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AgentProfileUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const profile =
    id === "default"
      ? agentProfileStore.updateDefault(DEFAULT_AGENT_PROFILE, parsed.data)
      : agentProfileStore.update(id, parsed.data);
  if (!profile) return Response.json({ error: "Unknown agent profile" }, { status: 404 });
  return Response.json(profile);
}

function handleAgentProfileReset(req: Request, id: string): Response {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (id !== "default") {
    return Response.json({ error: "Only the default profile can be reset" }, { status: 400 });
  }

  agentProfileStore.resetDefault();
  return Response.json(DEFAULT_AGENT_PROFILE);
}

function handleAgentProfileDelete(req: Request, id: string): Response {
  if (req.method !== "DELETE") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (id === "default") {
    return Response.json({ error: "The default agent profile cannot be deleted" }, { status: 400 });
  }

  const deleted = agentProfileStore.delete(id);
  if (!deleted) return Response.json({ error: "Unknown agent profile" }, { status: 404 });
  return Response.json({ ok: true });
}

function skillRegistryForUrl(req: Request) {
  const url = new URL(req.url);
  const workspaceRoot = url.searchParams.get("workspaceRoot") ?? undefined;
  return createTesseraSkillRegistry(workspaceRoot ? { workspaceRoot } : {});
}

async function handleSkillList(req: Request): Promise<Response> {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  try {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agentId") ?? undefined;
    const registry = skillRegistryForUrl(req);
    return Response.json({
      skills: await registry.listSkills(
        agentId ? { allowedSkillIds: allowedSkillIdsForAgent(agentId) } : undefined
      ),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

async function handleSkillGet(req: Request, id: string): Promise<Response> {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  try {
    const registry = skillRegistryForUrl(req);
    return Response.json(await registry.loadSkill(decodeURIComponent(id)));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 }
    );
  }
}

async function handleTaskSkillCreate(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const skillId = typeof input.skillId === "string" ? input.skillId : "";
  if (!skillId) return Response.json({ error: "skillId is required" }, { status: 400 });

  const task = taskStore.getTask(taskId);
  if (!task) return Response.json({ error: "Unknown task" }, { status: 404 });
  try {
    const registry = createTesseraSkillRegistry({ workspaceRoot: task.workspaceRoot });
    const allowedSkillIds = allowedSkillIdsForAgent(task.agentId);
    const detail = await registry.loadSkill(skillId, { allowedSkillIds });
    const updated = taskStore.addActiveSkill(taskId, {
      skillId: detail.id,
      name: detail.name,
      source: detail.source,
      ...(detail.externalProvider ? { externalProvider: detail.externalProvider } : {}),
    });
    return Response.json(updated);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}

function handleTaskSkillDelete(req: Request, taskId: string, skillId: string): Response {
  if (req.method !== "DELETE") return new Response("Method Not Allowed", { status: 405 });
  const updated = taskStore.removeActiveSkill(taskId, decodeURIComponent(skillId));
  if (!updated) return Response.json({ error: "Unknown task" }, { status: 404 });
  return Response.json(updated);
}

const server = Bun.serve({
  // Unix domain socket on macOS/Linux (no exposed TCP port).
  // TCP on Windows as a fallback; named pipe support is a future improvement.
  ...(socketPath ? { unix: socketPath } : { hostname: "127.0.0.1", port: 0 }),

  async fetch(req, srv) {
    if (req.headers.get("upgrade") === "websocket") {
      const err = validateWebSocket(req);
      if (err) return err;
      srv.upgrade(req);
      return;
    }

    const err = validateRequest(req);
    if (err) return err;

    const { pathname } = new URL(req.url);

    if (pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (pathname === "/spawn") {
      return handleSpawn(req);
    }

    if (pathname === "/agent/turn") {
      return handleAgentTurn(req);
    }

    if (pathname === "/workflows/run") {
      return handleWorkflowRun(req);
    }

    if (pathname === "/workflows/runs") {
      return handleWorkflowRunList(req);
    }

    if (pathname === "/playbooks") {
      return handlePlaybookList(req);
    }

    if (pathname === "/playbook-runs") {
      return handlePlaybookRunList(req);
    }

    if (pathname === "/inbox") {
      if (req.method === "GET") return handleInboxList(req);
      return handleInboxCreate(req);
    }

    if (pathname === "/tasks") {
      if (req.method === "GET") return handleTaskList(req);
      return handleTaskCreate(req);
    }

    if (pathname === "/skills") {
      return handleSkillList(req);
    }

    const skillMatch = pathname.match(/^\/skills\/([^/]+)$/);
    const skillId = skillMatch?.[1];
    if (skillId) {
      return handleSkillGet(req, skillId);
    }

    if (pathname === "/agent-profiles") {
      if (req.method === "GET") return handleAgentProfileList(req);
      return handleAgentProfileCreate(req);
    }

    const agentProfileResetMatch = pathname.match(/^\/agent-profiles\/([^/]+)\/reset$/);
    const resetAgentProfileId = agentProfileResetMatch?.[1];
    if (resetAgentProfileId) {
      return handleAgentProfileReset(req, resetAgentProfileId);
    }

    const agentProfileMatch = pathname.match(/^\/agent-profiles\/([^/]+)$/);
    const agentProfileId = agentProfileMatch?.[1];
    if (agentProfileId) {
      if (req.method === "GET") return handleAgentProfileGet(req, agentProfileId);
      if (req.method === "PATCH") return handleAgentProfileUpdate(req, agentProfileId);
      if (req.method === "DELETE") return handleAgentProfileDelete(req, agentProfileId);
    }

    const inboxActionMatch = pathname.match(/^\/inbox\/([^/]+)\/(resolve|snooze|cancel)$/);
    const inboxActionId = inboxActionMatch?.[1];
    const inboxAction = inboxActionMatch?.[2];
    if (inboxActionId && inboxAction) {
      if (inboxAction === "resolve") {
        return handleInboxResolve(req, decodeURIComponent(inboxActionId));
      }
      if (inboxAction === "snooze") {
        return handleInboxSnooze(req, decodeURIComponent(inboxActionId));
      }
      return handleInboxCancel(req, decodeURIComponent(inboxActionId));
    }

    const inboxMatch = pathname.match(/^\/inbox\/([^/]+)$/);
    const inboxId = inboxMatch?.[1];
    if (inboxId) {
      return handleInboxGet(req, decodeURIComponent(inboxId));
    }

    const playbookRunResumeMatch = pathname.match(/^\/playbook-runs\/([^/]+)\/resume$/);
    const playbookRunResumeId = playbookRunResumeMatch?.[1];
    if (playbookRunResumeId) {
      return handleWorkflowResume(req, decodeURIComponent(playbookRunResumeId));
    }

    const playbookRunMatch = pathname.match(/^\/playbook-runs\/([^/]+)$/);
    const playbookRunId = playbookRunMatch?.[1];
    if (playbookRunId) {
      return handlePlaybookRunGet(req, decodeURIComponent(playbookRunId));
    }

    const playbookRunCreateMatch = pathname.match(/^\/playbooks\/([^/]+)\/runs$/);
    const playbookRunCreateId = playbookRunCreateMatch?.[1];
    if (playbookRunCreateId) {
      return handlePlaybookRunCreate(req, decodeURIComponent(playbookRunCreateId));
    }

    const playbookMatch = pathname.match(/^\/playbooks\/([^/]+)$/);
    const playbookId = playbookMatch?.[1];
    if (playbookId) {
      return handlePlaybookGet(req, decodeURIComponent(playbookId));
    }

    const taskEventsMatch = pathname.match(/^\/tasks\/([^/]+)\/events$/);
    const taskEventsId = taskEventsMatch?.[1];
    if (taskEventsId) {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return handleTaskEvents(req, decodeURIComponent(taskEventsId));
    }

    const taskTurnMatch = pathname.match(/^\/tasks\/([^/]+)\/turns$/);
    const taskTurnTaskId = taskTurnMatch?.[1];
    if (taskTurnTaskId) {
      return handleTaskCreateTurn(req, taskTurnTaskId);
    }

    const taskSkillMatch = pathname.match(/^\/tasks\/([^/]+)\/skills$/);
    const taskSkillTaskId = taskSkillMatch?.[1];
    if (taskSkillTaskId) {
      return handleTaskSkillCreate(req, decodeURIComponent(taskSkillTaskId));
    }

    const taskSkillDeleteMatch = pathname.match(/^\/tasks\/([^/]+)\/skills\/([^/]+)$/);
    const taskSkillDeleteTaskId = taskSkillDeleteMatch?.[1];
    const taskSkillDeleteSkillId = taskSkillDeleteMatch?.[2];
    if (taskSkillDeleteTaskId && taskSkillDeleteSkillId) {
      return handleTaskSkillDelete(
        req,
        decodeURIComponent(taskSkillDeleteTaskId),
        taskSkillDeleteSkillId
      );
    }

    const taskTodoMatch = pathname.match(/^\/tasks\/([^/]+)\/todo$/);
    const taskTodoId = taskTodoMatch?.[1];
    if (taskTodoId) {
      return handleTaskTodo(req, taskTodoId);
    }

    const taskClarifyRequestMatch = pathname.match(/^\/tasks\/([^/]+)\/clarify$/);
    const taskClarifyRequestId = taskClarifyRequestMatch?.[1];
    if (taskClarifyRequestId) {
      return handleTaskClarifyRequest(req, taskClarifyRequestId);
    }

    const taskClarifyResolveMatch = pathname.match(/^\/tasks\/([^/]+)\/clarify\/resolve$/);
    const taskClarifyResolveId = taskClarifyResolveMatch?.[1];
    if (taskClarifyResolveId) {
      return handleTaskClarifyResolve(req, taskClarifyResolveId);
    }

    const taskNotificationMatch = pathname.match(/^\/tasks\/([^/]+)\/notify$/);
    const taskNotificationId = taskNotificationMatch?.[1];
    if (taskNotificationId) {
      return handleTaskNotification(req, taskNotificationId);
    }

    const taskAuditMatch = pathname.match(/^\/tasks\/([^/]+)\/audit$/);
    const taskAuditId = taskAuditMatch?.[1];
    if (taskAuditId) {
      return handleTaskAudit(req, taskAuditId);
    }

    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    const taskId = taskMatch?.[1];
    if (taskId) {
      if (req.method === "GET") return handleTaskGet(req, taskId);
      return handleTaskUpdate(req, taskId);
    }

    const workflowResumeMatch = pathname.match(/^\/workflows\/([^/]+)\/resume$/);
    const workflowRunId = workflowResumeMatch?.[1];
    if (workflowRunId) {
      return handleWorkflowResume(req, workflowRunId);
    }

    const workflowRunMatch = pathname.match(/^\/workflows\/runs\/([^/]+)$/);
    const workflowRunGetId = workflowRunMatch?.[1];
    if (workflowRunGetId) {
      return handleWorkflowRunGet(req, decodeURIComponent(workflowRunGetId));
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(_ws) {},
    message(ws, data) {
      ws.send(data);
    },
    close(_ws) {},
  },
});

// Validate and report connection info to the Tauri shell via stdout.
const info = SidecarReadySchema.parse(
  socketPath
    ? { type: "ready", transport: "unix", path: socketPath, token: TOKEN }
    : { type: "ready", transport: "tcp", port: server.port, token: TOKEN }
);

process.stdout.write(`${JSON.stringify(info)}\n`);
