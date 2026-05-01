# Pi Coding Agent MVP Design

## Summary

Use `@mariozechner/pi-coding-agent` as Tessera's embedded agent runtime for the
MVP task execution path. Tessera should reuse Pi's session, model registry,
auth storage abstraction, tool, extension, skill, and streaming event layers
instead of rebuilding them on top of `pi-agent-core`.

Tessera remains the product shell and security boundary. The desktop app owns
workspace selection, keychain-backed credential storage, approval UX, task and
workflow persistence, and workspace-scoped tool policy.

This design is inspired by OpenClaw's Pi integration and by Pi's SDK surface,
which exposes `AuthStorage`, `ModelRegistry`, `SessionManager`, and
`createAgentSession`. The implementation must use official Pi SDK behavior as
the source of truth during build.

## Goals

- Replace the current stub task runner with a Pi-backed task execution path.
- Reuse Pi Coding Agent for sessions, skills, extensions, prompt templates,
  built-in agent behavior, model registry, and auth storage abstractions.
- Preserve Tessera's existing model settings UX and keychain-backed secret
  storage.
- Scope every Pi file and shell capability to the selected workspace root.
- Allow workspace-contained file mutations without an extra approval prompt.
- Keep workflows as deterministic Tessera-owned orchestration, with Pi agent
  steps added after task execution is stable.

## Non-Goals

- Do not replace Tessera's desktop model settings UI.
- Do not persist provider credentials in Pi's plaintext auth file.
- Do not expose unrestricted Pi filesystem, edit, write, or shell tools.
- Do not convert all workflows to Pi sessions in the first slice.
- Do not add sub-agents, background planning modes, or OpenClaw parity features
  beyond what is needed for the MVP.

## Architecture

Add a narrow Pi adapter in `packages/core` and call it from the sidecar task
runner.

```text
Desktop UI
  -> Tauri model settings commands
     -> OS keychain + redacted settings JSON

Desktop UI
  -> authenticated sidecar task endpoints
     -> task-runner.ts
        -> packages/core TesseraPiSession adapter
           -> pi-coding-agent createAgentSession
              -> Tessera resource loader / tools / model registry / auth bridge
```

The adapter should hide Pi SDK details from the rest of Tessera. Sidecar code
should deal in Tessera concepts: task id, workspace root, prompt, model
selection, emitted task events, policy decisions, and artifacts.

## Model And Credential Design

Current Tessera model settings remain the user-facing source of truth:

- selected provider
- model name
- local provider base URL
- redacted credential state via `hasCredential`
- save, delete, and connection-test flows

Tauri continues to store secrets in the OS keychain. The sidecar receives only
the runtime credential needed for the current session or model test. Pi must
not be allowed to write those credentials into its default auth file.

Add a runtime bridge:

- `TesseraCredentialProvider`: sidecar-facing interface that can provide an
  ephemeral credential for the selected provider.
- `TesseraAuthStorage`: in-memory Pi `AuthStorage` adapter populated from
  Tessera credentials at session creation time.
- `TesseraModelRegistry`: maps Tessera `AgentProviderConfig` values to Pi model
  selection using Pi's registry APIs.

The existing `packages/core/src/model.ts` manual model construction can shrink
or disappear once Pi `ModelRegistry` handles provider/model resolution.

## Workspace Tool Boundary

All Pi tools must be workspace-scoped. A selected workspace root is required
before creating a Pi-backed task session.

The workspace root must be canonicalized before use:

- resolve relative segments
- resolve symlinks where the platform exposes canonical paths
- reject missing or non-directory roots
- store the canonical root on the task/session

Every file path passed to a Pi read, write, edit, glob, search, or metadata tool
must be resolved against the canonical workspace root and then checked with a
path containment guard:

```text
resolvedTarget == workspaceRoot
or resolvedTarget is inside workspaceRoot with a path-separator boundary
```

The guard must reject:

- absolute paths outside the workspace
- `..` traversal outside the workspace
- symlinks that resolve outside the workspace
- hardcoded home, temp, config, or system paths outside the workspace
- shell commands that set `cwd` outside the workspace
- generated artifact paths outside the workspace

Shell tools are disabled in the first MVP. When shell support is added later,
it must run with `cwd` set to the canonical workspace root, require approval
before execution, and reject any requested `cwd` outside the workspace. The
shell environment must not receive provider credentials by default.

Write/edit tools are allowed when every target path is inside the canonical
workspace root. Workspace containment is the approval boundary for file
mutation in the MVP. Operations outside the workspace are denied rather than
prompted.

## Tool Policy

The first MVP should start with the smallest useful tool set:

- allow workspace-scoped read/list/search tools
- allow workspace-scoped artifact creation through Tessera wrappers
- allow workspace-contained write/edit tools and keep bash disabled
- deny anything that cannot prove workspace containment
- deny any tool that attempts to access secrets, app config, keychain files, or
  sidecar databases directly

