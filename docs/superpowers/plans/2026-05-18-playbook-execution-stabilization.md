# Playbook Execution Stabilization Plan

> Product goal: Playbook execution should feel reliable even when the internal graph runtime is recovering from interruptions. End users should see workflow states and meaningful actions, not queue/lease/heartbeat mechanics.

**Spec:** `docs/superpowers/specs/2026-05-18-playbook-execution-stabilization-design.md`

## Requirements Summary

- Hide internal graph recovery states from the primary playbook UI.
- Add a product-facing run state facade: `working`, `recovering`, `waiting_for_review`, `retry_available`, `failed`, `completed`, `restart_required`.
- Auto-recover safe internal interruptions before asking the user.
- Render action labels from sidecar action specs, not from generic approval wording.
- Preserve technical evidence behind "View details" for dogfooding.
- Add a lightweight runner-version guard so stale sidecar/runtime mismatches do not create misleading recovery cards.

## Acceptance Criteria

1. A safe `stale_lease` research/tool step retries automatically once and does not show a blocking review card.
2. Exhausted recovery budget shows `Step interrupted` with `Retry step`, not `Your review is needed` with `Approve`.
3. Real human review still shows `Review needed` and artifact-specific actions like `Approve brief`.
4. Main UI copy never shows raw codes such as `stale_lease`, `stale_heartbeat`, `lease_id`, or `queue_entry_id`.
5. Raw codes remain visible in details/logs/debug views.
6. Run list and run detail badges are derived from the product state.
7. Runtime/sidecar version mismatch surfaces as `Restart required`.
8. Existing Slice 0/Slice 0.5 tests remain green.
9. `bun run check` passes.

## Implementation Steps

### Task 1: Add Product State Contracts

**Files:**
- `packages/contracts/src/index.ts`
- `packages/contracts/src/playbook-graph-run.test.ts`

Add schemas for:

- `PlaybookRunProductStateSchema`
- `PlaybookRunProductActionSchema`
- `PlaybookRunProductViewSchema`

Extend `PlaybookGraphRunReviewSurfaceSchema` with:

```typescript
productView: PlaybookRunProductViewSchema.optional()
```

Keep it optional for one slice so older review surfaces do not break during dogfooding.

Tests:

- Accepts `retry_available` with `Retry step`.
- Accepts `waiting_for_review` with `Approve brief`.
- Rejects empty labels.
- Rejects unknown product states.

### Task 2: Build Sidecar Product-State Projection

**Files:**
- `apps/sidecar/src/server.ts`
- `apps/sidecar/src/server.test.ts`

Create a pure helper near `graphRunActionSpecs`:

```typescript
function graphRunProductView(detail: GraphRunDetail): PlaybookRunProductView
```

Mapping:

- blocked human review -> `waiting_for_review`
- needs-attention retryable -> `retry_available`
- active running/queued -> `working`
- completed -> `completed`
- failed -> `failed`
- runner mismatch -> `restart_required`

Use existing action specs as the source of button labels. The sidecar already emits retry actions for `needs_attention` entries at [server.ts](/Users/utpal/Code/projects/tessera/apps/sidecar/src/server.ts:2446); this task promotes that label into the primary product action.

Tests:

- `needs_attention` produces title `Step interrupted` and primary action `Retry step`.
- human review produces title `Review needed` and primary action from artifact/action context.
- raw attention code is present only in `technicalSummary`.

### Task 3: Add Bounded Auto-Recovery

**Files:**
- `apps/sidecar/src/server.ts`
- `apps/sidecar/src/server.test.ts`
- `apps/sidecar/src/playbook-graph-run-store.ts`
- `apps/sidecar/src/playbook-graph-run-store.test.ts`
- `packages/core/src/playbook-graph-runtime.ts`
- `packages/core/src/playbook-graph-runtime.test.ts`

Add a recovery budget helper:

```typescript
function shouldAutoRecoverAttention(entry, operationRecords): boolean
```

Initial policy:

- auto-retry once for `stale_lease` on `script`, `condition`, `join`, read-only `tool`
- auto-retry once for `stale_heartbeat` on `script`, read-only `tool`
- no auto-retry for `hard_timeout`
- no auto-retry for `artifactWrite`, `humanReview`, write-capable tools

Record automatic recovery as an operation:

- `kind`: use existing `retry_needs_attention`
- `operatorIntent`: `Automatically retry interrupted step`
- `actionSpecId`: `system.recovery.auto_retry`

Tests:

- safe stale lease auto-requeues and run returns to `running`.
- second stale lease for the same queue entry family becomes `retry_available`.
- hard timeout does not auto-retry.
- artifactWrite does not auto-retry.

