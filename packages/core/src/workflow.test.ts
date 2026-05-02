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

  test("runs an agent workflow step through the Pi task runner adapter", async () => {
    const definition = loadWorkflowDefinition({
      id: "custom.agent",
      version: 1,
      name: "Custom Agent",
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
        prompt: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft: {{inputs.prompt}}",
          workspaceRootInput: "workspaceRoot",
          onSuccess: "completed",
        },
      ],
    });
    const calls: Array<{ prompt: string; workspaceRoot: string }> = [];

    const result = await runWorkflow({
      definition,
      input: { workspaceRoot: "/workspace/acme", prompt: "hello" },
      cli: {
        async runWorkspaceCli() {
          throw new Error("agent workflow should not call tool CLI");
        },
      },
      agentProvider: { provider: "local", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" },
      async agentRunner(options) {
        calls.push({ prompt: options.prompt, workspaceRoot: options.workspaceRoot });
        return { text: "drafted", boundaryViolations: 0 };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.outputs?.draft).toEqual({ text: "drafted", boundaryViolations: 0 });
    expect(calls).toEqual([{ prompt: "Draft: hello", workspaceRoot: "/workspace/acme" }]);
  });

  test("fails an agent workflow step when workspace input is missing", async () => {
    const definition = loadWorkflowDefinition({
      id: "custom.agent-missing-workspace",
      version: 1,
      name: "Custom Agent Missing Workspace",
      start: "draft",
      inputs: {
        prompt: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "{{inputs.prompt}}",
          workspaceRootInput: "workspaceRoot",
        },
      ],
    });

    const result = await runWorkflow({
      definition,
      input: { prompt: "hello" },
      cli: {
        async runWorkspaceCli() {
          throw new Error("agent workflow should not call tool CLI");
        },
      },
      async agentRunner() {
        throw new Error("agent runner should not be called without workspace root");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Missing workflow agent workspace root input");
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
