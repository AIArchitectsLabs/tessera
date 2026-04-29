// Agent/MCP runtime logic — consumed by apps/sidecar and apps/cli only.
// Never import this package from apps/desktop/ui.

export const CORE_VERSION = "0.1.0";

export { executeAgentTurn, type ExecuteAgentTurnOptions } from "./agent.js";
export { createAgentModel, resolveApiKey } from "./model.js";
export { evaluatePermission, type PermissionRequest } from "./permission.js";
export {
  createTesseraTools,
  summarizeToolResult,
  toolNameToId,
  type WorkspaceCliExecutor,
} from "./tools.js";
export {
  resumeWorkflowRun,
  runDemoWorkflow,
  type ResumeWorkflowRunOptions,
  type RunDemoWorkflowOptions,
} from "./workflow.js";
