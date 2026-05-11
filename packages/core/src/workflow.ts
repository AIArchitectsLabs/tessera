import type {
  AgentProviderConfig,
  PermissionDecision,
  PermissionGrant,
  WorkflowInputDefinition,
  WorkflowRunEvent,
  WorkflowRunResult,
  WorkflowRunStepRecord,
} from "@tessera/contracts";
import { createActor, createMachine } from "xstate";
import { type PiTaskTurnResult, runPiTaskTurn } from "./pi-session.js";
import { DEFAULT_AGENT_PROFILE } from "./task-model-resolution.js";
import { type WorkspaceCliExecutor, createTesseraTools } from "./tools.js";
import {
  type WorkflowCapabilityInventory,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowExecutionStepRecord,
  type WorkflowNodeRequirements,
  type WorkflowRunAssignmentPlan,
  WorkflowRunAssignmentPlanSchema,
  type WorkflowSourceGap,
  type WorkflowStep,
  createWorkflowCapabilityInventory,
  extractWorkflowAssignmentPlan,
  resolveWorkflowAssignmentPlan,
  validateWorkflowAssignmentPlan,
  workflowCapabilityRefs,
} from "./workflow-capabilities.js";
export {
  WorkflowCapabilityInventorySchema,
  WorkflowRunAssignmentPlanSchema,
} from "./workflow-capabilities.js";
import customerRenewalRiskReviewManifest from "./builtin-playbooks/customer.renewal-risk-review/manifest.json";
import customerRenewalRiskReviewDraft from "./builtin-playbooks/customer.renewal-risk-review/prompts/draft-risk-review.md" with {
  type: "text",
};
import demoWriteApprovalManifest from "./builtin-playbooks/demo.write-approval/manifest.json";
import operationsWeeklyStatusDigestManifest from "./builtin-playbooks/ops.weekly-status-digest/manifest.json";
import operationsWeeklyStatusDigestDraft from "./builtin-playbooks/ops.weekly-status-digest/prompts/draft-status-digest.md" with {
  type: "text",
};
import opsWeeklyUpdateManifest from "./builtin-playbooks/ops.weekly-update/manifest.json";
import salesMeetingBriefManifest from "./builtin-playbooks/sales.meeting-brief/manifest.json";
import salesMeetingBriefDraftBrief from "./builtin-playbooks/sales.meeting-brief/prompts/draft-brief.md" with {
  type: "text",
};
import { loadPlaybookManifest } from "./playbook-loader.js";
import { createSpawnShellExecutor } from "./shell-runtime.js";
import { TERMINAL_STEPS } from "./workflow-constants.js";

type WorkflowExecutionRunResult = WorkflowRunResult & {
  assignmentPlan?: WorkflowRunAssignmentPlan | undefined;
  sourceGaps?: WorkflowSourceGap[] | undefined;
  steps?: WorkflowExecutionStepRecord[] | undefined;
};

export const DEMO_WORKFLOW = loadPlaybookManifest({
  manifestJson: demoWriteApprovalManifest,
}).workflow;
export const WEEKLY_UPDATE_WORKFLOW = loadPlaybookManifest({
  manifestJson: opsWeeklyUpdateManifest,
}).workflow;
export const SALES_MEETING_BRIEF_WORKFLOW = loadPlaybookManifest({
  manifestJson: salesMeetingBriefManifest,
  prompts: { "prompts/draft-brief.md": salesMeetingBriefDraftBrief },
}).workflow;
export const CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW = loadPlaybookManifest({
  manifestJson: customerRenewalRiskReviewManifest,
  prompts: { "prompts/draft-risk-review.md": customerRenewalRiskReviewDraft },
}).workflow;
export const WEEKLY_STATUS_DIGEST_WORKFLOW = loadPlaybookManifest({
  manifestJson: operationsWeeklyStatusDigestManifest,
  prompts: { "prompts/draft-status-digest.md": operationsWeeklyStatusDigestDraft },
}).workflow;

