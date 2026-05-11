import { describe, expect, test } from "bun:test";
import {
  PlaybookAssignmentPreviewRequestSchema,
  PlaybookAssignmentPreviewResultSchema,
  PlaybookManifestSchema,
  PlaybookRunPreferenceReadRequestSchema,
  PlaybookRunPreferenceSchema,
  TokenUsageSchema,
  WorkflowRunResultSchema,
  WorkflowRunStepRecordSchema,
} from "./index.js";

describe("PlaybookManifestSchema", () => {
  const validWorkflow = {
    id: "demo",
    version: 1,
    name: "Demo",
    start: "ping",
    inputs: {},
    steps: [
      {
        id: "ping",
        kind: "tool",
        toolId: "workspace.ping",
        args: {},
        onSuccess: "completed",
      },
    ],
  };

  test("accepts a minimal valid manifest", () => {
    const result = PlaybookManifestSchema.parse({
      schemaVersion: 1,
      meta: {
        id: "demo",
        version: 1,
        name: "Demo",
      },
      workflow: validWorkflow,
    });
    expect(result.meta.id).toBe("demo");
    expect(result.workflow.id).toBe("demo");
  });

  test("accepts optional meta fields", () => {
    const result = PlaybookManifestSchema.parse({
      schemaVersion: 1,
      meta: {
        id: "demo",
        version: 1,
        name: "Demo",
        description: "A demo playbook",
        author: "Tessera",
        tags: ["demo", "test"],
        signature: "abc123",
      },
      workflow: validWorkflow,
    });
    expect(result.meta.author).toBe("Tessera");
    expect(result.meta.tags).toEqual(["demo", "test"]);
  });

  test("rejects missing schemaVersion", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        meta: { id: "demo", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects unsupported schemaVersion", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 999,
        meta: { id: "demo", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects empty meta.id", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 1,
        meta: { id: "", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects non-positive meta.version", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 1,
        meta: { id: "demo", version: 0, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("accepts token usage on workflow steps and run results", () => {
    const usage = TokenUsageSchema.parse({
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      cachedInputTokens: 200,
      reasoningTokens: 25,
    });

    expect(usage.totalTokens).toBe(1540);

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
