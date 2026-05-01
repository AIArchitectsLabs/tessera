import { describe, expect, test } from "bun:test";
import { type TaskEvent, TaskEventSchema } from "./index.js";

describe("TaskEvent schemas", () => {
  test("parses task.updated event", () => {
    const obj = {
      type: "task.updated" as const,
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      task: {
        id: "task-1",
        workspaceRoot: "/workspace/acme",
        title: "Draft announcement",
        status: "active" as const,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    } satisfies TaskEvent;

    expect(TaskEventSchema.parse(obj)).toEqual(obj);
  });

  test("parses turn.created event", () => {
    const obj = {
      type: "turn.created" as const,
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      turn: {
        id: "turn-1",
        taskId: "task-1",
        role: "user" as const,
        content: "Draft a launch announcement",
        status: "queued" as const,
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    } satisfies TaskEvent;

    expect(TaskEventSchema.parse(obj)).toEqual(obj);
  });

  test("parses turn.status_changed event", () => {
    const obj = {
      type: "turn.status_changed" as const,
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      turn: {
        id: "turn-1",
        taskId: "task-1",
        role: "agent" as const,
        content: "Working on the draft.",
        status: "running" as const,
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    } satisfies TaskEvent;

    expect(TaskEventSchema.parse(obj)).toEqual(obj);
  });

  test("parses turn.completed event", () => {
    const obj = {
      type: "turn.completed" as const,
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      turn: {
        id: "turn-1",
        taskId: "task-1",
        role: "agent" as const,
        content: "Draft complete.",
        status: "completed" as const,
        createdAt: "2026-05-01T00:00:00.000Z",
        completedAt: "2026-05-01T00:00:01.000Z",
      },
    } satisfies TaskEvent;

    expect(TaskEventSchema.parse(obj)).toEqual(obj);
  });

  test("parses artifact.created event", () => {
    const obj = {
      type: "artifact.created" as const,
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      artifact: {
        id: "artifact-1",
        taskId: "task-1",
        kind: "text" as const,
        title: "Launch Announcement Draft",
        createdAt: "2026-05-01T00:00:01.000Z",
      },
    } satisfies TaskEvent;

    expect(TaskEventSchema.parse(obj)).toEqual(obj);
  });

  test("rejects unknown event type", () => {
    const obj = {
      type: "unknown.event",
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
    };

    expect(TaskEventSchema.safeParse(obj).success).toBe(false);
  });
});
