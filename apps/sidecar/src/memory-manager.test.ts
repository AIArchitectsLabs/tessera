import { afterEach, describe, expect, test } from "bun:test";
import type { TaskDetail, TaskTurn, WorkflowRunResult } from "@tessera/contracts";
import { createMemoryManager, createNoopMemoryManager } from "./memory-manager.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";

const stores: ReturnType<typeof createMemoryStore>[] = [];

function makeStore(): ReturnType<typeof createMemoryStore> {
  const store = createMemoryStore(":memory:");
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function task(): TaskDetail {
  return {
    id: "task-1",
    workspaceRoot: "/workspace/acme",
    title: "Weekly update",
    status: "active",
    agentId: "default",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    notifications: [],
    auditRecords: [],
    activeSkills: [],
    turns: [],
    artifacts: [],
  };
}

function turn(content: string, overrides: Partial<TaskTurn> = {}): TaskTurn {
  return {
    id: "turn-1",
    taskId: "task-1",
    role: "user",
    content,
    status: "completed",
    createdAt: "2026-05-13T00:00:00.000Z",
    completedAt: "2026-05-13T00:00:01.000Z",
    ...overrides,
  };
}

describe("memory manager", () => {
  test("records safe task turns and recalls them with trace metadata", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });

    await manager.recordTaskTurn({ task: task(), turn: turn("Prefer concise weekly updates.") });
    const recalled = await manager.recallForTask({
      task: task(),
      query: "weekly updates",
      mode: "task",
      maxCharacters: 800,
    });

    expect(recalled.context).toContain("<tessera-memory-context>");
    expect(recalled.result.items[0]?.sourceRefs).toEqual([{ type: "turn", id: "turn-1" }]);
    expect(recalled.result.trace.selectedCount).toBe(1);
  });

  test("rejects secret-looking task turns before indexing", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });

    await manager.recordTaskTurn({
      task: task(),
      turn: turn("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz"),
    });
    const recalled = await manager.recallForTask({
      task: task(),
      query: "authorization",
      mode: "task",
      maxCharacters: 800,
    });

    expect(store.getEventByKey("task:task-1:turn:turn-1:completed")?.content).toBe("");
    expect(recalled.context).toBe("");
    expect(recalled.result.items).toHaveLength(0);
  });

  test("no-op manager never throws and returns empty recall", async () => {
    const manager = createNoopMemoryManager();

    await manager.recordTaskTurn({ task: task(), turn: turn("Remember concise updates.") });
    const recalled = await manager.recallForTask({
      task: task(),
      query: "updates",
      mode: "task",
      maxCharacters: 800,
    });

    expect(recalled.context).toBe("");
    expect(recalled.result.items).toEqual([]);
  });

  test("store failures degrade to empty recall instead of throwing", async () => {
    const brokenStore: MemoryStore = {
      close() {},
      recordEvent() {
        throw new Error("boom");
      },
      getEventByKey() {
        return undefined;
      },
      indexDocument() {
        throw new Error("boom");
      },
      searchChunks() {
        throw new Error("boom");
      },
      upsertMemory(memory) {
        return memory;
      },
      listActiveMemories() {
        throw new Error("boom");
      },
      forgetMemory() {},
    };
    const manager = createMemoryManager({ store: brokenStore });

    await expect(
      manager.recordTaskTurn({ task: task(), turn: turn("Remember concise updates.") })
    ).resolves.toBeUndefined();
    const recalled = await manager.recallForTask({
      task: task(),
      query: "updates",
      mode: "task",
      maxCharacters: 800,
    });

    expect(recalled.context).toBe("");
    expect(recalled.result.trace.omittedReasons).toEqual(["memory recall failed"]);
  });

  test("retries document indexing when the event was already recorded", async () => {
    const store = makeStore();
    let failNextIndex = true;
    const flakyStore: MemoryStore = {
      ...store,
      indexDocument(document) {
        if (failNextIndex) {
          failNextIndex = false;
          throw new Error("temporary index failure");
        }
        store.indexDocument(document);
      },
      recordEvent(event) {
        if (store.getEventByKey(event.eventKey)) throw new Error("duplicate event write");
        return store.recordEvent(event);
      },
    };
    const manager = createMemoryManager({ store: flakyStore, ownerId: "local-owner" });

    await manager.recordTaskTurn({ task: task(), turn: turn("Prefer concise weekly updates.") });
    await manager.recordTaskTurn({ task: task(), turn: turn("Prefer concise weekly updates.") });
    const recalled = await manager.recallForTask({
      task: task(),
      query: "weekly updates",
      mode: "task",
      maxCharacters: 800,
    });

    expect(recalled.result.items[0]?.sourceRefs).toEqual([{ type: "turn", id: "turn-1" }]);
  });

  test("records workflow run projection as a playbook event", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });
    const run: WorkflowRunResult = {
      runId: "run-1",
      workflowId: "ops.weekly-status-digest",
      status: "completed",
      input: { workspaceRoot: "/workspace/acme" },
      sourceGaps: [],
      outputs: { draft: { text: "Weekly digest created" } },
      startedAt: "2026-05-13T00:00:00.000Z",
      completedAt: "2026-05-13T00:01:00.000Z",
    };

    await manager.recordWorkflowRun({ run, workspaceRoot: "/workspace/acme" });

    const event = store.getEventByKey("workflow:run-1:completed");
    expect(event?.eventType).toBe("playbook.run.completed");
    expect(event?.content).toContain("Output keys: draft");
    expect(event?.content).not.toContain("Weekly digest created");
  });

  test("screens workflow projections before recording", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });
    const run: WorkflowRunResult = {
      runId: "run-secret",
      workflowId: "ops.weekly-status-digest",
      status: "completed",
      input: { workspaceRoot: "/workspace/acme" },
      sourceGaps: [],
      outputs: { "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz": true },
      completedAt: "2026-05-13T00:01:00.000Z",
    };

    await manager.recordWorkflowRun({ run, workspaceRoot: "/workspace/acme" });

    const event = store.getEventByKey("workflow:run-secret:completed");
    expect(event?.content).toBe("");
    expect(event?.sensitivity).toBe("secret_suspect");
    expect(event?.capturePolicy).toBe("rejected");
  });
});
