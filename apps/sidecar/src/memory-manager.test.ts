import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentProviderConfig,
  TaskDetail,
  TaskTurn,
  WorkflowRunResult,
} from "@tessera/contracts";
import { workspaceKeyForRoot } from "@tessera/core";
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
      getEventById() {
        return undefined;
      },
      getEventByKey() {
        return undefined;
      },
      getMemoryById() {
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
      listCandidateMemories() {
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

  test("auto-promotes high-confidence explicit memory requests", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });

    await manager.recordTaskTurn({
      task: task(),
      turn: turn("Remember that weekly customer updates should use concise bullets."),
    });
    const eventId = store.getEventByKey("task:task-1:turn:turn-1:completed")?.id;
    if (!eventId) throw new Error("Missing recorded memory event");

    const [candidate] = await manager.proposeCandidates({ eventIds: [eventId] });
    if (!candidate) throw new Error("Missing extracted memory");

    expect(candidate.status).toBe("active");
    expect(candidate.scope).toBe("workspace");
    expect(candidate.type).toBe("preference");
    expect(candidate.body).toBe("weekly customer updates should use concise bullets.");
    expect(candidate.sourceEventIds).toEqual([eventId]);
    expect(
      store
        .listActiveMemories({
          workspaceKey: candidate.workspaceKey ?? "",
          ownerId: "local-owner",
        })
        .map((memory) => memory.id)
    ).toEqual([candidate.id]);
  });

  test("semantic extraction promotes stable preferences without explicit remember phrasing", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });

    await manager.recordTaskTurn({
      task: task(),
      turn: turn("For future weekly updates, prefer concise bullets with source links."),
    });
    const eventId = store.getEventByKey("task:task-1:turn:turn-1:completed")?.id;
    if (!eventId) throw new Error("Missing recorded memory event");

    const [memory] = await manager.proposeCandidates({ eventIds: [eventId] });

    expect(memory?.status).toBe("active");
    expect(memory?.type).toBe("preference");
    expect(memory?.body).toBe("prefer concise bullets with source links.");
  });

  test("model-backed semantic extraction uses the configured provider and credential", async () => {
    const store = makeStore();
    const provider: AgentProviderConfig = {
      provider: "openai",
      model: "gpt-5.4",
      apiKeyEnv: "OPENAI_API_KEY",
    };
    const calls: Array<{ provider: AgentProviderConfig; credential?: unknown; prompt: string }> =
      [];
    const manager = createMemoryManager({
      store,
      ownerId: "local-owner",
      modelTurnExecutor: async (request) => {
        const eventId = /"id":\s*"([^"]+)"/.exec(request.prompt)?.[1] ?? "";
        calls.push({
          provider: request.provider,
          credential: request.credential,
          prompt: request.prompt,
        });
        return {
          status: "completed",
          messages: [
            {
              role: "assistant",
              text: JSON.stringify({
                memories: [
                  {
                    sourceEventIds: [eventId],
                    type: "preference",
                    title: "Weekly update style",
                    body: "Prefer concise bullets with source links.",
                    confidence: 0.92,
                    promotionReason: "The user described a stable future formatting preference.",
                  },
                ],
              }),
            },
          ],
          toolResults: [],
          permissionDecisions: [],
        };
      },
    });

    await manager.recordTaskTurn({
      task: task(),
      turn: turn("Weekly update finished."),
    });
    const eventId = store.getEventByKey("task:task-1:turn:turn-1:completed")?.id;
    if (!eventId) throw new Error("Missing recorded memory event");

    const [memory] = await manager.proposeCandidates({
      eventIds: [eventId],
      provider,
      credential: { apiKey: "sk-test" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toEqual(provider);
    expect(calls[0]?.credential).toEqual({ apiKey: "sk-test" });
    expect(calls[0]?.prompt).toContain(eventId);
    expect(memory?.status).toBe("active");
    expect(memory?.body).toBe("Prefer concise bullets with source links.");
    expect(memory?.sourceEventIds).toEqual([eventId]);
  });

  test("falls back to local semantic extraction when model extraction is unavailable", async () => {
    const store = makeStore();
    const manager = createMemoryManager({
      store,
      ownerId: "local-owner",
      modelTurnExecutor: async () => ({
        status: "error",
        messages: [],
        toolResults: [],
        permissionDecisions: [],
        error: "model unavailable",
      }),
    });

    await manager.recordTaskTurn({
      task: task(),
      turn: turn("For future weekly updates, prefer concise bullets with source links."),
    });
    const eventId = store.getEventByKey("task:task-1:turn:turn-1:completed")?.id;
    if (!eventId) throw new Error("Missing recorded memory event");

    const [memory] = await manager.proposeCandidates({
      eventIds: [eventId],
      provider: { provider: "local", model: "local", baseUrl: "http://127.0.0.1:11434/v1" },
    });

    expect(memory?.status).toBe("active");
    expect(memory?.body).toBe("prefer concise bullets with source links.");
  });

  test("semantic low-confidence extractions stay as review candidates", async () => {
    const store = makeStore();
    const manager = createMemoryManager({
      store,
      ownerId: "local-owner",
      semanticExtractor: {
        async extract({ events }) {
          return [
            {
              sourceEventIds: [events[0]?.id ?? ""],
              type: "preference",
              title: "Weekly style",
              body: "Prefer a single paragraph.",
              confidence: 0.6,
              promotionReason: "Semantic extraction needs review.",
            },
          ];
        },
      },
    });

    await manager.recordTaskTurn({ task: task(), turn: turn("Weekly update finished.") });
    const eventId = store.getEventByKey("task:task-1:turn:turn-1:completed")?.id;
    if (!eventId) throw new Error("Missing recorded memory event");

    const [candidate] = await manager.proposeCandidates({ eventIds: [eventId] });
    if (!candidate || candidate.status !== "candidate") {
      throw new Error("Missing review candidate");
    }
    const [reviewCandidate] = store.listCandidateMemories({
      workspaceKey: candidate.workspaceKey ?? "",
    });
    if (!reviewCandidate) throw new Error("Missing stored review candidate");

    expect(reviewCandidate.rationale.riskFlags).toEqual(["low_confidence"]);
    expect(store.listActiveMemories({ workspaceKey: candidate.workspaceKey ?? "" })).toHaveLength(
      0
    );
    expect(
      store.listCandidateMemories({ workspaceKey: candidate.workspaceKey ?? "" }).map((memory) => ({
        id: memory.id,
        reason: memory.rationale.promotionReason,
      }))
    ).toEqual([{ id: candidate.id, reason: "Semantic extraction needs review." }]);
  });

  test("semantic conflicts stay as review candidates instead of overwriting active memory", async () => {
    const store = makeStore();
    const workspaceKey = workspaceKeyForRoot("/workspace/acme");
    store.upsertMemory({
      id: "memory-active-style",
      workspaceKey,
      ownerId: "local-owner",
      scope: "workspace",
      type: "preference",
      title: "Weekly style",
      body: "Prefer detailed narrative updates.",
      status: "active",
      confidence: 0.9,
      freshness: "fresh",
      sourceEventIds: ["memory-event-old"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    const manager = createMemoryManager({
      store,
      ownerId: "local-owner",
      semanticExtractor: {
        async extract({ events }) {
          return [
            {
              sourceEventIds: [events[0]?.id ?? ""],
              type: "preference",
              title: "Weekly style",
              body: "Prefer concise bullet updates.",
              confidence: 0.94,
              promotionReason: "Semantic extraction found a stable preference.",
            },
          ];
        },
      },
    });

    await manager.recordTaskTurn({ task: task(), turn: turn("Prefer concise bullet updates.") });
    const eventId = store.getEventByKey("task:task-1:turn:turn-1:completed")?.id;
    if (!eventId) throw new Error("Missing recorded memory event");

    const [candidate] = await manager.proposeCandidates({ eventIds: [eventId] });
    if (!candidate || candidate.status !== "candidate") {
      throw new Error("Missing conflicting review candidate");
    }
    const [reviewCandidate] = store.listCandidateMemories({ workspaceKey });
    if (!reviewCandidate) throw new Error("Missing stored conflicting review candidate");

    expect(reviewCandidate.rationale.conflictingMemoryIds).toEqual(["memory-active-style"]);
    expect(reviewCandidate.rationale.riskFlags).toEqual(["stale"]);
    expect(store.listActiveMemories({ workspaceKey })).toHaveLength(1);
  });

  test("semantic extraction is idempotent and skips rejected event content", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });

    await manager.recordTaskTurn({
      task: task(),
      turn: turn("Remember Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz"),
    });
    const eventId = store.getEventByKey("task:task-1:turn:turn-1:completed")?.id;
    if (!eventId) throw new Error("Missing recorded memory event");

    expect(await manager.proposeCandidates({ eventIds: [eventId] })).toEqual([]);

    await manager.recordTaskTurn({
      task: task(),
      turn: turn("Remember that weekly customer updates should use concise bullets.", {
        id: "turn-2",
      }),
    });
    const safeEventId = store.getEventByKey("task:task-1:turn:turn-2:completed")?.id;
    if (!safeEventId) throw new Error("Missing recorded safe memory event");

    const first = await manager.proposeCandidates({ eventIds: [safeEventId] });
    const second = await manager.proposeCandidates({ eventIds: [safeEventId] });

    expect(second.map((candidate) => candidate.id)).toEqual(first.map((candidate) => candidate.id));
    expect(store.listActiveMemories({ workspaceKey: first[0]?.workspaceKey ?? "" })).toHaveLength(
      1
    );
  });
});
