# Action Inbox MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for parallel implementation or `superpowers:executing-plans` for single-owner execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable Action Inbox MVP so Tessera can represent user-required decisions as typed, persisted work items instead of transient task/chat state.

**Architecture:** Define shared inbox contracts first, add a sidecar-owned SQLite inbox store, expose HTTP endpoints and Tauri proxy commands, then add a focused inbox UI lane. In this MVP, inbox messages are created by existing task clarification and task notification flows, and workflow/tool approvals can be represented without fully replacing the current workflow resume path yet. Keep the inbox independent from task turns, workflow checkpoint state, credentials, and future memory systems.

**Tech Stack:** Bun, TypeScript, Zod contracts, Bun SQLite, Tauri 2 Rust commands, React/Vite/Tailwind, Biome.

---

## Requirements Summary

- The inbox is the product primitive for Human-in-the-Loop work. `docs/tessera_prd.md` requires persisted inbox messages for approvals, input requests, credential prompts, exceptions, reviews, and policy decisions.
- Existing permission decisions already have an `ask` shape with approval payloads in `packages/contracts/src/index.ts`.
- Existing workflow runs can already block and resume through `/workflows/runs` and `/workflows/:id/resume`.
- Existing task flows already persist clarification, notifications, and audit records inside `apps/sidecar/src/task-store.ts`.
- Existing UI is currently task-first: `apps/desktop/ui/src/App.tsx` renders `RailNav`, `Sidebar`, and `TaskDetail` directly.

## MVP Scope

- Build one persisted inbox store shared by tasks, workflows, agents, and system services.
- Support these message types first: `approval`, `input_required`, `credential`, `exception`, `review`.
- Support these statuses first: `open`, `snoozed`, `resolved`, `expired`, `cancelled`.
- Support list/get/create/resolve/snooze/cancel APIs.
- Route task clarification requests into `input_required` inbox messages.
- Route task notifications into `review` or `exception` inbox messages based on severity.
- Add an Inbox rail target and main-pane view with list, filters, detail, resolve, and snooze.
- Do not implement full Git ledger approvals, OAuth login, enterprise audit export, or workflow package promotion in this slice.

## File Structure

### Shared contracts

- Modify: `packages/contracts/src/index.ts`
  - Add inbox source/type/status/severity/action/audit schemas.
  - Add `InboxMessageSchema`, `InboxListResultSchema`, `InboxCreateRequestSchema`, `InboxResolveRequestSchema`, `InboxSnoozeRequestSchema`, and `InboxCancelRequestSchema`.
  - Add optional `inboxMessageId` links to task clarification/notification events only if useful for UI reconciliation.
- Create: `packages/contracts/src/inbox.test.ts`
  - Cover message shapes, typed actions, status transitions, task/workflow links, and strict credential-redaction expectations.

### Sidecar persistence and APIs

- Create: `apps/sidecar/src/inbox-store.ts`
  - SQLite table for inbox messages plus immutable per-message audit entries.
  - Methods: `create`, `get`, `list`, `resolve`, `snooze`, `cancel`, `expire`, `appendAudit`.
- Create: `apps/sidecar/src/inbox-store.test.ts`
  - Persistence, filtering, status transitions, audit append order, and invalid action handling.
- Modify: `apps/sidecar/src/server.ts`
  - Initialize/close the inbox store alongside task/profile stores.
  - Add routes:
    - `GET /inbox?status=open&type=approval&workspaceRoot=...`
    - `POST /inbox`
    - `GET /inbox/:id`
    - `POST /inbox/:id/resolve`
    - `POST /inbox/:id/snooze`
    - `POST /inbox/:id/cancel`
  - Create inbox messages from `handleTaskClarifyRequest` and `handleTaskNotification`.
- Create or extend: `apps/sidecar/src/server.test.ts`
  - Verify inbox endpoints and task-to-inbox creation behavior.

### Tauri proxy commands

- Modify: `apps/desktop/src-tauri/src/lib.rs`
  - Add commands: `inbox_list`, `inbox_get`, `inbox_create`, `inbox_resolve`, `inbox_snooze`, `inbox_cancel`.
  - Register commands in the Tauri invoke handler.
- Add/extend Rust tests near existing command/request tests if practical.

### Desktop UI

- Modify: `apps/desktop/ui/src/components/RailNav.tsx`
  - Restore a simple mode prop for `"tasks"` and `"inbox"` only.
  - Add an Inbox icon button, using a lucide icon such as `Inbox`.
