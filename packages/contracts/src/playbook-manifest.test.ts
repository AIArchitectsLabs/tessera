import { describe, expect, test } from "bun:test";
import {
  AgentTurnResultSchema,
  PlaybookAssignmentPreviewRequestSchema,
  PlaybookAssignmentPreviewResultSchema,
  PlaybookRunPreferenceReadRequestSchema,
  PlaybookRunPreferenceSaveRequestSchema,
  PlaybookRunPreferenceSchema,
  TokenUsageSchema,
  WorkflowRunResultSchema,
  WorkflowRunStepRecordSchema,
} from "./index.js";

describe("playbook view contracts", () => {
  test("accepts token usage on workflow steps and run results", () => {
    const usage = TokenUsageSchema.parse({
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      cachedInputTokens: 200,
      reasoningTokens: 25,
    });

    expect(usage.totalTokens).toBe(1540);

    const agentTurn = AgentTurnResultSchema.parse({
      status: "completed",
      messages: [{ role: "assistant", text: "Done" }],
      toolResults: [],
      permissionDecisions: [],
      usage,
    });
    expect(agentTurn.usage?.totalTokens).toBe(1540);

    const step = WorkflowRunStepRecordSchema.parse({
      id: "draftBrief",
      label: "Draft meeting brief",
      kind: "agent",
      phase: "Prepare",
      status: "succeeded",
      usage,
    });
    expect(step.usage?.inputTokens).toBe(1200);

    const run = WorkflowRunResultSchema.parse({
      runId: "run-usage",
      workflowId: "sales.meeting-brief",
      status: "completed",
      input: {},
      sourceGaps: [],
      usage,
      steps: [step],
    });
    expect(run.usage?.outputTokens).toBe(340);
  });

  test("accepts playbook assignment preview and preference contracts", () => {
    const assignmentPlan = {
      resolverVersion: 1,
      createdAt: "2026-05-11T00:00:00.000Z",
      assignments: {
        draftBrief: {
          stepId: "draftBrief",
          agentId: "default",
          agentLabel: "Tessera",
          skillCapabilities: [],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
          integrationCapabilities: [],
        },
      },
    };

    const preview = PlaybookAssignmentPreviewResultSchema.parse({
      assignmentPlan,
      confirmationRequired: true,
      blockers: [],
      sourceGaps: [],
      nodePreviews: [
        {
          stepId: "draftBrief",
          stepLabel: "Draft meeting brief",
          kind: "agent",
          recommendedAgentId: "default",
          recommendedAgentLabel: "Tessera",
          candidates: [
            {
              agentId: "default",
              agentLabel: "Tessera",
              assignment: assignmentPlan.assignments.draftBrief,
              recommended: true,
              disabled: false,
            },
          ],
        },
      ],
    });
    expect(preview.confirmationRequired).toBe(true);

    const previewRequest = PlaybookAssignmentPreviewRequestSchema.parse({
      workspaceRoot: "/tmp/workspace",
      capabilityInventory: {
        agents: [],
        integrations: [],
      },
      previousPlan: assignmentPlan,
    });
    expect(previewRequest.workspaceRoot).toBe("/tmp/workspace");
    expect(() =>
      PlaybookAssignmentPreviewRequestSchema.parse({
        workspaceRoot: "/tmp/workspace",
        playbookId: "sales.meeting-brief",
      })
    ).toThrow();
    expect(() =>
      PlaybookAssignmentPreviewRequestSchema.parse({
        workspaceRoot: "/tmp/workspace",
        unexpectedField: true,
      })
    ).toThrow();

    const preference = PlaybookRunPreferenceSchema.parse({
      workspaceRoot: "/tmp/workspace",
      playbookId: "sales.meeting-brief",
      assignmentPlan,
      updatedAt: "2026-05-11T00:00:00.000Z",
    });
    expect(preference.playbookId).toBe("sales.meeting-brief");

    const readRequest = PlaybookRunPreferenceReadRequestSchema.parse({
      workspaceRoot: "/tmp/workspace",
    });
    expect(readRequest.workspaceRoot).toBe("/tmp/workspace");

    const saveRequest = PlaybookRunPreferenceSaveRequestSchema.parse({
      workspaceRoot: "/tmp/workspace",
      assignmentPlan,
      capabilityInventory: {
        agents: [
          {
            id: "default",
            label: "Tessera",
            fingerprint: "ui-built-agent-fingerprint",
            modelCapabilities: [],
            dataPolicies: ["cloud-ok"],
            skillCapabilities: [],
            toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
          },
        ],
        integrations: [],
      },
    });
    expect(saveRequest.assignmentPlan.assignments.draftBrief?.agentId).toBe("default");
    expect(saveRequest.capabilityInventory?.agents[0]?.fingerprint).toBe(
      "ui-built-agent-fingerprint"
    );
    expect(() =>
      PlaybookRunPreferenceSaveRequestSchema.parse({
        workspaceRoot: "/tmp/workspace",
        assignmentPlan,
        updatedAt: "2026-05-11T00:00:00.000Z",
      })
    ).toThrow();
  });

  test("rejects playbook assignment preview candidates with mismatched agent identity", () => {
    expect(() =>
      PlaybookAssignmentPreviewResultSchema.parse({
        assignmentPlan: {
          resolverVersion: 1,
          createdAt: "2026-05-11T00:00:00.000Z",
          assignments: {},
        },
        confirmationRequired: true,
        blockers: [],
        sourceGaps: [],
        nodePreviews: [
          {
            stepId: "draftBrief",
            stepLabel: "Draft meeting brief",
            kind: "agent",
            candidates: [
              {
                agentId: "default",
                agentLabel: "Tessera",
                assignment: {
                  stepId: "draftBrief",
                  agentId: "other",
                  agentLabel: "Tessera",
                  skillCapabilities: [],
                  toolCapabilities: ["tool.workspace.read"],
                  integrationCapabilities: [],
                },
                recommended: true,
                disabled: false,
              },
            ],
          },
        ],
      })
    ).toThrow();
  });

  test("accepts legacy workflow run results without usage", () => {
    const legacyRun = WorkflowRunResultSchema.parse({
      runId: "run-legacy",
      workflowId: "sales.meeting-brief",
      status: "completed",
      input: {},
      sourceGaps: [],
    });

    expect(legacyRun.usage).toBeUndefined();
  });
});
