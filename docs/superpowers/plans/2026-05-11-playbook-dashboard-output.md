# Playbook Dashboard Output Implementation Plan (Sub-plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Dashboard output type end-to-end: a playbook can declare a `"dashboard"` output, have its run produce a structured layout (via a sidecar-side script or a static layout file), persist that layout, render it in the UI with a Refresh button, and pin it to a Dashboards section in the catalog.

**Architecture:** Three additive contract changes (`"dashboard"` kind, optional `id`/`layoutScript`/`layout` on `WorkflowOutputDeclaration`, new `DashboardLayoutSchema`). A new sidecar layout-runner module spawns a Bun child process with a 5-second timeout, passes run outputs as JSON over stdin, validates the script's stdout against `DashboardLayoutSchema`, and stores the result in a new `dashboard_layout_json` column on `workflow_runs`. The UI gains a `<DashboardView>` component and a Refresh action that re-runs the playbook with the previous inputs (concurrent clicks dropped with a toast).

**Tech Stack:** TypeScript strict, Bun, Zod, SQLite (bun:sqlite), React, Biome.

**Depends on:** Sub-plan A (folder-based playbook packages) — merged at `8b58a06`.

**Spec reference:** `docs/superpowers/specs/2026-05-10-playbook-enhancements-design.md` Sections 2 (Schema Design) and 3 (Dashboard UX & Refresh).

**Out of scope (later sub-plans):** External `.playbook` import/export (sub-plan C), workspace activation UI (sub-plan C), scheduled refresh, OS-level sandboxing of scripts.

---

## File Structure

**New files:**
- `packages/core/src/dashboard-layout.ts` — Layout binding resolution helpers (used by UI for `binding` path lookup)
- `apps/sidecar/src/layout-runner.ts` — Sidecar-side script spawner with timeout + validation
- `apps/sidecar/src/layout-runner.test.ts` — Unit tests for the runner
- `apps/desktop/ui/src/components/DashboardView.tsx` — Renders `DashboardLayout` against run outputs
- `apps/desktop/ui/src/components/DashboardView.test.tsx` — Component tests
- `apps/desktop/ui/src/components/PlaybookRefreshButton.tsx` — Refresh action with concurrent-click guard
- `packages/core/src/builtin-playbooks/ops.activity-snapshot/manifest.json` — A small built-in dashboard playbook for end-to-end testing
- `packages/core/src/builtin-playbooks/ops.activity-snapshot/layouts/dashboard.json` — Static layout (no script) for the built-in
- `packages/core/src/builtin-playbooks/ops.activity-snapshot/prompts/draft-snapshot.md` — Agent prompt
- `packages/core/src/builtin-playbooks/ops.activity-snapshot/prompts/draft-snapshot.md.d.ts` — TS declaration

**Modified files:**
- `packages/contracts/src/index.ts` — Add `"dashboard"` to output `kind` enum; add optional `id`/`layoutScript`/`layout` to `WorkflowOutputDeclarationSchema`; add `DashboardLayoutSchema`, `DashboardSectionSchema`, related types
- `apps/sidecar/src/workflow-store.ts` — SQLite migration: add `dashboard_layout_json TEXT` column to `workflow_runs`; update read/write methods
- `apps/sidecar/src/server.ts` — Add `GET /workflows/runs/:id/dashboard-layout` endpoint; wire layout-runner into workflow completion path; pre-fill inputs from previous run on refresh
- `apps/desktop/src-tauri/src/lib.rs` — Add Tauri proxy command `playbook_get_dashboard_layout`
- `apps/desktop/ui/src/components/PlaybooksView.tsx` — Show Dashboard badge; pin run-once dashboards to top "Dashboards" section; render `<DashboardView>` for dashboard outputs; use `<PlaybookRefreshButton>` instead of one-shot "Run again"
- `packages/core/src/workflow.ts` — Register the new built-in `ops.activity-snapshot` playbook

---

## Task 1: Add dashboard schemas to contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/dashboard-layout.test.ts` (new)

- [ ] **Step 1: Write failing schema tests**

