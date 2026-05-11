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
export { createWorkspaceToolDefinitions } from "./workspace-tools.js";
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
  DEMO_WORKFLOW,
  CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW,
  SALES_MEETING_BRIEF_WORKFLOW,
  WEEKLY_UPDATE_WORKFLOW,
  WEEKLY_STATUS_DIGEST_WORKFLOW,
  resumeWorkflowRun,
  runDemoWorkflow,
  runWorkflow,
  type ResumeWorkflowRunOptions,
  type RunDemoWorkflowOptions,
  type RunWorkflowOptions,
} from "./workflow.js";
export { loadPlaybookManifest } from "./playbook-loader.js";
export type { LoadPlaybookManifestOptions } from "./playbook-loader.js";
