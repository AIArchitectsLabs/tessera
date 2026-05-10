import { describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  BrowserRecipeProposalSchema,
  TaskArtifactSchema,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskDetailSchema,
  TaskListResultSchema,
  TaskSummarySchema,
  TaskUpdateRequestSchema,
  compileAgentRuntimeContext,
} from "./index.js";

describe("task contracts", () => {
  test("accepts draft browser recipe proposal contracts", () => {
    const parsed = BrowserRecipeProposalSchema.parse({
      id: "recipe-1",
      status: "draft",
      domain: "example.com",
      goal: "Inspect Example",
      source: { taskId: "task-1", sessionId: "session-1" },
      permissions: ["browser.read"],
      steps: [
        {
          action: "open",
          url: "https://example.com",
          expectedState: "Example Domain page is visible",
        },
        {
          action: "see",
          expectedState: "Readable page text is extracted",
        },
      ],
      artifacts: [{ title: "Screenshot", path: "/tmp/example.png" }],
      createdAt: "2026-05-10T00:00:00.000Z",
    });

    expect(parsed.status).toBe("draft");
    expect(parsed.permissions).toEqual(["browser.read"]);
  });

  test("accepts workspace task summaries", () => {
    const parsed = TaskSummarySchema.parse({
      id: "task-1",
      workspaceRoot: "/workspace/acme",
      title: "Draft announcement",
      status: "done",
      agentId: "default",
      agentLabel: "Maeve",
      latestActivity: "Created draft artifact",
      createdAt: "2026-04-30T10:00:00.000Z",
      updatedAt: "2026-04-30T10:01:00.000Z",
    });

    expect(parsed.workspaceRoot).toBe("/workspace/acme");
    expect(parsed.status).toBe("done");
    expect(parsed.agentId).toBe("default");
  });

  test("rejects tasks without a workspace root", () => {
    const parsed = TaskCreateRequestSchema.safeParse({
      initialInstruction: "Do work",
    });

    expect(parsed.success).toBe(false);
  });

  test("accepts task detail with turns and artifacts", () => {
    const agentContext = compileAgentRuntimeContext(
      AgentProfileSchema.parse({
        id: "ops",
        name: "Ops",
        model: { mode: "default" },
        instructions: "Keep deliverables concrete.",
        createdAt: "2026-04-30T10:00:00.000Z",
        updatedAt: "2026-04-30T10:00:00.000Z",
      })
    );
    const detail = TaskDetailSchema.parse({
      id: "task-1",
      workspaceRoot: "/workspace/acme",
      title: "Draft announcement",
      status: "done",
      agentContext,
      createdAt: "2026-04-30T10:00:00.000Z",
      updatedAt: "2026-04-30T10:01:00.000Z",
      turns: [
        {
          id: "turn-1",
          taskId: "task-1",
          role: "user",
          content: "Draft a launch announcement",
          status: "completed",
          createdAt: "2026-04-30T10:00:00.000Z",
          completedAt: "2026-04-30T10:00:01.000Z",
        },
        {
          id: "turn-2",
          taskId: "task-1",
          role: "agent",
          content: "Created an initial draft.",
          status: "completed",
          createdAt: "2026-04-30T10:00:01.000Z",
          completedAt: "2026-04-30T10:00:02.000Z",
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          taskId: "task-1",
          turnId: "turn-2",
          kind: "text",
          title: "Task output",
          contentPreview: "Draft output",
          createdAt: "2026-04-30T10:00:02.000Z",
        },
      ],
    });

    expect(detail.turns).toHaveLength(2);
    expect(detail.artifacts[0]?.turnId).toBe("turn-2");
    expect(detail.agentContext?.toolPolicy.preset).toBe("workspace_editor");
  });

  test("accepts list, update, turn create, and artifact shapes", () => {
    expect(
      TaskListResultSchema.parse({
        tasks: [
          {
            id: "task-1",
            workspaceRoot: "/workspace/acme",
            title: "Draft announcement",
            status: "active",
            createdAt: "2026-04-30T10:00:00.000Z",
            updatedAt: "2026-04-30T10:00:00.000Z",
          },
        ],
      }).tasks
    ).toHaveLength(1);

    expect(TaskUpdateRequestSchema.parse({ status: "waiting", latestActivity: "Waiting" })).toEqual(
      {
        status: "waiting",
        latestActivity: "Waiting",
      }
    );

    expect(TaskCreateTurnRequestSchema.parse({ content: "Revise it" }).content).toBe("Revise it");

    expect(
      TaskArtifactSchema.parse({
        id: "artifact-1",
        taskId: "task-1",
        kind: "text",
        title: "Output",
        createdAt: "2026-04-30T10:00:00.000Z",
      }).kind
    ).toBe("text");
  });
});
