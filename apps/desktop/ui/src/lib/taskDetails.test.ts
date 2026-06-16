import { describe, expect, test } from "bun:test";
import type { TaskDetail, TaskTurn } from "@tessera/contracts";
import { mergeTaskDetail } from "./taskDetails.js";

const baseTurn: TaskTurn = {
  id: "turn-1",
  taskId: "task-1",
  role: "agent",
  content: "Working on it",
  status: "running",
  createdAt: "2026-05-03T00:00:01.000Z",
};

const baseDetail: TaskDetail = {
  id: "task-1",
  workspaceRoot: "/workspace",
  title: "Task",
  status: "active",
  agentId: "default",
  agentLabel: "Tessera",
  latestActivity: "Running",
  createdAt: "2026-05-03T00:00:00.000Z",
  updatedAt: "2026-05-03T00:00:03.000Z",
  notifications: [],
  auditRecords: [],
  activeSkills: [],
  turns: [baseTurn],
  artifacts: [],
};

describe("mergeTaskDetail", () => {
  test("adds new turns from an incoming snapshot", () => {
    const incoming: TaskDetail = {
      ...baseDetail,
      updatedAt: "2026-05-03T00:00:02.000Z",
      turns: [
        {
          id: "turn-0",
          taskId: "task-1",
          role: "user",
          content: "Follow up",
          status: "running",
          createdAt: "2026-05-03T00:00:00.500Z",
        },
        {
          id: "turn-2",
          taskId: "task-1",
          role: "agent",
          content: "Queued",
          status: "queued",
          createdAt: "2026-05-03T00:00:02.000Z",
        },
      ],
    };

    const result = mergeTaskDetail(baseDetail, incoming);
    expect(result.turns.map((turn) => turn.id)).toEqual(["turn-0", "turn-1", "turn-2"]);
  });

  test("keeps the more advanced turn state when an incoming snapshot is older", () => {
    const incoming: TaskDetail = {
      ...baseDetail,
      updatedAt: "2026-05-03T00:00:02.000Z",
      turns: [
        {
          ...baseTurn,
          content: "Queued",
          status: "queued",
        },
      ],
    };

    const result = mergeTaskDetail(baseDetail, incoming);
    expect(result.turns[0]?.status).toBe("running");
    expect(result.turns[0]?.content).toBe("Working on it");
  });

  test("clears stale clarification when the incoming snapshot is newer", () => {
    const current: TaskDetail = {
      ...baseDetail,
      updatedAt: "2026-05-03T00:00:03.000Z",
      clarify: {
        promptId: "prompt-1",
        taskId: "task-1",
        message: "Which source should I use?",
        allowFreeform: true,
        options: [],
        createdAt: "2026-05-03T00:00:02.000Z",
      },
    };
    const incoming: TaskDetail = {
      ...baseDetail,
      updatedAt: "2026-05-03T00:00:04.000Z",
    };

    const result = mergeTaskDetail(current, incoming);

    expect(result.clarify).toBeUndefined();
  });
});
