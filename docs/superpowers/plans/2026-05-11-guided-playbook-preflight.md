# Guided Playbook Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Guided Preflight for Playbooks: users explicitly confirm or change per-node agents before the first run, reuse or change those choices later, see workflow structure before launch, and see token usage per run when providers report it.

**Architecture:** Additive contract fields carry token usage and assignment preference data. The sidecar stores workspace/playbook assignment preferences in SQLite and exposes preview/get/save commands through the existing Tauri proxy path. The frontend keeps next-run configuration in the Start state, using the existing capability inventory and `assignmentPlan` run-create field, while details/history remain secondary.

**Tech Stack:** TypeScript strict, Bun, Zod, SQLite (`bun:sqlite`), React + Vite, Tauri command proxy, Biome.

**Spec reference:** `docs/superpowers/specs/2026-05-11-playbook-run-agent-and-usage-ux-design.md`.

---

## File Structure

**New files:**
- `apps/sidecar/src/playbook-run-preferences.ts` — SQLite-backed playbook assignment preference store.
- `apps/sidecar/src/playbook-run-preferences.test.ts` — Preference persistence and validation tests.

**Modified files:**
- `packages/contracts/src/index.ts` — Add `TokenUsageSchema`, usage fields on run/step records, assignment preview/preference schemas.
- `packages/contracts/src/playbook-manifest.test.ts` — Add schema tests for usage and assignment preference contracts.
- `packages/core/src/pi-session.ts` — Extend `PiTaskTurnResult` with optional normalized usage and extract usage from Pi SDK events/final messages when available.
- `packages/core/src/workflow.ts` — Attach step usage and aggregate run usage.
- `apps/sidecar/src/playbook-routing.ts` — Export assignment preview helpers that expose recommended assignment plans and blockers.
- `apps/sidecar/src/playbook-routing.test.ts` — Cover preview output and stale preference validation behavior.
- `apps/sidecar/src/server.ts` — Wire preference store, preview/get/save endpoints, and response schemas.
- `apps/desktop/src-tauri/src/lib.rs` — Add Tauri commands for assignment preview and preference get/save.
- `apps/desktop/ui/src/components/PlaybooksView.tsx` — Add Guided Preflight workflow/agent setup UI, pass explicit assignment plan to run create, render usage.
- `apps/desktop/ui/src/components/PlaybooksView.test.tsx` — Cover first-run confirmation, changing agents, and usage rendering.

---

## Task 1: Add Contracts For Usage, Assignment Preview, And Preferences

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/playbook-manifest.test.ts`

- [ ] **Step 1: Write failing contract tests**

In `packages/contracts/src/playbook-manifest.test.ts`, replace:

```ts
import { PlaybookManifestSchema } from "./index.js";
```

with:

```ts
import {
  PlaybookAssignmentPreviewResultSchema,
  PlaybookManifestSchema,
  PlaybookRunPreferenceSchema,
  TokenUsageSchema,
  WorkflowRunResultSchema,
  WorkflowRunStepRecordSchema,
} from "./index.js";
```

Then append these tests to the file:

```ts

test("accepts token usage on workflow steps and run results", () => {
  const usage = TokenUsageSchema.parse({
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    cachedInputTokens: 200,
    reasoningTokens: 25,
  });

  expect(usage.totalTokens).toBe(1540);

  const step = WorkflowRunStepRecordSchema.parse({
    id: "draftBrief",
    label: "Draft meeting brief",
    kind: "agent",
    phase: "Prepare",
    status: "succeeded",
    usage,
  });
  expect(step.usage?.inputTokens).toBe(1200);

  const run = WorkflowRunResultSchema.parse({
    runId: "run-usage",
    workflowId: "sales.meeting-brief",
    status: "completed",
    input: {},
    sourceGaps: [],
    usage,
    steps: [step],
  });
  expect(run.usage?.outputTokens).toBe(340);
});