- Modify: `apps/desktop/ui/src/App.tsx`
  - Own `activeView: "tasks" | "inbox"`.
  - Load inbox items when the inbox view is active.
  - Keep task SSE behavior scoped to selected task detail.
- Create: `apps/desktop/ui/src/components/InboxView.tsx`
  - List open/snoozed/resolved items.
  - Detail pane with source, type, severity, context, allowed actions, audit history, resolve and snooze controls.
- Create: `apps/desktop/ui/src/lib/inbox.ts`
  - Small helpers for labels, severity classes, and action copy.
- Create: `apps/desktop/ui/src/lib/inbox.test.ts`
  - Label/status/action helper coverage.
- Add/extend component tests if the existing UI test setup covers these surfaces.

---

## Task 1: Define Inbox Contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/inbox.test.ts`

- [x] **Step 1: Write failing contract tests**

Cover:

- `InboxMessageSchema` accepts a task-linked `input_required` message with a structured context payload.
- `InboxMessageSchema` accepts a workflow-linked `approval` message whose context includes the existing permission approval payload shape.
- `InboxCreateRequestSchema` rejects plaintext credential secret fields in `context` and `actions`.
- `InboxResolveRequestSchema` requires an `actionId` and optional typed `payload`.
- `InboxSnoozeRequestSchema` requires a future-ish ISO timestamp string. Do not enforce wall-clock time in the schema; enforce exact datetime syntax only.
- `InboxListResultSchema` parses a list of summaries/details without lossy fields.

Run:

```bash
bun test packages/contracts/src/inbox.test.ts
```

Expected: FAIL because schemas do not exist.

- [x] **Step 2: Add shared schemas and types**

Add after task/workflow contracts in `packages/contracts/src/index.ts`:

- `InboxSourceSchema`: `task`, `workflow`, `agent`, `system`, `integration`.
- `InboxMessageTypeSchema`: `approval`, `input_required`, `review`, `exception`, `credential`, `policy_override`, `artifact_review`, `production_promotion`.
- `InboxStatusSchema`: `open`, `snoozed`, `resolved`, `expired`, `cancelled`.
- `InboxSeveritySchema`: `info`, `warning`, `critical`.
- `InboxActionSchema`: stable `id`, `label`, `style`, optional `payloadSchema` or `payloadHint`.
- `InboxAuditEntrySchema`: `id`, `messageId`, `event`, `actor`, `payload`, `createdAt`.
- `InboxMessageSchema`: required PRD fields plus `workspaceRoot`, `taskId`, `workflowRunId`, `turnId`, `source`, `type`, `severity`, `status`, `title`, `body`, `context`, `actions`, `deadline`, `snoozedUntil`, `resolvedAt`, `createdAt`, `updatedAt`, `audit`.

Keep `context` as structured JSON, but add a small recursive guard or explicit tests to reject obvious secret keys such as `apiKey`, `token`, `secret`, `password`, and `credential`.

- [x] **Step 3: Verify contracts**

Run:

```bash
bun test packages/contracts/src/inbox.test.ts
bun run --filter @tessera/contracts typecheck
```

Expected: PASS.

---

## Task 2: Add Sidecar Inbox Store

**Files:**
- Create: `apps/sidecar/src/inbox-store.ts`
- Create: `apps/sidecar/src/inbox-store.test.ts`

- [x] **Step 1: Write store tests**

Cover:

- Creates an inbox message with an initial `created` audit entry.
- Lists by `status`, `type`, `workspaceRoot`, `taskId`, and `workflowRunId`.
- Resolving an open message sets `resolvedAt`, status `resolved`, and appends an audit entry.
- Snoozing sets status `snoozed` plus `snoozedUntil`.
- Cancelling sets status `cancelled`.
- Re-opening snoozed messages can be deferred unless the API explicitly needs it.
- Existing messages survive closing and reopening the store.

Run:

```bash
bun test apps/sidecar/src/inbox-store.test.ts
```

Expected: FAIL until implementation exists.

- [x] **Step 2: Implement SQLite persistence**

Use a sidecar-owned SQLite store similar to `apps/sidecar/src/task-store.ts`.

Recommended tables:

```sql
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
```

- [x] **Step 3: Verify store**

Run:

```bash
bun test apps/sidecar/src/inbox-store.test.ts
```

Expected: PASS.

---

## Task 3: Expose Sidecar Inbox APIs

**Files:**
- Modify: `apps/sidecar/src/server.ts`
- Add/modify: `apps/sidecar/src/server.test.ts`

- [ ] **Step 1: Add API tests**

