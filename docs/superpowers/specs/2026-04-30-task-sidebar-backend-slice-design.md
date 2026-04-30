# Task Sidebar Backend Slice Design

## Summary

Add first-class workspace tasks to Tessera. A task is the user-facing work item, separate from workflow runs. It belongs to a selected workspace, appears in the left secondary sidebar when the Tasks rail item is selected, can execute a minimal backend run, and can produce persisted artifact records.

## Product Behavior

The rail gains selected-mode state. Clicking the Tasks item switches the secondary sidebar from the file explorer to a task history view. The workspace picker remains at the top of the secondary sidebar so task context stays tied to the selected workspace.

When no workspace is selected, task creation and task listing are disabled. The Tasks view shows an empty state asking the user to select a workspace before creating tasks. This avoids tasks that cannot produce workspace-relevant artifacts.

When a workspace is selected, the sidebar shows:

- `New task`
- a `Tasks` section header
- task rows with title, status, agent/persona label when present, updated time, and latest activity preview

Selecting a task opens its detail view in the main pane. The first detail view shows task metadata, current status, latest activity, and produced artifacts. Conversation history and rich agent controls are out of scope for this slice.

## Data Model

Tasks are added to `packages/contracts` as shared Zod schemas and TypeScript types.

```ts
type TaskStatus = "active" | "waiting" | "done" | "failed";

interface TaskSummary {
  id: string;
  workspaceRoot: string;
  title: string;
  status: TaskStatus;
  agentLabel?: string;
  latestActivity?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskDetail extends TaskSummary {
  description?: string;
  artifacts: TaskArtifact[];
}

interface TaskArtifact {
  id: string;
  taskId: string;
  kind: "text" | "file";
  title: string;
  path?: string;
  contentPreview?: string;
  createdAt: string;
}
```

`workspaceRoot` is required for persisted tasks. Global task browsing can be added later by querying across workspace roots, but this first UI filters tasks to the selected workspace.

## Backend And Persistence

The sidecar adds a SQLite-backed `task-store.ts`. It should use the same app data directory pattern as workflow persistence, but tasks remain a separate domain from workflow runs.

Initial HTTP endpoints:

- `GET /tasks?workspaceRoot=<path>` returns task summaries for the selected workspace, ordered by `updatedAt` descending.
- `POST /tasks` creates a task and starts the minimal execution loop.
- `GET /tasks/:id` returns task detail with artifacts.
- `PATCH /tasks/:id` updates task fields such as status, title, and latest activity for later UI actions.

The store persists tasks and artifacts in separate tables. Task creation must reject missing or empty `workspaceRoot`.

## Execution And Artifacts

The first slice includes a bounded backend execution path so tasks are not empty metadata. Creating a task stores it as `active`, runs a deterministic task runner, creates at least one artifact record, updates `latestActivity`, and transitions the task to `done` or `failed`.

The initial runner can be deterministic rather than a full provider-backed agent loop. It accepts `title`, optional `description`, and `workspaceRoot`, then produces a text artifact record such as an initial draft or task output preview. The runner interface should be shaped so a later real agent loop can replace it without changing UI contracts.

Artifacts are persisted in SQLite for this slice. Writing artifact files into the workspace is out of scope, so `TaskArtifact.path` is optional and may be absent. The UI should still render the artifact title and content preview.

## Tauri Commands

Rust adds thin sidecar proxy commands matching the existing workflow pattern:

- `task_list`
- `task_create`
- `task_get`
- `task_update`

The frontend calls these through `invoke` and uses shared contract types. The UI must not read SQLite or sidecar HTTP directly.

## Frontend Structure

Keep the feature small, but split the current app shell along the task boundary:

- `App.tsx` owns `workspaceRoot`, `sidebarMode`, `selectedTaskId`, task list state, and loading/error state.
- `RailNav` renders Files, Tasks, and future rail items.
- `Sidebar` keeps `WorkspacePicker` and switches content by selected mode.
- `TaskList` renders disabled, loading, error, empty, and populated task history states.
- `TaskDetail` renders the selected task and artifacts in the main pane.

`FileExplorer` stays behind `sidebarMode === "files"`.

`New task` should use a small inline title input in the sidebar. The input remains available when task creation fails, and creation is disabled when no workspace is selected.

## Error Handling

Task list failures show an inline sidebar error with retry. Task creation failures keep the draft title and show an inline error. Task execution failures transition the task to `failed` and persist a latest activity message describing the failure.

If a selected task cannot be loaded, the detail pane shows a recoverable error and the sidebar remains usable.

## Tests And Verification

Add contract schema tests for task create, list, detail, update, and artifact shapes.

Add sidecar store tests for:

- rejecting task creation without a workspace
- creating a task
- listing tasks by workspace
- ordering by `updatedAt`
- updating task status/latest activity
- creating and loading artifacts
- persisting failed execution state

Add endpoint tests only if the current sidecar server can be tested without a broad server refactor. Otherwise, keep endpoint logic thin and cover contracts plus store behavior.

Run:

```bash
bun run check
bun test packages/contracts apps/sidecar
```

## Out Of Scope

- streaming task progress
- provider/model selection
- multi-turn chat
- approval gates
- task deletion/archive
- background cancellation
- writing artifact files into the workspace
- global task inbox UI
- workflow-run integration

## Open Implementation Notes

The execution runner should be small and deterministic for this slice, but it should return a structured result rather than directly mutating UI-facing fields. That keeps the later provider-backed task runner as a backend replacement instead of a frontend rewrite.