test("accepts playbook assignment preview and preference contracts", () => {
  const assignmentPlan = {
    resolverVersion: 1,
    createdAt: "2026-05-11T00:00:00.000Z",
    assignments: {
      draftBrief: {
        stepId: "draftBrief",
        agentId: "default",
        agentLabel: "Tessera",
        skillCapabilities: [],
        toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
        integrationCapabilities: [],
      },
    },
  };

  const preview = PlaybookAssignmentPreviewResultSchema.parse({
    assignmentPlan,
    confirmationRequired: true,
    blockers: [],
    sourceGaps: [],
    nodePreviews: [
      {
        stepId: "draftBrief",
        stepLabel: "Draft meeting brief",
        kind: "agent",
        recommendedAgentId: "default",
        recommendedAgentLabel: "Tessera",
        candidates: [
          {
            agentId: "default",
            agentLabel: "Tessera",
            assignment: assignmentPlan.assignments.draftBrief,
            recommended: true,
            disabled: false,
          },
        ],
      },
    ],
  });
  expect(preview.confirmationRequired).toBe(true);

  const preference = PlaybookRunPreferenceSchema.parse({
    workspaceRoot: "/tmp/workspace",
    playbookId: "sales.meeting-brief",
    assignmentPlan,
    updatedAt: "2026-05-11T00:00:00.000Z",
  });
  expect(preference.playbookId).toBe("sales.meeting-brief");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/contracts/src/playbook-manifest.test.ts`

Expected: failure because `TokenUsageSchema`, `PlaybookAssignmentPreviewResultSchema`, and `PlaybookRunPreferenceSchema` are not exported.

- [ ] **Step 3: Add usage schemas**

In `packages/contracts/src/index.ts`, add this after `WorkflowRunEventSchema`:

```ts
export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
```

Then add `usage: TokenUsageSchema.optional(),` to both `WorkflowRunStepRecordSchema` and `WorkflowRunResultSchema`.

- [ ] **Step 4: Add assignment preview and preference schemas**

In `packages/contracts/src/index.ts`, directly after `WorkflowRunAssignmentPlanSchema`, add:

```ts
export const PlaybookAssignmentCandidateSchema = z
  .object({
    agentId: z.string().min(1),
    agentLabel: z.string().min(1),
    assignment: WorkflowNodeAssignmentSchema,
    recommended: z.boolean().default(false),
    disabled: z.boolean().default(false),
    reason: z.string().min(1).optional(),
  })
  .strict();
export type PlaybookAssignmentCandidate = z.infer<typeof PlaybookAssignmentCandidateSchema>;

export const PlaybookAssignmentNodePreviewSchema = z
  .object({
    stepId: z.string().min(1),
    stepLabel: z.string().min(1),
    kind: z.enum(["agent", "tool"]),
    recommendedAgentId: z.string().min(1).optional(),
    recommendedAgentLabel: z.string().min(1).optional(),
    candidates: z.array(PlaybookAssignmentCandidateSchema).default([]),
    blocker: WorkflowSourceGapSchema.optional(),
  })
  .strict();
export type PlaybookAssignmentNodePreview = z.infer<typeof PlaybookAssignmentNodePreviewSchema>;

export const PlaybookAssignmentPreviewRequestSchema = z
  .object({
    playbookId: z.string().min(1),
    workspaceRoot: z.string().min(1).optional(),
    capabilityInventory: WorkflowCapabilityInventorySchema.optional(),
    previousPlan: WorkflowRunAssignmentPlanSchema.optional(),
  })
  .strict();
export type PlaybookAssignmentPreviewRequest = z.infer<
  typeof PlaybookAssignmentPreviewRequestSchema
>;

export const PlaybookAssignmentPreviewResultSchema = z
  .object({
    assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
    confirmationRequired: z.boolean(),
    blockers: z.array(WorkflowSourceGapSchema).default([]),
    sourceGaps: z.array(WorkflowSourceGapSchema).default([]),
    nodePreviews: z.array(PlaybookAssignmentNodePreviewSchema).default([]),
  })
  .strict();
export type PlaybookAssignmentPreviewResult = z.infer<
  typeof PlaybookAssignmentPreviewResultSchema
>;

export const PlaybookRunPreferenceSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    playbookId: z.string().min(1),
    assignmentPlan: WorkflowRunAssignmentPlanSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PlaybookRunPreference = z.infer<typeof PlaybookRunPreferenceSchema>;

export const PlaybookRunPreferenceReadResultSchema = z
  .object({
    preference: PlaybookRunPreferenceSchema.optional(),
  })
  .strict();
export type PlaybookRunPreferenceReadResult = z.infer<
  typeof PlaybookRunPreferenceReadResultSchema
>;
```

- [ ] **Step 5: Run contract tests**

Run: `bun test packages/contracts/src/playbook-manifest.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/playbook-manifest.test.ts
git commit -m "feat: add playbook preflight contracts" \
  -m "Add additive schemas for token usage, assignment previews, and workspace-scoped playbook run preferences." \
  -m "Constraint: Existing workflow run payloads must remain valid" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: bun test packages/contracts/src/playbook-manifest.test.ts"
```

---

## Task 2: Store And Preview Playbook Assignment Preferences

**Files:**
- Create: `apps/sidecar/src/playbook-run-preferences.ts`
- Create: `apps/sidecar/src/playbook-run-preferences.test.ts`
- Modify: `apps/sidecar/src/playbook-routing.ts`
- Modify: `apps/sidecar/src/playbook-routing.test.ts`
- Modify: `apps/sidecar/src/server.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write preference store tests**

Create `apps/sidecar/src/playbook-run-preferences.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createPlaybookRunPreferenceStore } from "./playbook-run-preferences.js";

const tempDirs: string[] = [];

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-playbook-pref-"));
  tempDirs.push(dir);
  return join(dir, "workflow.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createPlaybookRunPreferenceStore", () => {
  test("saves and loads a workspace/playbook assignment preference", () => {
    const store = createPlaybookRunPreferenceStore(tempDb());
    const assignmentPlan = {
      resolverVersion: 1,
      createdAt: "2026-05-11T00:00:00.000Z",
      assignments: {
        draftBrief: {
          stepId: "draftBrief",
          agentId: "default",
          agentLabel: "Tessera",
          skillCapabilities: [],
          toolCapabilities: ["tool.workspace.read"],
          integrationCapabilities: [],
        },
      },
    };

    store.save({
      workspaceRoot: "/tmp/workspace",
      playbookId: "sales.meeting-brief",
      assignmentPlan,
      updatedAt: "2026-05-11T01:00:00.000Z",
    });

    const loaded = store.get("/tmp/workspace", "sales.meeting-brief");
    expect(loaded?.assignmentPlan.assignments.draftBrief?.agentId).toBe("default");
    store.close();
  });

  test("keeps preferences scoped by workspace and playbook", () => {
    const store = createPlaybookRunPreferenceStore(tempDb());
    const base = {
      resolverVersion: 1,
      createdAt: "2026-05-11T00:00:00.000Z",
      assignments: {},
    };
    store.save({
      workspaceRoot: "/tmp/a",
      playbookId: "sales.meeting-brief",
      assignmentPlan: base,
      updatedAt: "2026-05-11T01:00:00.000Z",
    });
    expect(store.get("/tmp/b", "sales.meeting-brief")).toBeUndefined();
    expect(store.get("/tmp/a", "ops.activity-snapshot")).toBeUndefined();
    store.close();
  });
});
```

- [ ] **Step 2: Run preference tests and confirm failure**

Run: `bun test apps/sidecar/src/playbook-run-preferences.test.ts`

Expected: failure because `playbook-run-preferences.ts` does not exist.

- [ ] **Step 3: Implement the preference store**

Create `apps/sidecar/src/playbook-run-preferences.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type PlaybookRunPreference,
  PlaybookRunPreferenceSchema,
} from "@tessera/contracts";

interface PreferenceRow {
  payload: string;
}

export interface PlaybookRunPreferenceStore {
  close(): void;
  get(workspaceRoot: string, playbookId: string): PlaybookRunPreference | undefined;
  save(preference: PlaybookRunPreference): void;
}

export function createPlaybookRunPreferenceStore(dbPath: string): PlaybookRunPreferenceStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_run_preferences (
      workspace_root TEXT NOT NULL,
      playbook_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_root, playbook_id)
    )
  `);

  const getPreference = db.prepare<PreferenceRow, [string, string]>(
    "SELECT payload FROM playbook_run_preferences WHERE workspace_root = ? AND playbook_id = ?"
  );
  const savePreference = db.prepare(`
    INSERT INTO playbook_run_preferences (workspace_root, playbook_id, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_root, playbook_id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);

  return {
    close() {
      db.close();
    },
    get(workspaceRoot, playbookId) {
      const row = getPreference.get(workspaceRoot, playbookId);
      if (!row) return undefined;
      return PlaybookRunPreferenceSchema.parse(JSON.parse(row.payload));
    },
    save(preference) {
      const parsed = PlaybookRunPreferenceSchema.parse(preference);
      savePreference.run(
        parsed.workspaceRoot,
        parsed.playbookId,
        JSON.stringify(parsed),
        parsed.updatedAt
      );
    },
  };
}
```

- [ ] **Step 4: Add assignment preview helper tests**

Append to `apps/sidecar/src/playbook-routing.test.ts`:

```ts
test("builds a playbook assignment preview requiring confirmation", () => {
  const definition = {
    id: "playbook.preflight",
    version: 1,
    name: "Preflight",
    start: "draft",
    inputs: {},
    requiredCapabilities: [],
    optionalCapabilities: [],
    steps: [
      {
        id: "draft",
        kind: "agent",
        label: "Draft",
        phase: "Prepare",
        prompt: "Draft",
        workspaceRootInput: "workspaceRoot",
      },
    ],
  } as const;
  const inventory = buildLocalPlaybookCapabilityInventory([
    {
      id: "default",
      name: "Tessera",
      model: { mode: "default" },
      instructions: "",
      soul: "",
      userContext: "",
      skills: [],
      toolPolicyPreset: "workspace_editor",
      memoryDefaults: "",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
    },
  ]);

  const preview = createPlaybookAssignmentPreview({
    definition,
    capabilityInventory: inventory,
  });

  expect(preview.confirmationRequired).toBe(true);
  expect(preview.nodePreviews[0]?.recommendedAgentId).toBe("default");
  expect(preview.assignmentPlan?.assignments.draft?.agentId).toBe("default");
});
```

- [ ] **Step 5: Export `createPlaybookAssignmentPreview`**

In `apps/sidecar/src/playbook-routing.ts`, export this function near `resolvePlaybookExecutionContext`:

```ts
export function createPlaybookAssignmentPreview(options: {
  definition: WorkflowDefinition;
  capabilityInventory: WorkflowCapabilityInventory;
  previousPlan?: WorkflowRunAssignmentPlan;
}): PlaybookAssignmentPreviewResult {
  try {
    const resolved = resolvePlaybookExecutionContext({
      definition: options.definition,
      capabilityInventory: options.capabilityInventory,
      assignmentPlan: options.previousPlan,
    });
    return PlaybookAssignmentPreviewResultSchema.parse({
      assignmentPlan: resolved.assignmentPlan,
      confirmationRequired: true,
      blockers: [],
      sourceGaps: resolved.sourceGaps,
      nodePreviews: options.definition.steps.map((step) => {
        const assignment = resolved.assignmentPlan.assignments[step.id];
        return {
          stepId: step.id,
          stepLabel: step.label ?? step.id,
          kind: step.kind,
          ...(assignment?.agentId ? { recommendedAgentId: assignment.agentId } : {}),
          ...(assignment?.agentLabel ? { recommendedAgentLabel: assignment.agentLabel } : {}),
          candidates: assignment?.agentId
            ? [
                {
                  agentId: assignment.agentId,
                  agentLabel: assignment.agentLabel ?? assignment.agentId,
                  assignment,
                  recommended: true,
                  disabled: false,
                },
              ]
            : [],
        };
      }),
    });
  } catch (error) {
    return PlaybookAssignmentPreviewResultSchema.parse({
      confirmationRequired: true,
      blockers: [
        {
          stepId: options.definition.start,
          kind: "model",
          capability: "model.reasoning",
          optional: false,
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
      sourceGaps: [],
      nodePreviews: [],
    });
  }
}
```

Import `PlaybookAssignmentPreviewResult`, `PlaybookAssignmentPreviewResultSchema`, and existing types from `@tessera/contracts`.

- [ ] **Step 6: Wire sidecar endpoints**

In `apps/sidecar/src/server.ts`:

1. Import `PlaybookAssignmentPreviewRequestSchema`, `PlaybookRunPreferenceReadResultSchema`, `PlaybookRunPreferenceSchema`.
2. Import `createPlaybookRunPreferenceStore`.
3. Instantiate `const playbookPreferenceStore = createPlaybookRunPreferenceStore(WORKFLOW_DB_PATH);`.
4. Close it in the shutdown handler.
5. Add handlers for:

```ts
async function handlePlaybookAssignmentPreview(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const definition = workflowDefinition(playbookId);
  if (!definition) return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  const body = await req.json();
  const parsed = PlaybookAssignmentPreviewRequestSchema.parse({ ...body, playbookId });
  const preview = createPlaybookAssignmentPreview({
    definition,
    capabilityInventory: parsed.capabilityInventory ?? buildLocalPlaybookCapabilityInventory(agentProfileStore.list()),
    ...(parsed.previousPlan ? { previousPlan: parsed.previousPlan } : {}),
  });
  return Response.json(preview);
}

async function handlePlaybookRunPreferenceGet(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = await req.json();
  const workspaceRoot = typeof body.workspaceRoot === "string" ? body.workspaceRoot : "";
  if (!workspaceRoot) return Response.json({ error: "Missing workspaceRoot" }, { status: 400 });
  return Response.json(
    PlaybookRunPreferenceReadResultSchema.parse({
      preference: playbookPreferenceStore.get(workspaceRoot, playbookId),
    })
  );
}

async function handlePlaybookRunPreferenceSave(req: Request, playbookId: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = await req.json();
  const preference = PlaybookRunPreferenceSchema.parse({ ...body, playbookId });
  const definition = workflowDefinition(playbookId);
  if (!definition) return Response.json({ error: "Unknown playbook id" }, { status: 404 });
  resolvePlaybookExecutionState({
    definition,
    capabilityInventory: buildLocalPlaybookCapabilityInventory(agentProfileStore.list()),
    assignmentPlan: preference.assignmentPlan,
  });
  playbookPreferenceStore.save(preference);
  return Response.json({ preference });
}
```

Use the existing router style in `server.ts` to mount:

- `POST /playbooks/:id/assignment-preview`
- `POST /playbooks/:id/run-preference/get`
- `POST /playbooks/:id/run-preference/save`

- [ ] **Step 7: Add Tauri commands**

In `apps/desktop/src-tauri/src/lib.rs`, mirror the existing `playbook_run_create`
proxy style. Add:

```rust
#[tauri::command]
async fn playbook_assignment_preview(
    state: State<'_, SidecarHandle>,
    playbook_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let body = request.to_string();
    let path = format!(
        "/playbooks/{}/assignment-preview",
        percent_encode(&playbook_id)
    );
    let json = state.post(&path, &body).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}
```

Add matching `playbook_run_preference_get` and `playbook_run_preference_save`
commands that use the same `state.post` pattern with these paths:

```rust
format!("/playbooks/{}/run-preference/get", percent_encode(&playbook_id))
format!("/playbooks/{}/run-preference/save", percent_encode(&playbook_id))
```

Register all three in `invoke_handler`.

- [ ] **Step 8: Run sidecar tests**

Run:

```bash
bun test apps/sidecar/src/playbook-run-preferences.test.ts apps/sidecar/src/playbook-routing.test.ts
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/sidecar/src/playbook-run-preferences.ts apps/sidecar/src/playbook-run-preferences.test.ts apps/sidecar/src/playbook-routing.ts apps/sidecar/src/playbook-routing.test.ts apps/sidecar/src/server.ts apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add playbook assignment preflight API" \
  -m "Persist workspace-scoped playbook assignment preferences and expose assignment preview/get/save commands for Guided Preflight." \
  -m "Constraint: Preferences must not store credentials" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: bun test apps/sidecar/src/playbook-run-preferences.test.ts apps/sidecar/src/playbook-routing.test.ts"
```

---

## Task 3: Capture And Persist Token Usage

**Files:**
- Modify: `packages/core/src/pi-session.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/workflow.test.ts` or existing workflow tests that exercise agent runs

- [ ] **Step 1: Extend `PiTaskTurnResult` test coverage**

Find the workflow test that stubs `agentRunner` in `packages/core/src/workflow.test.ts`. Add an assertion that a runner result with usage appears on the step and the run:

```ts
const result = await runWorkflow({
  definition,
  cli,
  input: { workspaceRoot },
  agentRunner: async () => ({
    text: "Draft complete",
    boundaryViolations: 0,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }),
});

expect(result.steps?.find((step) => step.id === "draft")?.usage).toEqual({
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
});
expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
```

- [ ] **Step 2: Run the workflow test and confirm failure**

Run: `bun test packages/core/src/workflow.test.ts`

Expected: failure because `usage` is not included in `PiTaskTurnResult` and workflow results.

- [ ] **Step 3: Extend result type and normalize usage**

In `packages/core/src/pi-session.ts`, change:

```ts
export interface PiTaskTurnResult {
  text: string;
  boundaryViolations: number;
  usage?: TokenUsage;
}
```

Import `type TokenUsage` from `@tessera/contracts`.

Add a small helper:

```ts
function usageFromUnknown(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = record.inputTokens ?? record.input_tokens ?? record.prompt_tokens;
  const outputTokens = record.outputTokens ?? record.output_tokens ?? record.completion_tokens;
  const totalTokens = record.totalTokens ?? record.total_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: typeof totalTokens === "number" ? totalTokens : inputTokens + outputTokens,
    ...(typeof record.cachedInputTokens === "number"
      ? { cachedInputTokens: record.cachedInputTokens }
      : {}),
    ...(typeof record.reasoningTokens === "number" ? { reasoningTokens: record.reasoningTokens } : {}),
  };
}
```

Inside `runPiTaskTurn`, track the latest usage event from SDK messages by calling `usageFromUnknown` on event/message objects where the SDK exposes usage. Return `{ text, boundaryViolations, ...(usage ? { usage } : {}) }`.

- [ ] **Step 4: Aggregate usage in workflow execution**

In `packages/core/src/workflow.ts`, import `type TokenUsage`. Add:

```ts
function sumUsage(values: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const reported = values.filter((value): value is TokenUsage => Boolean(value));
  if (reported.length === 0) return undefined;
  return {
    inputTokens: reported.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: reported.reduce((sum, value) => sum + value.outputTokens, 0),
    totalTokens: reported.reduce((sum, value) => sum + value.totalTokens, 0),
    cachedInputTokens: reported.reduce((sum, value) => sum + (value.cachedInputTokens ?? 0), 0),
    reasoningTokens: reported.reduce((sum, value) => sum + (value.reasoningTokens ?? 0), 0),
  };
}
```

When an agent step succeeds, add `usage: result.usage` to the `markStep` patch only when `result.usage` exists.

Where final, blocked, denied, or failed run objects are returned, include `usage: sumUsage(steps.map((step) => step.usage))` when defined.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test packages/core/src/workflow.test.ts packages/contracts/src/playbook-manifest.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pi-session.ts packages/core/src/workflow.ts packages/core/src/workflow.test.ts
git commit -m "feat: track playbook token usage" \
  -m "Normalize provider-reported token usage into workflow step and run records so Playbook runs can display input, output, and total tokens." \
  -m "Constraint: Providers may omit usage, so missing usage remains undefined rather than estimated" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: bun test packages/core/src/workflow.test.ts packages/contracts/src/playbook-manifest.test.ts"
```

---

## Task 4: Build Guided Preflight In The Playbooks UI

**Files:**
- Modify: `apps/desktop/ui/src/components/PlaybooksView.tsx`
- Modify: `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

- [ ] **Step 1: Add UI tests for first-run preflight**

In `apps/desktop/ui/src/components/PlaybooksView.test.tsx`, update the mock `playbook.steps` to include an agent step:

```ts
steps: [
  {
    id: "draftBrief",
    kind: "agent",
    label: "Draft meeting brief",
    phase: "Prepare",
    prompt: "Draft",
    workspaceRootInput: "workspaceRoot",
  },
],
```

Extend the mock `invoke` with:

```ts
case "playbook_run_preference_get":
  return { preference: undefined };
case "playbook_assignment_preview":
  return {
    confirmationRequired: true,
    blockers: [],
    sourceGaps: [],
    assignmentPlan: {
      resolverVersion: 1,
      createdAt: "2026-05-11T00:00:00.000Z",
      assignments: {
        draftBrief: {
          stepId: "draftBrief",
          agentId: "default",
          agentLabel: "Tessera",
          skillCapabilities: [],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
          integrationCapabilities: [],
        },
      },
    },
    nodePreviews: [
      {
        stepId: "draftBrief",
        stepLabel: "Draft meeting brief",
        kind: "agent",
        recommendedAgentId: "default",
        recommendedAgentLabel: "Tessera",
        candidates: [
          {
            agentId: "default",
            agentLabel: "Tessera",
            recommended: true,
            disabled: false,
            assignment: {
              stepId: "draftBrief",
              agentId: "default",
              agentLabel: "Tessera",
              skillCapabilities: [],
              toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
              integrationCapabilities: [],
            },
          },
        ],
      },
    ],
  };
case "playbook_run_preference_save":
  return { preference: args };
```

Add this test:

```ts
test("requires first-run agent confirmation before starting a playbook", async () => {
  const view = renderPlaybooksView();

  await waitFor(() => {
    expect(view.getByText("Before you run")).toBeTruthy();
    expect(view.getByText("Draft meeting brief")).toBeTruthy();
    expect(view.getByText(/Tessera/)).toBeTruthy();
  });

  const runButton = view.getByRole("button", { name: /Prepare brief/i });
  expect(runButton.hasAttribute("disabled")).toBe(true);

  fireEvent.click(view.getByRole("button", { name: /Confirm agents/i }));

  await waitFor(() => {
    expect(runButton.hasAttribute("disabled")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the UI test and confirm failure**

Run: `bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx`

Expected: failure because the preflight UI and commands are not implemented.

- [ ] **Step 3: Add preflight state and loading**

In `PlaybooksView.tsx`, import the new contract types:

```ts
PlaybookAssignmentPreviewResult,
PlaybookRunPreferenceReadResult,
WorkflowRunAssignmentPlan,
TokenUsage,
```

Add state:

```ts
const [assignmentPreview, setAssignmentPreview] =
  useState<PlaybookAssignmentPreviewResult | null>(null);
const [draftAssignmentPlan, setDraftAssignmentPlan] = useState<WorkflowRunAssignmentPlan | null>(null);
const [agentsConfirmed, setAgentsConfirmed] = useState(false);
```

Add an effect that loads preference and preview whenever `selectedPlaybookId`, `workspaceRoot`, and `capabilityInventory` are ready:

```ts
useEffect(() => {
  if (!selectedPlaybookId || !workspaceRoot || !capabilityInventory) return;
  let cancelled = false;
  async function loadPreflight() {
    const preference = await invoke<PlaybookRunPreferenceReadResult>("playbook_run_preference_get", {
      playbookId: selectedPlaybookId,
      request: { workspaceRoot },
    });
    const preview = await invoke<PlaybookAssignmentPreviewResult>("playbook_assignment_preview", {
      playbookId: selectedPlaybookId,
      request: {
        workspaceRoot,
        capabilityInventory,
        previousPlan: preference.preference?.assignmentPlan,
      },
    });
    if (cancelled) return;
    setAssignmentPreview(preview);
    setDraftAssignmentPlan(preview.assignmentPlan ?? preference.preference?.assignmentPlan ?? null);
    setAgentsConfirmed(Boolean(preference.preference && preview.blockers.length === 0));
  }
  void loadPreflight().catch((error) => setSetupError(error instanceof Error ? error.message : String(error)));
  return () => {
    cancelled = true;
  };
}, [capabilityInventory, selectedPlaybookId, workspaceRoot]);
```

- [ ] **Step 4: Add preflight rendering**

Create a `GuidedPreflight` component inside `PlaybooksView.tsx` near `GuidedStart`:

```tsx
function GuidedPreflight({
  preview,
  confirmed,
  onConfirm,
}: {
  preview: PlaybookAssignmentPreviewResult | null;
  confirmed: boolean;
  onConfirm: () => void;
}) {
  if (!preview) {
    return (
      <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
        Checking playbook setup...
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Before you run</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Review the workflow and confirm which agents will run each step.
          </div>
        </div>
        <Button type="button" size="sm" variant={confirmed ? "outline" : "default"} onClick={onConfirm}>
          {confirmed ? "Agents confirmed" : "Confirm agents"}
        </Button>
      </div>
      <div className="space-y-2">
        {preview.nodePreviews.map((node) => (
          <div key={node.stepId} className="rounded-md border border-border bg-secondary/40 px-3 py-2">
            <div className="text-sm font-medium text-foreground">{node.stepLabel}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {node.kind === "agent"
                ? `Agent: ${node.recommendedAgentLabel ?? "Choose an agent"}`
                : "Tool step"}
            </div>
          </div>
        ))}
      </div>
      {preview.blockers.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {preview.blockers[0]?.reason ?? "This playbook needs setup before it can run."}
        </div>
      ) : null}
    </div>
  );
}
```

Render it inside `GuidedStart` below the intake fields and above the submit button.

- [ ] **Step 5: Gate run start and save preference**

Update `GuidedStart` props to accept `preflightReady`, `assignmentPreview`, `agentsConfirmed`, and `onConfirmAgents`.

Set:

```ts
const canSubmit = formReady && !!workspaceRoot && !running && agentsConfirmed && !assignmentPreview?.blockers.length;
```

In `startRun`, include:

```ts
assignmentPlan: draftAssignmentPlan ?? undefined,
```

When confirming agents:

```ts
async function confirmAgents() {
  if (!selectedPlaybookId || !workspaceRoot || !draftAssignmentPlan) return;
  await invoke("playbook_run_preference_save", {
    playbookId: selectedPlaybookId,
    request: {
      workspaceRoot,
      assignmentPlan: draftAssignmentPlan,
      updatedAt: new Date().toISOString(),
    },
  });
  setAgentsConfirmed(true);
}
```

- [ ] **Step 6: Add usage display helpers**

In `PlaybooksView.tsx`, add:

```ts
function formatTokens(value?: number): string {
  if (value === undefined) return "Not reported";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function UsageSummary({ usage }: { usage?: TokenUsage }) {
  if (!usage) {
    return <div className="text-xs text-muted-foreground">Tokens not reported by provider</div>;
  }
  return (
    <div className="grid grid-cols-3 gap-2 text-xs">
      <div><div className="text-muted-foreground">Input</div><div className="font-medium">{formatTokens(usage.inputTokens)}</div></div>
      <div><div className="text-muted-foreground">Output</div><div className="font-medium">{formatTokens(usage.outputTokens)}</div></div>
      <div><div className="text-muted-foreground">Total</div><div className="font-medium">{formatTokens(usage.totalTokens)}</div></div>
    </div>
  );
}
```

Render `UsageSummary` in `GuidedResult` near the result subcopy. Add compact run-row copy:

```tsx
{run.usage ? (
  <span className="text-[10px] text-muted-foreground">{formatTokens(run.usage.totalTokens)} tokens</span>
) : null}
```

- [ ] **Step 7: Run UI tests**

Run: `bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/ui/src/components/PlaybooksView.tsx apps/desktop/ui/src/components/PlaybooksView.test.tsx
git commit -m "feat: add guided playbook preflight" \
  -m "Add first-run agent confirmation, workflow preview, assignment preference save, and token usage display to the Playbooks guided Start and Result screens." \
  -m "Constraint: Next-run configuration belongs in the Start preflight module" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx"
```

---

## Task 5: Final Verification And Polish

**Files:**
- Modify only files already changed by Tasks 1-4 when verification finds an issue.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test packages/contracts/src/playbook-manifest.test.ts apps/sidecar/src/playbook-run-preferences.test.ts apps/sidecar/src/playbook-routing.test.ts packages/core/src/workflow.test.ts apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: all tests pass.

- [ ] **Step 2: Run repository check**

Run: `bun run check`

Expected: Biome and TypeScript pass.

- [ ] **Step 3: Run desktop UI dev server**

Run: `bun run --filter './apps/desktop/ui' dev`

Expected: Vite prints a local URL with no startup errors.

- [ ] **Step 4: Manual UI verification**

Open the UI and verify:

- Sales Meeting Brief shows "Before you run" on the Start screen.
- Run button is disabled until agents are confirmed.
- Confirming agents enables the Run button.
- A completed run shows usage when usage exists.
- A completed run without usage says token usage was not reported.
- Changing a playbook does not leak another playbook's assignment preference.

- [ ] **Step 5: Commit final fixes**

If any verification changes were needed:

```bash
git add <changed-files>
git commit -m "fix: polish guided playbook preflight" \
  -m "Address verification issues found while testing Guided Preflight end to end." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: bun run check"
```

If no changes were needed, do not create an empty commit.

---

## Self-Review

Spec coverage:
- First-run explicit assignment confirmation: Task 4.
- Workflow structure visibility before launch: Task 4.
- Per-node agent assignment contract and preview: Tasks 1, 2, and 4.
- Repeat-run assignment preference: Tasks 2 and 4.
- Historical assignment preservation: existing run `assignmentPlan` remains in run create; Task 4 passes explicit plans.
- Token usage per step and run: Tasks 1 and 3.
- Token usage UI: Task 4.
- Missing usage state: Tasks 3 and 4.

Scope boundaries:
- Cost estimation remains out of scope.
- Full node-canvas editing remains out of scope.
- Editing agent profiles inside run setup remains out of scope.

Completeness scan:
- The plan contains concrete implementation steps and code references for each task.

Type consistency:
- `TokenUsage`, `PlaybookAssignmentPreviewResult`, and `PlaybookRunPreference` are defined in Task 1 before they are used by sidecar or UI tasks.
