import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
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
  DashboardLayoutSchema,
  GraphPlaybookImportResultSchema,
  InboxCancelRequestSchema,
  InboxCreateRequestSchema,
  InboxListResultSchema,
  InboxMessageTypeSchema,
  InboxResolveRequestSchema,
  InboxSnoozeRequestSchema,
  InboxStatusSchema,
  MemoryForgetRequestSchema,
  MemoryReviewDecisionRequestSchema,
  MemoryReviewListResultSchema,
  type ModelRuntimeCredential,
  NotifyRequestSchema,
  PlaybookDetailSchema,
  type PlaybookGraphArtifactVersion,
  type PlaybookGraphBranchItem,
  PlaybookGraphGitMilestoneCommitRequestSchema,
  PlaybookGraphGitMilestonePreviewRequestSchema,
  type PlaybookGraphNode,
  type PlaybookGraphOperationKind,
  type PlaybookGraphOperationRecord,
  type PlaybookGraphPlatformContext,
  type PlaybookGraphQueueEntry,
  type PlaybookGraphResumeActionSpec,
  PlaybookGraphResumeActionSpecSchema,
  PlaybookGraphResumeDecisionSchema,
  type PlaybookGraphReviewEvent,
  PlaybookGraphRunCreateRequestSchema,
  PlaybookGraphRunDetailSchema,
  PlaybookGraphRunDrainRequestSchema,
  PlaybookGraphRunListFilterSchema,
  PlaybookGraphRunListResultSchema,
  type PlaybookGraphRunRecord,
  PlaybookGraphRunReviewSurfaceSchema,
  PlaybookGraphWritingStyleMetadataSchema,
  PlaybookListResultSchema,
  PlaybookRunPreferenceReadRequestSchema,
  PlaybookRunPreferenceReadResultSchema,
  PlaybookRunPreferenceSaveRequestSchema,
  PlaybookRunPreferenceSchema,
  type PlaybookRunProductAction,
  type PlaybookRunProductView,
  type PlaybookSummary,
  PlaybookSummarySchema,
  type ShellToolCall,
  ShellToolCallSchema,
  SidecarReadySchema,
  SpawnRequestSchema,
  type SpawnResult,
  StyleComplianceSummarySchema,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskListResultSchema,
  type TaskSkillActivation,
  TaskUpdateRequestSchema,
  TodoOperationSchema,
  type WorkflowCapability,
  WorkflowCapabilitySchema,
  type WorkflowOutputDeclaration,
  WorkflowOutputDeclarationSchema,
  type WorkflowRunAssignmentPlan,
  WorkspaceConfigSchema,
  WorkspaceStyleGuideReadRequestSchema,
  WorkspaceStyleGuideSaveRequestSchema,
  compileAgentRuntimeContext,
} from "@tessera/contracts";
import {
  AgentProfileCreateRequestSchema,
  AgentProfileUpdateRequestSchema,
} from "@tessera/contracts";
import {
  CORE_VERSION,
  DEFAULT_AGENT_PROFILE,
  type GraphRunStore,
  type OptionalCapabilityInstallProgress,
  type OptionalCapabilityManager,
  type PlaybookGraphAgentAdapterInput,
  type PlaybookGraphArtifactWriteAdapterInput,
  type PlaybookGraphScriptAdapterInput,
  type PlaybookGraphToolAdapterInput,
  type PlaybookGraphToolExecutionPolicy,
  WorkspaceConfigConflictError,
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
  hardTimeoutMs,
  hashPlaybookSourceFiles,
  installGraphPlaybookPackage,
  loadBuiltInGraphPlaybookPackages,
  optionalCapabilityDefinitionsFromEnv,
  parsePinnedCompiledGraph,
  playbookGraphExecutionContextDriftReason,
  readPlaybookGraphPackage,
  readWorkspaceConfig,
  resolveSlashSkillInvocation,
  saveWorkspaceConfig,
  softTimeoutMs,
  stableJsonStringify,
} from "@tessera/core";
import { createAgentProfileStore } from "./agent-profile-store.js";
import {
  createPlaywrightBrowserExecutor,
  resolveBrowserRuntimeConfigFromEnv,
} from "./browser-runtime.js";
import { mergeDefaultAgentProfile } from "./default-agent-profile.js";
import { importGraphPlaybookArchive } from "./graph-playbook-importer.js";
import {
  type GraphPlaybookRegistryEntry,
  loadInstalledGraphPlaybookCatalog,
  loadInstalledGraphPlaybookRegistry,
} from "./graph-playbook-registry.js";
import { createInboxStore } from "./inbox-store.js";
import {
  type TesseraMemoryManager,
  createMemoryManager,
  createNoopMemoryManager,
} from "./memory-manager.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import { createPlaybookGraphRunStore } from "./playbook-graph-run-store.js";
import { runPlaybookGraphScript } from "./playbook-graph-script-runner.js";
import {
  type PlaybookRunPreferenceStore,
  createPlaybookRunPreferenceStore,
} from "./playbook-run-preference-store.js";
import { createTesseraSkillRegistry } from "./skill-registry.js";
import { createTaskEventBus } from "./task-event-bus.js";
import { runTaskTurn } from "./task-runner.js";
import { createTaskStore } from "./task-store.js";
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
const LOCAL_GRAPH_RUN_OWNER_KEY = LOCAL_MEMORY_OWNER_ID;
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
const graphRunStore = createPlaybookGraphRunStore(WORKFLOW_DB_PATH);
const taskStore = createTaskStore(TASK_DB_PATH);
const agentProfileStore = createAgentProfileStore(TASK_DB_PATH);
const agentProfileStoresByUserKey = new Map<string, ReturnType<typeof createAgentProfileStore>>();
const inboxStore = createInboxStore(TASK_DB_PATH);
const playbookRunPreferenceStore = createPlaybookRunPreferenceStore(TASK_DB_PATH);
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

interface GraphPlaybookRegistryState {
  entries: GraphPlaybookRegistryEntry[];
  loaded?: boolean;
}

const installedGraphPlaybookRegistryState: GraphPlaybookRegistryState = { entries: [] };
const installedGraphPlaybookCatalogState: GraphPlaybookRegistryState = { entries: [] };
const installedGraphPlaybookRegistryStatesByUserKey = new Map<
  string,
  { state: GraphPlaybookRegistryState; catalogState: GraphPlaybookRegistryState }
>();

export interface BuiltInGraphPlaybookRegistryEntry {
  kind: "built-in";
  id: string;
  packageVersion: string;
  name: string;
  graphHash: string;
  sourceHash: string;
  installedRoot: string;
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
    catalogState?: GraphPlaybookRegistryState;
  } = {}
): Promise<GraphPlaybookRegistryEntry[]> {
  const state = options.state ?? installedGraphPlaybookRegistryState;
  const catalogState = options.catalogState ?? installedGraphPlaybookCatalogState;
  const installRoot = options.installRoot ?? GRAPH_PLAYBOOK_INSTALL_ROOT;
  const cacheRoot = options.cacheRoot ?? GRAPH_PLAYBOOK_CACHE_ROOT;
  const entries = await loadInstalledGraphPlaybookRegistry({
    installRoot,
    cacheRoot,
  });
  const catalogEntries = await loadInstalledGraphPlaybookCatalog({ installRoot, cacheRoot });
  state.entries = entries;
  state.loaded = true;
  catalogState.entries = catalogEntries;
  catalogState.loaded = true;
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
  const entries = loaded.map((entry) => ({
    kind: "built-in" as const,
    id: entry.compiled.graph.id,
    packageVersion: entry.compiled.graph.version,
    name: entry.compiled.graph.name,
    graphHash: entry.compiled.metadata.graphHash,
    sourceHash: entry.compiled.metadata.sourceHash,
    installedRoot: entry.root,
    compiled: entry.compiled,
    sourceFiles: entry.sourceFiles,
  }));
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

function validateUserKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new Error("Invalid user key");
  }
  return value;
}

function userKeyFromRequest(req: Request): string | undefined {
  const raw = new URL(req.url).searchParams.get("userKey");
  return raw ? validateUserKey(raw) : undefined;
}

function graphPlaybookUserSegment(userKey: string): string {
  return `u-${Buffer.from(userKey, "utf8").toString("base64url")}`;
}

function graphPlaybookRootsForUserKey(
  userKey: string | undefined,
  options: { installRoot?: string; cacheRoot?: string } = {}
): { installRoot: string; cacheRoot: string } {
  const installRoot = options.installRoot ?? GRAPH_PLAYBOOK_INSTALL_ROOT;
  const cacheRoot = options.cacheRoot ?? GRAPH_PLAYBOOK_CACHE_ROOT;
  if (!userKey) {
    return { installRoot, cacheRoot };
  }
  const segment = graphPlaybookUserSegment(userKey);
  return {
    installRoot: join(installRoot, "users", segment),
    cacheRoot: join(cacheRoot, "users", segment),
  };
}

function graphPlaybookRegistryStatesForUserKey(
  userKey: string | undefined,
  options: { state?: GraphPlaybookRegistryState; catalogState?: GraphPlaybookRegistryState } = {}
): { state: GraphPlaybookRegistryState; catalogState: GraphPlaybookRegistryState } {
  if (options.state || options.catalogState) {
    return {
      state: options.state ?? { entries: [] },
      catalogState: options.catalogState ?? { entries: [] },
    };
  }
  if (!userKey) {
    return {
      state: installedGraphPlaybookRegistryState,
      catalogState: installedGraphPlaybookCatalogState,
    };
  }

  const existing = installedGraphPlaybookRegistryStatesByUserKey.get(userKey);
  if (existing) return existing;

  const created = {
    state: { entries: [] },
    catalogState: { entries: [] },
  };
  installedGraphPlaybookRegistryStatesByUserKey.set(userKey, created);
  return created;
}

function graphPlaybookRequestScope(
  req: Request,
  options: {
    installRoot?: string;
    cacheRoot?: string;
    state?: GraphPlaybookRegistryState;
    catalogState?: GraphPlaybookRegistryState;
  } = {}
): {
  userKey: string | undefined;
  installRoot: string;
  cacheRoot: string;
  state: GraphPlaybookRegistryState;
  catalogState: GraphPlaybookRegistryState;
} {
  const userKey = userKeyFromRequest(req);
  return {
    userKey,
    ...graphPlaybookRootsForUserKey(userKey, options),
    ...graphPlaybookRegistryStatesForUserKey(userKey, options),
  };
}

interface GraphRunRequestScope {
  ownerUserKey: string;
  workspaceRoot?: string;
}

