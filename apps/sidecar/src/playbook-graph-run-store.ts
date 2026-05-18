import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  PlaybookGraphArtifactVersion,
  PlaybookGraphBranchItem,
  PlaybookGraphNodeMemo,
  PlaybookGraphOperationRecord,
  PlaybookGraphQueueEntry,
  PlaybookGraphReviewEvent,
  PlaybookGraphRunListFilter,
  PlaybookGraphRunRecord,
} from "@tessera/contracts";
import {
  PlaybookGraphArtifactVersionSchema,
  PlaybookGraphBranchItemSchema,
  PlaybookGraphNodeMemoSchema,
  PlaybookGraphOperationRecordSchema,
  PlaybookGraphQueueEntrySchema,
  PlaybookGraphReviewEventSchema,
  PlaybookGraphRunRecordSchema,
} from "@tessera/contracts";
import { type GraphRunStore, parsePinnedCompiledGraph, stableJsonStringify } from "@tessera/core";
import { configureSidecarSqlite } from "./sqlite.js";

type PayloadRow = { payload: string };
type QueuePayloadRow = {
  queue_entry_id: string;
  status: PlaybookGraphQueueEntry["status"];
  payload: string;
};

const QUEUE_SUCCESS_STATUSES = new Set(["succeeded", "memoized", "skipped"]);

function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