Pi's default tools should not be registered raw. The first implementation
should expose custom Pi tools that call Tessera's existing tool policy layer.
Wrapped Pi internals can be considered later, after the custom tool
surface proves where reuse is actually needed.

Custom tools are preferable to broad post-hoc filtering because policy
decisions need a precise preview, capability classification, and risk
description before execution.

## Task Execution

Replace the current simulated task runner with a Pi session run.

Flow:

1. User creates or continues a workspace task.
2. Sidecar loads task, selected workspace root, selected model config, and
   runtime credential.
3. Sidecar creates a `TesseraPiSession` with an in-memory Pi session manager for
   the first slice.
4. User turn is marked completed.
5. Agent turn is marked running.
6. Pi events stream into Tessera task events.
7. Tool calls create task activity updates.
8. Denied tool calls mark the task waiting or failed, depending on whether the
   agent can recover with an in-workspace alternative.
9. Completed assistant output is persisted as the agent turn.
10. Produced files or text outputs are persisted as task artifacts.

The current task database remains Tessera-owned. Pi session files can be
introduced later only if they are stored under Tessera's app data directory and
do not duplicate secrets.

## Workflow Execution

Keep the current workflow runner as the deterministic outer orchestrator.
Workflow runs are checkpointed by Tessera and can suspend/resume around
recoverable blocked tool requests.

After Pi-backed task execution works, add a new workflow step kind:

```ts
type WorkflowAgentStep = {
  id: string;
  kind: "agent";
  prompt: string;
  modelRef?: string;
  workspaceRootInput?: string;
  onSuccess?: string;
  onFailure?: string;
};
```

The workflow agent step should call the same `TesseraPiSession` adapter used by
tasks. If a Pi tool attempts an out-of-workspace operation, the workflow run
becomes blocked or denied using Tessera's existing policy result shape.

## Event Mapping

Pi events should be mapped into existing Tessera events instead of leaking Pi
event names into the UI contract.

Initial mapping:

- session start -> task updated, latest activity `Starting`
- assistant text delta -> agent turn content update or buffered stream event
- tool call start -> task updated, latest activity based on tool label
- tool result -> artifact or turn metadata when relevant
- recoverable blocked tool request -> task status `waiting`
- assistant completed -> turn completed
- error/interrupted -> turn failed and task failed or waiting, depending on
  recoverability

If Pi event types change, only the adapter should need updates.

## Error Handling

Missing model credential should fail before session creation with the same
Settings > Model guidance used today.

Workspace boundary failures are denied, not approval prompts. The user should
not be asked to approve operations outside the selected workspace.

Tool schema failures return structured tool errors to the session and are also
recorded in task activity.

Pi SDK failures should mark the current agent turn failed without corrupting the
task history.

Cancellation should abort the Pi session, mark the running turn failed or
interrupted, and keep all completed prior turns intact.

## Testing

Required tests:

- workspace root canonicalization accepts real workspace roots
- workspace root canonicalization rejects missing roots
- path guard allows files inside the workspace
- path guard rejects `..` traversal
- path guard rejects absolute paths outside the workspace
- path guard rejects symlinks that resolve outside the workspace
- write/edit tools are allowed inside the workspace without extra approval
- bash tools are denied in the first MVP
- denied outside-workspace tools do not execute
- task runner maps Pi assistant output to an agent turn
- task runner maps Pi tool events to task activity
- missing credential fails before creating a Pi session
- credential bridge does not persist credentials to Pi auth files
- workflow agent step blocks or denies out-of-workspace tool requests

Verification commands for the implementation slice:

```bash
bun run check
bun run --filter '*' test
```

## MVP Sequence

1. Add `@mariozechner/pi-coding-agent` as a dependency of `packages/core`.
2. Add a minimal `TesseraPiSession` adapter using in-memory Pi session
   management.
3. Add a workspace path guard with dedicated tests.
4. Add read-only workspace-scoped tools.
5. Bridge existing model settings and credentials into Pi runtime auth/model
   selection.
6. Replace the task runner stub with Pi session execution.
7. Stream Pi output into existing task events.
8. Add workspace-contained write/edit wrappers.
9. Add workflow `agent` steps only after task execution is verified.

## Open Questions

- Which Pi session persistence mode is best once MVP task execution works:
  Tessera-only SQLite, Pi session files under Tessera app data, or both with a
  single authoritative task id mapping?
- Should Tessera expose Pi skills directly in the UI, or treat them as hidden
  implementation capabilities behind task personas and workflows?

## References

- Nader Dabit, "How to build a custom agent framework":
  https://nader.substack.com/p/how-to-build-a-custom-agent-framework
- Pi SDK docs: https://pi.dev/docs/latest/sdk
- Pi docs home: https://pi.dev/docs/latest
- OpenClaw Pi architecture: https://docs.openclaw.ai/pi
- OpenClaw model failover: https://docs.openclaw.ai/concepts/model-failover
