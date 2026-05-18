# Playbook Execution Stabilization Design

**Date:** 2026-05-18
**Status:** Draft
**Relationship:** Follows Slice 0 and Slice 0.5. Precedes the larger command/effect kernel rewrite.

## Problem

Playbook execution is technically more durable than it was, but the product still exposes internal engine states to end users. The latest SEO/GEO run did not fail because of the old fan-out cap; it parked one `searchSources` branch with `stale_lease`. That is a runtime ownership detail, but the UI rendered it as a review card with an `Approve` action.

This creates three product failures:

1. Users see internal recovery vocabulary instead of workflow vocabulary.
2. Safe, retryable interruptions ask the user for permission instead of recovering automatically.
3. Different execution paths can still surface different recovery states, so the same underlying event may look like review, interruption, or attention.

The stabilization goal is not to add more queue states. The goal is to put a product-facing run model between the graph engine and the UI.

## Current Evidence

- The UI maps `needs_attention` directly to user-visible copy and still mentions retry/mark-failed mechanics in `attentionEvidenceCopy` ([PlaybooksView.tsx](/Users/utpal/Code/projects/tessera/apps/desktop/ui/src/components/PlaybooksView.tsx:166)).
- `graphRunApproval` turns a `needs_attention` queue entry into a generic approval-shaped prompt with `reasonCode: "graph_needs_attention_retry"` ([PlaybooksView.tsx](/Users/utpal/Code/projects/tessera/apps/desktop/ui/src/components/PlaybooksView.tsx:894)).
- `GuidedReview` always renders the frame as "Your review is needed", "What Tessera prepared", and "What happens if you approve", even for retry/recovery situations ([PlaybooksView.tsx](/Users/utpal/Code/projects/tessera/apps/desktop/ui/src/components/PlaybooksView.tsx:2442)).
- The UI dispatch path maps the user's apparent approval to `retry_needs_attention` behind the scenes ([PlaybooksView.tsx](/Users/utpal/Code/projects/tessera/apps/desktop/ui/src/components/PlaybooksView.tsx:3591)).
- The sidecar already exposes action specs with proper labels like `Retry`, but the main guided review surface does not render from those labels consistently ([server.ts](/Users/utpal/Code/projects/tessera/apps/sidecar/src/server.ts:2446)).
- The store can auto-requeue entries when `recoveryPolicy === "rerun_if_no_success_memo"`, but entries using `block_for_review` become `needs_attention` immediately ([playbook-graph-run-store.ts](/Users/utpal/Code/projects/tessera/apps/sidecar/src/playbook-graph-run-store.ts:820)).
- Runtime status selection still promotes any queue entry with `needs_attention` to run-level `needs_attention`, without a product-level distinction between "recovering", "retry available", and "user review needed" ([playbook-graph-runtime.ts](/Users/utpal/Code/projects/tessera/packages/core/src/playbook-graph-runtime.ts:1445)).

## Decision

Add a product-facing run state facade and bounded auto-recovery before doing the larger execution-kernel rewrite.

The graph queue can keep internal statuses like `blocked`, `interrupted`, `needs_attention`, `stale_lease`, and `stale_heartbeat`, but the UI should render only product states:

- `working`
- `recovering`
- `waiting_for_review`
- `retry_available`
- `failed`
- `completed`
- `restart_required`

The sidecar becomes responsible for translating internal queue/run facts into these product states. The desktop UI stops interpreting raw queue statuses as the primary user experience.

## Principles

1. **Internal mechanics are diagnostic, not product language.** Queue status, lease state, heartbeat, runtime id, and node path belong in technical details.
2. **Safe recovery should be automatic.** A first stale lease on read-only or memo-safe work should retry without asking the user.
3. **User decisions must be semantic.** Use `Approve brief`, `Retry step`, `Continue waiting`, `Stop run`; never generic `Approve` for recovery.
4. **One visible run state wins.** The UI should not compose its own meaning from queue entries.
5. **Debug detail remains available.** Dogfooding needs evidence, but behind "View details".

## Viable Options

### Option A: UI-only copy fix

Change `GuidedReview` and `graphRunApproval` labels so recovery says "Retry step" instead of "Approve".

Pros:
- Fastest.
- Reduces the immediate confusion in the screenshot.

Cons:
- Leaves the UI interpreting engine statuses.
- Does not auto-recover safe failures.
- Same class of issue will reappear under a different internal code.

### Option B: Product-state facade plus bounded auto-recovery

Add a sidecar-derived review/view model that maps graph internals to stable user states and actions. UI renders from that model. Add limited automatic retries for safe internal interruptions.

Pros:
- Directly addresses the leak between engine and product.
- Keeps the current runtime but reduces user-visible failure rate.
- Creates a clean baseline for the future kernel rewrite.

Cons:
- Touches contracts, sidecar projection, and UI.
- Requires careful tests around retry budgets and action labels.

### Option C: Jump straight to the command/effect kernel rewrite

Replace the execution core first, and solve product-state mapping as part of the rewrite.

Pros:
- Long-term cleanest architecture.
- Could simplify ownership and resume flows in one large pass.

Cons:
- High risk while dogfooding is already unstable.
- Product confusion continues until the rewrite lands.
- The rewrite still needs a product-state contract; delaying it does not remove it.

## Chosen Option

Option B. Stabilize the product surface and auto-recovery first. Then the larger kernel rewrite can preserve the same product-state contract as an acceptance baseline.

## Product State Model

Add a derived product view to the graph run review surface:

```typescript
type PlaybookRunProductState =
  | "working"
  | "recovering"
  | "waiting_for_review"
  | "retry_available"
  | "failed"
  | "completed"
  | "restart_required";

interface PlaybookRunPrimaryAction {
  actionId: string;
  label: string;
  tone: "primary" | "secondary" | "danger";
  decision: PlaybookGraphResumeDecision["decision"];
  queueEntryId?: string;
}

interface PlaybookRunProductView {
  state: PlaybookRunProductState;
  title: string;
  message: string;
  primaryAction?: PlaybookRunPrimaryAction;
  secondaryActions: PlaybookRunPrimaryAction[];
  technicalSummary?: {
    internalStatus: string;
    attentionCode?: string;
    queueEntryId?: string;
    nodePath?: string[];
  };
}
```

The exact names can be adjusted during implementation, but the invariant should hold: the UI renders this product view first and queue internals second.

## State Mapping

- `blocked` + `humanReview` -> `waiting_for_review`
  - Copy: "Review the brief before Tessera continues."
  - Primary action: `Approve brief`, `Approve draft`, or action spec label.

- `needs_attention` with retryable internal evidence -> `retry_available`
  - Copy: "A research step was interrupted. Tessera can retry it."
  - Primary action: `Retry step`
  - No "What Tessera prepared" section.

- retryable interruption under remaining auto-retry budget -> `recovering`
  - Copy: "A step was interrupted. Tessera is retrying it."
  - No blocking user action.

- active queued/running work -> `working`
  - Copy: "Tessera is working."
  - Soft-timeout badge may appear, but not as a blocking review.

- sidecar/runtime version mismatch -> `restart_required`
  - Copy: "Restart Tessera to finish updating the playbook runner."
  - No attempt to continue old runs under a stale binary.

## Auto-Recovery Policy

Bounded automatic retry should happen before the run becomes user-blocking.

Initial policy:

- Auto-retry `stale_lease` once for `script`, `condition`, `join`, and read-only `tool` nodes.
- Auto-retry `stale_heartbeat` once for `script` and read-only `tool` nodes.
- Do not auto-retry `artifactWrite`, `humanReview`, or any write-capable tool.
- Do not auto-retry `hard_timeout` by default; surface `retry_available`.
- Preserve current memo safety: if a success memo exists, do not rerun the same side effect.
- Record each automatic retry as an operation record with a product-level reason.

Retry budget is per queue entry attempt family, not per drain tick, so a reaper loop cannot retry forever.

## Execution Ownership Direction

This stabilization slice should not fully rewrite execution ownership, but it should stop increasing ambiguity.

Rules:

- Request handlers may create/resume intent.
- The background worker/supervisor should own actual continuation whenever possible.
- Request-time `graph_run_drain` remains as a compatibility path for tests and immediate dogfooding, but the product state should not depend on whether work was drained in-request or in-background.
- A later kernel slice should collapse this into one command/effect supervisor.

## Runtime Version Gate

Add a lightweight runner version stamp:

- Sidecar exposes `playbookRunnerVersion`, derived from package/build metadata or a hard-coded runtime schema version.
- Desktop stores the runner version seen when a graph run starts.
- If a run is resumed under a different incompatible runner version, product state becomes `restart_required` or `repair_required`, not an ambiguous retry/review card.

This directly addresses the dogfooding pattern where rebuilt sidecar binaries and old live sidecars coexist.

## UI Requirements

- `GuidedReview` should become a generic `RunDecisionCard` or render from `PlaybookRunProductView`.
- The card title must be state-specific:
  - `waiting_for_review`: "Review needed"
  - `retry_available`: "Step interrupted"
  - `recovering`: "Recovering"
  - `restart_required`: "Restart required"
- The primary button must come from the sidecar action label. Do not synthesize `Approve` for all resumable states.
- "What Tessera prepared" appears only for real artifact review.
- "What happens if you approve" appears only for approval actions.
- Technical evidence moves behind "View details".

## Acceptance Criteria

1. A `stale_lease` on a safe read-only research step auto-recovers once and does not show a user decision card.
2. If auto-recovery budget is exhausted, the user sees `Step interrupted` with `Retry step`, not `Your review is needed` with `Approve`.
3. Human review still shows review-specific copy and artifact-opening affordances.
4. Raw attention codes are visible only in details, tests, logs, or debug UI.
5. Run list badges use product states, not raw graph internals.
6. A sidecar/runtime version mismatch produces `Restart required`.
7. Existing Slice 0 and Slice 0.5 tests remain green.

## Test Strategy

- Contract tests for the new product-state schema.
- Sidecar projection tests mapping:
  - human review -> `waiting_for_review`
  - stale lease under retry budget -> `recovering`
  - stale lease after retry budget -> `retry_available`
  - hard timeout -> `retry_available`
  - completed/failed -> terminal product states
- Sidecar recovery tests proving automatic retries are bounded and memo-safe.
- UI tests proving:
  - recovery card says `Step interrupted`
  - button says `Retry step`
  - review card still says `Approve brief`
  - technical codes do not appear in the main card
- Smoke dogfood:
  - import/run SEO/GEO playbook
  - interrupt one read-only research branch
  - observe automatic recovery or `Retry step`

## ADR

**Decision:** Introduce a product-facing run state facade and bounded auto-recovery before the larger execution-kernel rewrite.

**Drivers:** Reduce end-user confusion immediately, stop exposing queue internals, and create a stable product contract for the future rewrite.

**Alternatives considered:** UI-only copy fix; full kernel rewrite first.

**Why chosen:** It fixes the user-visible instability without risking a large rewrite while dogfooding is active.

**Consequences:** Contracts and review-surface projection get one more layer, but this is intentional. The layer becomes the stable interface the future kernel must preserve.

**Follow-ups:** After this lands and dogfooding stabilizes, write the Slice 1 kernel plan against the product-state contract rather than raw queue statuses.