const WORKFLOW_REGISTRY = new Map<string, WorkflowDefinition>([
  [DEMO_WORKFLOW.id, DEMO_WORKFLOW],
  [WEEKLY_UPDATE_WORKFLOW.id, WEEKLY_UPDATE_WORKFLOW],
  [SALES_MEETING_BRIEF_WORKFLOW.id, SALES_MEETING_BRIEF_WORKFLOW],
  [CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW.id, CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW],
  [WEEKLY_STATUS_DIGEST_WORKFLOW.id, WEEKLY_STATUS_DIGEST_WORKFLOW],
]);

export interface RunDemoWorkflowOptions {
  agentCredential?: string;
  agentProvider?: AgentProviderConfig;
  agentRunner?: (options: {
    credential?: string;
    prompt: string;
    provider: AgentProviderConfig;
    workspaceRoot: string;
  }) => Promise<PiTaskTurnResult>;
  cli: WorkspaceCliExecutor;
  capabilityInventory?: WorkflowCapabilityInventory;
  assignmentPlan?: WorkflowRunAssignmentPlan;
  input?: Record<string, unknown>;
  onCheckpoint?: (run: WorkflowExecutionRunResult) => void | Promise<void>;
}

export interface RunWorkflowOptions extends RunDemoWorkflowOptions {
  definition: WorkflowDefinition;
}

export interface ResumeWorkflowRunOptions {
  agentCredential?: string;
  agentProvider?: AgentProviderConfig;
  agentRunner?: (options: {
    credential?: string;
    prompt: string;
    provider: AgentProviderConfig;
    workspaceRoot: string;
  }) => Promise<PiTaskTurnResult>;
  cli: WorkspaceCliExecutor;
  decision: "approve" | "deny";
  run: WorkflowExecutionRunResult;
  definition?: WorkflowDefinition;
  capabilityInventory?: WorkflowCapabilityInventory;
  assignmentPlan?: WorkflowRunAssignmentPlan;
  onCheckpoint?: (run: WorkflowExecutionRunResult) => void | Promise<void>;
}

function createRunId(): string {
  return crypto.randomUUID();
}

function createEventId(): string {
  return crypto.randomUUID();
}

function matchesInputType(value: unknown, type: WorkflowInputDefinition["type"]): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string[]") {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
  return typeof value === "string";
}

function normalizeInput(
  definition: WorkflowDefinition,
  input: Record<string, unknown> = {}
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(definition.inputs)) {
    const value = key in input ? input[key] : spec.default;
    if (value === undefined) {
      if (spec.required) throw new Error(`Missing required workflow input: ${key}`);
      continue;
    }

    if (!matchesInputType(value, spec.type)) {
      throw new Error(`Invalid workflow input type for ${key}: expected ${spec.type}`);
    }

    if (spec.options) {
      const allowed = new Set(spec.options.map((option) => option.value));
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === "string" && !allowed.has(item)) {
          throw new Error(`Invalid workflow input option for ${key}: ${item}`);
        }
      }
    }

    normalized[key] = value;
  }

  return normalized;
}

