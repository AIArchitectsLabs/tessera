import { describe, expect, test } from "bun:test";
import type { SpawnResult, WorkflowDefinition } from "@tessera/contracts";
import {
  WorkflowCapabilityInventorySchema,
  WorkflowRunAssignmentPlanSchema,
} from "@tessera/contracts";
import {
  ACTIVITY_SNAPSHOT_WORKFLOW,
  BUILTIN_PLAYBOOK_ROOTS,
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

const capabilityInventory = WorkflowCapabilityInventorySchema.parse({
  agents: [
    {
      id: "agent-reasoner",
      label: "Reasoning Agent",
      fingerprint: "agent:reasoner",
      model: {
        provider: "openai",
        model: "gpt-5.4",
      },
      modelCapabilities: ["model.reasoning"],
      contextTokens: 64000,
      dataPolicies: ["workspace-local-ok", "cloud-ok"],
      skillCapabilities: ["skill.meeting-prep"],
      toolCapabilities: ["tool.workspace.read"],
    },
    {
      id: "agent-summarizer",
      label: "Summary Agent",
      fingerprint: "agent:summarizer",
      model: {
        provider: "openai",
        model: "gpt-4.1-mini",
      },
      modelCapabilities: ["model.summarization"],
      contextTokens: 128000,
      dataPolicies: ["cloud-ok"],
      skillCapabilities: ["skill.summary"],
      toolCapabilities: ["tool.workspace.write"],
    },
  ],
  integrations: [
    {
      id: "calendar",
      label: "Calendar",
      fingerprint: "integration:calendar",
      capabilities: ["integration.calendar.events.read"],
      dataPolicies: ["workspace-local-ok", "cloud-ok"],
      configured: true,
    },
  ],
});

describe("workflow runner", () => {
  test("resolves per-node capability assignments from the capability inventory", async () => {
    const definition: WorkflowDefinition = {
      id: "capability.nodes",
      version: 1,
      name: "Capability Nodes",
      requiredCapabilities: [],
      optionalCapabilities: [],
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
        topic: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft the brief for {{inputs.topic}}",
          workspaceRootInput: "workspaceRoot",
          requires: {
            model: {
              acceptableProviders: ["openai"],
              acceptableModels: ["gpt-5.4"],
              acceptableModelClasses: [],
              acceptablePortableModelIds: [],
              acceptableCapabilities: ["model.reasoning"],
              capabilities: [],
              minContextTokens: 32000,
              dataPolicy: "workspace-local-ok",
            },
            skills: [{ capability: "skill.meeting-prep", optional: false }],
            tools: [{ capability: "tool.workspace.read", optional: false }],
            integrations: [{ capability: "integration.calendar.events.read", optional: false }],
          },
          onSuccess: "summarize",
        },
        {
          id: "summarize",
          kind: "agent",
          prompt: "Summarize the brief for {{inputs.topic}}",
          workspaceRootInput: "workspaceRoot",
          requires: {
            model: {
              acceptableProviders: ["openai"],
              acceptableModels: ["gpt-4.1-mini"],
              acceptableModelClasses: [],
              acceptablePortableModelIds: [],
              acceptableCapabilities: ["model.summarization"],
              capabilities: [],
              dataPolicy: "cloud-ok",
            },
            skills: [{ capability: "skill.summary", optional: false }],
            tools: [{ capability: "tool.workspace.write", optional: false }],
            integrations: [],
          },
          onSuccess: "completed",
        },
      ],
    };

    const calls: Array<{ model: string; provider: string; prompt: string }> = [];

    const result = await runWorkflow({
      definition,
      input: { workspaceRoot: "/workspace/acme", topic: "Quarterly review" },
      capabilityInventory,
      cli: {
        async runWorkspaceCli() {
          throw new Error("tool CLI should not be used by agent-only workflow");
        },
      },
      async agentRunner(options) {
        calls.push({
          model: options.provider.model,
          provider: options.provider.provider,
          prompt: options.prompt,
        });
        return options.provider.model === "gpt-5.4"
          ? {
              text: `drafted:${options.provider.model}`,
              boundaryViolations: 0,
              usage: {
                inputTokens: 10,
                outputTokens: 4,
                totalTokens: 14,
                cachedInputTokens: 2,
                reasoningTokens: 1,
              },
            }
          : {
              text: `drafted:${options.provider.model}`,
              boundaryViolations: 0,
              usage: {
                inputTokens: 6,
                outputTokens: 2,
                totalTokens: 8,
              },
            };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.assignmentPlan?.assignments.draft?.agentId).toBe("agent-reasoner");
    expect(result.assignmentPlan?.assignments.summarize?.agentId).toBe("agent-summarizer");
    expect(result.steps?.find((step) => step.id === "draft")?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    });
    expect(result.steps?.find((step) => step.id === "summarize")?.usage).toEqual({
      inputTokens: 6,
      outputTokens: 2,
      totalTokens: 8,
    });
    expect(result.usage).toEqual({
      inputTokens: 16,
      outputTokens: 6,
      totalTokens: 22,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    });
    expect(result.steps?.find((step) => step.id === "draft")?.assignment?.agentId).toBe(
      "agent-reasoner"
    );
    expect(result.steps?.find((step) => step.id === "summarize")?.assignment?.agentId).toBe(
      "agent-summarizer"
    );
    expect(calls).toEqual([
      {
        model: "gpt-5.4",
        provider: "openai",
        prompt: "Draft the brief for Quarterly review",
      },
      {
        model: "gpt-4.1-mini",
        provider: "openai",
        prompt: "Summarize the brief for Quarterly review",
      },
    ]);
  });

  test("rejects assignment plans that do not match the resolved capability inventory", async () => {
    const definition: WorkflowDefinition = {
      id: "capability.invalid-plan",
      version: 1,
      name: "Capability Invalid Plan",
      requiredCapabilities: [],
      optionalCapabilities: [],
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
        topic: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft the brief for {{inputs.topic}}",
          workspaceRootInput: "workspaceRoot",
          requires: {
            model: {
              acceptableProviders: ["openai"],
              acceptableModels: ["gpt-5.4"],
              acceptableModelClasses: [],
              acceptablePortableModelIds: [],
              acceptableCapabilities: ["model.reasoning"],
              capabilities: [],
              dataPolicy: "cloud-ok",
            },
            skills: [],
            tools: [],
            integrations: [],
          },
        },
      ],
    };

    const invalidPlan = WorkflowRunAssignmentPlanSchema.parse({
      resolverVersion: 1,
      createdAt: "2026-05-08T00:00:00.000Z",
      assignments: {
        draft: {
          stepId: "draft",
          agentId: "agent-summarizer",
          agentLabel: "Summary Agent",
          agentFingerprint: "agent:summarizer",
          provider: { provider: "openai", model: "gpt-4.1-mini" },
          providerFingerprint: "provider:summarizer",
          credentialRef: "OPENAI_API_KEY",
          skillCapabilities: ["skill.summary"],
          toolCapabilities: ["tool.workspace.write"],
          integrationCapabilities: [],
        },
      },
    });

    await expect(
      runWorkflow({
        definition,
        input: { workspaceRoot: "/workspace/acme", topic: "Quarterly review" },
        capabilityInventory,
        assignmentPlan: invalidPlan,
        cli: {
          async runWorkspaceCli() {
            throw new Error("invalid assignment plan should fail before tool execution");
          },
        },
        async agentRunner() {
          throw new Error("invalid assignment plan should fail before agent execution");
        },
      })
    ).rejects.toThrow("Assignment plan validation failed");
  });

  test("threads the capability inventory through tool approval resume", async () => {
    const definition: WorkflowDefinition = {
      id: "capability.resume",
      version: 1,
      name: "Capability Resume",
      requiredCapabilities: [],
      optionalCapabilities: [],
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
        target: { type: "string", required: true },
        value: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft the write-up",
          workspaceRootInput: "workspaceRoot",
          requires: {
            model: {
              acceptableProviders: ["openai"],
              acceptableModels: ["gpt-5.4"],
              acceptableModelClasses: [],
              acceptablePortableModelIds: [],
              acceptableCapabilities: ["model.reasoning"],
              capabilities: [],
              dataPolicy: "cloud-ok",
            },
            skills: [{ capability: "skill.meeting-prep", optional: false }],
            tools: [],
            integrations: [],
          },
          onSuccess: "writeProbe",
        },
        {
          id: "writeProbe",
          kind: "tool",
          toolId: "workspace.writeProbe",
          args: { target: "{{inputs.target}}", value: "{{inputs.value}}" },
          requires: {
            skills: [],
            tools: [{ capability: "tool.workspace.write", optional: false }],
            integrations: [{ capability: "integration.calendar.events.read", optional: false }],
          },
          onSuccess: "completed",
        },
      ],
    };

    const blocked = await runWorkflow({
      definition,
      input: {
        workspaceRoot: "/workspace/acme",
        target: "lead",
        value: "qualified",
      },
      capabilityInventory,
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
      async agentRunner(options) {
        return {
          text: `drafted:${options.provider.model}`,
          boundaryViolations: 0,
        };
      },
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.assignmentPlan?.assignments.draft?.agentId).toBe("agent-reasoner");
    expect(blocked.assignmentPlan?.assignments.writeProbe?.agentId).toBe("agent-summarizer");
    expect(blocked.steps?.find((step) => step.id === "writeProbe")?.assignment?.agentId).toBe(
      "agent-summarizer"
    );

    const driftedCapabilityInventory = WorkflowCapabilityInventorySchema.parse({
      ...capabilityInventory,
      agents: capabilityInventory.agents.map((agent) =>
        agent.id === "agent-reasoner"
          ? { ...agent, fingerprint: "agent:reasoner-new-fingerprint" }
          : agent
      ),
    });

    const resumed = await resumeWorkflowRun({
      run: blocked,
      decision: "approve",
      definition,
      capabilityInventory: driftedCapabilityInventory,
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.assignmentPlan?.assignments.writeProbe?.agentId).toBe("agent-summarizer");
    expect(resumed.outputs?.writeProbe).toEqual({
      target: "lead",
      value: "qualified",
      mutated: false,
    });
  });

  test("runs a workflow loaded from a manifest definition", async () => {
    const definition: WorkflowDefinition = {
      id: "custom.write-approval",
      version: 1,
      name: "Custom Write Approval",
      requiredCapabilities: [],
      optionalCapabilities: [],
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
    };

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

  test("runs an agent workflow step through the Pi task runner adapter", async () => {
    const definition: WorkflowDefinition = {
      id: "custom.agent",
      version: 1,
      name: "Custom Agent",
      requiredCapabilities: [],
      optionalCapabilities: [],
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
    };
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
    const definition: WorkflowDefinition = {
      id: "custom.agent-missing-workspace",
      version: 1,
      name: "Custom Agent Missing Workspace",
      requiredCapabilities: [],
      optionalCapabilities: [],
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
    };

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
    const checkpoints: string[] = [];

    const result = await runDemoWorkflow({
      input: { message: "hello", target: "lead", value: "qualified" },
      cli: {
        async runWorkspaceCli(args) {
          calls.push(args);
          return spawnResult;
        },
      },
      onCheckpoint(run) {
        checkpoints.push(`${run.status}:${run.currentStepId ?? "terminal"}`);
      },
    });

    expect(calls).toEqual([["ping", "hello"]]);
    expect(checkpoints).toContain("running:ping");
    expect(checkpoints).toContain("running:writeProbe");
    expect(checkpoints).toContain("blocked:writeProbe");
    expect(result.status).toBe("blocked");
    expect(result.workflowId).toBe("demo.write-approval");
    expect(result.currentStepId).toBe("writeProbe");
    expect(result.steps?.find((step) => step.id === "ping")?.status).toBe("succeeded");
    expect(result.steps?.find((step) => step.id === "writeProbe")?.status).toBe("blocked");
    expect(result.events?.map((event) => event.status)).toContain("blocked");
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

  test("registers the activity snapshot dashboard built-in with a package root", () => {
    expect(ACTIVITY_SNAPSHOT_WORKFLOW.id).toBe("ops.activity-snapshot");
    expect(ACTIVITY_SNAPSHOT_WORKFLOW.outputs?.some((output) => output.kind === "dashboard")).toBe(
      true
    );
    expect(ACTIVITY_SNAPSHOT_WORKFLOW.inputs.workspaceRoot).toBeDefined();
    expect(BUILTIN_PLAYBOOK_ROOTS[ACTIVITY_SNAPSHOT_WORKFLOW.id]).toContain(
      "ops.activity-snapshot"
    );
  });
});
