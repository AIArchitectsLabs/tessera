# Playbook Execution Simplification — Slice 0.5 Design

**Date:** 2026-05-18
**Status:** Draft — pending user review
**Slice relationship:** Closes two gaps left open by Slice 0 (`2026-05-18-playbook-execution-slice-0-design.md`). Precedes Slice 1 (kernel rewrite, deferred).

## Problem

Slice 0 landed `needs_attention`, the stale-lease reaper, and the recovery decision surface. Two pieces of the original Slice 0 contract did not land and now bracket the remaining stability gap:

- **B is half-closed.** `needs_attention` only triggers on lease expiry. A worker that is alive but stuck inside an adapter call (model timeout, tool hang) gives no signal until the lease TTL crosses. `lastHeartbeatAt` exists in the evidence schema but nothing writes it. Soft/hard timeouts and the per-node-kind matrix are absent.
- **C4 is open.** Dependency satisfaction still chains via `dependsOn: [queueEntryId]` plus a queue-row `artifactBindingState` (`packages/core/src/playbook-graph-runtime.ts:902, 1026, 1143`). The artifact-binding refresh mitigates drift but the source of truth is still transient queue state, not the committed `playbook_artifact_versions`. The "upstream completed but downstream blocked" class of bug remains latent.

## Decision

