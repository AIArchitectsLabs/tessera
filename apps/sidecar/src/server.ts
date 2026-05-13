import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentProfile,
  type AgentProviderConfig,
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
  type ModelRuntimeCredential,
  NotifyRequestSchema,
  PlaybookAssignmentPreviewRequestSchema,
  PlaybookAssignmentPreviewResultSchema,
  PlaybookDetailSchema,
  PlaybookListResultSchema,
  PlaybookRunDetailSchema,
  type PlaybookRunPreference,
  PlaybookRunPreferenceReadRequestSchema,
  PlaybookRunPreferenceReadResultSchema,
  type PlaybookRunPreferenceSaveRequest,
  PlaybookRunPreferenceSaveRequestSchema,
  PlaybookRunPreferenceSchema,
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
  type WorkflowCapabilityInventory,
  type WorkflowDefinition,
  WorkflowResumeRequestSchema,
  type WorkflowRunAssignmentPlan,
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
  ACTIVITY_SNAPSHOT_WORKFLOW,
  BUILTIN_PLAYBOOK_ROOTS,
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
import { generateDashboardLayout } from "./layout-runner.js";
import {
  type TesseraMemoryManager,
  createMemoryManager,
  createNoopMemoryManager,
} from "./memory-manager.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import {
  buildLocalPlaybookCapabilityInventory,
  createPlaybookAssignmentPreview,
  mergePlaybookRunMetadata,
  parsePlaybookRunCreateRequest,
  resolveCheckpointedPlaybookExecutionContext,
  resolvePlaybookExecutionContext,
} from "./playbook-routing.js";
import { createPlaybookRunPreferenceStore } from "./playbook-run-preferences.js";
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
const MEMORY_DB_PATH =
  process.env.TESSERA_MEMORY_DB_PATH ?? join(homedir(), ".tessera", "memory.sqlite");
