import type {
  PermissionDecision,
  PermissionGrant,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
} from "@tessera/contracts";
import { WorkflowDefinitionSchema } from "@tessera/contracts";
import { createActor, createMachine } from "xstate";
import { type WorkspaceCliExecutor, createTesseraTools } from "./tools.js";
import demoWorkflowManifest from "./workflows/demo.write-approval.json";

const TERMINAL_STEPS = new Set(["completed", "failed", "denied"]);

export function loadWorkflowDefinition(value: unknown): WorkflowDefinition {
  const definition = WorkflowDefinitionSchema.parse(value);
  const stepIds = new Set(definition.steps.map((step) => step.id));

  if (!stepIds.has(definition.start)) {
    throw new Error(`Unknown workflow start step: ${definition.start}`);
  }

  for (const step of definition.steps) {
    for (const next of [step.onSuccess, step.onFailure]) {
      if (next && !stepIds.has(next) && !TERMINAL_STEPS.has(next)) {
        throw new Error(`Unknown workflow transition from ${step.id}: ${next}`);
      }
    }
  }

  return definition;
}

export const DEMO_WORKFLOW = loadWorkflowDefinition(demoWorkflowManifest);

export interface RunDemoWorkflowOptions {
  cli: WorkspaceCliExecutor;
  input?: Record<string, unknown>;
}

export interface RunWorkflowOptions extends RunDemoWorkflowOptions {
  definition: WorkflowDefinition;
}

export interface ResumeWorkflowRunOptions {
  cli: WorkspaceCliExecutor;
  decision: "approve" | "deny";
  run: WorkflowRunResult;
  definition?: WorkflowDefinition;
}

function createRunId(): string {
  return crypto.randomUUID();
}

function matchesInputType(value: unknown, type: "string" | "number" | "boolean"): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  return typeof value === "boolean";
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

function agentToolName(toolId: WorkflowStep["toolId"]): string {
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

async function executeFromStep(options: {
  cli: WorkspaceCliExecutor;
  definition: WorkflowDefinition;
  grants?: PermissionGrant[];
  input: Record<string, unknown>;
  outputs: Record<string, unknown>;
  runId: string;
  startStepId: string;
}): Promise<WorkflowRunResult> {
  const { cli, definition, grants, input, outputs, runId } = options;
  const machine = compileWorkflowMachine(definition, options.startStepId);
  const actor = createActor(machine).start();
  let currentStepId = options.startStepId;

  while (!TERMINAL_STEPS.has(currentStepId)) {
    const step = definition.steps.find((item) => item.id === currentStepId);
    if (!step) {
      return {
        runId,
        workflowId: definition.id,
        status: "failed",
        currentStepId,
        input,
        outputs,
        error: `Unknown workflow step: ${currentStepId}`,
      };
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
      return {
        runId,
        workflowId: definition.id,
        status: "failed",
        currentStepId,
        input,
        outputs,
        error: `Unknown workflow tool: ${step.toolId}`,
      };
    }

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
      return {
        runId,
        workflowId: definition.id,
        status: "blocked",
        currentStepId: step.id,
        input,
        outputs,
        approval: decision.approval,
      };
    }

    if (
      decision &&
      typeof decision === "object" &&
      "decision" in decision &&
      decision.decision === "deny"
    ) {
      return {
        runId,
        workflowId: definition.id,
        status: "denied",
        currentStepId: step.id,
        input,
        outputs,
      };
    }

    outputs[step.id] = result.details;
    actor.send({ type: "STEP_SUCCESS" });
    currentStepId = String(actor.getSnapshot().value);
  }

  return {
    runId,
    workflowId: definition.id,
    status: currentStepId === "completed" ? "completed" : "failed",
    input,
    outputs,
  };
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const input = normalizeInput(options.definition, options.input);
  return executeFromStep({
    cli: options.cli,
    definition: options.definition,
    input,
    outputs: {},
    runId: createRunId(),
    startStepId: options.definition.start,
  });
}

export async function runDemoWorkflow(options: RunDemoWorkflowOptions): Promise<WorkflowRunResult> {
  return runWorkflow({ ...options, definition: DEMO_WORKFLOW });
}

export async function resumeWorkflowRun(
  options: ResumeWorkflowRunOptions
): Promise<WorkflowRunResult> {
  const { run, decision, cli } = options;
  if (run.status !== "blocked" || !run.currentStepId || !run.approval) {
    return run;
  }

  if (decision === "deny") {
    return {
      ...run,
      status: "denied",
    };
  }

  return executeFromStep({
    cli,
    definition: options.definition ?? DEMO_WORKFLOW,
    grants: [{ type: "exact", toolId: run.approval.toolId, args: run.approval.args }],
    input: run.input,
    outputs: run.outputs ?? {},
    runId: run.runId,
    startStepId: run.currentStepId,
  });
}
