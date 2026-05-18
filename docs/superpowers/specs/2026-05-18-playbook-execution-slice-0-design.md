# Playbook Execution Simplification — Slice 0 Design

**Date:** 2026-05-18
**Status:** Draft — pending user review
**Slice relationship:** Slice 0 of a two-slice plan. Slice 1 (command/effect kernel rewrite) is deferred to a separate spec written after Slice 0 stabilizes.

## Problem

Playbook runs hang and block during dogfooding. Two root-cause classes account for the pain:

- **B. False-positive timeout failures.** Steps are marked `failed` from timeout *observation* even when the worker is alive or the work has actually completed. This destroys trust in run state.
- **C3 + C4. Scheduling/recovery bugs.** Stale leases held by dead workers are not reclaimed within one drain tick, and downstream steps block because dependency satisfaction reads transient queue state instead of committed artifact versions.

The original draft (`.omx/plans/2026-05-18-playbook-execution-simplification.md`, pasted by the user) proposes a full command/effect kernel rewrite plus a simpler durable model plus an alpha reset. That plan is correct as an *end state* but bundles risky redesign with bug fixes. Landing it as one slice means dogfooding stays broken for weeks.

## Decision

Split the work into two slices:

- **Slice 0 (this spec):** targeted policy fixes inside the existing runtime. No kernel, no schema replacement, no reset. Lands B + C3 + C4 fixes only.
- **Slice 1 (separate spec, deferred):** the kernel rewrite from the user's draft, written after Slice 0 has stabilized. Slice 1 inherits Slice 0's timeout/heartbeat policy as a literal port instead of inventing it during a rewrite.

This separation gives the rewrite a clean acceptance criterion ("behave identically to Slice 0 under all characterization tests") and stops the bleeding within a single delivery slice.

## Scope (Slice 0)

### In scope
- Eliminate timeout-observation-as-failure (B).
- Reclaim stale leases deterministically within one drain tick (C3).
- Resolve dependency satisfaction from committed artifact versions (C4).
- All landed inside the existing `drainPlaybookGraphRun` loop with surgical insertions, not a rewrite.

### Non-goals (explicit, deferred to Slice 1)
- No reducer / command / effect kernel.
- No replacement of the durable model (`playbook_runs` / `playbook_steps` / etc.).
- No simplification of `handleGraphRunResume`.
- No `RunView` / `StepView` read-model.
- No alpha reset; existing local data must keep working.
- No changes to playbook package format, plugin SDK, or UI panel architecture.
- No changes to `parallelMap` semantics.

## Design

### Fix B — Evidence-bearing timeouts, never silent failure

**New step status:** `needs_attention`. Added as a string enum value on `playbook_steps.status`. Distinct from `failed` and from `blocked` (which already means "waiting on human review" — conflating would hide cause).

**Heartbeat path:**
- Worker writes `StepHeartbeat { stepId, workerId, ts }` to `playbook_events` (append-only) on a ticker keyed to the executing node's kind. Cadence is **tunable per node-kind with a 10s default**.
- Long-running agent/tool calls heartbeat independently of model streaming. The ticker starts before `adapter.invoke()` and stops on resolution or rejection.
- Heartbeat write is last-write-wins per `(stepId, workerId)`; cost is one row append per tick.

**Failure rule (load-bearing invariant):** the runtime may only transition a step to `failed` when one of the following holds:
1. The adapter call returned or threw an error.
2. The user issued an explicit `ForceFail` decision.
3. The runtime determined a deterministic failure (e.g., condition node with an invalid expression, missing required input).

Missing heartbeat → `needs_attention`. Never `failed`. This is the single rule that fixes B.

**Per-kind timeout defaults** (hard-coded for Slice 0; per-playbook overrides are a Slice 1 concern):

| Node kind | soft | hard |
|---|---|---|
| script | 30s | 2m |
| condition / join | 5s | 30s |
| tool | 2m | 10m |
| agent | 5m | 30m |
| humanReview | — | — |
| parallelMap parent | — | — (children own timeouts) |

Soft timeout = emit `SoftTimeoutObserved` event, surface UI badge ("running longer than expected"), step stays `in_progress`. Hard timeout = emit `HardTimeoutObserved`, attempt cancellation, transition step to `needs_attention`, surface recovery actions.

