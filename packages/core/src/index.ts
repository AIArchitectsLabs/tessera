// Agent/MCP runtime logic — consumed by apps/sidecar and apps/cli only.
// Never import this package from apps/desktop/ui.

export const CORE_VERSION = "0.1.0";

export { executeAgentTurn, type ExecuteAgentTurnOptions } from "./agent.js";
export { createAgentModel, resolveApiKey } from "./model.js";
export {
  createTesseraModelRegistry,
  runPiTaskTurn,
  type PiSessionFactory,
  type PiSessionFactoryOptions,
  type PiSessionLike,
  type PiTaskTurnResult,
  type RunPiTaskTurnOptions,
} from "./pi-session.js";
export { evaluatePermission, type PermissionRequest } from "./permission.js";
export {
  createTesseraTools,
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
  DEMO_WORKFLOW,
  loadWorkflowDefinition,
  resumeWorkflowRun,
  runDemoWorkflow,
  runWorkflow,
  type ResumeWorkflowRunOptions,
  type RunDemoWorkflowOptions,
  type RunWorkflowOptions,
} from "./workflow.js";
