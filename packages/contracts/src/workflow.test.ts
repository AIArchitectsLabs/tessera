import { describe, expect, test } from "bun:test";
import {
  WorkflowDefinitionSchema,
  WorkflowResumeRequestSchema,
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

    expect(parsed.steps[0]?.toolId).toBe("workspace.ping");
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
});
