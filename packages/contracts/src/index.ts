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

export const ModelProviderSchema = z.enum(["openai", "anthropic", "openrouter", "local"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

const OpenAIModelProviderSettingsSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const AnthropicModelProviderSettingsSchema = z.object({
  provider: z.literal("anthropic"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const OpenRouterModelProviderSettingsSchema = z.object({
  provider: z.literal("openrouter"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const LocalModelProviderSettingsSchema = z.object({
  provider: z.literal("local"),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  hasCredential: z.boolean().default(false),
});

export const ModelProviderSettingsSchema = z.discriminatedUnion("provider", [
  OpenAIModelProviderSettingsSchema,
  AnthropicModelProviderSettingsSchema,
  OpenRouterModelProviderSettingsSchema,
  LocalModelProviderSettingsSchema,
]);
export type ModelProviderSettings = z.infer<typeof ModelProviderSettingsSchema>;

export const ModelSettingsReadSchema = z.object({
  selectedProvider: ModelProviderSchema,
  providers: z.object({
    openai: OpenAIModelProviderSettingsSchema,
    anthropic: AnthropicModelProviderSettingsSchema,
    openrouter: OpenRouterModelProviderSettingsSchema,
    local: LocalModelProviderSettingsSchema,
  }),
});
export type ModelSettingsRead = z.infer<typeof ModelSettingsReadSchema>;

export const ModelSettingsSaveRequestSchema = z
  .object({
    selectedProvider: ModelProviderSchema,
    provider: AgentProviderConfigSchema,
    credential: z
      .object({
        apiKey: z.string().min(1),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.selectedProvider !== value.provider.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectedProvider must match provider.provider",
        path: ["provider"],
      });
    }
  });
export type ModelSettingsSaveRequest = z.infer<typeof ModelSettingsSaveRequestSchema>;

export const ModelCredentialDeleteRequestSchema = z.object({
  provider: ModelProviderSchema,
});
export type ModelCredentialDeleteRequest = z.infer<typeof ModelCredentialDeleteRequestSchema>;

export const ModelConnectionTestRequestSchema = z.object({
  provider: AgentProviderConfigSchema,
  credential: z
    .object({
      apiKey: z.string().min(1),
    })
    .optional(),
});
export type ModelConnectionTestRequest = z.infer<typeof ModelConnectionTestRequestSchema>;

export const ModelConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type ModelConnectionTestResult = z.infer<typeof ModelConnectionTestResultSchema>;

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
  credential: z
    .object({
      apiKey: z.string().min(1),
    })
    .optional(),
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

export const WorkflowAgentStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  kind: z.literal("agent"),
  prompt: z.string().min(1),
  workspaceRootInput: z.string().min(1).default("workspaceRoot"),
  onSuccess: z.string().min(1).optional(),
  onFailure: z.string().min(1).optional(),
});

export type WorkflowAgentStep = z.infer<typeof WorkflowAgentStepSchema>;
export type WorkflowStep = WorkflowToolStep | WorkflowAgentStep;

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.record(WorkflowInputDefinitionSchema).default({}),
  start: z.string().min(1),
  steps: z
    .array(z.discriminatedUnion("kind", [WorkflowToolStepSchema, WorkflowAgentStepSchema]))
    .min(1),
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

export const AgentModelSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("override"), provider: AgentProviderConfigSchema }).strict(),
]);
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>;

export const AgentProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    model: AgentModelSelectionSchema,
    instructions: z.string().optional(),
    soul: z.string().optional(),
    skills: z.array(z.string().min(1)).default([]),
    tools: z.array(z.string().min(1)).default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const TaskExecutionConfigSchema = z.object({
  agent: AgentProfileSchema,
  provider: AgentProviderConfigSchema,
  credential: z.object({ apiKey: z.string().min(1) }).optional(),
});
export type TaskExecutionConfig = z.infer<typeof TaskExecutionConfigSchema>;

export const TaskCreateRequestSchema = z.object({
  workspaceRoot: z.string().min(1),
  initialInstruction: z.string().min(1),
  description: z.string().optional(),
  agentId: z.string().min(1).default("default"),
  agentLabel: z.string().min(1).default("Tessera"),
  execution: TaskExecutionConfigSchema.optional(),
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
  agentId: z.string().min(1).default("default"),
  execution: TaskExecutionConfigSchema.optional(),
});
export type TaskCreateTurnRequest = z.infer<typeof TaskCreateTurnRequestSchema>;

export const TaskEventTypeSchema = z.enum([
  "task.updated",
  "turn.created",
  "turn.status_changed",
  "turn.completed",
  "artifact.created",
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

const TaskEventBase = z.object({
  taskId: z.string().min(1),
  emittedAt: z.string().datetime(),
});

export const TaskUpdatedEventSchema = TaskEventBase.extend({
  type: z.literal("task.updated"),
  task: TaskSummarySchema,
});
export const TurnCreatedEventSchema = TaskEventBase.extend({
  type: z.literal("turn.created"),
  turn: TaskTurnSchema,
});
export const TurnStatusChangedEventSchema = TaskEventBase.extend({
  type: z.literal("turn.status_changed"),
  turn: TaskTurnSchema,
});
export const TurnCompletedEventSchema = TaskEventBase.extend({
  type: z.literal("turn.completed"),
  turn: TaskTurnSchema,
});
export const ArtifactCreatedEventSchema = TaskEventBase.extend({
  type: z.literal("artifact.created"),
  artifact: TaskArtifactSchema,
});

export const TaskEventSchema = z.discriminatedUnion("type", [
  TaskUpdatedEventSchema,
  TurnCreatedEventSchema,
  TurnStatusChangedEventSchema,
  TurnCompletedEventSchema,
  ArtifactCreatedEventSchema,
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;
