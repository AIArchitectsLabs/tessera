import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type TaskArtifact,
  TaskArtifactSchema,
  type TaskCreateRequest,
  type TaskDetail,
  TaskDetailSchema,
  type TaskStatus,
  type TaskSummary,
  TaskSummarySchema,
  type TaskTurn,
  TaskTurnSchema,
  type TaskTurnStatus,
  type TaskUpdateRequest,
} from "@tessera/contracts";

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
};

export interface TaskStore {
  close(): void;
  createAgentTurn(taskId: string, content: string): TaskTurn;
  createArtifact(input: CreateArtifactInput): TaskArtifact;
  createQueuedAgentTurn(taskId: string): TaskTurn;
  createTask(input: CreateTaskInput): TaskDetail;
  createUserTurn(taskId: string, content: string): TaskTurn;
  getTask(taskId: string): TaskDetail | undefined;
  getTaskSummary(taskId: string): TaskSummary;
  getTurn(turnId: string): TaskTurn;
  listTasks(filter: { workspaceRoot: string }): TaskSummary[];
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
  agent_label: string | null;
  latest_activity: string | null;
  description: string | null;
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
    agentLabel: row.agent_label ?? undefined,
    latestActivity: row.latest_activity ?? undefined,
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

export function createTaskStore(dbPath: string): TaskStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_root TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_label TEXT,
      latest_activity TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
  `);

  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, workspace_root, title, status, agent_label, latest_activity, description, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const updateTaskRow = db.prepare(`
    UPDATE tasks
    SET title = COALESCE(?, title),
        status = COALESCE(?, status),
        latest_activity = COALESCE(?, latest_activity),
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
        parsed.agentLabel ?? "Tessera",
        parsed.initialInstruction,
        parsed.description ?? null,
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
    getTask,
    listTasks(filter) {
      assertNonEmpty(filter.workspaceRoot, "workspaceRoot");
      return listTaskRows.all(filter.workspaceRoot).map(rowToSummary);
    },
    updateTask(taskId, patch) {
      requireTask(taskId);
      const updatedAt = nowIso();
      updateTaskRow.run(
        patch.title?.trim() || null,
        patch.status ?? null,
        patch.latestActivity ?? null,
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