const MEMORY_DISABLED = process.env.TESSERA_MEMORY_DISABLED === "1";
const TESSERA_DATA_DIR = process.env.TESSERA_DATA_DIR ?? join(homedir(), ".tessera");
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`;
const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const browserExecutor = createPlaywrightBrowserExecutor({
  artifactDir: join(TESSERA_DATA_DIR, "browser-artifacts"),
  profileDir: join(TESSERA_DATA_DIR, "browser-profile"),
  recipeDir: join(TESSERA_DATA_DIR, "browser-recipes"),
  ...resolveBrowserRuntimeConfigFromEnv(),
});
const workflowStore = createWorkflowCheckpointStore(WORKFLOW_DB_PATH);
const playbookRunPreferenceStore = createPlaybookRunPreferenceStore(WORKFLOW_DB_PATH);
const taskStore = createTaskStore(TASK_DB_PATH);
const agentProfileStore = createAgentProfileStore(TASK_DB_PATH);
const inboxStore = createInboxStore(TASK_DB_PATH);
export interface MemoryRuntimeStatus {
  enabled: boolean;
  mode: "active" | "disabled" | "fallback";
  dbPath: string;
  startupWarning?: {
    type: "tessera.memory.startup_failed";
    message: string;
  };
}

export function createServerMemoryRuntime(options: {
  dbPath: string;
  disabled: boolean;
  ownerId: string;
  createStore?: (dbPath: string) => MemoryStore;
  warn?: (message: string) => void;
}): {
  memoryStore?: MemoryStore;
  memoryManager: TesseraMemoryManager;
  memoryStatus: MemoryRuntimeStatus;
} {
  if (options.disabled) {
    return {
      memoryManager: createNoopMemoryManager(),
      memoryStatus: {
        enabled: false,
        mode: "disabled",
        dbPath: options.dbPath,
      },
    };
  }

  try {
    const memoryStore = (options.createStore ?? createMemoryStore)(options.dbPath);
    return {
      memoryStore,
      memoryManager: createMemoryManager({ store: memoryStore, ownerId: options.ownerId }),
      memoryStatus: {
        enabled: true,
        mode: "active",
        dbPath: options.dbPath,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const startupWarning: MemoryRuntimeStatus["startupWarning"] = {
      type: "tessera.memory.startup_failed",
      message,
    };
    options.warn?.(JSON.stringify(startupWarning));
    return {
      memoryManager: createNoopMemoryManager(),
      memoryStatus: {
        enabled: false,
        mode: "fallback",
        dbPath: options.dbPath,
        startupWarning,
      },
    };
  }
}

const { memoryStore, memoryManager, memoryStatus } = createServerMemoryRuntime({
  dbPath: MEMORY_DB_PATH,
  disabled: MEMORY_DISABLED,
  ownerId: "local-owner",
  warn: (message) => console.warn(message),
});
const taskEventBus = createTaskEventBus();
interface WorkflowRegistryEntry {
  definition: WorkflowDefinition;
  packageRoot: string;
}

function builtinPlaybookRoot(workflowId: string): string {
  const root = BUILTIN_PLAYBOOK_ROOTS[workflowId];
  if (!root) throw new Error(`Missing built-in playbook root for ${workflowId}`);
  return root;
}

const workflowRegistry = new Map<string, WorkflowRegistryEntry>([
  [
    SALES_MEETING_BRIEF_WORKFLOW.id,
    {
      definition: SALES_MEETING_BRIEF_WORKFLOW,
      packageRoot: builtinPlaybookRoot(SALES_MEETING_BRIEF_WORKFLOW.id),
    },
  ],
  [
    CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW.id,
    {
      definition: CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW,
      packageRoot: builtinPlaybookRoot(CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW.id),
    },
  ],
  [
    WEEKLY_STATUS_DIGEST_WORKFLOW.id,
    {
      definition: WEEKLY_STATUS_DIGEST_WORKFLOW,
      packageRoot: builtinPlaybookRoot(WEEKLY_STATUS_DIGEST_WORKFLOW.id),
    },
  ],
  [
    DEMO_WORKFLOW.id,
    { definition: DEMO_WORKFLOW, packageRoot: builtinPlaybookRoot(DEMO_WORKFLOW.id) },
  ],
  [
    WEEKLY_UPDATE_WORKFLOW.id,
    {
      definition: WEEKLY_UPDATE_WORKFLOW,
      packageRoot: builtinPlaybookRoot(WEEKLY_UPDATE_WORKFLOW.id),
    },
  ],
  [
    ACTIVITY_SNAPSHOT_WORKFLOW.id,
    {
      definition: ACTIVITY_SNAPSHOT_WORKFLOW,
      packageRoot: builtinPlaybookRoot(ACTIVITY_SNAPSHOT_WORKFLOW.id),
    },
  ],
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
  playbookRunPreferenceStore.close();
  taskStore.close();
  agentProfileStore.close();
  inboxStore.close();
  memoryStore?.close();
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

export function buildWorkflowExecutionOptions(options: {
  agentProvider?: AgentProviderConfig;
  assignmentPlan?: WorkflowRunAssignmentPlan;
  capabilityInventory?: WorkflowCapabilityInventory;
  credential?: ModelRuntimeCredential;
}): {
  agentCredential?: ModelRuntimeCredential;
  agentProvider?: AgentProviderConfig;
  assignmentPlan?: WorkflowRunAssignmentPlan;
  capabilityInventory?: WorkflowCapabilityInventory;
} {
  return {
    ...(options.assignmentPlan ? { assignmentPlan: options.assignmentPlan } : {}),
    ...(options.capabilityInventory ? { capabilityInventory: options.capabilityInventory } : {}),
    ...(options.agentProvider ? { agentProvider: options.agentProvider } : {}),
    ...(options.credential ? { agentCredential: options.credential } : {}),
  };
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

function workflowDefinition(workflowId: string): WorkflowDefinition | undefined {
  return workflowRegistry.get(workflowId)?.definition;
}

function workflowDefinitions(): WorkflowDefinition[] {
  return [...workflowRegistry.values()].map((entry) => entry.definition);
}

async function saveWorkflowRunWithDashboardLayout(
  run: Parameters<typeof workflowStore.save>[0],
  entry: WorkflowRegistryEntry | undefined
): Promise<Parameters<typeof workflowStore.save>[0]> {
  if (!entry || !["completed", "failed", "denied"].includes(run.status)) {
    workflowStore.save(run);
    await recordWorkflowRunMemory(run);
    return run;
  }

  const layout = await generateDashboardLayout({
    definition: entry.definition,
    packageRoot: entry.packageRoot,
    outputs: run.outputs ?? {},
    runId: run.runId,
    completedAt: run.completedAt ?? new Date().toISOString(),
  });
  const runWithLayout = layout ? { ...run, dashboardLayout: layout } : run;
  workflowStore.save(runWithLayout);
  await recordWorkflowRunMemory(runWithLayout);
  return runWithLayout;
}

function workspaceRootFromWorkflowRun(
  run: Parameters<typeof workflowStore.save>[0]
): string | undefined {
  const workspaceRoot = run.input.workspaceRoot;
  return typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot : undefined;
}

async function recordWorkflowRunMemory(
  run: Parameters<typeof workflowStore.save>[0]
): Promise<void> {
  try {
    const workspaceRoot = workspaceRootFromWorkflowRun(run);
    await memoryManager.recordWorkflowRun({
      run,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    });
  } catch {}
}

function playbookRunDetail(run: unknown): unknown {
  const parsed = PlaybookRunDetailSchema.parse(run);
  const definition = workflowDefinition(parsed.workflowId);
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

type FetchLike = typeof fetch;

export async function requestCodexDeviceCode(fetchImpl: FetchLike = fetch): Promise<{
  deviceAuthId: string;
  interval: number;
  userCode: string;
  verificationUri: string;
}> {
  const response = await fetchImpl(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error(`Codex device-code request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const userCode = typeof payload.user_code === "string" ? payload.user_code : "";
  const deviceAuthId = typeof payload.device_auth_id === "string" ? payload.device_auth_id : "";
  if (!userCode || !deviceAuthId) {
    throw new Error("Codex device-code response was missing required fields");
  }
  const rawInterval =
    typeof payload.interval === "number"
      ? payload.interval
      : Number.parseInt(String(payload.interval ?? "5"), 10);
  return {
    deviceAuthId,
    interval: Number.isFinite(rawInterval) ? Math.max(3, rawInterval) : 5,
    userCode,
    verificationUri: `${CODEX_OAUTH_ISSUER}/codex/device`,
  };
}

