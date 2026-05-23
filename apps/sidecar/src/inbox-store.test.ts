import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxStore } from "./inbox-store.js";

const tempDirs: string[] = [];

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-inbox-store-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("inbox store", () => {
  test("creates messages with an initial audit entry", () => {
    const store = createInboxStore(tempDbPath("inbox.sqlite"));
    try {
      const message = store.create({
        workspaceRoot: "/workspace/acme",
        taskId: "task-1",
        source: "task",
        type: "input_required",
        severity: "warning",
        title: "Clarification needed",
        context: { prompt: "Which market?" },
        actions: [{ id: "respond", label: "Respond", style: "primary" }],
      });

      expect(message.status).toBe("open");
      expect(message.audit).toHaveLength(1);
      expect(message.audit[0]?.event).toBe("created");
      expect(store.get(message.id)?.taskId).toBe("task-1");
    } finally {
      store.close();
    }
  });

  test("filters messages by status, type, workspace, and task", () => {
    const store = createInboxStore(tempDbPath("inbox.sqlite"));
    try {
      const taskMessage = store.create({
        workspaceRoot: "/workspace/acme",
        taskId: "task-1",
        source: "task",
        type: "review",
        severity: "info",
        title: "Review task output",
        context: { artifactId: "artifact-1" },
        actions: [{ id: "acknowledge", label: "Acknowledge", style: "secondary" }],
      });
      store.create({
        workspaceRoot: "/workspace/other",
        source: "task",
        type: "review",
        severity: "critical",
        title: "Review other workspace",
        context: { artifactId: "artifact-2" },
        actions: [{ id: "acknowledge", label: "Acknowledge", style: "secondary" }],
      });
      store.snooze(taskMessage.id, {
        snoozedUntil: "2026-05-06T10:00:00.000Z",
      });

      expect(store.list({ status: "snoozed" }).map((message) => message.id)).toEqual([
        taskMessage.id,
      ]);
      expect(store.list({ type: "review" })).toHaveLength(2);
      expect(store.list({ workspaceRoot: "/workspace/acme" })).toHaveLength(1);
      expect(store.list({ taskId: "task-1" })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("resolves, snoozes, and cancels messages with audit entries", () => {
    const store = createInboxStore(tempDbPath("inbox.sqlite"));
    try {
      const message = store.create({
        source: "system",
        type: "exception",
        severity: "critical",
        title: "Tool failed",
        context: { code: "TOOL_FAILED" },
        actions: [{ id: "acknowledge", label: "Acknowledge", style: "secondary" }],
      });

      const snoozed = store.snooze(message.id, {
        snoozedUntil: "2026-05-06T10:00:00.000Z",
        reason: "Handle tomorrow",
      });
      expect(snoozed?.status).toBe("snoozed");
      expect(snoozed?.snoozedUntil).toBe("2026-05-06T10:00:00.000Z");

      const resolved = store.resolve(message.id, {
        actionId: "acknowledge",
        payload: { note: "Seen" },
      });
      expect(resolved?.status).toBe("resolved");
      expect(resolved?.resolvedAt).toBeString();
      expect(resolved?.audit.map((entry) => entry.event)).toEqual([
        "created",
        "snoozed",
        "resolved",
      ]);

      const cancelledMessage = store.create({
        source: "system",
        type: "review",
        severity: "info",
        title: "Stale review",
        context: {},
        actions: [{ id: "acknowledge", label: "Acknowledge", style: "secondary" }],
      });
      const cancelled = store.cancel(cancelledMessage.id, { reason: "Superseded" });
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.audit.at(-1)?.payload).toEqual({ reason: "Superseded" });
    } finally {
      store.close();
    }
  });

  test("rejects resolving with an unavailable action", () => {
    const store = createInboxStore(tempDbPath("inbox.sqlite"));
    try {
      const message = store.create({
        source: "task",
        type: "input_required",
        severity: "warning",
        title: "Clarification needed",
        context: {},
        actions: [{ id: "respond", label: "Respond", style: "primary" }],
      });

      expect(() => store.resolve(message.id, { actionId: "approve" })).toThrow(
        "Inbox action is not available"
      );
    } finally {
      store.close();
    }
  });

  test("persists messages across store instances", () => {
    const dbPath = tempDbPath("inbox.sqlite");
    const first = createInboxStore(dbPath);
    const created = first.create({
      source: "integration",
      type: "credential",
      severity: "warning",
      title: "Connect Google Workspace",
      context: { provider: "google-workspace" },
      actions: [{ id: "open-settings", label: "Open settings", style: "primary" }],
    });
    first.close();

    const second = createInboxStore(dbPath);
    try {
      expect(second.get(created.id)?.title).toBe("Connect Google Workspace");
      expect(second.list({ status: "open" })).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  test("consumes messages once and records consumed audit", () => {
    const store = createInboxStore(tempDbPath("inbox-consume.sqlite"));
    try {
      const message = store.create({
        source: "system",
        type: "approval",
        severity: "info",
        title: "Write to sheet rows.append",
        context: { command: "sheets", subcommand: "rows.append" },
        actions: [{ id: "approve", label: "Approve", style: "primary" }],
      });

      const consumed = store.consume(message.id, "agent:test");
      expect(consumed?.status).toBe("consumed");
      expect(consumed?.consumedAt).toBeString();
      expect(consumed?.audit.at(-1)?.event).toBe("consumed");

      expect(() => store.consume(message.id, "agent:test")).toThrow(
        "Inbox message cannot be consumed in current state: consumed"
      );
    } finally {
      store.close();
    }
  });
});
