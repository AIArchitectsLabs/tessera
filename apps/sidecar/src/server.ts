import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  type AgentProfile,
  type AgentProviderConfig,
  AgentTurnRequestSchema,
  type AgentTurnResult,
  AuditRecordSchema,
  ClarifyRequestSchema,
  ClarifyResponseSchema,
  type CompiledPlaybookGraph,
  CompiledPlaybookGraphSchema,
  InboxCancelRequestSchema,
  InboxCreateRequestSchema,
  InboxListResultSchema,
  InboxMessageTypeSchema,
  InboxResolveRequestSchema,
  InboxSnoozeRequestSchema,
  InboxStatusSchema,
  MemoryForgetRequestSchema,
  type MemoryRecallResult,
  MemoryReviewDecisionRequestSchema,
  MemoryReviewListResultSchema,
  type ModelRuntimeCredential,
  NotifyRequestSchema,
  PlaybookAssignmentPreviewRequestSchema,
  PlaybookAssignmentPreviewResultSchema,
  PlaybookDetailSchema,
  type PlaybookGraphArtifactVersion,
  type PlaybookGraphBranchItem,
  PlaybookGraphGitMilestoneCommitRequestSchema,
  PlaybookGraphGitMilestonePreviewRequestSchema,
  type PlaybookGraphNode,
  type PlaybookGraphOperationKind,
  type PlaybookGraphOperationRecord,
  type PlaybookGraphQueueEntry,
  PlaybookGraphResumeActionSpecSchema,
  PlaybookGraphResumeDecisionSchema,
  type PlaybookGraphReviewEvent,
  PlaybookGraphRunCreateRequestSchema,
  PlaybookGraphRunDetailSchema,
  PlaybookGraphRunListFilterSchema,
  PlaybookGraphRunListResultSchema,
  type PlaybookGraphRunRecord,
  PlaybookGraphRunReviewSurfaceSchema,
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
  type ShellToolCall,
  ShellToolCallSchema,
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
  type WorkflowOutputDeclaration,
  WorkflowResumeRequestSchema,
  type WorkflowRunAssignmentPlan,
  WorkflowRunAssignmentPlanSchema,
  type WorkflowRunEvent,
  WorkflowRunListResultSchema,
  WorkflowRunRequestSchema,
  type WorkflowRunResult,
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
  CORE_VERSION,
  CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW,
  DEFAULT_AGENT_PROFILE,
  DEMO_WORKFLOW,
  type GraphRunStore,
  type OptionalCapabilityInstallProgress,
  type OptionalCapabilityManager,
  type PlaybookGraphAgentAdapterInput,
  type PlaybookGraphArtifactWriteAdapterInput,
  type PlaybookGraphScriptAdapterInput,
  type PlaybookGraphToolAdapterInput,
  type PlaybookGraphToolExecutionPolicy,
  SALES_MEETING_BRIEF_WORKFLOW,
  WEEKLY_STATUS_DIGEST_WORKFLOW,
  WEEKLY_UPDATE_WORKFLOW,
  childPlaybookGraphNodePath,
  createGraphGitMilestoneService,
  createOptionalCapabilityManager,
  createPlaybookGraphCache,
  createPlaybookGraphExecutionContextPin,
  createPlaybookGraphQueueEntry,
  createPlaybookGraphRun,
  createPlaybookGraphSnapshot,
  createSpawnShellExecutor,
  createWorkspaceGuard,
  drainPlaybookGraphRun,
  executeAgentTurn,
  findCliCommand,
  hashPlaybookSourceFiles,
  installGraphPlaybookPackage,
  loadBuiltInGraphPlaybookPackages,
  optionalCapabilityDefinitionsFromEnv,
  parsePinnedCompiledGraph,
  playbookGraphExecutionContextDriftReason,
  readPlaybookGraphPackage,
  resolveSlashSkillInvocation,
  resumeWorkflowRun,
  runWorkflow,
  stableJsonStringify,
} from "@tessera/core";
import { createAgentProfileStore } from "./agent-profile-store.js";
import {
  createPlaywrightBrowserExecutor,
  resolveBrowserRuntimeConfigFromEnv,
} from "./browser-runtime.js";
import { mergeDefaultAgentProfile } from "./default-agent-profile.js";
import {
  type GraphPlaybookRegistryEntry,
  loadInstalledGraphPlaybookRegistry,
} from "./graph-playbook-registry.js";
import { createInboxStore } from "./inbox-store.js";
import { generateDashboardLayout } from "./layout-runner.js";
import {
  type TesseraMemoryManager,
  createMemoryManager,
  createNoopMemoryManager,
} from "./memory-manager.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import { createPlaybookGraphRunStore } from "./playbook-graph-run-store.js";
import { runPlaybookGraphScript } from "./playbook-graph-script-runner.js";
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
const LOCAL_MEMORY_OWNER_ID = "local-owner";
const TESSERA_DATA_DIR = process.env.TESSERA_DATA_DIR ?? join(homedir(), ".tessera");
const GRAPH_PLAYBOOK_INSTALL_ROOT =
  process.env.TESSERA_GRAPH_PLAYBOOK_INSTALL_ROOT ??
  join(TESSERA_DATA_DIR, "graph-playbooks", "installed");
