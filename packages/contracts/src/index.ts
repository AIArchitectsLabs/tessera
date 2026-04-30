import { z } from "zod";

// IPC envelope — all messages between frontend and sidecar use this shape.
export const IpcEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

export type IpcEnvelope = z.infer<typeof IpcEnvelopeSchema>;

// Sidecar reports its connection info to the Rust shell on stdout at boot.
export const SidecarReadySchema = z.discriminatedUnion("transport", [
  z.object({
    type: z.literal("ready"),
    transport: z.literal("unix"),
    path: z.string(),
    token: z.string(),
  }),
  z.object({
    type: z.literal("ready"),
    transport: z.literal("tcp"),
    port: z.number(),
    token: z.string(),
  }),
]);

export type SidecarReady = z.infer<typeof SidecarReadySchema>;

// Spawn a registered CLI binary via the sidecar.
export const SpawnRequestSchema = z.object({
  binary: z.enum(["workspace-cli"]),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export const SpawnResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  signal: z.string().nullable(),
  durationMs: z.number().nonnegative(),
});

export type SpawnResult = z.infer<typeof SpawnResultSchema>;

export const AgentProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("openai"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
  }),
  z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("ANTHROPIC_API_KEY"),
  }),
  z.object({
    provider: z.literal("openrouter"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENROUTER_API_KEY"),
  }),
  z.object({
    provider: z.literal("local"),
    model: z.string().min(1),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1).optional(),
  }),
]);

export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>;

export const ToolCapabilitySchema = z.enum(["read", "write"]);
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

export const ToolRiskSchema = z.object({
  mutates: z.boolean(),
  destructive: z.boolean(),
  external: z.boolean(),
  reversible: z.boolean(),
  dryRunSupported: z.boolean(),
});

export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const PermissionGrantSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    toolId: z.string().min(1),
  }),
  z.object({
    type: z.literal("exact"),
    toolId: z.string().min(1),
    args: z.record(z.unknown()),
  }),
]);

export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const PermissionDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("allow"),
    toolId: z.string(),
    reason: z.string(),
  }),
  z.object({
    decision: z.literal("ask"),
    toolId: z.string(),
    reason: z.string(),
    approval: z.object({
      toolId: z.string(),
      args: z.record(z.unknown()),
      capability: ToolCapabilitySchema,
      risk: ToolRiskSchema,
      preview: z.string(),
      reasonCode: z.string(),
    }),
  }),
  z.object({
    decision: z.literal("deny"),
    toolId: z.string(),
    reason: z.string(),
  }),
]);

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const AgentTurnRequestSchema = z.object({
  prompt: z.string().min(1),
  provider: AgentProviderConfigSchema,
  grants: z.array(PermissionGrantSchema).default([]),
  timeoutMs: z.number().int().positive().max(120_000).default(60_000),
});

export type AgentTurnRequest = z.infer<typeof AgentTurnRequestSchema>;

export const AgentMessageSummarySchema = z.object({
  role: z.string(),
  text: z.string().optional(),
});

export type AgentMessageSummary = z.infer<typeof AgentMessageSummarySchema>;

export const AgentToolResultSummarySchema = z.object({
  toolId: z.string(),
  status: z.enum(["success", "error", "blocked"]),
  text: z.string(),
  details: z.unknown().optional(),
});

export type AgentToolResultSummary = z.infer<typeof AgentToolResultSummarySchema>;

export const AgentTurnResultSchema = z.object({
  status: z.enum(["completed", "blocked", "denied", "error"]),
  messages: z.array(AgentMessageSummarySchema),
  toolResults: z.array(AgentToolResultSummarySchema),
  permissionDecisions: z.array(PermissionDecisionSchema),
  error: z.string().optional(),
});

export type AgentTurnResult = z.infer<typeof AgentTurnResultSchema>;

export const WorkflowInputDefinitionSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
});

export type WorkflowInputDefinition = z.infer<typeof WorkflowInputDefinitionSchema>;

export const WorkflowToolStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  kind: z.literal("tool"),
  toolId: z.enum(["workspace.ping", "workspace.writeProbe"]),
  args: z.record(z.unknown()).default({}),
  onSuccess: z.string().min(1).optional(),
  onFailure: z.string().min(1).optional(),
});

export type WorkflowToolStep = z.infer<typeof WorkflowToolStepSchema>;
export type WorkflowStep = WorkflowToolStep;

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.record(WorkflowInputDefinitionSchema).default({}),
  start: z.string().min(1),
  steps: z.array(WorkflowToolStepSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WorkflowRunRequestSchema = z.object({
  workflowId: z.string().min(1).default("demo.write-approval"),
  input: z.record(z.unknown()).default({}),
});

export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequestSchema>;

export const WorkflowRunResultSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  status: z.enum(["running", "blocked", "completed", "denied", "failed"]),
  currentStepId: z.string().optional(),
  input: z.record(z.unknown()).default({}),
  outputs: z.record(z.unknown()).optional(),
  approval: PermissionDecisionSchema.options[1].shape.approval.optional(),
  error: z.string().optional(),
});

export type WorkflowRunResult = z.infer<typeof WorkflowRunResultSchema>;

export const WorkflowRunListResultSchema = z.object({
  runs: z.array(WorkflowRunResultSchema),
});

export type WorkflowRunListResult = z.infer<typeof WorkflowRunListResultSchema>;

export const WorkflowResumeRequestSchema = z.object({
  runId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});

export type WorkflowResumeRequest = z.infer<typeof WorkflowResumeRequestSchema>;

export const TaskStatusSchema = z.enum(["active", "waiting", "done", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskTurnRoleSchema = z.enum(["user", "agent", "system"]);
export type TaskTurnRole = z.infer<typeof TaskTurnRoleSchema>;

export const TaskTurnStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export type TaskTurnStatus = z.infer<typeof TaskTurnStatusSchema>;

export const TaskTurnSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  role: TaskTurnRoleSchema,
  content: z.string().min(1),
  status: TaskTurnStatusSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type TaskTurn = z.infer<typeof TaskTurnSchema>;

export const TaskArtifactSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  kind: z.enum(["text", "file"]),
  title: z.string().min(1),
  path: z.string().min(1).optional(),
  contentPreview: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

export const TaskSummarySchema = z.object({
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema,
  agentLabel: z.string().min(1).optional(),
  latestActivity: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskDetailSchema = TaskSummarySchema.extend({
  description: z.string().optional(),
  turns: z.array(TaskTurnSchema),
  artifacts: z.array(TaskArtifactSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const TaskListResultSchema = z.object({
  tasks: z.array(TaskSummarySchema),
});
export type TaskListResult = z.infer<typeof TaskListResultSchema>;

export const TaskCreateRequestSchema = z.object({
  workspaceRoot: z.string().min(1),
  initialInstruction: z.string().min(1),
  description: z.string().optional(),
  agentLabel: z.string().min(1).default("Tessera"),
});
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>;

export const TaskUpdateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  status: TaskStatusSchema.optional(),
  latestActivity: z.string().optional(),
});
export type TaskUpdateRequest = z.infer<typeof TaskUpdateRequestSchema>;

export const TaskCreateTurnRequestSchema = z.object({
  content: z.string().min(1),
});
export type TaskCreateTurnRequest = z.infer<typeof TaskCreateTurnRequestSchema>;