export async function pollCodexDeviceToken(
  input: { deviceAuthId: string; userCode: string },
  fetchImpl: FetchLike = fetch
): Promise<
  | { status: "pending" }
  | {
      status: "authorized";
      credential: {
        authMode: "chatgpt";
        baseUrl: string;
        lastRefresh: string;
        tokens: { accessToken: string; refreshToken: string };
      };
    }
> {
  const pollResponse = await fetchImpl(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
  });
  if (pollResponse.status === 403 || pollResponse.status === 404) {
    return { status: "pending" };
  }
  if (!pollResponse.ok) {
    throw new Error(`Codex device-code poll failed with status ${pollResponse.status}`);
  }
  const pollPayload = (await pollResponse.json()) as Record<string, unknown>;
  const authorizationCode =
    typeof pollPayload.authorization_code === "string" ? pollPayload.authorization_code : "";
  const codeVerifier =
    typeof pollPayload.code_verifier === "string" ? pollPayload.code_verifier : "";
  if (!authorizationCode || !codeVerifier) {
    throw new Error("Codex device-code poll response was missing exchange fields");
  }

  const form = new URLSearchParams({
    client_id: CODEX_OAUTH_CLIENT_ID,
    code: authorizationCode,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
  });
  const tokenResponse = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!tokenResponse.ok) {
    throw new Error(`Codex token exchange failed with status ${tokenResponse.status}`);
  }
  const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
  const accessToken =
    typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : "";
  const refreshToken =
    typeof tokenPayload.refresh_token === "string" ? tokenPayload.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new Error("Codex token exchange response was missing tokens");
  }
  return {
    status: "authorized",
    credential: {
      authMode: "chatgpt",
      baseUrl: CODEX_DEFAULT_BASE_URL,
      lastRefresh: new Date().toISOString(),
      tokens: { accessToken, refreshToken },
    },
  };
}