function graphRunWorkspaceRootFromRequest(req: Request): string | undefined {
  const raw = new URL(req.url).searchParams.get("workspaceRoot");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function graphRunScopeFromRequest(req: Request): GraphRunRequestScope {
  const workspaceRoot = graphRunWorkspaceRootFromRequest(req);
  return {
    ownerUserKey: userKeyFromRequest(req) ?? LOCAL_GRAPH_RUN_OWNER_KEY,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };
}

function graphRunStoredWorkspaceRoot(run: PlaybookGraphRunRecord): string | undefined {
  return run.materialization?.kind === "workspace" ? run.materialization.workspaceRoot : undefined;
}

function graphRunMatchesScope(run: PlaybookGraphRunRecord, scope: GraphRunRequestScope): boolean {
  return (
    run.ownerUserKey === scope.ownerUserKey &&
    (scope.workspaceRoot === undefined || graphRunStoredWorkspaceRoot(run) === scope.workspaceRoot)
  );
}

function memoryOwnerIdForUserKey(userKey: string | undefined): string {
  return userKey ?? LOCAL_MEMORY_OWNER_ID;
}

function memoryManagerForUserKey(userKey: string | undefined): TesseraMemoryManager {
  if (!memoryStore) return memoryManager;
  return createMemoryManager({ store: memoryStore, ownerId: memoryOwnerIdForUserKey(userKey) });
}

function agentProfileStoreForUserKey(userKey: string | undefined) {
  if (!userKey) return agentProfileStore;
  const existing = agentProfileStoresByUserKey.get(userKey);
  if (existing) return existing;
  const store = createAgentProfileStore(
    join(dirname(TASK_DB_PATH), "users", userKey, "agent-profiles.sqlite")
  );
  agentProfileStoresByUserKey.set(userKey, store);
  return store;
}

function profileForAgentId(agentId: string, userKey?: string): AgentProfile {
  const store = agentProfileStoreForUserKey(userKey);
  if (agentId === "default") return defaultAgentProfile(userKey);
  return store.get(agentId) ?? DEFAULT_AGENT_PROFILE;
}

function defaultAgentProfile(userKey?: string): AgentProfile {
  const store = agentProfileStoreForUserKey(userKey);
  return mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, store.get("default"));
}

function pinnedGraphRunAgentProfileId(run: PlaybookGraphRunRecord): string | undefined {
  const id = run.executionContext?.fingerprints.agentProfileId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function graphRunAgentProfileForExistingRun(input: {
  run: PlaybookGraphRunRecord;
  userKey?: string;
  fallbackAgent?: AgentProfile;
}): { agentProfile: AgentProfile; pinnedAgentResolved: boolean } {
  if (input.fallbackAgent) {
    return { agentProfile: input.fallbackAgent, pinnedAgentResolved: true };
  }
  const pinnedAgentId = pinnedGraphRunAgentProfileId(input.run);
  if (pinnedAgentId) {
    const profile = profileForAgentId(pinnedAgentId, input.userKey);
    if (profile.id === pinnedAgentId) {
      return { agentProfile: profile, pinnedAgentResolved: true };
    }
  }
  return {
    agentProfile: defaultAgentProfile(input.userKey),
    pinnedAgentResolved: !pinnedAgentId,
  };
}

function allowedSkillIdsForAgent(agentId: string, userKey?: string): string[] {
  return profileForAgentId(agentId, userKey).skills ?? [];
}

async function parseSkillInvocation(options: {
  text: string;
  workspaceRoot: string;
  agentId: string;
  userKey?: string | undefined;
}): Promise<{
  originalContent: string;
  prompt: string;
  skill?: Omit<TaskSkillActivation, "activatedAt">;
}> {
  const registry = createTesseraSkillRegistry({ workspaceRoot: options.workspaceRoot });
  const allowedSkillIds = allowedSkillIdsForAgent(options.agentId, options.userKey);
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
  graphRunStore.close();
  taskStore.close();
  agentProfileStore.close();
  for (const store of agentProfileStoresByUserKey.values()) {
    store.close();
  }
  inboxStore.close();
  playbookRunPreferenceStore.close();
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

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated at 1 MiB]`;
}

function graphMetadataArray<T>(metadata: Record<string, unknown> | undefined, key: string): T[] {
  const value = metadata?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function graphMetadataStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string
): string[] {
  return graphMetadataArray<unknown>(metadata, key).filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function graphPlaybookCapabilities(
  metadata: Record<string, unknown> | undefined,
  key: string
): WorkflowCapability[] {
  const capabilities: WorkflowCapability[] = [];
  const seen = new Set<WorkflowCapability>();

  for (const value of graphMetadataStringArray(metadata, key)) {
    const parsed = WorkflowCapabilitySchema.safeParse(value);
    let normalized: WorkflowCapability | undefined;
    if (parsed.success) {
      normalized = parsed.data;
    } else {
      const baseCapability = WorkflowCapabilitySchema.safeParse(value.split(".")[0]);
      normalized = baseCapability.success ? baseCapability.data : undefined;
    }
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    capabilities.push(normalized);
  }

  return capabilities;
}

function graphPlaybookVersion(version: string): number {
  const parsed = Number.parseInt(version, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

interface GraphPlaybookProjectionSource {
  kind: "built-in" | "imported";
  id: string;
  packageVersion: string;
  graphHash: string;
  sourceHash: string;
  installedRoot: string;
  compiled: CompiledPlaybookGraph;
  sourceFiles?: Record<string, string>;
}

function graphPlaybookOutputs(entry: GraphPlaybookProjectionSource): WorkflowOutputDeclaration[] {
  return graphMetadataArray<unknown>(entry.compiled.graph.metadata, "outputs").flatMap((output) => {
    const parsed = WorkflowOutputDeclarationSchema.safeParse(output);
    if (!parsed.success) return [];
    const declaration = parsed.data;
    if (declaration.kind !== "dashboard" || !declaration.layout) return [declaration];
    const layoutSource = entry.sourceFiles?.[declaration.layout];
    if (!layoutSource) return [declaration];
    try {
      return [
        {
          ...declaration,
          layoutData: DashboardLayoutSchema.parse(JSON.parse(layoutSource)),
        },
      ];
    } catch {
      return [declaration];
    }
  });
}

function graphPlaybookWritingStyle(
  metadata: Record<string, unknown> | undefined
): PlaybookSummary["writingStyle"] {
  const raw =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata.writingStyle
      : undefined;
  const parsed = PlaybookGraphWritingStyleMetadataSchema.safeParse(raw);
  return parsed.success && parsed.data.enabled ? parsed.data : undefined;
}

function graphPlaybookSummary(entry: GraphPlaybookProjectionSource): PlaybookSummary {
  const graph = entry.compiled.graph;
  const metadata = graph.metadata;
  return PlaybookSummarySchema.parse({
    id: graph.id,
    version: graphPlaybookVersion(graph.version),
    packageVersion: entry.packageVersion,
    name: graph.name,
    description: graph.description,
    graphHash: entry.graphHash,
    sourceHash: entry.sourceHash,
    category: typeof metadata?.category === "string" ? metadata.category : undefined,
    businessUseCase:
      typeof metadata?.businessUseCase === "string"
        ? metadata.businessUseCase
        : entry.kind === "imported"
          ? (graph.description ?? graph.name)
          : undefined,
    requiredCapabilities: graphPlaybookCapabilities(metadata, "requiredCapabilities"),
    optionalCapabilities: graphPlaybookCapabilities(metadata, "optionalCapabilities"),
    outputs: graphPlaybookOutputs(entry),
    writingStyle: graphPlaybookWritingStyle(metadata),
    stepCount: graph.nodes.length,
    phases: graphMetadataStringArray(metadata, "phases"),
  });
}

function graphPlaybookDetail(entry: GraphPlaybookProjectionSource) {
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

async function builtInGraphPlaybookByHash(
  playbookId: string,
  graphHash: string
): Promise<BuiltInGraphPlaybookRegistryEntry | undefined> {
  return (await builtInGraphPlaybooks()).find(
    (entry) => entry.id === playbookId && entry.graphHash === graphHash
  );
}

function graphPlaybookNeedsSourceFiles(compiled: CompiledPlaybookGraph): boolean {
  return graphMetadataArray<unknown>(compiled.graph.metadata, "outputs").some((output) => {
    if (!output || typeof output !== "object" || Array.isArray(output)) return false;
    const declaration = output as Record<string, unknown>;
    return declaration.kind === "dashboard" && typeof declaration.layout === "string";
  });
}

async function importedGraphPlaybookProjection(
  entry: GraphPlaybookRegistryEntry,
  options: { includeSourceFiles?: boolean } = {}
): Promise<GraphPlaybookProjectionSource | undefined> {
  const packageFiles =
    options.includeSourceFiles && graphPlaybookNeedsSourceFiles(entry.compiled)
      ? await readPlaybookGraphPackage(entry.installedRoot)
      : undefined;
  if (packageFiles && hashPlaybookSourceFiles(packageFiles.sourceFiles) !== entry.sourceHash) {
    return undefined;
  }
  return {
    kind: "imported",
    id: entry.id,
    packageVersion: entry.packageVersion,
    graphHash: entry.graphHash,
    sourceHash: entry.sourceHash,
    installedRoot: entry.installedRoot,
    compiled: entry.compiled,
    ...(packageFiles ? { sourceFiles: packageFiles.sourceFiles } : {}),
  };
}

async function importedGraphPlaybookCatalog({
  state,
  includeSourceFiles = false,
}: {
  state?: GraphPlaybookRegistryState | undefined;
  includeSourceFiles?: boolean | undefined;
} = {}): Promise<GraphPlaybookProjectionSource[]> {
  const catalogState = state ?? installedGraphPlaybookCatalogState;
  const projections = await Promise.all(
    catalogState.entries.map((entry) =>
      importedGraphPlaybookProjection(entry, { includeSourceFiles })
    )
  );
  return projections.filter((entry): entry is GraphPlaybookProjectionSource => entry !== undefined);
}

async function importedGraphPlaybookById(
  playbookId: string,
  state?: GraphPlaybookRegistryState,
  options: { includeSourceFiles?: boolean } = {}
): Promise<GraphPlaybookProjectionSource | undefined> {
  const catalogState = state ?? installedGraphPlaybookCatalogState;
  if (state === undefined && catalogState.entries.length === 0) {
    await refreshInstalledGraphPlaybookRegistry();
  }
  const entry = catalogState.entries.find((candidate) => candidate.id === playbookId);
  return entry ? importedGraphPlaybookProjection(entry, options) : undefined;
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
  catalogState?: GraphPlaybookRegistryState;
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
    message.startsWith("Invalid graph playbook archive") ||
    message.startsWith("Invalid zip archive") ||
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
    message.startsWith("Unsupported zip archive") ||
    message.startsWith("Unsupported zip compression method") ||
    message.startsWith("Zip archive exceeds") ||
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

  const graphPlaybooks = graphPlaybookRequestScope(req, options);

  try {
    const installed = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot: graphPlaybooks.installRoot,
      cacheRoot: graphPlaybooks.cacheRoot,
      compilerVersion: options.compilerVersion ?? `tessera-sidecar-${CORE_VERSION}`,
      scriptSdkVersion: options.scriptSdkVersion ?? `tessera-sidecar-${CORE_VERSION}`,
    });
    await refreshInstalledGraphPlaybookRegistry({
      installRoot: graphPlaybooks.installRoot,
      cacheRoot: graphPlaybooks.cacheRoot,
      state: graphPlaybooks.state,
      catalogState: graphPlaybooks.catalogState,
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

export async function handleGraphPlaybookImport(
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
  const zipPath = typeof input.zipPath === "string" ? input.zipPath.trim() : "";
  if (!zipPath) {
    return Response.json({ error: "zipPath is required" }, { status: 400 });
  }

  const graphPlaybooks = graphPlaybookRequestScope(req, options);

  try {
    const builtIns = await builtInGraphPlaybooks();
    const imported = await importGraphPlaybookArchive({
      zipPath,
      installRoot: graphPlaybooks.installRoot,
      cacheRoot: graphPlaybooks.cacheRoot,
      builtInIds: builtIns.map((entry) => entry.id),
      compilerVersion: options.compilerVersion ?? `tessera-sidecar-${CORE_VERSION}`,
      scriptSdkVersion: options.scriptSdkVersion ?? `tessera-sidecar-${CORE_VERSION}`,
    });
    await refreshInstalledGraphPlaybookRegistry({
      installRoot: graphPlaybooks.installRoot,
      cacheRoot: graphPlaybooks.cacheRoot,
      state: graphPlaybooks.state,
      catalogState: graphPlaybooks.catalogState,
    });

    return Response.json(GraphPlaybookImportResultSchema.parse(imported));
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
const DEFAULT_GRAPH_RUN_LEASE_MS = 30_000;
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
  heartbeatMs?: number;
  maxSteps?: number;
  executionContext?: Record<string, unknown>;
  assignmentPlan?: WorkflowRunAssignmentPlan;
  blockOnMissingAdapters?: boolean;
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
  needsAttention: number;
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

function graphRunOptionsWithAssignmentPlan(
  options: GraphRunHandlerOptions,
  assignmentPlan: WorkflowRunAssignmentPlan | undefined
): GraphRunHandlerOptions {
  if (assignmentPlan === undefined) return options;
  return { ...options, assignmentPlan };
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
    case "retry_needs_attention":
      return "retry_needs_attention";
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

function graphRunLeaseRenewalMs(
  options: Pick<GraphRunHandlerOptions, "leaseMs" | "leaseRenewalMs">
): number {
  if (options.leaseRenewalMs !== undefined) return options.leaseRenewalMs;
  const leaseMs = options.leaseMs ?? DEFAULT_GRAPH_RUN_LEASE_MS;
  return Math.max(1, Math.min(DEFAULT_GRAPH_RUN_WORKER_LEASE_RENEWAL_MS, Math.floor(leaseMs / 3)));
}

function graphRunPayloadWorkspaceRoot(payload: Record<string, unknown>): string | undefined {
  const workspaceRoot = payload.workspaceRoot;
  return typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot : undefined;
}

function graphArtifactPathValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\\/:\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function renderGraphArtifactWritePath(path: string, input: Record<string, unknown>): string {
  return path.replace(/\{\{\s*inputs\.([A-Za-z0-9_.:-]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split(".").reduce<unknown>((cursor, segment) => {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
      return (cursor as Record<string, unknown>)[segment];
    }, input);
    return graphArtifactPathValue(value) || "untitled";
  });
}

function textValueFromArtifact(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "markdown", "bodyMarkdown", "content", "body", "summary"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim().length > 0) return text;
  }

  const title = typeof record.title === "string" ? record.title.trim() : "";
  const thesis = typeof record.thesis === "string" ? record.thesis.trim() : "";
  const audiencePromise =
    typeof record.audiencePromise === "string" ? record.audiencePromise.trim() : "";
  const outline = Array.isArray(record.outline) ? record.outline : [];
  const sections = [
    title ? `# ${title}` : "",
    thesis ? `## Thesis\n\n${thesis}` : "",
    audiencePromise ? `## Audience Promise\n\n${audiencePromise}` : "",
    outline.length > 0
      ? [
          "## Outline",
          ...outline.flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return [];
            const outlineItem = item as Record<string, unknown>;
            const heading =
              typeof outlineItem.heading === "string" ? outlineItem.heading.trim() : "";
            const points = Array.isArray(outlineItem.points)
              ? outlineItem.points.filter((point): point is string => typeof point === "string")
              : [];
            return [
              heading ? `### ${heading}` : "",
              points.length > 0 ? points.map((point) => `- ${point}`).join("\n") : "",
            ].filter(Boolean);
          }),
        ].join("\n\n")
      : "",
  ].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function formatGraphArtifactWriteContent(value: unknown, path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    const text = textValueFromArtifact(value);
    if (text !== undefined) return text.endsWith("\n") ? text : `${text}\n`;
  }
  if (typeof value === "string") return value;
  const json = JSON.stringify(value, null, 2);
  return `${json ?? String(value)}\n`;
}

