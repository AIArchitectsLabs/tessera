import { describe, expect, test } from "bun:test";
import {
  CANONICAL_CAPABILITIES,
  CapabilityKindSchema,
  PlaybookDetailSchema,
  PlaybookListResultSchema,
  PlaybookRunDetailSchema,
  WorkflowCapabilityInventorySchema,
  WorkflowNodeRequirementsSchema,
  WorkflowResumeRequestSchema,
  WorkflowRunAssignmentPlanSchema,
  WorkflowRunListResultSchema,
  WorkflowRunRequestSchema,
  WorkflowRunResultSchema,
  assertKnownCapability,
  canonicalCapability,
} from "./index.js";

describe("workflow contracts", () => {
  test("resolves canonical capabilities and aliases", () => {
    expect(CANONICAL_CAPABILITIES.length).toBeGreaterThan(0);
    expect(CapabilityKindSchema.parse("skill")).toBe("skill");
    expect(canonicalCapability("reasoning")?.id).toBe("model.reasoning");
    expect(canonicalCapability("tool.workspace.read")?.kind).toBe("tool");
    expect(assertKnownCapability("reasoning", "model", false)).toBe("model.reasoning");
    expect(assertKnownCapability("skill.not-real", "skill", true)).toBe("skill.not-real");
    expect(() => assertKnownCapability("tool.workspace.read", "skill", false)).toThrow();
  });

  test("rejects local ids in workflow node requirements", () => {
    expect(() =>
      WorkflowNodeRequirementsSchema.parse({
        agentId: "agent-1",
      })
    ).toThrow();
  });

  test("accepts blocked run results and resume decisions", () => {
    const assignmentPlan = WorkflowRunAssignmentPlanSchema.parse({
      resolverVersion: 1,
      createdAt: "2026-05-08T00:00:00.000Z",
      assignments: {
        writeProbe: {
          stepId: "writeProbe",
          agentId: "agent-1",
          agentLabel: "Research Agent",
          provider: {
            provider: "openai",
            model: "gpt-4o",
          },
          credentialRef: "openai-primary",
        },
      },
    });

    const result = WorkflowRunResultSchema.parse({
      runId: "run-1",
      workflowId: "demo.write-approval",
      status: "blocked",
      currentStepId: "writeProbe",
      input: { target: "lead", value: "qualified" },
      assignmentPlan,
      sourceGaps: [
        {
          stepId: "writeProbe",
          capability: "integration.calendar.events.read",
          kind: "integration",
          optional: true,
        },
      ],
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
      capabilityInventory: WorkflowCapabilityInventorySchema.parse({
        agents: [
          {
            id: "agent-1",
            label: "Research Agent",
            fingerprint: "agent-1:fingerprint",
            model: {
              provider: "openai",
              model: "gpt-4o",
              hasCredential: true,
            },
            modelCapabilities: ["model.reasoning"],
            skillCapabilities: ["skill.meeting-prep"],
            toolCapabilities: ["tool.workspace.read"],
          },
        ],
        integrations: [
          {
            id: "calendar",
            label: "Calendar",
            fingerprint: "calendar:fingerprint",
            capabilities: ["integration.calendar.events.read"],
            configured: true,
          },
        ],
      }),
      assignmentPlan,
    });

    expect(resume.decision).toBe("approve");
    expect(resume.assignmentPlan?.assignments.writeProbe?.agentId).toBe("agent-1");
  });

  test("accepts non-demo workflow run requests", () => {
    const assignmentPlan = WorkflowRunAssignmentPlanSchema.parse({
      resolverVersion: 1,
      createdAt: "2026-05-08T00:00:00.000Z",
      assignments: {},
    });

    const capabilityInventory = WorkflowCapabilityInventorySchema.parse({
      agents: [],
      integrations: [],
    });

    const parsed = WorkflowRunRequestSchema.parse({
      workflowId: "operations.lead-sync",
      input: { message: "hello" },
      assignmentPlan,
      capabilityInventory,
      agentProvider: {
        provider: "openai",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      credential: { apiKey: "test-key" },
    });

    expect(parsed.workflowId).toBe("operations.lead-sync");
    expect(parsed.assignmentPlan?.resolverVersion).toBe(1);
    expect(parsed.agentProvider?.provider).toBe("openai");
    expect(parsed.credential).toMatchObject({ apiKey: "test-key" });
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

  test("accepts playbook summaries and display-ready run detail", () => {
    const playbooks = PlaybookListResultSchema.parse({
      playbooks: [
        {
          id: "ops.weekly-update",
          version: 1,
          name: "Weekly Update",
          description: "Prepare a weekly update",
          stepCount: 2,
          phases: ["Collect", "Draft"],
        },
      ],
    });
    const detail = PlaybookDetailSchema.parse({
      ...playbooks.playbooks[0],
      inputs: { message: { type: "string", required: true, default: "weekly" } },
      steps: [
        {
          id: "collect",
          label: "Collect context",
          phase: "Collect",
          kind: "tool",
          toolId: "workspace.ping",
          args: { message: "{{inputs.message}}" },
        },
      ],
    });
    const run = PlaybookRunDetailSchema.parse({
      runId: "run-1",
      workflowId: detail.id,
      status: "completed",
      input: { message: "weekly" },
      outputs: { collect: { message: "pong" } },
      playbook: playbooks.playbooks[0],
      steps: [
        {
          id: "collect",
          label: "Collect context",
          kind: "tool",
          phase: "Collect",
          status: "succeeded",
          outputPreview: '{"message":"pong"}',
        },
      ],
      events: [
        {
          id: "event-1",
          runId: "run-1",
          workflowId: detail.id,
          stepId: "collect",
          status: "succeeded",
          message: "Collect context completed",
          createdAt: "2026-05-08T00:00:00.000Z",
        },
      ],
    });

    expect(run.playbook?.name).toBe("Weekly Update");
    expect(run.steps?.[0]?.phase).toBe("Collect");
    expect(run.events?.[0]?.status).toBe("succeeded");
  });
});
