import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "@tessera/contracts";
import { resumeWorkflowRun, runDemoWorkflow } from "./workflow.js";

const spawnResult: SpawnResult = {
  stdout: '{"message":"pong"}\n',
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 3,
};

describe("workflow runner", () => {
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