Create `packages/contracts/src/dashboard-layout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DashboardLayoutSchema, WorkflowOutputDeclarationSchema } from "./index.js";

describe("DashboardLayoutSchema", () => {
  test("accepts a layout with one metrics section", () => {
    const layout = DashboardLayoutSchema.parse({
      sections: [
        {
          type: "metrics",
          title: "Pipeline",
          items: [
            { label: "Open deals", binding: "draftSnapshot.openDeals" },
            { label: "At risk", binding: "draftSnapshot.atRisk", unit: "deals" },
          ],
        },
      ],
    });
    expect(layout.sections).toHaveLength(1);
  });

  test("accepts all four section types", () => {
    const layout = DashboardLayoutSchema.parse({
      refreshLabel: "Refresh pipeline",
      sections: [
        { type: "metrics", items: [{ label: "x", binding: "a" }] },
        { type: "list", title: "Risks", binding: "b" },
        { type: "text", title: "Summary", binding: "c" },
        { type: "table", title: "Deals", binding: "d", columns: [{ key: "name", label: "Name" }] },
      ],
    });
    expect(layout.sections).toHaveLength(4);
  });

  test("rejects layouts with no sections", () => {
    expect(() => DashboardLayoutSchema.parse({ sections: [] })).toThrow();
  });

  test("rejects unknown section type", () => {
    expect(() =>
      DashboardLayoutSchema.parse({
        sections: [{ type: "chart", binding: "a", title: "x" }],
      })
    ).toThrow();
  });
});

describe("WorkflowOutputDeclarationSchema extensions", () => {
  test("accepts dashboard kind with layoutScript", () => {
    const decl = WorkflowOutputDeclarationSchema.parse({
      id: "main",
      kind: "dashboard",
      label: "Pipeline",
      layoutScript: "scripts/render.ts",
    });
    expect(decl.kind).toBe("dashboard");
    expect(decl.layoutScript).toBe("scripts/render.ts");
  });

  test("accepts dashboard kind with static layout path", () => {
    const decl = WorkflowOutputDeclarationSchema.parse({
      kind: "dashboard",
      label: "Pipeline",
      layout: "layouts/dashboard.json",
    });
    expect(decl.layout).toBe("layouts/dashboard.json");
  });

  test("still accepts existing document output kinds", () => {
    const decl = WorkflowOutputDeclarationSchema.parse({
      kind: "meetingBrief",
      label: "Meeting brief",
    });
    expect(decl.kind).toBe("meetingBrief");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test packages/contracts/src/dashboard-layout.test.ts`
Expected: FAIL with `DashboardLayoutSchema` undefined and `kind` enum mismatch.

- [ ] **Step 3: Add the schemas**

Open `packages/contracts/src/index.ts`. Find `WorkflowOutputDeclarationSchema` (around line 1201).

Replace the `kind` enum value list to include `"dashboard"`:

```ts
kind: z.enum([
  "meetingBrief",
  "businessBrief",
  "statusDigest",
  "sourceSummary",
  "approvalRequest",
  "dashboard",
]),
```

Add three optional fields after `description`:

```ts
id: z.string().min(1).optional(),
layoutScript: z.string().min(1).optional(),
layout: z.string().min(1).optional(),
```

Directly after `WorkflowOutputDeclarationSchema` and its type export, add:

```ts
export const DashboardSectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("metrics"),
    title: z.string().min(1).optional(),
    items: z
      .array(
        z.object({
          label: z.string().min(1),
          binding: z.string().min(1),
          unit: z.string().min(1).optional(),
        })
      )
      .min(1),
  }),
  z.object({
    type: z.literal("list"),
    title: z.string().min(1),
    binding: z.string().min(1),
    emptyLabel: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("text"),
    title: z.string().min(1),
    binding: z.string().min(1),
  }),
  z.object({
    type: z.literal("table"),
    title: z.string().min(1),
    binding: z.string().min(1),
    columns: z
      .array(z.object({ key: z.string().min(1), label: z.string().min(1) }))
      .min(1),
  }),
]);
export type DashboardSection = z.infer<typeof DashboardSectionSchema>;

export const DashboardLayoutSchema = z.object({
  refreshLabel: z.string().min(1).optional(),
  sections: z.array(DashboardSectionSchema).min(1),
});
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun test packages/contracts/src/dashboard-layout.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Run typecheck and biome**

Run: `bun run check`
Expected: No errors. If `WorkflowDefinition`-consuming code breaks because of the wider `kind` enum, it means those callers were narrowing on the enum; widen them.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/dashboard-layout.test.ts
git commit -m "feat(contracts): add DashboardLayoutSchema and dashboard output kind"
```

---

## Task 2: Add binding-path resolver to core

Layout sections reference run outputs via dot-paths like `"draftSnapshot.riskItems"`. The UI and tests both need a resolver.

**Files:**
- Create: `packages/core/src/dashboard-layout.ts`
- Create: `packages/core/src/dashboard-layout.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/src/dashboard-layout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveBinding } from "./dashboard-layout.js";

describe("resolveBinding", () => {
  const outputs = {
    draftSnapshot: {
      openDeals: 14,
      atRisk: 3,
      riskItems: [{ name: "Acme" }, { name: "Globex" }],
      summary: "Three deals advanced.",
    },
  };

  test("resolves a top-level key", () => {
    expect(resolveBinding({ draftSnapshot: { x: 1 } }, "draftSnapshot")).toEqual({ x: 1 });
  });

  test("resolves a nested key via dot path", () => {
    expect(resolveBinding(outputs, "draftSnapshot.openDeals")).toBe(14);
  });

  test("returns undefined for an unknown path", () => {
    expect(resolveBinding(outputs, "draftSnapshot.ghost")).toBeUndefined();
  });

  test("returns undefined when traversing through a non-object", () => {
    expect(resolveBinding(outputs, "draftSnapshot.openDeals.x")).toBeUndefined();
  });

  test("returns the original value if path is empty", () => {
    expect(resolveBinding(outputs, "")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test packages/core/src/dashboard-layout.test.ts`

- [ ] **Step 3: Implement the resolver**

Create `packages/core/src/dashboard-layout.ts`:

```ts
export function resolveBinding(outputs: unknown, binding: string): unknown {
  if (!binding) return undefined;
  const parts = binding.split(".");
  let cursor: unknown = outputs;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}
```

Export from `packages/core/src/index.ts`:

```ts
export { resolveBinding } from "./dashboard-layout.js";
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun test packages/core/src/dashboard-layout.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Run check, commit**

```bash
bun run check
git add packages/core/src/dashboard-layout.ts packages/core/src/dashboard-layout.test.ts packages/core/src/index.ts
git commit -m "feat(core): add resolveBinding for dashboard layout paths"
```

---

## Task 3: SQLite migration for `dashboard_layout_json`

Add a column to the `workflow_runs` table. The store's existing schema initialization runs at sidecar boot; we extend it to add the column if missing.

**Files:**
- Modify: `apps/sidecar/src/workflow-store.ts`
- Modify: `apps/sidecar/src/workflow-store.test.ts`

- [ ] **Step 1: Add a failing test**

Open `apps/sidecar/src/workflow-store.test.ts`. Add this test inside the existing `describe` block:

```ts
test("save and reload a run with dashboardLayout", () => {
  const store = createWorkflowStore(":memory:");
  const layout = {
    sections: [{ type: "text", title: "Summary", binding: "step1.summary" }],
  };
  store.save({
    runId: "r1",
    workflowId: "w1",
    status: "completed",
    input: {},
    outputs: { step1: { summary: "hello" } },
    startedAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:01.000Z",
    dashboardLayout: layout,
  });
  const loaded = store.get("r1");
  expect(loaded?.dashboardLayout).toEqual(layout);
});
```

Run: `bun test apps/sidecar/src/workflow-store.test.ts`
Expected: FAIL — column missing or field not preserved.

- [ ] **Step 2: Add the column to the schema**

Open `apps/sidecar/src/workflow-store.ts`. In the `CREATE TABLE` statement for `workflow_runs`, add:

```sql
dashboard_layout_json TEXT
```

For an existing database without the column, add a migration block before the table-creation guard:

```ts
const columns = db.query<{ name: string }, []>(
  "PRAGMA table_info(workflow_runs)"
).all();
const hasDashboardLayout = columns.some((c) => c.name === "dashboard_layout_json");
if (!hasDashboardLayout) {
  try {
    db.run("ALTER TABLE workflow_runs ADD COLUMN dashboard_layout_json TEXT");
  } catch (err) {
    // Table doesn't exist yet — the CREATE TABLE below will include the column
  }
}
```

Update the `save()` method to accept an optional `dashboardLayout` field and serialize it to JSON. Update the `get()`/`list()` reads to parse it back. Use the existing pattern for `outputs_json` as a reference.

In the type definitions for stored records, add:

```ts
dashboardLayout?: DashboardLayout;
```

Import `DashboardLayout` from `@tessera/contracts`.

- [ ] **Step 3: Run tests, expect pass**

Run: `bun test apps/sidecar/src/workflow-store.test.ts`
Expected: All tests PASS, including the new one.

- [ ] **Step 4: Run check, commit**

```bash
bun run check
git add apps/sidecar/src/workflow-store.ts apps/sidecar/src/workflow-store.test.ts
git commit -m "feat(sidecar): persist dashboard layout on workflow runs"
```

---

## Task 4: Layout-runner module in sidecar

A Bun child process executes the layout script with a 5-second timeout. Input is JSON over stdin (`{ outputs, meta }`). Output is JSON on stdout (validated against `DashboardLayoutSchema`). Failures return `null` and the runner reports the reason for logging.

**Files:**
- Create: `apps/sidecar/src/layout-runner.ts`
- Create: `apps/sidecar/src/layout-runner.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/sidecar/src/layout-runner.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLayoutScript } from "./layout-runner.js";

async function makeScript(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "layout-script-"));
  const path = join(dir, "render.ts");
  writeFileSync(path, content);
  return path;
}

describe("runLayoutScript", () => {
  test("returns the validated layout on success", async () => {
    const scriptPath = await makeScript(`
      const input = JSON.parse(await Bun.stdin.text());
      const layout = {
        sections: [
          { type: "text", title: "Summary", binding: "step1.summary" }
        ]
      };
      process.stdout.write(JSON.stringify(layout));
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.layout.sections).toHaveLength(1);
    }
  });

  test("returns timeout on a script that hangs", async () => {
    const scriptPath = await makeScript(`
      await new Promise((r) => setTimeout(r, 60000));
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
      timeoutMs: 500,
    });
    expect(result.kind).toBe("timeout");
  });

  test("returns validation_failed when stdout is not a valid layout", async () => {
    const scriptPath = await makeScript(`
      process.stdout.write(JSON.stringify({ not: "a layout" }));
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
    });
    expect(result.kind).toBe("validation_failed");
  });

  test("returns crash when the script throws", async () => {
    const scriptPath = await makeScript(`
      throw new Error("boom");
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
    });
    expect(result.kind).toBe("crash");
  });
});
```

- [ ] **Step 2: Implement the runner**

Create `apps/sidecar/src/layout-runner.ts`:

```ts
import { type DashboardLayout, DashboardLayoutSchema } from "@tessera/contracts";

