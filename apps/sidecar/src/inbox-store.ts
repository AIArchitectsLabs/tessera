import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type InboxCancelRequest,
  type InboxCreateRequest,
  InboxCreateRequestSchema,
  type InboxMessage,
  InboxMessageSchema,
  type InboxMessageType,
  type InboxResolveRequest,
  InboxResolveRequestSchema,
  type InboxSnoozeRequest,
  InboxSnoozeRequestSchema,
  type InboxStatus,
} from "@tessera/contracts";

export interface InboxListFilter {
  status?: InboxStatus;
  type?: InboxMessageType;
  workspaceRoot?: string;
  taskId?: string;
  workflowRunId?: string;
}

export interface InboxStore {
  cancel(messageId: string, request: InboxCancelRequest): InboxMessage | undefined;
  close(): void;
  create(input: InboxCreateRequest): InboxMessage;
  get(messageId: string): InboxMessage | undefined;
  list(filter?: InboxListFilter): InboxMessage[];
  resolve(messageId: string, request: InboxResolveRequest): InboxMessage | undefined;
  snooze(messageId: string, request: InboxSnoozeRequest): InboxMessage | undefined;
}

interface InboxMessageRow {
  id: string;
  workspace_root: string | null;
  task_id: string | null;
  workflow_run_id: string | null;
  turn_id: string | null;
  source: InboxMessage["source"];
  type: InboxMessage["type"];
  severity: InboxMessage["severity"];
  status: InboxStatus;
  title: string;
  body: string | null;
  context_json: string;
  actions_json: string;
  deadline: string | null;
  snoozed_until: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InboxAuditRow {
  id: string;
  message_id: string;
  event: string;
  actor: string;
  payload_json: string | null;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function rowToAudit(row: InboxAuditRow) {
  return {
    id: row.id,
    messageId: row.message_id,
    event: row.event,
    actor: row.actor,
    payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
    createdAt: row.created_at,
  };
}

function rowToMessage(row: InboxMessageRow, audit: InboxAuditRow[]): InboxMessage {
  return InboxMessageSchema.parse({
    id: row.id,
    workspaceRoot: row.workspace_root ?? undefined,
    taskId: row.task_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    source: row.source,
    type: row.type,
    severity: row.severity,
    status: row.status,
    title: row.title,
    body: row.body ?? undefined,
    context: JSON.parse(row.context_json),
    actions: JSON.parse(row.actions_json),
    deadline: row.deadline ?? undefined,
    snoozedUntil: row.snoozed_until ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    audit: audit.map(rowToAudit),
  });
}

function matchesFilter(message: InboxMessage, filter: InboxListFilter): boolean {
  if (filter.status && message.status !== filter.status) return false;
  if (filter.type && message.type !== filter.type) return false;
  if (filter.workspaceRoot && message.workspaceRoot !== filter.workspaceRoot) return false;
  if (filter.taskId && message.taskId !== filter.taskId) return false;
  if (filter.workflowRunId && message.workflowRunId !== filter.workflowRunId) return false;
  return true;
}

export function createInboxStore(dbPath: string): InboxStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_root TEXT,
      task_id TEXT,
      workflow_run_id TEXT,
      turn_id TEXT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      context_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      deadline TEXT,
      snoozed_until TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox_audit_entries (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL,
      event TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES inbox_messages(id) ON DELETE CASCADE
    );
  `);

  const insertMessage = db.prepare(`
    INSERT INTO inbox_messages (
      id, workspace_root, task_id, workflow_run_id, turn_id, source, type, severity, status, title, body, context_json, actions_json, deadline, snoozed_until, resolved_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAudit = db.prepare(`
    INSERT INTO inbox_audit_entries (id, message_id, event, actor, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getMessageRow = db.prepare<InboxMessageRow, [string]>(
    "SELECT * FROM inbox_messages WHERE id = ?"
  );
  const listMessageRows = db.prepare<InboxMessageRow, []>(
    "SELECT * FROM inbox_messages ORDER BY updated_at DESC, id DESC"
  );
  const listAuditRows = db.prepare<InboxAuditRow, [string]>(
    "SELECT * FROM inbox_audit_entries WHERE message_id = ? ORDER BY created_at ASC, rowid ASC"
  );
  const updateStatusRow = db.prepare(`
    UPDATE inbox_messages
    SET status = ?, snoozed_until = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
  `);

  function appendAudit(messageId: string, event: string, payload?: unknown): void {
    insertAudit.run(
      createId("inbox-audit"),
      messageId,
      event,
      "system",
      payload === undefined ? null : JSON.stringify(payload),
      nowIso()
    );
  }

  function get(messageId: string): InboxMessage | undefined {
    const row = getMessageRow.get(messageId);
    if (!row) return undefined;
    return rowToMessage(row, listAuditRows.all(messageId));
  }

  return {
    close() {
      db.close();
    },
    create(input) {
      const parsed = InboxCreateRequestSchema.parse(input);
      const id = createId("inbox");
      const createdAt = nowIso();
      insertMessage.run(
        id,
        parsed.workspaceRoot ?? null,
        parsed.taskId ?? null,
        parsed.workflowRunId ?? null,
        parsed.turnId ?? null,
        parsed.source,
        parsed.type,
        parsed.severity,
        "open",
        parsed.title,
        parsed.body ?? null,
        JSON.stringify(parsed.context),
        JSON.stringify(parsed.actions),
        parsed.deadline ?? null,
        null,
        null,
        createdAt,
        createdAt
      );
      appendAudit(id, "created");
      const message = get(id);
      if (!message) throw new Error(`Could not load created inbox message: ${id}`);
      return message;
    },
    get,
    list(filter = {}) {
      return listMessageRows
        .all()
        .map((row) => rowToMessage(row, listAuditRows.all(row.id)))
        .filter((message) => matchesFilter(message, filter));
    },
    resolve(messageId, request) {
      const message = get(messageId);
      if (!message) return undefined;
      const parsed = InboxResolveRequestSchema.parse(request);
      if (!message.actions.some((action) => action.id === parsed.actionId)) {
        throw new Error(`Inbox action is not available: ${parsed.actionId}`);
      }
      const resolvedAt = nowIso();
      updateStatusRow.run("resolved", null, resolvedAt, resolvedAt, messageId);
      appendAudit(messageId, "resolved", {
        actionId: parsed.actionId,
        ...(parsed.payload === undefined ? {} : { payload: parsed.payload }),
      });
      return get(messageId);
    },
    snooze(messageId, request) {
      const message = get(messageId);
      if (!message) return undefined;
      const parsed = InboxSnoozeRequestSchema.parse(request);
      const updatedAt = nowIso();
      updateStatusRow.run("snoozed", parsed.snoozedUntil, null, updatedAt, messageId);
      appendAudit(messageId, "snoozed", {
        snoozedUntil: parsed.snoozedUntil,
        ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      });
      return get(messageId);
    },
    cancel(messageId, request) {
      const message = get(messageId);
      if (!message) return undefined;
      const updatedAt = nowIso();
      updateStatusRow.run("cancelled", null, null, updatedAt, messageId);
      appendAudit(messageId, "cancelled", request.reason ? { reason: request.reason } : undefined);
      return get(messageId);
    },
  };
}