async function createWorkspaceArtifactWriteAdapter(
  workspaceRoot: string
): Promise<NonNullable<GraphRunHandlerOptions["artifactWriteAdapter"]>> {
  const guard = await createWorkspaceGuard(workspaceRoot);
  return async ({ run, node, artifactVersion, value }) => {
    const renderedPath = renderGraphArtifactWritePath(node.path, run.input);
    const parentAbsolute = await guard.resolveInsideWorkspaceForCreate(dirname(renderedPath));
    await mkdir(parentAbsolute, { recursive: true });
    const absolute = await guard.resolveInsideWorkspaceForCreate(renderedPath);
    const content = formatGraphArtifactWriteContent(value, renderedPath);
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

function graphWritingStyleMetadata(
  graph: CompiledPlaybookGraph["graph"]
): ReturnType<typeof PlaybookGraphWritingStyleMetadataSchema.parse> | undefined {
  const parsed = PlaybookGraphWritingStyleMetadataSchema.safeParse(graph.metadata?.writingStyle);
  return parsed.success && parsed.data.enabled ? parsed.data : undefined;
}

async function graphRunPlatformContext(input: {
  compiledGraph: CompiledPlaybookGraph;
  workspaceRoot?: string;
  selection?: {
    copyType?: string | undefined;
    override?: string | undefined;
    toneNudges?: string[] | undefined;
  };
}): Promise<PlaybookGraphPlatformContext | undefined> {
  const writingStyle = graphWritingStyleMetadata(input.compiledGraph.graph);
  if (!writingStyle || !input.workspaceRoot) return undefined;
  const workspaceConfig = await readWorkspaceConfig(input.workspaceRoot);
  if (!workspaceConfig.config.styleGuide) return undefined;
  const workspaceGuide = WorkspaceConfigSchema.parse(workspaceConfig.config).styleGuide;
  if (!workspaceGuide) return undefined;
  const guide = workspaceGuide;
  const copyType =
    input.selection?.copyType ?? writingStyle.defaultCopyType ?? guide.profile.defaultCopyType;
  const styleGuide = {
    schemaVersion: 1 as const,
    profileId: guide.profile.id,
    profileName: guide.profile.name,
    copyType,
    source: "workspace" as const,
    snapshot: guide,
    ...(input.selection?.override ? { override: input.selection.override } : {}),
    toneNudges: input.selection?.toneNudges ?? [],
  };
  const styleGuideHash = graphRunHash(styleGuide);
  return { styleGuide, styleGuideHash };
}

function workspaceConfigErrorResponse(error: unknown): Response {
  if (error instanceof WorkspaceConfigConflictError) {
    return Response.json(
      {
        error: error.message,
        currentFingerprint: error.currentFingerprint,
      },
      { status: 409 }
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const status =
    error instanceof SyntaxError ||
    (error instanceof Error && ["WorkspaceBoundaryError", "ZodError"].includes(error.name))
      ? 400
      : 500;
  return Response.json({ error: message }, { status });
}

export async function handleWorkspaceStyleGuideRead(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = WorkspaceStyleGuideReadRequestSchema.safeParse({
    workspaceRoot: searchParams.get("workspaceRoot") ?? "",
  });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    return Response.json(await readWorkspaceConfig(parsed.data.workspaceRoot));
  } catch (error) {
    return workspaceConfigErrorResponse(error);
  }
}

export async function handleWorkspaceStyleGuideSave(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WorkspaceStyleGuideSaveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    return Response.json(
      await saveWorkspaceConfig({
        workspaceRoot: parsed.data.workspaceRoot,
        config: parsed.data.config,
        ...(parsed.data.expectedFingerprint
          ? { expectedFingerprint: parsed.data.expectedFingerprint }
          : {}),
        overwrite: parsed.data.overwrite,
      })
    );
  } catch (error) {
    return workspaceConfigErrorResponse(error);
  }
}

function graphRunStylePromptSection(input: PlaybookGraphAgentAdapterInput): string | undefined {
  const style = input.platformContext?.styleGuide;
  if (!style) return undefined;
  const guide = style.snapshot;
  const copyType = guide.copyTypes[style.copyType];
  const copyTypeLabel = copyType?.label ? `${copyType.label} (${style.copyType})` : style.copyType;
  const targetWords =
    copyType?.targetWords?.min && copyType.targetWords.max
      ? `${copyType.targetWords.min}-${copyType.targetWords.max}`
      : copyType?.targetWords?.min
        ? `at least ${copyType.targetWords.min}`
        : copyType?.targetWords?.max
          ? `up to ${copyType.targetWords.max}`
          : "";
  return [
    "Workspace Style Guide:",
    `Profile: ${style.profileName}`,
    `Copy type: ${copyTypeLabel}`,
    copyType?.length ? `Length: ${copyType.length}` : "",
    targetWords ? `Target words: ${targetWords}` : "",
    copyType?.tone.length ? `Copy type tone: ${copyType.tone.join(", ")}` : "",
    copyType?.formatRules.length ? `Format rules: ${copyType.formatRules.join("; ")}` : "",
    guide.voice.persona ? `Persona: ${guide.voice.persona}` : "",
    guide.voice.pointOfView ? `Point of view: ${guide.voice.pointOfView}` : "",
    guide.tone.default.length > 0 ? `Tone: ${guide.tone.default.join(", ")}` : "",
    guide.language.readingLevel ? `Reading level: ${guide.language.readingLevel}` : "",
    guide.language.jargonPolicy ? `Jargon policy: ${guide.language.jargonPolicy}` : "",
    guide.voice.principles.length > 0 ? `Principles: ${guide.voice.principles.join("; ")}` : "",
    guide.language.preferredTerms.length > 0
      ? `Preferred terms: ${guide.language.preferredTerms.join(", ")}`
      : "",
    guide.language.bannedTerms.length > 0
      ? `Banned terms: ${guide.language.bannedTerms.join(", ")}`
      : "",
    guide.structure.introMaxWords ? `Intro max words: ${guide.structure.introMaxWords}` : "",
    guide.structure.paragraphMaxSentences
      ? `Paragraph max sentences: ${guide.structure.paragraphMaxSentences}`
      : "",
    guide.evidence.claimPolicy ? `Claim policy: ${guide.evidence.claimPolicy}` : "",
    style.override ? `One-run override: ${style.override}` : "",
    style.toneNudges.length > 0 ? `Tone nudges: ${style.toneNudges.join(", ")}` : "",
    "Treat hard rules as binding for this node output.",
  ]
    .filter(Boolean)
    .join("\n");
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

function graphRunAssignmentExecutionContext(
  assignmentPlan: WorkflowRunAssignmentPlan | undefined
): Record<string, unknown> | undefined {
  const assignments = Object.fromEntries(
    Object.entries(assignmentPlan?.assignments ?? {}).map(([nodeId, assignment]) => [
      nodeId,
      {
        ...(assignment.agentId ? { agentId: assignment.agentId } : {}),
        ...(assignment.agentLabel ? { agentLabel: assignment.agentLabel } : {}),
        ...(assignment.agentFingerprint ? { agentFingerprint: assignment.agentFingerprint } : {}),
        ...(assignment.providerFingerprint
          ? { providerFingerprint: assignment.providerFingerprint }
          : {}),
        skillCapabilities: assignment.skillCapabilities,
        toolCapabilities: assignment.toolCapabilities,
        integrationCapabilities: assignment.integrationCapabilities,
      },
    ])
  );
  if (Object.keys(assignments).length === 0) return undefined;
  return {
    resolverVersion: assignmentPlan?.resolverVersion ?? 1,
    assignments,
  };
}

function graphRunExecutionContextWithAssignments(
  executionContext: Record<string, unknown> | undefined,
  assignmentPlan: WorkflowRunAssignmentPlan | undefined
): Record<string, unknown> | undefined {
  const assignmentContext = graphRunAssignmentExecutionContext(assignmentPlan);
  if (!assignmentContext) return executionContext;
  return {
    ...(executionContext ?? {}),
    nodeAssignments: assignmentContext,
  };
}

function graphRunAgentProvider(options: GraphRunHandlerOptions): AgentProviderConfig | undefined {
  const agent = options.agentProfile;
  if (agent?.model.mode === "override") return agent.model.provider;
  return options.agentProvider;
}

const GRAPH_AGENT_WORKSPACE_CONTEXT_MAX_FILES = 24;
const GRAPH_AGENT_WORKSPACE_CONTEXT_MAX_SNIPPETS = 8;
const GRAPH_AGENT_WORKSPACE_CONTEXT_MAX_DEPTH = 3;
const GRAPH_AGENT_WORKSPACE_CONTEXT_SNIPPET_CHARS = 1_200;
const GRAPH_AGENT_WORKSPACE_CONTEXT_TEXT_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".json",
  ".md",
  ".skill",
  ".txt",
]);
const GRAPH_AGENT_WORKSPACE_CONTEXT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
]);

