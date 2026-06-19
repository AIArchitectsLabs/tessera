import { describe, expect, test } from "bun:test";
import { SidecarReadySchema, type TaskEvent, TaskEventSchema } from "./index.js";

describe("SidecarReady schema", () => {
  test("reports graph run worker readiness and defaults old sidecars to disabled", () => {
    expect(
      SidecarReadySchema.parse({
        type: "ready",
        transport: "unix",
        path: "/tmp/tessera.sock",
        token: "token",
        graphRunWorker: true,
      })
    ).toEqual({
      type: "ready",
      transport: "unix",
      path: "/tmp/tessera.sock",
      token: "token",
      graphRunWorker: true,
    });
    expect(
      SidecarReadySchema.parse({
        type: "ready",
        transport: "tcp",
        port: 1234,
        token: "token",
      }).graphRunWorker
    ).toBe(false);
  });
});

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
        agentId: "default",
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

  test("parses task.playbook_imported event", () => {
    const obj = {
      type: "task.playbook_imported" as const,
      taskId: "task-1",
      emittedAt: "2026-05-01T00:00:00.000Z",
      playbookId: "weekly-email-summary",
      packagePath: "playbooks/weekly-email-summary",
      versionBumpedFrom: "0.1.0",
      import: {
        schemaVersion: 1 as const,
        status: "installed" as const,
        id: "weekly-email-summary",
        version: "0.1.1",
        name: "Weekly Email Summary",
        graphHash: `sha256:${"a".repeat(64)}`,
        sourceHash: `sha256:${"b".repeat(64)}`,
        warnings: [],
      },
    } satisfies TaskEvent;

    expect(TaskEventSchema.parse(obj)).toEqual(obj);
  });

  test("rejects malformed emittedAt", () => {
    const obj = {
      type: "task.updated",
      taskId: "task-1",
      emittedAt: "not-a-date",
      task: {
        id: "task-1",
        workspaceRoot: "/workspace",
        title: "Test task",
        status: "active" as const,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    };
    expect(TaskEventSchema.safeParse(obj).success).toBe(false);
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
