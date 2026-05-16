import { describe, expect, test } from "bun:test";
import type {
  CompiledPlaybookGraph,
  PlaybookGraphArtifactVersion,
  PlaybookGraphBranchItem,
  PlaybookGraphNodeMemo,
  PlaybookGraphOperationRecord,
  PlaybookGraphQueueEntry,
  PlaybookGraphReviewEvent,
  PlaybookGraphRunListFilter,
  PlaybookGraphRunRecord,
} from "@tessera/contracts";
import { compilePlaybookGraph } from "./playbook-graph-compiler.js";
import {
  type GraphRunStore,
  createGraphNodeMemoKeyParts,
  createPlaybookGraphExecutionContextPin,
  createPlaybookGraphMemoKey,
  createPlaybookGraphQueueEntry,
  createPlaybookGraphRun,
  createPlaybookGraphSnapshot,
  drainPlaybookGraphRun,
  parsePinnedCompiledGraph,
} from "./playbook-graph-runtime.js";

class MemoryGraphRunStore implements GraphRunStore {
  runs = new Map<string, PlaybookGraphRunRecord>();
  queue = new Map<string, PlaybookGraphQueueEntry>();
  artifacts = new Map<string, PlaybookGraphArtifactVersion>();
  branchItems = new Map<string, PlaybookGraphBranchItem>();
  reviews: PlaybookGraphReviewEvent[] = [];
  operations: PlaybookGraphOperationRecord[] = [];
  memos = new Map<string, PlaybookGraphNodeMemo>();

  async createRun(run: PlaybookGraphRunRecord): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async createRunWithQueue(input: {
    run: PlaybookGraphRunRecord;
    queueEntries: PlaybookGraphQueueEntry[];
  }): Promise<void> {
    this.runs.set(input.run.runId, input.run);
    for (const entry of input.queueEntries) {
      this.queue.set(entry.queueEntryId, entry);
    }
  }

  async getRun(runId: string): Promise<PlaybookGraphRunRecord | undefined> {
    return this.runs.get(runId);
  }

  async updateRun(run: PlaybookGraphRunRecord): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async listRuns(filter?: PlaybookGraphRunListFilter): Promise<PlaybookGraphRunRecord[]> {
    return [...this.runs.values()].filter(
      (run) =>
        (filter?.playbookId === undefined || run.playbookId === filter.playbookId) &&
        (filter?.status === undefined || run.status === filter.status)
    );
  }

  async getQueue(runId: string): Promise<PlaybookGraphQueueEntry[]> {
    return [...this.queue.values()].filter((entry) => entry.runId === runId);
  }

  async upsertQueueEntry(entry: PlaybookGraphQueueEntry): Promise<void> {
    this.queue.set(entry.queueEntryId, entry);
  }

  async updateQueueEntry(entry: PlaybookGraphQueueEntry): Promise<void> {
    this.queue.set(entry.queueEntryId, entry);
  }

