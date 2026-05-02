# Pi Session Context And Policy Design

## Summary

Three targeted improvements to the Pi task execution path: wire the resolved
agent profile through to the Pi session (a gap introduced in the task model
settings slice), give Pi full conversation history on task continuation, and
surface workspace boundary violations as a `waiting` task status rather than
silently completing.

All changes are confined to `packages/core` and `apps/sidecar`. No contract,
Rust, or UI changes.

## Context

The previous slices established:

- Pi session adapter with workspace-scoped tools (`pi-session.ts`,
  `workspace-tools.ts`, `workspace-guard.ts`)
- Resolved `TaskExecutionConfig` carried from Tauri keychain through sidecar to
  the Pi runner (`task-model-settings-and-agent-profiles` slice)
- `AgentProfile` with tool allowlist and instructions/soul fields

One gap shipped with the agent profiles slice: `runTaskTurn` extracts
`execution.provider` and `execution.credential` from the resolved config but
drops `execution.agent` — the `piRunner` callback type does not include `agent`,
so tool filtering and instruction prepending in `runPiTaskTurn` never fire in
production.

## Goals

- Forward the resolved agent profile to the Pi session so tool filtering and
  agent instructions apply on every task run.
- Pass full prior-turn history to Pi on task continuation so follow-up messages
  have context.
- When a Pi tool call is denied by the workspace guard, surface this as task
  status `waiting` rather than status `done`.

## Non-Goals

- Resumable mid-session gating (approve/deny a specific tool call and continue):
  deferred.
- File artifact tracking (`kind: "file"`): separate brainstorming.
- Workflow agent step (`kind: "agent"`): separate slice.
- Session persistence across turns (Pi-native multi-turn via SDK message
  objects): deferred until Pi SDK surface is better mapped.

## Architecture

All changes stay within the two-layer boundary established by the MVP:

```
task-runner.ts  (Tessera orchestration — task persistence, status, event publish)
    │
    └── runPiTaskTurn  (Pi knowledge boundary — session creation, tool wiring,
                        event mapping, prompt assembly)
            │
            └── createWorkspaceToolDefinitions  (workspace policy)
```

Each change adds a small, named field to an existing interface rather than
introducing new abstractions.

## Change 1 — Agent Profile Forwarding Fix

### Problem

`RunTaskTurnOptions.piRunner` is typed as:

```ts
piRunner?: (options: {
  credential?: string;
  onActivity?: (activity: string) => void;
  prompt: string;
  provider: AgentProviderConfig;
  workspaceRoot: string;
}) => Promise<PiTaskTurnResult>;
```

`agent` is absent. The call site in `runTaskTurn` does not pass
`opts.execution?.agent`, so `runPiTaskTurn` always receives `agent: undefined`
and skips tool filtering and instruction prepending.

### Fix

Add `agent?: AgentProfile` to the `piRunner` callback type. Pass
`opts.execution?.agent` at the call site. No other files change.

## Change 2 — Multi-Turn Conversation Context

### Design

When `runTaskTurn` is called for a continuation turn, the task already has
completed prior turns in `TaskStore`. Before calling `piRunner`, collect all
turns completed before the current user turn and format them as a conversation
history string.

**Collection rule:** include all turns where `status === "completed"` and
`createdAt < currentUserTurn.createdAt`, in creation order. Exclude the initial
system-role turn if present. Skip turns with empty content.

**Format:**

```
Prior conversation:
User: <content>
Assistant: <content>
[…]

User task:
<current prompt>
```

The history block is injected in `buildPrompt` (renamed from
`withAgentInstructions`) which assembles the full prompt in this order:

1. Agent instructions (if `agent.instructions` present)
2. Agent soul (if `agent.soul` present)
3. Prior conversation block (if `conversationHistory` non-empty)
4. `User task:\n<prompt>`

**Interface additions:**

```ts
// RunPiTaskTurnOptions gains:
conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;

// piRunner callback type gains the same field
```

