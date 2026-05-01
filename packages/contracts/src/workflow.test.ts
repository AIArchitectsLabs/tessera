import { describe, expect, test } from "bun:test";
import {
  WorkflowDefinitionSchema,
  WorkflowResumeRequestSchema,
  WorkflowRunListResultSchema,
  WorkflowRunRequestSchema,
  WorkflowRunResultSchema,
} from "./index.js";

describe("workflow contracts", () => {
  test("accepts the v1 demo workflow definition shape", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: "demo.write-approval",
      version: 1,
      name: "Demo Write Approval",
      start: "ping",
      inputs: {
        message: { type: "string", required: true, default: "hello" },
      },
      steps: [
        {
          id: "ping",
          kind: "tool",
          toolId: "workspace.ping",
          args: { message: "{{inputs.message}}" },
          onSuccess: "completed",
        },
      ],
    });

    expect(parsed.steps[0]?.kind).toBe("tool");
    if (parsed.steps[0]?.kind === "tool") {
      expect(parsed.steps[0].toolId).toBe("workspace.ping");
    }
  });

  test("rejects unsupported workflow tools", () => {
    const parsed = WorkflowDefinitionSchema.safeParse({
      id: "bad",
      version: 1,
      name: "Bad",
      start: "run",
      steps: [{ id: "run", kind: "tool", toolId: "shell.rm", args: {} }],
    });

    expect(parsed.success).toBe(false);
  });

  test("accepts agent workflow steps", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: "agent.workflow",
      version: 1,
      name: "Agent Workflow",
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
        prompt: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "{{inputs.prompt}}",
          workspaceRootInput: "workspaceRoot",
          onSuccess: "completed",
        },
      ],
    });

    expect(parsed.steps[0]?.kind).toBe("agent");
  });

  test("accepts blocked run results and resume decisions", () => {
    const result = WorkflowRunResultSchema.parse({
      runId: "run-1",
      workflowId: "demo.write-approval",
      status: "blocked",
      currentStepId: "writeProbe",
      input: { target: "lead", value: "qualified" },
      approval: {
        toolId: "workspace.writeProbe",
        args: { target: "lead", value: "qualified" },
        capability: "write",
        risk: {
          mutates: true,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: true,
        },
        preview: "write-probe target=lead value=qualified",
        reasonCode: "write_requires_approval",
      },
    });

    const resume = WorkflowResumeRequestSchema.parse({
      runId: result.runId,
      decision: "approve",
    });

    expect(resume).toEqual({ runId: "run-1", decision: "approve" });
  });

  test("accepts non-demo workflow run requests", () => {
    const parsed = WorkflowRunRequestSchema.parse({
      workflowId: "operations.lead-sync",
      input: { message: "hello" },
    });

    expect(parsed.workflowId).toBe("operations.lead-sync");
  });

  test("accepts workflow run list results", () => {
    const parsed = WorkflowRunListResultSchema.parse({
      runs: [
        {
          runId: "run-1",
          workflowId: "demo.write-approval",
          status: "blocked",
          currentStepId: "writeProbe",
          input: { target: "lead", value: "qualified" },
        },
      ],
    });

    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.status).toBe("blocked");
  });
});
