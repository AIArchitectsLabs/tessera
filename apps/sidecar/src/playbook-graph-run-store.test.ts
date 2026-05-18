import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompiledPlaybookGraph,
  PlaybookGraphArtifactVersion,
  PlaybookGraphBranchItem,
  PlaybookGraphNodeMemo,
  PlaybookGraphOperationRecord,
  PlaybookGraphQueueEntry,
  PlaybookGraphReviewEvent,
  PlaybookGraphRunRecord,
} from "@tessera/contracts";
import { PlaybookGraphRunRecordSchema } from "@tessera/contracts";
import {
  compilePlaybookGraph,
  createPlaybookGraphRun,
  createPlaybookGraphSnapshot,
} from "@tessera/core";
import { createPlaybookGraphRunStore } from "./playbook-graph-run-store.js";

const tempDirs: string[] = [];
const now = "2026-05-15T00:00:00.000Z";
const later = "2026-05-15T00:00:01.000Z";

function operationRecord(
  patch: Partial<PlaybookGraphOperationRecord> = {}
): PlaybookGraphOperationRecord {
  return {
    schemaVersion: 1,
    operationRecordId: "operation-record-1",
    operationAttemptId: "operation-attempt-1",
    runId: "run-1",
    actionSpecId: "queue-plan:approve",
    kind: "resume",
    status: "succeeded",
    operatorIntent: "Approve graph review",
    affectedArtifactIds: [],
    affectedReviewEventIds: [],
    affectedQueueEntryIds: ["queue-plan"],
    createdAt: later,
    completedAt: later,
    ...patch,
  };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-graph-run-store-"));
  tempDirs.push(dir);
  return join(dir, "graph-runs.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function compiledGraph(): CompiledPlaybookGraph {
  return compilePlaybookGraph({
    graph: {
      schemaVersion: 1,
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
      artifacts: {
        plan: { schema: "schemas/plan.schema.json" },
      },
      start: "plan",
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
    },
    sourceFiles: { "playbook.ts": "export default graph;\n" },
    compilerVersion: "test-compiler",
    scriptSdkVersion: "test-sdk",
    compiledAt: now,
  });
}

async function createRunAndQueue(dbPath = tempDbPath()): Promise<{
  dbPath: string;
  run: PlaybookGraphRunRecord;
  queueEntry: PlaybookGraphQueueEntry;
}> {
  const store = createPlaybookGraphRunStore(dbPath);
  const run = await createPlaybookGraphRun({
    compiledGraph: compiledGraph(),
    store,
    runId: "run-1",
    now,
  });
  const queueEntry = (await store.getQueue(run.runId))[0];
  store.close();
  if (!queueEntry) throw new Error("Missing queue entry");
  return { dbPath, run, queueEntry };
}

describe("createPlaybookGraphRunStore", () => {
  test("persists graph runs and queue entries across store instances", async () => {
    const { dbPath, run } = await createRunAndQueue();

    const store = createPlaybookGraphRunStore(dbPath);
    expect((await store.getRun(run.runId))?.snapshot.snapshotHash).toBe(run.snapshot.snapshotHash);
    expect((await store.getQueue(run.runId)).map((entry) => entry.nodePath)).toEqual(["plan"]);
    store.close();
  });

  test("atomically creates runs with the initial queue entry", async () => {
    const dbPath = tempDbPath();
    const store = createPlaybookGraphRunStore(dbPath);
    const graph = compiledGraph();
    const run = PlaybookGraphRunRecordSchema.parse({
      schemaVersion: 1,
      runId: "run-invalid-initial-queue",
      playbookId: graph.graph.id,
      status: "queued",
      input: {},
      snapshot: createPlaybookGraphSnapshot({ compiledGraph: graph }),
      startedAt: now,
      updatedAt: now,
    });
    const invalidQueueEntry = {
      schemaVersion: 1,
      queueEntryId: "queue-invalid",
      runId: run.runId,
      nodeId: "plan",
      nodePath: "../plan",
      nodeKind: "script",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    } as unknown as PlaybookGraphQueueEntry;

    await expect(
      store.createRunWithQueue({ run, queueEntries: [invalidQueueEntry] })
    ).rejects.toThrow(/node paths/);
    expect(await store.getRun(run.runId)).toBeUndefined();
    expect(await store.getQueue(run.runId)).toEqual([]);
    store.close();
  });

  test("persists graph run materialization context across store instances", async () => {
    const dbPath = tempDbPath();
    const store = createPlaybookGraphRunStore(dbPath);
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-1",
      now,
      materialization: {
        schemaVersion: 1,
        kind: "workspace",
        workspaceRoot: "/tmp/tessera-workspace",
      },
    });
    store.close();

    const reopened = createPlaybookGraphRunStore(dbPath);
    expect((await reopened.getRun(run.runId))?.materialization).toEqual({
      schemaVersion: 1,
      kind: "workspace",
      workspaceRoot: "/tmp/tessera-workspace",
    });
    reopened.close();
  });

  test("reports needs_repair when the pinned snapshot hash no longer verifies", async () => {
    const dbPath = tempDbPath();
    const store = createPlaybookGraphRunStore(dbPath);
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-1",
      now,
    });

    await store.updateRun({
      ...run,
      snapshot: { ...run.snapshot, snapshotJson: '{"tampered":true}' },
    });

    expect((await store.getRun(run.runId))?.status).toBe("needs_repair");
    expect((await store.listRuns({ status: "needs_repair" })).map((item) => item.runId)).toEqual([
      run.runId,
    ]);
    store.close();
  });

  test("atomically claims one dependency-satisfied queued entry", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const first = createPlaybookGraphRunStore(dbPath);
    const second = createPlaybookGraphRunStore(dbPath);

    const claimed = await first.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseExpiresAt: later,
      now,
    });
    const loser = await second.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-2",
      leaseId: "lease-2",
      leaseExpiresAt: later,
      now,
    });

    expect(claimed?.status).toBe("running");
    expect(claimed?.runtimeId).toBe("runtime-1");
    expect(loser).toBeUndefined();
    first.close();
    second.close();
  });

  test("does not claim entries until dependencies and consumed artifact versions exist", async () => {
    const dbPath = tempDbPath();
    const store = createPlaybookGraphRunStore(dbPath);
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-1",
      now,
    });
    const base = (await store.getQueue(run.runId))[0];
    if (!base) throw new Error("Missing queue entry");
    await store.updateQueueEntry({ ...base, status: "succeeded", updatedAt: now });
    await store.upsertQueueEntry({
      ...base,
      queueEntryId: "queue-dependent",
      nodeId: "dependent",
      nodePath: "dependent",
      status: "queued",
      dependsOn: [base.queueEntryId],
      declaredConsumesArtifacts: ["plan"],
      consumesArtifacts: [
        { artifactId: "plan", versionId: "artifact-version-1", contentHash: "sha256:plan" },
      ],
      artifactBindingState: "resolved",
      createdAt: later,
      updatedAt: later,
    });

    expect(
      await store.claimNextQueuedEntry({
        runId: run.runId,
        runtimeId: "runtime-1",
        leaseId: "lease-1",
        leaseExpiresAt: later,
        now,
      })
    ).toBeUndefined();

    await store.addArtifactVersion({
      schemaVersion: 1,
      runId: run.runId,
      artifactId: "plan",
      versionId: "artifact-version-1",
      producerQueueEntryId: base.queueEntryId,
      nodePath: "plan",
      contentHash: "sha256:plan",
      value: { ok: true },
      createdAt: later,
    });

    expect(
      (
        await store.claimNextQueuedEntry({
          runId: run.runId,
          runtimeId: "runtime-1",
          leaseId: "lease-1",
          leaseExpiresAt: later,
          now,
        })
      )?.queueEntryId
    ).toBe("queue-dependent");
    store.close();
  });

  test("does not claim queued entries while declared artifact bindings are unresolved", async () => {
    const dbPath = tempDbPath();
    const store = createPlaybookGraphRunStore(dbPath);
    const run = await createPlaybookGraphRun({
      compiledGraph: compiledGraph(),
      store,
      runId: "run-1",
      now,
    });
    const base = (await store.getQueue(run.runId))[0];
    if (!base) throw new Error("Missing queue entry");
    await store.updateQueueEntry({ ...base, status: "succeeded", updatedAt: now });
    await store.upsertQueueEntry({
      ...base,
      queueEntryId: "queue-dependent",
      nodeId: "dependent",
      nodePath: "dependent",
      status: "queued",
      dependsOn: [base.queueEntryId],
      declaredConsumesArtifacts: ["plan"],
      consumesArtifacts: [],
      artifactBindingState: "unresolved",
      createdAt: later,
      updatedAt: later,
    });

    expect(
      await store.claimNextQueuedEntry({
        runId: run.runId,
        runtimeId: "runtime-1",
        leaseId: "lease-1",
        leaseExpiresAt: later,
        now,
      })
    ).toBeUndefined();

    await store.addArtifactVersion({
      schemaVersion: 1,
      runId: run.runId,
      artifactId: "plan",
      versionId: "artifact-version-1",
      producerQueueEntryId: base.queueEntryId,
      nodePath: "plan",
      contentHash: "sha256:plan",
      value: { ok: true },
      createdAt: later,
    });
    const dependent = (await store.getQueue(run.runId)).find(
      (entry) => entry.queueEntryId === "queue-dependent"
    );
    if (!dependent) throw new Error("Missing dependent queue entry");
    await store.updateQueueEntry({
      ...dependent,
      consumesArtifacts: [
        { artifactId: "plan", versionId: "artifact-version-1", contentHash: "sha256:plan" },
      ],
      artifactBindingState: "resolved",
      updatedAt: later,
    });

    expect(
      (
        await store.claimNextQueuedEntry({
          runId: run.runId,
          runtimeId: "runtime-1",
          leaseId: "lease-1",
          leaseExpiresAt: later,
          now,
        })
      )?.queueEntryId
    ).toBe("queue-dependent");
    store.close();
  });

  test("renews and releases leases only for the matching runtime claim", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseExpiresAt: later,
      now,
    });
    if (!claimed) throw new Error("Missing claim");

    expect(
      await store.renewQueueLease({
        runId: run.runId,
        queueEntryId: claimed.queueEntryId,
        runtimeId: "runtime-2",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-05-15T00:00:05.000Z",
        now: later,
      })
    ).toBe(false);
    expect(
      await store.renewQueueLease({
        runId: run.runId,
        queueEntryId: claimed.queueEntryId,
        runtimeId: "runtime-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2026-05-15T00:00:05.000Z",
        now: later,
      })
    ).toBe(true);
    expect(
      await store.releaseQueueLease({
        runId: run.runId,
        queueEntryId: claimed.queueEntryId,
        runtimeId: "runtime-2",
        leaseId: "lease-1",
        now: later,
      })
    ).toBe(false);
    expect(
      await store.releaseQueueLease({
        runId: run.runId,
        queueEntryId: claimed.queueEntryId,
        runtimeId: "runtime-1",
        leaseId: "lease-1",
        now: later,
      })
    ).toBe(true);
    expect((await store.getQueue(run.runId))[0]?.status).toBe("queued");
    store.close();
  });

  test("marks stale running leases interrupted without stealing unexpired claims", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-old",
      leaseId: "lease-old",
      leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      now,
    });

    expect(
      await store.markStaleQueueLeasesInterrupted({
        runId: run.runId,
        runtimeId: "runtime-new",
        now: "2026-05-15T00:00:00.500Z",
        interruptedAt: "2026-05-15T00:00:00.500Z",
      })
    ).toBe(0);
    expect(
      await store.markStaleQueueLeasesInterrupted({
        runId: run.runId,
        runtimeId: "runtime-new",
        now: "2026-05-15T00:00:02.000Z",
        interruptedAt: "2026-05-15T00:00:02.000Z",
      })
    ).toBe(1);
    expect((await store.getQueue(run.runId))[0]?.status).toBe("interrupted");
    store.close();
  });

  test("recovers stale leases by requeueing safe work and flagging manual attention", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const safe = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-old",
      leaseId: "lease-old",
      leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      now,
    });
    if (!safe) throw new Error("Missing safe claim");
    await store.upsertQueueEntry({
      ...safe,
      queueEntryId: "queue-manual",
      nodeId: "agent",
      nodePath: "agent",
      nodeKind: "agent",
      status: "running",
      recoveryPolicy: "block_for_review",
      runtimeId: "runtime-old",
      leaseId: "lease-manual",
      claimedAt: now,
      leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      createdAt: now,
      updatedAt: now,
    });

    expect(
      await store.recoverStaleQueueLeases({
        runId: run.runId,
        runtimeId: "runtime-new",
        now: "2026-05-15T00:00:02.000Z",
      })
    ).toEqual({ inspected: 2, autoRequeued: 1, needsAttention: 1, interrupted: 0 });

    const queue = await store.getQueue(run.runId);
    const safeRecovered = queue.find((entry) => entry.queueEntryId === safe.queueEntryId);
    const manual = queue.find((entry) => entry.queueEntryId === "queue-manual");
    expect(safeRecovered?.status).toBe("queued");
    expect(safeRecovered?.attentionEvidence?.recoveryDecision).toBe("auto_requeued");
    expect(await store.listOperationRecords(run.runId)).toContainEqual(
      expect.objectContaining({
        actionSpecId: "system.recovery.auto_retry",
        kind: "retry_needs_attention",
        affectedQueueEntryIds: [safe.queueEntryId],
      })
    );
    expect(manual?.status).toBe("needs_attention");
    expect(manual?.attentionEvidence?.recoveryDecision).toBe("needs_attention");
    expect(manual?.runtimeId).toBeUndefined();
    store.close();
  });

  test("bumpHeartbeat updates lastHeartbeatAt when lease matches and no-ops otherwise", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-A",
      leaseExpiresAt: "2026-05-15T00:01:00.000Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");

    expect(
      await store.bumpHeartbeat({
        runId: run.runId,
        queueEntryId: claimed.queueEntryId,
        leaseId: "lease-A",
        now: "2026-05-15T00:00:10.000Z",
      })
    ).toBe(true);
    expect((await store.getQueue(run.runId))[0]?.lastHeartbeatAt).toBe("2026-05-15T00:00:10.000Z");
    expect(
      await store.bumpHeartbeat({
        runId: run.runId,
        queueEntryId: claimed.queueEntryId,
        leaseId: "lease-stale",
        now: "2026-05-15T00:00:20.000Z",
      })
    ).toBe(false);
    expect((await store.getQueue(run.runId))[0]?.lastHeartbeatAt).toBe("2026-05-15T00:00:10.000Z");
    store.close();
  });

  test("recoverStaleQueueLeases transitions stale-heartbeat work to needs_attention", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-old",
      leaseId: "lease-old",
      leaseExpiresAt: "2026-05-15T00:05:00.000Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");
    await store.updateQueueEntry({
      ...claimed,
      recoveryPolicy: "block_for_review",
      lastHeartbeatAt: "2026-05-15T00:00:10.000Z",
      updatedAt: "2026-05-15T00:00:10.000Z",
    });

    const result = await store.recoverStaleQueueLeases({
      runId: run.runId,
      runtimeId: "runtime-new",
      now: "2026-05-15T00:01:00.000Z",
      hardTimeoutMs: () => 30 * 60_000,
    });

    expect(result.needsAttention).toBe(1);
    const entry = (await store.getQueue(run.runId))[0];
    expect(entry?.status).toBe("needs_attention");
    expect(entry?.attentionEvidence?.code).toBe("stale_heartbeat");
    expect(entry?.attentionEvidence?.thresholdMs).toBe(45_000);
    store.close();
  });

  test("recoverStaleQueueLeases transitions hard-timeout work and emits operation record", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-old",
      leaseId: "lease-old",
      leaseExpiresAt: "2026-05-15T00:40:00.000Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");
    await store.updateQueueEntry({
      ...claimed,
      nodeKind: "agent",
      recoveryPolicy: "block_for_review",
      claimedAt: "2026-05-15T00:00:00.000Z",
      lastHeartbeatAt: "2026-05-15T00:30:59.000Z",
      updatedAt: "2026-05-15T00:30:59.000Z",
    });

    const result = await store.recoverStaleQueueLeases({
      runId: run.runId,
      runtimeId: "runtime-new",
      now: "2026-05-15T00:31:00.000Z",
      hardTimeoutMs: (kind) => (kind === "agent" ? 30 * 60_000 : undefined),
    });

    expect(result.needsAttention).toBe(1);
    const entry = (await store.getQueue(run.runId))[0];
    expect(entry?.attentionEvidence?.code).toBe("hard_timeout");
    expect(entry?.attentionEvidence?.thresholdMs).toBe(30 * 60_000);
    const ops = await store.listOperationRecords(run.runId);
    expect(ops.some((op) => op.kind === "hard_timeout_observed")).toBe(true);
    store.close();
  });

  test("recoverStaleQueueLeases does not auto-requeue after budget or hard timeout", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-old",
      leaseId: "lease-old",
      leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");
    await store.addOperationRecord({
      schemaVersion: 1,
      operationRecordId: `${claimed.queueEntryId}:auto-retry`,
      operationAttemptId: `${claimed.queueEntryId}:auto-retry`,
      runId: run.runId,
      actionSpecId: "system.recovery.auto_retry",
      kind: "retry_needs_attention",
      status: "succeeded",
      operatorIntent: "Automatically retry interrupted step",
      queueEntryId: claimed.queueEntryId,
      affectedArtifactIds: [],
      affectedReviewEventIds: [],
      affectedQueueEntryIds: [claimed.queueEntryId],
      createdAt: "2026-05-15T00:00:00.500Z",
      completedAt: "2026-05-15T00:00:00.500Z",
    });

    expect(
      await store.recoverStaleQueueLeases({
        runId: run.runId,
        runtimeId: "runtime-new",
        now: "2026-05-15T00:00:02.000Z",
      })
    ).toEqual({ inspected: 1, autoRequeued: 0, needsAttention: 1, interrupted: 0 });
    expect((await store.getQueue(run.runId))[0]?.status).toBe("needs_attention");
    expect((await store.getQueue(run.runId))[0]?.attentionEvidence?.recoveryDecision).toBe(
      "needs_attention"
    );

    await store.updateQueueEntry({
      ...claimed,
      status: "running",
      runtimeId: "runtime-old",
      leaseId: "lease-hard",
      claimedAt: "2026-05-15T00:00:00.000Z",
      leaseExpiresAt: "2026-05-15T00:40:00.000Z",
      attentionEvidence: undefined,
      updatedAt: "2026-05-15T00:30:59.000Z",
    });
    const hardResult = await store.recoverStaleQueueLeases({
      runId: run.runId,
      runtimeId: "runtime-new",
      now: "2026-05-15T00:31:00.000Z",
      hardTimeoutMs: () => 30 * 60_000,
    });

    expect(hardResult).toMatchObject({ autoRequeued: 0, needsAttention: 1 });
    const hardEntry = (await store.getQueue(run.runId))[0];
    expect(hardEntry?.status).toBe("needs_attention");
    expect(hardEntry?.attentionEvidence?.code).toBe("hard_timeout");
    expect(hardEntry?.attentionEvidence?.recoveryDecision).toBe("needs_attention");
    store.close();
  });

  test("checkpointNodeSuccess commits queue, run, artifacts, and memo together", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-05-15T00:00:05.000Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");
    const completedEntry: PlaybookGraphQueueEntry = {
      ...claimed,
      status: "succeeded",
      nodeMemoKey: "sha256:memo",
      updatedAt: later,
      completedAt: later,
    };
    const artifact: PlaybookGraphArtifactVersion = {
      schemaVersion: 1,
      runId: run.runId,
      artifactId: "plan",
      versionId: "artifact-version-1",
      producerQueueEntryId: claimed.queueEntryId,
      nodePath: "plan",
      contentHash: "sha256:plan",
      value: { ok: true },
      createdAt: later,
    };
    const memo: PlaybookGraphNodeMemo = {
      schemaVersion: 1,
      runId: run.runId,
      nodeMemoKey: "sha256:memo",
      queueEntryId: claimed.queueEntryId,
      nodePath: "plan",
      status: "succeeded",
      memoKeyParts: {
        schemaVersion: 1,
        runId: run.runId,
        snapshotHash: run.snapshot.snapshotHash,
        graphHash: run.snapshot.graphHash,
        nodePath: "plan",
        nodeSpecHash: "sha256:node",
        executionContextHash: "sha256:context",
        inputSnapshotHash: "sha256:input",
      },
      artifactRefs: [
        {
          artifactId: artifact.artifactId,
          versionId: artifact.versionId,
          contentHash: artifact.contentHash,
        },
      ],
      createdAt: later,
    };

    await store.checkpointNodeSuccess({
      run: { ...run, status: "completed", updatedAt: later, completedAt: later },
      queueEntry: completedEntry,
      memo,
      artifactVersions: [artifact],
    });

    expect((await store.getRun(run.runId))?.status).toBe("completed");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("succeeded");
    expect((await store.getQueue(run.runId))[0]?.runtimeId).toBeUndefined();
    expect(await store.getArtifactVersion(run.runId, "plan", "artifact-version-1")).toEqual(
      artifact
    );
    expect(await store.getMemo(run.runId, "sha256:memo")).toEqual(memo);
    store.close();
  });

  test("checkpointNodeSuccess persists branch items atomically with queue progress", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-05-15T00:00:05.000Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");
    const branchItem: PlaybookGraphBranchItem = {
      schemaVersion: 1,
      runId: run.runId,
      parentQueueEntryId: claimed.queueEntryId,
      branchItemId: `${claimed.queueEntryId}:item:0`,
      nodePath: "plan:item:0",
      index: 0,
      itemHash: "sha256:item",
      value: { title: "First" },
      status: "queued",
      createdAt: later,
      updatedAt: later,
    };

    await store.checkpointNodeSuccess({
      run: { ...run, status: "running", updatedAt: later },
      queueEntry: {
        ...claimed,
        status: "succeeded",
        updatedAt: later,
        completedAt: later,
      },
      branchItems: [branchItem],
    });
    store.close();

    const reopened = createPlaybookGraphRunStore(dbPath);
    expect(await reopened.listBranchItems(run.runId)).toEqual([branchItem]);
    expect((await reopened.getQueue(run.runId))[0]?.status).toBe("succeeded");
    reopened.close();
  });

  test("keeps artifact versions and memo entries immutable", async () => {
    const { dbPath, run, queueEntry } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const artifact: PlaybookGraphArtifactVersion = {
      schemaVersion: 1,
      runId: run.runId,
      artifactId: "plan",
      versionId: "artifact-version-1",
      producerQueueEntryId: queueEntry.queueEntryId,
      nodePath: "plan",
      contentHash: "sha256:plan",
      value: { ok: true },
      createdAt: later,
    };
    const memo: PlaybookGraphNodeMemo = {
      schemaVersion: 1,
      runId: run.runId,
      nodeMemoKey: "sha256:memo",
      queueEntryId: queueEntry.queueEntryId,
      nodePath: "plan",
      status: "succeeded",
      memoKeyParts: {
        schemaVersion: 1,
        runId: run.runId,
        snapshotHash: run.snapshot.snapshotHash,
        graphHash: run.snapshot.graphHash,
        nodePath: "plan",
        nodeSpecHash: "sha256:node",
        executionContextHash: "sha256:context",
        inputSnapshotHash: "sha256:input",
      },
      artifactRefs: [],
      createdAt: later,
    };

    await store.addArtifactVersion(artifact);
    await store.putMemo(memo);

    await expect(
      store.addArtifactVersion({
        ...artifact,
        contentHash: "sha256:other",
        value: { ok: false },
      })
    ).rejects.toThrow(/different durable payload/);
    await expect(
      store.putMemo({
        ...memo,
        outputPreview: "changed",
      })
    ).rejects.toThrow(/different durable payload/);
    expect(await store.getArtifactVersion(run.runId, "plan", "artifact-version-1")).toEqual(
      artifact
    );
    expect(await store.getMemo(run.runId, "sha256:memo")).toEqual(memo);
    store.close();
  });

  test("checkpointNodeSuccess rejects stale claims without writing memo or artifacts", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-05-15T00:00:00.500Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");

    await expect(
      store.checkpointNodeSuccess({
        run: { ...run, status: "completed", updatedAt: later, completedAt: later },
        queueEntry: {
          ...claimed,
          status: "succeeded",
          updatedAt: later,
          completedAt: later,
        },
        artifactVersions: [
          {
            schemaVersion: 1,
            runId: run.runId,
            artifactId: "plan",
            versionId: "artifact-version-1",
            producerQueueEntryId: claimed.queueEntryId,
            nodePath: "plan",
            contentHash: "sha256:plan",
            value: { ok: true },
            createdAt: later,
          },
        ],
      })
    ).rejects.toThrow(/lease expired/);
    expect(await store.listArtifactVersions(run.runId)).toEqual([]);
    expect((await store.getRun(run.runId))?.status).toBe("queued");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("running");
    store.close();
  });

  test("checkpointNodeFailure rejects stale claims without failing the run", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-05-15T00:00:00.500Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");

    await expect(
      store.checkpointNodeFailure({
        run: {
          ...run,
          status: "failed",
          error: "stale failure",
          updatedAt: later,
          completedAt: later,
        },
        queueEntry: {
          ...claimed,
          status: "failed",
          error: "stale failure",
          updatedAt: later,
          completedAt: later,
        },
      })
    ).rejects.toThrow(/lease expired/);
    expect((await store.getRun(run.runId))?.status).toBe("queued");
    expect((await store.getQueue(run.runId))[0]?.status).toBe("running");
    expect((await store.getQueue(run.runId))[0]?.error).toBeUndefined();
    store.close();
  });

  test("checkpointNodeFailure commits failed state and clears the lease for active claims", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const claimed = await store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-05-15T00:00:02.000Z",
      now,
    });
    if (!claimed) throw new Error("Missing claim");

    await store.checkpointNodeFailure({
      run: {
        ...run,
        status: "failed",
        error: "script failed",
        updatedAt: later,
        completedAt: later,
      },
      queueEntry: {
        ...claimed,
        status: "failed",
        error: "script failed",
        updatedAt: later,
        completedAt: later,
      },
    });

    const failed = (await store.getQueue(run.runId))[0];
    expect((await store.getRun(run.runId))?.status).toBe("failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("script failed");
    expect(failed?.runtimeId).toBeUndefined();
    expect(failed?.leaseId).toBeUndefined();
    store.close();
  });

  test("lists operation records deterministically and keeps duplicate record IDs idempotent", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const first = operationRecord({ runId: run.runId, operationRecordId: "operation-record-b" });
    const second = operationRecord({
      runId: run.runId,
      operationRecordId: "operation-record-a",
      operationAttemptId: "operation-attempt-2",
      createdAt: now,
      completedAt: now,
    });

    await store.addOperationRecord(first);
    await store.addOperationRecord(second);
    await store.addOperationRecord(first);

    expect(
      (await store.listOperationRecords(run.runId)).map((record) => record.operationRecordId)
    ).toEqual(["operation-record-a", "operation-record-b"]);
    await expect(
      store.addOperationRecord({ ...first, operatorIntent: "Changed intent" })
    ).rejects.toThrow(/different durable payload/);
    store.close();
  });

  test("rejects different terminal operation records for the same attempt and kind", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const terminal = operationRecord({ runId: run.runId });
    await store.addOperationRecord(terminal);

    await expect(
      store.addOperationRecord({
        ...terminal,
        operationRecordId: "operation-record-2",
        status: "failed",
        failureReason: "commit failed",
      })
    ).rejects.toThrow(/terminal record/);
    expect(await store.listOperationRecords(run.runId)).toEqual([terminal]);
    store.close();
  });

  test("persists git intent and result rows with one operation attempt", async () => {
    const { dbPath, run } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    await store.addOperationRecord(
      operationRecord({
        runId: run.runId,
        operationRecordId: "git-started",
        operationAttemptId: "git-attempt-1",
        kind: "git_milestone",
        status: "started",
        operatorIntent: "Record Git milestone",
        affectedQueueEntryIds: [],
        completedAt: undefined,
      })
    );
    await store.addOperationRecord(
      operationRecord({
        runId: run.runId,
        operationRecordId: "git-succeeded",
        operationAttemptId: "git-attempt-1",
        kind: "git_milestone",
        status: "succeeded",
        operatorIntent: "Record Git milestone",
        affectedQueueEntryIds: [],
        gitEvidenceId: "abc123",
      })
    );

    expect((await store.listOperationRecords(run.runId)).map((record) => record.status)).toEqual([
      "started",
      "succeeded",
    ]);
    store.close();
  });

  test("applyGraphMutationWithOperationRecord rolls back graph writes when the operation is invalid", async () => {
    const { dbPath, run, queueEntry } = await createRunAndQueue();
    const store = createPlaybookGraphRunStore(dbPath);
    const reviewEvent: PlaybookGraphReviewEvent = {
      schemaVersion: 1,
      reviewEventId: "review-1",
      runId: run.runId,
      queueEntryId: queueEntry.queueEntryId,
      nodePath: queueEntry.nodePath,
      artifactId: "plan",
      decision: "approved",
      payload: {},
      createdAt: later,
    };

    await expect(
      store.applyGraphMutationWithOperationRecord({
        run: { ...run, status: "running", updatedAt: later },
        reviewEvents: [reviewEvent],
        operationRecord: {
          ...operationRecord({ runId: run.runId }),
          redactedPayloadSummary: "password: leaked",
        },
      })
    ).rejects.toThrow(/secret-bearing/);

    expect((await store.getRun(run.runId))?.status).toBe("queued");
    expect(await store.listReviewEvents(run.runId)).toEqual([]);
    expect(await store.listOperationRecords(run.runId)).toEqual([]);
    store.close();
  });
});
