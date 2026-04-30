import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "@tessera/contracts";
import {
  loadWorkflowDefinition,
  resumeWorkflowRun,
  runDemoWorkflow,
  runWorkflow,
} from "./workflow.js";

const spawnResult: SpawnResult = {
  stdout: '{"message":"pong"}\n',
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 3,
};

describe("workflow runner", () => {
  test("runs a workflow loaded from a manifest definition", async () => {
    const definition = loadWorkflowDefinition({
      id: "custom.write-approval",
      version: 1,
      name: "Custom Write Approval",
      start: "ping",
      inputs: {
        message: { type: "string", required: true, default: "hello" },
        target: { type: "string", required: true, default: "lead" },
        value: { type: "string", required: true, default: "qualified" },
      },
      steps: [
        {
          id: "ping",
          kind: "tool",
          toolId: "workspace.ping",
          args: { message: "{{inputs.message}}" },
          onSuccess: "writeProbe",
        },
        {
          id: "writeProbe",
          kind: "tool",
          toolId: "workspace.writeProbe",
          args: { target: "{{inputs.target}}", value: "{{inputs.value}}" },
          onSuccess: "completed",
        },
      ],
    });

    const result = await runWorkflow({
      definition,
      input: { message: "hello", target: "lead", value: "qualified" },
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
    });

    expect(result.workflowId).toBe("custom.write-approval");
    expect(result.status).toBe("blocked");
    expect(result.currentStepId).toBe("writeProbe");
  });

  test("rejects manifest definitions whose start step is missing", () => {
    expect(() =>
      loadWorkflowDefinition({
        id: "bad",
        version: 1,
        name: "Bad",
        start: "missing",
        steps: [
          {
            id: "ping",
            kind: "tool",
            toolId: "workspace.ping",
            args: {},
          },
        ],
      })
    ).toThrow("Unknown workflow start step: missing");
  });

  test("runs the demo workflow until an unapproved write blocks", async () => {
    const calls: string[][] = [];

    const result = await runDemoWorkflow({
      input: { message: "hello", target: "lead", value: "qualified" },
      cli: {
        async runWorkspaceCli(args) {
          calls.push(args);
          return spawnResult;
        },
      },
    });

    expect(calls).toEqual([["ping", "hello"]]);
    expect(result.status).toBe("blocked");
    expect(result.workflowId).toBe("demo.write-approval");
    expect(result.currentStepId).toBe("writeProbe");
    expect(result.approval).toEqual({
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
    });
  });

  test("resumes a blocked workflow when the user approves the exact write", async () => {
    const blocked = await runDemoWorkflow({
      input: { message: "hello", target: "lead", value: "qualified" },
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
    });

    const resumed = await resumeWorkflowRun({
      run: blocked,
      decision: "approve",
      cli: {
        async runWorkspaceCli() {
          throw new Error("resume should not repeat completed read steps");
        },
      },
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.currentStepId).toBeUndefined();
    expect(resumed.outputs?.writeProbe).toEqual({
      target: "lead",
      value: "qualified",
      mutated: false,
    });
  });

  test("denies a blocked workflow without executing the write", async () => {
    const blocked = await runDemoWorkflow({
      input: { message: "hello", target: "lead", value: "qualified" },
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
    });

    const denied = await resumeWorkflowRun({
      run: blocked,
      decision: "deny",
      cli: {
        async runWorkspaceCli() {
          throw new Error("deny should not execute tools");
        },
      },
    });

    expect(denied.status).toBe("denied");
    expect(denied.currentStepId).toBe("writeProbe");
  });
});