### Task 4: Replace Guided Review With State-Specific Decision Copy

**Files:**
- `apps/desktop/ui/src/components/PlaybooksView.tsx`
- `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

Refactor `GuidedReview` into a state-driven card.

Current issue: [GuidedReview](/Users/utpal/Code/projects/tessera/apps/desktop/ui/src/components/PlaybooksView.tsx:2389) always renders review language and an approve button. That is wrong for retry/recovery.

New behavior:

- `waiting_for_review`: show artifact review sections.
- `retry_available`: show "Step interrupted", "Tessera can retry this step", primary button `Retry step`.
- `recovering`: show non-blocking recovery progress.
- `restart_required`: show restart-specific copy.

Tests:

- `retry_available` does not render "What Tessera prepared".
- `retry_available` does not render "What happens if you approve".
- primary button is `Retry step`.
- human review still renders `Approve brief`.

### Task 5: Stop UI From Inferring Recovery Meaning From Raw Queue State

**Files:**
- `apps/desktop/ui/src/components/PlaybooksView.tsx`
- `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

Change `graphRunApproval` so it prefers `selectedGraphRunSurface.productView`.

Fallback to the old raw-queue inference only when `productView` is absent, and mark that branch with a TODO to remove after one release.

Current raw inference lives around [PlaybooksView.tsx](/Users/utpal/Code/projects/tessera/apps/desktop/ui/src/components/PlaybooksView.tsx:836). This task makes that code a compatibility fallback, not the main path.

Tests:

- when `productView` exists, UI ignores raw `attentionEvidence.reason` for main copy.
- details view can still show technical summary.

### Task 6: Add Runner Version Guard

**Files:**
- `packages/contracts/src/index.ts`
- `apps/sidecar/src/server.ts`
- `apps/sidecar/src/server.test.ts`
- `apps/desktop/ui/src/components/PlaybooksView.tsx`

Add a runner compatibility marker:

- sidecar reports current `playbookRunnerVersion`
- run creation stores it in graph run payload
- review surface compares stored vs current
- mismatch maps to product state `restart_required`

Tests:

- matching version leaves state unchanged.
- incompatible version returns `restart_required`.
- UI renders restart copy and does not show retry/approve actions.

### Task 7: Verification And Dogfooding

Run:

```bash
bun test packages/contracts/src/playbook-graph-run.test.ts \
  packages/core/src/playbook-graph-runtime.test.ts \
  apps/sidecar/src/playbook-graph-run-store.test.ts \
  apps/sidecar/src/server.test.ts \
  apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Run:

```bash
bun run check
```

Dogfood:

1. Import/run SEO/GEO playbook.
2. Interrupt a read-only research branch once.
3. Confirm automatic recovery or `Retry step`.
4. Interrupt it twice.
5. Confirm user sees `Step interrupted`, not `Your review is needed`.
6. Trigger a real brief review.
7. Confirm user sees `Review needed` and `Approve brief`.

## Risks And Mitigations

**Risk:** Auto-retry repeats work with external side effects.  
**Mitigation:** Start with memo-safe deterministic nodes and read-only tool nodes only.

**Risk:** Product-state facade hides useful debug evidence.  
**Mitigation:** Keep technical summary under "View details"; do not put it in the main card.

**Risk:** Optional `productView` creates two UI paths.  
**Mitigation:** Make old raw-queue inference a short-lived compatibility fallback and remove it after dogfooding.

**Risk:** Runner-version gate blocks recoverable runs too aggressively.  
**Mitigation:** Use compatibility groups, not exact binary hashes, once the marker proves useful.

## Execution Recommendation

Implement Tasks 1-5 as the first stabilization slice. Task 6 can land in the same slice if small, but it should not block fixing the misleading recovery UI.

Use a single owner or small team:

- Contracts/projection lane: Tasks 1-3.
- UI lane: Tasks 4-5.
- Verification lane: Task 7.

Do not start the full command/effect kernel rewrite until this product-state facade is dogfooded. The rewrite should preserve this facade exactly.

## ADR

**Decision:** Stabilize playbook execution by adding a product-state facade and bounded auto-recovery before rewriting the execution kernel.

**Drivers:** User trust, reduced support/debug burden, immediate dogfooding stability, and a cleaner acceptance baseline for the future kernel.

**Alternatives considered:**

- UI-only copy patch: too shallow; internal states would keep leaking.
- Full kernel rewrite first: too risky while the visible workflow is unstable.

**Why chosen:** This creates a stable user-facing contract while keeping the implementation scope controlled.

**Consequences:** Adds a projection layer now, but that layer becomes the public contract future internals must satisfy.