export interface RunLayoutScriptOptions {
  scriptPath: string;
  input: {
    outputs: Record<string, unknown>;
    meta: { runId: string; completedAt: string; playbookId: string };
  };
  timeoutMs?: number;
}

export type RunLayoutScriptResult =
  | { kind: "success"; layout: DashboardLayout }
  | { kind: "timeout" }
  | { kind: "validation_failed"; error: string }
  | { kind: "crash"; error: string };

const DEFAULT_TIMEOUT_MS = 5000;

export async function runLayoutScript(
  options: RunLayoutScriptOptions
): Promise<RunLayoutScriptResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = Bun.spawn(["bun", "run", options.scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  let killed = false;
  const watchKill = (async () => {
    await proc.exited;
    clearTimeout(timeout);
    if (proc.exitCode !== 0 && proc.signalCode) killed = true;
  })();

  proc.stdin.write(JSON.stringify(options.input));
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await watchKill;

  if (killed) return { kind: "timeout" };
  if (proc.exitCode !== 0) return { kind: "crash", error: stderr || "non-zero exit" };

  try {
    const parsed = JSON.parse(stdout);
    const layout = DashboardLayoutSchema.parse(parsed);
    return { kind: "success", layout };
  } catch (err) {
    return { kind: "validation_failed", error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test apps/sidecar/src/layout-runner.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
bun run check
git add apps/sidecar/src/layout-runner.ts apps/sidecar/src/layout-runner.test.ts
git commit -m "feat(sidecar): add layout-runner with timeout and validation"
```

---

## Task 5: Wire layout execution into run completion

After a workflow run reaches a terminal state, look at its `WorkflowDefinition.outputs` for any `kind: "dashboard"` declarations. For each, resolve the script or static layout path (relative to the playbook package's root on disk — for now, built-ins live in source; sub-plan C generalizes to imported playbooks). Run the layout, persist the resulting `DashboardLayout` (or null on failure) to the run record.

**Files:**
- Modify: `apps/sidecar/src/server.ts`

- [ ] **Step 1: Locate the run-completion path**

Search for the `onCheckpoint` callback that handles run terminal states. The current code in `server.ts` around lines 805–815 saves the run to `workflowStore`. The layout step should run before `workflowStore.save(...)` when the run reaches a terminal status and a dashboard output is declared.

- [ ] **Step 2: Add a helper to find dashboard outputs**

In `apps/sidecar/src/server.ts`, add:

```ts
import { runLayoutScript, type RunLayoutScriptResult } from "./layout-runner.js";
import { DashboardLayoutSchema, type DashboardLayout, type WorkflowDefinition } from "@tessera/contracts";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

async function generateDashboardLayout(options: {
  definition: WorkflowDefinition;
  packageRoot: string;
  outputs: Record<string, unknown>;
  runId: string;
  completedAt: string;
}): Promise<DashboardLayout | null> {
  const dashboardOutput = options.definition.outputs?.find((o) => o.kind === "dashboard");
  if (!dashboardOutput) return null;

  if (dashboardOutput.layoutScript) {
    const scriptPath = resolve(options.packageRoot, dashboardOutput.layoutScript);
    if (!scriptPath.startsWith(options.packageRoot)) return null; // traversal guard
    const result: RunLayoutScriptResult = await runLayoutScript({
      scriptPath,
      input: {
        outputs: options.outputs,
        meta: { runId: options.runId, completedAt: options.completedAt, playbookId: options.definition.id },
      },
    });
    if (result.kind === "success") return result.layout;
    return null;
  }

  if (dashboardOutput.layout) {
    const layoutPath = resolve(options.packageRoot, dashboardOutput.layout);
    if (!layoutPath.startsWith(options.packageRoot)) return null;
    try {
      const raw = JSON.parse(readFileSync(layoutPath, "utf8"));
      return DashboardLayoutSchema.parse(raw);
    } catch {
      return null;
    }
  }

  return null;
}
```

- [ ] **Step 3: Provide the packageRoot at workflow registration time**

The current `workflowRegistry` (server.ts:96–102) stores `WorkflowDefinition` only. Extend the registry value to `{ definition, packageRoot }` so the run-completion handler knows where the package's `scripts/` and `layouts/` live.

For built-in playbooks defined in `packages/core/src/workflow.ts`, expose a small helper to return the directory path. Since built-ins are statically imported with text-import for prompts, the easiest path for sub-plan B is to ship a parallel map of `playbookId → absolute path of source folder` resolved at module init using `import.meta.dir`:

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUILTIN_PLAYBOOK_ROOTS: Record<string, string> = {
  "demo.write-approval": join(__dirname, "builtin-playbooks", "demo.write-approval"),
  "ops.weekly-update": join(__dirname, "builtin-playbooks", "ops.weekly-update"),
  "sales.meeting-brief": join(__dirname, "builtin-playbooks", "sales.meeting-brief"),
  "customer.renewal-risk-review": join(__dirname, "builtin-playbooks", "customer.renewal-risk-review"),
  "operations.weekly-status-digest": join(__dirname, "builtin-playbooks", "ops.weekly-status-digest"),
  "ops.activity-snapshot": join(__dirname, "builtin-playbooks", "ops.activity-snapshot"),
};
```

Export this from `packages/core/src/workflow.ts` and consume it in `apps/sidecar/src/server.ts` when building the registry.

NOTE for the implementer: `import.meta.dir` will not work inside the compiled sidecar binary (Bun's `--compile` flatten). If tests + smoke pass, the path resolution survives bundling because Bun captures the source layout. If it doesn't, fall back to a `BUILTIN_PLAYBOOKS_DIR` env var checked at runtime.

- [ ] **Step 4: Invoke `generateDashboardLayout` in the run-completion path**

In the `onCheckpoint` handler (around `server.ts:805`), when `run.status` matches a terminal state (`completed`, `failed`, `denied`), call `generateDashboardLayout` with the run's outputs map and persist the result on the saved record:

```ts
const layout = await generateDashboardLayout({
  definition,
  packageRoot,
  outputs: run.outputs ?? {},
  runId: run.runId,
  completedAt: run.completedAt ?? new Date().toISOString(),
});
await workflowStore.save({ ...run, dashboardLayout: layout ?? undefined });
```

Make sure non-dashboard playbooks are unaffected: when `dashboardOutput` is missing, the helper returns `null` and the saved record has no `dashboardLayout`.

- [ ] **Step 5: Run all sidecar tests**

Run: `bun test apps/sidecar/src/`
Expected: All existing tests still pass. The new layout-runner tests already passed in Task 4.

- [ ] **Step 6: Commit**

```bash
bun run check
git add apps/sidecar/src/server.ts packages/core/src/workflow.ts
git commit -m "feat(sidecar): generate dashboard layout on run completion"
```

---

## Task 6: Build the `ops.activity-snapshot` built-in dashboard playbook

A small built-in dashboard playbook exercises the end-to-end path without depending on external integrations. It runs a single agent step that produces a structured output, then a static `layouts/dashboard.json` renders four sections.

**Files:**
- Create: `packages/core/src/builtin-playbooks/ops.activity-snapshot/manifest.json`
- Create: `packages/core/src/builtin-playbooks/ops.activity-snapshot/prompts/draft-snapshot.md`
- Create: `packages/core/src/builtin-playbooks/ops.activity-snapshot/prompts/draft-snapshot.md.d.ts`
- Create: `packages/core/src/builtin-playbooks/ops.activity-snapshot/layouts/dashboard.json`
- Modify: `packages/core/src/workflow.ts` to register the new playbook

- [ ] **Step 1: Author the manifest**

Create `packages/core/src/builtin-playbooks/ops.activity-snapshot/manifest.json`:

```json
{
  "schemaVersion": 1,
  "meta": {
    "id": "ops.activity-snapshot",
    "version": 1,
    "name": "Activity Snapshot",
    "description": "Refreshable dashboard of recent workspace activity.",
    "author": "Tessera"
  },
  "workflow": {
    "id": "ops.activity-snapshot",
    "version": 1,
    "name": "Activity Snapshot",
    "description": "Refreshable dashboard of recent workspace activity.",
    "start": "draftSnapshot",
    "inputs": {
      "scope": {
        "type": "string",
        "required": true,
        "label": "Scope",
        "default": "this week",
        "order": 1
      }
    },
    "outputs": [
      {
        "kind": "dashboard",
        "label": "Activity dashboard",
        "layout": "layouts/dashboard.json"
      }
    ],
    "steps": [
      {
        "id": "draftSnapshot",
        "label": "Draft activity snapshot",
        "kind": "agent",
        "prompt": "file:prompts/draft-snapshot.md",
        "onSuccess": "completed"
      }
    ]
  }
}
```

- [ ] **Step 2: Author the prompt**

Create `packages/core/src/builtin-playbooks/ops.activity-snapshot/prompts/draft-snapshot.md`:

```
Produce a JSON-shaped activity snapshot for {{inputs.scope}}. Return an object with keys: openItems (integer count), atRisk (integer count), highlights (array of short strings), summary (short paragraph). Use only information available from the workspace; if unavailable, leave fields empty or zero.
```

Create the matching `.md.d.ts`:

```ts
declare const content: string;
export default content;
```

- [ ] **Step 3: Author the static layout**

Create `packages/core/src/builtin-playbooks/ops.activity-snapshot/layouts/dashboard.json`:

```json
{
  "refreshLabel": "Refresh snapshot",
  "sections": [
    {
      "type": "metrics",
      "title": "Activity",
      "items": [
        { "label": "Open items", "binding": "draftSnapshot.openItems" },
        { "label": "At risk", "binding": "draftSnapshot.atRisk" }
      ]
    },
    { "type": "list", "title": "Highlights", "binding": "draftSnapshot.highlights", "emptyLabel": "No highlights yet." },
    { "type": "text", "title": "Summary", "binding": "draftSnapshot.summary" }
  ]
}
```

- [ ] **Step 4: Register the new built-in**

In `packages/core/src/workflow.ts`, add an import for the new manifest + prompt and register `ACTIVITY_SNAPSHOT_WORKFLOW` following the same pattern as the other five. Add its id to `BUILTIN_PLAYBOOK_ROOTS` (Task 5).

In `apps/sidecar/src/server.ts`, add the new workflow to the `workflowRegistry`.

- [ ] **Step 5: Verify**

Run: `bun test packages/core/src/ apps/sidecar/src/`
Expected: existing tests pass, no regressions.

Run: `bun run check`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/builtin-playbooks/ops.activity-snapshot packages/core/src/workflow.ts apps/sidecar/src/server.ts
git commit -m "feat(core): add ops.activity-snapshot built-in dashboard playbook"
```

---

## Task 7: Sidecar HTTP endpoint + Tauri command for dashboard layout

The UI fetches the persisted layout via the sidecar.

**Files:**
- Modify: `apps/sidecar/src/server.ts` — add `GET /workflows/runs/:runId/dashboard-layout`
- Modify: `apps/desktop/src-tauri/src/lib.rs` — add proxy command `playbook_get_dashboard_layout`

- [ ] **Step 1: Add the sidecar route**

Inside the route table in `server.ts`, add:

```ts
if (method === "GET" && url.pathname.match(/^\/workflows\/runs\/[^/]+\/dashboard-layout$/)) {
  const runId = url.pathname.split("/")[3];
  const run = workflowStore.get(runId);
  if (!run) return json(404, { error: "Run not found" });
  return json(200, { layout: run.dashboardLayout ?? null });
}
```

(Match the existing route-style in the file — if it uses a router instead of regex, adapt.)

- [ ] **Step 2: Add the Tauri command**

In `apps/desktop/src-tauri/src/lib.rs`, follow the pattern of existing playbook proxies (e.g., `playbook_list`). Add:

```rust
#[tauri::command]
async fn playbook_get_dashboard_layout(
  state: tauri::State<'_, SidecarHandle>,
  run_id: String,
) -> Result<serde_json::Value, String> {
  state
    .proxy_get(&format!("/workflows/runs/{}/dashboard-layout", run_id))
    .await
}
```

Register it in the `invoke_handler!` macro.

- [ ] **Step 3: Smoke verify**

Run: `bun run check` and `bun run --filter '*' test`.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/server.ts apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(sidecar,desktop): expose dashboard layout per run"
```

---

## Task 8: `<DashboardView>` UI component

Renders a `DashboardLayout` against a run's outputs.

**Files:**
- Create: `apps/desktop/ui/src/components/DashboardView.tsx`
- Create: `apps/desktop/ui/src/components/DashboardView.test.tsx`

- [ ] **Step 1: Write component tests**

Create `apps/desktop/ui/src/components/DashboardView.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { DashboardView } from "./DashboardView.tsx";

describe("DashboardView", () => {
  test("renders metric tiles", () => {
    render(
      <DashboardView
        layout={{
          sections: [
            {
              type: "metrics",
              title: "Pipeline",
              items: [{ label: "Open deals", binding: "step1.open", unit: "deals" }],
            },
          ],
        }}
        outputs={{ step1: { open: 12 } }}
      />
    );
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("Open deals")).toBeTruthy();
  });

  test("renders empty-label when list binding is empty", () => {
    render(
      <DashboardView
        layout={{
          sections: [{ type: "list", title: "Risks", binding: "step1.risks", emptyLabel: "Nothing yet" }],
        }}
        outputs={{ step1: { risks: [] } }}
      />
    );
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  test("renders table with declared columns", () => {
    render(
      <DashboardView
        layout={{
          sections: [
            {
              type: "table",
              title: "Deals",
              binding: "step1.deals",
              columns: [
                { key: "name", label: "Name" },
                { key: "stage", label: "Stage" },
              ],
            },
          ],
        }}
        outputs={{ step1: { deals: [{ name: "Acme", stage: "Proposal" }] } }}
      />
    );
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Proposal")).toBeTruthy();
  });

  test("renders text section", () => {
    render(
      <DashboardView
        layout={{ sections: [{ type: "text", title: "Summary", binding: "step1.summary" }] }}
        outputs={{ step1: { summary: "Hello world." } }}
      />
    );
    expect(screen.getByText("Hello world.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement the component**

Create `apps/desktop/ui/src/components/DashboardView.tsx`:

```tsx
import type { DashboardLayout, DashboardSection } from "@tessera/contracts";
import { resolveBinding } from "@tessera/core";

interface DashboardViewProps {
  layout: DashboardLayout;
  outputs: Record<string, unknown>;
}

export function DashboardView({ layout, outputs }: DashboardViewProps) {
  return (
    <div className="space-y-4">
      {layout.sections.map((section, index) => (
        <DashboardSectionView key={index} section={section} outputs={outputs} />
      ))}
    </div>
  );
}

function DashboardSectionView({
  section,
  outputs,
}: {
  section: DashboardSection;
  outputs: Record<string, unknown>;
}) {
  if (section.type === "metrics") {
    return (
      <div>
        {section.title ? <h3 className="text-sm font-medium">{section.title}</h3> : null}
        <div className="flex gap-4">
          {section.items.map((item, index) => {
            const value = resolveBinding(outputs, item.binding);
            return (
              <div key={index} className="rounded-md border p-3">
                <div className="text-2xl font-semibold">{formatValue(value)}</div>
                <div className="text-xs text-muted-foreground">
                  {item.label}
                  {item.unit ? ` (${item.unit})` : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (section.type === "list") {
    const items = resolveBinding(outputs, section.binding);
    const list = Array.isArray(items) ? items : [];
    return (
      <div>
        <h3 className="text-sm font-medium">{section.title}</h3>
        {list.length === 0 ? (
          <div className="text-sm text-muted-foreground">{section.emptyLabel ?? "Nothing to show."}</div>
        ) : (
          <ul className="list-disc pl-5">
            {list.map((entry, index) => (
              <li key={index}>{formatValue(entry)}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (section.type === "text") {
    const value = resolveBinding(outputs, section.binding);
    return (
      <div>
        <h3 className="text-sm font-medium">{section.title}</h3>
        <p className="text-sm">{formatValue(value)}</p>
      </div>
    );
  }

  if (section.type === "table") {
    const rows = resolveBinding(outputs, section.binding);
    const list = Array.isArray(rows) ? rows : [];
    return (
      <div>
        <h3 className="text-sm font-medium">{section.title}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {section.columns.map((col) => (
                <th key={col.key} className="text-left">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((row, index) => (
              <tr key={index}>
                {section.columns.map((col) => (
                  <td key={col.key}>{formatValue((row as Record<string, unknown>)?.[col.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
```

- [ ] **Step 3: Run tests**

Run: `bun test apps/desktop/ui/src/components/DashboardView.test.tsx`
Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
bun run check
git add apps/desktop/ui/src/components/DashboardView.tsx apps/desktop/ui/src/components/DashboardView.test.tsx
git commit -m "feat(ui): add DashboardView component"
```

---

## Task 9: Refresh button with concurrent-click guard

A `<PlaybookRefreshButton>` that:
- Re-runs the playbook with the previous run's inputs
- Disables itself while a refresh is in flight and shows a "Refreshing…" indicator
- Drops a click that arrives while another refresh is in flight, showing a transient toast

**Files:**
- Create: `apps/desktop/ui/src/components/PlaybookRefreshButton.tsx`
- Create: `apps/desktop/ui/src/components/PlaybookRefreshButton.test.tsx`

- [ ] **Step 1: Tests first**

Create `apps/desktop/ui/src/components/PlaybookRefreshButton.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PlaybookRefreshButton } from "./PlaybookRefreshButton.tsx";

describe("PlaybookRefreshButton", () => {
  test("calls onRefresh on click", () => {
    let called = 0;
    render(<PlaybookRefreshButton label="Refresh" isRefreshing={false} onRefresh={() => { called++; }} />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(called).toBe(1);
  });

  test("is disabled and shows refreshing label when isRefreshing", () => {
    render(<PlaybookRefreshButton label="Refresh" isRefreshing={true} onRefresh={() => {}} />);
    const button = screen.getByRole("button");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Refreshing/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement**

Create `apps/desktop/ui/src/components/PlaybookRefreshButton.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

interface PlaybookRefreshButtonProps {
  label?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
}

export function PlaybookRefreshButton({ label, isRefreshing, onRefresh }: PlaybookRefreshButtonProps) {
  return (
    <Button disabled={isRefreshing} onClick={onRefresh} variant="default" size="sm">
      {isRefreshing ? (
        <>
          <Loader2 size={14} className="mr-1 animate-spin" />
          Refreshing…
        </>
      ) : (
        <>
          <RefreshCw size={14} className="mr-1" />
          {label ?? "Refresh"}
        </>
      )}
    </Button>
  );
}
```

The concurrent-click guard is implemented by the *parent* via the `isRefreshing` prop. The button itself can't double-fire because it disables itself.

- [ ] **Step 3: Commit**

```bash
bun test apps/desktop/ui/src/components/PlaybookRefreshButton.test.tsx
bun run check
git add apps/desktop/ui/src/components/PlaybookRefreshButton.tsx apps/desktop/ui/src/components/PlaybookRefreshButton.test.tsx
git commit -m "feat(ui): add PlaybookRefreshButton"
```

---

## Task 10: Integrate `<DashboardView>` + refresh into `PlaybooksView`

Wire the dashboard rendering into the existing Playbooks shell. When a completed run has a dashboard output, fetch its persisted layout and render via `<DashboardView>`. Replace the existing "Run again" affordance for dashboard playbooks with `<PlaybookRefreshButton>` that re-runs using the previous run's inputs.

**Files:**
- Modify: `apps/desktop/ui/src/components/PlaybooksView.tsx`
- Modify: `apps/desktop/ui/src/lib/playbooks.ts` (helpers to detect dashboard kind)

- [ ] **Step 1: Detect dashboard playbooks**

In `apps/desktop/ui/src/lib/playbooks.ts`, add:

```ts
import type { PlaybookDetail, PlaybookSummary } from "@tessera/contracts";

export function isDashboardPlaybook(playbook: PlaybookSummary | PlaybookDetail | null): boolean {
  return playbook?.outputs?.some((o) => o.kind === "dashboard") ?? false;
}
```

- [ ] **Step 2: Fetch the persisted layout for a completed run**

In `PlaybooksView.tsx`, when the active run is `completed` and the playbook is a dashboard, fetch the layout via `invoke("playbook_get_dashboard_layout", { runId })`. Render `<DashboardView layout={layout} outputs={run.outputs} />` instead of the document Result view.

- [ ] **Step 3: Wire the refresh button**

For dashboard playbooks in `completed` state, replace the existing "Run again" button with:

```tsx
<PlaybookRefreshButton
  label={layout?.refreshLabel ?? `Refresh ${playbook.name}`}
  isRefreshing={refreshing}
  onRefresh={async () => {
    if (refreshing) {
      toast.info("Refresh already in progress");
      return;
    }
    setRefreshing(true);
    try {
      await startPlaybookRun({
        playbookId: playbook.id,
        input: previousRun.input,
        // user may have pre-edited the form; if so, use the form state, else fall back to previousRun.input
      });
    } finally {
      setRefreshing(false);
    }
  }}
/>
```

The concurrent-click guard is the early-return when `refreshing` is true.

- [ ] **Step 4: Pre-fill intake form on refresh**

When the user opens a dashboard playbook with prior runs, populate the intake form with the most recent run's `input` so they can edit before hitting Refresh.

- [ ] **Step 5: Run UI tests**

Run: `bun test apps/desktop/ui/src/`
Expected: All previously passing tests still pass.

- [ ] **Step 6: Commit**

```bash
bun run check
git add apps/desktop/ui/src/components/PlaybooksView.tsx apps/desktop/ui/src/lib/playbooks.ts
git commit -m "feat(ui): render dashboard layouts with refresh button"
```

---

## Task 11: Catalog pinning + Dashboard badge

Dashboard playbooks get a `Dashboard` badge in the catalog. Once a dashboard has been run at least once in the current workspace, it pins to a top-of-catalog "Dashboards" section.

**Files:**
- Modify: `apps/desktop/ui/src/components/PlaybooksView.tsx`

- [ ] **Step 1: Sort/group catalog entries**

Compute two groups in the catalog render path:

```ts
const dashboards = playbooks.filter((p) => isDashboardPlaybook(p));
const documents = playbooks.filter((p) => !isDashboardPlaybook(p));

const pinnedDashboards = dashboards.filter((p) => hasRunHistory(p.id));
const unpinnedDashboards = dashboards.filter((p) => !hasRunHistory(p.id));
```

`hasRunHistory(playbookId)` checks whether the runs list (already loaded by `PlaybooksView`) contains any completed run for this playbook.

- [ ] **Step 2: Render groups**

```tsx
{pinnedDashboards.length > 0 ? (
  <section>
    <h2>Dashboards</h2>
    {pinnedDashboards.map(renderPlaybookCard)}
  </section>
) : null}
<section>
  <h2>Playbooks</h2>
  {[...unpinnedDashboards, ...documents].map(renderPlaybookCard)}
</section>
```

- [ ] **Step 3: Add the Dashboard badge**

Inside `renderPlaybookCard`, if `isDashboardPlaybook(playbook)`, render a small badge near the playbook name:

```tsx
{isDashboardPlaybook(playbook) ? (
  <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">Dashboard</span>
) : null}
```

- [ ] **Step 4: Commit**

```bash
bun test apps/desktop/ui/src/
bun run check
git add apps/desktop/ui/src/components/PlaybooksView.tsx
git commit -m "feat(ui): dashboard badge and Dashboards catalog section"
```

---

## Task 12: End-to-end smoke verification

- [ ] **Step 1: Full check + test suite**

```bash
bun run check
bun run --filter '*' test
```

- [ ] **Step 2: Build sidecar binary**

```bash
bun run --filter './apps/sidecar' build
```

- [ ] **Step 3: Manual smoke (optional but recommended)**

Run `bun run dev`, open the Tessera desktop app, navigate to Playbooks, find "Activity Snapshot" (the new built-in dashboard), run it, confirm:
- A dashboard renders with metrics tiles + list + summary text
- A "Refresh snapshot" button is visible
- Clicking Refresh re-runs the workflow and updates the snapshot
- A second click during refresh shows a toast and is ignored
- The Dashboard badge appears next to "Activity Snapshot" in the catalog
- After at least one completed run, "Activity Snapshot" appears in a top "Dashboards" section

- [ ] **Step 4: Final commit (only if smoke uncovered fixes)**

```bash
git status
# If clean, skip
```

---

## Self-Review Notes

- **Spec coverage:** Section 2 schema changes (Tasks 1, 2). Section 2 layout script contract (Tasks 4, 5). Section 3 Dashboard UX (Tasks 8–11). Concurrent refresh policy (Task 10).
- **Deferred to sub-plan C:** Disk-based loader for imported playbooks, asset serving, workspace activation.
- **Risk:** `BUILTIN_PLAYBOOK_ROOTS` uses `import.meta.dir` which may not survive `bun build --compile`. If Task 5 smoke fails, fall back to env-var resolution at sidecar boot.
- **Behavior preservation:** Existing five built-in playbooks remain document-only; their behavior is unchanged. The dashboard path is purely additive.