Slice 0.5 closes both gaps with additive changes inside the existing runtime. No kernel, no schema replacement, no reset. After Slice 0.5, Slice 1 (the command/effect kernel rewrite from the user's original draft) becomes a pure refactor with a complete characterization suite as its acceptance baseline.

## Scope

### In scope
- Real adapter-execution heartbeat path; reaper considers both lease TTL and stale heartbeat.
- Per-node-kind soft/hard timeout policy; soft timeout surfaces as a non-blocking UI badge.
- Dependency satisfaction resolved from `playbook_artifact_versions` at scheduler-pick time, not from queue state.
- Regression tests for each broken transition.

### Non-goals
- No reducer / command / effect kernel.
- No replacement of the durable model.
- No simplification of `handleGraphRunResume` beyond what these fixes touch.
- No `RunView` / `StepView` read-model.
- No changes to `parallelMap` semantics.
- No new recovery decisions beyond what Slice 0 already shipped.
- `ForceFail` remains behind a debug toggle until dogfooding validates the heartbeat-driven `needs_attention` flow.

## Design

### Part A — Heartbeat path (closes Fix B)

**Schema touches** (additive only):
- `PlaybookGraphQueueEntrySchema` gains an optional `lastHeartbeatAt: z.string().datetime().optional()` alongside `claimedAt` / `leaseExpiresAt`. (Currently `lastHeartbeatAt` only lives on `PlaybookGraphAttentionEvidenceSchema`.)
- One forward-only SQLite migration adds the column; existing rows default to NULL.
- New event kinds emitted via the existing operation-record path: `StepHeartbeat`, `SoftTimeoutObserved`, `HardTimeoutObserved`. No new event table — uses the operation log already in place.

**Worker behavior:**
- Before invoking the adapter, the worker starts a heartbeat ticker keyed to the node-kind's cadence (default 10s, tunable per kind).
- Each tick writes a single store call: `bumpHeartbeat({ queueEntryId, leaseId, now })`. Last-write-wins per `(queueEntryId, leaseId)`. Operation: `UPDATE playbook_graph_queue SET last_heartbeat_at = ? WHERE queue_entry_id = ? AND lease_id = ?`. Skips the write entirely if the lease has been lost (the `WHERE lease_id = ?` clause makes it idempotent and safe).
- The ticker stops on adapter resolution, rejection, or worker shutdown.
- Adapter failures continue to flow through the existing `FailStep` path. Heartbeat is observability only — it never determines failure on its own.

**Reaper extension** (`recoverStaleQueueLeases` in `apps/sidecar/src/playbook-graph-run-store.ts:782`):
- Predicate today: `entry.status === "running" && entry.leaseExpiresAt && entry.leaseExpiresAt <= now`.
- New predicate: `entry.status === "running" && (leaseExpired || heartbeatStale || hardTimeoutCrossed)`, where:
  - `leaseExpired = entry.leaseExpiresAt && entry.leaseExpiresAt <= now`.
  - `heartbeatStale = entry.lastHeartbeatAt && (now - entry.lastHeartbeatAt) > HEARTBEAT_STALENESS_MS` (single constant, **45s** — three missed 10s heartbeats with slack; independent of node kind).
  - `hardTimeoutCrossed = entry.claimedAt && (now - entry.claimedAt) > hardTimeoutMs(entry.nodeKind)`.
- Attention evidence carries `lastHeartbeatAt` and `thresholdMs` so the UI can render *why* the step was parked.
- Auto-requeue policy from Slice 0 is preserved: `rerun_if_no_success_memo` → `auto_requeued`, else → `needs_attention`.

**Per-node-kind timeout matrix** (hard-coded constants in `packages/core/src/playbook-graph-runtime.ts`; per-playbook overrides deferred to Slice 1):

| Node kind | heartbeat cadence | soft timeout | hard timeout |
|---|---|---|---|
| script | 10s | 30s | 2m |
| condition / join | 10s | 5s | 30s |
| tool | 10s | 2m | 10m |
| agent | 10s | 5m | 30m |
| artifactWrite | 10s | 30s | 2m |
| humanReview | — | — | — |
| parallelMap parent | — | — | — (children own timeouts) |

**Threshold semantics** (three independent thresholds per active step):
- *Heartbeat staleness* (`HEARTBEAT_STALENESS_MS = 45s`, single constant): worker presumed lost. Triggers reaper transition to `needs_attention` with `code: "stale_heartbeat"`. Independent of node kind because it measures worker liveness, not work duration.
- *Soft timeout* (per node kind): step is taking longer than expected but heartbeats are still arriving. Reaper does not touch. Runtime emits one `SoftTimeoutObserved` operation record on first crossing; UI surfaces a non-blocking badge ("running longer than expected"). Step stays `in_progress`.
- *Hard timeout* (per node kind): step exceeded maximum allowed wall-clock duration regardless of heartbeat liveness. Reaper transitions to `needs_attention` with `code: "hard_timeout"`. Distinct from `stale_heartbeat`: hard timeout means the work itself ran too long; stale heartbeat means we lost contact with the worker.

The existing `code: "stale_lease"` from Slice 0 remains for the lease-expiry case (e.g., sidecar restart where the lease TTL is the only signal). New evidence codes: `"stale_heartbeat"`, `"hard_timeout"`.

**Failure rule (unchanged, restated for clarity):** a step transitions to `failed` only when the adapter returned/threw an error, the user issued `force_failed`, or the runtime determined a deterministic failure. Missing heartbeat → `needs_attention`. Never `failed`.

### Part B — Artifact-version-driven dependency resolution (closes Fix C4)

**Current shape:**
- Downstream queue entries declare `dependsOn: [upstreamQueueEntryId]` (`playbook-graph-runtime.ts:902, 1026, 1143`).
- Dependency satisfaction is implicit: when the upstream queue entry transitions to `completed`, downstream becomes pickable. Artifact bindings are tracked in a queue-row `artifactBindingState` that can drift relative to committed artifact versions.

**Target shape:**
- `dependsOn` stays as a hint (cheap pickability check) but is no longer the source of truth.
- At scheduler-pick time, for each pending entry, the runtime resolves declared artifact consumes against `playbook_artifact_versions`. An entry is runnable iff every declared `consumesArtifacts` ref has a committed version produced at or after the upstream step's completion timestamp.
- The existing `artifactBindingState` field continues to render in the UI but is recomputed from artifact-versions on read, not stored as authoritative on the queue row.

**Implementation:**
- Extract a new pure helper `resolveArtifactDependencies({ entry, artifactVersions, completedAt }) → { runnable: boolean, missing: ArtifactRef[] }` into the existing runtime file. Pure function, fully unit-testable.
- The scheduler-pick site (currently inside `drainPlaybookGraphRun`) calls the helper before claiming a lease. If `runnable === false`, the entry stays `queued` and we log the missing refs.
- No write-path changes: artifact-version commits already go through `playbook_artifact_versions`; we are switching the *read* side, not the *write* side.

This eliminates the "upstream done but downstream blocked" class by making the dependency check a function of committed facts.

## Data Model Touches

Additive only.

1. `playbook_graph_queue` — add `last_heartbeat_at` column (nullable, no default). One forward-only migration. Safe against existing local alpha data.
2. `PlaybookGraphQueueEntrySchema` (contracts) — add optional `lastHeartbeatAt`.
3. `PlaybookGraphAttentionEvidenceSchema.code` — add `"hard_timeout"` and `"stale_heartbeat"` enum values alongside existing `"stale_lease"`.
4. `PlaybookGraphAttentionEvidenceSchema.thresholdMs` already exists; we start populating it for hard-timeout cases.

No changes to `playbook_artifact_versions`, run table, contracts-exported run shape, or any UI panel architecture beyond the soft-timeout badge.

## Worker Loop Changes

Today the worker (with Slice 0 changes) does: reaper recovery → context drift check → `drainPlaybookGraphRun`.

After Slice 0.5:
1. Reaper recovery — extended predicate (lease OR stale heartbeat).
2. Context drift check (unchanged).
3. `drainPlaybookGraphRun` — pick site calls `resolveArtifactDependencies` before claiming.
4. Adapter execution — heartbeat ticker wraps `adapter.invoke()`; soft-timeout observation emits one operation record per crossing.

No new worker process. No new IPC.

## UI Surface Changes

Minimal.

- Step row badge: when `lastHeartbeatAt` is fresh but step has crossed its soft-timeout threshold, render "running longer than expected" with the threshold value. Click reveals heartbeat evidence.
- `needs_attention` evidence block (already rendered in Slice 0) now distinguishes `code: "stale_lease"`, `"stale_heartbeat"`, and `"hard_timeout"` in its copy. All three surface the same recovery actions.
- No new buttons, no new panels.

## Tests

### New regression tests (each must fail on `main`, pass after Slice 0.5)

Heartbeat path:
- Worker invokes a slow adapter that streams for 6 minutes with heartbeats every 10s. Step stays `in_progress` past the 5m agent soft-timeout. Asserts one `SoftTimeoutObserved` record exists; no transition to `needs_attention`.
- Worker invokes an agent adapter that produces no heartbeat for 60 seconds. Reaper transitions step to `needs_attention` with `code: "stale_heartbeat"` and `thresholdMs = 45000`.
- Worker invokes an agent adapter that heartbeats correctly but the work itself runs 31 minutes. Reaper transitions step to `needs_attention` with `code: "hard_timeout"` and `thresholdMs = 1800000`.
- Worker dies before first heartbeat. Reaper still transitions on lease expiry with `code: "stale_lease"` (Slice 0 behavior preserved).
- Heartbeat write with stale `lease_id` is a no-op (`WHERE lease_id = ?` clause). Asserts no stale heartbeat can extend a lease the worker no longer owns.
- Reaper is idempotent across both predicates: running twice on a `(leaseExpired, heartbeatStale)` row does not double-transition.

Artifact-version dependency:
- Upstream step completes and commits artifact version. Downstream queue entry was enqueued before completion. Next drain tick: `resolveArtifactDependencies` returns `runnable: true`, step is claimed. Asserts the dependency check inspects `playbook_artifact_versions`, not `artifactBindingState`.
- Upstream artifact missing → `resolveArtifactDependencies` returns `runnable: false, missing: [ref]`. Downstream stays `queued`. Asserts a log line names the missing ref.
- Upstream completes but artifact version commit lags (simulated): downstream stays `queued` for one tick, then becomes runnable on the next tick. No spurious `needs_attention`.

### Characterization tests (must keep passing unchanged)
All existing tests added in Slice 0, plus the pre-Slice-0 characterization set. No churn expected — Slice 0.5 is additive.

## Acceptance Criteria

1. All Slice 0 tests pass unchanged.
2. All new regression tests pass.
3. `bun test packages/contracts/src/playbook-graph-run.test.ts packages/core/src/playbook-graph-runtime.test.ts apps/sidecar/src/playbook-graph-run-store.test.ts apps/sidecar/src/server.test.ts apps/desktop/ui/src/components/PlaybooksView.test.tsx` is green.
4. `bun run check` is green.
5. Manual dogfooding, three scenarios:
   - Kill the sidecar mid-step → `code: "stale_lease"`.
   - Stub an adapter that sleeps 60s without writing heartbeats → `code: "stale_heartbeat"`.
   - Stub an agent adapter that heartbeats correctly but runs past 30m → `code: "hard_timeout"`.
   All three surface evidence and the existing retry action.
6. No step transitions to `failed` during dogfooding without an adapter error or explicit user decision recorded in the operation log.

## Risks and Mitigations

**Risk:** Heartbeat writes contend with adapter throughput on slow disk.
**Mitigation:** One UPDATE per 10s per active step is well under any sane SQLite limit. If it becomes hot, debounce or batch — measure first.

**Risk:** Soft-timeout badges become noise the user learns to ignore.
**Mitigation:** Defaults err generous (5m for agents, 2m for tools). If a class of nodes routinely crosses soft, that's a signal to retune the matrix, not to remove the badge.

**Risk:** Switching dependency truth to artifact-versions surfaces existing playbooks whose declared `consumesArtifacts` are wrong.
**Mitigation:** The migration adds logging at the `resolveArtifactDependencies` call site; any "missing ref" log is a real bug to fix in the playbook definition, not in the runtime. Slice 0.5 surfaces these latently-wrong playbooks rather than letting them ride on accidental queue-state coupling.

**Risk:** Heartbeat ticker leaks if adapter never resolves.
**Mitigation:** Ticker is keyed to the same `AbortController` / lifecycle the adapter invocation already owns. Worker shutdown clears all active tickers. Reaper is the backstop — even with a leaked ticker, hard timeout fires.

## Notes for Slice 1 (deferred)

Slice 0.5 leaves Slice 1's footprint identical to what the original draft proposed, minus:
- Heartbeat / timeout policy — proven in 0.5, ported literally into the reducer.
- `needs_attention` status — already exists.
- Lease reaper — already pure; lifts directly into the reducer's `Tick` command.
- `resolveArtifactDependencies` — pure helper, lifts directly.

Slice 1's load-bearing remaining work: command/effect kernel, narrow repository interface, unified resume command path, `RunView` / `StepView` read-model, alpha reset of the durable model. Acceptance criterion: behave identically under the now-comprehensive Slice 0 + 0.5 characterization suite.

## ADR

**Decision:** Land Slice 0.5 (heartbeat path + per-kind timeout matrix + artifact-version dependency resolution) before starting Slice 1 (kernel rewrite).

**Drivers:** Slice 0 closed the dead-worker / restart path but left the live-but-stuck-worker path and the dependency-blocked-after-completion path open. Slice 1's reducer would have to invent both policies during a rewrite, which is exactly the failure mode the original draft's risk section flagged.

**Alternatives considered:**
- *Jump straight to Slice 1.* Rejected: rewriting while the policies are still unproven means the reducer's command set is guesswork.
- *Bundle heartbeat into Slice 1 only.* Rejected: dogfooding continues to hit B in the meantime.

**Consequences:** Two small additive changes to the current runtime. Slice 1 inherits both as pure functions and ports them literally instead of redesigning during a rewrite.
