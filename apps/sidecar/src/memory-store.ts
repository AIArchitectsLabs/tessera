import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Memory,
  type MemoryCandidate,
  MemoryCandidateSchema,
  type MemoryEvent,
  MemoryEventSchema,
  type MemoryForgetAction,
  type MemoryForgetRequest,
  MemorySchema,
  type MemoryScope,
} from "@tessera/contracts";

export interface MemoryDocumentInput {
  id: string;
  workspaceKey?: string;
  ownerId?: string;
  scope: MemoryScope;
  kind: "event" | "task_summary" | "playbook_note" | "user_memory";
  sourceId: string;
  title?: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryChunkSearchInput {
  workspaceKey: string;
  ownerId?: string;
  query: string;
  limit: number;
}

export interface MemoryChunkSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  title?: string;
  sourceId: string;
  scope: MemoryScope;
  metadata: Record<string, unknown>;
}

export interface MemoryStore {
  close(): void;
  recordEvent(event: MemoryEvent): MemoryEvent;
  getEventById(id: string): MemoryEvent | undefined;
  getEventByKey(eventKey: string): MemoryEvent | undefined;
  getMemoryById(id: string): Memory | undefined;
  indexDocument(document: MemoryDocumentInput): void;
  searchChunks(input: MemoryChunkSearchInput): MemoryChunkSearchResult[];
  upsertMemory(memory: Memory | MemoryCandidate): Memory | MemoryCandidate;
  listActiveMemories(filter: { workspaceKey?: string; ownerId?: string; limit?: number }): Memory[];
  listCandidateMemories(filter: {
    workspaceKey?: string;
    ownerId?: string;
    limit?: number;
  }): MemoryCandidate[];
  isSourceForgotten(sourceId: string): boolean;
  forgetMemory(request: MemoryForgetRequest): void;
}

interface MemoryEventRow {
  id: string;
  event_key: string;
  workspace_key: string | null;
  owner_id: string | null;
  scope: MemoryScope;
  subject_type: string;
  subject_id: string;
  event_type: string;
  content: string;
  content_hash: string;
  metadata_json: string;
  sensitivity: string;
  capture_policy: string;
  schema_version: number;
  created_at: string;
}