**Recovery actions** on a `needs_attention` step: `RetryStep`, `ContinueWaiting`, `MarkWorkerLost`, `CancelStep`, `ForceFail`. These reuse existing resume-handler decision shapes where possible. `ForceFail` is **hidden behind a debug toggle** in the UI until dogfooding validates the `needs_attention` flow.

### Fix C3 — Single deterministic lease reaper

Recovery is currently scattered across `drainPlaybookGraphRun` and the worker's outer loop. Consolidate into one function that runs at the *start* of every drain tick.

**Invariant:** before any scheduling work, scan `playbook_claims` where `now - last_heartbeat_at > heartbeatTimeout` (default 60s). For each stale claim, atomically:

1. Write a `LeaseExpired` event with evidence (worker id, last heartbeat, threshold).
2. Release the queue row so it is claimable.
3. Transition the step to `needs_attention` **only if** it was `in_progress`. Skip if already terminal (no resurrection).

The reaper is a pure function over `(claims, now, heartbeatTimeout)`. Fully unit-testable against a fake clock. Idempotent: running it twice on the same stale claim does not double-transition.

### Fix C4 — Dependencies resolve from committed artifact versions

Dependency satisfaction today reads transient queue/lease state, which produces the "upstream done but downstream blocked" class of bugs.

Replace with: at scheduler-pick time, for each pending step, look up its declared artifact dependencies in `playbook_artifact_versions` (already append-only, already the source of truth). A step is runnable iff every declared dependency has a committed version produced at or after the upstream step's completion event.

The queue row no longer holds dependency truth. It is a hint that the step exists; correctness lives in the artifact-versions table.

## Data Model Touches

Additive only. No table replacements.

1. **`playbook_steps.status`** — add `needs_attention` to the enum. Existing rows untouched.
2. **`playbook_events`** — already append-only. New `kind` values: `StepHeartbeat`, `SoftTimeoutObserved`, `HardTimeoutObserved`, `LeaseExpired`, `CancellationAttempted`, `CancellationConfirmed`. No schema change.
3. **`playbook_claims`** — add `last_heartbeat_at` column (nullable, defaults to `claimed_at` for existing rows).

One forward-only migration. Safe against existing local alpha data; no reset required.

No changes to `playbook_artifact_versions`, queue table shape, run table shape, or contract types exported from `packages/contracts` beyond the one-variant enum addition.

## Worker Loop Changes

Today: scan active runs → recover interrupted work → check context drift → call `maybeDrainGraphRun`.

After Slice 0:

1. **Reaper pass** (new). Single function. Performs the C3 transition atomically. Runs at the top of every drain tick.
2. Context drift check (unchanged).
3. `drainPlaybookGraphRun` (existing), with C4 dependency resolution swapped in at the pick-step site.

During adapter execution, the worker starts a heartbeat ticker keyed to the node-kind's cadence before invoking the adapter and stops it on resolution or rejection. Adapter failures continue to flow through the existing `FailStep` path.

No new worker process. No new IPC. No new scheduling algorithm.

## UI Surface Changes

Minimal — only what makes `needs_attention` actionable.

- Step row renders `needs_attention` with an evidence block: last heartbeat (relative time), threshold crossed, worker id.
- Recovery action buttons map to existing resume-handler decision shapes where possible. `ForceFail` is hidden behind a debug toggle.
- Soft-timeout surfaces as a non-blocking badge; step stays `in_progress`.

No new panels. No `RunView` / `StepView` abstraction — that is Slice 1.

## Tests

### Characterization tests (must pass against today's `main` before any code change)
- Linear success path through `drainPlaybookGraphRun`.
- Condition routing.
- Memoized deterministic step replay.
- Human review block → approve → continue.
- Edit-artifact invalidation downstream.
- `parallelMap` fan-out/fan-in (smallest case).

### New regression tests (must fail on today's `main`, pass after Slice 0)

