# Beta Dogfood Checklist

Use this checklist before cutting a public beta build. It covers the golden path
that a beta user must be able to complete without internal planning notes.

## Run Metadata

- Date:
- Tester:
- OS:
- Tessera commit:
- App build:
- Workspace path:
- Notes:

## Verdict

| Flow | Result | Evidence |
| --- | --- | --- |
| Task chat | Not run | |
| Built-in playbook run | Not run | |
| Human review to workspace write | Not run | |
| External playbook import | Not run | |

Result values: `pass`, `pass-with-notes`, or `fail`.

## Setup

- Start from a clean local workspace with `inputs/`, `outputs/`, and `imports/`
  directories.
- Launch the desktop app from the beta build being tested.
- Select the clean workspace in Tessera.
- Confirm at least one agent profile is available.
- Confirm optional integrations are either connected or clearly marked as
  optional setup.

## Flow 1: Task Chat

Purpose: prove a user can start a task, send a follow-up, and see the task
timeline stay responsive.

Steps:

1. Open the task chat screen.
2. Create a new task with a short workspace-grounded request.
3. Wait for the first assistant response to finish.
4. Send a follow-up message in the same task.
5. Open any generated artifact or referenced workspace file if one appears.

Pass criteria:

- A task is created and visible in the task list.
- The first response completes without a stuck loading state.
- The follow-up turn appears in the same task.
- Any checklist, artifact, or referenced file can be inspected from the task
  detail view.
- No console, sidecar, or UI error is visible.

Evidence:

- Task ID:
- Prompt used:
- Follow-up used:
- Artifact or file opened:
- Screenshot/log notes:

Automation candidate:

- Existing proxy coverage lives in `apps/desktop/ui/src/components/TaskDetail.test.tsx`.
- Keep manual until one real sidecar-backed task chat run passes on each target OS.

## Flow 2: Built-In Playbook Run

Purpose: prove a beta user can run a built-in playbook from setup through output.

Steps:

1. Open Playbooks.
2. Select a built-in playbook, preferably `Sales Meeting Brief`.
3. Review setup and capability preflight.
4. Start the run.
5. Wait until the run reaches a completed or review-needed state.
6. Inspect the main output artifact or run summary.

Pass criteria:

- Built-in playbooks load without import steps.
- Setup/preflight is understandable and does not block on hidden internal state.
- Starting the run creates a graph run.
- The run appears in run history.
- The output or next human action is visible from the playbook screen.

Evidence:

- Playbook ID:
- Run ID:
- Agent/profile used:
- Output artifact title/path:
- Screenshot/log notes:

Automation candidate:

- Existing proxy coverage lives in `apps/desktop/ui/src/components/PlaybooksView.test.tsx`
  under the built-in graph run tests.
- Automate a sidecar-backed smoke after the manual run identifies the lowest-risk
  built-in fixture.

## Flow 3: Human Review To Workspace Write

Purpose: prove a user can inspect prepared evidence, make a review decision, and
approve a write that stays inside the selected workspace.

Steps:

1. Open a playbook run that is waiting for human review.
2. Inspect the prepared artifact evidence.
3. If available, request changes once with a short note.
4. Return to the review step and approve the prepared write.
5. Open the written workspace file from Tessera.
6. Confirm the file is inside the selected workspace.

Pass criteria:

- Review-needed state is clear.
- Evidence is visible before approval.
- Request-changes feedback is captured when used.
- Approval resumes the run with the expected review action.
- The resulting write is visible in the workspace and opens from the app.
- No write escapes the selected workspace.

Evidence:

- Run ID:
- Review queue entry:
- Review action:
- Workspace file path:
- Screenshot/log notes:

Automation candidate:

- Existing proxy coverage lives in `apps/desktop/ui/src/components/PlaybooksView.test.tsx`
  for review resume, evidence preview, request changes, and workspace file open.
- Workspace boundary coverage lives in `apps/desktop/src-tauri/src/lib.rs` tests.
- Keep final approval manual for beta unless the fixture is fully deterministic.

## Flow 4: External Playbook Import

Purpose: prove a beta user can import a public playbook package and understand
whether it is ready to run.

Steps:

1. Open Playbooks.
2. Import a playbook archive from the clean workspace.
3. Confirm the imported playbook appears in the catalog.
4. Import a playbook folder if the beta package includes one.
5. Select the imported playbook.
6. Review package metadata, required capabilities, optional sources, and run
   readiness.
7. Start a run if the package is safe and ready.

Pass criteria:

- Archive import returns a clear success message.
- Folder import returns a clear success message when tested.
- Imported package version and description are visible.
- Required capabilities and optional sources are visible before run start.
- Canceling import leaves existing playbook state unchanged.
- If run started, run history and output/review state appear.

Evidence:

- Package path:
- Playbook ID:
- Package version:
- Run ID, if started:
- Screenshot/log notes:

Automation candidate:

- Existing proxy coverage lives in `apps/desktop/ui/src/components/PlaybooksView.test.tsx`
  under archive import, folder import, and cancel import tests.
- Add a sidecar-backed import smoke once the public sample package path is stable.

## Automated Proxy Checks

Run these after any code change that touches the golden path:

```bash
bun test apps/desktop/ui/src/components/TaskDetail.test.tsx
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
cargo test
```

For broader release confidence, also run:

```bash
bun run check
```

These checks do not replace a real dogfood pass. They prove the current UI and
workspace-boundary contracts still match the intended beta flows.

Latest proxy run notes:

- `TaskDetail.test.tsx`: passed without React `act(...)` warnings.
- `PlaybooksView.test.tsx`: passed.
- `cargo test`: passed.

## Failure Triage

For each failed flow, create or link an issue with:

- flow name
- exact failing step
- expected behavior
- actual behavior
- task ID, run ID, or playbook ID when available
- screenshot or log excerpt
- whether the beta should block on the fix