interface MemoryRow {
  id: string;
  workspace_key: string | null;
  owner_id: string | null;
  scope: MemoryScope;
  memory_type: string;
  title: string;
  body: string;
  status: "candidate" | "active" | "rejected" | "archived";
  confidence: number;
  freshness: string;
  expires_at: string | null;
  source_event_ids_json: string;
  source_document_ids_json: string;
  supersedes_memory_id: string | null;
  last_used_at: string | null;
  rationale_json: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryDocumentRow {
  id: string;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function candidateRationale(memory: Memory | MemoryCandidate): MemoryCandidate["rationale"] | null {
  if (memory.status !== "candidate") return null;
  const candidate = MemoryCandidateSchema.safeParse(memory);
  if (candidate.success) return candidate.data.rationale;
  return {
    supportingEventIds: memory.sourceEventIds,
    conflictingMemoryIds: [],
    promotionReason: "Candidate memory pending review.",
    riskFlags: [],
  };
}

function normalizeMemoryEvent(event: MemoryEvent): MemoryEvent {
  return MemoryEventSchema.parse({
    ...event,
    workspaceKey: event.workspaceKey ?? undefined,
    ownerId: event.ownerId ?? undefined,
    metadata: event.metadata ?? {},
  });
}

function normalizeMemory(memory: Memory): Memory {
  return MemorySchema.parse({
    ...memory,
    workspaceKey: memory.workspaceKey ?? undefined,
    ownerId: memory.ownerId ?? undefined,
    expiresAt: memory.expiresAt ?? undefined,
    supersedesMemoryId: memory.supersedesMemoryId ?? undefined,
    lastUsedAt: memory.lastUsedAt ?? undefined,
    sourceEventIds: asStringArray(memory.sourceEventIds),
    sourceDocumentIds: asStringArray(memory.sourceDocumentIds),
  });
}

function eventRowToEvent(row: MemoryEventRow): MemoryEvent {
  return normalizeMemoryEvent({
    id: row.id,
    eventKey: row.event_key,
    workspaceKey: row.workspace_key ?? undefined,
    ownerId: row.owner_id ?? undefined,
    scope: row.scope,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    eventType: row.event_type,
    content: row.content,
    contentHash: row.content_hash,
    metadata: parseJsonObject(row.metadata_json),
    sensitivity: row.sensitivity as MemoryEvent["sensitivity"],
    capturePolicy: row.capture_policy as MemoryEvent["capturePolicy"],
    schemaVersion: row.schema_version as MemoryEvent["schemaVersion"],
    createdAt: row.created_at,
  });
}

function memoryRowToMemory(row: MemoryRow): Memory {
  const memory = normalizeMemory({
    id: row.id,
    workspaceKey: row.workspace_key ?? undefined,
    ownerId: row.owner_id ?? undefined,
    scope: row.scope,
    type: row.memory_type as Memory["type"],
    title: row.title,
    body: row.body,
    status: row.status,
    confidence: row.confidence,
    freshness: row.freshness as Memory["freshness"],
    expiresAt: row.expires_at ?? undefined,
    sourceEventIds: parseJsonArray(row.source_event_ids_json),
    sourceDocumentIds: parseJsonArray(row.source_document_ids_json),
    supersedesMemoryId: row.supersedes_memory_id ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (memory.status !== "candidate") return memory;

  const rationale = row.rationale_json ? parseJsonObject(row.rationale_json) : {};
  return MemoryCandidateSchema.parse({
    ...memory,
    rationale: {
      supportingEventIds: Array.isArray(rationale.supportingEventIds)
        ? rationale.supportingEventIds
        : memory.sourceEventIds,
      conflictingMemoryIds: Array.isArray(rationale.conflictingMemoryIds)
        ? rationale.conflictingMemoryIds
        : [],
      promotionReason:
        typeof rationale.promotionReason === "string"
          ? rationale.promotionReason
          : "Candidate memory pending review.",
      riskFlags: Array.isArray(rationale.riskFlags) ? rationale.riskFlags : [],
    },
  });
}

function chunkContent(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [trimmed]) {
    if (paragraph.length <= 1200) {
      chunks.push(paragraph);
      continue;
    }
    for (let index = 0; index < paragraph.length; index += 1200) {
      chunks.push(paragraph.slice(index, index + 1200));
    }
  }
  return chunks;
}

function bindOptionalString(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function ftsQueryFromText(query: string): string | undefined {
  const terms = query
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}

export function createMemoryStore(dbPath: string): MemoryStore {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY NOT NULL,
      event_key TEXT NOT NULL UNIQUE,
      workspace_key TEXT,
      owner_id TEXT,
      scope TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      capture_policy TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_documents (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_key TEXT,
      owner_id TEXT,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY NOT NULL,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER,
      embedding_provider TEXT,
      embedding_model TEXT,
      embedding_dimension INTEGER,
      embedding BLOB,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES memory_documents(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunk_fts
    USING fts5(content, chunk_id UNINDEXED, document_id UNINDEXED, tokenize = 'unicode61');

	    CREATE TABLE IF NOT EXISTS memories (
	      id TEXT PRIMARY KEY NOT NULL,
      workspace_key TEXT,
      owner_id TEXT,
      scope TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      freshness TEXT NOT NULL,
      expires_at TEXT,
      source_event_ids_json TEXT NOT NULL,
      source_document_ids_json TEXT NOT NULL,
      supersedes_memory_id TEXT,
      last_used_at TEXT,
      rationale_json TEXT,
      created_at TEXT NOT NULL,
	      updated_at TEXT NOT NULL
	    );

	    CREATE TABLE IF NOT EXISTS memory_forget_markers (
	      source_id TEXT PRIMARY KEY NOT NULL,
	      memory_id TEXT NOT NULL,
	      action TEXT NOT NULL,
	      reason TEXT NOT NULL,
	      requested_at TEXT NOT NULL
	    );
	  `);

  const memoryColumns = db
    .prepare<{ name: string }, []>("PRAGMA table_info(memories)")
    .all()
    .map((column) => column.name);
  if (!memoryColumns.includes("rationale_json")) {
    db.exec("ALTER TABLE memories ADD COLUMN rationale_json TEXT");
  }

  const insertEvent = db.prepare(`
    INSERT INTO memory_events (
      id, event_key, workspace_key, owner_id, scope, subject_type, subject_id, event_type,
      content, content_hash, metadata_json, sensitivity, capture_policy, schema_version, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING
  `);
  const getEventByIdRow = db.prepare<MemoryEventRow, [string]>(
    "SELECT * FROM memory_events WHERE id = ?"
  );
  const getEvent = db.prepare<MemoryEventRow, [string]>(
    "SELECT * FROM memory_events WHERE event_key = ?"
  );

  const deleteChunkFtsRows = db.prepare<{ rowid: number }, [string]>(
    "SELECT rowid FROM memory_chunk_fts WHERE document_id = ?"
  );
  const deleteChunkFtsRow = db.prepare("DELETE FROM memory_chunk_fts WHERE rowid = ?");
  const deleteChunksByDocument = db.prepare("DELETE FROM memory_chunks WHERE document_id = ?");
  const deleteDocumentById = db.prepare("DELETE FROM memory_documents WHERE id = ?");
  const listDocumentsBySourceId = db.prepare<MemoryDocumentRow, [string]>(
    "SELECT id FROM memory_documents WHERE source_id = ?"
  );
  const insertDocument = db.prepare(`
    INSERT INTO memory_documents (
      id, workspace_key, owner_id, scope, kind, source_id, title, content, metadata_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO memory_chunks (
      id, document_id, chunk_index, content, token_count, embedding_provider, embedding_model,
      embedding_dimension, embedding, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunkFts = db.prepare(
    "INSERT INTO memory_chunk_fts (content, chunk_id, document_id) VALUES (?, ?, ?)"
  );
  const upsertMemoryRow = db.prepare(`
    INSERT INTO memories (
      id, workspace_key, owner_id, scope, memory_type, title, body, status, confidence, freshness,
      expires_at, source_event_ids_json, source_document_ids_json, supersedes_memory_id, last_used_at,
      rationale_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_key = excluded.workspace_key,
      owner_id = excluded.owner_id,
      scope = excluded.scope,
      memory_type = excluded.memory_type,
      title = excluded.title,
      body = excluded.body,
      status = excluded.status,
      confidence = excluded.confidence,
      freshness = excluded.freshness,
      expires_at = excluded.expires_at,
      source_event_ids_json = excluded.source_event_ids_json,
      source_document_ids_json = excluded.source_document_ids_json,
      supersedes_memory_id = excluded.supersedes_memory_id,
      last_used_at = excluded.last_used_at,
      rationale_json = excluded.rationale_json,
      updated_at = excluded.updated_at
  `);
  const getMemoryById = db.prepare<MemoryRow, [string]>("SELECT * FROM memories WHERE id = ?");
  const listActiveMemoryRowsByWorkspace = db.prepare<MemoryRow, [string, number]>(
    "SELECT * FROM memories WHERE status = 'active' AND workspace_key = ? ORDER BY confidence DESC, updated_at DESC, id DESC LIMIT ?"
  );
  const listActiveMemoryRowsByWorkspaceAndOwner = db.prepare<MemoryRow, [string, string, number]>(
    "SELECT * FROM memories WHERE status = 'active' AND workspace_key = ? AND owner_id = ? ORDER BY confidence DESC, updated_at DESC, id DESC LIMIT ?"
  );
  const listActiveMemoryRows = db.prepare<MemoryRow, [number]>(
    "SELECT * FROM memories WHERE status = 'active' ORDER BY confidence DESC, updated_at DESC, id DESC LIMIT ?"
  );
  const listActiveMemoryRowsByOwner = db.prepare<MemoryRow, [string, number]>(
    "SELECT * FROM memories WHERE status = 'active' AND owner_id = ? ORDER BY confidence DESC, updated_at DESC, id DESC LIMIT ?"
  );
  const listCandidateMemoryRows = db.prepare<MemoryRow, [number]>(
    "SELECT * FROM memories WHERE status = 'candidate' ORDER BY updated_at DESC, confidence DESC, id DESC LIMIT ?"
  );
  const listCandidateMemoryRowsByWorkspace = db.prepare<MemoryRow, [string, number]>(
    "SELECT * FROM memories WHERE status = 'candidate' AND workspace_key = ? ORDER BY updated_at DESC, confidence DESC, id DESC LIMIT ?"
  );
  const listCandidateMemoryRowsByWorkspaceAndOwner = db.prepare<
    MemoryRow,
    [string, string, number]
  >(
    "SELECT * FROM memories WHERE status = 'candidate' AND workspace_key = ? AND owner_id = ? ORDER BY updated_at DESC, confidence DESC, id DESC LIMIT ?"
  );
  const listCandidateMemoryRowsByOwner = db.prepare<MemoryRow, [string, number]>(
    "SELECT * FROM memories WHERE status = 'candidate' AND owner_id = ? ORDER BY updated_at DESC, confidence DESC, id DESC LIMIT ?"
  );
  const forgetMemoryRow = db.prepare(
    "UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?"
  );
  const insertForgetMarker = db.prepare(`
	    INSERT INTO memory_forget_markers (source_id, memory_id, action, reason, requested_at)
	    VALUES (?, ?, ?, ?, ?)
	    ON CONFLICT(source_id) DO UPDATE SET
	      memory_id = excluded.memory_id,
	      action = excluded.action,
	      reason = excluded.reason,
	      requested_at = excluded.requested_at
	  `);
  const getForgetMarkerBySourceId = db.prepare<{ source_id: string }, [string]>(
    "SELECT source_id FROM memory_forget_markers WHERE source_id = ?"
  );
  const searchChunkRowsByWorkspace = db.prepare<
    {
      chunk_id: string;
      document_id: string;
      content: string;
      document_title: string | null;
      source_id: string;
      scope: MemoryScope;
      metadata_json: string;
    },
    [string, string, number]
  >(
    `
      SELECT
        c.id AS chunk_id,
        c.document_id AS document_id,
        c.content AS content,
        d.title AS document_title,
        d.source_id AS source_id,
        d.scope AS scope,
        d.metadata_json AS metadata_json
      FROM memory_chunk_fts f
      JOIN memory_chunks c ON c.id = f.chunk_id
      JOIN memory_documents d ON d.id = c.document_id
      WHERE memory_chunk_fts MATCH ? AND d.workspace_key = ?
      ORDER BY d.updated_at DESC, c.chunk_index ASC, c.id ASC
      LIMIT ?
    `
  );
  const searchChunkRowsByWorkspaceAndOwner = db.prepare<
    {
      chunk_id: string;
      document_id: string;
      content: string;
      document_title: string | null;
      source_id: string;
      scope: MemoryScope;
      metadata_json: string;
    },
    [string, string, string, number]
  >(
    `
      SELECT
        c.id AS chunk_id,
        c.document_id AS document_id,
        c.content AS content,
        d.title AS document_title,
        d.source_id AS source_id,
        d.scope AS scope,
        d.metadata_json AS metadata_json
      FROM memory_chunk_fts f
      JOIN memory_chunks c ON c.id = f.chunk_id
      JOIN memory_documents d ON d.id = c.document_id
      WHERE memory_chunk_fts MATCH ? AND d.workspace_key = ? AND d.owner_id = ?
      ORDER BY d.updated_at DESC, c.chunk_index ASC, c.id ASC
      LIMIT ?
    `
  );

  function withTransaction<T>(run: () => T): T {
    db.exec("BEGIN");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getEventByKey(eventKey: string): MemoryEvent | undefined {
    const row = getEvent.get(eventKey);
    return row ? eventRowToEvent(row) : undefined;
  }

  function getEventById(id: string): MemoryEvent | undefined {
    const row = getEventByIdRow.get(id);
    return row ? eventRowToEvent(row) : undefined;
  }

  function getMemory(id: string): Memory | undefined {
    const row = getMemoryById.get(id);
    return row ? memoryRowToMemory(row) : undefined;
  }

  function deleteIndexedDocument(documentId: string): void {
    const existingRows = deleteChunkFtsRows.all(documentId);
    for (const row of existingRows) {
      deleteChunkFtsRow.run(row.rowid);
    }
    deleteChunksByDocument.run(documentId);
    deleteDocumentById.run(documentId);
  }

  function deleteIndexedDocumentsForSource(sourceId: string): void {
    for (const row of listDocumentsBySourceId.all(sourceId)) {
      deleteIndexedDocument(row.id);
    }
  }

  function markSourcesForgotten(input: {
    memory: Memory;
    action: MemoryForgetAction;
    reason: string;
    requestedAt: string;
  }): void {
    const sourceIds = new Set([...input.memory.sourceEventIds, ...input.memory.sourceDocumentIds]);
    for (const sourceId of sourceIds) {
      insertForgetMarker.run(
        sourceId,
        input.memory.id,
        input.action,
        input.reason,
        input.requestedAt
      );
    }
  }

  function sourceIsForgotten(sourceId: string): boolean {
    return getForgetMarkerBySourceId.get(sourceId) != null;
  }

  return {
    close() {
      db.close();
    },
    recordEvent(event) {
      const parsed = normalizeMemoryEvent(event);
      insertEvent.run(
        parsed.id,
        parsed.eventKey,
        parsed.workspaceKey ?? null,
        parsed.ownerId ?? null,
        parsed.scope,
        parsed.subjectType,
        parsed.subjectId,
        parsed.eventType,
        parsed.content,
        parsed.contentHash,
        JSON.stringify(parsed.metadata ?? {}),
        parsed.sensitivity,
        parsed.capturePolicy,
        parsed.schemaVersion,
        parsed.createdAt
      );
      const stored = getEventByKey(parsed.eventKey);
      if (!stored) throw new Error(`Could not load stored memory event: ${parsed.eventKey}`);
      return stored;
    },
    getEventById,
    getEventByKey,
    getMemoryById: getMemory,
    indexDocument(document) {
      if (sourceIsForgotten(document.sourceId) || sourceIsForgotten(document.id)) {
        deleteIndexedDocument(document.id);
        return;
      }
      withTransaction(() => {
        const existingRows = deleteChunkFtsRows.all(document.id);
        for (const row of existingRows) {
          deleteChunkFtsRow.run(row.rowid);
        }
        deleteChunksByDocument.run(document.id);
        deleteDocumentById.run(document.id);

        insertDocument.run(
          document.id,
          document.workspaceKey ?? null,
          document.ownerId ?? null,
          document.scope,
          document.kind,
          document.sourceId,
          bindOptionalString(document.title),
          document.content,
          JSON.stringify(document.metadata ?? {}),
          document.createdAt,
          document.updatedAt
        );

        const chunks = chunkContent(document.content);
        for (const [index, content] of chunks.entries()) {
          const chunkId = createId("memory-chunk");
          insertChunk.run(
            chunkId,
            document.id,
            index,
            content,
            null,
            null,
            null,
            null,
            null,
            document.updatedAt
          );
          insertChunkFts.run(content, chunkId, document.id);
        }
      });
    },
    searchChunks(input) {
      const limit = input.limit > 0 ? input.limit : 8;
      const query = ftsQueryFromText(input.query);
      if (!query) return [];
      const rows = input.ownerId
        ? searchChunkRowsByWorkspaceAndOwner.all(query, input.workspaceKey, input.ownerId, limit)
        : searchChunkRowsByWorkspace.all(query, input.workspaceKey, limit);

      return rows.map((row) => {
        const result: MemoryChunkSearchResult = {
          chunkId: row.chunk_id,
          documentId: row.document_id,
          content: row.content,
          sourceId: row.source_id,
          scope: row.scope,
          metadata: parseJsonObject(row.metadata_json),
        };
        if (row.document_title !== null) result.title = row.document_title;
        return result;
      });
    },
    upsertMemory(memory) {
      const parsed = normalizeMemory(memory);
      const rationale = candidateRationale(memory);
      upsertMemoryRow.run(
        parsed.id,
        parsed.workspaceKey ?? null,
        parsed.ownerId ?? null,
        parsed.scope,
        parsed.type,
        parsed.title,
        parsed.body,
        parsed.status,
        parsed.confidence,
        parsed.freshness,
        parsed.expiresAt ?? null,
        JSON.stringify(parsed.sourceEventIds),
        JSON.stringify(parsed.sourceDocumentIds),
        parsed.supersedesMemoryId ?? null,
        parsed.lastUsedAt ?? null,
        rationale ? JSON.stringify(rationale) : null,
        parsed.createdAt,
        parsed.updatedAt
      );
      const stored = getMemory(parsed.id);
      if (!stored) throw new Error(`Could not load stored memory: ${parsed.id}`);
      return stored;
    },
    listActiveMemories(filter) {
      const limit = filter.limit && filter.limit > 0 ? filter.limit : 8;
      const rows =
        filter.workspaceKey && filter.ownerId
          ? listActiveMemoryRowsByWorkspaceAndOwner.all(filter.workspaceKey, filter.ownerId, limit)
          : filter.workspaceKey
            ? listActiveMemoryRowsByWorkspace.all(filter.workspaceKey, limit)
            : filter.ownerId
              ? listActiveMemoryRowsByOwner.all(filter.ownerId, limit)
              : listActiveMemoryRows.all(limit);
      return rows.map(memoryRowToMemory);
    },
    listCandidateMemories(filter) {
      const limit = filter.limit && filter.limit > 0 ? filter.limit : 8;
      const rows =
        filter.workspaceKey && filter.ownerId
          ? listCandidateMemoryRowsByWorkspaceAndOwner.all(
              filter.workspaceKey,
              filter.ownerId,
              limit
            )
          : filter.workspaceKey
            ? listCandidateMemoryRowsByWorkspace.all(filter.workspaceKey, limit)
            : filter.ownerId
              ? listCandidateMemoryRowsByOwner.all(filter.ownerId, limit)
              : listCandidateMemoryRows.all(limit);
      return rows.map((row) => MemoryCandidateSchema.parse(memoryRowToMemory(row)));
    },
    isSourceForgotten(sourceId) {
      return sourceIsForgotten(sourceId);
    },
    forgetMemory(request) {
      const parsed = request;
      const action = parsed.action ?? "archive";
      const memory = getMemory(parsed.memoryId);
      forgetMemoryRow.run(parsed.requestedAt, parsed.memoryId);
      if (!memory) return;

      markSourcesForgotten({
        memory,
        action,
        reason: parsed.reason,
        requestedAt: parsed.requestedAt,
      });

      if (action !== "archive") {
        withTransaction(() => {
          for (const documentId of memory.sourceDocumentIds) {
            deleteIndexedDocument(documentId);
          }
          for (const sourceEventId of memory.sourceEventIds) {
            deleteIndexedDocumentsForSource(sourceEventId);
          }
        });
      }
    },
  };
}
