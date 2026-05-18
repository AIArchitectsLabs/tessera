# Playbook Execution Slice 0.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two gaps left open by Slice 0 (live-but-stuck worker, and dependency satisfaction routed through transient queue state) so playbook runs stop hanging in `Working` forever and downstream steps cannot stall behind committed upstream artifacts.

**Architecture:** Two additive runtime changes inside the existing durable model. (A) A 10s-cadence heartbeat ticker wraps every adapter invocation; the reaper grows two new staleness predicates (`stale_heartbeat`, `hard_timeout`) on top of `stale_lease`; per-node-kind hard-timeout constants drive `needs_attention` for genuinely runaway work. (B) A new pure helper `resolveArtifactDependencies` becomes the dependency truth at scheduler-pick time, reading committed `playbook_artifact_versions` instead of relying on queue-row `artifactBindingState`. No new tables, no new IPC, no new worker process.

**Tech Stack:** TypeScript (strict), Bun, Zod (contracts), better-sqlite3 (sidecar store), React (UI).

**Spec:** `docs/superpowers/specs/2026-05-18-playbook-execution-slice-0-5-design.md`.

## Implementation Status

Implemented on 2026-05-18.

- Slice 0.5 heartbeat, soft-timeout observation, stale-heartbeat recovery, hard-timeout recovery, dependency resolution, sidecar drain wiring, and UI attention copy are implemented.
- The SEO/GEO run failure seen after import was traced to `parallelMap` treating `maxConcurrentBranches` as a total item cap. The runtime now limits total fan-out with `maxGeneratedItems` / `maxTotalBranches`, while allowing more total items than the concurrency window.
- Verified with:
  - `bun test packages/contracts/src/playbook-graph-run.test.ts packages/core/src/playbook-graph-runtime.test.ts apps/sidecar/src/playbook-graph-run-store.test.ts apps/sidecar/src/server.test.ts apps/desktop/ui/src/components/PlaybooksView.test.tsx`
  - `bun run check`
- Rebuilt packaged sidecar/CLI binaries with `bun run build:sidecar` after freeing generated Rust build output with `cargo clean`.
- Not completed here: per-task git commits and the full manual desktop dogfooding matrix in Task 13 Step 3.

---

## File Structure

**Contracts** (`packages/contracts/src/index.ts`)
- Extend `PlaybookGraphAttentionCodeSchema` with `"stale_heartbeat"` and `"hard_timeout"`.
- Extend `PlaybookGraphQueueEntrySchema` with optional `lastHeartbeatAt`.
- Extend `PlaybookGraphOperationKindSchema` with `"soft_timeout_observed"` and `"hard_timeout_observed"`.
- Tests in `packages/contracts/src/playbook-graph-run.test.ts`.

**Core runtime** (`packages/core/src/playbook-graph-runtime.ts`)
- New constants: `HEARTBEAT_STALENESS_MS`, per-node-kind soft/hard timeout matrix, heartbeat cadence default.
- New helper `withHeartbeatTicker` (nests inside `withQueueLeaseRenewal`'s `work()`) — runs a heartbeat ticker, emits one `SoftTimeoutObserved` operation record on first crossing, leaves hard-timeout enforcement to the reaper.
- New pure helper `resolveArtifactDependencies({ entry, artifactVersions }) → { runnable, missing }`.
- `GraphRunStore` interface gains `bumpHeartbeat({ runId, queueEntryId, leaseId, now })` returning `boolean`.
- `recoverStaleQueueLeases` predicate moves from "lease expired only" to "lease expired OR heartbeat stale OR hard timeout crossed". Reaper takes a `hardTimeoutMs` callback so the policy stays in core.
- Tests in `packages/core/src/playbook-graph-runtime.test.ts`.

**Sidecar store** (`apps/sidecar/src/playbook-graph-run-store.ts`)
- Forward-only schema migration adding `last_heartbeat_at TEXT` to `playbook_graph_queue` using the existing `PRAGMA table_info(...)` pattern (mirrors `apps/sidecar/src/agent-profile-store.ts:131`).
- New `bumpHeartbeat` method backed by a single conditional `UPDATE`.
- Extended `recoverStaleQueueLeases` honors the new predicates and writes `soft_timeout_observed` / `hard_timeout_observed` operation records as appropriate.
- Tests in `apps/sidecar/src/playbook-graph-run-store.test.ts`.

**Sidecar wiring** (`apps/sidecar/src/server.ts`)
- Default `leaseRenewalMs` stays where it is. Add `heartbeatMs` and timeout-matrix plumbing into `drainPlaybookGraphRun`.
- Server tests in `apps/sidecar/src/server.test.ts` get one regression for the heartbeat-stale recovery path through the HTTP/runtime stack.

**UI** (`apps/desktop/ui/src/components/PlaybooksView.tsx`)
- Step row badge "running longer than expected" when `lastHeartbeatAt` is fresh and `claimedAt` crossed the node-kind's soft-timeout threshold.
- `needs_attention` evidence panel copy distinguishes `stale_lease`, `stale_heartbeat`, `hard_timeout`.
- Tests in `apps/desktop/ui/src/components/PlaybooksView.test.tsx`.

---

## Notes for Implementers

- Operation records require `operatorIntent` (1–160 chars) and `actionSpecId` (≥1 char). For runtime-emitted timeout records, use `actionSpecId: "system.timeout.soft"` / `"system.timeout.hard"` and intents like `"Step running longer than expected"` / `"Step exceeded hard timeout"`. Status flows through as `"succeeded"` (observation never fails).
- Per Slice 0.5 spec, heartbeat itself is **not** an operation record — it is one column update per tick. Only soft/hard timeout crossings produce operation records.
- All node kinds get a heartbeat ticker except `humanReview` and `parallelMap` parent (children own their own timeouts) — see matrix in the spec.
- Per-node-kind constants live in `playbook-graph-runtime.ts` (not contracts). Per-playbook overrides are deferred to Slice 1.
- `lastHeartbeatAt` lives in both the queue row's JSON `payload` (so it round-trips through `PlaybookGraphQueueEntrySchema`) **and** in the dedicated indexed column (so reaper queries don't need to JSON-decode every row).
- The store-side `dependenciesSatisfied` (`apps/sidecar/src/playbook-graph-run-store.ts:358`) already cross-checks committed artifact versions. Slice 0.5's job is to (a) make the same logic the authoritative answer at scheduler-pick across both stores, and (b) move it into a pure helper in core that both stores call into and that the runtime can call directly before claim attempts.

---

## Task Order Rationale

Bottom-up. Contracts first (schemas types both runtime and store depend on). Pure runtime helpers next (heartbeat ticker, `resolveArtifactDependencies`). Sidecar store last (schema migration + SQL changes + reaper extension). UI badges last. Each task ships a failing test, the minimal change, a passing test, and a commit.