Fix B:
- Worker starts a step, dies before heartbeat threshold → step shows `needs_attention` with evidence. Asserts `status !== 'failed'`.
- Adapter throws `TimeoutError` (adapter-confirmed) → step becomes `failed`. Distinguishes adapter timeout from observation timeout.
- Soft timeout fires but heartbeats continue → step stays `in_progress`, no false transition.
- Long agent call streams for 6m with heartbeats → step stays `in_progress` past the 5m soft timeout.

Fix C3:
- Two workers; one claims a step then dies. Next drain tick reaps the lease, the other worker re-claims and completes. Run finishes successfully.
- Reaper idempotency: running twice in a row on the same stale claim does not double-transition.
- Reaper skips already-terminal steps.

Fix C4:
- Upstream completes and writes artifact version. Downstream queue row was enqueued before completion. Next drain tick picks up the downstream step. Asserts dependency check reads `playbook_artifact_versions`, not queue state.
- Artifact dep with no committed version → downstream stays pending.

## Acceptance Criteria

1. All characterization tests pass unchanged.
2. All new regression tests pass.
3. `bun test packages/core/src/playbook-graph-runtime.test.ts apps/sidecar/src/playbook-graph-run-store.test.ts apps/sidecar/src/server.test.ts` is green.
4. `bun run check` is green.
5. Manual dogfooding: run the longest built-in playbook, kill the sidecar mid-step, restart, observe `needs_attention` with evidence and successful retry.
6. No step transitions to `failed` during dogfooding without an adapter error or explicit user decision recorded in the event log.

## Risks and Mitigations

**Risk:** Heartbeat events flood `playbook_events` and degrade query performance.
**Mitigation:** Heartbeats are append-only and not joined in read paths; reaper queries `playbook_claims.last_heartbeat_at`, not the event log. Cadence default of 10s keeps volume bounded.

**Risk:** `needs_attention` becomes a dumping ground that the user starts ignoring.
**Mitigation:** Every `needs_attention` carries evidence and explicit recovery actions. If dogfooding shows the status is being ignored, that is the signal to tighten timeout policy, not to remove the status.

**Risk:** Adding the reaper at the top of every drain tick adds latency under high run counts.
**Mitigation:** Reaper is a single indexed query on `playbook_claims.last_heartbeat_at`. Measure during dogfooding; if it becomes hot, debounce to once per N ticks. Not a Slice 0 concern at current run volumes.

**Risk:** Slice 0 makes the existing loop *more* complex, raising the cost of Slice 1.
**Mitigation:** Slice 0 inserts in two well-bounded places (reaper at top of drain, heartbeat ticker around adapter calls). Slice 1's kernel will reuse the reaper as a pure function and the heartbeat policy as a literal port.

## Slice 1 Sketch (deferred)

After Slice 0 stabilizes, Slice 1 lands the user's original draft with these subtractions (already shipped in Slice 0):
- Timeout / heartbeat policy.
- `needs_attention` status.
- Lease reaper as a pure function.

Slice 1's remaining load-bearing work: command/effect kernel in `packages/core/src/playbook-execution/`, narrow repository interface, unified resume command path, `RunView` / `StepView` read-model, alpha reset of the durable model. That spec gets written after Slice 0 has been dogfooded for ~2 weeks so the kernel's command set is informed by which recovery actions actually matter in practice.

## ADR

**Decision:** Split the playbook execution simplification into Slice 0 (targeted policy fixes inside the existing runtime) and Slice 1 (command/effect kernel rewrite, deferred). Slice 0 lands the heartbeat/timeout policy, the lease reaper, and the artifact-version dependency resolution.

**Drivers:** Restore dogfooding trust in 1–2 weeks instead of 4–6. Decouple bug fixes from architectural rewrite. Give Slice 1 a clean acceptance baseline.

**Alternatives considered:**
- *Land the user's original full plan as one slice.* Rejected: bundles risky redesign with bug fixes; if any slice slips, hangs keep hurting dogfooding.
- *Patch the current runtime in place with no `needs_attention` status.* Rejected: without a distinct status and evidence, the runtime keeps lying about failures even after the fixes.

**Consequences:** Slice 0 makes the existing loop slightly larger before Slice 1 shrinks it. The trade is acceptable because Slice 0's insertions are well-bounded and Slice 1 inherits them as pure functions.