const GRAPH_PLAYBOOK_CACHE_ROOT =
  process.env.TESSERA_GRAPH_PLAYBOOK_CACHE_ROOT ??
  join(TESSERA_DATA_DIR, "graph-playbooks", "cache");
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`;
const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const GOOGLE_WORKSPACE_CAPABILITY_ID = "google-workspace-cli";
const GOOGLE_WORKSPACE_BINARY_NAME = "gws";
const GOOGLE_WORKSPACE_CLI_COMMANDS = new Set([
  "calendar",
  "contacts",
  "drive",
  "gcal",
  "gmail",
  "mail",
  "people",
]);
const browserExecutor = createPlaywrightBrowserExecutor({
  artifactDir: join(TESSERA_DATA_DIR, "browser-artifacts"),
  profileDir: join(TESSERA_DATA_DIR, "browser-profile"),
  recipeDir: join(TESSERA_DATA_DIR, "browser-recipes"),
  ...resolveBrowserRuntimeConfigFromEnv(),
});
const optionalCapabilityManager = createOptionalCapabilityManager({
  rootDir: join(TESSERA_DATA_DIR, "capabilities"),
  definitions: optionalCapabilityDefinitionsFromEnv(process.env),
});
type CapabilityInstallProgress = {
  phase: OptionalCapabilityInstallProgress["phase"] | "available" | "failed";
  downloadedBytes?: number;
  totalBytes?: number;
  message?: string;
};
const capabilityInstallProgress = new Map<string, CapabilityInstallProgress>();
const capabilityInstallTasks = new Map<string, Promise<void>>();
const workflowStore = createWorkflowCheckpointStore(WORKFLOW_DB_PATH);
const graphRunStore = createPlaybookGraphRunStore(WORKFLOW_DB_PATH);
const playbookRunPreferenceStore = createPlaybookRunPreferenceStore(WORKFLOW_DB_PATH);
const taskStore = createTaskStore(TASK_DB_PATH);
const agentProfileStore = createAgentProfileStore(TASK_DB_PATH);
const inboxStore = createInboxStore(TASK_DB_PATH);
const graphRunBackgroundWorkerRef: { current: GraphRunWorker | undefined } = {
  current: undefined,
};
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
  ownerId: LOCAL_MEMORY_OWNER_ID,
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

interface GraphPlaybookRegistryState {
  entries: GraphPlaybookRegistryEntry[];
}

const installedGraphPlaybookRegistryState: GraphPlaybookRegistryState = { entries: [] };

export interface BuiltInGraphPlaybookRegistryEntry extends GraphPlaybookRegistryEntry {
  kind: "built-in";
  compiled: CompiledPlaybookGraph;
  sourceFiles: Record<string, string>;
}

interface BuiltInGraphPlaybookRegistryState {
  entries: BuiltInGraphPlaybookRegistryEntry[];
}

const builtInGraphPlaybookRegistryState: BuiltInGraphPlaybookRegistryState = { entries: [] };

export async function refreshInstalledGraphPlaybookRegistry(
  options: {
    installRoot?: string;
    cacheRoot?: string;
    state?: GraphPlaybookRegistryState;
  } = {}
): Promise<GraphPlaybookRegistryEntry[]> {
  const state = options.state ?? installedGraphPlaybookRegistryState;
  const entries = await loadInstalledGraphPlaybookRegistry({
    installRoot: options.installRoot ?? GRAPH_PLAYBOOK_INSTALL_ROOT,
    cacheRoot: options.cacheRoot ?? GRAPH_PLAYBOOK_CACHE_ROOT,
  });
  state.entries = entries;
  return entries;
}

void refreshInstalledGraphPlaybookRegistry().catch((error) => {
  console.warn(
    JSON.stringify({
      type: "tessera.graph_playbook_registry.startup_failed",
      message: error instanceof Error ? error.message : String(error),
    })
  );
});

export async function refreshBuiltInGraphPlaybookRegistry(
  options: {
    state?: BuiltInGraphPlaybookRegistryState;
    compiledAt?: string;
  } = {}
): Promise<BuiltInGraphPlaybookRegistryEntry[]> {
  const state = options.state ?? builtInGraphPlaybookRegistryState;
  const loaded = await loadBuiltInGraphPlaybookPackages({
    compilerVersion: `tessera-core-${CORE_VERSION}`,
    scriptSdkVersion: `tessera-plugin-sdk-${CORE_VERSION}`,
    ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
  });
  const entries = await Promise.all(
    loaded.map(async (entry) => {
      const packageFiles = await readPlaybookGraphPackage(entry.root);
      return {
        kind: "built-in" as const,
        id: entry.compiled.graph.id,
        version: entry.compiled.graph.version,
        name: entry.compiled.graph.name,
        graphHash: entry.compiled.metadata.graphHash,
        installedRoot: entry.root,
        compiled: entry.compiled,
        sourceFiles: packageFiles.sourceFiles,
      };
    })
  );
  state.entries = entries.sort((left, right) => left.id.localeCompare(right.id));
  return state.entries;
}

void refreshBuiltInGraphPlaybookRegistry().catch((error) => {
  console.warn(
    JSON.stringify({
      type: "tessera.builtin_graph_playbook_registry.startup_failed",
      message: error instanceof Error ? error.message : String(error),
    })
  );
});

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
  graphRunBackgroundWorkerRef.current?.stop();
  void browserExecutor.dispose();
  workflowStore.close();
  graphRunStore.close();
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

function graphMetadataArray<T>(metadata: Record<string, unknown> | undefined, key: string): T[] {
  const value = metadata?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function graphPlaybookVersion(version: string): number {
  const parsed = Number.parseInt(version, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function graphPlaybookSummary(entry: BuiltInGraphPlaybookRegistryEntry): PlaybookSummary {
  const graph = entry.compiled.graph;
  const metadata = graph.metadata;
  return PlaybookSummarySchema.parse({
    id: graph.id,
    version: graphPlaybookVersion(graph.version),
    name: graph.name,
    description: graph.description,
    category: typeof metadata?.category === "string" ? metadata.category : undefined,
    businessUseCase:
      typeof metadata?.businessUseCase === "string" ? metadata.businessUseCase : undefined,
    requiredCapabilities: graphMetadataArray(metadata, "requiredCapabilities"),
    optionalCapabilities: graphMetadataArray(metadata, "optionalCapabilities"),
    outputs: graphMetadataArray<WorkflowOutputDeclaration>(metadata, "outputs"),
    stepCount: graph.nodes.length,
    phases: graphMetadataArray<string>(metadata, "phases"),
  });
}

function graphPlaybookDetail(entry: BuiltInGraphPlaybookRegistryEntry) {
  const summary = graphPlaybookSummary(entry);
  return PlaybookDetailSchema.parse({
    ...summary,
    inputs: entry.compiled.graph.inputs,
    steps: entry.compiled.graph.nodes.map((node) =>
      node.kind === "agent"
        ? {
            id: node.id,
            kind: "agent" as const,
            label: node.label,
            prompt: `file:${node.prompt}`,
            workspaceRootInput: "workspaceRoot",
            onSuccess: node.onSuccess,
            onFailure: node.onFailure,
          }
        : {
            id: node.id,
            kind: "tool" as const,
            label: node.label,
            toolId: "workspace.ping" as const,
            args: {},
            onSuccess: node.onSuccess,
            onFailure: node.onFailure,
          }
    ),
  });
}

async function builtInGraphPlaybooks(): Promise<BuiltInGraphPlaybookRegistryEntry[]> {
  if (builtInGraphPlaybookRegistryState.entries.length > 0) {
    return builtInGraphPlaybookRegistryState.entries;
  }
  return refreshBuiltInGraphPlaybookRegistry();
}

async function builtInGraphPlaybook(
  playbookId: string
): Promise<BuiltInGraphPlaybookRegistryEntry | undefined> {
  return (await builtInGraphPlaybooks()).find((entry) => entry.id === playbookId);
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

function memoryShadowEvent(input: {
  run: WorkflowRunResult;
  memoryShadow: MemoryRecallResult;
}): WorkflowRunEvent {
  return {
    id: `workflow-event-memory-shadow-${randomBytes(8).toString("hex")}`,
    runId: input.run.runId,
    workflowId: input.run.workflowId,
    status: "running",
    message: "Playbook memory shadow recall evaluated",
    createdAt: new Date().toISOString(),
    metadata: {
      memoryShadow: input.memoryShadow,
    },
  };
}

function emptyPlaybookMemoryShadow(input: {
  run: WorkflowRunResult;
  workspaceRoot?: string;
  omittedReason: string;
}): MemoryRecallResult {
  return {
    mode: "workspace",
    timedOut: false,
    items: [],
    trace: {
      query: input.run.workflowId,
      ...(input.workspaceRoot ? { workspaceKey: input.workspaceRoot } : {}),
      candidateCount: 0,
      selectedCount: 0,
      omittedReasons: [input.omittedReason],
      durationMs: 0,
    },
  };
}

export async function attachPlaybookMemoryShadow(
  run: WorkflowRunResult,
  manager: Pick<TesseraMemoryManager, "recallForPlaybookRun"> = memoryManager
): Promise<WorkflowRunResult> {
  const workspaceRoot = workspaceRootFromWorkflowRun(run);
  let memoryShadow: MemoryRecallResult;
  if (!workspaceRoot) {
    memoryShadow = emptyPlaybookMemoryShadow({
      run,
      omittedReason: "playbook memory shadow recall skipped: missing workspace root",
    });
  } else {
    try {
      memoryShadow = await manager.recallForPlaybookRun({
        workflowId: run.workflowId,
        workspaceRoot,
        maxItems: 8,
      });
    } catch {
      memoryShadow = emptyPlaybookMemoryShadow({
        run,
        workspaceRoot,
        omittedReason: "playbook memory shadow recall failed",
      });
    }
  }

  const events = (run.events ?? []).filter(
    (event) => !(event.metadata && "memoryShadow" in event.metadata)
  );
  return {
    ...run,
    events: [...events, memoryShadowEvent({ run, memoryShadow })],
  };
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

async function resolveCapabilityBinary(options: {
  capabilityManager: OptionalCapabilityManager;
  capabilityId: string;
  binaryName: string;
  install: boolean;
}) {
  const initialStatus = await options.capabilityManager.status(options.capabilityId);
  let path = await options.capabilityManager.resolveBinary(
    options.capabilityId,
    options.binaryName
  );

  if (!path && options.install && initialStatus.installAvailable) {
    await installCapabilityBinary({
      capabilityManager: options.capabilityManager,
      capabilityId: options.capabilityId,
      binaryName: options.binaryName,
    });
    path = await options.capabilityManager.resolveBinary(options.capabilityId, options.binaryName);
  }

  const status = await options.capabilityManager.status(options.capabilityId);
  const progress =
    capabilityInstallProgress.get(capabilityKey(options.capabilityId, options.binaryName)) ??
    (path !== undefined
      ? ({
          phase: "installed",
          ...(status.sizeBytes !== undefined
            ? { downloadedBytes: status.sizeBytes, totalBytes: status.sizeBytes }
            : {}),
        } satisfies CapabilityInstallProgress)
      : status.installAvailable
        ? ({
            phase: "available",
            ...(status.sizeBytes !== undefined ? { totalBytes: status.sizeBytes } : {}),
          } satisfies CapabilityInstallProgress)
        : undefined);
  return {
    capabilityId: options.capabilityId,
    binaryName: options.binaryName,
    ...(path !== undefined ? { path } : {}),
    installed: path !== undefined,
    installAvailable: status.installAvailable,
    version: status.version,
    ...(status.sizeBytes !== undefined ? { sizeBytes: status.sizeBytes } : {}),
    ...(status.message !== undefined ? { message: status.message } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}

function capabilityKey(capabilityId: string, binaryName: string): string {
  return `${capabilityId}:${binaryName}`;
}

async function installCapabilityBinary(options: {
  capabilityManager: OptionalCapabilityManager;
  capabilityId: string;
  binaryName: string;
}): Promise<void> {
  const key = capabilityKey(options.capabilityId, options.binaryName);
  const existingTask = capabilityInstallTasks.get(key);
  if (existingTask) {
    await existingTask;
    return;
  }

  const task = (async () => {
    try {
      const initialStatus = await options.capabilityManager.status(options.capabilityId);
      if (initialStatus.installed) {
        capabilityInstallProgress.set(key, {
          phase: "installed",
          ...(initialStatus.sizeBytes !== undefined
            ? { downloadedBytes: initialStatus.sizeBytes, totalBytes: initialStatus.sizeBytes }
            : {}),
        });
        return;
      }
      capabilityInstallProgress.set(key, {
        phase: "downloading",
        ...(initialStatus.sizeBytes !== undefined ? { totalBytes: initialStatus.sizeBytes } : {}),
      });
      await options.capabilityManager.install(options.capabilityId, {
        onProgress(progress) {
          capabilityInstallProgress.set(key, {
            phase: progress.phase,
            ...(progress.downloadedBytes !== undefined
              ? { downloadedBytes: progress.downloadedBytes }
              : {}),
            ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {}),
          });
        },
      });
      const installedStatus = await options.capabilityManager.status(options.capabilityId);
      const currentProgress = capabilityInstallProgress.get(key);
      capabilityInstallProgress.set(
        key,
        installedStatus.sizeBytes !== undefined
          ? {
              phase: "installed",
              downloadedBytes: installedStatus.sizeBytes,
              totalBytes: installedStatus.sizeBytes,
            }
          : currentProgress?.phase === "installed"
            ? currentProgress
            : { phase: "installed" }
      );
    } catch (error) {
      capabilityInstallProgress.set(key, {
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      capabilityInstallTasks.delete(key);
    }
  })();
  capabilityInstallTasks.set(key, task);
  await task;
}

export async function handleCapabilityBinary(
  req: Request,
  capabilityId: string,
  binaryName: string,
  capabilityManager: OptionalCapabilityManager = optionalCapabilityManager
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const result = await resolveCapabilityBinary({
      capabilityManager,
      capabilityId,
      binaryName,
      install: false,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: message },
      { status: message.startsWith("Unknown optional capability") ? 404 : 500 }
    );
  }
}

export async function handleCapabilityBinaryInstall(
  req: Request,
  capabilityId: string,
  binaryName: string,
  capabilityManager: OptionalCapabilityManager = optionalCapabilityManager
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    await installCapabilityBinary({
      capabilityManager,
      capabilityId,
      binaryName,
    });
    const result = await resolveCapabilityBinary({
      capabilityManager,
      capabilityId,
      binaryName,
      install: false,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: message },
      { status: message.startsWith("Unknown optional capability") ? 404 : 500 }
    );
  }
}

function usesGoogleWorkspaceCli(args: string[]): boolean {
  const command = args[0];
  return command !== undefined && GOOGLE_WORKSPACE_CLI_COMMANDS.has(command);
}

export async function resolveGoogleWorkspaceCliEnv(
  args: string[],
  capabilityManager: OptionalCapabilityManager = optionalCapabilityManager,
  env: Record<string, string | undefined> = process.env
): Promise<Record<string, string>> {
  if (!usesGoogleWorkspaceCli(args)) return {};
  if (env.TESSERA_GWS_CLI_PATH?.trim()) return {};

  try {
    const result = await resolveCapabilityBinary({
      capabilityManager,
      capabilityId: GOOGLE_WORKSPACE_CAPABILITY_ID,
      binaryName: GOOGLE_WORKSPACE_BINARY_NAME,
      install: false,
    });
    return result.path ? { TESSERA_GWS_CLI_PATH: result.path } : {};
  } catch {
    return {};
  }
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
  const managedEnv = await resolveGoogleWorkspaceCliEnv(args);
  const proc = Bun.spawn([cliPath, ...args], {
    env: { ...process.env, ...managedEnv },
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

interface GraphPlaybookInstallHandlerOptions {
  installRoot?: string;
  cacheRoot?: string;
  state?: GraphPlaybookRegistryState;
  compilerVersion?: string;
  scriptSdkVersion?: string;
}

function graphPlaybookInstallErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (message.startsWith("Graph playbook package conflict")) {
    return 409;
  }
  if (error instanceof SyntaxError || errorCode === "ENOENT" || errorCode === "ENOTDIR") {
    return 400;
  }
  if (
    message.startsWith("CommonJS require() imports are not allowed") ||
    message.startsWith("Dangerous imports are not allowed") ||
    message.startsWith("Directory symlinks are not allowed") ||
    message.startsWith("Dynamic import() is not allowed") ||
    message.startsWith("Executable hook directories are not allowed") ||
    message.startsWith("Graph playbook default export must be") ||
    message.startsWith("Graph playbook entrypoint must default-export") ||
    message.startsWith("Graph playbook literals") ||
    message.startsWith("Invalid graph playbook package") ||
    message.startsWith("Invalid TypeScript in graph playbook package source") ||
    message.startsWith("Lockfiles are not allowed") ||
    message.startsWith("Graph playbook package") ||
    message.startsWith("Manifest and compiled graph") ||
    message.startsWith("Manifest entrypoint resolves outside") ||
    message.startsWith("Missing graph playbook package") ||
    message.startsWith("Only package-relative imports") ||
    message.startsWith("Package file escapes root") ||
    message.startsWith("Package-relative imports") ||
    message.startsWith("Package-relative paths") ||
    message.startsWith("package.json") ||
    message.startsWith("Playbook graph references missing") ||
    message.startsWith("Symlink resolves outside") ||
    error instanceof TypeError ||
    (error instanceof Error && error.name === "ZodError")
  ) {
    return 400;
  }
  return 500;
}

export async function handleGraphPlaybookInstall(
  req: Request,
  options: GraphPlaybookInstallHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const sourceRoot = typeof input.sourceRoot === "string" ? input.sourceRoot.trim() : "";
  if (!sourceRoot) {
    return Response.json({ error: "sourceRoot is required" }, { status: 400 });
  }

  const installRoot = options.installRoot ?? GRAPH_PLAYBOOK_INSTALL_ROOT;
  const cacheRoot = options.cacheRoot ?? GRAPH_PLAYBOOK_CACHE_ROOT;

  try {
    const installed = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion: options.compilerVersion ?? `tessera-sidecar-${CORE_VERSION}`,
      scriptSdkVersion: options.scriptSdkVersion ?? `tessera-sidecar-${CORE_VERSION}`,
    });
    await refreshInstalledGraphPlaybookRegistry({
      installRoot,
      cacheRoot,
      ...(options.state ? { state: options.state } : {}),
    });

    return Response.json({
      id: installed.compiled.metadata.playbookId,
      version: installed.compiled.metadata.packageVersion,
      graphHash: installed.compiled.metadata.graphHash,
      sourceHash: installed.compiled.metadata.sourceHash,
      ...(installed.warnings?.length ? { warnings: installed.warnings } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: graphPlaybookInstallErrorStatus(error) });
  }
}

const GRAPH_RUN_WORKER_ACTIVE_STATUSES = new Set<PlaybookGraphRunRecord["status"]>([
  "queued",
  "running",
  "interrupted",
]);
const DEFAULT_GRAPH_RUN_WORKER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_GRAPH_RUN_WORKER_LEASE_RENEWAL_MS = 10_000;

export interface GraphRunHandlerOptions {
  store?: GraphRunStore;
  cacheRoot?: string;
  installRoot?: string;
  graphPlaybookRegistryState?: GraphPlaybookRegistryState;
  workspaceRoot?: string;
  runtimeId?: string;
  now?: () => string;
  leaseMs?: number;
  leaseRenewalMs?: number;
  maxSteps?: number;
  executionContext?: Record<string, unknown>;
  agentProfile?: AgentProfile;
  agentProvider?: AgentProviderConfig;
  credential?: ModelRuntimeCredential;
  scriptTimeoutMs?: number;
  scriptBunExecutable?: string;
  workspaceCli?: (args: string[], timeoutMs?: number) => Promise<SpawnResult>;
  scriptAdapter?: (input: PlaybookGraphScriptAdapterInput) => Promise<unknown> | unknown;
  agentAdapter?: (input: PlaybookGraphAgentAdapterInput) => Promise<unknown> | unknown;
  toolAdapter?: (input: PlaybookGraphToolAdapterInput) => Promise<unknown> | unknown;
  toolAdapters?: Record<
    string,
    (input: PlaybookGraphToolAdapterInput) => Promise<unknown> | unknown
  >;
  toolPolicies?: Record<string, PlaybookGraphToolExecutionPolicy>;
  toolCapabilities?: string[];
  artifactWriteAdapter?: (
    input: PlaybookGraphArtifactWriteAdapterInput
  ) => Promise<unknown> | unknown;
  gitMilestoneService?: ReturnType<typeof createGraphGitMilestoneService>;
}

export interface GraphRunInterruptedRecoveryResult {
  interrupted: number;
  requeued: number;
  blocked: number;
}

export interface GraphRunWorkQueueDrainResult {
  inspected: number;
  recovered: number;
  requeued: number;
  blocked: number;
  drained: number;
  skipped: number;
  errors: Array<{ runId: string; message: string }>;
}

export interface GraphRunWorker {
  start(): void;
  /**
   * Stops scheduling future worker ticks. Any in-flight tick is allowed to finish
   * because queue leases and checkpoint guards remain the durability boundary.
   */
  stop(): void;
  tick(): Promise<GraphRunWorkQueueDrainResult>;
}

export interface GraphRunWorkerOptions extends GraphRunHandlerOptions {
  pollIntervalMs?: number;
  warn?: (message: string) => void;
}

function graphRunOptionsWithWorkspaceRoot(
  options: GraphRunHandlerOptions,
  workspaceRoot: string | undefined
): GraphRunHandlerOptions {
  if (!workspaceRoot) return options;
  return { ...options, workspaceRoot };
}

function graphRunOptionsWithExecutionContext(
  options: GraphRunHandlerOptions,
  executionContext: Record<string, unknown> | undefined
): GraphRunHandlerOptions {
  if (executionContext === undefined) return options;
  return { ...options, executionContext };
}

function sidecarGraphRunRuntimeId(label: string): string {
  return `sidecar-${process.pid}-${label}`;
}

function graphRunNow(options: GraphRunHandlerOptions): string {
  return options.now ? options.now() : new Date().toISOString();
}

function graphRunOperationKind(decision: string): PlaybookGraphOperationKind {
  switch (decision) {
    case "edit_input":
      return "edit_input";
    case "edit_artifact":
      return "edit_artifact";
    case "edit_review":
      return "edit_review";
    case "retry_interrupted":
      return "retry_interrupted";
    case "approve_repair":
    case "retry_repair":
      return "repair";
    default:
      return "resume";
  }
}

function graphRunOperationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|secret|password|credential|authorization)\s*[:=]\s*\S+/gi,
      "$1: [redacted]"
    )
    .slice(0, 1_000);
}

function graphRunPayloadSummary(payload: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (
      /api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|secret|password|credential|authorization/i.test(
        key
      )
    ) {
      continue;
    }
    if (typeof value === "string") {
      parts.push(`${key}: ${value.length} chars`);
    } else if (value && typeof value === "object") {
      parts.push(`${key}: object`);
    } else if (value !== undefined) {
      parts.push(`${key}: ${typeof value}`);
    }
  }
  return parts.length > 0 ? parts.join(", ").slice(0, 500) : undefined;
}

function graphRunOperationRecord(input: {
  runId: string;
  actionSpecId: string;
  kind: PlaybookGraphOperationKind;
  status: PlaybookGraphOperationRecord["status"];
  operatorIntent: string;
  createdAt: string;
  operationAttemptId?: string;
  queueEntryId?: string;
  affectedArtifactIds?: string[];
  affectedReviewEventIds?: string[];
  affectedQueueEntryIds?: string[];
  gitEvidenceId?: string;
  redactedPayloadSummary?: string;
  failureReason?: string;
}): PlaybookGraphOperationRecord {
  return {
    schemaVersion: 1,
    operationRecordId: randomUUID(),
    operationAttemptId: input.operationAttemptId ?? randomUUID(),
    runId: input.runId,
    actionSpecId: input.actionSpecId,
    kind: input.kind,
    status: input.status,
    operatorIntent: input.operatorIntent,
    ...(input.queueEntryId ? { queueEntryId: input.queueEntryId } : {}),
    affectedArtifactIds: input.affectedArtifactIds ?? [],
    affectedReviewEventIds: input.affectedReviewEventIds ?? [],
    affectedQueueEntryIds: input.affectedQueueEntryIds ?? [],
    ...(input.gitEvidenceId ? { gitEvidenceId: input.gitEvidenceId } : {}),
    ...(input.redactedPayloadSummary
      ? { redactedPayloadSummary: input.redactedPayloadSummary }
      : {}),
    createdAt: input.createdAt,
    ...(input.status === "started" ? {} : { completedAt: input.createdAt }),
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
  };
}

function graphRunOperationTerminalTime(startedAt: string, options: GraphRunHandlerOptions): string {
  const terminalAt = graphRunNow(options);
  if (terminalAt > startedAt) return terminalAt;
  return new Date(Date.parse(startedAt) + 1).toISOString();
}

function graphRunPayloadWorkspaceRoot(payload: Record<string, unknown>): string | undefined {
  const workspaceRoot = payload.workspaceRoot;
  return typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot : undefined;
}

function formatGraphArtifactWriteContent(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value, null, 2);
  return `${json ?? String(value)}\n`;
}

async function createWorkspaceArtifactWriteAdapter(
  workspaceRoot: string
): Promise<NonNullable<GraphRunHandlerOptions["artifactWriteAdapter"]>> {
  const guard = await createWorkspaceGuard(workspaceRoot);
  return async ({ node, artifactVersion, value }) => {
    const parentAbsolute = await guard.resolveInsideWorkspaceForCreate(dirname(node.path));
    await mkdir(parentAbsolute, { recursive: true });
    const absolute = await guard.resolveInsideWorkspaceForCreate(node.path);
    const content = formatGraphArtifactWriteContent(value);
    await writeFile(absolute, content, "utf8");
    return {
      path: relative(guard.root, absolute),
      bytes: Buffer.byteLength(content),
      artifactId: node.artifact,
      artifactVersionId: artifactVersion.versionId,
      contentHash: artifactVersion.contentHash,
    };
  };
}

async function graphRunArtifactWriteAdapter(
  runId: string,
  store: GraphRunStore,
  options: GraphRunHandlerOptions
): Promise<GraphRunHandlerOptions["artifactWriteAdapter"] | undefined> {
  if (options.artifactWriteAdapter) return options.artifactWriteAdapter;
  const persistedRun = await store.getRun(runId);
  const workspaceRoot =
    persistedRun?.materialization?.kind === "workspace"
      ? persistedRun.materialization.workspaceRoot
      : options.workspaceRoot;
  if (!workspaceRoot) return undefined;
  return createWorkspaceArtifactWriteAdapter(workspaceRoot);
}

async function graphRunScriptAdapter(
  runId: string,
  store: GraphRunStore,
  options: GraphRunHandlerOptions
): Promise<GraphRunHandlerOptions["scriptAdapter"] | undefined> {
  if (options.scriptAdapter) return options.scriptAdapter;
  const persistedRun = await store.getRun(runId);
  if (!persistedRun?.snapshot.sourceFiles) return undefined;
  return (input) =>
    runPlaybookGraphScript({
      input,
      ...(options.scriptTimeoutMs === undefined ? {} : { timeoutMs: options.scriptTimeoutMs }),
      ...(options.scriptBunExecutable === undefined
        ? {}
        : { bunExecutable: options.scriptBunExecutable }),
    });
}

function graphRunHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

function graphRunWorkspaceCli(
  options: GraphRunHandlerOptions
): (args: string[], timeoutMs?: number) => Promise<SpawnResult> {
  return options.workspaceCli ?? runWorkspaceCli;
}

function graphRunRuntimeAuthFingerprint(
  credential: ModelRuntimeCredential | undefined
): Record<string, unknown> | undefined {
  if (!credential) return undefined;
  if ("apiKey" in credential) {
    return {
      runtimeAuthKind: "api_key",
      runtimeAuthDigest: graphRunHash({
        kind: "api_key",
        value: credential.apiKey,
      }),
    };
  }
  return {
    runtimeAuthKind: credential.authType,
    runtimeAuthBaseUrl: credential.baseUrl,
    ...(credential.accountId ? { runtimeAuthAccountId: credential.accountId } : {}),
    runtimeAuthDigest: graphRunHash({
      kind: credential.authType,
      value: credential.accessToken,
    }),
  };
}

function graphRunAgentExecutionContext(input: {
  agent: AgentProfile;
  provider: AgentProviderConfig;
  credential?: ModelRuntimeCredential;
}): Record<string, unknown> {
  const runtimeAuth = graphRunRuntimeAuthFingerprint(input.credential);
  return {
    agentProfileId: input.agent.id,
    agentProfileUpdatedAt: input.agent.updatedAt,
    provider: input.provider.provider,
    model: input.provider.model,
    providerFingerprint: graphRunHash(input.provider),
    ...(runtimeAuth ? { runtimeAuth } : {}),
  };
}

function graphRunAgentProvider(options: GraphRunHandlerOptions): AgentProviderConfig | undefined {
  if (options.agentProvider) return options.agentProvider;
  const agent = options.agentProfile;
  return agent?.model.mode === "override" ? agent.model.provider : undefined;
}

function graphRunAgentPrompt(input: PlaybookGraphAgentAdapterInput): string {
  const context = stableJsonStringify({
    runId: input.run.runId,
    nodeId: input.node.id,
    input: input.input,
    artifacts: input.artifacts,
    branchItem: input.branchItem?.value,
  });
  return [
    input.prompt ?? `Execute graph agent node ${input.node.id}.`,
    "",
    "Pinned graph runtime context:",
    context,
  ].join("\n");
}

function graphRunAgentOutput(result: AgentTurnResult): unknown {
  const text = result.messages
    .map((message) => message.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n\n");
  return {
    status: result.status,
    ...(text ? { text } : {}),
    toolResults: result.toolResults,
    permissionDecisions: result.permissionDecisions,
    ...(result.error ? { error: result.error } : {}),
  };
}

function graphRunAgentAdapter(
  options: GraphRunHandlerOptions
): GraphRunHandlerOptions["agentAdapter"] | undefined {
  if (options.agentAdapter) return options.agentAdapter;
  const agent = options.agentProfile ?? defaultAgentProfile();
  const provider = graphRunAgentProvider({ ...options, agentProfile: agent });
  if (!provider && !options.credential) return undefined;
  if (!provider) throw new Error("Graph agent execution requires a model provider");
  const workspaceCli = graphRunWorkspaceCli(options);
  return async (input) => {
    const result = await executeAgentTurn({
      cli: { runWorkspaceCli: workspaceCli },
      request: {
        prompt: graphRunAgentPrompt(input),
        provider,
        grants: [],
        ...(options.credential ? { credential: options.credential } : {}),
        timeoutMs: 120_000,
      },
    });
    return graphRunAgentOutput(result);
  };
}

const GRAPH_RUN_DEFAULT_TOOL_POLICIES: Record<string, PlaybookGraphToolExecutionPolicy> = {
  "web.search": { capability: "web.search", idempotent: true, sideEffect: "read" },
  "web.fetch": { capability: "web.fetch", idempotent: true, sideEffect: "read" },
  "integration.web.search": {
    capability: "integration.web.search",
    idempotent: true,
    sideEffect: "read",
  },
  "integration.web.fetch": {
    capability: "integration.web.fetch",
    idempotent: true,
    sideEffect: "read",
  },
  "integration.calendar.events.read": {
    capability: "integration.calendar.events.read",
    idempotent: true,
    sideEffect: "read",
  },
  "integration.mail.messages.read": {
    capability: "integration.mail.messages.read",
    idempotent: true,
    sideEffect: "read",
  },
  "integration.drive.files.read": {
    capability: "integration.drive.files.read",
    idempotent: true,
    sideEffect: "read",
  },
  "integration.contacts.read": {
    capability: "integration.contacts.read",
    idempotent: true,
    sideEffect: "read",
  },
};

const GRAPH_RUN_TOOL_SHELL_ALLOWLIST: Record<
  string,
  Array<Pick<ShellToolCall, "command" | "subcommand">>
> = {
  "web.search": [{ command: "web-search", subcommand: "search" }],
  "web.fetch": [{ command: "web-fetch", subcommand: "fetch" }],
  "integration.web.search": [{ command: "web-search", subcommand: "search" }],
  "integration.web.fetch": [{ command: "web-fetch", subcommand: "fetch" }],
  "integration.calendar.events.read": [
    { command: "gcal", subcommand: "list" },
    { command: "gcal", subcommand: "read" },
  ],
  "integration.mail.messages.read": [
    { command: "mail", subcommand: "list" },
    { command: "mail", subcommand: "search" },
    { command: "mail", subcommand: "read" },
  ],
  "integration.drive.files.read": [
    { command: "drive", subcommand: "search" },
    { command: "drive", subcommand: "read" },
  ],
  "integration.contacts.read": [{ command: "contacts", subcommand: "lookup" }],
};

function graphRunDefaultToolPolicies(
  options: GraphRunHandlerOptions
): Record<string, PlaybookGraphToolExecutionPolicy> {
  return {
    ...GRAPH_RUN_DEFAULT_TOOL_POLICIES,
    ...(options.toolPolicies ?? {}),
  };
}

function graphRunDefaultToolCapabilities(options: GraphRunHandlerOptions): string[] {
  return options.toolCapabilities ?? Object.keys(graphRunDefaultToolPolicies(options));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function graphRunShellCallFromTool(input: PlaybookGraphToolAdapterInput): ShellToolCall {
  const args = input.node.args;
  const explicitCommand = typeof args.command === "string" ? args.command : undefined;
  const explicitSubcommand = typeof args.subcommand === "string" ? args.subcommand : undefined;
  const explicitArgs = stringArray(args.args);
  const query = typeof args.query === "string" ? args.query : undefined;
  const url = typeof args.url === "string" ? args.url : undefined;

  const inferred =
    input.node.capability === "web.search" || input.node.capability === "integration.web.search"
      ? { command: "web-search", subcommand: "search", args: query ? [query] : explicitArgs }
      : input.node.capability === "web.fetch" || input.node.capability === "integration.web.fetch"
        ? { command: "web-fetch", subcommand: "fetch", args: url ? [url] : explicitArgs }
        : explicitCommand && explicitSubcommand
          ? { command: explicitCommand, subcommand: explicitSubcommand, args: explicitArgs }
          : undefined;

  if (!inferred) {
    throw new Error(
      `Graph tool ${input.node.id} requires shell command/subcommand args for ${input.node.capability}`
    );
  }

  const call = ShellToolCallSchema.parse(inferred);
  const policy = findCliCommand(call);
  const allowlist = GRAPH_RUN_TOOL_SHELL_ALLOWLIST[input.node.capability] ?? [];
  const allowedForCapability = allowlist.some(
    (item) => item.command === call.command && item.subcommand === call.subcommand
  );
  if (!policy || policy.approval !== "allow" || !allowedForCapability) {
    throw new Error(
      `Graph tool ${input.node.id} cannot execute ${call.command} ${call.subcommand} under ${input.node.capability}`
    );
  }
  return call;
}

function defaultGraphRunToolAdapter(
  options: GraphRunHandlerOptions
): NonNullable<GraphRunHandlerOptions["toolAdapter"]> {
  const shell = createSpawnShellExecutor({
    runWorkspaceCli: graphRunWorkspaceCli(options),
  });
  return async (input) => shell.executeShell(graphRunShellCallFromTool(input));
}

function graphRunToolAdapter(
  options: GraphRunHandlerOptions
): GraphRunHandlerOptions["toolAdapter"] | undefined {
  if (options.toolAdapter) return options.toolAdapter;
  const defaultAdapter = defaultGraphRunToolAdapter(options);
  return async (input) => {
    const adapter = options.toolAdapters?.[input.node.capability];
    if (adapter) {
      return adapter(input);
    }
    if (!GRAPH_RUN_DEFAULT_TOOL_POLICIES[input.node.capability]) {
      throw new Error(`No graph tool adapter registered for capability: ${input.node.capability}`);
    }
    return defaultAdapter(input);
  };
}

function graphRunOptionsWithAgentRuntime(
  options: GraphRunHandlerOptions,
  runtime: {
    agentProvider?: AgentProviderConfig;
    credential?: ModelRuntimeCredential;
    agentProfile?: AgentProfile;
  }
): GraphRunHandlerOptions {
  return {
    ...options,
    ...(runtime.agentProfile ? { agentProfile: runtime.agentProfile } : {}),
    ...(runtime.agentProvider ? { agentProvider: runtime.agentProvider } : {}),
    ...(runtime.credential ? { credential: runtime.credential } : {}),
  };
}

async function graphRunDetail(
  runId: string,
  store: GraphRunStore
): Promise<ReturnType<typeof PlaybookGraphRunDetailSchema.parse> | undefined> {
  const run = await store.getRun(runId);
  if (!run) return undefined;
  return PlaybookGraphRunDetailSchema.parse({
    run,
    queue: await store.getQueue(runId),
    branchItems: await store.listBranchItems(runId),
    artifacts: await store.listArtifactVersions(runId),
    reviews: await store.listReviewEvents(runId),
    operations: await store.listOperationRecords(runId),
  });
}

type GraphRunDetail = ReturnType<typeof PlaybookGraphRunDetailSchema.parse>;
type GraphRunReviewSurface = ReturnType<typeof PlaybookGraphRunReviewSurfaceSchema.parse>;

function graphQueueById(detail: GraphRunDetail): Map<string, PlaybookGraphQueueEntry> {
  return new Map(detail.queue.map((entry) => [entry.queueEntryId, entry]));
}

function graphArtifactSortKey(version: PlaybookGraphArtifactVersion): string {
  return [
    version.createdAt,
    version.artifactId,
    version.versionId,
    version.producerQueueEntryId,
  ].join("\u0000");
}

function graphTimelineSortKey(row: {
  createdAt: string;
  queueEntryId?: string | undefined;
  reviewEventId?: string | undefined;
  artifactId?: string | undefined;
  timelineRowId: string;
}): string {
  return [
    row.createdAt,
    row.queueEntryId ?? "",
    row.reviewEventId ?? "",
    row.artifactId ?? "",
    row.timelineRowId,
  ].join("\u0000");
}

function graphRunNodeForQueueEntry(
  detail: GraphRunDetail,
  entry: PlaybookGraphQueueEntry
): PlaybookGraphNode | undefined {
  try {
    return findGraphRunNode(
      parsePinnedCompiledGraph(detail.run.snapshot).graph.nodes,
      entry.nodeId
    );
  } catch {
    return undefined;
  }
}

function graphRunActiveArtifactRows(
  detail: GraphRunDetail
): GraphRunReviewSurface["activeArtifacts"] {
  const queueById = graphQueueById(detail);
  const activeVersions = detail.artifacts.filter(
    (version) => queueById.get(version.producerQueueEntryId)?.status !== "skipped"
  );
  const latestByArtifact = new Map<string, PlaybookGraphArtifactVersion>();
  for (const version of [...activeVersions].sort((left, right) =>
    graphArtifactSortKey(left).localeCompare(graphArtifactSortKey(right))
  )) {
    latestByArtifact.set(version.artifactId, version);
  }
  return [...latestByArtifact.values()]
    .sort((left, right) => graphArtifactSortKey(right).localeCompare(graphArtifactSortKey(left)))
    .map((version) => ({
      schemaVersion: 1 as const,
      artifactId: version.artifactId,
      versionId: version.versionId,
      producerQueueEntryId: version.producerQueueEntryId,
      producerStatus: queueById.get(version.producerQueueEntryId)?.status,
      nodePath: version.nodePath,
      contentHash: version.contentHash,
      value: version.value,
      createdAt: version.createdAt,
    }));
}

function graphRunArtifactTimelineRows(
  detail: GraphRunDetail,
  activeArtifacts: GraphRunReviewSurface["activeArtifacts"]
): GraphRunReviewSurface["artifactTimeline"] {
  const queueById = graphQueueById(detail);
  const activeVersionIds = new Set(
    activeArtifacts.map((artifact) => `${artifact.artifactId}:${artifact.versionId}`)
  );
  return [...detail.artifacts]
    .sort((left, right) => graphArtifactSortKey(right).localeCompare(graphArtifactSortKey(left)))
    .map((version) => ({
      schemaVersion: 1 as const,
      artifactId: version.artifactId,
      versionId: version.versionId,
      producerQueueEntryId: version.producerQueueEntryId,
      producerStatus: queueById.get(version.producerQueueEntryId)?.status,
      nodePath: version.nodePath,
      contentHash: version.contentHash,
      active: activeVersionIds.has(`${version.artifactId}:${version.versionId}`),
      value: version.value,
      createdAt: version.createdAt,
    }));
}

function graphRunTimelineRows(detail: GraphRunDetail): GraphRunReviewSurface["timeline"] {
  const persisted: GraphRunReviewSurface["timeline"] = detail.reviews.map((event) => ({
    schemaVersion: 1 as const,
    timelineRowId: `review:${event.reviewEventId}`,
    kind: "review_event" as const,
    createdAt: event.createdAt,
    synthetic: false,
    queueEntryId: event.queueEntryId,
    nodePath: event.nodePath,
    artifactId: event.artifactId,
    reviewEventId: event.reviewEventId,
    decision: event.decision,
    message: `Review ${event.decision.replace("_", " ")}`,
    payload: event.payload,
  }));
  const operations: GraphRunReviewSurface["timeline"] = detail.operations.map((record) => ({
    schemaVersion: 1 as const,
    timelineRowId: `operation:${record.operationRecordId}`,
    kind: "operation_record" as const,
    createdAt: record.createdAt,
    synthetic: false,
    queueEntryId: record.queueEntryId,
    message: `${record.operatorIntent} ${record.status}`,
    payload: {
      operationRecordId: record.operationRecordId,
      operationAttemptId: record.operationAttemptId,
      kind: record.kind,
      status: record.status,
      ...(record.gitEvidenceId ? { gitEvidenceId: record.gitEvidenceId } : {}),
      ...(record.failureReason ? { failureReason: record.failureReason } : {}),
    },
  }));
  const requestedEventKeys = new Set(
    detail.reviews
      .filter((event) => event.decision === "requested")
      .map((event) => `${event.queueEntryId}:${event.artifactId}`)
  );
  const synthetic: GraphRunReviewSurface["timeline"] = [];
  for (const entry of detail.queue) {
    if (entry.status === "blocked" && entry.nodeKind === "humanReview") {
      const node = graphRunNodeForQueueEntry(detail, entry);
      const artifactId =
        detail.reviews.find((event) => event.queueEntryId === entry.queueEntryId)?.artifactId ??
        (node?.kind === "humanReview" ? node.artifact : undefined) ??
        "review";
      if (requestedEventKeys.has(`${entry.queueEntryId}:${artifactId}`)) continue;
      synthetic.push({
        schemaVersion: 1 as const,
        timelineRowId: `${detail.run.runId}:${entry.queueEntryId}:synthetic_requested`,
        kind: "synthetic_requested" as const,
        createdAt: entry.updatedAt,
        synthetic: true,
        queueEntryId: entry.queueEntryId,
        nodePath: entry.nodePath,
        artifactId,
        decision: "requested" as const,
        message: entry.blockedReason ?? "human review required",
        payload: {},
      });
      continue;
    }
    if (entry.status === "interrupted") {
      synthetic.push({
        schemaVersion: 1 as const,
        timelineRowId: `${detail.run.runId}:${entry.queueEntryId}:synthetic_interrupted`,
        kind: "synthetic_interrupted" as const,
        createdAt: entry.updatedAt,
        synthetic: true,
        queueEntryId: entry.queueEntryId,
        nodePath: entry.nodePath,
        message: entry.blockedReason ?? "queue entry interrupted",
        payload: {},
      });
    }
  }
  const repair: GraphRunReviewSurface["timeline"] =
    detail.run.status === "needs_repair"
      ? [
          {
            schemaVersion: 1 as const,
            timelineRowId: `${detail.run.runId}:synthetic_repair`,
            kind: "synthetic_repair" as const,
            createdAt: detail.run.updatedAt,
            synthetic: true,
            message: detail.run.repairReason ?? "graph run needs repair",
            payload: {},
          },
        ]
      : [];
  return [...persisted, ...operations, ...synthetic, ...repair].sort((left, right) =>
    graphTimelineSortKey(left).localeCompare(graphTimelineSortKey(right))
  );
}

function graphRunBranchGroups(
  detail: GraphRunDetail,
  activeArtifacts: GraphRunReviewSurface["activeArtifacts"]
): GraphRunReviewSurface["branches"] {
  const queueByParent = new Map<string, PlaybookGraphQueueEntry[]>();
  for (const entry of detail.queue) {
    const branchItem = detail.branchItems
      .filter(
        (item) => entry.nodePath === item.nodePath || entry.nodePath.startsWith(`${item.nodePath}/`)
      )
      .sort((left, right) => right.nodePath.length - left.nodePath.length)[0];
    if (!branchItem) continue;
    const entries = queueByParent.get(branchItem.branchItemId) ?? [];
    entries.push(entry);
    queueByParent.set(branchItem.branchItemId, entries);
  }
  return detail.queue
    .filter((entry) => entry.nodeKind === "parallelMap")
    .sort((left, right) => left.nodePath.localeCompare(right.nodePath))
    .map((parent) => {
      const items = detail.branchItems
        .filter((item) => item.parentQueueEntryId === parent.queueEntryId)
        .sort(
          (left, right) =>
            left.index - right.index || left.branchItemId.localeCompare(right.branchItemId)
        )
        .map((item) => {
          const queue = [...(queueByParent.get(item.branchItemId) ?? [])].sort((left, right) =>
            left.nodePath.localeCompare(right.nodePath)
          );
          const queueIds = new Set(queue.map((entry) => entry.queueEntryId));
          return {
            schemaVersion: 1 as const,
            branchItem: item,
            queue,
            activeArtifacts: activeArtifacts.filter((artifact) =>
              queueIds.has(artifact.producerQueueEntryId)
            ),
            stale: item.status === "skipped" || queue.some((entry) => entry.status === "skipped"),
            error: queue.find((entry) => entry.error)?.error,
          };
        });
      return {
        schemaVersion: 1 as const,
        parentQueueEntryId: parent.queueEntryId,
        parentNodePath: parent.nodePath,
        parentStatus: parent.status,
        items,
      };
    });
}

function graphRunActionSpecs(detail: GraphRunDetail): GraphRunReviewSurface["actions"] {
  const actions: GraphRunReviewSurface["actions"] = [];
  const actionSpec = (input: unknown): GraphRunReviewSurface["actions"][number] =>
    PlaybookGraphResumeActionSpecSchema.parse(input);
  const blocked = detail.queue.filter((entry) => entry.status === "blocked");
  for (const entry of blocked) {
    if (entry.nodeKind === "humanReview") {
      const node = graphRunNodeForQueueEntry(detail, entry);
      actions.push(
        actionSpec({
          schemaVersion: 1,
          actionId: `${entry.queueEntryId}:approve`,
          decision: "approve",
          label: "Approve",
          queueEntryId: entry.queueEntryId,
          nodePath: entry.nodePath,
          nodeKind: entry.nodeKind,
          allowedRunStatuses: ["blocked"],
          allowedQueueStatuses: ["blocked"],
          sideEffect: "resume",
        })
      );
      if (node?.kind === "humanReview" && node.onRequestChanges) {
        actions.push(
          actionSpec({
            schemaVersion: 1,
            actionId: `${entry.queueEntryId}:request_changes`,
            decision: "request_changes",
            label: "Request changes",
            queueEntryId: entry.queueEntryId,
            nodePath: entry.nodePath,
            nodeKind: entry.nodeKind,
            allowedRunStatuses: ["blocked"],
            allowedQueueStatuses: ["blocked"],
            requiredPayloadFields: [
              { path: "notes", label: "Notes", kind: "string", required: false },
            ],
            sideEffect: "invalidate_downstream",
            invalidatesDownstream: true,
          })
        );
      }
      actions.push(
        actionSpec({
          schemaVersion: 1,
          actionId: `${entry.queueEntryId}:deny`,
          decision: "deny",
          label: "Stop run",
          queueEntryId: entry.queueEntryId,
          nodePath: entry.nodePath,
          nodeKind: entry.nodeKind,
          allowedRunStatuses: ["blocked"],
          allowedQueueStatuses: ["blocked"],
          sideEffect: "terminal",
          destructive: true,
        }),
        actionSpec({
          schemaVersion: 1,
          actionId: `${entry.queueEntryId}:edit_artifact`,
          decision: "edit_artifact",
          label: "Edit artifact",
          queueEntryId: entry.queueEntryId,
          nodePath: entry.nodePath,
          nodeKind: entry.nodeKind,
          allowedRunStatuses: ["blocked"],
          allowedQueueStatuses: ["blocked"],
          requiredPayloadFields: [
            { path: "artifactId", label: "Artifact", kind: "string" },
            { path: "value", label: "Value", kind: "json" },
          ],
          sideEffect: "invalidate_downstream",
          invalidatesDownstream: true,
        }),
        actionSpec({
          schemaVersion: 1,
          actionId: `${entry.queueEntryId}:edit_review`,
          decision: "edit_review",
          label: "Edit review",
          queueEntryId: entry.queueEntryId,
          nodePath: entry.nodePath,
          nodeKind: entry.nodeKind,
          allowedRunStatuses: ["blocked"],
          allowedQueueStatuses: ["blocked"],
          requiredPayloadFields: [
            { path: "artifactId", label: "Artifact", kind: "string", required: false },
            { path: "notes", label: "Notes", kind: "string", required: false },
          ],
          sideEffect: "invalidate_downstream",
          invalidatesDownstream: true,
        })
      );
    }
  }
  for (const entry of detail.queue.filter((entry) => entry.status === "interrupted")) {
    actions.push(
      actionSpec({
        schemaVersion: 1,
        actionId: `${entry.queueEntryId}:retry_interrupted`,
        decision: "retry_interrupted",
        label: "Retry interrupted work",
        queueEntryId: entry.queueEntryId,
        nodePath: entry.nodePath,
        nodeKind: entry.nodeKind,
        allowedRunStatuses: ["interrupted", "running", "blocked"],
        allowedQueueStatuses: ["interrupted"],
        sideEffect: "resume",
        requiresWorkspace: entry.nodeKind === "artifactWrite",
      })
    );
  }
  if (
    detail.run.status === "blocked" &&
    detail.run.blockedReason?.includes("execution context changed")
  ) {
    actions.push(
      actionSpec({
        schemaVersion: 1,
        actionId: `${detail.run.runId}:approve_context_change`,
        decision: "approve_context_change",
        label: "Approve context change",
        allowedRunStatuses: ["blocked"],
        allowedQueueStatuses: [],
        sideEffect: "resume",
        requiresExecutionContext: true,
        requiresProvider: true,
      })
    );
  }
  if (detail.run.status === "needs_repair") {
    actions.push(
      actionSpec({
        schemaVersion: 1,
        actionId: `${detail.run.runId}:approve_repair`,
        decision: "approve_repair",
        label: "Approve repair",
        allowedRunStatuses: ["needs_repair"],
        allowedQueueStatuses: [],
        requiredPayloadFields: [
          {
            path: "compiledGraph",
            label: "Compiled graph",
            kind: "compiledGraph",
            required: false,
          },
          { path: "sourceFiles", label: "Source files", kind: "sourceFiles", required: false },
        ],
        sideEffect: "resume",
      })
    );
  }
  actions.push(
    actionSpec({
      schemaVersion: 1,
      actionId: `${detail.run.runId}:edit_input`,
      decision: "edit_input",
      label: "Edit input",
      allowedRunStatuses: [
        "queued",
        "running",
        "blocked",
        "interrupted",
        "completed",
        "failed",
        "needs_repair",
      ],
      allowedQueueStatuses: [],
      requiredPayloadFields: [{ path: "input", label: "Input", kind: "object" }],
      sideEffect: "invalidate_downstream",
      invalidatesDownstream: true,
    })
  );
  return actions.sort((left, right) => left.actionId.localeCompare(right.actionId));
}

async function graphRunGitMilestonePreview(
  detail: GraphRunDetail,
  options: GraphRunHandlerOptions
): Promise<GraphRunReviewSurface["gitMilestone"]> {
  const workspaceRoot =
    detail.run.materialization?.kind === "workspace"
      ? detail.run.materialization.workspaceRoot
      : options.workspaceRoot;
  if (!workspaceRoot) {
    return {
      schemaVersion: 1,
      available: false,
      unavailableReason: "Git milestone service requires a workspace-backed graph run",
      changedFiles: [],
      dirtyPolicy: "allow_selected_paths",
      unsupportedFeatures: ["run branches", "rollback", "promotion"],
    };
  }
  const service = options.gitMilestoneService ?? createGraphGitMilestoneService();
  return service.preview({
    runId: detail.run.runId,
    actionSpecId: `${detail.run.runId}:git_milestone`,
    workspaceRoot,
  });
}

async function graphRunReviewSurfaceFromDetail(
  detail: GraphRunDetail,
  _options: GraphRunHandlerOptions
): Promise<GraphRunReviewSurface> {
  const activeArtifacts = graphRunActiveArtifactRows(detail);
  return PlaybookGraphRunReviewSurfaceSchema.parse({
    schemaVersion: 1,
    detail,
    activeArtifacts,
    artifactTimeline: graphRunArtifactTimelineRows(detail, activeArtifacts),
    timeline: graphRunTimelineRows(detail),
    branches: graphRunBranchGroups(detail, activeArtifacts),
    actions: graphRunActionSpecs(detail),
  });
}

async function graphRunReviewSurface(
  runId: string,
  store: GraphRunStore,
  options: GraphRunHandlerOptions
): Promise<GraphRunReviewSurface | undefined> {
  const detail = await graphRunDetail(runId, store);
  if (!detail) return undefined;
  return graphRunReviewSurfaceFromDetail(detail, options);
}

async function maybeDrainGraphRun(
  runId: string,
  options: GraphRunHandlerOptions
): Promise<boolean> {
  const store = options.store ?? graphRunStore;
  const scriptAdapter = await graphRunScriptAdapter(runId, store, options);
  const artifactWriteAdapter = await graphRunArtifactWriteAdapter(runId, store, options);
  const agentAdapter = graphRunAgentAdapter(options);
  const toolAdapter = graphRunToolAdapter(options);
  const toolPolicies = graphRunDefaultToolPolicies(options);
  const toolCapabilities = graphRunDefaultToolCapabilities(options);
  if (!scriptAdapter && !artifactWriteAdapter && !agentAdapter && !toolAdapter) return false;
  if (!scriptAdapter && !agentAdapter && !artifactWriteAdapter && toolAdapter) {
    const queuedEntries = (await store.getQueue(runId)).filter(
      (entry) => entry.status === "queued"
    );
    if (queuedEntries.length === 0 || queuedEntries.some((entry) => entry.nodeKind !== "tool")) {
      return false;
    }
  }
  if (!scriptAdapter && artifactWriteAdapter) {
    const queuedEntries = (await store.getQueue(runId)).filter(
      (entry) => entry.status === "queued"
    );
    if (
      queuedEntries.length === 0 ||
      queuedEntries.some((entry) => entry.nodeKind !== "artifactWrite")
    ) {
      return false;
    }
  }
  await drainPlaybookGraphRun({
    runId,
    runtimeId: options.runtimeId ?? sidecarGraphRunRuntimeId("request"),
    store,
    ...(options.now ? { now: options.now } : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.leaseRenewalMs !== undefined ? { leaseRenewalMs: options.leaseRenewalMs } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.executionContext !== undefined
      ? { executionContext: options.executionContext }
      : {}),
    ...(scriptAdapter ? { scriptAdapter } : {}),
    ...(agentAdapter ? { agentAdapter } : {}),
    ...(toolAdapter ? { toolAdapter } : {}),
    toolPolicies,
    toolCapabilities,
    ...(artifactWriteAdapter ? { artifactWriteAdapter } : {}),
  });
  return true;
}

async function maybeBlockGraphRunForExecutionContextDrift(
  run: PlaybookGraphRunRecord,
  store: GraphRunStore,
  options: GraphRunHandlerOptions
): Promise<boolean> {
  const blockedReason = playbookGraphExecutionContextDriftReason(run, options.executionContext);
  if (!blockedReason) return false;
  await store.updateRun({
    ...run,
    status: "blocked",
    blockedReason,
    updatedAt: graphRunNow(options),
  });
  return true;
}

export async function recoverGraphRunInterruptedWork(
  runId: string,
  options: GraphRunHandlerOptions = {}
): Promise<GraphRunInterruptedRecoveryResult> {
  const store = options.store ?? graphRunStore;
  const recoveredAt = graphRunNow(options);
  const interrupted = await store.markStaleQueueLeasesInterrupted({
    runId,
    runtimeId: options.runtimeId ?? sidecarGraphRunRuntimeId("worker"),
    now: recoveredAt,
    interruptedAt: recoveredAt,
  });
  const run = await store.getRun(runId);
  if (!run) return { interrupted, requeued: 0, blocked: 0 };

  const interruptedEntries = (await store.getQueue(runId)).filter(
    (entry) => entry.status === "interrupted"
  );
  let requeued = 0;
  for (const entry of interruptedEntries) {
    if (entry.recoveryPolicy !== "rerun_if_no_success_memo") continue;
    await store.updateQueueEntry({
      ...entry,
      status: "queued",
      runtimeId: undefined,
      leaseId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      blockedReason: undefined,
      error: undefined,
      completedAt: undefined,
      updatedAt: recoveredAt,
    });
    requeued += 1;
  }

  if (requeued > 0) {
    const firstRequeued = interruptedEntries.find(
      (entry) => entry.recoveryPolicy === "rerun_if_no_success_memo"
    );
    await store.updateRun({
      ...run,
      status: "running",
      currentQueueEntryId: firstRequeued?.queueEntryId ?? run.currentQueueEntryId,
      blockedReason: undefined,
      error: undefined,
      completedAt: undefined,
      updatedAt: recoveredAt,
    });
  } else if (interruptedEntries.length > 0 && run.status !== "interrupted") {
    await store.updateRun({
      ...run,
      status: "interrupted",
      updatedAt: recoveredAt,
    });
  }

  return {
    interrupted,
    requeued,
    blocked: interruptedEntries.length - requeued,
  };
}

export async function drainGraphRunWorkQueue(
  options: GraphRunWorkerOptions = {}
): Promise<GraphRunWorkQueueDrainResult> {
  const store = options.store ?? graphRunStore;
  const runtimeId = options.runtimeId ?? sidecarGraphRunRuntimeId("worker");
  const workerOptions: GraphRunHandlerOptions = {
    ...options,
    runtimeId,
    leaseRenewalMs: options.leaseRenewalMs ?? DEFAULT_GRAPH_RUN_WORKER_LEASE_RENEWAL_MS,
  };
  const result: GraphRunWorkQueueDrainResult = {
    inspected: 0,
    recovered: 0,
    requeued: 0,
    blocked: 0,
    drained: 0,
    skipped: 0,
    errors: [],
  };

  for (const run of await store.listRuns()) {
    if (!GRAPH_RUN_WORKER_ACTIVE_STATUSES.has(run.status)) continue;
    result.inspected += 1;
    try {
      if (await maybeBlockGraphRunForExecutionContextDrift(run, store, workerOptions)) {
        result.blocked += 1;
        result.drained += 1;
        continue;
      }
      const recovery = await recoverGraphRunInterruptedWork(run.runId, workerOptions);
      result.recovered += recovery.interrupted;
      result.requeued += recovery.requeued;
      result.blocked += recovery.blocked;
      if (await maybeDrainGraphRun(run.runId, workerOptions)) {
        result.drained += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.errors.push({
        runId: run.runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export function createGraphRunWorker(options: GraphRunWorkerOptions = {}): GraphRunWorker {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<GraphRunWorkQueueDrainResult> | undefined;
  const runtimeId = options.runtimeId ?? sidecarGraphRunRuntimeId("worker");
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_GRAPH_RUN_WORKER_POLL_INTERVAL_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const reportError = (error: unknown) => {
    warn(
      JSON.stringify({
        type: "tessera.graph_run_worker.tick_failed",
        message: error instanceof Error ? error.message : String(error),
      })
    );
  };
  const tick = async (): Promise<GraphRunWorkQueueDrainResult> => {
    if (inFlight) return inFlight;
    inFlight = drainGraphRunWorkQueue({ ...options, runtimeId }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch(reportError);
      }, pollIntervalMs);
      void tick().catch(reportError);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}

async function buildHumanReviewEvent(input: {
  store: GraphRunStore;
  runId: string;
  queueEntry: PlaybookGraphQueueEntry;
  artifactId: string;
  decision: "approved" | "denied" | "request_changes";
  payload: Record<string, unknown>;
  createdAt: string;
}): Promise<PlaybookGraphReviewEvent> {
  const artifact = (await input.store.listArtifactVersions(input.runId))
    .filter((version) => version.artifactId === input.artifactId)
    .at(-1);
  return {
    schemaVersion: 1,
    reviewEventId: randomUUID(),
    runId: input.runId,
    queueEntryId: input.queueEntry.queueEntryId,
    nodePath: input.queueEntry.nodePath,
    artifactId: input.artifactId,
    ...(artifact ? { artifactVersionId: artifact.versionId } : {}),
    decision: input.decision,
    payload: input.payload,
    createdAt: input.createdAt,
  };
}

async function installedGraphRunSourceFiles(
  compiledGraph: CompiledPlaybookGraph,
  options: GraphRunHandlerOptions
): Promise<Record<string, string> | undefined> {
  const state = options.graphPlaybookRegistryState ?? installedGraphPlaybookRegistryState;
  const cacheRoot = options.cacheRoot ?? GRAPH_PLAYBOOK_CACHE_ROOT;
  const installRoot = options.installRoot ?? GRAPH_PLAYBOOK_INSTALL_ROOT;
  let entry = state.entries.find(
    (candidate) =>
      candidate.id === compiledGraph.metadata.playbookId &&
      candidate.graphHash === compiledGraph.metadata.graphHash
  );

  if (!entry) {
    const refreshed = await refreshInstalledGraphPlaybookRegistry({
      installRoot,
      cacheRoot,
      state,
    });
    entry = refreshed.find(
      (candidate) =>
        candidate.id === compiledGraph.metadata.playbookId &&
        candidate.graphHash === compiledGraph.metadata.graphHash
    );
  }
  if (!entry) return undefined;

  const packageFiles = await readPlaybookGraphPackage(entry.installedRoot);
  const sourceHash = hashPlaybookSourceFiles(packageFiles.sourceFiles);
  if (sourceHash !== compiledGraph.metadata.sourceHash) {
    throw new Error("Installed graph source files do not match compiled graph source hash");
  }
  return packageFiles.sourceFiles;
}

export async function handleGraphRunCreate(
  req: Request,
  options: GraphRunHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PlaybookGraphRunCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const store = options.store ?? graphRunStore;
    const workspaceRoot = parsed.data.workspaceRoot ?? options.workspaceRoot;
    const agentProfile = profileForAgentId(parsed.data.agentId);
    const runtimeOptions = graphRunOptionsWithAgentRuntime(options, {
      agentProfile,
      ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
      ...(parsed.data.credential ? { credential: parsed.data.credential } : {}),
    });
    const provider = graphRunAgentProvider(runtimeOptions);
    const executionContext =
      parsed.data.executionContext ??
      (provider
        ? graphRunAgentExecutionContext({
            agent: agentProfile,
            provider,
            ...(runtimeOptions.credential ? { credential: runtimeOptions.credential } : {}),
          })
        : undefined);
    const compiledGraph =
      parsed.data.compiledGraph ??
      (await createPlaybookGraphCache(options.cacheRoot ?? GRAPH_PLAYBOOK_CACHE_ROOT).get(
        parsed.data.playbookId ?? "",
        parsed.data.graphHash ?? ""
      ));
    if (!compiledGraph) {
      return Response.json({ error: "Unknown compiled graph" }, { status: 404 });
    }
    const sourceFiles =
      parsed.data.sourceFiles ?? (await installedGraphRunSourceFiles(compiledGraph, options));

    const run = await createPlaybookGraphRun({
      compiledGraph,
      ...(sourceFiles ? { sourceFiles } : {}),
      input: parsed.data.input,
      ...(executionContext !== undefined
        ? { executionContext }
        : options.executionContext !== undefined
          ? { executionContext: options.executionContext }
          : {}),
      ...(workspaceRoot
        ? {
            materialization: {
              schemaVersion: 1 as const,
              kind: "workspace" as const,
              workspaceRoot,
            },
          }
        : {}),
      store,
      ...(options.now ? { now: options.now() } : {}),
    });
    if (parsed.data.drainDeterministic) {
      await maybeDrainGraphRun(
        run.runId,
        graphRunOptionsWithExecutionContext(
          graphRunOptionsWithWorkspaceRoot(runtimeOptions, workspaceRoot),
          executionContext ?? options.executionContext
        )
      );
    }

    const detail = await graphRunDetail(run.runId, store);
    if (!detail) return Response.json({ error: "Graph run was not persisted" }, { status: 500 });
    return Response.json(detail);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function handleGraphRunList(
  req: Request,
  options: GraphRunHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const store = options.store ?? graphRunStore;
  const status = searchParams.get("status") ?? undefined;
  const playbookId = searchParams.get("playbookId") ?? undefined;
  const filter = PlaybookGraphRunListFilterSchema.safeParse({
    ...(playbookId ? { playbookId } : {}),
    ...(status ? { status } : {}),
  });
  if (!filter.success) {
    return Response.json({ error: filter.error.message }, { status: 400 });
  }
  const runs = await store.listRuns(filter.data);
  const parsed = PlaybookGraphRunListResultSchema.safeParse({ runs });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  return Response.json(parsed.data);
}

export async function handleGraphRunGet(
  req: Request,
  runId: string,
  options: GraphRunHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const detail = await graphRunDetail(runId, options.store ?? graphRunStore);
  if (!detail) return Response.json({ error: "Unknown graph run" }, { status: 404 });
  return Response.json(detail);
}

export async function handleGraphRunReviewSurface(
  req: Request,
  runId: string,
  options: GraphRunHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const surface = await graphRunReviewSurface(runId, options.store ?? graphRunStore, options);
  if (!surface) return Response.json({ error: "Unknown graph run" }, { status: 404 });
  return Response.json(surface);
}

export async function handleGraphRunGitMilestonePreview(
  req: Request,
  runId: string,
  options: GraphRunHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PlaybookGraphGitMilestonePreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  if (parsed.data.runId !== runId) {
    return Response.json({ error: "Git milestone body runId does not match URL" }, { status: 400 });
  }
  const store = options.store ?? graphRunStore;
  const detail = await graphRunDetail(runId, store);
  if (!detail) return Response.json({ error: "Unknown graph run" }, { status: 404 });
  const workspaceRoot =
    detail.run.materialization?.kind === "workspace"
      ? detail.run.materialization.workspaceRoot
      : options.workspaceRoot;
  if (
    !workspaceRoot ||
    (parsed.data.workspaceRoot && workspaceRoot !== parsed.data.workspaceRoot)
  ) {
    return Response.json(
      { error: "Git milestone workspaceRoot must match the graph run workspace" },
      { status: 409 }
    );
  }
  const service = options.gitMilestoneService ?? createGraphGitMilestoneService();
  const preview = await service.preview({
    runId,
    actionSpecId: parsed.data.actionSpecId,
    workspaceRoot,
    affectedPaths: parsed.data.affectedPaths,
    dirtyPolicy: parsed.data.dirtyPolicy,
    ...(parsed.data.message ? { message: parsed.data.message } : {}),
  });
  return Response.json(preview);
}

export async function handleGraphRunGitMilestoneCommit(
  req: Request,
  runId: string,
  options: GraphRunHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PlaybookGraphGitMilestoneCommitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  if (parsed.data.runId !== runId) {
    return Response.json({ error: "Git milestone body runId does not match URL" }, { status: 400 });
  }
  const store = options.store ?? graphRunStore;
  const detail = await graphRunDetail(runId, store);
  if (!detail) return Response.json({ error: "Unknown graph run" }, { status: 404 });
  const workspaceRoot =
    detail.run.materialization?.kind === "workspace"
      ? detail.run.materialization.workspaceRoot
      : options.workspaceRoot;
  if (!workspaceRoot || workspaceRoot !== parsed.data.workspaceRoot) {
    return Response.json(
      { error: "Git milestone workspaceRoot must match the graph run workspace" },
      { status: 409 }
    );
  }
  const operationAttemptId = randomUUID();
  const startedAt = graphRunNow(options);
  await store.addOperationRecord(
    graphRunOperationRecord({
      runId,
      actionSpecId: parsed.data.actionSpecId,
      kind: "git_milestone",
      status: "started",
      operatorIntent: "Record Git milestone",
      createdAt: startedAt,
      operationAttemptId,
      affectedArtifactIds: [],
      affectedQueueEntryIds: [],
      redactedPayloadSummary: `paths: ${parsed.data.affectedPaths.length}`,
    })
  );
  try {
    const service = options.gitMilestoneService ?? createGraphGitMilestoneService();
    const result = await service.commit(parsed.data);
    const completedAt = graphRunOperationTerminalTime(startedAt, options);
    await store.addOperationRecord(
      graphRunOperationRecord({
        runId,
        actionSpecId: parsed.data.actionSpecId,
        kind: "git_milestone",
        status: "succeeded",
        operatorIntent: "Record Git milestone",
        createdAt: completedAt,
        operationAttemptId,
        affectedArtifactIds: [],
        affectedQueueEntryIds: [],
        gitEvidenceId: result.evidence.commitHash,
        redactedPayloadSummary: `paths: ${result.evidence.affectedPaths.length}`,
      })
    );
    return Response.json(result);
  } catch (error) {
    const failedAt = graphRunOperationTerminalTime(startedAt, options);
    await store.addOperationRecord(
      graphRunOperationRecord({
        runId,
        actionSpecId: parsed.data.actionSpecId,
        kind: "git_milestone",
        status: "failed",
        operatorIntent: "Record Git milestone",
        createdAt: failedAt,
        operationAttemptId,
        affectedArtifactIds: [],
        affectedQueueEntryIds: [],
        redactedPayloadSummary: `paths: ${parsed.data.affectedPaths.length}`,
        failureReason: graphRunOperationFailureReason(error),
      })
    );
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 }
    );
  }
}

function queueSuccessPatch(entry: PlaybookGraphQueueEntry, now: string): PlaybookGraphQueueEntry {
  return {
    ...entry,
    status: "succeeded",
    runtimeId: undefined,
    leaseId: undefined,
    claimedAt: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
    completedAt: now,
  };
}

function graphRunContentHash(value: unknown): string {
  return graphRunHash(value);
}

function requeueGraphQueueEntry(
  entry: PlaybookGraphQueueEntry,
  now: string,
  refresh?: {
    node: PlaybookGraphNode;
    artifactVersions: PlaybookGraphArtifactVersion[];
  }
): PlaybookGraphQueueEntry {
  const refreshed = refresh
    ? createPlaybookGraphQueueEntry({
        runId: entry.runId,
        node: refresh.node,
        nodePath: entry.nodePath,
        dependsOn: entry.dependsOn,
        artifactVersions: refresh.artifactVersions,
        now: entry.createdAt,
      })
    : undefined;
  return {
    ...entry,
    status: "queued",
    runtimeId: undefined,
    leaseId: undefined,
    claimedAt: undefined,
    leaseExpiresAt: undefined,
    blockedReason: undefined,
    error: undefined,
    completedAt: undefined,
    nodeMemoKey: undefined,
    producesArtifacts: refreshed?.producesArtifacts ?? entry.producesArtifacts,
    consumesArtifacts: refreshed?.consumesArtifacts ?? entry.consumesArtifacts,
    recoveryPolicy: refreshed?.recoveryPolicy ?? entry.recoveryPolicy,
    updatedAt: now,
  };
}

function skipGraphQueueEntry(entry: PlaybookGraphQueueEntry, now: string): PlaybookGraphQueueEntry {
  return {
    ...entry,
    status: "skipped",
    runtimeId: undefined,
    leaseId: undefined,
    claimedAt: undefined,
    leaseExpiresAt: undefined,
    blockedReason: undefined,
    error: undefined,
    nodeMemoKey: undefined,
    updatedAt: now,
    completedAt: now,
  };
}

function findGraphRunNode(
  nodes: PlaybookGraphNode[],
  nodeId: string
): PlaybookGraphNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    if (node.kind === "parallelMap") {
      const nested = findGraphRunNode(node.branch.nodes, nodeId);
      if (nested) return nested;
    }
  }
  return undefined;
}

function graphRunBranchItemForNodePath(
  nodePath: string,
  branchItems: PlaybookGraphBranchItem[]
): PlaybookGraphBranchItem | undefined {
  return branchItems
    .filter((item) => nodePath === item.nodePath || nodePath.startsWith(`${item.nodePath}/`))
    .sort((left, right) => right.nodePath.length - left.nodePath.length)[0];
}

async function graphRunQueueInvalidation(input: {
  store: GraphRunStore;
  runId: string;
  now: string;
  rootQueueEntryId?: string;
  artifactVersion?: PlaybookGraphArtifactVersion;
}): Promise<{
  count: number;
  queueEntries: PlaybookGraphQueueEntry[];
  branchItems: PlaybookGraphBranchItem[];
}> {
  const queue = await input.store.getQueue(input.runId);
  const branchItems = await input.store.listBranchItems(input.runId);
  const run = await input.store.getRun(input.runId);
  const artifactVersions = await input.store.listArtifactVersions(input.runId);
  const invalidationArtifactVersions = input.artifactVersion
    ? [...artifactVersions, input.artifactVersion]
    : artifactVersions;
  let nodes: PlaybookGraphNode[] | undefined;
  if (run) {
    try {
      nodes = parsePinnedCompiledGraph(run.snapshot).graph.nodes;
    } catch {
      nodes = undefined;
    }
  }
  const affected = new Set<string>();
  if (input.rootQueueEntryId) affected.add(input.rootQueueEntryId);
  if (input.artifactVersion) {
    for (const entry of queue) {
      if (
        entry.consumesArtifacts.some((ref) => ref.artifactId === input.artifactVersion?.artifactId)
      ) {
        affected.add(entry.queueEntryId);
      }
    }
  }
  if (!input.rootQueueEntryId && !input.artifactVersion) {
    for (const entry of queue) affected.add(entry.queueEntryId);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of queue) {
      if (affected.has(entry.queueEntryId)) continue;
      if (entry.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(entry.queueEntryId);
        changed = true;
      }
    }
  }

  const invalidatedParallelMapEntries = queue.filter(
    (entry) => affected.has(entry.queueEntryId) && entry.nodeKind === "parallelMap"
  );
  const invalidatedParallelMapIds = new Set(
    invalidatedParallelMapEntries.map((entry) => entry.queueEntryId)
  );
  const staleBranchQueueIds = new Set<string>();
  for (const parent of invalidatedParallelMapEntries) {
    const prefix = `${parent.nodePath}/item:`;
    for (const entry of queue) {
      if (entry.nodePath.startsWith(prefix)) {
        staleBranchQueueIds.add(entry.queueEntryId);
      }
    }
  }
  const nextBranchItems: PlaybookGraphBranchItem[] = [];
  for (const item of branchItems) {
    if (!invalidatedParallelMapIds.has(item.parentQueueEntryId)) continue;
    nextBranchItems.push({
      ...item,
      status: "skipped",
      updatedAt: input.now,
    });
  }

  let count = 0;
  const nextQueueEntries: PlaybookGraphQueueEntry[] = [];
  for (const entry of queue) {
    if (!affected.has(entry.queueEntryId)) continue;
    if (staleBranchQueueIds.has(entry.queueEntryId)) {
      nextQueueEntries.push(skipGraphQueueEntry(entry, input.now));
      count += 1;
      continue;
    }
    const node = nodes ? findGraphRunNode(nodes, entry.nodeId) : undefined;
    nextQueueEntries.push(
      requeueGraphQueueEntry(
        entry,
        input.now,
        node ? { node, artifactVersions: invalidationArtifactVersions } : undefined
      )
    );
    count += 1;
  }
  return { count, queueEntries: nextQueueEntries, branchItems: nextBranchItems };
}

function graphRunHasValidSnapshot(run: PlaybookGraphRunRecord): boolean {
  try {
    parsePinnedCompiledGraph(run.snapshot);
    return true;
  } catch {
    return false;
  }
}

function graphRunRepairSourceFiles(
  payload: Record<string, unknown>
): Record<string, string> | undefined {
  const sourceFiles = payload.sourceFiles;
  if (!sourceFiles || typeof sourceFiles !== "object" || Array.isArray(sourceFiles)) {
    return undefined;
  }
  const entries = Object.entries(sourceFiles);
  if (!entries.every(([, value]) => typeof value === "string")) {
    throw new Error("repair sourceFiles must be a record of strings");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export async function handleGraphRunResume(
  req: Request,
  runId: string,
  options: GraphRunHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PlaybookGraphResumeDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  if (parsed.data.runId !== runId) {
    return Response.json({ error: "Resume body runId does not match URL" }, { status: 400 });
  }

  try {
    const store = options.store ?? graphRunStore;
    const run = await store.getRun(runId);
    if (!run) return Response.json({ error: "Unknown graph run" }, { status: 404 });
    const now = options.now ? options.now() : new Date().toISOString();
    const runtimeOptions = graphRunOptionsWithAgentRuntime(options, {
      agentProfile: options.agentProfile ?? defaultAgentProfile(),
      ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
      ...(parsed.data.credential ? { credential: parsed.data.credential } : {}),
    });
    const runtimeProvider = graphRunAgentProvider(runtimeOptions);
    const executionContext =
      parsed.data.executionContext ??
      (runtimeProvider
        ? graphRunAgentExecutionContext({
            agent: runtimeOptions.agentProfile ?? defaultAgentProfile(),
            provider: runtimeProvider,
            ...(runtimeOptions.credential ? { credential: runtimeOptions.credential } : {}),
          })
        : options.executionContext);

    const mutation: {
      run?: PlaybookGraphRunRecord;
      queueEntries: PlaybookGraphQueueEntry[];
      branchItems: PlaybookGraphBranchItem[];
      artifactVersions: PlaybookGraphArtifactVersion[];
      reviewEvents: PlaybookGraphReviewEvent[];
    } = {
      queueEntries: [],
      branchItems: [],
      artifactVersions: [],
      reviewEvents: [],
    };
    const affectedArtifactIds = new Set<string>();
    const affectedReviewEventIds = new Set<string>();
    const affectedQueueEntryIds = new Set<string>();
    let shouldDrain = false;
    let drainOptions = graphRunOptionsWithExecutionContext(runtimeOptions, executionContext);

    const addReviewEvent = async (
      input: Omit<Parameters<typeof buildHumanReviewEvent>[0], "store" | "runId" | "createdAt">
    ) => {
      const event = await buildHumanReviewEvent({ store, runId, createdAt: now, ...input });
      mutation.reviewEvents.push(event);
      affectedReviewEventIds.add(event.reviewEventId);
      affectedQueueEntryIds.add(event.queueEntryId);
      affectedArtifactIds.add(event.artifactId);
    };

    if (parsed.data.decision === "deny") {
      const queue = await store.getQueue(runId);
      const active = parsed.data.queueEntryId
        ? queue.find((entry) => entry.queueEntryId === parsed.data.queueEntryId)
        : queue.find((entry) => entry.status === "blocked" || entry.status === "interrupted");
      const compiled = parsePinnedCompiledGraph(run.snapshot);
      const node = active ? findGraphRunNode(compiled.graph.nodes, active.nodeId) : undefined;
      if (active) {
        if (node?.kind === "humanReview") {
          await addReviewEvent({
            queueEntry: active,
            artifactId: node.artifact,
            decision: "denied",
            payload: parsed.data.payload,
          });
        }
        mutation.queueEntries.push({
          ...active,
          status: "failed",
          runtimeId: undefined,
          leaseId: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
          completedAt: now,
          error: "Graph run denied by user",
        });
        affectedQueueEntryIds.add(active.queueEntryId);
      }
      mutation.run = {
        ...run,
        status: "denied",
        currentQueueEntryId: active?.queueEntryId ?? run.currentQueueEntryId,
        updatedAt: now,
        completedAt: now,
      };
    } else if (parsed.data.decision === "approve_context_change") {
      if (executionContext === undefined) {
        return Response.json(
          { error: "Execution context is required to approve a graph context change" },
          { status: 409 }
        );
      }
      if (run.status !== "blocked" || !run.blockedReason?.includes("execution context changed")) {
        return Response.json(
          { error: "Graph run is not blocked on an execution context change" },
          { status: 409 }
        );
      }
      mutation.run = {
        ...run,
        status: "running",
        executionContext: createPlaybookGraphExecutionContextPin(executionContext),
        blockedReason: undefined,
        repairReason: undefined,
        error: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
      shouldDrain = true;
    } else if (
      parsed.data.decision === "approve_repair" ||
      parsed.data.decision === "retry_repair"
    ) {
      if (run.status !== "needs_repair") {
        return Response.json({ error: "Graph run is not waiting for repair" }, { status: 409 });
      }
      const snapshotValid = graphRunHasValidSnapshot(run);
      const repairCompiledGraph = parsed.data.payload.compiledGraph;
      let repairedSnapshot = run.snapshot;
      let repairedPlaybookId = run.playbookId;
      if (!snapshotValid || repairCompiledGraph !== undefined) {
        const compiled = CompiledPlaybookGraphSchema.safeParse(repairCompiledGraph);
        if (!compiled.success) {
          return Response.json(
            {
              error:
                "approve_repair requires payload.compiledGraph when the pinned snapshot is invalid",
            },
            { status: 409 }
          );
        }
        if (compiled.data.metadata.playbookId !== run.playbookId) {
          return Response.json(
            { error: "repair compiledGraph must match the existing run playbookId" },
            { status: 409 }
          );
        }
        if (compiled.data.metadata.graphHash !== run.snapshot.graphHash) {
          return Response.json(
            { error: "repair compiledGraph must match the existing run graphHash" },
            { status: 409 }
          );
        }
        const sourceFiles = graphRunRepairSourceFiles(parsed.data.payload);
        repairedSnapshot = createPlaybookGraphSnapshot({
          compiledGraph: compiled.data,
          ...(sourceFiles ? { sourceFiles } : {}),
        });
        repairedPlaybookId = compiled.data.metadata.playbookId;
      }
      mutation.run = {
        ...run,
        playbookId: repairedPlaybookId,
        snapshot: repairedSnapshot,
        status: "running",
        repairReason: undefined,
        blockedReason: undefined,
        error: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
      shouldDrain = true;
    } else if (parsed.data.decision === "edit_input") {
      const nextInput = parsed.data.payload.input;
      if (!nextInput || typeof nextInput !== "object" || Array.isArray(nextInput)) {
        return Response.json(
          { error: "edit_input requires payload.input object" },
          { status: 400 }
        );
      }
      const invalidated = await graphRunQueueInvalidation({ store, runId, now });
      mutation.queueEntries.push(...invalidated.queueEntries);
      mutation.branchItems.push(...invalidated.branchItems);
      for (const entry of invalidated.queueEntries) affectedQueueEntryIds.add(entry.queueEntryId);
      for (const item of invalidated.branchItems)
        affectedQueueEntryIds.add(item.parentQueueEntryId);
      mutation.run = {
        ...run,
        status: "running",
        input: { ...run.input, ...(nextInput as Record<string, unknown>) },
        blockedReason: undefined,
        repairReason: undefined,
        error: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
      shouldDrain = invalidated.count > 0;
    } else if (parsed.data.decision === "edit_artifact") {
      const artifactId = parsed.data.payload.artifactId;
      if (typeof artifactId !== "string" || !artifactId.trim()) {
        return Response.json(
          { error: "edit_artifact requires payload.artifactId" },
          { status: 400 }
        );
      }
      const value = parsed.data.payload.value;
      const producerQueueEntryId =
        typeof parsed.data.queueEntryId === "string"
          ? parsed.data.queueEntryId
          : `${runId}:artifact-edit:${artifactId}:${randomUUID()}`;
      const version: PlaybookGraphArtifactVersion = {
        schemaVersion: 1,
        runId,
        artifactId,
        versionId: `${producerQueueEntryId}:${artifactId}:edit:${randomUUID()}`,
        producerQueueEntryId,
        nodePath:
          typeof parsed.data.queueEntryId === "string"
            ? ((await store.getQueue(runId)).find(
                (entry) => entry.queueEntryId === parsed.data.queueEntryId
              )?.nodePath ?? `edit:${artifactId}`)
            : `edit:${artifactId}`,
        contentHash: graphRunContentHash(value),
        value,
        createdAt: now,
      };
      const invalidated = await graphRunQueueInvalidation({
        store,
        runId,
        now,
        artifactVersion: version,
      });
      mutation.artifactVersions.push(version);
      mutation.queueEntries.push(...invalidated.queueEntries);
      mutation.branchItems.push(...invalidated.branchItems);
      affectedArtifactIds.add(artifactId);
      for (const entry of invalidated.queueEntries) affectedQueueEntryIds.add(entry.queueEntryId);
      for (const item of invalidated.branchItems)
        affectedQueueEntryIds.add(item.parentQueueEntryId);
      mutation.run = {
        ...run,
        status: "running",
        blockedReason: undefined,
        repairReason: undefined,
        error: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
      shouldDrain = true;
    } else if (parsed.data.decision === "edit_review") {
      const queue = await store.getQueue(runId);
      const target =
        (parsed.data.queueEntryId
          ? queue.find((entry) => entry.queueEntryId === parsed.data.queueEntryId)
          : undefined) ?? queue.find((entry) => entry.status === "blocked");
      if (!target) {
        return Response.json({ error: "No queue entry to attach review edit" }, { status: 409 });
      }
      const reviewEvent: PlaybookGraphReviewEvent = {
        schemaVersion: 1,
        reviewEventId: randomUUID(),
        runId,
        queueEntryId: target.queueEntryId,
        nodePath: target.nodePath,
        artifactId:
          typeof parsed.data.payload.artifactId === "string"
            ? parsed.data.payload.artifactId
            : "review",
        decision: "edited",
        payload: parsed.data.payload,
        createdAt: now,
      };
      const invalidated = await graphRunQueueInvalidation({
        store,
        runId,
        now,
        rootQueueEntryId: target.queueEntryId,
      });
      mutation.reviewEvents.push(reviewEvent);
      mutation.queueEntries.push(...invalidated.queueEntries);
      mutation.branchItems.push(...invalidated.branchItems);
      affectedReviewEventIds.add(reviewEvent.reviewEventId);
      affectedQueueEntryIds.add(target.queueEntryId);
      affectedArtifactIds.add(reviewEvent.artifactId);
      for (const entry of invalidated.queueEntries) affectedQueueEntryIds.add(entry.queueEntryId);
      for (const item of invalidated.branchItems)
        affectedQueueEntryIds.add(item.parentQueueEntryId);
      mutation.run = {
        ...run,
        status: "running",
        blockedReason: undefined,
        repairReason: undefined,
        error: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
      shouldDrain = true;
    } else if (parsed.data.decision === "retry_interrupted") {
      const queue = await store.getQueue(runId);
      const interrupted = queue.find(
        (entry) =>
          entry.status === "interrupted" &&
          (!parsed.data.queueEntryId || entry.queueEntryId === parsed.data.queueEntryId)
      );
      if (!interrupted) {
        return Response.json({ error: "No interrupted queue entry to retry" }, { status: 409 });
      }
      mutation.queueEntries.push({
        ...interrupted,
        status: "queued",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
        blockedReason: undefined,
        error: undefined,
        completedAt: undefined,
      });
      affectedQueueEntryIds.add(interrupted.queueEntryId);
      mutation.run = { ...run, status: "running", updatedAt: now };
      drainOptions = graphRunOptionsWithExecutionContext(
        graphRunOptionsWithWorkspaceRoot(
          runtimeOptions,
          graphRunPayloadWorkspaceRoot(parsed.data.payload)
        ),
        executionContext
      );
      shouldDrain = true;
    } else if (parsed.data.decision === "approve" || parsed.data.decision === "request_changes") {
      const queue = await store.getQueue(runId);
      const blocked = queue.find(
        (entry) =>
          entry.status === "blocked" &&
          (!parsed.data.queueEntryId || entry.queueEntryId === parsed.data.queueEntryId)
      );
      if (!blocked) {
        return Response.json({ error: "No blocked queue entry to approve" }, { status: 409 });
      }
      const compiled = parsePinnedCompiledGraph(run.snapshot);
      const node = findGraphRunNode(compiled.graph.nodes, blocked.nodeId);
      if (!node) {
        mutation.run = {
          ...run,
          status: "needs_repair",
          repairReason: `Unknown blocked graph node: ${blocked.nodeId}`,
          updatedAt: now,
        };
      } else if (node.kind !== "humanReview") {
        return Response.json(
          { error: `${node.kind} queue entries cannot be approved through human review resume` },
          { status: 409 }
        );
      } else if (parsed.data.decision === "request_changes" && !node.onRequestChanges) {
        return Response.json(
          { error: "Blocked human review has no request-changes transition" },
          { status: 409 }
        );
      } else {
        await addReviewEvent({
          queueEntry: blocked,
          artifactId: node.artifact,
          decision: parsed.data.decision === "approve" ? "approved" : "request_changes",
          payload: parsed.data.payload,
        });
      }
      if (node?.kind === "humanReview") {
        const target =
          parsed.data.decision === "approve"
            ? (node.onApprove ?? node.onSuccess ?? "completed")
            : node.onRequestChanges;
        if (!target) {
          return Response.json(
            { error: "Blocked human review has no resume target" },
            { status: 409 }
          );
        }
        const completedQueue = queueSuccessPatch(blocked, now);
        mutation.queueEntries.push(completedQueue);
        affectedQueueEntryIds.add(completedQueue.queueEntryId);
        if (target === "completed") {
          const branchItem = graphRunBranchItemForNodePath(
            completedQueue.nodePath,
            await store.listBranchItems(runId)
          );
          if (branchItem) {
            mutation.branchItems.push({
              ...branchItem,
              status: "completed",
              updatedAt: now,
            });
            mutation.run = {
              ...run,
              status: "running",
              currentQueueEntryId: undefined,
              blockedReason: undefined,
              repairReason: undefined,
              error: undefined,
              completedAt: undefined,
              updatedAt: now,
            };
            shouldDrain = true;
          } else {
            mutation.run = {
              ...run,
              status: "completed",
              currentQueueEntryId: undefined,
              blockedReason: undefined,
              updatedAt: now,
              completedAt: now,
            };
          }
        } else if (target === "failed" || target === "denied") {
          mutation.run = {
            ...run,
            status: target,
            currentQueueEntryId: undefined,
            blockedReason: undefined,
            updatedAt: now,
            completedAt: now,
          };
        } else {
          const next = findGraphRunNode(compiled.graph.nodes, target);
          if (!next) {
            mutation.run = {
              ...run,
              status: "needs_repair",
              repairReason: `Unknown graph resume target: ${target}`,
              updatedAt: now,
            };
          } else {
            const artifactVersions = await store.listArtifactVersions(run.runId);
            const nextQueueEntry = createPlaybookGraphQueueEntry({
              runId: run.runId,
              node: next,
              nodePath: childPlaybookGraphNodePath(completedQueue.nodePath, next.id),
              dependsOn: [completedQueue.queueEntryId],
              artifactVersions,
              now,
            });
            mutation.queueEntries.push(nextQueueEntry);
            affectedQueueEntryIds.add(nextQueueEntry.queueEntryId);
            mutation.run = {
              ...run,
              status: "running",
              currentQueueEntryId: nextQueueEntry.queueEntryId,
              blockedReason: undefined,
              updatedAt: now,
            };
            drainOptions = graphRunOptionsWithExecutionContext(
              graphRunOptionsWithWorkspaceRoot(
                runtimeOptions,
                graphRunPayloadWorkspaceRoot(parsed.data.payload)
              ),
              executionContext
            );
            shouldDrain = true;
          }
        }
      }
    } else {
      return Response.json({ error: "Unsupported graph resume decision" }, { status: 400 });
    }

    const redactedPayloadSummary = graphRunPayloadSummary(parsed.data.payload);
    await store.applyGraphMutationWithOperationRecord({
      ...(mutation.run ? { run: mutation.run } : {}),
      queueEntries: mutation.queueEntries,
      branchItems: mutation.branchItems,
      artifactVersions: mutation.artifactVersions,
      reviewEvents: mutation.reviewEvents,
      operationRecord: graphRunOperationRecord({
        runId,
        actionSpecId: `${parsed.data.queueEntryId ?? runId}:${parsed.data.decision}`,
        kind: graphRunOperationKind(parsed.data.decision),
        status: "succeeded",
        operatorIntent: parsed.data.decision.replaceAll("_", " "),
        createdAt: now,
        affectedArtifactIds: Array.from(affectedArtifactIds).sort(),
        affectedReviewEventIds: Array.from(affectedReviewEventIds).sort(),
        affectedQueueEntryIds: Array.from(affectedQueueEntryIds).sort(),
        ...(parsed.data.queueEntryId ? { queueEntryId: parsed.data.queueEntryId } : {}),
        ...(redactedPayloadSummary ? { redactedPayloadSummary } : {}),
      }),
    });

    if (shouldDrain) {
      await maybeDrainGraphRun(runId, drainOptions);
    }

    const detail = await graphRunDetail(runId, store);
    if (!detail) return Response.json({ error: "Unknown graph run" }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
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
    const withMemoryShadow = await attachPlaybookMemoryShadow(merged);
    const saved = await saveWorkflowRunWithDashboardLayout(withMemoryShadow, entry);
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

export async function handlePlaybookList(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const builtIns = await builtInGraphPlaybooks();
  return Response.json(
    PlaybookListResultSchema.parse({
      playbooks: builtIns.map((entry) => graphPlaybookSummary(entry)),
    })
  );
}

export async function handlePlaybookGet(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const entry = await builtInGraphPlaybook(playbookId);
  if (!entry) return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  return Response.json(graphPlaybookDetail(entry));
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

export async function handlePlaybookRunCreate(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const entry = await builtInGraphPlaybook(playbookId);
  if (!entry) return Response.json({ error: "Unknown playbook id" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const request =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const input =
    request.input && typeof request.input === "object" && !Array.isArray(request.input)
      ? (request.input as Record<string, unknown>)
      : {};
  const graphRunBody = {
    input,
    compiledGraph: entry.compiled,
    sourceFiles: entry.sourceFiles,
    drainDeterministic:
      typeof request.drainDeterministic === "boolean" ? request.drainDeterministic : true,
    ...(typeof request.workspaceRoot === "string" ? { workspaceRoot: request.workspaceRoot } : {}),
    ...(typeof request.agentId === "string" ? { agentId: request.agentId } : {}),
    ...(request.agentProvider ? { agentProvider: request.agentProvider } : {}),
    ...(request.credential ? { credential: request.credential } : {}),
  };

  return handleGraphRunCreate(
    new Request(req.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(graphRunBody),
    })
  );
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

export async function handlePlaybookRunList(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const playbookId = searchParams.get("playbookId") ?? undefined;
  if (playbookId && !(await builtInGraphPlaybook(playbookId))) {
    return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  }

  const graphRunUrl = new URL(req.url);
  graphRunUrl.pathname = "/graph-runs";
  return handleGraphRunList(new Request(graphRunUrl.toString(), { method: "GET" }));
}

export async function handlePlaybookRunGet(req: Request, runId: string): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  return handleGraphRunGet(req, runId);
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
      const withMemoryShadow = await attachPlaybookMemoryShadow(result);
      const saved = await saveWorkflowRunWithDashboardLayout(withMemoryShadow, entry);
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
    const withMemoryShadow = await attachPlaybookMemoryShadow(merged);
    const saved = await saveWorkflowRunWithDashboardLayout(withMemoryShadow, entry);
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
        capabilityManager: optionalCapabilityManager,
        cli: { runWorkspaceCli },
        memory: memoryManager,
        ...(execution ? { execution } : {}),
        promptOverride: invocation.prompt,
        pythonSkillRoot: join(TESSERA_DATA_DIR, "python-skills"),
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
        capabilityManager: optionalCapabilityManager,
        cli: { runWorkspaceCli },
        memory: memoryManager,
        ...(execution ? { execution } : {}),
        promptOverride: invocation.prompt,
        pythonSkillRoot: join(TESSERA_DATA_DIR, "python-skills"),
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

export function handleMemoryReviewList(
  req: Request,
  store: MemoryStore | undefined = memoryStore
): Response {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  if (!store) {
    return Response.json({ active: [], candidates: [] });
  }

  const url = new URL(req.url);
  const workspaceKey = url.searchParams.get("workspaceKey") ?? undefined;
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 24;
  const result = MemoryReviewListResultSchema.parse({
    active: store.listActiveMemories({
      ...(workspaceKey ? { workspaceKey } : {}),
      ownerId: LOCAL_MEMORY_OWNER_ID,
      limit,
    }),
    candidates: store.listCandidateMemories({
      ...(workspaceKey ? { workspaceKey } : {}),
      ownerId: LOCAL_MEMORY_OWNER_ID,
      limit,
    }),
  });
  return Response.json(result);
}

export async function handleMemoryReviewDecision(
  req: Request,
  store: MemoryStore | undefined = memoryStore
): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!store) {
    return Response.json({ error: "Memory store is unavailable" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = MemoryReviewDecisionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const memory = store.getMemoryById(parsed.data.memoryId);
  if (!memory) {
    return Response.json({ error: "Unknown memory" }, { status: 404 });
  }
  if (parsed.data.decision === "accept" && memory.status !== "candidate") {
    return Response.json({ error: "Only candidate memories can be accepted" }, { status: 400 });
  }

  const nextStatus =
    parsed.data.decision === "accept"
      ? "active"
      : parsed.data.decision === "reject"
        ? "rejected"
        : "archived";
  const updated = store.upsertMemory({
    ...memory,
    status: nextStatus,
    updatedAt: parsed.data.decidedAt,
  });
  return Response.json(updated);
}

export async function handleMemoryForget(
  req: Request,
  store: MemoryStore | undefined = memoryStore
): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!store) {
    return Response.json({ error: "Memory store is unavailable" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = MemoryForgetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  store.forgetMemory(parsed.data);
  return Response.json({ ok: true });
}

graphRunBackgroundWorkerRef.current =
  process.env.TESSERA_GRAPH_RUN_WORKER === "1"
    ? createGraphRunWorker({ store: graphRunStore })
    : undefined;
graphRunBackgroundWorkerRef.current?.start();

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

    if (pathname === "/memory/review") {
      return handleMemoryReviewList(req);
    }

    if (pathname === "/memory/review/decision") {
      return handleMemoryReviewDecision(req);
    }

    if (pathname === "/memory/forget") {
      return handleMemoryForget(req);
    }

    if (pathname === "/spawn") {
      return handleSpawn(req);
    }

    const capabilityBinaryInstallMatch = pathname.match(
      /^\/capabilities\/([^/]+)\/binaries\/([^/]+)\/install$/
    );
    if (capabilityBinaryInstallMatch) {
      return handleCapabilityBinaryInstall(
        req,
        decodeURIComponent(capabilityBinaryInstallMatch[1] ?? ""),
        decodeURIComponent(capabilityBinaryInstallMatch[2] ?? "")
      );
    }

    const capabilityBinaryMatch = pathname.match(/^\/capabilities\/([^/]+)\/binaries\/([^/]+)$/);
    if (capabilityBinaryMatch) {
      return handleCapabilityBinary(
        req,
        decodeURIComponent(capabilityBinaryMatch[1] ?? ""),
        decodeURIComponent(capabilityBinaryMatch[2] ?? "")
      );
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

    if (pathname === "/graph-playbooks/install") {
      return handleGraphPlaybookInstall(req);
    }

    if (pathname === "/graph-runs") {
      if (req.method === "GET") return handleGraphRunList(req);
      return handleGraphRunCreate(req);
    }

    const graphRunResumeMatch = pathname.match(/^\/graph-runs\/([^/]+)\/resume$/);
    const graphRunResumeId = graphRunResumeMatch?.[1];
    if (graphRunResumeId) {
      return handleGraphRunResume(req, decodeURIComponent(graphRunResumeId));
    }

    const graphRunGitMilestonePreviewMatch = pathname.match(
      /^\/graph-runs\/([^/]+)\/git-milestone\/preview$/
    );
    const graphRunGitMilestonePreviewId = graphRunGitMilestonePreviewMatch?.[1];
    if (graphRunGitMilestonePreviewId) {
      return handleGraphRunGitMilestonePreview(
        req,
        decodeURIComponent(graphRunGitMilestonePreviewId)
      );
    }

    const graphRunGitMilestoneCommitMatch = pathname.match(
      /^\/graph-runs\/([^/]+)\/git-milestone$/
    );
    const graphRunGitMilestoneCommitId = graphRunGitMilestoneCommitMatch?.[1];
    if (graphRunGitMilestoneCommitId) {
      return handleGraphRunGitMilestoneCommit(
        req,
        decodeURIComponent(graphRunGitMilestoneCommitId)
      );
    }

    const graphRunReviewSurfaceMatch = pathname.match(/^\/graph-runs\/([^/]+)\/review-surface$/);
    const graphRunReviewSurfaceId = graphRunReviewSurfaceMatch?.[1];
    if (graphRunReviewSurfaceId) {
      return handleGraphRunReviewSurface(req, decodeURIComponent(graphRunReviewSurfaceId));
    }

    const graphRunMatch = pathname.match(/^\/graph-runs\/([^/]+)$/);
    const graphRunId = graphRunMatch?.[1];
    if (graphRunId) {
      return handleGraphRunGet(req, decodeURIComponent(graphRunId));
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
