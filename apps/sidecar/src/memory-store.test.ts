import { afterEach, describe, expect, test } from "bun:test";
import type { Memory, MemoryCandidate, MemoryEvent } from "@tessera/contracts";
import { createMemoryStore } from "./memory-store.js";

const stores: ReturnType<typeof createMemoryStore>[] = [];

function makeStore(): ReturnType<typeof createMemoryStore> {
  const store = createMemoryStore(":memory:");
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "memory-event-1",
    eventKey: "task:task-1:turn:turn-1:completed",
    workspaceKey: "workspace:one",
    ownerId: "local-owner",
    scope: "task",
    subjectType: "turn",
    subjectId: "turn-1",
    eventType: "task.turn.completed",
    content: "Draft a weekly revenue update.",
    contentHash: "sha256:one",
    metadata: { taskId: "task-1" },
    sensitivity: "public",
    capturePolicy: "summary",
    schemaVersion: 1,
    createdAt: "2026-05-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory store", () => {
  test("records events idempotently by event key", () => {
    const store = makeStore();

    const first = store.recordEvent(event());
    const second = store.recordEvent(event({ id: "memory-event-2", content: "Changed retry" }));

    expect(second.id).toBe(first.id);
    expect(store.getEventById(first.id)?.eventKey).toBe("task:task-1:turn:turn-1:completed");
    expect(store.getEventByKey("task:task-1:turn:turn-1:completed")?.content).toBe(
      "Draft a weekly revenue update."
    );
  });

  test("indexes and searches documents inside a workspace boundary", () => {
    const store = makeStore();
    store.indexDocument({
      id: "doc-1",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "task",
      kind: "event",
      sourceId: "memory-event-1",
      title: "Weekly update",
      content: "Customer renewals and weekly revenue update.",
      metadata: {},
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    store.indexDocument({
      id: "doc-2",
      workspaceKey: "workspace:two",
      ownerId: "local-owner",
      scope: "task",
      kind: "event",
      sourceId: "memory-event-2",
      title: "Hidden update",
      content: "Customer renewals from another workspace.",
      metadata: {},
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });

    const results = store.searchChunks({
      workspaceKey: "workspace:one",
      query: "customer renewals",
      limit: 5,
    });

    expect(results.map((result) => result.documentId)).toEqual(["doc-1"]);
  });

  test("searches documents inside combined workspace and owner boundaries", () => {
    const store = makeStore();
    store.indexDocument({
      id: "doc-owner-1",
      workspaceKey: "workspace:one",
      ownerId: "owner-one",
      scope: "task",
      kind: "event",
      sourceId: "memory-event-1",
      title: "Owner one",
      content: "Alpha renewal details.",
      metadata: { taskId: "task-1" },
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    store.indexDocument({
      id: "doc-owner-2",
      workspaceKey: "workspace:one",
      ownerId: "owner-two",
      scope: "task",
      kind: "event",
      sourceId: "memory-event-2",
      title: "Owner two",
      content: "Alpha renewal details.",
      metadata: { taskId: "task-2" },
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });

    const results = store.searchChunks({
      workspaceKey: "workspace:one",
      ownerId: "owner-one",
      query: "alpha",
      limit: 5,
    });

    expect(results.map((result) => result.documentId)).toEqual(["doc-owner-1"]);
    expect(results[0]?.metadata).toEqual({ taskId: "task-1" });
  });

  test("sanitizes malformed FTS input and returns no rows for empty queries", () => {
    const store = makeStore();
    store.indexDocument({
      id: "doc-fts",
      workspaceKey: "workspace:one",
      scope: "task",
      kind: "event",
      sourceId: "memory-event-1",
      content: "Alpha beta renewal details.",
      metadata: {},
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(store.searchChunks({ workspaceKey: "workspace:one", query: '"', limit: 5 })).toEqual([]);
    expect(
      store.searchChunks({ workspaceKey: "workspace:one", query: "alpha -beta", limit: 5 })
    ).toHaveLength(1);
  });

  test("reindexing a document removes stale FTS rows", () => {
    const store = makeStore();
    const document = {
      id: "doc-reindex",
      workspaceKey: "workspace:one",
      scope: "task" as const,
      kind: "event" as const,
      sourceId: "memory-event-1",
      metadata: {},
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    store.indexDocument({ ...document, content: "Old renewal language." });
    store.indexDocument({ ...document, content: "Fresh pipeline language." });

    expect(
      store.searchChunks({ workspaceKey: "workspace:one", query: "old", limit: 5 })
    ).toHaveLength(0);
    expect(
      store.searchChunks({ workspaceKey: "workspace:one", query: "fresh", limit: 5 })
    ).toHaveLength(1);
  });

  test("archives active memories so they no longer recall", () => {
    const store = makeStore();
    const memory: Memory = {
      id: "memory-1",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "workspace",
      type: "preference",
      title: "Style",
      body: "Prefer concise bullets.",
      status: "active",
      confidence: 0.9,
      freshness: "fresh",
      sourceEventIds: ["memory-event-1"],
      sourceDocumentIds: ["doc-1"],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    store.upsertMemory(memory);
    expect(store.listActiveMemories({ workspaceKey: "workspace:one" })).toHaveLength(1);

    store.forgetMemory({
      memoryId: "memory-1",
      reason: "User asked to forget it",
      requestedAt: "2026-05-13T00:01:00.000Z",
    });

    expect(store.listActiveMemories({ workspaceKey: "workspace:one" })).toHaveLength(0);
  });

  test("delete forget removes linked indexed content and marks sources forgotten", () => {
    const store = makeStore();
    const memory: Memory = {
      id: "memory-1",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "workspace",
      type: "preference",
      title: "Style",
      body: "Prefer renewal summaries.",
      status: "active",
      confidence: 0.9,
      freshness: "fresh",
      sourceEventIds: ["memory-event-1"],
      sourceDocumentIds: ["doc-1"],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    store.recordEvent(event());
    store.indexDocument({
      id: "doc-1",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "task",
      kind: "event",
      sourceId: "memory-event-1",
      title: "Weekly update",
      content: "Renewal summaries should be concise.",
      metadata: {},
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    store.upsertMemory(memory);

    expect(
      store.searchChunks({ workspaceKey: "workspace:one", query: "renewal", limit: 5 })
    ).toHaveLength(1);

    store.forgetMemory({
      memoryId: "memory-1",
      action: "delete",
      reason: "User asked to forget it",
      requestedAt: "2026-05-13T00:01:00.000Z",
    });

    expect(store.listActiveMemories({ workspaceKey: "workspace:one" })).toHaveLength(0);
    expect(
      store.searchChunks({ workspaceKey: "workspace:one", query: "renewal", limit: 5 })
    ).toHaveLength(0);
    expect(store.isSourceForgotten("memory-event-1")).toBe(true);
    expect(store.isSourceForgotten("doc-1")).toBe(true);
  });

  test("lists active memories inside combined workspace and owner boundaries", () => {
    const store = makeStore();
    const baseMemory: Memory = {
      id: "memory-1",
      workspaceKey: "workspace:one",
      ownerId: "owner-one",
      scope: "workspace",
      type: "preference",
      title: "Style",
      body: "Prefer concise bullets.",
      status: "active",
      confidence: 0.9,
      freshness: "fresh",
      sourceEventIds: ["memory-event-1"],
      sourceDocumentIds: ["doc-1"],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    store.upsertMemory(baseMemory);
    store.upsertMemory({ ...baseMemory, id: "memory-2", ownerId: "owner-two" });

    expect(
      store
        .listActiveMemories({ workspaceKey: "workspace:one", ownerId: "owner-one" })
        .map((memory) => memory.id)
    ).toEqual(["memory-1"]);
  });

  test("lists active memories across workspaces for review", () => {
    const store = makeStore();
    const baseMemory: Memory = {
      id: "memory-1",
      workspaceKey: "workspace:one",
      ownerId: "owner-one",
      scope: "workspace",
      type: "preference",
      title: "Weekly style",
      body: "Prefer concise bullets.",
      status: "active",
      confidence: 0.9,
      freshness: "fresh",
      sourceEventIds: ["event-1"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    store.upsertMemory(baseMemory);
    store.upsertMemory({ ...baseMemory, id: "memory-2", workspaceKey: "workspace:two" });
    store.upsertMemory({ ...baseMemory, id: "memory-3", ownerId: "owner-two" });

    expect(store.listActiveMemories({ ownerId: "owner-one" }).map((memory) => memory.id)).toEqual([
      "memory-2",
      "memory-1",
    ]);
  });

  test("lists candidate memories inside combined workspace and owner boundaries", () => {
    const store = makeStore();
    const baseCandidate: MemoryCandidate = {
      id: "memory-candidate-1",
      workspaceKey: "workspace:one",
      ownerId: "owner-one",
      scope: "workspace",
      type: "preference",
      title: "Weekly update style",
      body: "Prefer concise weekly updates.",
      status: "candidate",
      confidence: 0.72,
      freshness: "fresh",
      sourceEventIds: ["memory-event-1"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      rationale: {
        supportingEventIds: ["memory-event-1"],
        conflictingMemoryIds: [],
        promotionReason: "Explicit memory request.",
        riskFlags: [],
      },
    };

    store.upsertMemory(baseCandidate);
    store.upsertMemory({ ...baseCandidate, id: "memory-candidate-2", ownerId: "owner-two" });
    store.upsertMemory({ ...baseCandidate, id: "memory-active-1", status: "active" });

    expect(
      store
        .listCandidateMemories({ workspaceKey: "workspace:one", ownerId: "owner-one" })
        .map((memory) => memory.id)
    ).toEqual(["memory-candidate-1"]);
  });

  test("normalizes non-positive active memory limits to the default bound", () => {
    const store = makeStore();
    const baseMemory: Memory = {
      id: "memory-0",
      workspaceKey: "workspace:one",
      scope: "workspace",
      type: "preference",
      title: "Style",
      body: "Prefer concise bullets.",
      status: "active",
      confidence: 0.9,
      freshness: "fresh",
      sourceEventIds: ["memory-event-1"],
      sourceDocumentIds: ["doc-1"],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    for (let index = 0; index < 10; index++) {
      store.upsertMemory({
        ...baseMemory,
        id: `memory-${index}`,
        confidence: 1 - index / 100,
      });
    }

    expect(store.listActiveMemories({ workspaceKey: "workspace:one", limit: -1 })).toHaveLength(8);
  });
});