type GraphAgentWorkspaceFile = {
  absolutePath: string;
  modifiedMs: number;
  relativePath: string;
  size: number;
};

function graphRunWorkspaceRootFromInput(input: PlaybookGraphAgentAdapterInput): string | undefined {
  const workspaceRoot = input.input.workspaceRoot;
  return typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot : undefined;
}

function graphRunWorkspaceContextIsTextFile(path: string): boolean {
  return GRAPH_AGENT_WORKSPACE_CONTEXT_TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

async function collectGraphRunWorkspaceFiles(
  root: string,
  dir: string,
  depth: number
): Promise<GraphAgentWorkspaceFile[]> {
  if (depth > GRAPH_AGENT_WORKSPACE_CONTEXT_MAX_DEPTH) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: GraphAgentWorkspaceFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith("~$") || entry.name.startsWith(".~lock.")) continue;
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (GRAPH_AGENT_WORKSPACE_CONTEXT_SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await collectGraphRunWorkspaceFiles(root, absolutePath, depth + 1)));
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata) continue;
    files.push({
      absolutePath,
      modifiedMs: metadata.mtimeMs,
      relativePath: relative(root, absolutePath).replaceAll("\\", "/"),
      size: metadata.size,
    });
  }
  return files;
}

export async function graphRunWorkspaceContext(
  input: PlaybookGraphAgentAdapterInput
): Promise<string | undefined> {
  const workspaceRoot = graphRunWorkspaceRootFromInput(input);
  if (!workspaceRoot) return undefined;
  const guard = await createWorkspaceGuard(workspaceRoot).catch(() => undefined);
  if (!guard) return undefined;
  const files = (await collectGraphRunWorkspaceFiles(guard.root, guard.root, 0))
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .slice(0, GRAPH_AGENT_WORKSPACE_CONTEXT_MAX_FILES);
  if (files.length === 0) {
    return `Workspace root: ${guard.root}\nNo files were visible in this workspace.`;
  }

  const inventory = files.map((file) => {
    const modified = new Date(file.modifiedMs).toISOString();
    return `- ${file.relativePath} (${file.size} bytes, modified ${modified})`;
  });
  const snippets: string[] = [];
  for (const file of files) {
    if (snippets.length >= GRAPH_AGENT_WORKSPACE_CONTEXT_MAX_SNIPPETS) break;
    if (!graphRunWorkspaceContextIsTextFile(file.relativePath)) continue;
    const text = await readFile(file.absolutePath, "utf8").catch(() => undefined);
    if (!text?.trim()) continue;
    snippets.push(
      [
        `### ${file.relativePath}`,
        text.trim().slice(0, GRAPH_AGENT_WORKSPACE_CONTEXT_SNIPPET_CHARS),
      ].join("\n")
    );
  }

  return [
    `Workspace root: ${guard.root}`,
    "Recent workspace files:",
    inventory.join("\n"),
    snippets.length > 0 ? ["", "Workspace excerpts:", snippets.join("\n\n")].join("\n") : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

export function graphRunAgentPrompt(
  input: PlaybookGraphAgentAdapterInput,
  workspaceContext?: string,
  agent?: AgentProfile
): string {
  const context = stableJsonStringify({
    runId: input.run.runId,
    nodeId: input.node.id,
    input: input.input,
    artifacts: input.artifacts,
    platformContext: input.platformContext,
    branchItem: input.branchItem?.value,
  });
  const runtime = agent ? compileAgentRuntimeContext(agent) : undefined;
  const styleSection = graphRunStylePromptSection(input);
  return [
    ...(agent
      ? [
          `Agent profile: ${agent.name}`,
          runtime ? `Agent runtime: ${runtime.compiledSummary}` : "",
          agent.instructions ? `Agent instructions:\n${agent.instructions}` : "",
          agent.soul ? `Agent soul:\n${agent.soul}` : "",
          agent.userContext ? `User context:\n${agent.userContext}` : "",
          agent.memoryDefaults ? `Memory defaults:\n${agent.memoryDefaults}` : "",
        ].filter(Boolean)
      : []),
    input.prompt ?? `Execute graph agent node ${input.node.id}.`,
    ...(styleSection ? ["", styleSection] : []),
    ...(workspaceContext ? ["", "Workspace context:", workspaceContext] : []),
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
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

export function graphRunAgentProfileForNode(input: {
  assignmentPlan?: WorkflowRunAssignmentPlan;
  fallbackAgent: AgentProfile;
  nodeId: string;
  run: Pick<PlaybookGraphRunRecord, "assignmentPlan" | "ownerUserKey">;
  resolveProfile?: (agentId: string, userKey?: string) => AgentProfile;
}): AgentProfile {
  const assignment =
    input.assignmentPlan?.assignments[input.nodeId] ??
    input.run.assignmentPlan?.assignments[input.nodeId];
  if (!assignment?.agentId) return input.fallbackAgent;
  return (input.resolveProfile ?? profileForAgentId)(assignment.agentId, input.run.ownerUserKey);
}

function graphRunAgentAdapter(
  options: GraphRunHandlerOptions
): GraphRunHandlerOptions["agentAdapter"] | undefined {
  if (options.agentAdapter) return options.agentAdapter;
  const fallbackAgent = options.agentProfile ?? defaultAgentProfile();
  const fallbackProvider = graphRunAgentProvider({ ...options, agentProfile: fallbackAgent });
  if (!fallbackProvider && !options.credential) return undefined;
  const workspaceCli = graphRunWorkspaceCli(options);
  return async (input) => {
    const agent = graphRunAgentProfileForNode({
      fallbackAgent,
      nodeId: input.node.id,
      run: input.run,
      ...(options.assignmentPlan ? { assignmentPlan: options.assignmentPlan } : {}),
    });
    const provider = graphRunAgentProvider({ ...options, agentProfile: agent });
    if (!provider) throw new Error("Graph agent execution requires a model provider");
    const workspaceContext = await graphRunWorkspaceContext(input);
    const result = await executeAgentTurn({
      cli: { runWorkspaceCli: workspaceCli },
      request: {
        prompt: graphRunAgentPrompt(input, workspaceContext, agent),
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
  store: GraphRunStore,
  scope?: GraphRunRequestScope
): Promise<ReturnType<typeof PlaybookGraphRunDetailSchema.parse> | undefined> {
  const run = await store.getRun(runId);
  if (!run) return undefined;
  if (scope && !graphRunMatchesScope(run, scope)) return undefined;
  return PlaybookGraphRunDetailSchema.parse({
    run,
    queue: await store.getQueue(runId),
    branchItems: await store.listBranchItems(runId),
    artifacts: (await store.listArtifactVersions(runId)).sort((left, right) =>
      graphArtifactSortKey(left).localeCompare(graphArtifactSortKey(right))
    ),
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

function isAutoRecoverableToolNode(
  node: PlaybookGraphNode | undefined,
  toolPolicies: Record<string, PlaybookGraphToolExecutionPolicy>
): boolean {
  if (!node || node.kind !== "tool") return false;
  const policy = toolPolicies[node.capability];
  return policy?.idempotent === true && policy.sideEffect === "read";
}

function autoRecoveryOperationExists(
  operations: PlaybookGraphOperationRecord[],
  queueEntryId: string
): boolean {
  return operations.some(
    (operation) =>
      operation.kind === "retry_needs_attention" &&
      operation.actionSpecId === "system.recovery.auto_retry" &&
      operation.affectedQueueEntryIds.includes(queueEntryId)
  );
}

function shouldAutoRecoverAttention(
  entry: PlaybookGraphQueueEntry,
  node: PlaybookGraphNode | undefined,
  operations: PlaybookGraphOperationRecord[],
  toolPolicies: Record<string, PlaybookGraphToolExecutionPolicy>
): boolean {
  if (entry.status !== "needs_attention") return false;
  if (autoRecoveryOperationExists(operations, entry.queueEntryId)) return false;
  const code = entry.attentionEvidence?.code;
  if (code === "hard_timeout") return false;
  if (entry.nodeKind === "artifactWrite" || entry.nodeKind === "humanReview") return false;
  if (code === "stale_lease") {
    return (
      entry.nodeKind === "script" ||
      entry.nodeKind === "condition" ||
      entry.nodeKind === "join" ||
      isAutoRecoverableToolNode(node, toolPolicies)
    );
  }
  if (code === "stale_heartbeat") {
    return entry.nodeKind === "script" || isAutoRecoverableToolNode(node, toolPolicies);
  }
  return false;
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

function graphRunArtifactLabel(artifactId: string): string {
  return artifactId
    .replace(/Scorecard$/i, " scorecard")
    .replace(/Brief$/i, " brief")
    .replace(/Draft$/i, " draft")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function graphReviewArtifactId(
  detail: GraphRunDetail,
  entry: PlaybookGraphQueueEntry,
  node: PlaybookGraphNode | undefined
): string | undefined {
  return (
    detail.reviews.find((event) => event.queueEntryId === entry.queueEntryId)?.artifactId ??
    (node?.kind === "humanReview" ? node.artifact : undefined) ??
    entry.consumesArtifacts[0]?.artifactId
  );
}

function graphReviewApproveLabel(
  detail: GraphRunDetail,
  entry: PlaybookGraphQueueEntry,
  node: PlaybookGraphNode | undefined
): string {
  const artifactId = graphReviewArtifactId(detail, entry, node);
  if (!artifactId) return "Approve";
  const label = graphRunArtifactLabel(artifactId).toLowerCase();
  if (label.includes("brief")) return "Approve brief";
  if (label.includes("article")) return "Approve article";
  if (label.includes("draft")) return "Approve draft";
  return "Approve";
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
          label: graphReviewApproveLabel(detail, entry, node),
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
        label: "Retry step",
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
  for (const entry of detail.queue.filter((entry) => entry.status === "needs_attention")) {
    actions.push(
      actionSpec({
        schemaVersion: 1,
        actionId: `${entry.queueEntryId}:retry_needs_attention`,
        decision: "retry_needs_attention",
        label: "Retry step",
        description: entry.attentionEvidence?.reason ?? entry.blockedReason,
        queueEntryId: entry.queueEntryId,
        nodePath: entry.nodePath,
        nodeKind: entry.nodeKind,
        allowedRunStatuses: ["needs_attention", "running", "blocked"],
        allowedQueueStatuses: ["needs_attention"],
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

function productActionFromSpec(
  action: PlaybookGraphResumeActionSpec,
  tone: PlaybookRunProductAction["tone"] = "primary"
): PlaybookRunProductAction {
  return {
    actionId: action.actionId,
    label: action.label,
    ...(action.description ? { description: action.description } : {}),
    tone,
    decision: action.decision,
    ...(action.queueEntryId ? { queueEntryId: action.queueEntryId } : {}),
  };
}

function graphRunProductView(
  detail: GraphRunDetail,
  actions: PlaybookGraphResumeActionSpec[]
): PlaybookRunProductView {
  if (detail.run.status === "completed") {
    return {
      schemaVersion: 1,
      state: "completed",
      title: "Completed",
      message: "Tessera finished this run.",
      secondaryActions: [],
      technicalSummary: { internalStatus: detail.run.status },
    };
  }
  if (detail.run.status === "failed") {
    return {
      schemaVersion: 1,
      state: "failed",
      title: "Run failed",
      message: detail.run.error ?? "Tessera could not finish this run.",
      secondaryActions: [],
      technicalSummary: { internalStatus: detail.run.status },
    };
  }

  const attentionEntry = detail.queue.find((entry) => entry.status === "needs_attention");
  if (attentionEntry) {
    const retryAction = actions.find(
      (action) =>
        action.decision === "retry_needs_attention" &&
        action.queueEntryId === attentionEntry.queueEntryId
    );
    return {
      schemaVersion: 1,
      state: "retry_available",
      title: "Step interrupted",
      message: "A playbook step was interrupted. Tessera can retry it.",
      ...(retryAction ? { primaryAction: productActionFromSpec(retryAction) } : {}),
      secondaryActions: [],
      technicalSummary: {
        internalStatus: `${detail.run.status}:${attentionEntry.status}`,
        ...(attentionEntry.attentionEvidence?.code
          ? { attentionCode: attentionEntry.attentionEvidence.code }
          : {}),
        queueEntryId: attentionEntry.queueEntryId,
        nodePath: attentionEntry.nodePath,
        nodeKind: attentionEntry.nodeKind,
      },
    };
  }

  const interruptedEntry = detail.queue.find((entry) => entry.status === "interrupted");
  if (interruptedEntry || detail.run.status === "interrupted") {
    const retryAction = interruptedEntry
      ? actions.find(
          (action) =>
            action.decision === "retry_interrupted" &&
            action.queueEntryId === interruptedEntry.queueEntryId
        )
      : undefined;
    return {
      schemaVersion: 1,
      state: "retry_available",
      title: "Step interrupted",
      message: "A playbook step was interrupted. Tessera can retry it.",
      ...(retryAction ? { primaryAction: productActionFromSpec(retryAction) } : {}),
      secondaryActions: [],
      technicalSummary: {
        internalStatus: interruptedEntry
          ? `${detail.run.status}:${interruptedEntry.status}`
          : detail.run.status,
        ...(interruptedEntry
          ? {
              queueEntryId: interruptedEntry.queueEntryId,
              nodePath: interruptedEntry.nodePath,
              nodeKind: interruptedEntry.nodeKind,
            }
          : {}),
      },
    };
  }

  const reviewEntry = detail.queue.find(
    (entry) => entry.status === "blocked" && entry.nodeKind === "humanReview"
  );
  if (reviewEntry) {
    const approveAction = actions.find(
      (action) => action.decision === "approve" && action.queueEntryId === reviewEntry.queueEntryId
    );
    const stopAction = actions.find(
      (action) => action.decision === "deny" && action.queueEntryId === reviewEntry.queueEntryId
    );
    return {
      schemaVersion: 1,
      state: "waiting_for_review",
      title: "Review needed",
      message: "Review what Tessera prepared before the run continues.",
      ...(approveAction ? { primaryAction: productActionFromSpec(approveAction) } : {}),
      secondaryActions: stopAction ? [productActionFromSpec(stopAction, "danger")] : [],
      technicalSummary: {
        internalStatus: `${detail.run.status}:${reviewEntry.status}`,
        queueEntryId: reviewEntry.queueEntryId,
        nodePath: reviewEntry.nodePath,
        nodeKind: reviewEntry.nodeKind,
      },
    };
  }

  return {
    schemaVersion: 1,
    state: "working",
    title: "Working",
    message: "Tessera is working on this run.",
    secondaryActions: [],
    technicalSummary: { internalStatus: detail.run.status },
  };
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

function graphNodeConsumesStyle(node: PlaybookGraphNode): boolean {
  if (node.style?.consume === true) return true;
  return node.kind === "agent" && node.output?.style?.consume === true;
}

function findGraphNodeByPath(
  nodes: PlaybookGraphNode[],
  nodePath: string
): PlaybookGraphNode | null {
  const nodeId = nodePath.split("/").at(-1);
  if (!nodeId) return null;
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    if (node.kind === "parallelMap") {
      const nested = findGraphNodeByPath(node.branch.nodes, nodePath);
      if (nested) return nested;
    }
  }
  return null;
}

function artifactText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "markdown", "content", "body", "article", "brief"]) {
      if (typeof record[key] === "string") return record[key];
    }
  }
  return "";
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function styleComplianceForDetail(
  detail: GraphRunDetail
): GraphRunReviewSurface["styleCompliance"] {
  const styleContext = detail.run.platformContext?.styleGuide;
  if (!styleContext) return undefined;
  const compiled = parsePinnedCompiledGraph(detail.run.snapshot);
  const guide = styleContext.snapshot;
  const activeArtifacts = graphRunActiveArtifactRows(detail);
  const findings: NonNullable<GraphRunReviewSurface["styleCompliance"]>["findings"] = [];

  for (const artifact of activeArtifacts) {
    const producer = findGraphNodeByPath(compiled.graph.nodes, artifact.nodePath);
    if (!producer || !graphNodeConsumesStyle(producer)) continue;
    const text = artifactText(artifact.value);
    if (!text) continue;
    const normalized = text.toLowerCase();

    for (const term of guide.language.bannedTerms) {
      if (!term.trim()) continue;
      if (normalized.includes(term.toLowerCase())) {
        findings.push({
          artifactId: artifact.artifactId,
          outputKind: artifact.artifactId,
          nodePath: artifact.nodePath,
          severity: "fail",
          ruleId: "language.bannedTerms",
          message: `Uses banned term: ${term}.`,
          suggestedFix: "Replace it with a concrete, approved phrase or remove it.",
        });
      }
    }

    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph && !paragraph.startsWith("#"));
    const intro = paragraphs[0];
    if (
      intro &&
      guide.structure.introMaxWords &&
      wordCount(intro) > guide.structure.introMaxWords
    ) {
      findings.push({
        artifactId: artifact.artifactId,
        outputKind: artifact.artifactId,
        nodePath: artifact.nodePath,
        severity: "warning",
        ruleId: "structure.introMaxWords",
        message: `Intro is ${wordCount(intro)} words; limit is ${guide.structure.introMaxWords}.`,
        suggestedFix: "Shorten the introduction and move detail into the body.",
      });
    }
    if (guide.structure.paragraphMaxSentences) {
      for (const paragraph of paragraphs) {
        const count = sentenceCount(paragraph);
        if (count > guide.structure.paragraphMaxSentences) {
          findings.push({
            artifactId: artifact.artifactId,
            outputKind: artifact.artifactId,
            nodePath: artifact.nodePath,
            severity: "warning",
            ruleId: "structure.paragraphMaxSentences",
            message: `Paragraph has ${count} sentences; limit is ${guide.structure.paragraphMaxSentences}.`,
            suggestedFix: "Split the paragraph into shorter, scannable blocks.",
          });
          break;
        }
      }
    }
  }

  const severity = findings.some((finding) => finding.severity === "fail")
    ? "fail"
    : findings.length > 0
      ? "warning"
      : "pass";
  return StyleComplianceSummarySchema.parse({
    schemaVersion: 1,
    styleGuideHash: detail.run.platformContext?.styleGuideHash,
    profileName: styleContext.profileName,
    copyType: styleContext.copyType,
    severity,
    findings,
  });
}

async function graphRunReviewSurfaceFromDetail(
  detail: GraphRunDetail,
  _options: GraphRunHandlerOptions
): Promise<GraphRunReviewSurface> {
  const activeArtifacts = graphRunActiveArtifactRows(detail);
  const actions = graphRunActionSpecs(detail);
  return PlaybookGraphRunReviewSurfaceSchema.parse({
    schemaVersion: 1,
    detail,
    activeArtifacts,
    artifactTimeline: graphRunArtifactTimelineRows(detail, activeArtifacts),
    timeline: graphRunTimelineRows(detail),
    branches: graphRunBranchGroups(detail, activeArtifacts),
    actions,
    productView: graphRunProductView(detail, actions),
    styleCompliance: styleComplianceForDetail(detail),
  });
}

async function graphRunReviewSurface(
  runId: string,
  store: GraphRunStore,
  options: GraphRunHandlerOptions,
  scope?: GraphRunRequestScope
): Promise<GraphRunReviewSurface | undefined> {
  const detail = await graphRunDetail(runId, store, scope);
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
  const queuedEntries = (await store.getQueue(runId)).filter((entry) => entry.status === "queued");
  if (
    options.blockOnMissingAdapters === false &&
    queuedEntries.length > 0 &&
    queuedEntries.every((entry) =>
      graphRunQueuedEntryRequiresUnavailableAdapter(entry, {
        scriptAdapter: Boolean(scriptAdapter),
        artifactWriteAdapter: Boolean(artifactWriteAdapter),
        agentAdapter: Boolean(agentAdapter),
        toolAdapter: Boolean(toolAdapter),
      })
    )
  ) {
    return false;
  }
  if (!scriptAdapter && !agentAdapter && !artifactWriteAdapter && toolAdapter) {
    if (queuedEntries.length === 0 || queuedEntries.some((entry) => entry.nodeKind !== "tool")) {
      return false;
    }
  }
  if (!scriptAdapter && artifactWriteAdapter) {
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
    leaseRenewalMs: graphRunLeaseRenewalMs(options),
    heartbeatMs: options.heartbeatMs ?? 10_000,
    softTimeoutMs,
    hardTimeoutMs,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.blockOnMissingAdapters !== undefined
      ? { blockOnMissingAdapters: options.blockOnMissingAdapters }
      : {}),
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

function graphRunQueuedEntryRequiresUnavailableAdapter(
  entry: PlaybookGraphQueueEntry,
  adapters: {
    scriptAdapter: boolean;
    artifactWriteAdapter: boolean;
    agentAdapter: boolean;
    toolAdapter: boolean;
  }
): boolean {
  switch (entry.nodeKind) {
    case "agent":
      return !adapters.agentAdapter;
    case "artifactWrite":
      return !adapters.artifactWriteAdapter;
    case "script":
      return !adapters.scriptAdapter;
    case "tool":
      return !adapters.toolAdapter;
    default:
      return false;
  }
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
  const recovered = await store.recoverStaleQueueLeases({
    runId,
    runtimeId: options.runtimeId ?? sidecarGraphRunRuntimeId("worker"),
    now: recoveredAt,
    hardTimeoutMs,
  });
  const run = await store.getRun(runId);
  if (!run) {
    return {
      interrupted: recovered.inspected,
      requeued: recovered.autoRequeued,
      blocked: recovered.needsAttention,
      needsAttention: recovered.needsAttention,
    };
  }

  const interruptedEntries = (await store.getQueue(runId)).filter(
    (entry) => entry.status === "interrupted"
  );
  let requeued = 0;
  let needsAttention = recovered.needsAttention;
  const autoRecoveredQueueEntryIds: string[] = [];
  const toolPolicies = graphRunDefaultToolPolicies(options);
  const operationRecords = await store.listOperationRecords(runId);
  for (const entry of interruptedEntries) {
    if (
      entry.recoveryPolicy === "rerun_if_no_success_memo" &&
      !autoRecoveryOperationExists(operationRecords, entry.queueEntryId)
    ) {
      const operationRecord = {
        schemaVersion: 1,
        operationRecordId: `${entry.queueEntryId}:auto-retry`,
        operationAttemptId: `${entry.queueEntryId}:auto-retry`,
        runId: entry.runId,
        actionSpecId: "system.recovery.auto_retry",
        kind: "retry_needs_attention",
        status: "succeeded",
        operatorIntent: "Automatically retry interrupted step",
        queueEntryId: entry.queueEntryId,
        affectedArtifactIds: [],
        affectedReviewEventIds: [],
        affectedQueueEntryIds: [entry.queueEntryId],
        createdAt: recoveredAt,
        completedAt: recoveredAt,
        redactedPayloadSummary: "attentionCode=stale_lease",
      } satisfies PlaybookGraphOperationRecord;
      await store.addOperationRecord(operationRecord);
      operationRecords.push(operationRecord);
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
        attentionEvidence: {
          code: "stale_lease",
          reason:
            entry.blockedReason ??
            "Tessera stopped while this step was running. This can happen if the app or sidecar restarted during the step.",
          observedAt: recoveredAt,
          previousQueueStatus: "interrupted",
          recoveryDecision: "auto_requeued",
        },
        updatedAt: recoveredAt,
      });
      requeued += 1;
      continue;
    }
    await store.updateQueueEntry({
      ...entry,
      status: "needs_attention",
      runtimeId: undefined,
      leaseId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      blockedReason:
        entry.blockedReason ??
        "Tessera stopped while this step was running and needs a retry decision.",
      error: undefined,
      completedAt: undefined,
      attentionEvidence: {
        code: "ambiguous_recovery",
        reason:
          entry.blockedReason ??
          "Tessera stopped while this step was running and needs a retry decision.",
        observedAt: recoveredAt,
        previousQueueStatus: "interrupted",
        recoveryDecision: "needs_attention",
      },
      updatedAt: recoveredAt,
    });
    needsAttention += 1;
  }

  const postRecoveryDetail = await graphRunDetail(runId, store);
  if (postRecoveryDetail) {
    for (const entry of postRecoveryDetail.queue.filter(
      (item) => item.status === "needs_attention"
    )) {
      const node = graphRunNodeForQueueEntry(postRecoveryDetail, entry);
      if (!shouldAutoRecoverAttention(entry, node, postRecoveryDetail.operations, toolPolicies)) {
        continue;
      }
      await store.addOperationRecord({
        schemaVersion: 1,
        operationRecordId: `${entry.queueEntryId}:auto-retry`,
        operationAttemptId: `${entry.queueEntryId}:auto-retry`,
        runId: entry.runId,
        actionSpecId: "system.recovery.auto_retry",
        kind: "retry_needs_attention",
        status: "succeeded",
        operatorIntent: "Automatically retry interrupted step",
        queueEntryId: entry.queueEntryId,
        affectedArtifactIds: [],
        affectedReviewEventIds: [],
        affectedQueueEntryIds: [entry.queueEntryId],
        createdAt: recoveredAt,
        completedAt: recoveredAt,
        ...(entry.attentionEvidence?.code
          ? { redactedPayloadSummary: `attentionCode=${entry.attentionEvidence.code}` }
          : {}),
      });
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
        attentionEvidence: entry.attentionEvidence
          ? {
              ...entry.attentionEvidence,
              recoveryDecision: "auto_requeued",
            }
          : undefined,
        updatedAt: recoveredAt,
      });
      autoRecoveredQueueEntryIds.push(entry.queueEntryId);
      needsAttention = Math.max(0, needsAttention - 1);
    }
  }

  if (recovered.autoRequeued + requeued + autoRecoveredQueueEntryIds.length > 0) {
    const firstRequeued = interruptedEntries.find(
      (entry) => entry.recoveryPolicy === "rerun_if_no_success_memo"
    );
    await store.updateRun({
      ...run,
      status: "running",
      currentQueueEntryId:
        firstRequeued?.queueEntryId ?? autoRecoveredQueueEntryIds[0] ?? run.currentQueueEntryId,
      blockedReason: undefined,
      error: undefined,
      completedAt: undefined,
      updatedAt: recoveredAt,
    });
  } else if (needsAttention > 0 && run.status !== "needs_attention") {
    await store.updateRun({
      ...run,
      status: "needs_attention",
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
    interrupted: recovered.inspected + interruptedEntries.length,
    requeued: recovered.autoRequeued + requeued + autoRecoveredQueueEntryIds.length,
    blocked: needsAttention,
    needsAttention,
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
    leaseRenewalMs: graphRunLeaseRenewalMs(options),
    blockOnMissingAdapters: options.blockOnMissingAdapters ?? false,
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
      candidate.graphHash === compiledGraph.metadata.graphHash &&
      candidate.sourceHash === compiledGraph.metadata.sourceHash
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
        candidate.graphHash === compiledGraph.metadata.graphHash &&
        candidate.sourceHash === compiledGraph.metadata.sourceHash
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

async function builtInGraphRunSourceFiles(
  compiledGraph: CompiledPlaybookGraph
): Promise<Record<string, string> | undefined> {
  const entry = await builtInGraphPlaybookByHash(
    compiledGraph.metadata.playbookId,
    compiledGraph.metadata.graphHash
  );
  if (!entry) return undefined;

  const sourceHash = hashPlaybookSourceFiles(entry.sourceFiles);
  if (sourceHash !== compiledGraph.metadata.sourceHash) {
    throw new Error("Built-in graph source files do not match compiled graph source hash");
  }
  return entry.sourceFiles;
}

async function graphRunCompiledGraphFromReference(
  input: {
    playbookId?: string | undefined;
    graphHash?: string | undefined;
    sourceHash?: string | undefined;
  },
  options: GraphRunHandlerOptions
): Promise<CompiledPlaybookGraph | undefined> {
  const playbookId = input.playbookId ?? "";
  const graphHash = input.graphHash ?? "";
  const sourceHash = input.sourceHash ?? "";
  if (!playbookId || !graphHash || !sourceHash) return undefined;

  const cache = createPlaybookGraphCache(options.cacheRoot ?? GRAPH_PLAYBOOK_CACHE_ROOT);
  const cachedSource = await cache.getSource(playbookId, graphHash, sourceHash);
  if (cachedSource) return cachedSource;

  const builtIn = await builtInGraphPlaybookByHash(playbookId, graphHash);
  return builtIn?.sourceHash === sourceHash ? builtIn.compiled : undefined;
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
    const scope = graphRunScopeFromRequest(req);
    const userKey = scope.ownerUserKey;
    if (
      scope.workspaceRoot &&
      parsed.data.workspaceRoot &&
      scope.workspaceRoot !== parsed.data.workspaceRoot
    ) {
      return Response.json(
        { error: "Graph run workspaceRoot must match the request scope" },
        { status: 409 }
      );
    }
    const workspaceRoot = parsed.data.workspaceRoot ?? scope.workspaceRoot ?? options.workspaceRoot;
    const graphPlaybooks = graphPlaybookRequestScope(req, {
      ...(options.installRoot ? { installRoot: options.installRoot } : {}),
      ...(options.cacheRoot ? { cacheRoot: options.cacheRoot } : {}),
      ...(options.graphPlaybookRegistryState ? { state: options.graphPlaybookRegistryState } : {}),
    });
    const graphPlaybookRuntimeOptions: GraphRunHandlerOptions = {
      ...options,
      installRoot: graphPlaybooks.installRoot,
      cacheRoot: graphPlaybooks.cacheRoot,
      graphPlaybookRegistryState: graphPlaybooks.state,
    };
    const agentProfile = profileForAgentId(parsed.data.agentId, userKey);
    const runtimeOptions = graphRunOptionsWithAgentRuntime(graphPlaybookRuntimeOptions, {
      agentProfile,
      ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
      ...(parsed.data.credential ? { credential: parsed.data.credential } : {}),
    });
    const provider = graphRunAgentProvider(runtimeOptions);
    const executionContext = graphRunExecutionContextWithAssignments(
      parsed.data.executionContext ??
        (provider
          ? graphRunAgentExecutionContext({
              agent: agentProfile,
              provider,
              ...(runtimeOptions.credential ? { credential: runtimeOptions.credential } : {}),
            })
          : undefined),
      parsed.data.assignmentPlan
    );
    const compiledGraph =
      parsed.data.compiledGraph ??
      (await graphRunCompiledGraphFromReference(parsed.data, graphPlaybookRuntimeOptions));
    if (!compiledGraph) {
      return Response.json({ error: "Unknown compiled graph" }, { status: 404 });
    }
    const sourceFiles =
      parsed.data.sourceFiles ??
      (await installedGraphRunSourceFiles(compiledGraph, graphPlaybookRuntimeOptions)) ??
      (await builtInGraphRunSourceFiles(compiledGraph));
    const platformContext = await graphRunPlatformContext({
      compiledGraph,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(parsed.data.styleGuideSelection ? { selection: parsed.data.styleGuideSelection } : {}),
    });

    const run = await createPlaybookGraphRun({
      compiledGraph,
      ...(sourceFiles ? { sourceFiles } : {}),
      ownerUserKey: scope.ownerUserKey,
      input: parsed.data.input,
      ...(platformContext ? { platformContext } : {}),
      ...(parsed.data.assignmentPlan ? { assignmentPlan: parsed.data.assignmentPlan } : {}),
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

    const detail = await graphRunDetail(run.runId, store, scope);
    if (!detail) return Response.json({ error: "Graph run was not persisted" }, { status: 500 });
    return Response.json(detail);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function handleGraphRunDrain(
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

  const parsed = PlaybookGraphRunDrainRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const store = options.store ?? graphRunStore;
    const scope = graphRunScopeFromRequest(req);
    const userKey = userKeyFromRequest(req);
    const run = await store.getRun(runId);
    if (!run || !graphRunMatchesScope(run, scope)) {
      return Response.json({ error: "Unknown graph run" }, { status: 404 });
    }
    const workspaceRoot =
      run.materialization?.kind === "workspace"
        ? run.materialization.workspaceRoot
        : options.workspaceRoot;
    const requestedAssignmentPlan = parsed.data.assignmentPlan;
    const assignmentPlan = requestedAssignmentPlan ?? run.assignmentPlan;
    const { agentProfile, pinnedAgentResolved } = graphRunAgentProfileForExistingRun({
      run,
      ...(userKey ? { userKey } : {}),
      ...(options.agentProfile ? { fallbackAgent: options.agentProfile } : {}),
    });
    const runtimeOptions = graphRunOptionsWithAssignmentPlan(
      graphRunOptionsWithAgentRuntime(options, {
        agentProfile,
        ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
        ...(parsed.data.credential ? { credential: parsed.data.credential } : {}),
      }),
      assignmentPlan
    );
    const runtimeProvider = graphRunAgentProvider(runtimeOptions);
    const activeExecutionContext = runtimeProvider
      ? graphRunAgentExecutionContext({
          agent: runtimeOptions.agentProfile ?? agentProfile,
          provider: runtimeProvider,
          ...(runtimeOptions.credential ? { credential: runtimeOptions.credential } : {}),
        })
      : options.executionContext;
    const baseExecutionContext =
      parsed.data.executionContext ??
      (pinnedAgentResolved
        ? (activeExecutionContext ?? run.executionContext?.fingerprints)
        : (run.executionContext?.fingerprints ?? activeExecutionContext));
    const executionContext = graphRunExecutionContextWithAssignments(
      baseExecutionContext,
      assignmentPlan
    );

    if (requestedAssignmentPlan) {
      await store.updateRun({
        ...run,
        assignmentPlan: requestedAssignmentPlan,
        updatedAt: graphRunNow(runtimeOptions),
      });
    }

    await maybeDrainGraphRun(
      runId,
      graphRunOptionsWithExecutionContext(
        graphRunOptionsWithWorkspaceRoot(runtimeOptions, workspaceRoot),
        executionContext
      )
    );

    const detail = await graphRunDetail(runId, store, scope);
    if (!detail) return Response.json({ error: "Unknown graph run" }, { status: 404 });
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
  const scope = graphRunScopeFromRequest(req);
  const status = searchParams.get("status") ?? undefined;
  const playbookId = searchParams.get("playbookId") ?? undefined;
  const limit = searchParams.has("limit")
    ? Number.parseInt(searchParams.get("limit") ?? "", 10)
    : undefined;
  const filter = PlaybookGraphRunListFilterSchema.safeParse({
    ownerUserKey: scope.ownerUserKey,
    ...(scope.workspaceRoot ? { workspaceRoot: scope.workspaceRoot } : {}),
    ...(playbookId ? { playbookId } : {}),
    ...(status ? { status } : {}),
    ...(limit !== undefined ? { limit } : {}),
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

  const detail = await graphRunDetail(
    runId,
    options.store ?? graphRunStore,
    graphRunScopeFromRequest(req)
  );
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

  const surface = await graphRunReviewSurface(
    runId,
    options.store ?? graphRunStore,
    options,
    graphRunScopeFromRequest(req)
  );
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
  const detail = await graphRunDetail(runId, store, graphRunScopeFromRequest(req));
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
  const detail = await graphRunDetail(runId, store, graphRunScopeFromRequest(req));
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
    declaredConsumesArtifacts:
      refreshed?.declaredConsumesArtifacts ?? entry.declaredConsumesArtifacts,
    consumesArtifacts: refreshed?.consumesArtifacts ?? entry.consumesArtifacts,
    artifactBindingState: refreshed?.artifactBindingState ?? entry.artifactBindingState,
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
    const scope = graphRunScopeFromRequest(req);
    const userKey = userKeyFromRequest(req);
    const run = await store.getRun(runId);
    if (!run || !graphRunMatchesScope(run, scope)) {
      return Response.json({ error: "Unknown graph run" }, { status: 404 });
    }
    const now = options.now ? options.now() : new Date().toISOString();
    const requestedAssignmentPlan = parsed.data.assignmentPlan;
    const assignmentPlan = requestedAssignmentPlan ?? run.assignmentPlan;
    const { agentProfile, pinnedAgentResolved } = graphRunAgentProfileForExistingRun({
      run,
      ...(userKey ? { userKey } : {}),
      ...(options.agentProfile ? { fallbackAgent: options.agentProfile } : {}),
    });
    const runtimeOptions = graphRunOptionsWithAssignmentPlan(
      graphRunOptionsWithAgentRuntime(options, {
        agentProfile,
        ...(parsed.data.agentProvider ? { agentProvider: parsed.data.agentProvider } : {}),
        ...(parsed.data.credential ? { credential: parsed.data.credential } : {}),
      }),
      assignmentPlan
    );
    const runtimeProvider = graphRunAgentProvider(runtimeOptions);
    const activeExecutionContext = runtimeProvider
      ? graphRunAgentExecutionContext({
          agent: runtimeOptions.agentProfile ?? agentProfile,
          provider: runtimeProvider,
          ...(runtimeOptions.credential ? { credential: runtimeOptions.credential } : {}),
        })
      : options.executionContext;
    const baseExecutionContext =
      parsed.data.executionContext ??
      (pinnedAgentResolved
        ? (activeExecutionContext ?? run.executionContext?.fingerprints)
        : (run.executionContext?.fingerprints ?? activeExecutionContext));
    const executionContext = graphRunExecutionContextWithAssignments(
      baseExecutionContext,
      assignmentPlan
    );

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
      const queue = await store.getQueue(runId);
      const resumeEntry = queue.find(
        (entry) =>
          (entry.status === "running" || entry.status === "interrupted") &&
          (!run.currentQueueEntryId || entry.queueEntryId === run.currentQueueEntryId)
      );
      if (resumeEntry) {
        mutation.queueEntries.push({
          ...resumeEntry,
          status: "queued",
          runtimeId: undefined,
          leaseId: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          blockedReason: undefined,
          error: undefined,
          completedAt: undefined,
          updatedAt: now,
        });
        affectedQueueEntryIds.add(resumeEntry.queueEntryId);
      }
      mutation.run = {
        ...run,
        status: "running",
        executionContext: createPlaybookGraphExecutionContextPin(executionContext),
        currentQueueEntryId: resumeEntry?.queueEntryId ?? run.currentQueueEntryId,
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
    } else if (
      parsed.data.decision === "retry_interrupted" ||
      parsed.data.decision === "retry_needs_attention"
    ) {
      const queue = await store.getQueue(runId);
      const retryableStatus =
        parsed.data.decision === "retry_needs_attention" ? "needs_attention" : "interrupted";
      const retryable = queue.find(
        (entry) =>
          entry.status === retryableStatus &&
          (!parsed.data.queueEntryId || entry.queueEntryId === parsed.data.queueEntryId)
      );
      if (!retryable) {
        return Response.json(
          { error: `No ${retryableStatus} queue entry to retry` },
          { status: 409 }
        );
      }
      mutation.queueEntries.push({
        ...retryable,
        status: "queued",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        attentionEvidence: {
          ...(retryable.attentionEvidence ?? {
            code: "ambiguous_recovery" as const,
            reason: retryable.blockedReason ?? "Retry requested for recoverable graph work.",
            observedAt: now,
            recoveryDecision: "retry_requested" as const,
          }),
          recoveryDecision: "retry_requested" as const,
        },
        updatedAt: now,
        blockedReason: undefined,
        error: undefined,
        completedAt: undefined,
      });
      affectedQueueEntryIds.add(retryable.queueEntryId);
      mutation.run = {
        ...run,
        status: "running",
        currentQueueEntryId: retryable.queueEntryId,
        ...(executionContext !== undefined
          ? { executionContext: createPlaybookGraphExecutionContextPin(executionContext) }
          : {}),
        blockedReason: undefined,
        repairReason: undefined,
        error: undefined,
        completedAt: undefined,
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

    if (requestedAssignmentPlan) {
      mutation.run = {
        ...(mutation.run ?? run),
        assignmentPlan: requestedAssignmentPlan,
        updatedAt: mutation.run?.updatedAt ?? now,
      };
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

    const detail = await graphRunDetail(runId, store, scope);
    if (!detail) return Response.json({ error: "Unknown graph run" }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

interface PlaybookCatalogHandlerOptions {
  installRoot?: string;
  cacheRoot?: string;
  state?: GraphPlaybookRegistryState;
  catalogState?: GraphPlaybookRegistryState;
}

interface PlaybookRunPreferenceHandlerOptions {
  store?: PlaybookRunPreferenceStore;
}

function shouldRefreshGraphPlaybookCatalog(
  options: PlaybookCatalogHandlerOptions,
  catalogState: GraphPlaybookRegistryState
): boolean {
  if (options.catalogState !== undefined && options.state === undefined) {
    return options.installRoot !== undefined || options.cacheRoot !== undefined;
  }
  return (
    options.state !== undefined ||
    options.installRoot !== undefined ||
    options.cacheRoot !== undefined ||
    !catalogState.loaded
  );
}

export async function handlePlaybookList(
  req: Request,
  options: PlaybookCatalogHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const graphPlaybooks = graphPlaybookRequestScope(req, options);
  if (shouldRefreshGraphPlaybookCatalog(options, graphPlaybooks.catalogState)) {
    await refreshInstalledGraphPlaybookRegistry({
      installRoot: graphPlaybooks.installRoot,
      cacheRoot: graphPlaybooks.cacheRoot,
      state: graphPlaybooks.state,
      catalogState: graphPlaybooks.catalogState,
    });
  }
  const builtIns = await builtInGraphPlaybooks();
  const imported = await importedGraphPlaybookCatalog({ state: graphPlaybooks.catalogState });
  return Response.json(
    PlaybookListResultSchema.parse({
      playbooks: [
        ...builtIns.map((entry) => graphPlaybookSummary(entry)),
        ...imported.map((entry) => graphPlaybookSummary(entry)),
      ],
    })
  );
}

export async function handlePlaybookGet(
  req: Request,
  playbookId: string,
  options: PlaybookCatalogHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const graphPlaybooks = graphPlaybookRequestScope(req, options);
  const entry = await builtInGraphPlaybook(playbookId);
  if (
    entry === undefined &&
    shouldRefreshGraphPlaybookCatalog(options, graphPlaybooks.catalogState)
  ) {
    await refreshInstalledGraphPlaybookRegistry({
      installRoot: graphPlaybooks.installRoot,
      cacheRoot: graphPlaybooks.cacheRoot,
      state: graphPlaybooks.state,
      catalogState: graphPlaybooks.catalogState,
    });
  }
  const imported =
    entry === undefined
      ? await importedGraphPlaybookById(playbookId, graphPlaybooks.catalogState, {
          includeSourceFiles: true,
        })
      : undefined;
  const projection = entry ?? imported;
  if (!projection) return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  return Response.json(graphPlaybookDetail(projection));
}

export async function handlePlaybookRunPreferenceRead(
  req: Request,
  playbookId: string,
  options: PlaybookRunPreferenceHandlerOptions = {}
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = PlaybookRunPreferenceReadRequestSchema.safeParse({
    workspaceRoot: searchParams.get("workspaceRoot") ?? "",
  });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const preference = (options.store ?? playbookRunPreferenceStore).get({
    ownerUserKey: userKeyFromRequest(req) ?? LOCAL_GRAPH_RUN_OWNER_KEY,
    workspaceRoot: parsed.data.workspaceRoot,
    playbookId,
  });
  return Response.json(PlaybookRunPreferenceReadResultSchema.parse({ preference }));
}

export async function handlePlaybookRunPreferenceSave(
  req: Request,
  playbookId: string,
  options: PlaybookRunPreferenceHandlerOptions = {}
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

  const parsed = PlaybookRunPreferenceSaveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const preference = (options.store ?? playbookRunPreferenceStore).save({
    ownerUserKey: userKeyFromRequest(req) ?? LOCAL_GRAPH_RUN_OWNER_KEY,
    workspaceRoot: parsed.data.workspaceRoot,
    playbookId,
    assignmentPlan: parsed.data.assignmentPlan,
  });
  return Response.json(PlaybookRunPreferenceSchema.parse(preference));
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
  const result = InboxListResultSchema.parse({
    messages: inboxStore.list({
      status: parsedStatus.data,
      ...(parsedType?.success ? { type: parsedType.data } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(taskId ? { taskId } : {}),
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
    const userKey = userKeyFromRequest(req);
    const invocation = await parseSkillInvocation({
      text: parsed.data.initialInstruction,
      workspaceRoot: parsed.data.workspaceRoot,
      agentId: parsed.data.agentId,
      userKey,
    });
    const taskInput = {
      ...parsed.data,
      initialInstruction: invocation.originalContent,
    };
    let execution = parsed.data.execution;
    if (execution && taskInput.agentId !== "default") {
      const profile = agentProfileStoreForUserKey(userKey).get(taskInput.agentId);
      if (profile) {
        execution = {
          ...execution,
          agent: profile,
          runtime: compileAgentRuntimeContext(profile),
        };
      }
    } else if (execution) {
      const agent = defaultAgentProfile(userKey);
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
        memory: memoryManagerForUserKey(userKey),
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
    const userKey = userKeyFromRequest(req);
    const task = taskStore.getTask(taskId);
    if (!task) return Response.json({ error: "Unknown task" }, { status: 404 });
    const invocation = await parseSkillInvocation({
      text: parsed.data.content,
      workspaceRoot: task.workspaceRoot,
      agentId: parsed.data.agentId,
      userKey,
    });
    const turnInput = {
      ...parsed.data,
      content: invocation.originalContent,
    };
    let execution = parsed.data.execution;
    if (execution && turnInput.agentId !== "default") {
      const profile = agentProfileStoreForUserKey(userKey).get(turnInput.agentId);
      if (profile) {
        execution = {
          ...execution,
          agent: profile,
          runtime: compileAgentRuntimeContext(profile),
        };
      }
    } else if (execution) {
      const agent = defaultAgentProfile(userKey);
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
        memory: memoryManagerForUserKey(userKey),
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
  const userKey = userKeyFromRequest(req);
  const store = agentProfileStoreForUserKey(userKey);

  const result = {
    profiles: [
      defaultAgentProfile(userKey),
      ...store.list().filter((profile) => profile.id !== "default"),
    ],
  };
  return Response.json(result);
}

function handleAgentProfileGet(req: Request, id: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const userKey = userKeyFromRequest(req);
  const store = agentProfileStoreForUserKey(userKey);

  const profile = id === "default" ? defaultAgentProfile(userKey) : store.get(id);
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
    const profile = agentProfileStoreForUserKey(userKeyFromRequest(req)).create(parsed.data);
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

  const userKey = userKeyFromRequest(req);
  const store = agentProfileStoreForUserKey(userKey);
  const profile =
    id === "default"
      ? store.updateDefault(DEFAULT_AGENT_PROFILE, parsed.data)
      : store.update(id, parsed.data);
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

  agentProfileStoreForUserKey(userKeyFromRequest(req)).resetDefault();
  return Response.json(DEFAULT_AGENT_PROFILE);
}

function handleAgentProfileDelete(req: Request, id: string): Response {
  if (req.method !== "DELETE") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (id === "default") {
    return Response.json({ error: "The default agent profile cannot be deleted" }, { status: 400 });
  }

  const deleted = agentProfileStoreForUserKey(userKeyFromRequest(req)).delete(id);
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
    const userKey = userKeyFromRequest(req);
    const registry = skillRegistryForUrl(req);
    return Response.json({
      skills: await registry.listSkills(
        agentId ? { allowedSkillIds: allowedSkillIdsForAgent(agentId, userKey) } : undefined
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
    const userKey = userKeyFromRequest(req);
    const registry = createTesseraSkillRegistry({ workspaceRoot: task.workspaceRoot });
    const allowedSkillIds = allowedSkillIdsForAgent(task.agentId, userKey);
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
  const ownerId = memoryOwnerIdForUserKey(userKeyFromRequest(req));
  const workspaceKey = url.searchParams.get("workspaceKey") ?? undefined;
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 24;
  const result = MemoryReviewListResultSchema.parse({
    active: store.listActiveMemories({
      ...(workspaceKey ? { workspaceKey } : {}),
      ownerId,
      limit,
    }),
    candidates: store.listCandidateMemories({
      ...(workspaceKey ? { workspaceKey } : {}),
      ownerId,
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
  const ownerId = memoryOwnerIdForUserKey(userKeyFromRequest(req));
  if (memory.ownerId !== ownerId) {
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
  const ownerId = memoryOwnerIdForUserKey(userKeyFromRequest(req));
  const memory = store.getMemoryById(parsed.data.memoryId);
  if (!memory || memory.ownerId !== ownerId) {
    return Response.json({ error: "Unknown memory" }, { status: 404 });
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

    if (pathname === "/graph-playbooks/import") {
      return handleGraphPlaybookImport(req);
    }

    if (pathname === "/graph-runs") {
      if (req.method === "GET") return handleGraphRunList(req);
      return handleGraphRunCreate(req);
    }

    if (pathname === "/workspace/style-guide") {
      if (req.method === "GET") return handleWorkspaceStyleGuideRead(req);
      return handleWorkspaceStyleGuideSave(req);
    }

    const graphRunDrainMatch = pathname.match(/^\/graph-runs\/([^/]+)\/drain$/);
    const graphRunDrainId = graphRunDrainMatch?.[1];
    if (graphRunDrainId) {
      return handleGraphRunDrain(req, decodeURIComponent(graphRunDrainId));
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

    if (pathname === "/playbooks") {
      return handlePlaybookList(req);
    }

    const playbookRunPreferenceMatch = pathname.match(/^\/playbooks\/([^/]+)\/run-preference$/);
    const playbookRunPreferenceId = playbookRunPreferenceMatch?.[1];
    if (playbookRunPreferenceId) {
      const decodedPlaybookId = decodeURIComponent(playbookRunPreferenceId);
      if (req.method === "GET") {
        return handlePlaybookRunPreferenceRead(req, decodedPlaybookId);
      }
      return handlePlaybookRunPreferenceSave(req, decodedPlaybookId);
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
