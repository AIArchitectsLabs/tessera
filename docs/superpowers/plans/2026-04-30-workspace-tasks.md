# Workspace Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build workspace-scoped, multi-turn tasks that appear in the left sidebar, persist in the sidecar, run a deterministic first task loop, and show turn-linked artifacts.

**Architecture:** Add task/turn/artifact contracts first, then a sidecar SQLite task store and deterministic runner, then HTTP endpoints and Tauri proxy commands, then React sidebar/detail UI. Keep tasks separate from workflow runs; workflows remain an implementation detail for later.

**Tech Stack:** Bun, TypeScript, Zod, Bun SQLite, Tauri 2 Rust commands, React/Vite/Tailwind, Biome.

---

## File Structure

- Modify `packages/contracts/src/index.ts`: export task schemas and request/result types.
- Create `packages/contracts/src/task.test.ts`: contract coverage for task, turn, artifact, and request/result schemas.
- Create `apps/sidecar/src/task-store.ts`: SQLite persistence for tasks, turns, and artifacts.
- Create `apps/sidecar/src/task-store.test.ts`: store tests for workspace requirement, listing, turns, artifacts, and updates.
- Create `apps/sidecar/src/task-runner.ts`: deterministic runner that appends an agent turn and text artifact for each user turn.
- Create `apps/sidecar/src/task-runner.test.ts`: runner tests for initial and follow-up turns.
- Modify `apps/sidecar/src/server.ts`: initialize task store and expose `/tasks`, `/tasks/:id`, and `/tasks/:id/turns`.
- Modify `apps/desktop/src-tauri/src/lib.rs`: add `task_list`, `task_create`, `task_get`, `task_update`, and `task_create_turn` commands.
- Modify `apps/desktop/ui/src/App.tsx`: own sidebar mode and task state, use new task commands.
- Create `apps/desktop/ui/src/components/RailNav.tsx`: rail mode buttons.
- Create `apps/desktop/ui/src/components/Sidebar.tsx`: workspace picker plus files/tasks switch.
- Create `apps/desktop/ui/src/components/TaskList.tsx`: disabled, loading, error, empty, create, and populated task list states.
- Create `apps/desktop/ui/src/components/TaskDetail.tsx`: conversation timeline, turn composer, and artifact list.

## Task 1: Contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/task.test.ts`

- [ ] **Step 1: Write contract tests**

Create `packages/contracts/src/task.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  TaskArtifactSchema,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskDetailSchema,
  TaskListResultSchema,
  TaskSummarySchema,
  TaskUpdateRequestSchema,
} from "./index.js";

describe("task contracts", () => {
  test("accepts workspace task summaries", () => {
    const parsed = TaskSummarySchema.parse({
      id: "task-1",
      workspaceRoot: "/workspace/acme",
      title: "Draft announcement",
      status: "done",
      agentLabel: "Maeve",
      latestActivity: "Created draft artifact",
      createdAt: "2026-04-30T10:00:00.000Z",
      updatedAt: "2026-04-30T10:01:00.000Z",
    });

    expect(parsed.workspaceRoot).toBe("/workspace/acme");
    expect(parsed.status).toBe("done");
  });

  test("rejects tasks without a workspace root", () => {
    const parsed = TaskCreateRequestSchema.safeParse({
      title: "No workspace",
      initialInstruction: "Do work",
    });

    expect(parsed.success).toBe(false);
  });

  test("accepts task detail with turns and artifacts", () => {
    const detail = TaskDetailSchema.parse({
      id: "task-1",
      workspaceRoot: "/workspace/acme",
      title: "Draft announcement",
      status: "done",
      createdAt: "2026-04-30T10:00:00.000Z",
      updatedAt: "2026-04-30T10:01:00.000Z",
      turns: [
        {
          id: "turn-1",
          taskId: "task-1",
          role: "user",
          content: "Draft a launch announcement",
          status: "completed",
          createdAt: "2026-04-30T10:00:00.000Z",
          completedAt: "2026-04-30T10:00:01.000Z",
        },
        {
          id: "turn-2",
          taskId: "task-1",
          role: "agent",
          content: "Created an initial draft.",
          status: "completed",
          createdAt: "2026-04-30T10:00:01.000Z",
          completedAt: "2026-04-30T10:00:02.000Z",
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          taskId: "task-1",
          turnId: "turn-2",
          kind: "text",
          title: "Task output",
          contentPreview: "Draft output",
          createdAt: "2026-04-30T10:00:02.000Z",
        },
      ],
    });

    expect(detail.turns).toHaveLength(2);
    expect(detail.artifacts[0]?.turnId).toBe("turn-2");
  });

  test("accepts list, update, turn create, and artifact shapes", () => {
    expect(
      TaskListResultSchema.parse({
        tasks: [
          {
            id: "task-1",
            workspaceRoot: "/workspace/acme",
            title: "Draft announcement",
            status: "active",
            createdAt: "2026-04-30T10:00:00.000Z",
            updatedAt: "2026-04-30T10:00:00.000Z",
          },
        ],
      }).tasks
    ).toHaveLength(1);

    expect(TaskUpdateRequestSchema.parse({ status: "waiting", latestActivity: "Waiting" })).toEqual({
      status: "waiting",
      latestActivity: "Waiting",
    });

    expect(TaskCreateTurnRequestSchema.parse({ content: "Revise it" }).content).toBe("Revise it");

    expect(
      TaskArtifactSchema.parse({
        id: "artifact-1",
        taskId: "task-1",
        kind: "text",
        title: "Output",
        createdAt: "2026-04-30T10:00:00.000Z",
      }).kind
    ).toBe("text");
  });
});
```

