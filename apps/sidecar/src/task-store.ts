import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentRuntimeContext,
  type AuditRecord,
  AuditRecordSchema,
  type ClarifyRequest,
  ClarifyRequestSchema,
  type ClarifyResponse,
  type NotifyRequest,
  NotifyRequestSchema,
  type TaskArtifact,
  TaskArtifactSchema,
  type TaskCreateRequest,
  type TaskDetail,
  TaskDetailSchema,
  type TaskSkillActivation,
  TaskSkillActivationSchema,
  type TaskStatus,
  type TaskSummary,
  TaskSummarySchema,
  type TaskTodo,
  TaskTodoSchema,
  type TaskTurn,
  TaskTurnSchema,
  type TaskTurnStatus,
  type TaskUpdateRequest,
  type TodoOperation,
} from "@tessera/contracts";
import { configureSidecarSqlite } from "./sqlite.js";

export interface CreateArtifactInput {
  taskId: string;
  turnId?: string;
  kind: TaskArtifact["kind"];
  title: string;
  path?: string;
  contentPreview?: string;
}

export type CreateTaskInput = Omit<TaskCreateRequest, "agentLabel" | "agentId" | "execution"> & {
  agentLabel?: string;
  agentId?: string;
  agentContext?: AgentRuntimeContext;
};

export interface TaskStore {
  addActiveSkill(
    taskId: string,
    skill: Omit<TaskSkillActivation, "activatedAt">
  ): TaskDetail | undefined;
  addNotification(taskId: string, notification: NotifyRequest): TaskDetail | undefined;
  appendAuditRecord(taskId: string, auditRecord: AuditRecord): TaskDetail | undefined;
  clearClarify(taskId: string, response: ClarifyResponse): TaskDetail | undefined;
  close(): void;
  createAgentTurn(taskId: string, content: string): TaskTurn;
  createArtifact(input: CreateArtifactInput): TaskArtifact;
  createQueuedAgentTurn(taskId: string): TaskTurn;
  createTask(input: CreateTaskInput): TaskDetail;
  createUserTurn(taskId: string, content: string): TaskTurn;
  getTask(taskId: string): TaskDetail | undefined;
  getTaskSummary(taskId: string): TaskSummary;
  requestClarify(taskId: string, clarify: ClarifyRequest): TaskDetail | undefined;
  removeActiveSkill(taskId: string, skillId: string): TaskDetail | undefined;
  getTurn(turnId: string): TaskTurn;
  listTasks(filter: { workspaceRoot: string }): TaskSummary[];
  updateTodo(taskId: string, operation: TodoOperation): TaskDetail | undefined;
  updateTask(taskId: string, patch: TaskUpdateRequest): TaskDetail | undefined;
  updateTurn(
    turnId: string,
    patch: { status?: TaskTurnStatus; content?: string; error?: string; completedAt?: string }
  ): TaskTurn | undefined;
}

