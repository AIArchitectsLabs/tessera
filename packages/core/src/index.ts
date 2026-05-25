// Agent/MCP runtime logic — consumed by apps/sidecar and apps/cli only.
// Never import this package from apps/desktop/ui.

export const CORE_VERSION = "0.1.0";

export { executeAgentTurn, type ExecuteAgentTurnOptions } from "./agent.js";
export {
  buildBrowserRecipeProposal,
  type BrowserRecipeActionInput,
  type BuildBrowserRecipeProposalInput,
} from "./browser-recipes.js";
export { resolveBinding } from "./dashboard-layout.js";
export { createAgentModel, resolveApiKey } from "./model.js";
export {
  executeWebSearch,
  type ExecuteWebSearchOptions,
  type WebSearchRuntime,
} from "./web-search.js";
export {
  createTesseraModelRegistry,
  runPiTaskTurn,
  type PiSessionFactory,
  type PiSessionFactoryOptions,
  type PiSessionLike,
  type PiTaskTurnResult,
  type RunPiTaskTurnOptions,
} from "./pi-session.js";
export { createTaskToolDefinitions, type TaskToolRuntime } from "./task-tools.js";
export { evaluatePermission, type PermissionRequest } from "./permission.js";
export {
  CLI_CATALOG,
  findCliCommand,
  formatCliCatalogLine,
  formatShellPreview,
} from "./cli-catalog.js";
export {
  createSpawnShellExecutor,
  ShellExecutionError,
  ShellValidationError,
  validateShellCall,
} from "./shell-runtime.js";
export {
  type BrowserExecutor,
  createTesseraTools,
  type ShellExecutor,
  summarizeToolResult,
  toolNameToId,
  type WorkspaceCliExecutor,
} from "./tools.js";
export {
  createWorkspaceGuard,
  WorkspaceBoundaryError,
  type WorkspaceGuard,
} from "./workspace-guard.js";
export {
  defaultWorkspaceConfig,
  readWorkspaceConfig,
  saveWorkspaceConfig,
  WorkspaceConfigConflictError,
  workspaceConfigRelativePath,
} from "./workspace-config.js";
export {
  createGraphGitMilestoneService,
  type GitServiceCommandInput,
  type GitServiceCommandResult,
  type GitServiceCommandRunner,
  type GraphGitMilestonePreviewInput,
  type GraphGitMilestoneServiceOptions,
} from "./git-service.js";
export { createPdfToolDefinitions } from "./pdf-tools.js";
export {
  createOptionalCapabilityManager,
  optionalCapabilityDefinitionsFromEnv,
  type OptionalCapabilityAsset,
  type OptionalCapabilityBinary,
  type OptionalCapabilityDefinition,
  type OptionalCapabilityEnv,
  type OptionalCapabilityInstallOptions,
  type OptionalCapabilityInstallPhase,
  type OptionalCapabilityInstallProgress,
  type OptionalCapabilityInstallResult,
  type OptionalCapabilityManager,
  type OptionalCapabilityManagerOptions,
  type OptionalCapabilityStatus,
} from "./optional-capabilities.js";
export {
  createPythonSkillRuntime,
  type PythonSkillCommandInput,
  type PythonSkillCommandResult,
  type PythonSkillCommandRunner,
  type PythonSkillRunInput,
  type PythonSkillRunResult,
  type PythonSkillRunnerCommand,
  type PythonSkillRuntime,
  type PythonSkillRuntimeOptions,
} from "./python-skill-runtime.js";
export {
  createPdfDocument,
  extractPdfText,
  getPdfCapabilities,
  inspectPdfDocument,
  normalizePdfPageRange,
  renderPdfPages,
  transformPdfDocument,
  validatePdfDocument,
  writePdfPacketManifest,
  type BinaryRunner,
  type BinaryRunnerInput,
  type BinaryRunnerResult,
  type PdfCapabilitiesOptions,
  type PdfCreateBlock,
  type PdfCreateOptions,
  type PdfDocumentOptions,
  type PdfExtractOptions,
  type PdfImageDimensions,
  type PdfImageDimensionsReader,
  type PdfPacketManifestOptions,
  type PdfRenderOptions,
  type PdfTransformOptions,
  type PdfTransformSource,
  type PdfValidateOptions,
} from "./pdf-service.js";
export { createWorkspaceToolDefinitions } from "./workspace-tools.js";
export {
  classifyMemoryContent,
  formatMemoryContext,
  memoryContentHash,
  sanitizeMemoryText,
  workspaceKeyForRoot,
  type ClassifiedMemoryContent,
  type FormatMemoryContextOptions,
  type MemoryProvider,
} from "./memory.js";
export {
  DEFAULT_AGENT_PROFILE,
  resolveTaskExecutionConfig,
} from "./task-model-resolution.js";
export {
  createSkillRegistry,
  resolveSlashSkillInvocation,
  type SkillEligibility,
  type SkillRegistry,
  type SkillRegistryOptions,
} from "./skills.js";
export {
  hashPlaybookGraph,
  hashPlaybookSourceFiles,
  stableJsonStringify,
  validatePlaybookGraph,
} from "./playbook-graph.js";
export {
  compilePlaybookGraph,
  type CompilePlaybookGraphOptions,
} from "./playbook-graph-compiler.js";
export {
  resolvePlaybookGraphPreflight,
  type ResolvePlaybookGraphPreflightOptions,
} from "./playbook-graph-preflight.js";
export {
  createPlaybookGraphCache,
  type PlaybookGraphCache,
} from "./playbook-graph-cache.js";
export {
  assertPackageRelativePath,
  readPlaybookGraphPackage,
  type PlaybookGraphPackageFiles,
} from "./playbook-graph-package.js";
export {
  loadGraphPlaybookPackage,
  type LoadGraphPlaybookPackageOptions,
  type LoadedGraphPlaybookPackage,
} from "./playbook-graph-package-loader.js";
export {
  installGraphPlaybookPackage,
  type InstallGraphPlaybookPackageOptions,
  type InstalledGraphPlaybookPackage,
} from "./playbook-graph-package-installer.js";
export {
  BUILTIN_GRAPH_PLAYBOOK_ROOTS,
  loadBuiltInGraphPlaybookPackages,
} from "./builtin-graph-playbooks.js";
export {
  createGraphNodeMemoKeyParts,
  createPlaybookGraphExecutionContextPin,
  createPlaybookGraphQueueEntry,
  createPlaybookGraphMemoKey,
  createPlaybookGraphRun,
  createPlaybookGraphSnapshot,
  childPlaybookGraphNodePath,
  drainPlaybookGraphRun,
  hardTimeoutMs,
  heartbeatCadenceMs,
  HEARTBEAT_STALENESS_MS,
  isQueueDependencySatisfied,
  parsePinnedCompiledGraph,
  playbookGraphExecutionContextDriftReason,
  softTimeoutMs,
  type CreatePlaybookGraphRunOptions,
  type GraphRunStore,
  type PlaybookGraphAgentAdapterInput,
  type PlaybookGraphArtifactWriteAdapterInput,
  type PlaybookGraphEffectAdapterInput,
  type PlaybookGraphEffectAdapterResult,
  type PlaybookGraphEffectExecutionPolicy,
  type PlaybookGraphRuntimeOptions,
  type PlaybookGraphRuntimeResult,
  type PlaybookGraphScriptAdapterInput,
  type PlaybookGraphToolAdapterInput,
  type PlaybookGraphToolExecutionPolicy,
} from "./playbook-graph-runtime.js";
