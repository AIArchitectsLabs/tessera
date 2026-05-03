import { describe, expect, test } from "bun:test";
import type { TaskArtifact, TaskDetail, TaskEvent, TaskTurn } from "@tessera/contracts";
import { applyTaskEvent } from "./applyTaskEvent.js";

const baseTurn: TaskTurn = {
  id: "turn-1",
  taskId: "task-1",
  role: "user",
  content: "Hello",
  status: "completed",
  createdAt: "2026-05-01T00:00:00.000Z",
};

const baseDetail: TaskDetail = {
  id: "task-1",
  workspaceRoot: "/workspace",
  title: "Test task",
  status: "active",
  agentId: "default",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  notifications: [],
  auditRecords: [],
  turns: [baseTurn],
  artifacts: [],
};

describe("applyTaskEvent", () => {
  test("task.updated merges summary fields", () => {
    const event: TaskEvent = {
      type: "task.updated",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      task: {
        id: "task-1",
        workspaceRoot: "/workspace",
        title: "Test task",
        status: "active",
        agentId: "default",
        latestActivity: "Drafting",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    };

    const result = applyTaskEvent(baseDetail, event);
    expect(result.latestActivity).toBe("Drafting");
    expect(result.turns).toBe(baseDetail.turns);
  });

  test("turn.created appends new turn", () => {
    const newTurn: TaskTurn = {
      id: "turn-2",
      taskId: "task-1",
      role: "agent",
      content: "World",
      status: "queued",
      createdAt: "2026-05-01T00:00:00.000Z",
    };
    const event: TaskEvent = {
      type: "turn.created",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      turn: newTurn,
    };

    const result = applyTaskEvent(baseDetail, event);
    expect(result.turns.length).toBe(2);
    expect(result.turns[result.turns.length - 1]).toBe(newTurn);
  });

  test("task.todo_updated replaces the todo snapshot", () => {
    const result = applyTaskEvent(baseDetail, {
      type: "task.todo_updated",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      todo: {
        updatedAt: "2026-05-01T00:00:00.000Z",
        items: [{ id: "todo-1", label: "Draft", status: "pending", order: 0 }],
      },
    });

    expect(result.todo?.items[0]?.label).toBe("Draft");
  });

  test("turn.created deduplicates existing turn", () => {
    const event: TaskEvent = {
      type: "turn.created",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      turn: baseTurn,
    };

    const result = applyTaskEvent(baseDetail, event);
    expect(result.turns.length).toBe(1);
  });

  test("turn.status_changed replaces turn by id", () => {
    const updatedTurn: TaskTurn = {
      ...baseTurn,
      status: "running",
    };
    const event: TaskEvent = {
      type: "turn.status_changed",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      turn: updatedTurn,
    };

    const result = applyTaskEvent(baseDetail, event);
    expect(result.turns[0]?.status).toBe("running");
  });

  test("turn.completed replaces turn by id", () => {
    const completedTurn: TaskTurn = {
      ...baseTurn,
      status: "completed",
      completedAt: "2026-05-01T00:01:00.000Z",
    };
    const event: TaskEvent = {
      type: "turn.completed",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      turn: completedTurn,
    };

    const result = applyTaskEvent(baseDetail, event);
    expect(result.turns[0]).toBe(completedTurn);
    expect(result.turns[0]?.completedAt).toBe("2026-05-01T00:01:00.000Z");
  });

  test("artifact.created appends new artifact", () => {
    const artifact: TaskArtifact = {
      id: "artifact-1",
      taskId: "task-1",
      kind: "text",
      title: "Output",
      createdAt: "2026-05-01T00:00:00.000Z",
    };
    const event: TaskEvent = {
      type: "artifact.created",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      artifact,
    };

    const result = applyTaskEvent(baseDetail, event);
    expect(result.artifacts.length).toBe(1);
  });

  test("artifact.created deduplicates existing artifact", () => {
    const artifact: TaskArtifact = {
      id: "artifact-1",
      taskId: "task-1",
      kind: "text",
      title: "Output",
      createdAt: "2026-05-01T00:00:00.000Z",
    };
    const detailWithArtifact: TaskDetail = { ...baseDetail, artifacts: [artifact] };
    const event: TaskEvent = {
      type: "artifact.created",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      artifact,
    };

    const result = applyTaskEvent(detailWithArtifact, event);
    expect(result.artifacts.length).toBe(1);
  });

  test("ignores event for different taskId", () => {
    const event: TaskEvent = {
      type: "task.updated",
      taskId: "task-other",
      emittedAt: "2026-05-01T00:00:00.000Z",
      task: {
        id: "task-other",
        workspaceRoot: "/workspace",
        title: "Other task",
        status: "active",
        agentId: "default",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    };

    const result = applyTaskEvent(baseDetail, event);
    expect(result).toBe(baseDetail);
  });
});