  async claimNextQueuedEntry(input: {
    runId: string;
    runtimeId: string;
    leaseId: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<PlaybookGraphQueueEntry | undefined> {
    const queue = [...this.queue.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
    for (const entry of queue) {
      if (entry.runId !== input.runId || entry.status !== "queued") continue;
      const dependencies = entry.dependsOn.map((id) => this.queue.get(id));
      if (
        dependencies.some(
          (dependency) =>
            !dependency || !["succeeded", "memoized", "skipped"].includes(dependency.status)
        )
      ) {
        continue;
      }
      if (
        entry.consumesArtifacts.some((artifact) => {
          const version = this.artifacts.get(
            `${entry.runId}:${artifact.artifactId}:${artifact.versionId}`
          );
          return !version || version.contentHash !== artifact.contentHash;
        })
      ) {
        continue;
      }
      const claimed = {
        ...entry,
        status: "running" as const,
        runtimeId: input.runtimeId,
        leaseId: input.leaseId,
        claimedAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
        attempt: entry.attempt + 1,
        updatedAt: input.now,
      };
      this.queue.set(claimed.queueEntryId, claimed);
      return claimed;
    }
    return undefined;
  }

  async renewQueueLease(input: {
    runId: string;
    queueEntryId: string;
    runtimeId: string;
    leaseId: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<boolean> {
    const entry = this.queue.get(input.queueEntryId);
    if (
      !entry ||
      entry.runId !== input.runId ||
      entry.runtimeId !== input.runtimeId ||
      entry.leaseId !== input.leaseId ||
      entry.status !== "running"
    ) {
      return false;
    }
    this.queue.set(entry.queueEntryId, {
      ...entry,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now,
    });
    return true;
  }

  async releaseQueueLease(input: {
    runId: string;
    queueEntryId: string;
    runtimeId: string;
    leaseId: string;
    now: string;
  }): Promise<boolean> {
    const entry = this.queue.get(input.queueEntryId);
    if (
      !entry ||
      entry.runId !== input.runId ||
      entry.runtimeId !== input.runtimeId ||
      entry.leaseId !== input.leaseId ||
      entry.status !== "running"
    ) {
      return false;
    }
    this.queue.set(entry.queueEntryId, {
      ...entry,
      status: "queued",
      runtimeId: undefined,
      leaseId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      updatedAt: input.now,
    });
    return true;
  }

  async listArtifactVersions(runId: string): Promise<PlaybookGraphArtifactVersion[]> {
    return [...this.artifacts.values()].filter((version) => version.runId === runId);
  }

  async addArtifactVersion(version: PlaybookGraphArtifactVersion): Promise<void> {
    this.artifacts.set(`${version.runId}:${version.artifactId}:${version.versionId}`, version);
  }

  async getArtifactVersion(
    runId: string,
    artifactId: string,
    versionId: string
  ): Promise<PlaybookGraphArtifactVersion | undefined> {
    return this.artifacts.get(`${runId}:${artifactId}:${versionId}`);
  }

  async listBranchItems(runId: string): Promise<PlaybookGraphBranchItem[]> {
    return [...this.branchItems.values()].filter((item) => item.runId === runId);
  }

  async upsertBranchItem(item: PlaybookGraphBranchItem): Promise<void> {
    this.branchItems.set(item.branchItemId, item);
  }

  async listReviewEvents(runId: string): Promise<PlaybookGraphReviewEvent[]> {
    return this.reviews.filter((event) => event.runId === runId);
  }

  async addReviewEvent(event: PlaybookGraphReviewEvent): Promise<void> {
    this.reviews.push(event);
  }

  async listOperationRecords(runId: string): Promise<PlaybookGraphOperationRecord[]> {
    return this.operations.filter((record) => record.runId === runId);
  }

  async addOperationRecord(record: PlaybookGraphOperationRecord): Promise<void> {
    this.operations.push(record);
  }

  async applyGraphMutationWithOperationRecord(input: {
    run?: PlaybookGraphRunRecord;
    queueEntries?: PlaybookGraphQueueEntry[];
    branchItems?: PlaybookGraphBranchItem[];
    artifactVersions?: PlaybookGraphArtifactVersion[];
    reviewEvents?: PlaybookGraphReviewEvent[];
    operationRecord: PlaybookGraphOperationRecord;
  }): Promise<void> {
    if (input.run) this.runs.set(input.run.runId, input.run);
    for (const entry of input.queueEntries ?? []) this.queue.set(entry.queueEntryId, entry);
    for (const item of input.branchItems ?? []) this.branchItems.set(item.branchItemId, item);
    for (const version of input.artifactVersions ?? []) await this.addArtifactVersion(version);
    for (const event of input.reviewEvents ?? []) this.reviews.push(event);
    this.operations.push(input.operationRecord);
  }

  async getMemo(runId: string, nodeMemoKey: string): Promise<PlaybookGraphNodeMemo | undefined> {
    return this.memos.get(`${runId}:${nodeMemoKey}`);
  }

  async putMemo(memo: PlaybookGraphNodeMemo): Promise<void> {
    this.memos.set(`${memo.runId}:${memo.nodeMemoKey}`, memo);
  }

  async markStaleQueueLeasesInterrupted(input: {
    runId: string;
    runtimeId: string;
    now: string;
    interruptedAt: string;
  }): Promise<number> {
    let count = 0;
    for (const entry of this.queue.values()) {
      if (
        entry.runId === input.runId &&
        entry.status === "running" &&
        entry.leaseExpiresAt &&
        entry.leaseExpiresAt <= input.now
      ) {
        this.queue.set(entry.queueEntryId, {
          ...entry,
          status: "interrupted",
          runtimeId: undefined,
          leaseId: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          updatedAt: input.interruptedAt,
        });
        count += 1;
      }
    }
    return count;
  }

  async checkpointNodeSuccess(input: {
    run: PlaybookGraphRunRecord;
    queueEntry: PlaybookGraphQueueEntry;
    queueEntries?: PlaybookGraphQueueEntry[];
    branchItems?: PlaybookGraphBranchItem[];
    memo?: PlaybookGraphNodeMemo;
    artifactVersions?: PlaybookGraphArtifactVersion[];
  }): Promise<void> {
    const active = this.queue.get(input.queueEntry.queueEntryId);
    if (!active || active.status !== "running") {
      throw new Error("Cannot checkpoint graph node without an active queue claim");
    }
    if (
      !input.queueEntry.runtimeId ||
      !input.queueEntry.leaseId ||
      active.runtimeId !== input.queueEntry.runtimeId ||
      active.leaseId !== input.queueEntry.leaseId
    ) {
      throw new Error("Cannot checkpoint graph node with a stale queue claim");
    }
    if (
      active.leaseExpiresAt &&
      input.queueEntry.completedAt &&
      active.leaseExpiresAt < input.queueEntry.completedAt
    ) {
      throw new Error("Cannot checkpoint graph node after its lease expired");
    }
    this.runs.set(input.run.runId, input.run);
    this.queue.set(input.queueEntry.queueEntryId, input.queueEntry);
    for (const entry of input.queueEntries ?? []) {
      this.queue.set(entry.queueEntryId, entry);
    }
    for (const item of input.branchItems ?? []) {
      this.branchItems.set(item.branchItemId, item);
    }
    for (const version of input.artifactVersions ?? []) {
      await this.addArtifactVersion(version);
    }
    if (input.memo) {
      await this.putMemo(input.memo);
    }
  }

  async checkpointNodeFailure(input: {
    run: PlaybookGraphRunRecord;
    queueEntry: PlaybookGraphQueueEntry;
  }): Promise<void> {
    const active = this.queue.get(input.queueEntry.queueEntryId);
    if (!active || active.status !== "running") {
      throw new Error("Cannot checkpoint graph node without an active queue claim");
    }
    if (
      !input.queueEntry.runtimeId ||
      !input.queueEntry.leaseId ||
      active.runtimeId !== input.queueEntry.runtimeId ||
      active.leaseId !== input.queueEntry.leaseId
    ) {
      throw new Error("Cannot checkpoint graph node with a stale queue claim");
    }
    if (
      active.leaseExpiresAt &&
      input.queueEntry.completedAt &&
      active.leaseExpiresAt < input.queueEntry.completedAt
    ) {
      throw new Error("Cannot checkpoint graph node after its lease expired");
    }
    this.runs.set(input.run.runId, input.run);
    this.queue.set(input.queueEntry.queueEntryId, {
      ...input.queueEntry,
      runtimeId: undefined,
      leaseId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
    });
  }
}

function compiledGraph(graphPatch: Record<string, unknown> = {}): CompiledPlaybookGraph {
  return compilePlaybookGraph({
    graph: {
      schemaVersion: 1,
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
      artifacts: {
        plan: { schema: "schemas/plan.schema.json" },
        scorecard: { schema: "schemas/scorecard.schema.json" },
      },
      start: "plan",
      nodes: [
        {
          id: "plan",
          kind: "script",
          run: "scripts/plan.ts",
          inputs: {},
          outputArtifact: "plan",
          onSuccess: "score",
        },
        {
          id: "score",
          kind: "script",
          run: "scripts/score.ts",
          inputs: { plan: { artifact: "plan" } },
          outputArtifact: "scorecard",
          onSuccess: "completed",
        },
      ],
      ...graphPatch,
    },
    sourceFiles: {
      "playbook.ts": "export default graph;\n",
      "scripts/plan.ts": "export default function plan() {}\n",
      "scripts/score.ts": "export default function score() {}\n",
    },
    compilerVersion: "test-compiler",
    scriptSdkVersion: "test-sdk",
    compiledAt: "2026-05-15T00:00:00.000Z",
  });
}

describe("createPlaybookGraphSnapshot", () => {
  test("pins canonical compiled graph JSON and verifies snapshot hash", () => {
    const compiled = compiledGraph();
    const snapshot = createPlaybookGraphSnapshot({
      compiledGraph: compiled,
      sourceFiles: {
        "playbook.ts": "export default graph;\n",
        "scripts/plan.ts": "export default function plan() {}\n",
        "scripts/score.ts": "export default function score() {}\n",
      },
    });

    expect(snapshot.snapshotHash.startsWith("sha256:")).toBe(true);
    expect(snapshot.sourceFileHashes["playbook.ts"]).toMatch(/^sha256:/);
    expect(snapshot.sourceFiles?.["scripts/score.ts"]).toBe("export default function score() {}\n");
    expect(parsePinnedCompiledGraph(snapshot).metadata.graphHash).toBe(compiled.metadata.graphHash);
    expect(() =>
      parsePinnedCompiledGraph({ ...snapshot, snapshotJson: '{"tampered":true}' })
    ).toThrow(/hash mismatch/);
  });

  test("rejects source files that do not match compiled source hash", () => {
    expect(() =>
      createPlaybookGraphSnapshot({
        compiledGraph: compiledGraph(),
        sourceFiles: { "playbook.ts": "changed\n" },
      })
    ).toThrow(/source files do not match/);
  });
});

describe("createPlaybookGraphExecutionContextPin", () => {
  test("pins non-secret execution fingerprints with a stable hash", () => {
    const first = createPlaybookGraphExecutionContextPin({
      provider: "openai:gpt-5.4",
      account: "acct-a:fingerprint",
      budget: { maxUsd: 5 },
    });
    const reordered = createPlaybookGraphExecutionContextPin({
      budget: { maxUsd: 5 },
      account: "acct-a:fingerprint",
      provider: "openai:gpt-5.4",
    });

    expect(first.executionContextHash).toBe(reordered.executionContextHash);
    expect(first.executionContextHash).toMatch(/^sha256:/);
    expect(first.fingerprints.account).toBe("acct-a:fingerprint");
    expect(() => createPlaybookGraphExecutionContextPin({ apiKey: "nope" })).toThrow(
      /secret-bearing/
    );
  });
});

describe("createPlaybookGraphMemoKey", () => {
  test("is stable across object key order and changes for graph-relevant inputs", async () => {
    const store = new MemoryGraphRunStore();
    const compiled = compiledGraph();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiled,
      store,
      runId: "run-1",
      now: "2026-05-15T00:00:00.000Z",
      input: { topic: "memo keys" },
    });
    const queueEntry = (await store.getQueue(run.runId))[0];
    if (!queueEntry) throw new Error("Missing queue entry");
    const node = compiled.graph.nodes[0];
    if (!node) throw new Error("Missing node");

    const first = createGraphNodeMemoKeyParts({
      run,
      node,
      queueEntry,
      executionContext: { provider: "local", model: "a" },
      artifacts: [],
    });
    const second = createGraphNodeMemoKeyParts({
      run,
      node,
      queueEntry,
      executionContext: { model: "a", provider: "local" },
      artifacts: [],
    });
    const changed = createGraphNodeMemoKeyParts({
      run: { ...run, snapshot: { ...run.snapshot, snapshotHash: "sha256:different" } },
      node,
      queueEntry,
      executionContext: { provider: "local", model: "a" },
      artifacts: [],
    });

    expect(createPlaybookGraphMemoKey(first)).toBe(createPlaybookGraphMemoKey(second));
    expect(createPlaybookGraphMemoKey(first)).not.toBe(createPlaybookGraphMemoKey(changed));
  });
});

describe("drainPlaybookGraphRun", () => {
  test("does not persist a run when start queue creation fails", async () => {
    const store = new MemoryGraphRunStore();
    const base = compiledGraph();
    const invalidCompiled = {
      ...base,
      graph: {
        ...base.graph,
        start: "unsafe start",
        nodes: [{ id: "unsafe start", kind: "join" as const, inputs: [], onSuccess: "completed" }],
      },
    } as unknown as CompiledPlaybookGraph;

    await expect(
      createPlaybookGraphRun({
        compiledGraph: invalidCompiled,
        store,
        runId: "run-invalid-start-path",
        now: "2026-05-15T00:00:00.000Z",
      })
    ).rejects.toThrow(/Graph node/);
    expect(await store.getRun("run-invalid-start-path")).toBeUndefined();
    expect(await store.getQueue("run-invalid-start-path")).toEqual([]);
  });

  test("pins execution context at run creation", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-context",
      now: "2026-05-15T00:00:00.000Z",
      executionContext: {
        provider: "openai:gpt-5.4",
        account: "acct-a:fingerprint",
        budget: { maxUsd: 5 },
      },
    });

    expect(run.executionContext?.executionContextHash).toMatch(/^sha256:/);
    expect(run.executionContext?.fingerprints).toEqual({
      provider: "openai:gpt-5.4",
      account: "acct-a:fingerprint",
      budget: { maxUsd: 5 },
    });
  });

  test("blocks before claiming queue work when execution context drifts", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-drift",
      now: "2026-05-15T00:00:00.000Z",
      executionContext: {
        provider: "openai:gpt-5.4",
        account: "acct-a:fingerprint",
        budget: { maxUsd: 5 },
      },
    });
    let calls = 0;

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-drift",
      store,
      executionContext: {
        provider: "openai:gpt-5.4",
        account: "acct-b:fingerprint",
        budget: { maxUsd: 5 },
      },
      scriptAdapter() {
        calls += 1;
        return { ok: true };
      },
    });

    expect(result.run.status).toBe("blocked");
    expect(result.run.blockedReason).toContain("execution context changed");
    expect(calls).toBe(0);
    expect((await store.getQueue(run.runId))[0]?.status).toBe("queued");
  });

  test("blocks on execution context drift before stale lease recovery mutates queue state", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-stale-drift",
      now: "2026-05-15T00:00:00.000Z",
      executionContext: {
        provider: "openai:gpt-5.4",
        account: "acct-a:fingerprint",
      },
    });
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "old-runtime",
      leaseId: "old-lease",
      now: "2026-05-15T00:00:00.000Z",
      leaseExpiresAt: "2026-05-15T00:00:01.000Z",
    });
    if (!claimed) throw new Error("Missing claimed queue entry");
    await store.updateRun({
      ...run,
      status: "running",
      currentQueueEntryId: claimed.queueEntryId,
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-drift",
      store,
      now: () => "2026-05-15T00:00:02.000Z",
      executionContext: {
        provider: "openai:gpt-5.4",
        account: "acct-b:fingerprint",
      },
      scriptAdapter() {
        return { ok: true };
      },
    });

    expect(result.run.status).toBe("blocked");
    expect(result.run.blockedReason).toContain("execution context changed");
    const queueEntry = (await store.getQueue(run.runId))[0];
    expect(queueEntry?.status).toBe("running");
    expect(queueEntry?.runtimeId).toBe("old-runtime");
    expect(queueEntry?.leaseId).toBe("old-lease");
  });

  test("continues when execution context matches the run pin", async () => {
    const store = new MemoryGraphRunStore();
    const executionContext = {
      provider: "openai:gpt-5.4",
      account: "acct-a:fingerprint",
      budget: { maxUsd: 5 },
    };
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-context-match",
      now: "2026-05-15T00:00:00.000Z",
      executionContext,
    });
    let calls = 0;

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-context-match",
      store,
      executionContext,
      scriptAdapter() {
        calls += 1;
        return { ok: true };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(calls).toBe(1);
  });

  test("executes deterministic script nodes through persisted queue state", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-1",
      now: "2026-05-15T00:00:00.000Z",
      input: { topic: "durability" },
    });
    const calls: string[] = [];

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-1",
      store,
      now: (() => {
        let tick = 0;
        return () => `2026-05-15T00:00:${String(tick++).padStart(2, "0")}.000Z`;
      })(),
      scriptAdapter({ node }) {
        calls.push(node.id);
        return { nodeId: node.id };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(calls).toEqual(["plan", "score"]);
    expect((await store.getQueue(run.runId)).map((entry) => entry.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(await store.listArtifactVersions(run.runId)).toHaveLength(2);
    expect(store.memos.size).toBe(2);
    const scoreEntry = (await store.getQueue(run.runId)).find((entry) => entry.nodeId === "score");
    expect(scoreEntry?.queueEntryId).toBe("run-1:plan/score");
    expect(scoreEntry?.consumesArtifacts).toEqual([
      expect.objectContaining({ artifactId: "plan" }),
    ]);
  });

  test("renews active queue leases while long-running adapters execute", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-renew",
      now: "2026-05-15T00:00:00.000Z",
    });
    const renewals: string[] = [];
    const renewQueueLease = store.renewQueueLease.bind(store);
    store.renewQueueLease = async (input: Parameters<GraphRunStore["renewQueueLease"]>[0]) => {
      renewals.push(input.leaseExpiresAt);
      return renewQueueLease(input);
    };

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-renew",
      store,
      leaseMs: 1_000,
      leaseRenewalMs: 1,
      async scriptAdapter() {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(renewals.length).toBeGreaterThan(0);
    expect((await store.getQueue(run.runId))[0]?.status).toBe("succeeded");
  });

  test("revisits looped nodes with distinct queue identities", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        start: "plan",
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: { previous: { artifact: "plan" } },
            outputArtifact: "plan",
            onSuccess: "check",
          },
          {
            id: "check",
            kind: "condition",
            when: { artifact: "plan", path: "$.done", equals: true },
            onTrue: "completed",
            onFalse: "plan",
          },
        ],
      }),
      store,
      runId: "run-loop",
      now: "2026-05-15T00:00:00.000Z",
    });
    let calls = 0;

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-loop",
      store,
      now: (() => {
        let tick = 0;
        return () => `2026-05-15T00:00:${String(tick++).padStart(2, "0")}.000Z`;
      })(),
      scriptAdapter() {
        calls += 1;
        return { done: calls === 2 };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(calls).toBe(2);
    expect((await store.getQueue(run.runId)).map((entry) => entry.queueEntryId)).toEqual([
      "run-loop:plan",
      "run-loop:plan/check",
      "run-loop:plan/check/plan",
      "run-loop:plan/check/plan/check",
    ]);
  });

  test("executes artifactWrite through an adapter without creating a new artifact version", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "writePlan",
          },
          {
            id: "writePlan",
            kind: "artifactWrite",
            artifact: "plan",
            path: "out/plan.json",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-write",
      now: "2026-05-15T00:00:00.000Z",
    });
    const writes: Array<{ path: string; value: unknown; versionId: string }> = [];

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-write",
      store,
      scriptAdapter() {
        return { title: "Plan" };
      },
      artifactWriteAdapter({ node, value, artifactVersion }) {
        writes.push({ path: node.path, value, versionId: artifactVersion.versionId });
        return { path: node.path, bytes: 16 };
      },
    });

    const queue = await store.getQueue(run.runId);
    expect(result.run.status).toBe("completed");
    expect(writes).toEqual([
      {
        path: "out/plan.json",
        value: { title: "Plan" },
        versionId: expect.stringContaining(":plan:v1"),
      },
    ]);
    expect(queue.find((entry) => entry.nodeId === "writePlan")?.producesArtifacts).toEqual([]);
    expect(queue.find((entry) => entry.nodeId === "writePlan")?.consumesArtifacts).toEqual([
      expect.objectContaining({ artifactId: "plan" }),
    ]);
    expect(await store.listArtifactVersions(run.runId)).toHaveLength(1);
    expect(store.memos.size).toBe(2);
  });

  test("memoized artifactWrite resume does not repeat the materialization adapter", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "writePlan",
          },
          {
            id: "writePlan",
            kind: "artifactWrite",
            artifact: "plan",
            path: "out/plan.json",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-write-memo",
      now: "2026-05-15T00:00:00.000Z",
    });
    let writes = 0;
    await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-1",
      store,
      scriptAdapter() {
        return { title: "Plan" };
      },
      artifactWriteAdapter() {
        writes += 1;
        return { path: "out/plan.json" };
      },
    });
    const completedRun = await store.getRun(run.runId);
    const writeEntry = (await store.getQueue(run.runId)).find(
      (entry) => entry.nodeId === "writePlan"
    );
    if (!completedRun || !writeEntry) throw new Error("Missing completed artifactWrite state");
    await store.updateRun({ ...completedRun, status: "running", completedAt: undefined });
    await store.updateQueueEntry({
      ...writeEntry,
      status: "queued",
      runtimeId: undefined,
      leaseId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      completedAt: undefined,
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-2",
      store,
      scriptAdapter() {
        return { title: "Plan" };
      },
      artifactWriteAdapter() {
        writes += 1;
        return { path: "out/plan.json" };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(writes).toBe(1);
    expect(
      (await store.getQueue(run.runId)).find((entry) => entry.nodeId === "writePlan")?.status
    ).toBe("memoized");
  });

  test("executes agent nodes through an adapter and memoizes resume", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: {},
            tools: [],
            output: { artifact: "plan" },
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-agent-exec",
      now: "2026-05-15T00:00:00.000Z",
      executionContext: { provider: "openai:gpt-5.4", profile: "default:fingerprint" },
    });
    let calls = 0;

    await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-agent-1",
      store,
      executionContext: { provider: "openai:gpt-5.4", profile: "default:fingerprint" },
      agentAdapter({ node }) {
        calls += 1;
        return { nodeId: node.id, text: "draft" };
      },
    });
    const completedRun = await store.getRun(run.runId);
    const completedEntry = (await store.getQueue(run.runId))[0];
    if (!completedRun || !completedEntry) throw new Error("Missing completed agent state");
    await store.updateRun({ ...completedRun, status: "running", completedAt: undefined });
    await store.updateQueueEntry({
      ...completedEntry,
      status: "queued",
      runtimeId: undefined,
      leaseId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      completedAt: undefined,
    });

    const resumed = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-agent-2",
      store,
      executionContext: { provider: "openai:gpt-5.4", profile: "default:fingerprint" },
      agentAdapter() {
        calls += 1;
        return { text: "rerun" };
      },
    });

    expect(resumed.run.status).toBe("completed");
    expect(calls).toBe(1);
    expect((await store.getQueue(run.runId))[0]?.status).toBe("memoized");
    expect((await store.listArtifactVersions(run.runId))[0]?.value).toEqual({
      nodeId: "draft",
      text: "draft",
    });
  });

  test("executes tool nodes only with explicit capability policy", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        start: "lookup",
        nodes: [
          {
            id: "lookup",
            kind: "tool",
            capability: "tool.workspace.read",
            args: { path: "README.md" },
            outputArtifact: "plan",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-tool-exec",
      now: "2026-05-15T00:00:00.000Z",
    });
    let calls = 0;

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-tool",
      store,
      toolCapabilities: ["tool.workspace.read"],
      toolPolicies: {
        "tool.workspace.read": {
          capability: "tool.workspace.read",
          idempotent: true,
          sideEffect: "read",
        },
      },
      toolAdapter({ node }) {
        calls += 1;
        return { capability: node.capability, args: node.args };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(calls).toBe(1);
    expect((await store.getQueue(run.runId))[0]?.status).toBe("succeeded");
    expect(store.memos.size).toBe(1);
    expect((await store.listArtifactVersions(run.runId))[0]?.value).toEqual({
      capability: "tool.workspace.read",
      args: { path: "README.md" },
    });
  });

  test("blocks tool nodes without an explicit execution policy", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        start: "lookup",
        nodes: [
          {
            id: "lookup",
            kind: "tool",
            capability: "tool.workspace.write",
            args: { path: "out.txt" },
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-tool-policy",
      now: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-tool-policy",
      store,
      toolAdapter() {
        return {};
      },
    });

    expect(result.run.status).toBe("blocked");
    expect(result.run.blockedReason).toContain("Tool execution policy is required");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("blocked");
    expect(store.memos.size).toBe(0);
  });

  test("parallelMap fans out branch items and rejoins after branches complete", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        artifacts: {
          items: { schema: "schemas/items.schema.json" },
          scorecard: { schema: "schemas/scorecard.schema.json" },
        },
        start: "items",
        nodes: [
          {
            id: "items",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "items",
            onSuccess: "map",
          },
          {
            id: "map",
            kind: "parallelMap",
            items: { artifact: "items", path: "$" },
            branch: {
              start: "scoreItem",
              nodes: [
                {
                  id: "scoreItem",
                  kind: "script",
                  run: "scripts/score.ts",
                  inputs: {},
                  outputArtifact: "scorecard",
                  onSuccess: "completed",
                },
              ],
            },
            onSuccess: "done",
          },
          {
            id: "done",
            kind: "join",
            inputs: ["scorecard"],
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-map",
      now: "2026-05-15T00:00:00.000Z",
    });
    const branchInputs: unknown[] = [];

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-map",
      store,
      scriptAdapter({ node, input }) {
        if (node.id === "items") return [{ id: "a" }, { id: "b" }];
        branchInputs.push(input.branchItem);
        return { item: input.branchItem };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(branchInputs).toEqual([{ id: "a" }, { id: "b" }]);
    expect((await store.listBranchItems(run.runId)).map((item) => item.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect((await store.getQueue(run.runId)).map((entry) => entry.queueEntryId)).toEqual([
      "run-map:items",
      "run-map:items/map",
      "run-map:items/map/item:0/scoreItem",
      "run-map:items/map/item:1/scoreItem",
      "run-map:items/map/done",
    ]);
  });

  test("parallelMap branch memo keys change when branch item values change", async () => {
    const store = new MemoryGraphRunStore();
    const compiled = compiledGraph({
      artifacts: {
        items: { schema: "schemas/items.schema.json" },
        scorecard: { schema: "schemas/scorecard.schema.json" },
      },
      start: "items",
      nodes: [
        {
          id: "items",
          kind: "script",
          run: "scripts/plan.ts",
          inputs: {},
          outputArtifact: "items",
          onSuccess: "map",
        },
        {
          id: "map",
          kind: "parallelMap",
          items: { artifact: "items", path: "$" },
          branch: {
            start: "scoreItem",
            nodes: [
              {
                id: "scoreItem",
                kind: "script",
                run: "scripts/score.ts",
                inputs: {},
                outputArtifact: "scorecard",
                onSuccess: "completed",
              },
            ],
          },
          onSuccess: "completed",
        },
      ],
    });
    const run = await createPlaybookGraphRun({
      compiledGraph: compiled,
      store,
      runId: "run-map-memo-branch",
      now: "2026-05-15T00:00:00.000Z",
    });
    const branchInputs: unknown[] = [];

    await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-map-memo-1",
      store,
      scriptAdapter({ node, input }) {
        if (node.id === "items") return [{ id: "a" }];
        branchInputs.push(input.branchItem);
        return { item: input.branchItem };
      },
    });

    const completedRun = await store.getRun(run.runId);
    if (!completedRun) throw new Error("Missing completed run");
    const queue = await store.getQueue(run.runId);
    const mapEntry = queue.find((entry) => entry.nodeId === "map");
    if (!mapEntry) throw new Error("Missing map queue entry");
    await store.addArtifactVersion({
      schemaVersion: 1,
      runId: run.runId,
      artifactId: "items",
      versionId: "manual-items-edit",
      producerQueueEntryId: "manual-edit",
      nodePath: "edit:items",
      contentHash: "sha256:items-edited",
      value: [{ id: "b" }],
      createdAt: "2026-05-15T00:00:01.000Z",
    });
    await store.updateRun({
      ...completedRun,
      status: "running",
      completedAt: undefined,
      updatedAt: "2026-05-15T00:00:01.000Z",
    });
    const mapNode = compiled.graph.nodes.find((node) => node.id === "map");
    if (!mapNode) throw new Error("Missing map node");
    await store.updateQueueEntry(
      createPlaybookGraphQueueEntry({
        runId: run.runId,
        node: mapNode,
        nodePath: mapEntry.nodePath,
        dependsOn: mapEntry.dependsOn,
        artifactVersions: await store.listArtifactVersions(run.runId),
        now: "2026-05-15T00:00:01.000Z",
      })
    );
    for (const entry of queue.filter((entry) => entry.nodePath.includes("/item:"))) {
      await store.updateQueueEntry({
        ...entry,
        status: "skipped",
        completedAt: "2026-05-15T00:00:01.000Z",
        updatedAt: "2026-05-15T00:00:01.000Z",
      });
    }

    await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-map-memo-2",
      store,
      scriptAdapter({ node, input }) {
        if (node.id === "items") return [{ id: "unexpected" }];
        branchInputs.push(input.branchItem);
        return { item: input.branchItem };
      },
    });

    expect(branchInputs).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("parallelMap enforces branch limits before fan-out", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        limits: { maxConcurrentBranches: 1 },
        artifacts: {
          items: { schema: "schemas/items.schema.json" },
          scorecard: { schema: "schemas/scorecard.schema.json" },
        },
        start: "items",
        nodes: [
          {
            id: "items",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "items",
            onSuccess: "map",
          },
          {
            id: "map",
            kind: "parallelMap",
            items: { artifact: "items", path: "$" },
            branch: {
              start: "scoreItem",
              nodes: [
                {
                  id: "scoreItem",
                  kind: "script",
                  run: "scripts/score.ts",
                  inputs: {},
                  outputArtifact: "scorecard",
                  onSuccess: "completed",
                },
              ],
            },
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-map-limits",
      now: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-map-limits",
      store,
      scriptAdapter({ node }) {
        if (node.id === "items") return [{ id: "a" }, { id: "b" }];
        return {};
      },
    });

    expect(result.run.status).toBe("failed");
    expect(result.run.error).toContain("maxConcurrentBranches");
    expect(await store.listBranchItems(run.runId)).toEqual([]);
  });

  test("resume reuses memoized queue work instead of rerunning a completed script", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-1",
      now: "2026-05-15T00:00:00.000Z",
    });
    let calls = 0;
    await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-1",
      store,
      scriptAdapter() {
        calls += 1;
        return { plan: true };
      },
    });
    const completedEntry = (await store.getQueue(run.runId))[0];
    if (!completedEntry) throw new Error("Missing completed entry");
    const completedRun = await store.getRun(run.runId);
    if (!completedRun) throw new Error("Missing completed run");
    await store.updateRun({
      ...completedRun,
      status: "running",
      completedAt: undefined,
    });
    await store.updateQueueEntry({
      ...completedEntry,
      status: "queued",
      runtimeId: undefined,
      leaseId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      completedAt: undefined,
    });

    const resumed = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-2",
      store,
      scriptAdapter() {
        calls += 1;
        return { plan: true };
      },
    });

    expect(resumed.run.status).toBe("completed");
    expect(calls).toBe(1);
    expect((await store.getQueue(run.runId))[0]?.status).toBe("memoized");
  });

  test("expired checkpoint rejection does not mark the run failed from a stale runtime", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-stale",
      now: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-stale",
      store,
      leaseMs: 1,
      now: (() => {
        const ticks = [
          "2026-05-15T00:00:00.000Z",
          "2026-05-15T00:00:00.000Z",
          "2026-05-15T00:00:00.000Z",
          "2026-05-15T00:00:01.000Z",
        ];
        return () => ticks.shift() ?? "2026-05-15T00:00:01.000Z";
      })(),
      scriptAdapter() {
        return { ok: true };
      },
    });

    expect(result.run.status).toBe("running");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("running");
    expect(await store.listArtifactVersions(run.runId)).toEqual([]);
  });

  test("expired failure checkpoint does not let a stale runtime fail the run", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-stale-failure",
      now: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-stale-failure",
      store,
      leaseMs: 1,
      now: (() => {
        const ticks = [
          "2026-05-15T00:00:00.000Z",
          "2026-05-15T00:00:00.000Z",
          "2026-05-15T00:00:00.000Z",
          "2026-05-15T00:00:01.000Z",
        ];
        return () => ticks.shift() ?? "2026-05-15T00:00:01.000Z";
      })(),
      scriptAdapter() {
        throw new Error("stale failure");
      },
    });

    expect(result.run.status).toBe("running");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("running");
    expect((await store.getQueue(run.runId))[0]?.error).toBeUndefined();
    expect(await store.listArtifactVersions(run.runId)).toEqual([]);
  });

  test("script adapter failures checkpoint a failed run through the active claim", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-failure",
      now: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-failure",
      store,
      scriptAdapter() {
        throw new Error("script failed");
      },
    });

    const failedEntry = (await store.getQueue(run.runId))[0];
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toBe("script failed");
    expect(failedEntry?.status).toBe("failed");
    expect(failedEntry?.runtimeId).toBeUndefined();
    expect(await store.listArtifactVersions(run.runId)).toEqual([]);
  });

  test("agent nodes block durably when no adapter is provided", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        start: "agent",
        nodes: [
          {
            id: "agent",
            kind: "agent",
            prompt: "prompts/write.md",
            inputs: {},
            tools: [],
          },
        ],
      }),
      store,
      runId: "run-agent",
      now: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-1",
      store,
    });

    expect(result.run.status).toBe("blocked");
    expect(result.run.blockedReason).toContain("agent adapter");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("blocked");
    expect(store.memos.size).toBe(0);
  });

  test("artifactWrite blocks durably when no adapter is provided", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph({
        start: "writePlan",
        nodes: [
          {
            id: "writePlan",
            kind: "artifactWrite",
            artifact: "plan",
            path: "out/plan.json",
            onSuccess: "completed",
          },
        ],
      }),
      store,
      runId: "run-write-blocked",
      now: "2026-05-15T00:00:00.000Z",
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-write",
      store,
    });

    expect(result.run.status).toBe("blocked");
    expect(result.run.blockedReason).toContain("artifact write adapter");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("blocked");
    expect(store.memos.size).toBe(0);
  });

  test("tampered pinned snapshots move the run to needs_repair", async () => {
    const store = new MemoryGraphRunStore();
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-1",
      now: "2026-05-15T00:00:00.000Z",
    });
    await store.updateRun({
      ...run,
      snapshot: { ...run.snapshot, snapshotJson: '{"tampered":true}' },
    });

    const result = await drainPlaybookGraphRun({
      runId: run.runId,
      runtimeId: "runtime-1",
      store,
    });

    expect(result.run.status).toBe("needs_repair");
    expect(result.run.repairReason).toContain("hash mismatch");
  });
});
