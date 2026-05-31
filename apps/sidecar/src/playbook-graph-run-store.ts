import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  EffectExecutionRecord,
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
  EffectExecutionRecordSchema,
  PlaybookGraphArtifactVersionSchema,
  PlaybookGraphBranchItemSchema,
  PlaybookGraphNodeMemoSchema,
  PlaybookGraphOperationRecordSchema,
  PlaybookGraphQueueEntrySchema,
  PlaybookGraphReviewEventSchema,
  PlaybookGraphRunRecordSchema,
} from "@tessera/contracts";
import {
  type GraphRunStore,
  HEARTBEAT_STALENESS_MS,
  parsePinnedCompiledGraph,
  stableJsonStringify,
} from "@tessera/core";
import { configureSidecarSqlite } from "./sqlite.js";

type PayloadRow = { payload: string };
type RunListParam = string | number;
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

function runWorkspaceRoot(run: PlaybookGraphRunRecord): string | undefined {
  return run.materialization?.kind === "workspace" ? run.materialization.workspaceRoot : undefined;
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
      owner_user_key TEXT,
      playbook_id TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_root TEXT,
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

    CREATE TABLE IF NOT EXISTS playbook_graph_effect_execution_records (
      effect_execution_record_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      node_path TEXT NOT NULL,
      capability TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      idempotency_key TEXT,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS playbook_graph_effect_records_run_idx
      ON playbook_graph_effect_execution_records (run_id, created_at, effect_execution_record_id);

    CREATE INDEX IF NOT EXISTS playbook_graph_effect_records_idempotency_idx
      ON playbook_graph_effect_execution_records (
        run_id, node_path, capability, adapter_id, idempotency_key, status, created_at
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

  const runColumns = db.query<{ name: string }, []>("PRAGMA table_info(playbook_graph_runs)").all();
  if (!runColumns.some((column) => column.name === "owner_user_key")) {
    db.run("ALTER TABLE playbook_graph_runs ADD COLUMN owner_user_key TEXT");
  }
  if (!runColumns.some((column) => column.name === "workspace_root")) {
    db.run("ALTER TABLE playbook_graph_runs ADD COLUMN workspace_root TEXT");
  }
  db.run(`
    CREATE INDEX IF NOT EXISTS playbook_graph_runs_owner_workspace_updated_idx
      ON playbook_graph_runs (owner_user_key, workspace_root, updated_at DESC, run_id DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS playbook_graph_runs_owner_workspace_playbook_updated_idx
      ON playbook_graph_runs (owner_user_key, workspace_root, playbook_id, updated_at DESC, run_id DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS playbook_graph_runs_owner_workspace_status_updated_idx
      ON playbook_graph_runs (owner_user_key, workspace_root, status, updated_at DESC, run_id DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS playbook_graph_runs_owner_workspace_playbook_status_updated_idx
      ON playbook_graph_runs (owner_user_key, workspace_root, playbook_id, status, updated_at DESC, run_id DESC)
  `);

  const queueColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(playbook_graph_queue)")
    .all();
  if (!queueColumns.some((column) => column.name === "last_heartbeat_at")) {
    db.run("ALTER TABLE playbook_graph_queue ADD COLUMN last_heartbeat_at TEXT");
  }

  const saveRun = db.prepare(`
    INSERT INTO playbook_graph_runs (
      run_id, owner_user_key, playbook_id, status, workspace_root, snapshot_hash, payload, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      owner_user_key = excluded.owner_user_key,
      playbook_id = excluded.playbook_id,
      status = excluded.status,
      workspace_root = excluded.workspace_root,
      snapshot_hash = excluded.snapshot_hash,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const getRun = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_runs WHERE run_id = ?"
  );
  const saveQueue = db.prepare(`
    INSERT INTO playbook_graph_queue (
      queue_entry_id, run_id, node_path, status, runtime_id, lease_id, lease_expires_at,
      last_heartbeat_at, depends_on_json, consumes_artifacts_json, payload, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue_entry_id) DO UPDATE SET
      run_id = excluded.run_id,
      node_path = excluded.node_path,
      status = excluded.status,
      runtime_id = excluded.runtime_id,
      lease_id = excluded.lease_id,
      lease_expires_at = excluded.lease_expires_at,
      last_heartbeat_at = excluded.last_heartbeat_at,
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
  const getEffectRecordPayload = db.prepare<PayloadRow | null, [string]>(
    "SELECT payload FROM playbook_graph_effect_execution_records WHERE effect_execution_record_id = ?"
  );
  const saveEffectRecord = db.prepare(`
    INSERT INTO playbook_graph_effect_execution_records (
      effect_execution_record_id, run_id, node_path, capability, adapter_id,
      idempotency_key, status, payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listEffectRecords = db.prepare<PayloadRow, [string]>(
    "SELECT payload FROM playbook_graph_effect_execution_records WHERE run_id = ? ORDER BY created_at ASC, effect_execution_record_id ASC"
  );
  const findCommittedEffectRecord = db.prepare<
    PayloadRow | null,
    [string, string, string, string, string]
  >(
    `SELECT payload FROM playbook_graph_effect_execution_records
     WHERE run_id = ?
       AND node_path = ?
       AND capability = ?
       AND adapter_id = ?
       AND idempotency_key = ?
       AND status = 'committed'
     ORDER BY created_at ASC, effect_execution_record_id ASC
     LIMIT 1`
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
  const bumpHeartbeatStatement = db.prepare(`
    UPDATE playbook_graph_queue
    SET last_heartbeat_at = ?,
        updated_at = ?,
        payload = json_set(payload, '$.lastHeartbeatAt', ?, '$.updatedAt', ?)
    WHERE queue_entry_id = ?
      AND run_id = ?
      AND status = 'running'
      AND lease_id = ?
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
      parsed.ownerUserKey ?? null,
      parsed.playbookId,
      parsed.status,
      runWorkspaceRoot(parsed) ?? null,
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
      parsed.lastHeartbeatAt ?? null,
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

  function listRunRows(filter?: PlaybookGraphRunListFilter): PayloadRow[] {
    const clauses: string[] = [];
    const params: RunListParam[] = [];
    if (filter?.ownerUserKey !== undefined) {
      clauses.push("owner_user_key = ?");
      params.push(filter.ownerUserKey);
    }
    if (filter?.workspaceRoot !== undefined) {
      clauses.push("workspace_root = ?");
      params.push(filter.workspaceRoot);
    }
    if (filter?.playbookId !== undefined) {
      clauses.push("playbook_id = ?");
      params.push(filter.playbookId);
    }
    if (filter?.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const sql = [
      "SELECT payload FROM playbook_graph_runs",
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      "ORDER BY updated_at DESC, run_id DESC",
      filter?.limit ? "LIMIT ?" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (filter?.limit) {
      params.push(filter.limit);
    }
    return db.query<PayloadRow, RunListParam[]>(sql).all(...params);
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
    const dependencies = entry.dependsOn.map((dependencyId) =>
      parseQueue(getQueuePayload.get(dependencyId))
    );
    const dependencyArtifacts = new Set(
      dependencies.flatMap((dependency) => dependency?.producesArtifacts ?? [])
    );
    const unresolvedDependencyArtifacts = entry.declaredConsumesArtifacts.some(
      (artifactId) =>
        dependencyArtifacts.has(artifactId) &&
        !entry.consumesArtifacts.some((artifact) => artifact.artifactId === artifactId)
    );
    if (unresolvedDependencyArtifacts) {
      return false;
    }
    for (const dependency of dependencies) {
      if (!dependency || !QUEUE_SUCCESS_STATUSES.has(dependency.status)) return false;
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

  function writeEffectExecutionRecord(record: EffectExecutionRecord): void {
    const parsed = EffectExecutionRecordSchema.parse(record);
    const existingById = getEffectRecordPayload.get(parsed.effectExecutionRecordId);
    if (existingById) {
      const previous = parseJson<unknown>(existingById.payload);
      if (stableJsonStringify(previous) === stableJsonStringify(parsed)) return;
      throw new Error("Effect execution record already exists with different durable payload");
    }
    saveEffectRecord.run(
      parsed.effectExecutionRecordId,
      parsed.runId,
      parsed.nodePath,
      parsed.capability,
      parsed.adapterId,
      parsed.idempotencyKey ?? null,
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
      effectRecords?: EffectExecutionRecord[];
      operationRecord: PlaybookGraphOperationRecord;
    }) => {
      if (input.run) writeRun(input.run);
      for (const entry of input.queueEntries ?? []) writeQueue(entry);
      for (const item of input.branchItems ?? []) writeBranchItem(item);
      for (const version of input.artifactVersions ?? []) writeArtifactVersion(version);
      for (const record of input.effectRecords ?? []) writeEffectExecutionRecord(record);
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
      const rows = listRunRows(filter);
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
    async bumpHeartbeat(input) {
      const result = bumpHeartbeatStatement.run(
        input.now,
        input.now,
        input.now,
        input.now,
        input.queueEntryId,
        input.runId,
        input.leaseId
      );
      return result.changes === 1;
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
    async listEffectExecutionRecords(runId) {
      return listEffectRecords
        .all(runId)
        .map((row) => EffectExecutionRecordSchema.parse(parseJson<unknown>(row.payload)));
    },
    async addEffectExecutionRecord(record) {
      writeEffectExecutionRecord(record);
    },
    async findCommittedEffectExecutionRecord(input) {
      const row = findCommittedEffectRecord.get(
        input.runId,
        input.nodePath,
        input.capability,
        input.adapterId,
        input.idempotencyKey
      );
      return row ? EffectExecutionRecordSchema.parse(parseJson<unknown>(row.payload)) : undefined;
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
    async recoverStaleQueueLeases(input) {
      let inspected = 0;
      let autoRequeued = 0;
      let needsAttention = 0;
      const operationRecords = listOperations
        .all(input.runId)
        .map((row) => PlaybookGraphOperationRecordSchema.parse(parseJson<unknown>(row.payload)));
      for (const entry of getQueue.all(input.runId).flatMap((row) => {
        const parsed = parseQueue(row);
        return parsed ? [parsed] : [];
      })) {
        if (entry.status !== "running") continue;

        const leaseExpired = !!entry.leaseExpiresAt && entry.leaseExpiresAt <= input.now;
        const heartbeatStaleMs =
          entry.lastHeartbeatAt && Date.parse(input.now) - Date.parse(entry.lastHeartbeatAt);
        const heartbeatStale =
          typeof heartbeatStaleMs === "number" && heartbeatStaleMs > HEARTBEAT_STALENESS_MS;
        const hardMs = input.hardTimeoutMs?.(entry.nodeKind);
        const hardCrossed =
          typeof hardMs === "number" &&
          !!entry.claimedAt &&
          Date.parse(input.now) - Date.parse(entry.claimedAt) > hardMs;

        if (!leaseExpired && !heartbeatStale && !hardCrossed) continue;

        inspected += 1;

        const code = hardCrossed
          ? ("hard_timeout" as const)
          : heartbeatStale
            ? ("stale_heartbeat" as const)
            : ("stale_lease" as const);
        const thresholdMs = hardCrossed
          ? hardMs
          : heartbeatStale
            ? HEARTBEAT_STALENESS_MS
            : undefined;
        const reason =
          code === "hard_timeout"
            ? `Step exceeded hard timeout of ${hardMs}ms`
            : code === "stale_heartbeat"
              ? "Worker stopped emitting heartbeats; presumed lost"
              : "Tessera stopped while this step was running. This can happen if the app or sidecar restarted during the step.";
        const alreadyAutoRetried = operationRecords.some(
          (operation) =>
            operation.kind === "retry_needs_attention" &&
            operation.actionSpecId === "system.recovery.auto_retry" &&
            operation.affectedQueueEntryIds.includes(entry.queueEntryId)
        );
        const shouldAutoRequeue =
          entry.recoveryPolicy === "rerun_if_no_success_memo" &&
          code !== "hard_timeout" &&
          !alreadyAutoRetried;
        const attentionEvidence = {
          code,
          reason,
          observedAt: input.now,
          previousQueueStatus: "running" as const,
          ...(entry.runtimeId ? { lastRuntimeId: entry.runtimeId } : {}),
          ...(entry.leaseId ? { lastLeaseId: entry.leaseId } : {}),
          ...(entry.claimedAt ? { lastClaimedAt: entry.claimedAt } : {}),
          ...(entry.leaseExpiresAt && leaseExpired ? { leaseExpiredAt: entry.leaseExpiresAt } : {}),
          ...(thresholdMs ? { thresholdMs } : {}),
          ...(entry.lastHeartbeatAt ? { lastHeartbeatAt: entry.lastHeartbeatAt } : {}),
          recoveryDecision: shouldAutoRequeue
            ? ("auto_requeued" as const)
            : ("needs_attention" as const),
        };
        if (shouldAutoRequeue) {
          const operationRecord = PlaybookGraphOperationRecordSchema.parse({
            schemaVersion: 1,
            operationRecordId: `${entry.queueEntryId}:auto-retry`,
            operationAttemptId: `${entry.queueEntryId}:auto-retry`,
            runId: entry.runId,
            actionSpecId: "system.recovery.auto_retry",
            kind: "retry_needs_attention",
            status: "succeeded",
            operatorIntent: "Automatically retry interrupted step",
            queueEntryId: entry.queueEntryId,
            affectedArtifactIds: [],
            affectedReviewEventIds: [],
            affectedQueueEntryIds: [entry.queueEntryId],
            createdAt: input.now,
            completedAt: input.now,
            redactedPayloadSummary: `attentionCode=${code}`,
          });
          writeOperationRecord(operationRecord);
          operationRecords.push(operationRecord);
          writeQueue({
            ...entry,
            status: "queued",
            runtimeId: undefined,
            leaseId: undefined,
            claimedAt: undefined,
            leaseExpiresAt: undefined,
            blockedReason: undefined,
            error: undefined,
            completedAt: undefined,
            attentionEvidence,
            updatedAt: input.now,
          });
          autoRequeued += 1;
        } else {
          writeQueue({
            ...entry,
            status: "needs_attention",
            runtimeId: undefined,
            leaseId: undefined,
            claimedAt: undefined,
            leaseExpiresAt: undefined,
            blockedReason: reason,
            error: undefined,
            completedAt: undefined,
            attentionEvidence,
            updatedAt: input.now,
          });
          needsAttention += 1;
        }

        if (code === "hard_timeout") {
          writeOperationRecord({
            schemaVersion: 1,
            operationRecordId: `${entry.queueEntryId}:hard-timeout:v${entry.attempt}`,
            operationAttemptId: `${entry.queueEntryId}:hard-timeout:v${entry.attempt}`,
            runId: entry.runId,
            actionSpecId: "system.timeout.hard",
            kind: "hard_timeout_observed",
            status: "succeeded",
            operatorIntent: "Step exceeded hard timeout",
            queueEntryId: entry.queueEntryId,
            affectedArtifactIds: [],
            affectedReviewEventIds: [],
            affectedQueueEntryIds: [entry.queueEntryId],
            createdAt: input.now,
            completedAt: input.now,
            ...(thresholdMs ? { redactedPayloadSummary: `thresholdMs=${thresholdMs}` } : {}),
          });
        }
      }
      return { inspected, autoRequeued, needsAttention, interrupted: 0 };
    },
    async checkpointNodeSuccess(input) {
      checkpointTransaction(input);
    },
    async checkpointNodeFailure(input) {
      checkpointFailureTransaction(input);
    },
  };
}