---

### Task 1: Contracts — extend attention codes and queue schema

**Files:**
- Modify: `packages/contracts/src/index.ts:2020-2099`
- Test: `packages/contracts/src/playbook-graph-run.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Append to `packages/contracts/src/playbook-graph-run.test.ts`:

```typescript
describe("PlaybookGraphAttentionEvidenceSchema slice-0.5 codes", () => {
  test("accepts stale_heartbeat with thresholdMs and lastHeartbeatAt", () => {
    const evidence = PlaybookGraphAttentionEvidenceSchema.parse({
      code: "stale_heartbeat",
      reason: "Heartbeat older than 45s",
      observedAt: "2026-05-18T12:00:45.000Z",
      previousQueueStatus: "running",
      thresholdMs: 45_000,
      lastHeartbeatAt: "2026-05-18T11:59:55.000Z",
      recoveryDecision: "needs_attention",
    });
    expect(evidence.code).toBe("stale_heartbeat");
    expect(evidence.thresholdMs).toBe(45_000);
  });

  test("accepts hard_timeout with thresholdMs and lastClaimedAt", () => {
    const evidence = PlaybookGraphAttentionEvidenceSchema.parse({
      code: "hard_timeout",
      reason: "Step exceeded hard timeout of 1800000ms",
      observedAt: "2026-05-18T12:30:00.000Z",
      previousQueueStatus: "running",
      thresholdMs: 1_800_000,
      lastClaimedAt: "2026-05-18T12:00:00.000Z",
      recoveryDecision: "needs_attention",
    });
    expect(evidence.code).toBe("hard_timeout");
  });
});