- [ ] **Step 2: Run failing contract test**

Run: `bun test packages/contracts/src/task.test.ts`

Expected: FAIL because task schemas are not exported.

- [ ] **Step 3: Add task schemas and types**

Append to `packages/contracts/src/index.ts` after workflow exports:

```ts
export const TaskStatusSchema = z.enum(["active", "waiting", "done", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskTurnRoleSchema = z.enum(["user", "agent", "system"]);
export type TaskTurnRole = z.infer<typeof TaskTurnRoleSchema>;

export const TaskTurnStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export type TaskTurnStatus = z.infer<typeof TaskTurnStatusSchema>;

export const TaskTurnSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  role: TaskTurnRoleSchema,
  content: z.string().min(1),
  status: TaskTurnStatusSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type TaskTurn = z.infer<typeof TaskTurnSchema>;

export const TaskArtifactSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  kind: z.enum(["text", "file"]),
  title: z.string().min(1),
  path: z.string().min(1).optional(),
  contentPreview: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

export const TaskSummarySchema = z.object({
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema,
  agentLabel: z.string().min(1).optional(),
  latestActivity: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskDetailSchema = TaskSummarySchema.extend({
  description: z.string().optional(),
  turns: z.array(TaskTurnSchema),
  artifacts: z.array(TaskArtifactSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const TaskListResultSchema = z.object({
  tasks: z.array(TaskSummarySchema),
});
export type TaskListResult = z.infer<typeof TaskListResultSchema>;

export const TaskCreateRequestSchema = z.object({
  workspaceRoot: z.string().min(1),
  title: z.string().min(1),
  initialInstruction: z.string().min(1),
  description: z.string().optional(),
  agentLabel: z.string().min(1).default("Tessera"),
});
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>;

export const TaskUpdateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  status: TaskStatusSchema.optional(),
  latestActivity: z.string().optional(),
});
export type TaskUpdateRequest = z.infer<typeof TaskUpdateRequestSchema>;

export const TaskCreateTurnRequestSchema = z.object({
  content: z.string().min(1),
});
export type TaskCreateTurnRequest = z.infer<typeof TaskCreateTurnRequestSchema>;
```

- [ ] **Step 4: Verify contracts**

Run: `bun test packages/contracts/src/task.test.ts`

Expected: PASS.

## Task 2: Sidecar Store

**Files:**
- Create: `apps/sidecar/src/task-store.ts`
- Test: `apps/sidecar/src/task-store.test.ts`

- [ ] **Step 1: Write store tests**

Create `apps/sidecar/src/task-store.test.ts` with tests for required workspace roots, task creation, workspace-filtered listing, follow-up turns, artifact loading, updates, and failed state.

- [ ] **Step 2: Run failing store tests**

Run: `bun test apps/sidecar/src/task-store.test.ts`

Expected: FAIL because `task-store.ts` does not exist.

- [ ] **Step 3: Implement SQLite task store**

Create `task-store.ts` with `createTaskStore(dbPath)` and methods:

```ts
createTask(input): TaskDetail
addTurn(taskId, content): TaskDetail
addAgentResult(taskId, userTurnId, result): TaskDetail
get(taskId): TaskDetail | undefined
list({ workspaceRoot }): TaskSummary[]
update(taskId, patch): TaskDetail | undefined
close(): void
```

Tables: `tasks`, `task_turns`, `task_artifacts`.

- [ ] **Step 4: Verify store**

Run: `bun test apps/sidecar/src/task-store.test.ts`

Expected: PASS.

## Task 3: Deterministic Task Runner

**Files:**
- Create: `apps/sidecar/src/task-runner.ts`
- Test: `apps/sidecar/src/task-runner.test.ts`

- [ ] **Step 1: Write runner tests**

Cover initial task execution and follow-up execution. Assert an agent turn is appended, artifact is created, task status becomes `done`, and latest activity is updated.