function resolveArgs(
  args: Record<string, unknown>,
  input: Record<string, unknown>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const match = value.match(/^\{\{inputs\.([A-Za-z0-9_]+)\}\}$/);
      const inputKey = match?.[1];
      resolved[key] = inputKey ? input[inputKey] : value;
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

function resolveTemplate(text: string, input: Record<string, unknown>): string {
  return text.replace(/\{\{inputs\.([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = input[key];
    return value === undefined ? "" : String(value);
  });
}

function defaultCapabilityInventory(): WorkflowCapabilityInventory {
  return createWorkflowCapabilityInventory([DEFAULT_AGENT_PROFILE]);
}

function resolveCapabilityInventory(
  inventory: WorkflowCapabilityInventory | undefined
): WorkflowCapabilityInventory {
  return inventory ?? defaultCapabilityInventory();
}

function resolveAssignmentPlan(
  definition: WorkflowDefinition,
  inventory: WorkflowCapabilityInventory | undefined,
  assignmentPlan: WorkflowRunAssignmentPlan | undefined
): WorkflowRunAssignmentPlan {
  const resolvedInventory = resolveCapabilityInventory(inventory);
  if (assignmentPlan) {
    return validateWorkflowAssignmentPlan(definition, resolvedInventory, assignmentPlan);
  }
  return resolveWorkflowAssignmentPlan(definition, resolvedInventory);
}

function collectSourceGaps(
  stepId: string,
  requires: WorkflowNodeRequirements | undefined,
  inventory: WorkflowCapabilityInventory | undefined
): WorkflowSourceGap[] {
  const gaps: WorkflowSourceGap[] = [];
  if (!requires) return gaps;

  const availableSkillCapabilities = new Set(
    inventory?.agents.flatMap((agent) => agent.skillCapabilities) ?? []
  );
  const availableToolCapabilities = new Set(
    inventory?.agents.flatMap((agent) => agent.toolCapabilities) ?? []
  );
  const availableIntegrationCapabilities = new Set(
    inventory?.integrations.flatMap((integration) => integration.capabilities) ?? []
  );

  for (const capability of workflowCapabilityRefs(requires.skills)) {
    if (availableSkillCapabilities.has(capability)) continue;
    gaps.push({
      stepId,
      kind: "skill",
      capability,
      optional: false,
      reason: "No available agent advertises this skill capability",
    });
  }
  for (const capability of workflowCapabilityRefs(requires.tools)) {
    if (availableToolCapabilities.has(capability)) continue;
    gaps.push({
      stepId,
      kind: "tool",
      capability,
      optional: false,
      reason: "No available agent advertises this tool capability",
    });
  }
  for (const capability of workflowCapabilityRefs(requires.integrations)) {
    if (availableIntegrationCapabilities.has(capability)) continue;
    gaps.push({
      stepId,
      kind: "integration",
      capability,
      optional: false,
      reason: "No configured integration advertises this capability",
    });
  }

  return gaps;
}

function agentToolName(toolId: Extract<WorkflowStep, { kind: "tool" }>["toolId"]): string {
  if (toolId === "workspace.ping") return "workspace_ping";
  return "workspace_write_probe";
}

function compileWorkflowMachine(definition: WorkflowDefinition, initial: string) {
  const states: Record<string, { type?: "final"; on?: Record<string, string> }> = {
    blocked: {},
    completed: { type: "final" },
    denied: { type: "final" },
    failed: { type: "final" },
  };

  for (const step of definition.steps) {
    states[step.id] = {
      on: {
        STEP_SUCCESS: step.onSuccess ?? "completed",
        STEP_FAILURE: step.onFailure ?? "failed",
        STEP_BLOCKED: "blocked",
      },
    };
  }

  return createMachine({
    id: definition.id,
    initial,
    states,
  });
}

function stepPhase(step: WorkflowStep): string {
  return step.phase ?? "Run";
}

function stepLabel(step: WorkflowStep): string {
  return step.label ?? step.id;
}

function createStepRecords(definition: WorkflowDefinition): WorkflowRunStepRecord[] {
  return definition.steps.map((step) => ({
    id: step.id,
    label: stepLabel(step),
    kind: step.kind,
    phase: stepPhase(step),
    status: "queued",
  }));
}

function previewOutput(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.slice(0, 240);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

function markStep(
  steps: WorkflowRunStepRecord[],
  stepId: string,
  patch: Partial<WorkflowRunStepRecord>
): WorkflowRunStepRecord[] {
  return steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step));
}

function eventFor(options: {
  runId: string;
  workflowId: string;
  status: WorkflowRunEvent["status"];
  message: string;
  stepId?: string;
  metadata?: Record<string, unknown>;
}): WorkflowRunEvent {
  return {
    id: createEventId(),
    runId: options.runId,
    workflowId: options.workflowId,
    status: options.status,
    message: options.message,
    createdAt: new Date().toISOString(),
    ...(options.stepId ? { stepId: options.stepId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

async function executeFromStep(options: {
  cli: WorkspaceCliExecutor;
  capabilityInventory?: WorkflowCapabilityInventory;
  assignmentPlan?: WorkflowRunAssignmentPlan;
  definition: WorkflowDefinition;
  agentCredential?: string;
  agentProvider?: AgentProviderConfig;
  agentRunner?: (options: {
    credential?: string;
    prompt: string;
    provider: AgentProviderConfig;
    workspaceRoot: string;
  }) => Promise<PiTaskTurnResult>;
  grants?: PermissionGrant[];
  input: Record<string, unknown>;
  outputs: Record<string, unknown>;
  runId: string;
  startStepId: string;
  startedAt?: string;
  steps?: WorkflowRunStepRecord[];
  events?: WorkflowRunEvent[];
  onCheckpoint?: (run: WorkflowExecutionRunResult) => void | Promise<void>;
}): Promise<WorkflowExecutionRunResult> {
  const { cli, definition, grants, input, outputs, runId } = options;
  const machine = compileWorkflowMachine(definition, options.startStepId);
  const actor = createActor(machine).start();
  let currentStepId = options.startStepId;
  const startedAt = options.startedAt ?? new Date().toISOString();
  let updatedAt = startedAt;
  let steps = options.steps ?? createStepRecords(definition);
  const events = options.events ? [...options.events] : [];
  const sourceGaps: WorkflowSourceGap[] = [];
  const assignmentPlan: WorkflowRunAssignmentPlan = options.assignmentPlan ?? {
    resolverVersion: 1,
    createdAt: startedAt,
    assignments: {},
  };

  const checkpoint = async (patch: Partial<WorkflowExecutionRunResult>) => {
    updatedAt = new Date().toISOString();
    const run: WorkflowExecutionRunResult = {
      runId,
      workflowId: definition.id,
      status: patch.status ?? "running",
      currentStepId,
      input,
      outputs,
      startedAt,
      updatedAt,
      steps,
      events,
      assignmentPlan,
      sourceGaps,
      ...patch,
    };
    await options.onCheckpoint?.(run);
  };

  if (events.length === 0) {
    events.push(
      eventFor({
        runId,
        workflowId: definition.id,
        status: "queued",
        message: `${definition.name} queued`,
        metadata: { assignmentPlan },
      })
    );
    await checkpoint({ status: "running" });
  }

  while (!TERMINAL_STEPS.has(currentStepId)) {
    const step = definition.steps.find((item) => item.id === currentStepId);
    if (!step) {
      events.push(
        eventFor({
          runId,
          workflowId: definition.id,
          status: "failed",
          message: `Unknown workflow step: ${currentStepId}`,
          stepId: currentStepId,
        })
      );
      const failed: WorkflowExecutionRunResult = {
        runId,
        workflowId: definition.id,
        status: "failed",
        currentStepId,
        input,
        outputs,
        startedAt,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        assignmentPlan,
        sourceGaps,
        steps,
        events,
        error: `Unknown workflow step: ${currentStepId}`,
      };
      await options.onCheckpoint?.(failed);
      return failed;
    }

    const stepStartedAt = new Date().toISOString();
    steps = markStep(steps, step.id, { status: "running", startedAt: stepStartedAt });
    events.push(
      eventFor({
        runId,
        workflowId: definition.id,
        status: "running",
        message: `${stepLabel(step)} started`,
        stepId: step.id,
      })
    );
    await checkpoint({ status: "running", currentStepId: step.id });

    if (step.kind === "agent") {
      const workspaceRoot = input[step.workspaceRootInput];
      if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
        const completedAt = new Date().toISOString();
        steps = markStep(steps, step.id, {
          status: "failed",
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
          error: `Missing workflow agent workspace root input: ${step.workspaceRootInput}`,
        });
        events.push(
          eventFor({
            runId,
            workflowId: definition.id,
            status: "failed",
            message: `${stepLabel(step)} failed`,
            stepId: step.id,
          })
        );
        const failed: WorkflowExecutionRunResult = {
          runId,
          workflowId: definition.id,
          status: "failed",
          currentStepId: step.id,
          input,
          outputs,
          startedAt,
          updatedAt: completedAt,
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          assignmentPlan,
          sourceGaps,
          steps,
          events,
          error: `Missing workflow agent workspace root input: ${step.workspaceRootInput}`,
        };
        await options.onCheckpoint?.(failed);
        return failed;
      }

      const stepGaps = collectSourceGaps(step.id, step.requires, options.capabilityInventory);
      sourceGaps.push(...stepGaps);
      const blockingGap = stepGaps.find((gap) => !gap.optional);
      if (blockingGap) {
        const completedAt = new Date().toISOString();
        steps = markStep(steps, step.id, {
          status: "failed",
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
          error: blockingGap.reason ?? `Missing required capability: ${blockingGap.capability}`,
        });
        events.push(
          eventFor({
            runId,
            workflowId: definition.id,
            status: "failed",
            message: `${stepLabel(step)} failed`,
            stepId: step.id,
            metadata: { sourceGaps: stepGaps },
          })
        );
        const failed: WorkflowExecutionRunResult = {
          runId,
          workflowId: definition.id,
          status: "failed",
          currentStepId: step.id,
          input,
          outputs,
          startedAt,
          updatedAt: completedAt,
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          assignmentPlan,
          sourceGaps,
          steps,
          events,
          error: blockingGap.reason ?? `Missing required capability: ${blockingGap.capability}`,
        };
        await options.onCheckpoint?.(failed);
        return failed;
      }

      const selected = assignmentPlan.assignments[step.id];
      if (!selected) {
        const completedAt = new Date().toISOString();
        const error = `Missing assignment for step: ${step.id}`;
        steps = markStep(steps, step.id, {
          status: "failed",
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
          error,
        });
        events.push(
          eventFor({
            runId,
            workflowId: definition.id,
            status: "failed",
            message: `${stepLabel(step)} failed`,
            stepId: step.id,
          })
        );
        const failed: WorkflowExecutionRunResult = {
          runId,
          workflowId: definition.id,
          status: "failed",
          currentStepId: step.id,
          input,
          outputs,
          startedAt,
          updatedAt: completedAt,
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          assignmentPlan,
          sourceGaps,
          steps,
          events,
          error,
        };
        await options.onCheckpoint?.(failed);
        return failed;
      }

      steps = markStep(steps, step.id, {
        status: "running",
        startedAt: stepStartedAt,
        assignment: selected,
      });
      const provider = selected.provider ?? options.agentProvider;
      if (!provider) {
        throw new Error(`No agent provider configured for step: ${step.id}`);
      }
      const credential =
        options.agentCredential ??
        (provider.provider === "local" || !("apiKeyEnv" in provider)
          ? undefined
          : process.env[provider.apiKeyEnv]);
      const agentPrompt = resolveTemplate(step.prompt, input);
      const result = options.agentRunner
        ? await options.agentRunner({
            ...(credential ? { credential } : {}),
            prompt: agentPrompt,
            provider,
            workspaceRoot,
          })
        : await runPiTaskTurn({
            ...(credential ? { credential } : {}),
            prompt: agentPrompt,
            provider,
            shell: createSpawnShellExecutor(cli),
            workspaceRoot,
          });

      outputs[step.id] = result;
      const completedAt = new Date().toISOString();
      steps = markStep(steps, step.id, {
        status: "succeeded",
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
        outputPreview: previewOutput(result),
        assignment: selected,
      });
      events.push(
        eventFor({
          runId,
          workflowId: definition.id,
          status: "succeeded",
          message: `${stepLabel(step)} completed`,
          stepId: step.id,
        })
      );
      actor.send({ type: "STEP_SUCCESS" });
      currentStepId = String(actor.getSnapshot().value);
      await checkpoint({ status: "running", currentStepId });
      continue;
    }

    const decisions: PermissionDecision[] = [];
    const registryOptions = {
      cli,
      onPermissionDecision(decision: PermissionDecision) {
        decisions.push(decision);
      },
      ...(grants ? { grants } : {}),
    };
    const tools = createTesseraTools(registryOptions);
    const tool = tools.find((item) => item.name === agentToolName(step.toolId));
    if (!tool) {
      const completedAt = new Date().toISOString();
      steps = markStep(steps, step.id, {
        status: "failed",
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
        error: `Unknown workflow tool: ${step.toolId}`,
      });
      events.push(
        eventFor({
          runId,
          workflowId: definition.id,
          status: "failed",
          message: `${stepLabel(step)} failed`,
          stepId: step.id,
        })
      );
      const failed: WorkflowExecutionRunResult = {
        runId,
        workflowId: definition.id,
        status: "failed",
        currentStepId,
        input,
        outputs,
        startedAt,
        updatedAt: completedAt,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        assignmentPlan,
        sourceGaps,
        steps,
        events,
        error: `Unknown workflow tool: ${step.toolId}`,
      };
      await options.onCheckpoint?.(failed);
      return failed;
    }

    const stepGaps = collectSourceGaps(step.id, step.requires, options.capabilityInventory);
    sourceGaps.push(...stepGaps);
    const blockingGap = stepGaps.find((gap) => !gap.optional);
    if (blockingGap) {
      const completedAt = new Date().toISOString();
      steps = markStep(steps, step.id, {
        status: "failed",
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
        error: blockingGap.reason ?? `Missing required capability: ${blockingGap.capability}`,
      });
      events.push(
        eventFor({
          runId,
          workflowId: definition.id,
          status: "failed",
          message: `${stepLabel(step)} failed`,
          stepId: step.id,
          metadata: { sourceGaps: stepGaps },
        })
      );
      const failed: WorkflowExecutionRunResult = {
        runId,
        workflowId: definition.id,
        status: "failed",
        currentStepId,
        input,
        outputs,
        startedAt,
        updatedAt: completedAt,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        assignmentPlan,
        sourceGaps,
        steps,
        events,
        error: blockingGap.reason ?? `Missing required capability: ${blockingGap.capability}`,
      };
      await options.onCheckpoint?.(failed);
      return failed;
    }

    const selected = assignmentPlan.assignments[step.id];
    if (!selected) {
      const completedAt = new Date().toISOString();
      steps = markStep(steps, step.id, {
        status: "failed",
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
        error: `Missing assignment for step: ${step.id}`,
      });
      events.push(
        eventFor({
          runId,
          workflowId: definition.id,
          status: "failed",
          message: `${stepLabel(step)} failed`,
          stepId: step.id,
        })
      );
      const failed: WorkflowExecutionRunResult = {
        runId,
        workflowId: definition.id,
        status: "failed",
        currentStepId,
        input,
        outputs,
        startedAt,
        updatedAt: completedAt,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        assignmentPlan,
        sourceGaps,
        steps,
        events,
        error: `Missing assignment for step: ${step.id}`,
      };
      await options.onCheckpoint?.(failed);
      return failed;
    }

    steps = markStep(steps, step.id, {
      status: "running",
      startedAt: stepStartedAt,
      assignment: selected,
    });

    const result = await tool.execute(`${runId}:${step.id}`, resolveArgs(step.args, input));
    const decision = decisions.at(-1);

    if (
      decision &&
      typeof decision === "object" &&
      "decision" in decision &&
      decision.decision === "ask" &&
      "approval" in decision
    ) {
      actor.send({ type: "STEP_BLOCKED" });
      const completedAt = new Date().toISOString();
      steps = markStep(steps, step.id, {
        status: "blocked",
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
      });
      events.push(
        eventFor({
          runId,
          workflowId: definition.id,
          status: "blocked",
          message: `${stepLabel(step)} needs approval`,
          stepId: step.id,
          metadata: { approval: decision.approval },
        })
      );
      const blocked: WorkflowExecutionRunResult = {
        runId,
        workflowId: definition.id,
        status: "blocked",
        currentStepId: step.id,
        input,
        outputs,
        startedAt,
        updatedAt: completedAt,
        assignmentPlan,
        sourceGaps,
        steps,
        events,
        approval: decision.approval,
      };
      await options.onCheckpoint?.(blocked);
      return blocked;
    }

    if (
      decision &&
      typeof decision === "object" &&
      "decision" in decision &&
      decision.decision === "deny"
    ) {
      const completedAt = new Date().toISOString();
      steps = markStep(steps, step.id, {
        status: "denied",
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
      });
      events.push(
        eventFor({
          runId,
          workflowId: definition.id,
          status: "denied",
          message: `${stepLabel(step)} denied`,
          stepId: step.id,
        })
      );
      const denied: WorkflowExecutionRunResult = {
        runId,
        workflowId: definition.id,
        status: "denied",
        currentStepId: step.id,
        input,
        outputs,
        startedAt,
        updatedAt: completedAt,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        assignmentPlan,
        sourceGaps,
        steps,
        events,
      };
      await options.onCheckpoint?.(denied);
      return denied;
    }

    outputs[step.id] = result.details;
    const completedAt = new Date().toISOString();
    steps = markStep(steps, step.id, {
      status: "succeeded",
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(stepStartedAt),
      outputPreview: previewOutput(result.details),
    });
    events.push(
      eventFor({
        runId,
        workflowId: definition.id,
        status: "succeeded",
        message: `${stepLabel(step)} completed`,
        stepId: step.id,
      })
    );
    actor.send({ type: "STEP_SUCCESS" });
    currentStepId = String(actor.getSnapshot().value);
    await checkpoint({ status: "running", currentStepId });
  }

  const completedAt = new Date().toISOString();
  events.push(
    eventFor({
      runId,
      workflowId: definition.id,
      status: currentStepId === "completed" ? "completed" : "failed",
      message: `${definition.name} ${currentStepId === "completed" ? "completed" : "failed"}`,
    })
  );
  const finalRun: WorkflowExecutionRunResult = {
    runId,
    workflowId: definition.id,
    status: currentStepId === "completed" ? "completed" : "failed",
    input,
    outputs,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    assignmentPlan,
    sourceGaps,
    steps,
    events,
  };
  await options.onCheckpoint?.(finalRun);
  return finalRun;
}

export async function runWorkflow(
  options: RunWorkflowOptions
): Promise<WorkflowExecutionRunResult> {
  const input = normalizeInput(options.definition, options.input);
  const capabilityInventory = resolveCapabilityInventory(options.capabilityInventory);
  const assignmentPlan = resolveAssignmentPlan(
    options.definition,
    capabilityInventory,
    options.assignmentPlan
  );
  return executeFromStep({
    cli: options.cli,
    capabilityInventory,
    assignmentPlan,
    definition: options.definition,
    ...(options.agentCredential ? { agentCredential: options.agentCredential } : {}),
    ...(options.agentProvider ? { agentProvider: options.agentProvider } : {}),
    ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
    input,
    outputs: {},
    runId: createRunId(),
    startStepId: options.definition.start,
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
  });
}

export async function runDemoWorkflow(
  options: RunDemoWorkflowOptions
): Promise<WorkflowExecutionRunResult> {
  return runWorkflow({ ...options, definition: DEMO_WORKFLOW });
}

export async function resumeWorkflowRun(
  options: ResumeWorkflowRunOptions
): Promise<WorkflowExecutionRunResult> {
  const { run, decision, cli } = options;
  if (run.status !== "blocked" || !run.currentStepId || !run.approval) {
    return run;
  }

  const capabilityInventory = resolveCapabilityInventory(options.capabilityInventory);
  const definition = options.definition ?? DEMO_WORKFLOW;
  const checkpointedAssignmentPlan = options.assignmentPlan ?? extractWorkflowAssignmentPlan(run);
  const assignmentPlan = checkpointedAssignmentPlan
    ? WorkflowRunAssignmentPlanSchema.parse(checkpointedAssignmentPlan)
    : resolveWorkflowAssignmentPlan(definition, capabilityInventory);

  if (decision === "deny") {
    const completedAt = new Date().toISOString();
    const events = [
      ...(run.events ?? []),
      eventFor({
        runId: run.runId,
        workflowId: run.workflowId,
        status: "denied",
        message: "Approval denied",
        stepId: run.currentStepId,
      }),
    ];
    const steps =
      run.steps && run.currentStepId
        ? markStep(run.steps, run.currentStepId, { status: "denied", completedAt })
        : run.steps;
    const denied: WorkflowExecutionRunResult = {
      ...run,
      status: "denied",
      approval: undefined,
      updatedAt: completedAt,
      completedAt,
      ...(run.startedAt ? { durationMs: Date.parse(completedAt) - Date.parse(run.startedAt) } : {}),
      ...(steps ? { steps } : {}),
      events,
    };
    await options.onCheckpoint?.(denied);
    return denied;
  }

  return executeFromStep({
    cli,
    capabilityInventory,
    assignmentPlan,
    definition,
    ...(options.agentCredential ? { agentCredential: options.agentCredential } : {}),
    ...(options.agentProvider ? { agentProvider: options.agentProvider } : {}),
    ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
    grants: [{ type: "exact", toolId: run.approval.toolId, args: run.approval.args }],
    input: run.input,
    outputs: run.outputs ?? {},
    runId: run.runId,
    startStepId: run.currentStepId,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.steps ? { steps: run.steps } : {}),
    ...(run.events ? { events: run.events } : {}),
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
  });
}