describe("PlaybookGraphQueueEntrySchema lastHeartbeatAt", () => {
  test("accepts optional lastHeartbeatAt", () => {
    const entry = PlaybookGraphQueueEntrySchema.parse({
      schemaVersion: 1,
      queueEntryId: "qe",
      runId: "run",
      nodeId: "n",
      nodePath: ["n"],
      nodeKind: "agent",
      status: "running",
      createdAt: "2026-05-18T12:00:00.000Z",
      updatedAt: "2026-05-18T12:00:10.000Z",
      lastHeartbeatAt: "2026-05-18T12:00:10.000Z",
    });
    expect(entry.lastHeartbeatAt).toBe("2026-05-18T12:00:10.000Z");
  });

  test("lastHeartbeatAt rejects non-datetime values", () => {
    expect(() =>
      PlaybookGraphQueueEntrySchema.parse({
        schemaVersion: 1,
        queueEntryId: "qe",
        runId: "run",
        nodeId: "n",
        nodePath: ["n"],
        nodeKind: "agent",
        status: "running",
        createdAt: "2026-05-18T12:00:00.000Z",
        updatedAt: "2026-05-18T12:00:00.000Z",
        lastHeartbeatAt: "not-a-date",
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/contracts/src/playbook-graph-run.test.ts -t "slice-0.5"`
Expected: failures referencing unknown enum values (`stale_heartbeat`, `hard_timeout`) and/or unrecognized `lastHeartbeatAt`.

- [ ] **Step 3: Extend `PlaybookGraphAttentionCodeSchema`**

In `packages/contracts/src/index.ts:2020-2027`:

```typescript
export const PlaybookGraphAttentionCodeSchema = z.enum([
  "stale_lease",
  "stale_heartbeat",
  "hard_timeout",
  "hard_timeout_observed",
  "lost_worker",
  "ambiguous_recovery",
  "manual_mark_worker_lost",
  "cancellation_requested",
]);
```

Keep existing `"hard_timeout_observed"` — it is the observation-event code; `"hard_timeout"` is the new reaper-issued recovery code distinct from it.

- [ ] **Step 4: Add `lastHeartbeatAt` to `PlaybookGraphQueueEntrySchema`**

In `packages/contracts/src/index.ts:2062-2099`, add the field between `leaseExpiresAt` and `blockedReason`:

```typescript
    leaseExpiresAt: z.string().datetime().optional(),
    lastHeartbeatAt: z.string().datetime().optional(),
    blockedReason: z.string().min(1).optional(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/contracts/src/playbook-graph-run.test.ts`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/playbook-graph-run.test.ts
git commit -m "feat(contracts): add slice-0.5 heartbeat fields and attention codes"
```

---

### Task 2: Contracts — extend operation kinds for timeout observations

**Files:**
- Modify: `packages/contracts/src/index.ts:2150-2160`
- Test: `packages/contracts/src/playbook-graph-run.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
describe("PlaybookGraphOperationKindSchema slice-0.5", () => {
  test("accepts soft_timeout_observed and hard_timeout_observed kinds", () => {
    expect(PlaybookGraphOperationKindSchema.parse("soft_timeout_observed")).toBe(
      "soft_timeout_observed"
    );
    expect(PlaybookGraphOperationKindSchema.parse("hard_timeout_observed")).toBe(
      "hard_timeout_observed"
    );
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/contracts/src/playbook-graph-run.test.ts -t "slice-0.5"`
Expected: failures on unknown enum values.

- [ ] **Step 3: Extend the enum**

In `packages/contracts/src/index.ts:2150-2159`:

```typescript
export const PlaybookGraphOperationKindSchema = z.enum([
  "resume",
  "edit_input",
  "edit_artifact",
  "edit_review",
  "retry_interrupted",
  "retry_needs_attention",
  "repair",
  "git_milestone",
  "soft_timeout_observed",
  "hard_timeout_observed",
]);
```

- [ ] **Step 4: Verify green**

Run: `bun test packages/contracts/src/playbook-graph-run.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/playbook-graph-run.test.ts
git commit -m "feat(contracts): add timeout observation operation kinds"
```

---

### Task 3: Runtime — per-node-kind timeout matrix and constants

**Files:**
- Modify: `packages/core/src/playbook-graph-runtime.ts` (top of file, near other module-scope constants around line 26-32)
- Test: `packages/core/src/playbook-graph-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/playbook-graph-runtime.test.ts`:

```typescript
import {
  HEARTBEAT_STALENESS_MS,
  hardTimeoutMs,
  softTimeoutMs,
  heartbeatCadenceMs,
} from "./playbook-graph-runtime.js";

describe("slice-0.5 timeout matrix", () => {
  test("agent has the longest soft and hard windows", () => {
    expect(softTimeoutMs("agent")).toBe(5 * 60_000);
    expect(hardTimeoutMs("agent")).toBe(30 * 60_000);
  });

  test("tool has middle window", () => {
    expect(softTimeoutMs("tool")).toBe(2 * 60_000);
    expect(hardTimeoutMs("tool")).toBe(10 * 60_000);
  });

  test("humanReview and parallelMap have no enforced timeout", () => {
    expect(softTimeoutMs("humanReview")).toBeUndefined();
    expect(hardTimeoutMs("humanReview")).toBeUndefined();
    expect(heartbeatCadenceMs("parallelMap")).toBeUndefined();
  });

  test("heartbeat staleness threshold is 45s", () => {
    expect(HEARTBEAT_STALENESS_MS).toBe(45_000);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "slice-0.5 timeout matrix"`
Expected: missing-export errors.

- [ ] **Step 3: Add the constants and accessors**

Near the top of `packages/core/src/playbook-graph-runtime.ts`, after the existing `TERMINAL_*` constants (around line 32):

```typescript
export const HEARTBEAT_STALENESS_MS = 45_000;

type TimeoutKind = PlaybookGraphQueueEntry["nodeKind"];

interface NodeKindTimeouts {
  heartbeatMs?: number;
  softMs?: number;
  hardMs?: number;
}

const NODE_KIND_TIMEOUTS: Record<TimeoutKind, NodeKindTimeouts> = {
  script: { heartbeatMs: 10_000, softMs: 30_000, hardMs: 2 * 60_000 },
  condition: { heartbeatMs: 10_000, softMs: 5_000, hardMs: 30_000 },
  join: { heartbeatMs: 10_000, softMs: 5_000, hardMs: 30_000 },
  tool: { heartbeatMs: 10_000, softMs: 2 * 60_000, hardMs: 10 * 60_000 },
  agent: { heartbeatMs: 10_000, softMs: 5 * 60_000, hardMs: 30 * 60_000 },
  artifactWrite: { heartbeatMs: 10_000, softMs: 30_000, hardMs: 2 * 60_000 },
  humanReview: {},
  parallelMap: {},
};

export function heartbeatCadenceMs(kind: TimeoutKind): number | undefined {
  return NODE_KIND_TIMEOUTS[kind].heartbeatMs;
}

export function softTimeoutMs(kind: TimeoutKind): number | undefined {
  return NODE_KIND_TIMEOUTS[kind].softMs;
}

export function hardTimeoutMs(kind: TimeoutKind): number | undefined {
  return NODE_KIND_TIMEOUTS[kind].hardMs;
}
```

- [ ] **Step 4: Verify green**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "slice-0.5 timeout matrix"`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/playbook-graph-runtime.ts packages/core/src/playbook-graph-runtime.test.ts
git commit -m "feat(core): add per-node-kind timeout matrix for slice-0.5"
```

---

### Task 4: Runtime — `bumpHeartbeat` on the store interface

**Files:**
- Modify: `packages/core/src/playbook-graph-runtime.ts` (the `GraphRunStore` interface near lines 36-110)
- Modify: `packages/core/src/playbook-graph-runtime.test.ts` (the `MemoryGraphRunStore` test double, near line 26)
- Test: `packages/core/src/playbook-graph-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe("MemoryGraphRunStore.bumpHeartbeat (test-double behavior)", () => {
  test("updates lastHeartbeatAt only when lease matches", async () => {
    const store = new MemoryGraphRunStore();
    const now = "2026-05-18T12:00:00.000Z";
    const entry: PlaybookGraphQueueEntry = {
      schemaVersion: 1,
      queueEntryId: "qe-1",
      runId: "run-1",
      nodeId: "n",
      nodePath: ["n"],
      nodeKind: "agent",
      status: "running",
      dependsOn: [],
      producesArtifacts: [],
      declaredConsumesArtifacts: [],
      consumesArtifacts: [],
      artifactBindingState: "resolved",
      recoveryPolicy: "rerun_if_no_success_memo",
      attempt: 1,
      runtimeId: "rt-1",
      leaseId: "lease-1",
      claimedAt: now,
      leaseExpiresAt: "2026-05-18T12:00:30.000Z",
      createdAt: now,
      updatedAt: now,
    };
    await store.upsertQueueEntry(entry);

    expect(
      await store.bumpHeartbeat({
        runId: "run-1",
        queueEntryId: "qe-1",
        leaseId: "lease-1",
        now: "2026-05-18T12:00:10.000Z",
      })
    ).toBe(true);

    expect((await store.getQueue("run-1"))[0].lastHeartbeatAt).toBe(
      "2026-05-18T12:00:10.000Z"
    );

    expect(
      await store.bumpHeartbeat({
        runId: "run-1",
        queueEntryId: "qe-1",
        leaseId: "lease-stale",
        now: "2026-05-18T12:00:20.000Z",
      })
    ).toBe(false);

    expect((await store.getQueue("run-1"))[0].lastHeartbeatAt).toBe(
      "2026-05-18T12:00:10.000Z"
    );
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "bumpHeartbeat"`
Expected: `store.bumpHeartbeat is not a function`.

- [ ] **Step 3: Extend `GraphRunStore`**

In `packages/core/src/playbook-graph-runtime.ts`, add to the `GraphRunStore` interface (after `renewQueueLease`):

```typescript
  bumpHeartbeat(input: {
    runId: string;
    queueEntryId: string;
    leaseId: string;
    now: string;
  }): Promise<boolean>;
```

- [ ] **Step 4: Implement in `MemoryGraphRunStore`**

In `packages/core/src/playbook-graph-runtime.test.ts`, add a method to the test double:

```typescript
  async bumpHeartbeat(input: {
    runId: string;
    queueEntryId: string;
    leaseId: string;
    now: string;
  }): Promise<boolean> {
    const entry = this.queue.get(input.queueEntryId);
    if (
      !entry ||
      entry.runId !== input.runId ||
      entry.status !== "running" ||
      entry.leaseId !== input.leaseId
    ) {
      return false;
    }
    this.queue.set(entry.queueEntryId, {
      ...entry,
      lastHeartbeatAt: input.now,
      updatedAt: input.now,
    });
    return true;
  }
```

- [ ] **Step 5: Verify green**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "bumpHeartbeat"`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/playbook-graph-runtime.ts packages/core/src/playbook-graph-runtime.test.ts
git commit -m "feat(core): add bumpHeartbeat to GraphRunStore interface"
```

---

### Task 5: Runtime — heartbeat ticker wrapping adapter invocations

**Files:**
- Modify: `packages/core/src/playbook-graph-runtime.ts` (the `withQueueLeaseRenewal` function around lines 218-261 and the adapter invocation site around lines 1594-1674)
- Test: `packages/core/src/playbook-graph-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("heartbeat ticker bumps lastHeartbeatAt while adapter runs", async () => {
  const store = new MemoryGraphRunStore();
  const run = await createPlaybookGraphRun({
    compiledGraph: compiledGraph({
      nodes: [
        {
          id: "plan",
          kind: "script",
          run: "scripts/plan.ts",
          inputs: {},
          outputArtifact: "plan",
          onSuccess: "completed",
        },
      ],
    }),
    store,
    runId: "run-hb",
    now: "2026-05-18T12:00:00.000Z",
  });

  const heartbeats: string[] = [];
  const bumpHeartbeat = store.bumpHeartbeat.bind(store);
  store.bumpHeartbeat = async (input) => {
    heartbeats.push(input.now);
    return bumpHeartbeat(input);
  };

  let tick = 0;
  const result = await drainPlaybookGraphRun({
    runId: run.runId,
    runtimeId: "rt-hb",
    store,
    leaseMs: 30_000,
    leaseRenewalMs: 5,
    heartbeatMs: 5,
    now: () => `2026-05-18T12:00:${String(tick++).padStart(2, "0")}.000Z`,
    async scriptAdapter() {
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true };
    },
  });

  expect(result.run.status).toBe("completed");
  expect(heartbeats.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "heartbeat ticker"`
Expected: failure — `heartbeatMs` not on options, no bumps recorded.

- [ ] **Step 3: Add `heartbeatMs` to `PlaybookGraphRuntimeOptions`**

In `packages/core/src/playbook-graph-runtime.ts` (the interface near line 186):

```typescript
  leaseMs?: number;
  leaseRenewalMs?: number;
  heartbeatMs?: number;
```

- [ ] **Step 4: Add `withHeartbeatTicker` helper**

After `withQueueLeaseRenewal` (around line 261):

```typescript
async function withHeartbeatTicker<T>(
  options: PlaybookGraphRuntimeOptions,
  queueEntry: PlaybookGraphQueueEntry,
  now: () => string,
  work: () => Promise<T> | T
): Promise<T> {
  const cadence = options.heartbeatMs ?? heartbeatCadenceMs(queueEntry.nodeKind);
  if (!cadence || !queueEntry.leaseId || queueEntry.status !== "running") {
    return work();
  }
  const leaseId = queueEntry.leaseId;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const at = now();
    void options.store
      .bumpHeartbeat({
        runId: queueEntry.runId,
        queueEntryId: queueEntry.queueEntryId,
        leaseId,
        now: at,
      })
      .catch(() => {
        // Heartbeat is best-effort observability; reaper is authoritative.
      });
  }, cadence);
  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}
```

- [ ] **Step 5: Wrap the adapter call site**

At lines ~1594-1674 (the existing `output = await withQueueLeaseRenewal(...)` block), nest the heartbeat ticker inside lease renewal:

```typescript
output = await withQueueLeaseRenewal(options, queueEntry, leaseMs, now, () =>
  withHeartbeatTicker(options, queueEntry, now, async () => {
    if (node.kind === "script") { /* existing body */ }
    if (node.kind === "agent")  { /* existing body */ }
    if (node.kind === "tool")   { /* existing body */ }
    // …unchanged for parallelMap, artifactWrite, condition, default…
  })
);
```

Move the existing adapter-dispatch body verbatim inside the inner closure. Do not change any adapter logic in this task.

- [ ] **Step 6: Verify green**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "heartbeat ticker"`
Expected: green. Run the full file to confirm no regressions:
Run: `bun test packages/core/src/playbook-graph-runtime.test.ts`
Expected: all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/playbook-graph-runtime.ts packages/core/src/playbook-graph-runtime.test.ts
git commit -m "feat(core): heartbeat ticker around graph adapter invocations"
```

---

### Task 6: Runtime — soft-timeout observation operation record

**Files:**
- Modify: `packages/core/src/playbook-graph-runtime.ts` (`withHeartbeatTicker`)
- Test: `packages/core/src/playbook-graph-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("soft timeout records a single observation when first crossed", async () => {
  const store = new MemoryGraphRunStore();
  const run = await createPlaybookGraphRun({
    compiledGraph: compiledGraph({
      nodes: [
        {
          id: "plan",
          kind: "script",
          run: "scripts/plan.ts",
          inputs: {},
          outputArtifact: "plan",
          onSuccess: "completed",
        },
      ],
    }),
    store,
    runId: "run-soft",
    now: "2026-05-18T12:00:00.000Z",
  });

  let tick = 0;
  const result = await drainPlaybookGraphRun({
    runId: run.runId,
    runtimeId: "rt-soft",
    store,
    leaseMs: 30_000,
    leaseRenewalMs: 5,
    heartbeatMs: 5,
    softTimeoutMs: () => 10,
    now: () =>
      `2026-05-18T12:00:${String(Math.floor(tick / 1000)).padStart(2, "0")}.${String(tick++ % 1000).padStart(3, "0")}Z`,
    async scriptAdapter() {
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true };
    },
  });
  expect(result.run.status).toBe("completed");
  const ops = await store.listOperationRecords(run.runId);
  const soft = ops.filter((op) => op.kind === "soft_timeout_observed");
  expect(soft.length).toBe(1);
  expect(soft[0].queueEntryId).toBeDefined();
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "soft timeout records"`
Expected: zero soft observations.

- [ ] **Step 3: Extend `withHeartbeatTicker` to emit one observation per crossing**

Replace `withHeartbeatTicker` from Task 5:

```typescript
async function withHeartbeatTicker<T>(
  options: PlaybookGraphRuntimeOptions,
  queueEntry: PlaybookGraphQueueEntry,
  now: () => string,
  work: () => Promise<T> | T
): Promise<T> {
  const cadence = options.heartbeatMs ?? heartbeatCadenceMs(queueEntry.nodeKind);
  const softMs =
    options.softTimeoutMs?.(queueEntry.nodeKind) ?? softTimeoutMs(queueEntry.nodeKind);
  if (!cadence || !queueEntry.leaseId || queueEntry.status !== "running") {
    return work();
  }
  const leaseId = queueEntry.leaseId;
  const claimedAtMs = queueEntry.claimedAt ? Date.parse(queueEntry.claimedAt) : Date.now();
  let stopped = false;
  let softObserved = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const at = now();
    void options.store
      .bumpHeartbeat({
        runId: queueEntry.runId,
        queueEntryId: queueEntry.queueEntryId,
        leaseId,
        now: at,
      })
      .catch(() => {});
    if (!softObserved && softMs && Date.parse(at) - claimedAtMs >= softMs) {
      softObserved = true;
      void options.store
        .addOperationRecord({
          schemaVersion: 1,
          operationRecordId: `${queueEntry.queueEntryId}:soft-timeout:v${queueEntry.attempt}`,
          operationAttemptId: `${queueEntry.queueEntryId}:soft-timeout:v${queueEntry.attempt}`,
          runId: queueEntry.runId,
          actionSpecId: "system.timeout.soft",
          kind: "soft_timeout_observed",
          status: "succeeded",
          operatorIntent: "Step running longer than expected",
          queueEntryId: queueEntry.queueEntryId,
          affectedArtifactIds: [],
          affectedReviewEventIds: [],
          affectedQueueEntryIds: [queueEntry.queueEntryId],
          createdAt: at,
          completedAt: at,
        })
        .catch(() => {});
    }
  }, cadence);
  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}
```

Add to `PlaybookGraphRuntimeOptions`:

```typescript
  softTimeoutMs?: (kind: PlaybookGraphQueueEntry["nodeKind"]) => number | undefined;
```

- [ ] **Step 4: Verify green**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "soft timeout records"`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/playbook-graph-runtime.ts packages/core/src/playbook-graph-runtime.test.ts
git commit -m "feat(core): emit soft_timeout_observed once per crossing"
```

---

### Task 7: Runtime — `resolveArtifactDependencies` pure helper

**Files:**
- Modify: `packages/core/src/playbook-graph-runtime.ts` (add helper near other artifact-resolution helpers around line 450)
- Test: `packages/core/src/playbook-graph-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { resolveArtifactDependencies } from "./playbook-graph-runtime.js";

describe("resolveArtifactDependencies", () => {
  const baseEntry = {
    schemaVersion: 1 as const,
    queueEntryId: "qe-down",
    runId: "run",
    nodeId: "down",
    nodePath: ["down"] as const,
    nodeKind: "script" as const,
    status: "queued" as const,
    dependsOn: ["qe-up"],
    producesArtifacts: [],
    declaredConsumesArtifacts: ["plan"],
    consumesArtifacts: [{ artifactId: "plan", versionId: "qe-up:plan:v1", contentHash: "h" }],
    artifactBindingState: "resolved" as const,
    recoveryPolicy: "rerun_if_no_success_memo" as const,
    attempt: 0,
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:00:00.000Z",
  };

  test("runnable when every declared consume has a committed version", () => {
    const result = resolveArtifactDependencies({
      entry: baseEntry,
      artifactVersions: [
        {
          schemaVersion: 1,
          runId: "run",
          artifactId: "plan",
          versionId: "qe-up:plan:v1",
          producerQueueEntryId: "qe-up",
          nodePath: ["up"],
          contentHash: "h",
          value: {},
          createdAt: "2026-05-18T12:00:00.000Z",
        },
      ],
    });
    expect(result.runnable).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("blocked when declared consume has no committed version", () => {
    const result = resolveArtifactDependencies({
      entry: baseEntry,
      artifactVersions: [],
    });
    expect(result.runnable).toBe(false);
    expect(result.missing.map((ref) => ref.artifactId)).toEqual(["plan"]);
  });

  test("blocked when content hash drifts", () => {
    const result = resolveArtifactDependencies({
      entry: baseEntry,
      artifactVersions: [
        {
          schemaVersion: 1,
          runId: "run",
          artifactId: "plan",
          versionId: "qe-up:plan:v1",
          producerQueueEntryId: "qe-up",
          nodePath: ["up"],
          contentHash: "other",
          value: {},
          createdAt: "2026-05-18T12:00:00.000Z",
        },
      ],
    });
    expect(result.runnable).toBe(false);
    expect(result.missing.map((ref) => ref.artifactId)).toEqual(["plan"]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "resolveArtifactDependencies"`
Expected: missing export.

- [ ] **Step 3: Implement the helper**

In `packages/core/src/playbook-graph-runtime.ts`, after `artifactBindingState` (~line 462):

```typescript
export function resolveArtifactDependencies(input: {
  entry: PlaybookGraphQueueEntry;
  artifactVersions: PlaybookGraphArtifactVersion[];
}): {
  runnable: boolean;
  missing: PlaybookGraphArtifactVersionRef[];
} {
  const { entry } = input;
  if (entry.declaredConsumesArtifacts.length === 0) {
    return { runnable: true, missing: [] };
  }
  const versionsById = new Map<string, PlaybookGraphArtifactVersion>();
  for (const version of input.artifactVersions) {
    versionsById.set(`${version.artifactId}:${version.versionId}`, version);
  }
  const missing: PlaybookGraphArtifactVersionRef[] = [];
  for (const artifactId of entry.declaredConsumesArtifacts) {
    const ref = entry.consumesArtifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!ref) {
      missing.push({ artifactId, versionId: "", contentHash: "" });
      continue;
    }
    const committed = versionsById.get(`${ref.artifactId}:${ref.versionId}`);
    if (!committed || committed.contentHash !== ref.contentHash) {
      missing.push(ref);
    }
  }
  return { runnable: missing.length === 0, missing };
}
```

- [ ] **Step 4: Verify green**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "resolveArtifactDependencies"`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/playbook-graph-runtime.ts packages/core/src/playbook-graph-runtime.test.ts
git commit -m "feat(core): add resolveArtifactDependencies pure helper"
```

---

### Task 8: Runtime — wire `resolveArtifactDependencies` into the scheduler pick

**Files:**
- Modify: `packages/core/src/playbook-graph-runtime.ts` (just before `options.store.claimNextQueuedEntry` around line 1292)
- Test: `packages/core/src/playbook-graph-runtime.test.ts`

- [ ] **Step 1: Write the failing regression test**

Mirror the structure of the existing test at `playbook-graph-runtime.test.ts:826` (`"refreshes unresolved artifact bindings before claiming dependent queued work"`):

```typescript
test("downstream stays queued for one tick when artifact commit lags, then becomes runnable", async () => {
  const store = new MemoryGraphRunStore();
  // Construct a two-node graph: upstream script "plan" → downstream script "summary"
  // where summary declares consumesArtifacts: ["plan"].
  // Seed the queue so the upstream queue entry is already marked succeeded,
  // but withhold the artifact version commit on the first drain. Assert:
  // 1) First drain pass leaves downstream entry status === "queued".
  // 2) After committing the artifact version, second drain reaches completed.
  // Use the helpers compiledGraph(), createPlaybookGraphRun(), drainPlaybookGraphRun().
  // Assert that the runtime logged the missing ref before claim was attempted.
});
```

The test must fail before Step 3 because today the runtime still routes dependency satisfaction through `artifactBindingState`; ensure your assertions check the exact state described.

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "downstream stays queued"`
Expected: the assertion that downstream remained `queued` on the first pass fails (today's behavior may either claim early or not log).

- [ ] **Step 3: Inject the resolver check at the scheduler-pick site**

In `drainPlaybookGraphRun`, immediately before `options.store.claimNextQueuedEntry(...)` (~line 1292), replace the current binding-refresh loop with the pure resolver. Read pending entries and active artifact versions once per pass, drop entries that fail `resolveArtifactDependencies`:

```typescript
const pending = await options.store.getQueue(run.runId);
const versions = activeArtifactVersions(
  await options.store.listArtifactVersions(run.runId),
  pending
);
const blocked: string[] = [];
for (const entry of pending) {
  if (entry.status !== "queued") continue;
  const { runnable, missing } = resolveArtifactDependencies({ entry, artifactVersions: versions });
  if (!runnable) {
    blocked.push(`${entry.queueEntryId}: missing ${missing.map((m) => m.artifactId).join(",")}`);
  }
}
if (blocked.length > 0) {
  options.logger?.debug?.({ runId: run.runId, blocked }, "graph.scheduler.blocked_on_artifact");
}
```

Then continue with the existing `claimNextQueuedEntry` call — the store-side `dependenciesSatisfied` already filters on committed versions, but the resolver above gives the runtime the *reason* for use in logs and (later) UI.

- [ ] **Step 4: Verify green**

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts -t "downstream stays queued"`
Expected: green. Then run the whole file:
Run: `bun test packages/core/src/playbook-graph-runtime.test.ts`
Expected: all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/playbook-graph-runtime.ts packages/core/src/playbook-graph-runtime.test.ts
git commit -m "feat(core): resolve queue dependencies from committed artifact versions"
```

---

### Task 9: Sidecar store — `last_heartbeat_at` column + migration

**Files:**
- Modify: `apps/sidecar/src/playbook-graph-run-store.ts` (schema near line 85, the `INSERT` prepared statement near line 202, the `getQueue` parse path)
- Test: `apps/sidecar/src/playbook-graph-run-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/sidecar/src/playbook-graph-run-store.test.ts`, add (use the existing fixture helper at the top of the file for store construction):

```typescript
test("bumpHeartbeat updates lastHeartbeatAt when lease matches and no-ops otherwise", async () => {
  const { store } = createTestStore();
  // Seed a run + queue entry in `running` status with leaseId "lease-A".
  expect(
    await store.bumpHeartbeat({
      runId: "run",
      queueEntryId: "qe",
      leaseId: "lease-A",
      now: "2026-05-18T12:00:10.000Z",
    })
  ).toBe(true);
  expect((await store.getQueue("run"))[0].lastHeartbeatAt).toBe("2026-05-18T12:00:10.000Z");
  expect(
    await store.bumpHeartbeat({
      runId: "run",
      queueEntryId: "qe",
      leaseId: "lease-stale",
      now: "2026-05-18T12:00:20.000Z",
    })
  ).toBe(false);
  expect((await store.getQueue("run"))[0].lastHeartbeatAt).toBe("2026-05-18T12:00:10.000Z");
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test apps/sidecar/src/playbook-graph-run-store.test.ts -t "bumpHeartbeat"`
Expected: `bumpHeartbeat is not a function`.

- [ ] **Step 3: Add the column and migration**

In `playbook-graph-run-store.ts`, after the `CREATE TABLE IF NOT EXISTS playbook_graph_queue` block (~line 97), add the conditional schema-migration pattern used by `apps/sidecar/src/agent-profile-store.ts:131-149`:

```typescript
const queueColumns = db
  .query<{ name: string }, []>("PRAGMA table_info(playbook_graph_queue)")
  .all();
if (!queueColumns.some((column) => column.name === "last_heartbeat_at")) {
  db.run("ALTER TABLE playbook_graph_queue ADD COLUMN last_heartbeat_at TEXT");
}
```

(Project convention elsewhere uses the equivalent statement-execution helper available on the existing `db` handle — match what `agent-profile-store.ts` does.)

- [ ] **Step 4: Persist and read the column**

Update the `INSERT INTO playbook_graph_queue` statement (~line 202) and the matching `UPDATE` paths to write `last_heartbeat_at` from the parsed entry's `lastHeartbeatAt`. The payload JSON already carries `lastHeartbeatAt` via the schema change in Task 1, so the read path only needs to ensure the JSON payload remains the round-trip source of truth.

- [ ] **Step 5: Implement `bumpHeartbeat`**

Add to the returned store object (alongside `renewQueueLease`):

```typescript
async bumpHeartbeat(input) {
  const result = db
    .prepare(
      `UPDATE playbook_graph_queue
         SET last_heartbeat_at = ?, updated_at = ?,
             payload = json_set(payload, '$.lastHeartbeatAt', ?)
       WHERE queue_entry_id = ? AND run_id = ? AND status = 'running' AND lease_id = ?`
    )
    .run(input.now, input.now, input.now, input.queueEntryId, input.runId, input.leaseId);
  return result.changes === 1;
},
```

- [ ] **Step 6: Verify green**

Run: `bun test apps/sidecar/src/playbook-graph-run-store.test.ts -t "bumpHeartbeat"`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/playbook-graph-run-store.ts apps/sidecar/src/playbook-graph-run-store.test.ts
git commit -m "feat(sidecar): add last_heartbeat_at column and bumpHeartbeat"
```

---

### Task 10: Sidecar store — extend `recoverStaleQueueLeases` predicate

**Files:**
- Modify: `apps/sidecar/src/playbook-graph-run-store.ts` (the `recoverStaleQueueLeases` block, ~line 781)
- Modify: `packages/core/src/playbook-graph-runtime.ts` (the `recoverStaleQueueLeases` interface input shape near line 105, and the call site in `drainPlaybookGraphRun` ~line 1256)
- Test: `apps/sidecar/src/playbook-graph-run-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
test("recoverStaleQueueLeases transitions stale-heartbeat agent step to needs_attention", async () => {
  const { store } = createTestStore();
  // Seed a running entry with leaseExpiresAt far in the future and lastHeartbeatAt 60s ago.
  const result = await store.recoverStaleQueueLeases({
    runId: "run",
    runtimeId: "rt",
    now: "2026-05-18T12:01:00.000Z",
    hardTimeoutMs: () => 30 * 60_000,
  });
  expect(result.needsAttention).toBe(1);
  const entry = (await store.getQueue("run"))[0];
  expect(entry.status).toBe("needs_attention");
  expect(entry.attentionEvidence?.code).toBe("stale_heartbeat");
  expect(entry.attentionEvidence?.thresholdMs).toBe(45_000);
});

test("recoverStaleQueueLeases transitions hard-timeout-crossed step to needs_attention and emits operation record", async () => {
  const { store } = createTestStore();
  // Seed a running agent entry where claimedAt was 31 minutes ago and heartbeats are fresh.
  const result = await store.recoverStaleQueueLeases({
    runId: "run",
    runtimeId: "rt",
    now: "2026-05-18T12:31:00.000Z",
    hardTimeoutMs: (kind) => (kind === "agent" ? 30 * 60_000 : undefined),
  });
  expect(result.needsAttention).toBe(1);
  const entry = (await store.getQueue("run"))[0];
  expect(entry.attentionEvidence?.code).toBe("hard_timeout");
  expect(entry.attentionEvidence?.thresholdMs).toBe(30 * 60_000);
  const ops = await store.listOperationRecords("run");
  expect(ops.some((op) => op.kind === "hard_timeout_observed")).toBe(true);
});

test("recoverStaleQueueLeases preserves slice-0 stale_lease path for dead workers", async () => {
  const { store } = createTestStore();
  // Seed a running entry with leaseExpiresAt in the past, no heartbeat.
  const result = await store.recoverStaleQueueLeases({
    runId: "run",
    runtimeId: "rt",
    now: "2026-05-18T12:00:35.000Z",
    hardTimeoutMs: () => 30 * 60_000,
  });
  expect(result.inspected).toBe(1);
  expect((await store.getQueue("run"))[0].attentionEvidence?.code).toBe("stale_lease");
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test apps/sidecar/src/playbook-graph-run-store.test.ts -t "recoverStaleQueueLeases"`
Expected: failures — current predicate only handles `leaseExpiresAt`.

- [ ] **Step 3: Extend the predicate**

Replace the `recoverStaleQueueLeases` body in `apps/sidecar/src/playbook-graph-run-store.ts:781-846` with the three-arm predicate:

```typescript
async recoverStaleQueueLeases(input) {
  let inspected = 0;
  let autoRequeued = 0;
  let needsAttention = 0;
  for (const entry of getQueue.all(input.runId).flatMap((row) => {
    const parsed = parseQueue(row);
    return parsed ? [parsed] : [];
  })) {
    if (entry.status !== "running") continue;

    const leaseExpired = entry.leaseExpiresAt && entry.leaseExpiresAt <= input.now;
    const heartbeatStaleMs =
      entry.lastHeartbeatAt && Date.parse(input.now) - Date.parse(entry.lastHeartbeatAt);
    const heartbeatStale =
      typeof heartbeatStaleMs === "number" && heartbeatStaleMs > 45_000;
    const hardMs = input.hardTimeoutMs?.(entry.nodeKind);
    const hardCrossed =
      typeof hardMs === "number" &&
      entry.claimedAt &&
      Date.parse(input.now) - Date.parse(entry.claimedAt) > hardMs;

    if (!leaseExpired && !heartbeatStale && !hardCrossed) continue;

    inspected += 1;

    const code = hardCrossed
      ? ("hard_timeout" as const)
      : heartbeatStale
        ? ("stale_heartbeat" as const)
        : ("stale_lease" as const);

    const thresholdMs = hardCrossed ? hardMs : heartbeatStale ? 45_000 : undefined;

    const reason =
      code === "hard_timeout"
        ? `Step exceeded hard timeout of ${hardMs}ms`
        : code === "stale_heartbeat"
          ? "Worker stopped emitting heartbeats; presumed lost"
          : "Tessera stopped while this step was running. This can happen if the app or sidecar restarted during the step.";

    const attentionEvidence = {
      code,
      reason,
      observedAt: input.now,
      previousQueueStatus: "running" as const,
      ...(entry.runtimeId ? { lastRuntimeId: entry.runtimeId } : {}),
      ...(entry.leaseId ? { lastLeaseId: entry.leaseId } : {}),
      ...(entry.claimedAt ? { lastClaimedAt: entry.claimedAt } : {}),
      ...(entry.leaseExpiresAt && leaseExpired ? { leaseExpiredAt: entry.leaseExpiresAt } : {}),
      ...(thresholdMs ? { thresholdMs } : {}),
      ...(entry.lastHeartbeatAt ? { lastHeartbeatAt: entry.lastHeartbeatAt } : {}),
      recoveryDecision:
        entry.recoveryPolicy === "rerun_if_no_success_memo"
          ? ("auto_requeued" as const)
          : ("needs_attention" as const),
    };

    if (entry.recoveryPolicy === "rerun_if_no_success_memo") {
      writeQueue({
        ...entry,
        status: "queued",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        blockedReason: undefined,
        error: undefined,
        completedAt: undefined,
        attentionEvidence,
        updatedAt: input.now,
      });
      autoRequeued += 1;
    } else {
      writeQueue({
        ...entry,
        status: "needs_attention",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        blockedReason: reason,
        error: undefined,
        completedAt: undefined,
        attentionEvidence,
        updatedAt: input.now,
      });
      needsAttention += 1;
    }

    if (code === "hard_timeout") {
      writeOperationRecord({
        schemaVersion: 1,
        operationRecordId: `${entry.queueEntryId}:hard-timeout:v${entry.attempt}`,
        operationAttemptId: `${entry.queueEntryId}:hard-timeout:v${entry.attempt}`,
        runId: entry.runId,
        actionSpecId: "system.timeout.hard",
        kind: "hard_timeout_observed",
        status: "succeeded",
        operatorIntent: "Step exceeded hard timeout",
        queueEntryId: entry.queueEntryId,
        affectedArtifactIds: [],
        affectedReviewEventIds: [],
        affectedQueueEntryIds: [entry.queueEntryId],
        createdAt: input.now,
        completedAt: input.now,
        ...(thresholdMs ? { redactedPayloadSummary: `thresholdMs=${thresholdMs}` } : {}),
      });
    }
  }
  return { inspected, autoRequeued, needsAttention, interrupted: 0 };
},
```

Add `hardTimeoutMs?: (kind: PlaybookGraphQueueEntry["nodeKind"]) => number | undefined` to the `recoverStaleQueueLeases` input shape on `GraphRunStore` (`packages/core/src/playbook-graph-runtime.ts` interface, ~line 105). Update both store implementations (`MemoryGraphRunStore` and the sidecar store) plus the call site in `drainPlaybookGraphRun` (~line 1256) to thread it. Use `hardTimeoutMs` from Task 3 as the default at the call site.

- [ ] **Step 4: Verify green**

Run: `bun test apps/sidecar/src/playbook-graph-run-store.test.ts -t "recoverStaleQueueLeases"`
Expected: all three tests green.

Run: `bun test packages/core/src/playbook-graph-runtime.test.ts apps/sidecar/src/playbook-graph-run-store.test.ts`
Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/playbook-graph-run-store.ts apps/sidecar/src/playbook-graph-run-store.test.ts packages/core/src/playbook-graph-runtime.ts packages/core/src/playbook-graph-runtime.test.ts
git commit -m "feat(sidecar): extend reaper with heartbeat-stale and hard-timeout"
```

---

### Task 11: Sidecar server — wire heartbeat defaults

**Files:**
- Modify: `apps/sidecar/src/server.ts` (the `drainPlaybookGraphRun` call sites ~lines 2622-2632 and 2801)
- Modify: `packages/core/src/index.ts` (export `softTimeoutMs` and `hardTimeoutMs` if not already exported)
- Test: `apps/sidecar/src/server.test.ts`

- [ ] **Step 1: Write the failing regression test**

Append to `apps/sidecar/src/server.test.ts` (mirror the fixture pattern at line 3402's `leaseMs: 40` test):

```typescript
test("agent that never resolves transitions to needs_attention via stale_heartbeat", async () => {
  // Start a graph runtime with an agent adapter that returns a never-resolving promise.
  // Use leaseMs and heartbeatMs small enough to cross 45_000ms equivalent under fake time
  // (or use a small softMs/hardMs override). Trigger drain, then trigger reaper
  // (recoverStaleQueueLeases) with `now` advanced past 45ms.
  // Assert the queue entry transitions to needs_attention with attentionEvidence.code === "stale_heartbeat".
  // Use a short-circuit `hardTimeoutMs: () => 10_000` to keep the stale_heartbeat branch.
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test apps/sidecar/src/server.test.ts -t "stale_heartbeat"`
Expected: failure — without heartbeat wiring, the run never transitions.

- [ ] **Step 3: Wire `heartbeatMs` and timeout callbacks into the drain calls**

In `apps/sidecar/src/server.ts` at both `drainPlaybookGraphRun` invocations (~line 2622 and 2801), pass:

```typescript
heartbeatMs: options.heartbeatMs ?? 10_000,
softTimeoutMs: (kind) => softTimeoutMs(kind),
hardTimeoutMs: (kind) => hardTimeoutMs(kind),
```

Import `softTimeoutMs` and `hardTimeoutMs` from `@tessera/core`. Re-export from `packages/core/src/index.ts` if not already exported.

- [ ] **Step 4: Verify green**

Run: `bun test apps/sidecar/src/server.test.ts -t "stale_heartbeat"`
Expected: green.

Run: `bun test apps/sidecar/src/server.test.ts`
Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/server.ts apps/sidecar/src/server.test.ts packages/core/src/index.ts
git commit -m "feat(sidecar): wire heartbeat and timeout policy into graph runs"
```

---

### Task 12: UI — soft-timeout badge and three-code attention copy

**Files:**
- Modify: `apps/desktop/ui/src/components/PlaybooksView.tsx` (step row render around line 2272 and attention evidence panel around line 836-859)
- Test: `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

- [ ] **Step 1: Write the failing tests**

```typescript
test("renders 'running longer than expected' badge when soft threshold crossed", () => {
  // Render PlaybooksView with a run whose currently-running queue entry has:
  //   status: "running"
  //   claimedAt: 6 minutes ago
  //   lastHeartbeatAt: 5 seconds ago
  //   nodeKind: "agent"  (soft threshold 5m)
  // Assert the badge text appears.
});

test("renders distinct copy for each attention code", () => {
  // Render three runs, each with attentionEvidence.code in
  // ["stale_lease", "stale_heartbeat", "hard_timeout"].
  // Assert each renders a code-specific human label.
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx -t "soft threshold"`
Expected: badge not in DOM.

Run: `bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx -t "distinct copy"`
Expected: copy mismatch.

- [ ] **Step 3: Add the badge and copy**

In `PlaybooksView.tsx` add a helper near `getDisplayStatus`:

```typescript
const NODE_KIND_SOFT_MS: Record<PlaybookGraphQueueEntry["nodeKind"], number | undefined> = {
  script: 30_000, condition: 5_000, join: 5_000,
  tool: 120_000, agent: 300_000, artifactWrite: 30_000,
  humanReview: undefined, parallelMap: undefined,
};

function softTimeoutCrossed(entry: PlaybookGraphQueueEntry, now: number): boolean {
  if (entry.status !== "running" || !entry.claimedAt) return false;
  const soft = NODE_KIND_SOFT_MS[entry.nodeKind];
  if (!soft) return false;
  return now - Date.parse(entry.claimedAt) >= soft;
}
```

Render the badge inside the step row alongside `Working`:

```tsx
{softTimeoutCrossed(entry, Date.now()) && (
  <span className="text-xs text-amber-700">Running longer than expected…</span>
)}
```

In the attention evidence panel (~line 836-859), branch on `attentionEntry.attentionEvidence?.code`:

```tsx
const attentionCopy: Record<PlaybookGraphAttentionCode, string> = {
  stale_lease:
    "Tessera lost track of this step while it was running. You can retry or mark it failed.",
  stale_heartbeat:
    "This step stopped reporting progress. It may be stuck inside a model or tool call.",
  hard_timeout:
    "This step ran longer than its hard time limit. Retry or mark failed.",
  hard_timeout_observed:
    "This step crossed its hard time limit.",
  lost_worker:
    "The worker process for this step is no longer reachable.",
  ambiguous_recovery:
    "Tessera could not determine how to recover this step automatically.",
  manual_mark_worker_lost:
    "Marked as worker lost by a user.",
  cancellation_requested:
    "Cancellation requested.",
};
```

Use it as the human label adjacent to the existing reason.

- [ ] **Step 4: Verify green**

Run: `bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/components/PlaybooksView.tsx apps/desktop/ui/src/components/PlaybooksView.test.tsx
git commit -m "feat(ui): soft-timeout badge and slice-0.5 attention copy"
```

---

### Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite called out by the spec**

```bash
bun test packages/contracts/src/playbook-graph-run.test.ts \
         packages/core/src/playbook-graph-runtime.test.ts \
         apps/sidecar/src/playbook-graph-run-store.test.ts \
         apps/sidecar/src/server.test.ts \
         apps/desktop/ui/src/components/PlaybooksView.test.tsx
```
Expected: all green.

- [ ] **Step 2: Run repo-wide check**

```bash
bun run check
```
Expected: lint, format, and tsc all clean.

- [ ] **Step 3: Manual dogfooding (sidecar + desktop)**

Start dev with `bun run dev`. Import the SEO/GEO Blog Article Reference Playbook, kick off a run, and verify the three scenarios from the spec acceptance:

1. Kill the sidecar mid-step → step surfaces with `code: "stale_lease"`.
2. Stub an adapter that sleeps 60s without writing heartbeats → step surfaces with `code: "stale_heartbeat"`.
3. Stub an agent adapter that heartbeats correctly but runs past 30m (use a temporary 30s override) → step surfaces with `code: "hard_timeout"`.

All three should reach `needs_attention` with the retry action still available.

- [ ] **Step 4: Commit the dogfooding notes if any**

If any UI copy needs tweaking based on dogfooding, fix in a follow-up commit.

---

## Acceptance Recap

1. All Slice 0 tests still green.
2. All new tests in Tasks 1–12 pass.
3. `bun run check` green.
4. Manual dogfooding hits all three timeout/lease codes.
5. No step transitions to `failed` without an adapter error or explicit user decision.