export async function refreshCodexOAuthCredential(
  credential: {
    authMode: "chatgpt";
    baseUrl?: string;
    lastRefresh?: string;
    tokens: { accessToken: string; refreshToken: string };
  },
  fetchImpl: FetchLike = fetch
): Promise<{
  authMode: "chatgpt";
  baseUrl: string;
  lastRefresh: string;
  tokens: { accessToken: string; refreshToken: string };
}> {
  const form = new URLSearchParams({
    client_id: CODEX_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credential.tokens.refreshToken,
  });
  const tokenResponse = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!tokenResponse.ok) {
    throw new Error(`Codex token refresh failed with status ${tokenResponse.status}`);
  }
  const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
  const accessToken =
    typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : "";
  const refreshToken =
    typeof tokenPayload.refresh_token === "string" ? tokenPayload.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new Error("Codex token refresh response was missing tokens");
  }
  return {
    authMode: "chatgpt",
    baseUrl: credential.baseUrl ?? CODEX_DEFAULT_BASE_URL,
    lastRefresh: new Date().toISOString(),
    tokens: { accessToken, refreshToken },
  };
}

async function handleCodexOauthDeviceCode(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  try {
    return Response.json(await requestCodexDeviceCode());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
}

async function handleCodexOauthPoll(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { deviceAuthId?: unknown }).deviceAuthId !== "string" ||
    typeof (body as { userCode?: unknown }).userCode !== "string"
  ) {
    return Response.json({ error: "deviceAuthId and userCode are required" }, { status: 400 });
  }
  try {
    return Response.json(
      await pollCodexDeviceToken({
        deviceAuthId: (body as { deviceAuthId: string }).deviceAuthId,
        userCode: (body as { userCode: string }).userCode,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
}

async function handleCodexOauthRefresh(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Codex credential is required" }, { status: 400 });
  }
  const credential = body as {
    authMode?: unknown;
    baseUrl?: unknown;
    lastRefresh?: unknown;
    tokens?: { accessToken?: unknown; refreshToken?: unknown };
  };
  if (
    credential.authMode !== "chatgpt" ||
    typeof credential.tokens?.accessToken !== "string" ||
    typeof credential.tokens.refreshToken !== "string"
  ) {
    return Response.json({ error: "Valid Codex credential is required" }, { status: 400 });
  }
  try {
    return Response.json(
      await refreshCodexOAuthCredential({
        authMode: "chatgpt",
        ...(typeof credential.baseUrl === "string" ? { baseUrl: credential.baseUrl } : {}),
        ...(typeof credential.lastRefresh === "string"
          ? { lastRefresh: credential.lastRefresh }
          : {}),
        tokens: {
          accessToken: credential.tokens.accessToken,
          refreshToken: credential.tokens.refreshToken,
        },
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
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

  const entry = workflowRegistry.get(parsed.data.workflowId);
  const definition = entry?.definition;
  if (!entry || !definition) {
    return Response.json({ error: "Unknown workflow id" }, { status: 404 });
  }

  try {
    const playbookState = resolvePlaybookExecutionState({
      definition,
      capabilityInventory: parsed.data.capabilityInventory,
      assignmentPlan: parsed.data.assignmentPlan,
    });
    const executionOptions = buildWorkflowExecutionOptions({
      assignmentPlan: playbookState.assignmentPlan,
      capabilityInventory: playbookState.capabilityInventory,
      ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
      ...(parsed.data.credential ? { credential: parsed.data.credential } : {}),
    });
    const result = await runWorkflow({
      definition,
      input: parsed.data.input,
      cli: {
        runWorkspaceCli,
      },
      ...executionOptions,
      async onCheckpoint(run) {
        await saveWorkflowRunWithDashboardLayout(
          mergePlaybookRunMetadata(run, playbookState),
          entry
        );
      },
    });
    const merged = mergePlaybookRunMetadata(result, playbookState);
    const saved = await saveWorkflowRunWithDashboardLayout(merged, entry);
    ensureWorkflowApprovalInbox(saved);
    return Response.json(saved);
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

async function handleWorkflowRunDashboardLayout(req: Request, runId: string): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const run = workflowStore.get(runId);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  if (run.dashboardLayout) return Response.json({ layout: run.dashboardLayout });

  const entry = workflowRegistry.get(run.workflowId);
  const runWithLayout = await saveWorkflowRunWithDashboardLayout(run, entry);
  return Response.json({ layout: runWithLayout.dashboardLayout ?? null });
}

function handlePlaybookList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  return Response.json(
    PlaybookListResultSchema.parse({
      playbooks: workflowDefinitions().map((definition) => playbookSummary(definition)),
    })
  );
}

function handlePlaybookGet(req: Request, playbookId: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const definition = workflowDefinition(playbookId);
  if (!definition) return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  return Response.json(
    PlaybookDetailSchema.parse({
      ...playbookSummary(definition),
      inputs: definition.inputs,
      steps: definition.steps,
    })
  );
}

async function handlePlaybookAssignmentPreview(
  req: Request,
  playbookId: string
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const entry = workflowRegistry.get(playbookId);
  const definition = entry?.definition;
  if (!entry || !definition) {
    return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PlaybookAssignmentPreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const preview = createPlaybookAssignmentPreview({
    definition,
    capabilityInventory:
      parsed.data.capabilityInventory ??
      buildLocalPlaybookCapabilityInventory(agentProfileStore.list()),
    ...(parsed.data.previousPlan ? { previousPlan: parsed.data.previousPlan } : {}),
  });

  return Response.json(PlaybookAssignmentPreviewResultSchema.parse(preview));
}

export function isPlaybookRunPreferenceAssignmentPlanValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith("Assignment for step ") ||
    message.startsWith("Assignment plan ") ||
    message.startsWith("Unable to resolve assignment for step ")
  );
}

export function buildPlaybookRunPreference(
  playbookId: string,
  request: PlaybookRunPreferenceSaveRequest,
  updatedAt = new Date()
): PlaybookRunPreference {
  return PlaybookRunPreferenceSchema.parse({
    workspaceRoot: request.workspaceRoot,
    playbookId,
    assignmentPlan: request.assignmentPlan,
    updatedAt: updatedAt.toISOString(),
  });
}

async function handlePlaybookRunCreate(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const entry = workflowRegistry.get(playbookId);
  const definition = entry?.definition;
  if (!entry || !definition)
    return Response.json({ error: "Unknown playbook id" }, { status: 404 });

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
    const executionOptions = buildWorkflowExecutionOptions({
      assignmentPlan: playbookState.assignmentPlan,
      capabilityInventory: playbookState.capabilityInventory,
      ...(parsed.agentProvider ? { agentProvider: parsed.agentProvider } : {}),
      ...(parsed.credential ? { credential: parsed.credential } : {}),
    });
    const result = await runWorkflow({
      definition,
      input: parsed.input,
      cli: {
        runWorkspaceCli,
      },
      ...executionOptions,
      async onCheckpoint(run) {
        await saveWorkflowRunWithDashboardLayout(
          mergePlaybookRunMetadata(run, playbookState),
          entry
        );
      },
    });
    const merged = mergePlaybookRunMetadata(result, playbookState);
    const saved = await saveWorkflowRunWithDashboardLayout(merged, entry);
    ensureWorkflowApprovalInbox(saved);
    return Response.json(playbookRunDetail(saved));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handlePlaybookRunPreferenceGet(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const entry = workflowRegistry.get(playbookId);
  if (!entry || !entry.definition) {
    return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PlaybookRunPreferenceReadRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  return Response.json(
    PlaybookRunPreferenceReadResultSchema.parse({
      preference: playbookRunPreferenceStore.get(parsed.data.workspaceRoot, playbookId),
    })
  );
}

async function handlePlaybookRunPreferenceSave(
  req: Request,
  playbookId: string
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const entry = workflowRegistry.get(playbookId);
  const definition = entry?.definition;
  if (!entry || !definition) {
    return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const request = PlaybookRunPreferenceSaveRequestSchema.safeParse(body);
  if (!request.success) {
    return Response.json({ error: request.error.message }, { status: 400 });
  }
  const preference = buildPlaybookRunPreference(playbookId, request.data);

  try {
    resolvePlaybookExecutionState({
      definition,
      capabilityInventory:
        request.data.capabilityInventory ??
        buildLocalPlaybookCapabilityInventory(agentProfileStore.list()),
      assignmentPlan: preference.assignmentPlan,
    });
    playbookRunPreferenceStore.save(preference);
    return Response.json(PlaybookRunPreferenceReadResultSchema.parse({ preference }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isPlaybookRunPreferenceAssignmentPlanValidationError(error)) {
      return Response.json({ error: message }, { status: 409 });
    }
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
      const entry = workflowRegistry.get(run.workflowId);
      const definition = entry?.definition;
      if (!entry || !definition) {
        return Response.json({ error: "Unknown workflow id" }, { status: 404 });
      }
      const result = await resumeWorkflowRun({
        run,
        decision: parsed.data.actionId,
        definition,
        cli: {
          runWorkspaceCli,
        },
        async onCheckpoint(checkpoint) {
          await saveWorkflowRunWithDashboardLayout(checkpoint, entry);
        },
      });
      const saved = await saveWorkflowRunWithDashboardLayout(result, entry);
      ensureWorkflowApprovalInbox(saved);
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
  const entry = workflowRegistry.get(existing.workflowId);
  const definition = entry?.definition;
  if (!entry || !definition) {
    return Response.json({ error: "Unknown workflow id" }, { status: 404 });
  }

  try {
    const playbookState = resolvePlaybookExecutionState({
      definition,
      capabilityInventory: parsed.data.capabilityInventory,
      assignmentPlan: parsed.data.assignmentPlan,
      existingAssignmentPlan: existing.assignmentPlan,
    });
    const executionOptions = buildWorkflowExecutionOptions({
      assignmentPlan: playbookState.assignmentPlan,
      capabilityInventory: playbookState.capabilityInventory,
      ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
      ...(parsed.data.credential ? { credential: parsed.data.credential } : {}),
    });
    const result = await resumeWorkflowRun({
      run: existing,
      decision: parsed.data.decision,
      definition,
      cli: {
        runWorkspaceCli,
      },
      ...executionOptions,
      async onCheckpoint(checkpoint) {
        await saveWorkflowRunWithDashboardLayout(
          mergePlaybookRunMetadata(checkpoint, playbookState),
          entry
        );
      },
    });
    const merged = mergePlaybookRunMetadata(result, playbookState);
    const saved = await saveWorkflowRunWithDashboardLayout(merged, entry);
    ensureWorkflowApprovalInbox(saved);
    return Response.json(saved);
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
        memory: memoryManager,
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
        memory: memoryManager,
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

export function handleMemoryStatus(
  req: Request,
  status: MemoryRuntimeStatus = memoryStatus
): Response {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  return Response.json(status);
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

    if (pathname === "/memory/status") {
      return handleMemoryStatus(req);
    }

    if (pathname === "/spawn") {
      return handleSpawn(req);
    }

    if (pathname === "/agent/turn") {
      return handleAgentTurn(req);
    }

    if (pathname === "/model/codex-oauth/device-code") {
      return handleCodexOauthDeviceCode(req);
    }

    if (pathname === "/model/codex-oauth/poll") {
      return handleCodexOauthPoll(req);
    }

    if (pathname === "/model/codex-oauth/refresh") {
      return handleCodexOauthRefresh(req);
    }

    if (pathname === "/workflows/run") {
      return handleWorkflowRun(req);
    }

    if (pathname === "/workflows/runs") {
      return handleWorkflowRunList(req);
    }

    const workflowRunDashboardLayoutMatch = pathname.match(
      /^\/workflows\/runs\/([^/]+)\/dashboard-layout$/
    );
    const workflowRunDashboardLayoutId = workflowRunDashboardLayoutMatch?.[1];
    if (workflowRunDashboardLayoutId) {
      return handleWorkflowRunDashboardLayout(
        req,
        decodeURIComponent(workflowRunDashboardLayoutId)
      );
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

    const playbookAssignmentPreviewMatch = pathname.match(
      /^\/playbooks\/([^/]+)\/assignment-preview$/
    );
    const playbookAssignmentPreviewId = playbookAssignmentPreviewMatch?.[1];
    if (playbookAssignmentPreviewId) {
      return handlePlaybookAssignmentPreview(req, decodeURIComponent(playbookAssignmentPreviewId));
    }

    const playbookRunPreferenceGetMatch = pathname.match(
      /^\/playbooks\/([^/]+)\/run-preference\/get$/
    );
    const playbookRunPreferenceGetId = playbookRunPreferenceGetMatch?.[1];
    if (playbookRunPreferenceGetId) {
      return handlePlaybookRunPreferenceGet(req, decodeURIComponent(playbookRunPreferenceGetId));
    }

    const playbookRunPreferenceSaveMatch = pathname.match(
      /^\/playbooks\/([^/]+)\/run-preference\/save$/
    );
    const playbookRunPreferenceSaveId = playbookRunPreferenceSaveMatch?.[1];
    if (playbookRunPreferenceSaveId) {
      return handlePlaybookRunPreferenceSave(req, decodeURIComponent(playbookRunPreferenceSaveId));
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