- [ ] **Step 2: Run failing runner tests**

Run: `bun test apps/sidecar/src/task-runner.test.ts`

Expected: FAIL because runner does not exist.

- [ ] **Step 3: Implement deterministic runner**

Create `runTaskTurn({ store, taskId, userTurnId })`. It loads the task, appends an agent turn whose content summarizes the user instruction, creates a text artifact with `turnId` pointing to the agent turn, and updates task status/latest activity. On errors, mark the user turn and task failed.

- [ ] **Step 4: Verify runner**

Run: `bun test apps/sidecar/src/task-runner.test.ts apps/sidecar/src/task-store.test.ts`

Expected: PASS.

## Task 4: Sidecar HTTP Endpoints

**Files:**
- Modify: `apps/sidecar/src/server.ts`

- [ ] **Step 1: Wire task store initialization**

Add `TASK_DB_PATH = process.env.TESSERA_TASK_DB_PATH ?? join(homedir(), ".tessera", "tasks.sqlite")`, initialize `createTaskStore(TASK_DB_PATH)`, and close it on process exit.

- [ ] **Step 2: Add handlers**

Add handlers for:

```ts
GET /tasks?workspaceRoot=...
POST /tasks
GET /tasks/:id
PATCH /tasks/:id
POST /tasks/:id/turns
```

Use contract schemas for validation. `POST /tasks` and `POST /tasks/:id/turns` should call `runTaskTurn` before returning the latest `TaskDetail`.

- [ ] **Step 3: Verify sidecar typecheck/tests**

Run: `bun test apps/sidecar && bun run --filter './apps/sidecar' typecheck`

Expected: PASS.

## Task 5: Tauri Commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add command proxies**

Add `task_list`, `task_create`, `task_get`, `task_update`, and `task_create_turn`, each forwarding JSON to the sidecar with the existing `SidecarHandle`.

- [ ] **Step 2: Register commands**

Add the five commands to `tauri::generate_handler!`.

- [ ] **Step 3: Verify Rust check**

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

## Task 6: React Task UI

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx`
- Create: `apps/desktop/ui/src/components/RailNav.tsx`
- Create: `apps/desktop/ui/src/components/Sidebar.tsx`
- Create: `apps/desktop/ui/src/components/TaskList.tsx`
- Create: `apps/desktop/ui/src/components/TaskDetail.tsx`

- [ ] **Step 1: Extract rail and sidebar components**

Move rail mode buttons to `RailNav`, and workspace/sidebar switching to `Sidebar`.

- [ ] **Step 2: Add task command calls**

Use `invoke<TaskListResult>("task_list", { workspaceRoot })`, `invoke<TaskDetail>("task_create", { request })`, `invoke<TaskDetail>("task_get", { taskId })`, and `invoke<TaskDetail>("task_create_turn", { taskId, request })`.

- [ ] **Step 3: Implement disabled and populated Tasks sidebar**

When `workspaceRoot` is missing, show disabled task state. When present, load task history and allow creating a task with title and initial instruction.

- [ ] **Step 4: Implement task detail conversation**

Render turns, artifacts, status, and a composer for follow-up instructions.

- [ ] **Step 5: Verify UI typecheck**

Run: `bun run --filter './apps/desktop/ui' typecheck`

Expected: PASS.

## Task 7: Full Verification And Commit

**Files:**
- All changed implementation files

- [ ] **Step 1: Run targeted tests**

Run: `bun test packages/contracts apps/sidecar`

Expected: PASS.

- [ ] **Step 2: Run full check**

Run: `bun run check`

Expected: PASS.

- [ ] **Step 3: Review diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors and changes match this plan.

- [ ] **Step 4: Commit**

Commit with a conventional commit and Lore trailers:

```bash
git add packages/contracts apps/sidecar apps/desktop/src-tauri apps/desktop/ui
git commit -m "feat(tasks): add workspace task conversations"
```

## Self-Review

Spec coverage:

- Workspace-required tasks: Task 1 contracts, Task 2 store validation, Task 6 disabled UI.
- Sidebar mode switch: Task 6.
- Multi-turn conversations: Task 1 turn schemas, Task 2 turns, Task 3 runner, Task 6 composer.
- Artifacts linked to turns: Task 1 artifact shape, Task 2 store, Task 3 runner, Task 6 detail UI.
- Sidecar endpoints and Tauri commands: Tasks 4 and 5.
- Verification: Task 7.

Placeholder scan: no placeholders remain; each task has exact files and commands.

Type consistency: `TaskDetail`, `TaskTurn`, `TaskArtifact`, `TaskCreateRequest`, `TaskCreateTurnRequest`, `TaskListResult`, and command names match across tasks.