Cover:

- `GET /inbox` returns open messages by default.
- `GET /inbox?status=snoozed` filters snoozed messages.
- `POST /inbox` validates and persists a message.
- `GET /inbox/:id` returns one message or 404.
- `POST /inbox/:id/resolve` resolves and appends audit.
- `POST /inbox/:id/snooze` snoozes and appends audit.
- `POST /inbox/:id/cancel` cancels and appends audit.
- `POST /tasks/:id/clarify` creates an `input_required` inbox item linked to the task.
- `POST /tasks/:id/notify` creates a `review` or `exception` inbox item linked to the task.

- [x] **Step 2: Wire store and routes**

In `apps/sidecar/src/server.ts`, initialize the store near the task/profile stores and close it in process cleanup. Add route handlers before the task `/:id` fallback.

Use existing handlers as patterns:

- workflow list/resume around `apps/sidecar/src/server.ts:247`
- task list/create around `apps/sidecar/src/server.ts:311`
- task clarify/notify around `apps/sidecar/src/server.ts:545`
- routing table around `apps/sidecar/src/server.ts:831`

- [x] **Step 3: Convert existing task signals**

On clarification request:

- Keep existing task `clarify_json` state and `task.clarify_requested` event.
- Also create an inbox message:
  - `source: "task"`
  - `type: "input_required"`
  - `severity: "warning"`
  - `status: "open"`
  - `taskId`, `workspaceRoot`
  - action: `respond`

On notification:

- Keep existing task notifications.
- Also create an inbox message:
  - `type: "exception"` for critical/destructive/error severities when available
  - otherwise `type: "review"`
  - action: `acknowledge`

- [x] **Step 4: Verify sidecar APIs**

Run:

```bash
bun test apps/sidecar/src/inbox-store.test.ts
bun test apps/sidecar/src/server.test.ts
bun run --filter @tessera/sidecar typecheck
```

Expected: PASS.

---

## Task 4: Add Tauri Inbox Commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [x] **Step 1: Add proxy commands**

Follow the existing task command style in `apps/desktop/src-tauri/src/lib.rs:686`.

Add:

- `inbox_list(status: Option<String>, message_type: Option<String>, workspace_root: Option<String>)`
- `inbox_get(message_id: String)`
- `inbox_create(request: serde_json::Value)`
- `inbox_resolve(message_id: String, request: serde_json::Value)`
- `inbox_snooze(message_id: String, request: serde_json::Value)`
- `inbox_cancel(message_id: String, request: serde_json::Value)`

Use `percent_encode` for query values and IDs, matching task command patterns.

- [x] **Step 2: Register commands**

Add the commands to the Tauri invoke handler near existing task commands.

- [ ] **Step 3: Verify desktop backend**

Run:

```bash
bun run --filter './apps/desktop' typecheck
bun run check
```

Expected: PASS.

---