interface TaskRow {
  id: string;
  workspace_root: string;
  title: string;
  status: TaskStatus;
  agent_id: string;
  agent_label: string | null;
  latest_activity: string | null;
  description: string | null;
  agent_context_json: string | null;
  todo_json: string | null;
  clarify_json: string | null;
  notifications_json: string | null;
  audit_records_json: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  task_id: string;
  role: TaskTurn["role"];
  content: string;
  status: TaskTurnStatus;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

interface ArtifactRow {
  id: string;
  task_id: string;
  turn_id: string | null;
  kind: TaskArtifact["kind"];
  title: string;
  path: string | null;
  content_preview: string | null;
  created_at: string;
}

interface TaskSkillRow {
  task_id: string;
  skill_id: string;
  name: string;
  source: TaskSkillActivation["source"];
  external_provider: TaskSkillActivation["externalProvider"] | null;
  activated_at: string;
  activated_by_turn_id: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

export function generateTaskTitle(initialInstruction: string): string {
  const normalized = initialInstruction
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ")
    .replace(/^[#*\-:;\s]+/, "")
    .replace(/[.!?,:;\s]+$/, "");

  if (!normalized) return "New task";
  if (normalized.length <= 48) return normalized;
  return `${normalized.slice(0, 45).trimEnd()}...`;
}

function rowToSummary(row: TaskRow): TaskSummary {
  return TaskSummarySchema.parse({
    id: row.id,
    workspaceRoot: row.workspace_root,
    title: row.title,
    status: row.status,
    agentId: row.agent_id,
    agentLabel: row.agent_label ?? undefined,
    latestActivity: row.latest_activity ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToTurn(row: TurnRow): TaskTurn {
  return TaskTurnSchema.parse({
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  });
}

function rowToArtifact(row: ArtifactRow): TaskArtifact {
  return TaskArtifactSchema.parse({
    id: row.id,
    taskId: row.task_id,
    turnId: row.turn_id ?? undefined,
    kind: row.kind,
    title: row.title,
    path: row.path ?? undefined,
    contentPreview: row.content_preview ?? undefined,
    createdAt: row.created_at,
  });
}

function rowToActiveSkill(row: TaskSkillRow): TaskSkillActivation {
  return TaskSkillActivationSchema.parse({
    skillId: row.skill_id,
    name: row.name,
    source: row.source,
    externalProvider: row.external_provider ?? undefined,
    activatedAt: row.activated_at,
    activatedByTurnId: row.activated_by_turn_id ?? undefined,
  });
}

function parseJsonOrUndefined<T>(
  value: string | null,
  schema: { parse: (value: unknown) => T }
): T | undefined {
  if (!value) return undefined;
  return schema.parse(JSON.parse(value));
}

function parseJsonArray<T>(value: string | null, parseItem: (value: unknown) => T): T[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => parseItem(item));
}

function normalizeTodoLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function applyTodoOperation(current: TaskTodo | undefined, operation: TodoOperation): TaskTodo {
  const updatedAt = nowIso();
  const items = current?.items ?? [];

  if (operation.type === "create" || operation.type === "replace") {
    const existingById = new Map(items.map((item) => [item.id, item]));
    const existingByLabel = new Map(items.map((item) => [normalizeTodoLabel(item.label), item]));
    return TaskTodoSchema.parse({
      items: operation.items.map((item) => {
        const previous =
          existingById.get(item.id) ?? existingByLabel.get(normalizeTodoLabel(item.label));
        if (!previous || previous.status !== "completed" || item.status === "completed") {
          return item;
        }
        return { ...item, status: "completed" as const };
      }),
      updatedAt,
    });
  }

  if (operation.type === "append") {
    return TaskTodoSchema.parse({ items: [...items, operation.item], updatedAt });
  }

  if (operation.type === "remove") {
    return TaskTodoSchema.parse({
      items: items.filter((item) => item.id !== operation.itemId),
      updatedAt,
    });
  }

  return TaskTodoSchema.parse({
    items: items.map((item) =>
      item.id === operation.itemId ? { ...item, status: operation.status } : item
    ),
    updatedAt,
  });
}

export function createTaskStore(dbPath: string): TaskStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  configureSidecarSqlite(db, dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_root TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default',
      agent_label TEXT,
      latest_activity TEXT,
      description TEXT,
      agent_context_json TEXT,
      todo_json TEXT,
      clarify_json TEXT,
      notifications_json TEXT,
      audit_records_json TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`
  );

  const taskColumns = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
  if (!taskColumns.some((column) => column.name === "agent_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (!taskColumns.some((column) => column.name === "agent_context_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_context_json TEXT");
  }
  if (!taskColumns.some((column) => column.name === "todo_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN todo_json TEXT");
  }
  if (!taskColumns.some((column) => column.name === "clarify_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN clarify_json TEXT");
  }
  if (!taskColumns.some((column) => column.name === "notifications_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN notifications_json TEXT");
  }
  if (!taskColumns.some((column) => column.name === "audit_records_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN audit_records_json TEXT");
  }
  if (!taskColumns.some((column) => column.name === "archived_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS task_turns (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      content_preview TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES task_turns(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_active_skills (
      task_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      external_provider TEXT,
      activated_at TEXT NOT NULL,
      activated_by_turn_id TEXT,
      PRIMARY KEY (task_id, skill_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);

  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, workspace_root, title, status, agent_id, agent_label, latest_activity, description, agent_context_json, todo_json, clarify_json, notifications_json, audit_records_json, archived_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTurn = db.prepare(`
    INSERT INTO task_turns (id, task_id, role, content, status, created_at, completed_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertArtifact = db.prepare(`
    INSERT INTO task_artifacts (id, task_id, turn_id, kind, title, path, content_preview, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getTaskRow = db.prepare<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?");
  const getTurnRow = db.prepare<TurnRow, [string]>("SELECT * FROM task_turns WHERE id = ?");
  const listTaskRows = db.prepare<TaskRow, [string]>(
    "SELECT * FROM tasks WHERE workspace_root = ? ORDER BY updated_at DESC, id DESC"
  );
  const listTurnRows = db.prepare<TurnRow, [string]>(
    "SELECT * FROM task_turns WHERE task_id = ? ORDER BY created_at ASC, rowid ASC"
  );
  const listArtifactRows = db.prepare<ArtifactRow, [string]>(
    "SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC, rowid ASC"
  );
  const listActiveSkillRows = db.prepare<TaskSkillRow, [string]>(
    "SELECT * FROM task_active_skills WHERE task_id = ? ORDER BY activated_at ASC, skill_id ASC"
  );
  const upsertActiveSkill = db.prepare(`
    INSERT INTO task_active_skills (
      task_id, skill_id, name, source, external_provider, activated_at, activated_by_turn_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, skill_id) DO UPDATE SET
      name = excluded.name,
      source = excluded.source,
      external_provider = excluded.external_provider,
      activated_at = excluded.activated_at,
      activated_by_turn_id = excluded.activated_by_turn_id
  `);
  const deleteActiveSkill = db.prepare(
    "DELETE FROM task_active_skills WHERE task_id = ? AND skill_id = ?"
  );
  const updateTaskRow = db.prepare(`
    UPDATE tasks
    SET title = COALESCE(?, title),
        status = COALESCE(?, status),
        latest_activity = COALESCE(?, latest_activity),
        archived_at = ?,
        updated_at = ?
    WHERE id = ?
  `);
  const updateTaskStateRow = db.prepare(`
    UPDATE tasks
    SET todo_json = COALESCE(?, todo_json),
        clarify_json = ?,
        notifications_json = COALESCE(?, notifications_json),
        audit_records_json = COALESCE(?, audit_records_json),
        updated_at = ?
    WHERE id = ?
  `);
  const touchTask = db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?");
  const updateTurnRow = db.prepare(`
    UPDATE task_turns
    SET status = COALESCE(?, status),
        content = COALESCE(?, content),
        completed_at = CASE WHEN ? IN ('completed', 'failed') THEN COALESCE(completed_at, ?) ELSE completed_at END,
        error = COALESCE(?, error)
    WHERE id = ?
  `);

  function requireTask(taskId: string): TaskRow {
    const task = getTaskRow.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  function getTask(taskId: string): TaskDetail | undefined {
    const row = getTaskRow.get(taskId);
    if (!row) return undefined;

    return TaskDetailSchema.parse({
      ...rowToSummary(row),
      description: row.description ?? undefined,
      agentContext: row.agent_context_json ? JSON.parse(row.agent_context_json) : undefined,
      todo: parseJsonOrUndefined(row.todo_json, TaskTodoSchema),
      clarify: parseJsonOrUndefined(row.clarify_json, ClarifyRequestSchema),
      notifications: parseJsonArray(row.notifications_json, (value) =>
        NotifyRequestSchema.parse(value)
      ),
      auditRecords: parseJsonArray(row.audit_records_json, (value) =>
        AuditRecordSchema.parse(value)
      ),
      activeSkills: listActiveSkillRows.all(taskId).map(rowToActiveSkill),
      turns: listTurnRows.all(taskId).map(rowToTurn),
      artifacts: listArtifactRows.all(taskId).map(rowToArtifact),
    });
  }

  function createTurn(input: {
    taskId: string;
    role: TaskTurn["role"];
    content: string;
    status: TaskTurnStatus;
  }): TaskTurn {
    requireTask(input.taskId);
    assertNonEmpty(input.content, "content");
    const id = createId("turn");
    const createdAt = nowIso();
    const completedAt = input.status === "completed" ? createdAt : null;
    insertTurn.run(
      id,
      input.taskId,
      input.role,
      input.content.trim(),
      input.status,
      createdAt,
      completedAt,
      null
    );
    touchTask.run(createdAt, input.taskId);
    const row = getTurnRow.get(id);
    if (!row) throw new Error(`Could not load created turn: ${id}`);
    return rowToTurn(row);
  }

  return {
    close() {
      db.close();
    },
    addActiveSkill(taskId, skill) {
      requireTask(taskId);
      const activatedAt = nowIso();
      const parsed = TaskSkillActivationSchema.parse({ ...skill, activatedAt });
      upsertActiveSkill.run(
        taskId,
        parsed.skillId,
        parsed.name,
        parsed.source,
        parsed.externalProvider ?? null,
        parsed.activatedAt,
        parsed.activatedByTurnId ?? null
      );
      touchTask.run(activatedAt, taskId);
      return getTask(taskId);
    },
    createAgentTurn(taskId, content) {
      return createTurn({ taskId, role: "agent", content, status: "completed" });
    },
    createQueuedAgentTurn(taskId) {
      return createTurn({ taskId, role: "agent", content: "Queued", status: "queued" });
    },
    createArtifact(input) {
      requireTask(input.taskId);
      assertNonEmpty(input.title, "title");
      const id = createId("artifact");
      const createdAt = nowIso();
      insertArtifact.run(
        id,
        input.taskId,
        input.turnId ?? null,
        input.kind,
        input.title.trim(),
        input.path ?? null,
        input.contentPreview ?? null,
        createdAt
      );
      touchTask.run(createdAt, input.taskId);
      return TaskArtifactSchema.parse({
        id,
        taskId: input.taskId,
        turnId: input.turnId,
        kind: input.kind,
        title: input.title.trim(),
        path: input.path,
        contentPreview: input.contentPreview,
        createdAt,
      });
    },
    createTask(input) {
      assertNonEmpty(input.workspaceRoot, "workspaceRoot");
      assertNonEmpty(input.initialInstruction, "initialInstruction");
      const title = generateTaskTitle(input.initialInstruction);
      const parsed = {
        ...input,
        workspaceRoot: input.workspaceRoot.trim(),
        title,
        initialInstruction: input.initialInstruction.trim(),
      };
      const id = createId("task");
      const createdAt = nowIso();
      insertTask.run(
        id,
        parsed.workspaceRoot,
        parsed.title,
        "active",
        parsed.agentId ?? "default",
        parsed.agentLabel ?? "Tessera",
        parsed.initialInstruction,
        parsed.description ?? null,
        parsed.agentContext ? JSON.stringify(parsed.agentContext) : null,
        null,
        null,
        JSON.stringify([]),
        JSON.stringify([]),
        null,
        createdAt,
        createdAt
      );
      insertTurn.run(
        createId("turn"),
        id,
        "user",
        parsed.initialInstruction,
        "running",
        createdAt,
        null,
        null
      );
      const task = getTask(id);
      if (!task) throw new Error(`Could not load created task: ${id}`);
      return task;
    },
    createUserTurn(taskId, content) {
      return createTurn({ taskId, role: "user", content, status: "running" });
    },
    addNotification(taskId, notification) {
      const task = getTask(taskId);
      if (!task) return undefined;
      const nextNotifications = [...task.notifications, NotifyRequestSchema.parse(notification)];
      const updatedAt = nowIso();
      updateTaskStateRow.run(
        null,
        task.clarify ? JSON.stringify(task.clarify) : null,
        JSON.stringify(nextNotifications),
        JSON.stringify(task.auditRecords),
        updatedAt,
        taskId
      );
      return getTask(taskId);
    },
    appendAuditRecord(taskId, auditRecord) {
      const task = getTask(taskId);
      if (!task) return undefined;
      const nextAudit = [...task.auditRecords, AuditRecordSchema.parse(auditRecord)];
      const updatedAt = nowIso();
      updateTaskStateRow.run(
        task.todo ? JSON.stringify(task.todo) : null,
        task.clarify ? JSON.stringify(task.clarify) : null,
        JSON.stringify(task.notifications),
        JSON.stringify(nextAudit),
        updatedAt,
        taskId
      );
      return getTask(taskId);
    },
    clearClarify(taskId, _response) {
      const task = getTask(taskId);
      if (!task) return undefined;
      const updatedAt = nowIso();
      updateTaskStateRow.run(
        task.todo ? JSON.stringify(task.todo) : null,
        null,
        JSON.stringify(task.notifications),
        JSON.stringify(task.auditRecords),
        updatedAt,
        taskId
      );
      return getTask(taskId);
    },
    getTask,
    listTasks(filter) {
      assertNonEmpty(filter.workspaceRoot, "workspaceRoot");
      return listTaskRows.all(filter.workspaceRoot).map(rowToSummary);
    },
    requestClarify(taskId, clarify) {
      requireTask(taskId);
      const task = getTask(taskId);
      if (!task) return undefined;
      const updatedAt = nowIso();
      updateTaskStateRow.run(
        task.todo ? JSON.stringify(task.todo) : null,
        JSON.stringify(ClarifyRequestSchema.parse(clarify)),
        JSON.stringify(task.notifications),
        JSON.stringify(task.auditRecords),
        updatedAt,
        taskId
      );
      return getTask(taskId);
    },
    removeActiveSkill(taskId, skillId) {
      requireTask(taskId);
      const updatedAt = nowIso();
      deleteActiveSkill.run(taskId, skillId);
      touchTask.run(updatedAt, taskId);
      return getTask(taskId);
    },
    updateTodo(taskId, operation) {
      requireTask(taskId);
      const task = getTask(taskId);
      if (!task) return undefined;
      const nextTodo = applyTodoOperation(task.todo, operation);
      const updatedAt = nowIso();
      updateTaskStateRow.run(
        JSON.stringify(nextTodo),
        task.clarify ? JSON.stringify(task.clarify) : null,
        JSON.stringify(task.notifications),
        JSON.stringify(task.auditRecords),
        updatedAt,
        taskId
      );
      return getTask(taskId);
    },
    updateTask(taskId, patch) {
      requireTask(taskId);
      const existing = requireTask(taskId);
      const updatedAt = nowIso();
      const archivedAt =
        patch.archived === undefined ? existing.archived_at : patch.archived ? updatedAt : null;
      updateTaskRow.run(
        patch.title?.trim() || null,
        patch.status ?? null,
        patch.latestActivity ?? null,
        archivedAt,
        updatedAt,
        taskId
      );
      return getTask(taskId);
    },
    getTaskSummary(taskId) {
      const row = getTaskRow.get(taskId);
      if (!row) throw new Error(`Unknown task: ${taskId}`);
      return rowToSummary(row);
    },
    getTurn(turnId) {
      const row = getTurnRow.get(turnId);
      if (!row) throw new Error(`Unknown turn: ${turnId}`);
      return rowToTurn(row);
    },
    updateTurn(turnId, patch) {
      const existing = getTurnRow.get(turnId);
      if (!existing) return undefined;
      const completedAt = patch.completedAt ?? nowIso();
      updateTurnRow.run(
        patch.status ?? null,
        patch.content ?? null,
        patch.status ?? null,
        completedAt,
        patch.error ?? null,
        turnId
      );
      touchTask.run(completedAt, existing.task_id);
      const row = getTurnRow.get(turnId);
      return row ? rowToTurn(row) : undefined;
    },
  };
}