function runWithVerifiedSnapshot(run: PlaybookGraphRunRecord): PlaybookGraphRunRecord {
  try {
    parsePinnedCompiledGraph(run.snapshot);
    return run;
  } catch (error) {
    return {
      ...run,
      status: "needs_repair",
      repairReason: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
  }
}

function persistedTerminalQueueEntry(entry: PlaybookGraphQueueEntry): PlaybookGraphQueueEntry {
  if (entry.status !== "succeeded" && entry.status !== "memoized" && entry.status !== "failed") {
    return entry;
  }
  return {
    ...entry,
    runtimeId: undefined,
    leaseId: undefined,
    claimedAt: undefined,
    leaseExpiresAt: undefined,
  };
}

export interface PlaybookGraphRunStore extends GraphRunStore {
  close(): void;
}

export function createPlaybookGraphRunStore(dbPath: string): PlaybookGraphRunStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  configureSidecarSqlite(db, dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_graph_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      playbook_id TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playbook_graph_queue (
      queue_entry_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      node_path TEXT NOT NULL,
      status TEXT NOT NULL,
      runtime_id TEXT,
      lease_id TEXT,
      lease_expires_at TEXT,
      depends_on_json TEXT NOT NULL,
      consumes_artifacts_json TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS playbook_graph_queue_run_status_idx
      ON playbook_graph_queue (run_id, status, updated_at);

    CREATE INDEX IF NOT EXISTS playbook_graph_runs_playbook_updated_idx
      ON playbook_graph_runs (playbook_id, updated_at DESC, run_id DESC);

    CREATE INDEX IF NOT EXISTS playbook_graph_runs_status_updated_idx
      ON playbook_graph_runs (status, updated_at DESC, run_id DESC);

    CREATE INDEX IF NOT EXISTS playbook_graph_runs_playbook_status_updated_idx
      ON playbook_graph_runs (playbook_id, status, updated_at DESC, run_id DESC);

    CREATE TABLE IF NOT EXISTS playbook_graph_branch_items (
      branch_item_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playbook_graph_artifact_versions (
      run_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      producer_queue_entry_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, artifact_id, version_id)
    );

    CREATE TABLE IF NOT EXISTS playbook_graph_review_events (
      review_event_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      queue_entry_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playbook_graph_operation_records (
      operation_record_id TEXT PRIMARY KEY NOT NULL,
      operation_attempt_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS playbook_graph_operation_records_run_idx
      ON playbook_graph_operation_records (run_id, created_at, operation_record_id);

    CREATE INDEX IF NOT EXISTS playbook_graph_operation_records_attempt_idx
      ON playbook_graph_operation_records (operation_attempt_id);

    CREATE TABLE IF NOT EXISTS playbook_graph_node_memos (
      run_id TEXT NOT NULL,
      node_memo_key TEXT NOT NULL,
      queue_entry_id TEXT NOT NULL,
      node_path TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_memo_key)
    );
  `);

  const saveRun = db.prepare(`
    INSERT INTO playbook_graph_runs (run_id, playbook_id, status, snapshot_hash, payload, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      playbook_id = excluded.playbook_id,
      status = excluded.status,
      snapshot_hash = excluded.snapshot_hash,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const getRun = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_runs WHERE run_id = ?"
  );
  const listRuns = db.prepare<PayloadRow, []>(
    "SELECT payload FROM playbook_graph_runs ORDER BY updated_at DESC, run_id DESC"
  );
  const listRunsLimited = db.prepare<PayloadRow, [number]>(
    "SELECT payload FROM playbook_graph_runs ORDER BY updated_at DESC, run_id DESC LIMIT ?"
  );
  const listRunsByPlaybook = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_runs WHERE playbook_id = ? ORDER BY updated_at DESC, run_id DESC"
  );
  const listRunsByPlaybookLimited = db.prepare<PayloadRow, [string, number]>(
    "SELECT payload FROM playbook_graph_runs WHERE playbook_id = ? ORDER BY updated_at DESC, run_id DESC LIMIT ?"
  );
  const listRunsByStatus = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_runs WHERE status = ? ORDER BY updated_at DESC, run_id DESC"
  );
  const listRunsByStatusLimited = db.prepare<PayloadRow, [string, number]>(
    "SELECT payload FROM playbook_graph_runs WHERE status = ? ORDER BY updated_at DESC, run_id DESC LIMIT ?"
  );
  const listRunsByPlaybookAndStatus = db.prepare<PayloadRow, [string, string]>(
    "SELECT payload FROM playbook_graph_runs WHERE playbook_id = ? AND status = ? ORDER BY updated_at DESC, run_id DESC"
  );
  const listRunsByPlaybookAndStatusLimited = db.prepare<PayloadRow, [string, string, number]>(
    "SELECT payload FROM playbook_graph_runs WHERE playbook_id = ? AND status = ? ORDER BY updated_at DESC, run_id DESC LIMIT ?"
  );
  const saveQueue = db.prepare(`
    INSERT INTO playbook_graph_queue (
      queue_entry_id, run_id, node_path, status, runtime_id, lease_id, lease_expires_at,
      depends_on_json, consumes_artifacts_json, payload, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue_entry_id) DO UPDATE SET
      run_id = excluded.run_id,
      node_path = excluded.node_path,
      status = excluded.status,
      runtime_id = excluded.runtime_id,
      lease_id = excluded.lease_id,
      lease_expires_at = excluded.lease_expires_at,
      depends_on_json = excluded.depends_on_json,
      consumes_artifacts_json = excluded.consumes_artifacts_json,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const getQueue = db.prepare<QueuePayloadRow, [string]>(
    "SELECT queue_entry_id, status, payload FROM playbook_graph_queue WHERE run_id = ? ORDER BY updated_at ASC, queue_entry_id ASC"
  );
  const queuedEntries = db.prepare<QueuePayloadRow, [string]>(
    "SELECT queue_entry_id, status, payload FROM playbook_graph_queue WHERE run_id = ? AND status = 'queued' ORDER BY updated_at ASC, queue_entry_id ASC"
  );
  const getQueueStatus = db.prepare<{ status: string } | null, [string]>(
    "SELECT status FROM playbook_graph_queue WHERE queue_entry_id = ?"
  );
  const getQueuePayload = db.prepare<PayloadRow | null, [string]>(
    "SELECT payload FROM playbook_graph_queue WHERE queue_entry_id = ?"
  );
  const getArtifactPayload = db.prepare<PayloadRow | null, [string, string, string]>(
    "SELECT payload FROM playbook_graph_artifact_versions WHERE run_id = ? AND artifact_id = ? AND version_id = ?"
  );
  const saveArtifact = db.prepare(`
    INSERT INTO playbook_graph_artifact_versions (
      run_id, artifact_id, version_id, producer_queue_entry_id, content_hash, payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listArtifacts = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_artifact_versions WHERE run_id = ? ORDER BY created_at ASC, version_id ASC"
  );
  const saveBranchItem = db.prepare(`
    INSERT INTO playbook_graph_branch_items (branch_item_id, run_id, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(branch_item_id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const listBranchItems = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_branch_items WHERE run_id = ? ORDER BY updated_at ASC, branch_item_id ASC"
  );
  const saveReview = db.prepare(`
    INSERT INTO playbook_graph_review_events (review_event_id, run_id, queue_entry_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(review_event_id) DO UPDATE SET
      payload = excluded.payload,
      created_at = excluded.created_at
  `);
  const listReviews = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_review_events WHERE run_id = ? ORDER BY created_at ASC"
  );
  const getOperationRecordPayload = db.prepare<PayloadRow | null, [string]>(
    "SELECT payload FROM playbook_graph_operation_records WHERE operation_record_id = ?"
  );
  const listOperations = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_operation_records WHERE run_id = ? ORDER BY created_at ASC, operation_record_id ASC"
  );
  const listAttemptTerminalOperations = db.prepare<PayloadRow, [string, string]>(
    "SELECT payload FROM playbook_graph_operation_records WHERE operation_attempt_id = ? AND kind = ? AND status IN ('succeeded', 'failed') ORDER BY created_at ASC, operation_record_id ASC"
  );
  const saveOperation = db.prepare(`
    INSERT INTO playbook_graph_operation_records (
      operation_record_id, operation_attempt_id, run_id, kind, status, payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const saveMemo = db.prepare(`
    INSERT INTO playbook_graph_node_memos (
      run_id, node_memo_key, queue_entry_id, node_path, payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getMemo = db.prepare<PayloadRow | null, [string, string]>(
    "SELECT payload FROM playbook_graph_node_memos WHERE run_id = ? AND node_memo_key = ?"
  );
  const markStaleLeases = db.prepare<[number], [string, string, string, string]>(`
    UPDATE playbook_graph_queue
    SET status = 'interrupted',
        runtime_id = NULL,
        lease_id = NULL,
        lease_expires_at = NULL,
        payload = json_set(
          json_remove(payload, '$.runtimeId', '$.leaseId', '$.claimedAt', '$.leaseExpiresAt'),
          '$.status', 'interrupted',
          '$.blockedReason', 'Tessera stopped while this step was running. This can happen if the app or sidecar restarted during the step.',
          '$.updatedAt', ?
        ),
        updated_at = ?
    WHERE run_id = ?
      AND status = 'running'
      AND lease_expires_at <= ?
  `);

  function writeRun(run: PlaybookGraphRunRecord): void {
    const parsed = PlaybookGraphRunRecordSchema.parse(run);
    saveRun.run(
      parsed.runId,
      parsed.playbookId,
      parsed.status,
      parsed.snapshot.snapshotHash,
      JSON.stringify(parsed),
      parsed.updatedAt
    );
  }

  function writeQueue(entry: PlaybookGraphQueueEntry): void {
    const parsed = PlaybookGraphQueueEntrySchema.parse(entry);
    saveQueue.run(
      parsed.queueEntryId,
      parsed.runId,
      parsed.nodePath,
      parsed.status,
      parsed.runtimeId ?? null,
      parsed.leaseId ?? null,
      parsed.leaseExpiresAt ?? null,
      JSON.stringify(parsed.dependsOn),
      JSON.stringify(parsed.consumesArtifacts),
      JSON.stringify(parsed),
      parsed.updatedAt
    );
  }

  function parseRun(row: PayloadRow | null): PlaybookGraphRunRecord | undefined {
    if (!row) return undefined;
    const parsed = PlaybookGraphRunRecordSchema.parse(parseJson<unknown>(row.payload));
    const verified = runWithVerifiedSnapshot(parsed);
    if (verified.status === "needs_repair" && parsed.status !== "needs_repair") {
      writeRun(verified);
    }
    return verified;
  }

  function parseQueue(
    row: PayloadRow | QueuePayloadRow | null
  ): PlaybookGraphQueueEntry | undefined {
    if (!row) return undefined;
    return PlaybookGraphQueueEntrySchema.parse(parseJson<unknown>(row.payload));
  }

  function parseArtifact(row: PayloadRow | null): PlaybookGraphArtifactVersion | undefined {
    if (!row) return undefined;
    return PlaybookGraphArtifactVersionSchema.parse(parseJson<unknown>(row.payload));
  }

  function parseBranchItem(row: PayloadRow | null): PlaybookGraphBranchItem | undefined {
    if (!row) return undefined;
    return PlaybookGraphBranchItemSchema.parse(parseJson<unknown>(row.payload));
  }

  function dependenciesSatisfied(entry: PlaybookGraphQueueEntry): boolean {
    for (const dependencyId of entry.dependsOn) {
      const row = getQueueStatus.get(dependencyId);
      if (!row || !QUEUE_SUCCESS_STATUSES.has(row.status)) return false;
    }
    for (const artifact of entry.consumesArtifacts) {
      const artifactRow = getArtifactPayload.get(
        entry.runId,
        artifact.artifactId,
        artifact.versionId
      );
      if (!artifactRow) {
        return false;
      }
      const persisted = PlaybookGraphArtifactVersionSchema.parse(
        parseJson<unknown>(artifactRow.payload)
      );
      if (persisted.contentHash !== artifact.contentHash) return false;
    }
    return true;
  }

  function shouldWriteImmutablePayload(
    existing: PayloadRow | null,
    next: unknown,
    label: string
  ): boolean {
    if (!existing) return true;
    const previous = parseJson<unknown>(existing.payload);
    if (stableJsonStringify(previous) === stableJsonStringify(next)) return false;
    throw new Error(`${label} already exists with different durable payload`);
  }

  function writeArtifactVersion(version: PlaybookGraphArtifactVersion): void {
    const parsed = PlaybookGraphArtifactVersionSchema.parse(version);
    const shouldWrite = shouldWriteImmutablePayload(
      getArtifactPayload.get(parsed.runId, parsed.artifactId, parsed.versionId),
      parsed,
      "Graph artifact version"
    );
    if (!shouldWrite) return;
    saveArtifact.run(
      parsed.runId,
      parsed.artifactId,
      parsed.versionId,
      parsed.producerQueueEntryId,
      parsed.contentHash,
      JSON.stringify(parsed),
      parsed.createdAt
    );
  }

  function writeMemo(memo: PlaybookGraphNodeMemo): void {
    const parsed = PlaybookGraphNodeMemoSchema.parse(memo);
    const shouldWrite = shouldWriteImmutablePayload(
      getMemo.get(parsed.runId, parsed.nodeMemoKey),
      parsed,
      "Graph node memo"
    );
    if (!shouldWrite) return;
    saveMemo.run(
      parsed.runId,
      parsed.nodeMemoKey,
      parsed.queueEntryId,
      parsed.nodePath,
      JSON.stringify(parsed),
      parsed.createdAt
    );
  }

  function writeOperationRecord(record: PlaybookGraphOperationRecord): void {
    const parsed = PlaybookGraphOperationRecordSchema.parse(record);
    const existingById = getOperationRecordPayload.get(parsed.operationRecordId);
    if (existingById) {
      const previous = parseJson<unknown>(existingById.payload);
      if (stableJsonStringify(previous) === stableJsonStringify(parsed)) return;
      throw new Error("Graph operation record already exists with different durable payload");
    }
    if (parsed.status === "succeeded" || parsed.status === "failed") {
      for (const existing of listAttemptTerminalOperations.all(
        parsed.operationAttemptId,
        parsed.kind
      )) {
        const previous = parseJson<unknown>(existing.payload);
        if (stableJsonStringify(previous) === stableJsonStringify(parsed)) return;
        throw new Error("Graph operation attempt already has a different terminal record");
      }
    }
    saveOperation.run(
      parsed.operationRecordId,
      parsed.operationAttemptId,
      parsed.runId,
      parsed.kind,
      parsed.status,
      JSON.stringify(parsed),
      parsed.createdAt
    );
  }

  function writeBranchItem(item: PlaybookGraphBranchItem): void {
    const parsed = PlaybookGraphBranchItemSchema.parse(item);
    saveBranchItem.run(parsed.branchItemId, parsed.runId, JSON.stringify(parsed), parsed.updatedAt);
  }

  const claimTransaction = db.transaction(
    (input: {
      runId: string;
      runtimeId: string;
      leaseId: string;
      leaseExpiresAt: string;
      now: string;
    }) => {
      for (const row of queuedEntries.all(input.runId)) {
        const entry = parseQueue(row);
        if (!entry || !dependenciesSatisfied(entry)) continue;
        const claimed = PlaybookGraphQueueEntrySchema.parse({
          ...entry,
          status: "running",
          runtimeId: input.runtimeId,
          leaseId: input.leaseId,
          claimedAt: input.now,
          leaseExpiresAt: input.leaseExpiresAt,
          attempt: entry.attempt + 1,
          updatedAt: input.now,
        });
        const result = db
          .prepare(
            "UPDATE playbook_graph_queue SET status = ?, runtime_id = ?, lease_id = ?, lease_expires_at = ?, payload = ?, updated_at = ? WHERE queue_entry_id = ? AND status = 'queued'"
          )
          .run(
            claimed.status,
            claimed.runtimeId ?? null,
            claimed.leaseId ?? null,
            claimed.leaseExpiresAt ?? null,
            JSON.stringify(claimed),
            claimed.updatedAt,
            claimed.queueEntryId
          );
        if (result.changes === 1) return claimed;
      }
      return undefined;
    }
  );

  const checkpointTransaction = db.transaction(
    (input: {
      run: PlaybookGraphRunRecord;
      queueEntry: PlaybookGraphQueueEntry;
      queueEntries?: PlaybookGraphQueueEntry[];
      branchItems?: PlaybookGraphBranchItem[];
      memo?: PlaybookGraphNodeMemo;
      artifactVersions?: PlaybookGraphArtifactVersion[];
    }) => {
      const existing = parseQueue(getQueuePayload.get(input.queueEntry.queueEntryId));
      if (!existing || existing.status !== "running") {
        throw new Error("Cannot checkpoint graph node without an active queue claim");
      }
      if (
        !input.queueEntry.runtimeId ||
        !input.queueEntry.leaseId ||
        existing.runtimeId !== input.queueEntry.runtimeId ||
        existing.leaseId !== input.queueEntry.leaseId
      ) {
        throw new Error("Cannot checkpoint graph node with a stale queue claim");
      }
      const checkpointedAt = input.queueEntry.completedAt ?? input.queueEntry.updatedAt;
      if (existing.leaseExpiresAt && existing.leaseExpiresAt < checkpointedAt) {
        throw new Error("Cannot checkpoint graph node after its lease expired");
      }

      writeRun(input.run);
      writeQueue(persistedTerminalQueueEntry(input.queueEntry));
      for (const entry of input.queueEntries ?? []) {
        writeQueue(entry);
      }
      for (const item of input.branchItems ?? []) {
        writeBranchItem(item);
      }
      for (const version of input.artifactVersions ?? []) {
        writeArtifactVersion(version);
      }
      if (input.memo) {
        writeMemo(input.memo);
      }
    }
  );

  const createRunWithQueueTransaction = db.transaction(
    (input: {
      run: PlaybookGraphRunRecord;
      queueEntries: PlaybookGraphQueueEntry[];
    }) => {
      writeRun(input.run);
      for (const entry of input.queueEntries) {
        writeQueue(entry);
      }
    }
  );

  const checkpointFailureTransaction = db.transaction(
    (input: {
      run: PlaybookGraphRunRecord;
      queueEntry: PlaybookGraphQueueEntry;
    }) => {
      const existing = parseQueue(getQueuePayload.get(input.queueEntry.queueEntryId));
      if (!existing || existing.status !== "running") {
        throw new Error("Cannot checkpoint graph node without an active queue claim");
      }
      if (
        !input.queueEntry.runtimeId ||
        !input.queueEntry.leaseId ||
        existing.runtimeId !== input.queueEntry.runtimeId ||
        existing.leaseId !== input.queueEntry.leaseId
      ) {
        throw new Error("Cannot checkpoint graph node with a stale queue claim");
      }
      const checkpointedAt = input.queueEntry.completedAt ?? input.queueEntry.updatedAt;
      if (existing.leaseExpiresAt && existing.leaseExpiresAt < checkpointedAt) {
        throw new Error("Cannot checkpoint graph node after its lease expired");
      }

      writeRun(input.run);
      writeQueue(persistedTerminalQueueEntry(input.queueEntry));
    }
  );

  const graphMutationOperationTransaction = db.transaction(
    (input: {
      run?: PlaybookGraphRunRecord;
      queueEntries?: PlaybookGraphQueueEntry[];
      branchItems?: PlaybookGraphBranchItem[];
      artifactVersions?: PlaybookGraphArtifactVersion[];
      reviewEvents?: PlaybookGraphReviewEvent[];
      operationRecord: PlaybookGraphOperationRecord;
    }) => {
      if (input.run) writeRun(input.run);
      for (const entry of input.queueEntries ?? []) writeQueue(entry);
      for (const item of input.branchItems ?? []) writeBranchItem(item);
      for (const version of input.artifactVersions ?? []) writeArtifactVersion(version);
      for (const event of input.reviewEvents ?? []) {
        const parsed = PlaybookGraphReviewEventSchema.parse(event);
        saveReview.run(
          parsed.reviewEventId,
          parsed.runId,
          parsed.queueEntryId,
          JSON.stringify(parsed),
          parsed.createdAt
        );
      }
      writeOperationRecord(input.operationRecord);
    }
  );

  return {
    close() {
      db.close();
    },
    async createRun(run) {
      writeRun(run);
    },
    async createRunWithQueue(input) {
      createRunWithQueueTransaction(input);
    },
    async getRun(runId) {
      return parseRun(getRun.get(runId));
    },
    async updateRun(run) {
      writeRun(run);
    },
    async listRuns(filter) {
      const limit = filter?.limit;
      const rows =
        filter?.playbookId && filter.status
          ? limit
            ? listRunsByPlaybookAndStatusLimited.all(filter.playbookId, filter.status, limit)
            : listRunsByPlaybookAndStatus.all(filter.playbookId, filter.status)
          : filter?.playbookId
            ? limit
              ? listRunsByPlaybookLimited.all(filter.playbookId, limit)
              : listRunsByPlaybook.all(filter.playbookId)
            : filter?.status
              ? limit
                ? listRunsByStatusLimited.all(filter.status, limit)
                : listRunsByStatus.all(filter.status)
              : limit
                ? listRunsLimited.all(limit)
                : listRuns.all();
      return rows.flatMap((row) => {
        const run = parseRun(row);
        return run ? [run] : [];
      });
    },
    async getQueue(runId) {
      return getQueue.all(runId).flatMap((row) => {
        const entry = parseQueue(row);
        return entry ? [entry] : [];
      });
    },
    async upsertQueueEntry(entry) {
      writeQueue(entry);
    },
    async updateQueueEntry(entry) {
      writeQueue(entry);
    },
    async listBranchItems(runId) {
      return listBranchItems.all(runId).flatMap((row) => {
        const item = parseBranchItem(row);
        return item ? [item] : [];
      });
    },
    async upsertBranchItem(item) {
      writeBranchItem(item);
    },
    async claimNextQueuedEntry(input) {
      return claimTransaction(input);
    },
    async renewQueueLease(input) {
      const entry = parseQueue(getQueuePayload.get(input.queueEntryId));
      if (
        !entry ||
        entry.runId !== input.runId ||
        entry.status !== "running" ||
        entry.runtimeId !== input.runtimeId ||
        entry.leaseId !== input.leaseId
      ) {
        return false;
      }
      writeQueue({
        ...entry,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      });
      return true;
    },
    async releaseQueueLease(input) {
      const entry = parseQueue(getQueuePayload.get(input.queueEntryId));
      if (
        !entry ||
        entry.runId !== input.runId ||
        entry.status !== "running" ||
        entry.runtimeId !== input.runtimeId ||
        entry.leaseId !== input.leaseId
      ) {
        return false;
      }
      writeQueue({
        ...entry,
        status: "queued",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: input.now,
      });
      return true;
    },
    async listArtifactVersions(runId) {
      return listArtifacts.all(runId).flatMap((row) => {
        const artifact = parseArtifact(row);
        return artifact ? [artifact] : [];
      });
    },
    async addArtifactVersion(version) {
      writeArtifactVersion(version);
    },
    async getArtifactVersion(runId, artifactId, versionId) {
      return parseArtifact(getArtifactPayload.get(runId, artifactId, versionId));
    },
    async listReviewEvents(runId) {
      return listReviews
        .all(runId)
        .map((row) => PlaybookGraphReviewEventSchema.parse(parseJson<unknown>(row.payload)));
    },
    async addReviewEvent(event: PlaybookGraphReviewEvent) {
      const parsed = PlaybookGraphReviewEventSchema.parse(event);
      saveReview.run(
        parsed.reviewEventId,
        parsed.runId,
        parsed.queueEntryId,
        JSON.stringify(parsed),
        parsed.createdAt
      );
    },
    async listOperationRecords(runId) {
      return listOperations
        .all(runId)
        .map((row) => PlaybookGraphOperationRecordSchema.parse(parseJson<unknown>(row.payload)));
    },
    async addOperationRecord(record) {
      writeOperationRecord(record);
    },
    async applyGraphMutationWithOperationRecord(input) {
      graphMutationOperationTransaction(input);
    },
    async getMemo(runId, nodeMemoKey) {
      const row = getMemo.get(runId, nodeMemoKey);
      return row ? PlaybookGraphNodeMemoSchema.parse(parseJson<unknown>(row.payload)) : undefined;
    },
    async putMemo(memo) {
      writeMemo(memo);
    },
    async markStaleQueueLeasesInterrupted(input) {
      const result = markStaleLeases.run(
        input.interruptedAt,
        input.interruptedAt,
        input.runId,
        input.now
      );
      return result.changes;
    },
    async checkpointNodeSuccess(input) {
      checkpointTransaction(input);
    },
    async checkpointNodeFailure(input) {
      checkpointFailureTransaction(input);
    },
  };
}