**First-turn tasks** (no prior completed turns) produce an empty
`conversationHistory` array and are completely unaffected — `buildPrompt`
omits the history block when the array is empty.

## Change 3 — Boundary Violation → Task `waiting`

### Design

**In `createWorkspaceToolDefinitions`:** add an optional second argument:

```ts
createWorkspaceToolDefinitions(
  guard: WorkspaceGuard,
  options?: { onViolation?: (toolName: string) => void }
)
```

Each tool's handler catches `WorkspaceBoundaryError` as before (returning an
error string to Pi), then additionally calls `options?.onViolation(toolName)`.

**In `runPiTaskTurn`:** track violations with a counter:

```ts
let boundaryViolations = 0;
const customTools = createWorkspaceToolDefinitions(guard, {
  onViolation: () => { boundaryViolations++; },
});
// …
return { text, boundaryViolations };
```

**`PiTaskTurnResult` gains:**

```ts
boundaryViolations: number;   // 0 when no violations occurred
```

**In `runTaskTurn`:** branch on the result:

```ts
if (result.boundaryViolations > 0) {
  store.updateTask(taskId, {
    status: "waiting",
    latestActivity: "Paused: agent reached workspace boundary",
  });
} else {
  store.updateTask(taskId, { status: "done", latestActivity: "Completed" });
}
```

The `piRunner` callback return type is updated to `Promise<PiTaskTurnResult>` so
test runners can also signal violations.

**User experience:** the task panel shows `waiting` status with the boundary
activity message. The user can send a follow-up turn (which, via multi-turn
context, will include the prior exchange) to redirect the agent.

## Error Handling

Existing error handling is unchanged. The `waiting` branch is only reached
when the Pi session completes normally but with one or more denied tool calls.
Thrown exceptions still produce `failed` status as before.

## Testing

Each change gets a failing test first:

| Test | File | Assertion |
|------|------|-----------|
| `piRunner` receives `agent` from `execution` | `task-runner.test.ts` | spy captures `agent` matching `execution.agent` |
| `piRunner` receives formatted history on continuation | `task-runner.test.ts` | prompt contains `Prior conversation:` block with prior turn content |
| first-turn prompt has no history block | `task-runner.test.ts` | prompt does not contain `Prior conversation:` |
| `boundaryViolations: 1` → task `waiting` | `task-runner.test.ts` | `store.getTask(id).status === "waiting"` |
| `boundaryViolations: 0` → task `done` | `task-runner.test.ts` | `store.getTask(id).status === "done"` |
| `onViolation` fires on workspace denial | `workspace-tools.test.ts` | callback called with tool name |
| history prepended after agent instructions | `pi-session.test.ts` | prompt order: instructions → history → user task |
| `buildPrompt` omits history when empty | `pi-session.test.ts` | no `Prior conversation:` section |
| `boundaryViolations` increments per denied call | `pi-session.test.ts` | `result.boundaryViolations === 2` after two denied tools |

Verification commands:

```bash
bun run check
bun run --filter '*' test
```

## Files Changed

| File | Nature of change |
|------|-----------------|
| `apps/sidecar/src/task-runner.ts` | Add `agent?` + `conversationHistory?` to piRunner type; pass both at call site; branch `waiting` vs `done` on `boundaryViolations` |
| `apps/sidecar/src/task-runner.test.ts` | New tests for agent forwarding, history, and waiting status |
| `packages/core/src/pi-session.ts` | Add `conversationHistory?` to options; extend `PiTaskTurnResult`; rename `withAgentInstructions` → `buildPrompt`; pass `onViolation` to tools |
| `packages/core/src/pi-session.test.ts` | New tests for prompt assembly and violation counting |
| `packages/core/src/workspace-tools.ts` | Add `onViolation` option; call on `WorkspaceBoundaryError` |
| `packages/core/src/workspace-tools.test.ts` | Test `onViolation` fires on denial |

## Known Exclusions

- Session persistence (Pi-native multi-turn via SDK message objects)
- File artifact tracking
- Workflow agent step
- Resumable mid-session tool approval