## Task 5: Build Inbox UI

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx`
- Modify: `apps/desktop/ui/src/components/RailNav.tsx`
- Create: `apps/desktop/ui/src/components/InboxView.tsx`
- Create: `apps/desktop/ui/src/lib/inbox.ts`
- Create: `apps/desktop/ui/src/lib/inbox.test.ts`

- [x] **Step 1: Add UI helper tests**

Cover:

- status label mapping
- type label mapping
- severity class mapping
- action button label fallback

Run:

```bash
bun test apps/desktop/ui/src/lib/inbox.test.ts
```

Expected: FAIL until helpers exist.

- [x] **Step 2: Add rail mode**

Modify `RailNav` to accept:

```ts
type AppView = "tasks" | "inbox";
```

Add a second icon button for Inbox. Keep the task button active by default. Use accessible titles and `aria-current` only on the active view.

- [x] **Step 3: Add app-level inbox state**

In `App.tsx`:

- add `activeView`
- add inbox list/detail state
- load inbox items when `activeView === "inbox"`
- keep settings as an overlay/sibling state, as it works today
- render either the existing task sidebar/detail pair or `InboxView`

- [x] **Step 4: Implement `InboxView`**

Target UI:

- left list grouped/filterable by `open`, `snoozed`, `resolved`
- detail pane shows title, type, severity, source, linked task/workflow IDs, context JSON in a compact pre block, actions, and audit history
- `Resolve` action calls `inbox_resolve`
- `Snooze` action calls `inbox_snooze`
- disabled/loading/error/empty states

Use existing utility patterns from `TaskList`, `TaskDetail`, and settings components. Keep cards compact and avoid nesting cards.

- [x] **Step 5: Verify UI**

Run:

```bash
bun test apps/desktop/ui/src/lib/inbox.test.ts
bun run --filter @tessera/ui typecheck
bun run check
```

Expected: PASS.

---

## Task 6: Approval Message Bridge For Workflow Runs

**Files:**
- Modify: `apps/sidecar/src/server.ts`
- Modify: `apps/sidecar/src/workflow-store.test.ts` or `apps/sidecar/src/server.test.ts`
- Modify: `apps/desktop/ui/src/components/InboxView.tsx`

- [x] **Step 1: Create inbox messages for blocked workflow approvals**

When a workflow run returns `status: "blocked"` with `approval`, create or upsert an `approval` inbox message:

- `source: "workflow"`
- `type: "approval"`
- `workflowRunId`
- `severity: "warning"` or `critical` if destructive
- `context.approval` contains the existing approval payload
- actions: `approve`, `deny`

Avoid creating duplicates if the same run is saved/relisted repeatedly.

- [x] **Step 2: Resolve workflow approval actions**

When an inbox approval action resolves:

- call `resumeWorkflowRun` with `approve` or `deny`, or have the inbox endpoint delegate to the existing workflow resume handler internally.
- mark the inbox message `resolved`.
- append audit entries for both the inbox action and workflow resume result.

- [x] **Step 3: Verify bridge**

Run:

```bash
bun test packages/contracts/src/workflow.test.ts
bun test apps/sidecar/src/workflow-store.test.ts
bun test apps/sidecar/src/server.test.ts
bun run --filter @tessera/sidecar typecheck
```

Expected: PASS.

---

## Acceptance Criteria

- [x] Inbox contracts parse task, workflow, agent, system, and integration message sources.
- [x] Inbox contracts reject obvious secret-bearing fields in persisted message context/actions.
- [x] Sidecar persists inbox messages and audit entries in SQLite.
- [x] Inbox list supports filtering by status, type, workspace root, task ID, and workflow run ID.
- [x] Task clarification requests create linked `input_required` inbox messages without breaking existing task detail behavior.
- [x] Task notifications create linked review/exception inbox messages without breaking existing task event streams.
- [x] Blocked workflow approvals create approval inbox messages and resolving them resumes or denies the workflow deterministically.
- [x] Tauri exposes inbox commands usable from the React UI.
- [x] UI has a task/inbox rail switch, an inbox list, detail view, resolve action, and snooze action.
- [x] Full repo check passes.

## Risks And Mitigations

- **Risk: Inbox duplicates for repeated blocked workflow states.**
  - Mitigation: use a deterministic dedupe key such as `workflow:<runId>:approval` or `task:<taskId>:clarify:<clarifyId-or-updatedAt>` in the store.
- **Risk: Secrets get persisted in message context.**
  - Mitigation: reject common secret-bearing keys at contract/store boundaries and add explicit tests.
- **Risk: Inbox becomes another task-state store.**
  - Mitigation: keep inbox messages as action-required envelopes with links to tasks/workflows, not copies of full task details.
- **Risk: Resolving inbox and workflow/task state can diverge.**
  - Mitigation: route resolution through one sidecar method that updates target state and inbox status in one operation where possible.
- **Risk: UI scope expands into a full notification center.**
  - Mitigation: MVP supports only action-required states and minimal filters.

## Verification Steps

Run targeted checks after each slice:

```bash
bun test packages/contracts/src/inbox.test.ts
bun test apps/sidecar/src/inbox-store.test.ts
bun test apps/sidecar/src/server.test.ts
bun test apps/desktop/ui/src/lib/inbox.test.ts
```

Run package checks:

```bash
bun run --filter @tessera/contracts typecheck
bun run --filter @tessera/sidecar test
bun run --filter @tessera/ui typecheck
```

Run final verification:

```bash
bun run check
bun run --filter '*' test
```

## Commit Plan

Use conventional commit subjects with Lore trailers.

1. `feat(contracts): define action inbox contracts`
2. `feat(sidecar): persist action inbox messages`
3. `feat(sidecar): expose action inbox endpoints`
4. `feat(desktop): proxy action inbox commands`
5. `feat(ui): add action inbox workspace view`
6. `feat(workflows): route approvals through action inbox`

Each commit should include:

```text
Constraint: Inbox state must stay independent from task turns, workflow checkpoints, secrets, and future memory stores
Confidence: medium
Scope-risk: moderate
Tested: <commands run>
Not-tested: <honest gaps>
```
