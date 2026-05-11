# Playbook Package Format Implementation Plan (Sub-plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline-JSON workflow loading in `packages/core/src/workflow.ts` with a folder-based playbook package format, and migrate the existing five workflows to packages. User-facing behavior unchanged.

**Architecture:** Add a `PlaybookManifest` schema (a thin wrapper of `{ schemaVersion, meta, workflow }`) to `packages/contracts`. A new `loadPlaybookManifest()` function in `packages/core` parses a manifest JSON + a prompts map, resolves `file:` prefixes in agent step `prompt` fields, and validates the inner `WorkflowDefinition`. Each existing workflow becomes a directory `packages/core/src/builtin-playbooks/<id>/` with `manifest.json` and (where applicable) `prompts/*.md`. Bun's static import features (`import json from "./x.json"` and `import text from "./y.md" with { type: "text" }`) keep the build entirely static — no runtime FS reads required for built-ins.

**Tech Stack:** TypeScript strict, Bun, Zod, Biome, existing test runner (`bun test`).

**Out of scope (later sub-plans):** Dashboard output kind and layout fields, disk-based import/export of `.playbook` zips, workspace activation, asset serving. Those land in sub-plans B and C.

---

## File Structure

**New files:**
- `packages/core/src/playbook-loader.ts` — package loader (manifest parse + prompt resolution + workflow validation)
- `packages/core/src/playbook-loader.test.ts` — unit tests for the loader
- `packages/core/src/builtin-playbooks/demo.write-approval/manifest.json`
- `packages/core/src/builtin-playbooks/ops.weekly-update/manifest.json`
- `packages/core/src/builtin-playbooks/sales.meeting-brief/manifest.json`
- `packages/core/src/builtin-playbooks/sales.meeting-brief/prompts/draft-brief.md`
- `packages/core/src/builtin-playbooks/customer.renewal-risk-review/manifest.json`
- `packages/core/src/builtin-playbooks/customer.renewal-risk-review/prompts/draft-risk-review.md`
- `packages/core/src/builtin-playbooks/ops.weekly-status-digest/manifest.json`
- `packages/core/src/builtin-playbooks/ops.weekly-status-digest/prompts/draft-status-digest.md`

**Modified files:**
- `packages/contracts/src/index.ts` — add `PlaybookManifestSchema` and `PlaybookMetaSchema`
- `packages/core/src/workflow.ts` — replace JSON imports + `loadWorkflowDefinition` consumers with `loadPlaybookManifest` calls; keep the existing `loadWorkflowDefinition` export as a thin wrapper around the loader for backward compatibility with any external usage
- `packages/core/src/index.ts` — export `loadPlaybookManifest` and `PlaybookManifestSchema`-related types

**Deleted files (Task 8):**
- `packages/core/src/workflows/demo.write-approval.json`
- `packages/core/src/workflows/weekly-update.json`
- `packages/core/src/workflows/sales.meeting-brief.json`
- `packages/core/src/workflows/customer.renewal-risk-review.json`
- `packages/core/src/workflows/operations.weekly-status-digest.json`
- (The `workflows/` directory itself, once empty)

---

## Task 1: Add `PlaybookManifestSchema` to contracts

**Files:**
- Modify: `packages/contracts/src/index.ts` (add new schemas near the existing `WorkflowDefinitionSchema`, around line 1247)
- Test: `packages/contracts/src/playbook-manifest.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/playbook-manifest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PlaybookManifestSchema } from "./index.js";

describe("PlaybookManifestSchema", () => {
  const validWorkflow = {
    id: "demo",
    version: 1,
    name: "Demo",
    start: "ping",
    inputs: {},
    steps: [
      {
        id: "ping",
        kind: "tool",
        toolId: "workspace.ping",
        args: {},
        onSuccess: "completed",
      },
    ],
  };

  test("accepts a minimal valid manifest", () => {
    const result = PlaybookManifestSchema.parse({
      schemaVersion: 1,
      meta: {
        id: "demo",
        version: 1,
        name: "Demo",
      },
      workflow: validWorkflow,
    });
    expect(result.meta.id).toBe("demo");
    expect(result.workflow.id).toBe("demo");
  });

  test("accepts optional meta fields", () => {
    const result = PlaybookManifestSchema.parse({
      schemaVersion: 1,
      meta: {
        id: "demo",
        version: 1,
        name: "Demo",
        description: "A demo playbook",
        author: "Tessera",
        tags: ["demo", "test"],
        signature: "abc123",
      },
      workflow: validWorkflow,
    });
    expect(result.meta.author).toBe("Tessera");
    expect(result.meta.tags).toEqual(["demo", "test"]);
  });

  test("rejects missing schemaVersion", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        meta: { id: "demo", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects unsupported schemaVersion", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 999,
        meta: { id: "demo", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects empty meta.id", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 1,
        meta: { id: "", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects non-positive meta.version", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 1,
        meta: { id: "demo", version: 0, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/contracts/src/playbook-manifest.test.ts`
Expected: FAIL with `Cannot find name 'PlaybookManifestSchema'` or "PlaybookManifestSchema is undefined".

- [ ] **Step 3: Add the schemas to `packages/contracts/src/index.ts`**

Open `packages/contracts/src/index.ts`. Find the line `export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;` (around line 1247). Insert the following directly after it:

```ts
export const PlaybookMetaSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  signature: z.string().min(1).optional(),
});
export type PlaybookMeta = z.infer<typeof PlaybookMetaSchema>;

export const PlaybookManifestSchema = z.object({
  schemaVersion: z.literal(1),
  meta: PlaybookMetaSchema,
  workflow: WorkflowDefinitionSchema,
});
export type PlaybookManifest = z.infer<typeof PlaybookManifestSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/contracts/src/playbook-manifest.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Run typecheck and biome**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/playbook-manifest.test.ts
git commit -m "feat(contracts): add PlaybookManifestSchema"
```

---

## Task 2: Implement `loadPlaybookManifest` in core

**Files:**
- Create: `packages/core/src/playbook-loader.ts`
- Create: `packages/core/src/playbook-loader.test.ts`

The loader's job: take a manifest JSON and an optional prompts map, walk every agent step, resolve any `prompt` field that starts with `file:` by replacing the value with the corresponding prompts-map entry, validate the resulting `WorkflowDefinition` (start step exists, transitions reach known steps), and return a parsed `PlaybookManifest`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/playbook-loader.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadPlaybookManifest } from "./playbook-loader.js";

const baseManifest = {
  schemaVersion: 1,
  meta: { id: "demo", version: 1, name: "Demo" },
  workflow: {
    id: "demo",
    version: 1,
    name: "Demo",
    start: "ping",
    inputs: {},
    steps: [
      {
        id: "ping",
        kind: "tool",
        toolId: "workspace.ping",
        args: {},
        onSuccess: "completed",
      },
    ],
  },
};

describe("loadPlaybookManifest", () => {
  test("loads a tool-only manifest with no prompts", () => {
    const manifest = loadPlaybookManifest({ manifestJson: baseManifest });
    expect(manifest.meta.id).toBe("demo");
    expect(manifest.workflow.steps[0].id).toBe("ping");
  });

  test("resolves file: prompt references against the prompts map", () => {
    const manifest = loadPlaybookManifest({
      manifestJson: {
        ...baseManifest,
        workflow: {
          ...baseManifest.workflow,
          start: "draft",
          steps: [
            {
              id: "draft",
              kind: "agent",
              prompt: "file:prompts/draft.md",
              onSuccess: "completed",
            },
          ],
        },
      },
      prompts: { "prompts/draft.md": "Draft a summary." },
    });
    const step = manifest.workflow.steps[0];
    if (step.kind !== "agent") throw new Error("expected agent step");
    expect(step.prompt).toBe("Draft a summary.");
  });

  test("leaves literal prompts unchanged", () => {
    const manifest = loadPlaybookManifest({
      manifestJson: {
        ...baseManifest,
        workflow: {
          ...baseManifest.workflow,
          start: "draft",
          steps: [
            {
              id: "draft",
              kind: "agent",
              prompt: "Draft a summary.",
              onSuccess: "completed",
            },
          ],
        },
      },
    });
    const step = manifest.workflow.steps[0];
    if (step.kind !== "agent") throw new Error("expected agent step");
    expect(step.prompt).toBe("Draft a summary.");
  });

  test("rejects unresolved file: references", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: {
            ...baseManifest.workflow,
            start: "draft",
            steps: [
              {
                id: "draft",
                kind: "agent",
                prompt: "file:prompts/missing.md",
                onSuccess: "completed",
              },
            ],
          },
        },
        prompts: {},
      })
    ).toThrow(/prompts\/missing\.md/);
  });

  test("rejects prompt references that escape the prompts/ directory", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: {
            ...baseManifest.workflow,
            start: "draft",
            steps: [
              {
                id: "draft",
                kind: "agent",
                prompt: "file:../escape.md",
                onSuccess: "completed",
              },
            ],
          },
        },
        prompts: { "../escape.md": "nope" },
      })
    ).toThrow(/prompts\//);
  });

  test("rejects manifests with an unknown start step", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: { ...baseManifest.workflow, start: "ghost" },
        },
      })
    ).toThrow(/Unknown workflow start step/);
  });

  test("rejects transitions to unknown steps", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: {
            ...baseManifest.workflow,
            steps: [
              {
                id: "ping",
                kind: "tool",
                toolId: "workspace.ping",
                args: {},
                onSuccess: "ghost",
              },
            ],
          },
        },
      })
    ).toThrow(/Unknown workflow transition/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/playbook-loader.test.ts`
Expected: FAIL with "Cannot find module './playbook-loader.js'".

- [ ] **Step 3: Create the loader**

Create `packages/core/src/playbook-loader.ts`:

```ts
import { type PlaybookManifest, PlaybookManifestSchema } from "@tessera/contracts";

const FILE_PREFIX = "file:";
const TERMINAL_STEPS = new Set(["completed", "failed", "denied"]);

export interface LoadPlaybookManifestOptions {
  manifestJson: unknown;
  prompts?: Record<string, string>;
}

export function loadPlaybookManifest(options: LoadPlaybookManifestOptions): PlaybookManifest {
  const promptsMap = options.prompts ?? {};
  const manifest = PlaybookManifestSchema.parse(options.manifestJson);

  const resolvedSteps = manifest.workflow.steps.map((step) => {
    if (step.kind !== "agent") return step;
    if (!step.prompt.startsWith(FILE_PREFIX)) return step;

    const relativePath = step.prompt.slice(FILE_PREFIX.length);
    if (!relativePath.startsWith("prompts/") || relativePath.includes("..")) {
      throw new Error(
        `Prompt reference must point inside prompts/: ${step.prompt}`
      );
    }

    const promptText = promptsMap[relativePath];
    if (promptText === undefined) {
      throw new Error(`Missing prompt file referenced by step ${step.id}: ${relativePath}`);
    }

    return { ...step, prompt: promptText };
  });

  const resolved: PlaybookManifest = {
    ...manifest,
    workflow: { ...manifest.workflow, steps: resolvedSteps },
  };

  const stepIds = new Set(resolved.workflow.steps.map((step) => step.id));
  if (!stepIds.has(resolved.workflow.start)) {
    throw new Error(`Unknown workflow start step: ${resolved.workflow.start}`);
  }
  for (const step of resolved.workflow.steps) {
    for (const next of [step.onSuccess, step.onFailure]) {
      if (next && !stepIds.has(next) && !TERMINAL_STEPS.has(next)) {
        throw new Error(`Unknown workflow transition from ${step.id}: ${next}`);
      }
    }
  }

  return resolved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/core/src/playbook-loader.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Export the loader**

Open `packages/core/src/index.ts`. Add to the existing export list:

```ts
export { loadPlaybookManifest } from "./playbook-loader.js";
export type { LoadPlaybookManifestOptions } from "./playbook-loader.js";
```

- [ ] **Step 6: Run typecheck and biome**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/playbook-loader.ts packages/core/src/playbook-loader.test.ts packages/core/src/index.ts
git commit -m "feat(core): add loadPlaybookManifest with file: prompt resolution"
```

---

## Task 3: Migrate `demo.write-approval` (tool-only, no prompts)

This is the simplest workflow — no agent steps, so no prompt extraction needed. We just wrap the existing definition in a `PlaybookManifest`.

**Files:**
- Create: `packages/core/src/builtin-playbooks/demo.write-approval/manifest.json`
- Modify: `packages/core/src/workflow.ts` (replace the JSON import and `loadWorkflowDefinition` call for this workflow only)

- [ ] **Step 1: Create the package manifest**

Create `packages/core/src/builtin-playbooks/demo.write-approval/manifest.json`:

```json
{
  "schemaVersion": 1,
  "meta": {
    "id": "demo.write-approval",
    "version": 1,
    "name": "Demo Write Approval",
    "description": "Proves deterministic workflow execution with HITL pause/resume.",
    "author": "Tessera"
  },
  "workflow": {
    "id": "demo.write-approval",
    "version": 1,
    "name": "Demo Write Approval",
    "description": "Proves deterministic workflow execution with HITL pause/resume.",
    "start": "ping",
    "inputs": {
      "message": { "type": "string", "required": true, "default": "hello" },
      "target": { "type": "string", "required": true, "default": "lead" },
      "value": { "type": "string", "required": true, "default": "qualified" }
    },
    "steps": [
      {
        "id": "ping",
        "kind": "tool",
        "toolId": "workspace.ping",
        "args": { "message": "{{inputs.message}}" },
        "onSuccess": "writeProbe",
        "onFailure": "failed"
      },
      {
        "id": "writeProbe",
        "kind": "tool",
        "toolId": "workspace.writeProbe",
        "args": { "target": "{{inputs.target}}", "value": "{{inputs.value}}" },
        "onSuccess": "completed",
        "onFailure": "failed"
      }
    ]
  }
}
```

- [ ] **Step 2: Update `workflow.ts` to load from the package**

Open `packages/core/src/workflow.ts`. Find this line (around line 36):

```ts
import demoWorkflowManifest from "./workflows/demo.write-approval.json";
```

Replace with:

```ts
import demoWriteApprovalManifest from "./builtin-playbooks/demo.write-approval/manifest.json";
```

Find this line (around line 68):

```ts
export const DEMO_WORKFLOW = loadWorkflowDefinition(demoWorkflowManifest);
```

Replace with:

```ts
export const DEMO_WORKFLOW = loadPlaybookManifest({
  manifestJson: demoWriteApprovalManifest,
}).workflow;
```

Add `loadPlaybookManifest` to the existing imports near the top of the file:

```ts
import { loadPlaybookManifest } from "./playbook-loader.js";
```

- [ ] **Step 3: Run the existing core test suite to verify nothing broke**

Run: `bun test packages/core/src/`
Expected: All previously passing tests still PASS. No tests changed in this task — we're proving the migration is behavior-preserving.

- [ ] **Step 4: Run typecheck and biome**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/builtin-playbooks/demo.write-approval packages/core/src/workflow.ts
git commit -m "refactor(core): migrate demo.write-approval to playbook package"
```

---

## Task 4: Migrate `ops.weekly-update` (tool-only, no prompts)

Same shape as Task 3 — tool-only, no prompts.

**Files:**
- Create: `packages/core/src/builtin-playbooks/ops.weekly-update/manifest.json`
- Modify: `packages/core/src/workflow.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/core/src/builtin-playbooks/ops.weekly-update/manifest.json`:

```json
{
  "schemaVersion": 1,
  "meta": {
    "id": "ops.weekly-update",
    "version": 1,
    "name": "Weekly Update",
    "description": "Prepare and stage a weekly status update with one approval checkpoint.",
    "author": "Tessera"
  },
  "workflow": {
    "id": "ops.weekly-update",
    "version": 1,
    "name": "Weekly Update",
    "description": "Prepare and stage a weekly status update with one approval checkpoint.",
    "phaseOrder": ["Collect", "Draft", "Approval"],
    "start": "collectContext",
    "inputs": {
      "message": { "type": "string", "required": true, "default": "weekly status" },
      "target": { "type": "string", "required": true, "default": "weekly-update" },
      "value": { "type": "string", "required": true, "default": "draft-ready" }
    },
    "steps": [
      {
        "id": "collectContext",
        "label": "Collect context",
        "phase": "Collect",
        "kind": "tool",
        "toolId": "workspace.ping",
        "args": { "message": "{{inputs.message}}" },
        "onSuccess": "stageDraft"
      },
      {
        "id": "stageDraft",
        "label": "Stage update draft",
        "phase": "Draft",
        "kind": "tool",
        "toolId": "workspace.writeProbe",
        "args": { "target": "{{inputs.target}}", "value": "{{inputs.value}}" },
        "onSuccess": "completed"
      }
    ]
  }
}
```

- [ ] **Step 2: Update `workflow.ts`**

Open `packages/core/src/workflow.ts`. Find this line (around line 39):

```ts
import weeklyUpdateManifest from "./workflows/weekly-update.json";
```

Replace with:

```ts
import opsWeeklyUpdateManifest from "./builtin-playbooks/ops.weekly-update/manifest.json";
```

Find this line (around line 69):

```ts
export const WEEKLY_UPDATE_WORKFLOW = loadWorkflowDefinition(weeklyUpdateManifest);
```

Replace with:

```ts
export const WEEKLY_UPDATE_WORKFLOW = loadPlaybookManifest({
  manifestJson: opsWeeklyUpdateManifest,
}).workflow;
```

- [ ] **Step 3: Run the existing core test suite**

Run: `bun test packages/core/src/`
Expected: All previously passing tests still PASS.

- [ ] **Step 4: Run typecheck and biome**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/builtin-playbooks/ops.weekly-update packages/core/src/workflow.ts
git commit -m "refactor(core): migrate ops.weekly-update to playbook package"
```

---

## Task 5: Migrate `sales.meeting-brief` (extract 1 prompt)

This workflow has one agent step (`draftBrief`) with a long inline prompt. We use a deterministic Python script to extract it: copy the source JSON, lift the prompt into a separate `.md` file, replace the inline prompt with a `file:` reference, and wrap the whole workflow body in a `PlaybookManifest`.

**Files:**
- Create: `packages/core/src/builtin-playbooks/sales.meeting-brief/manifest.json`
- Create: `packages/core/src/builtin-playbooks/sales.meeting-brief/prompts/draft-brief.md`
- Modify: `packages/core/src/workflow.ts`

- [ ] **Step 1: Run the extraction script**

Run from the repo root:

```bash
python3 <<'PY'
import json, os
src_path = 'packages/core/src/workflows/sales.meeting-brief.json'
pkg_dir = 'packages/core/src/builtin-playbooks/sales.meeting-brief'
os.makedirs(os.path.join(pkg_dir, 'prompts'), exist_ok=True)

src = json.load(open(src_path))

# Confirm assumptions: exactly one agent step with a literal prompt.
agent_steps = [s for s in src['steps'] if s.get('kind') == 'agent' and isinstance(s.get('prompt'), str)]
assert len(agent_steps) == 1, f"expected 1 agent step, found {len(agent_steps)}"
agent_step = agent_steps[0]
assert agent_step['id'] == 'draftBrief', f"unexpected agent step id: {agent_step['id']}"

prompt_text = agent_step['prompt']
with open(os.path.join(pkg_dir, 'prompts', 'draft-brief.md'), 'w') as f:
    f.write(prompt_text)

# Replace prompt with file: reference in the workflow body
agent_step['prompt'] = 'file:prompts/draft-brief.md'

manifest = {
    'schemaVersion': 1,
    'meta': {
        'id': src['id'],
        'version': src['version'],
        'name': src['name'],
        'description': src.get('description', ''),
        'author': 'Tessera',
    },
    'workflow': src,
}
with open(os.path.join(pkg_dir, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')
print('sales.meeting-brief migrated')
PY
```

Expected output: `sales.meeting-brief migrated`

- [ ] **Step 2: Verify the manifest structure**

```bash
python3 <<'PY'
import json
m = json.load(open('packages/core/src/builtin-playbooks/sales.meeting-brief/manifest.json'))
assert m['schemaVersion'] == 1
assert m['meta']['id'] == 'sales.meeting-brief'
assert m['workflow']['id'] == 'sales.meeting-brief'
agent_steps = [s for s in m['workflow']['steps'] if s.get('kind') == 'agent']
assert len(agent_steps) == 1
assert agent_steps[0]['prompt'] == 'file:prompts/draft-brief.md'
print('manifest ok')
PY
```

Expected: `manifest ok`

- [ ] **Step 3: Update `workflow.ts`**

Open `packages/core/src/workflow.ts`. Find:

```ts
import salesMeetingBriefManifest from "./workflows/sales.meeting-brief.json";
```

Replace with:

```ts
import salesMeetingBriefManifest from "./builtin-playbooks/sales.meeting-brief/manifest.json";
import salesMeetingBriefDraftBrief from "./builtin-playbooks/sales.meeting-brief/prompts/draft-brief.md" with { type: "text" };
```

Find:

```ts
export const SALES_MEETING_BRIEF_WORKFLOW = loadWorkflowDefinition(salesMeetingBriefManifest);
```

Replace with:

```ts
export const SALES_MEETING_BRIEF_WORKFLOW = loadPlaybookManifest({
  manifestJson: salesMeetingBriefManifest,
  prompts: { "prompts/draft-brief.md": salesMeetingBriefDraftBrief },
}).workflow;
```

- [ ] **Step 4: Run the existing core test suite**

Run: `bun test packages/core/src/`
Expected: All previously passing tests still PASS.

If a test asserts on the literal prompt text (e.g. `playbook-routing.test.ts` may compare prompt strings), update the assertion to compare against the extracted markdown file content. To verify, run:

```bash
grep -rn "Create a concise sales meeting brief" packages/core/src/ apps/sidecar/src/
```

If any test still references the literal string, replace it with an import of the markdown file using the same `with { type: "text" }` syntax. If no test references the literal string, no further changes are needed.

- [ ] **Step 5: Run typecheck and biome**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/builtin-playbooks/sales.meeting-brief packages/core/src/workflow.ts
git commit -m "refactor(core): migrate sales.meeting-brief to playbook package"
```

---

## Task 6: Migrate `customer.renewal-risk-review` (extract 1 prompt)

Same shape as Task 5.

**Files:**
- Create: `packages/core/src/builtin-playbooks/customer.renewal-risk-review/manifest.json`
- Create: `packages/core/src/builtin-playbooks/customer.renewal-risk-review/prompts/draft-risk-review.md`
- Modify: `packages/core/src/workflow.ts`

- [ ] **Step 1: Run the extraction script**

```bash
python3 <<'PY'
import json, os
src_path = 'packages/core/src/workflows/customer.renewal-risk-review.json'
pkg_dir = 'packages/core/src/builtin-playbooks/customer.renewal-risk-review'
os.makedirs(os.path.join(pkg_dir, 'prompts'), exist_ok=True)

src = json.load(open(src_path))
agent_steps = [s for s in src['steps'] if s.get('kind') == 'agent' and isinstance(s.get('prompt'), str)]
assert len(agent_steps) == 1, f"expected 1 agent step, found {len(agent_steps)}"
agent_step = agent_steps[0]

prompt_text = agent_step['prompt']
with open(os.path.join(pkg_dir, 'prompts', 'draft-risk-review.md'), 'w') as f:
    f.write(prompt_text)

agent_step['prompt'] = 'file:prompts/draft-risk-review.md'

manifest = {
    'schemaVersion': 1,
    'meta': {
        'id': src['id'],
        'version': src['version'],
        'name': src['name'],
        'description': src.get('description', ''),
        'author': 'Tessera',
    },
    'workflow': src,
}
with open(os.path.join(pkg_dir, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')
print('customer.renewal-risk-review migrated')
PY
```

Expected output: `customer.renewal-risk-review migrated`

- [ ] **Step 2: Verify the manifest structure**

```bash
python3 <<'PY'
import json
m = json.load(open('packages/core/src/builtin-playbooks/customer.renewal-risk-review/manifest.json'))
assert m['schemaVersion'] == 1
assert m['meta']['id'] == 'customer.renewal-risk-review'
assert m['workflow']['id'] == 'customer.renewal-risk-review'
agent_steps = [s for s in m['workflow']['steps'] if s.get('kind') == 'agent']
assert len(agent_steps) == 1
assert agent_steps[0]['prompt'] == 'file:prompts/draft-risk-review.md'
print('manifest ok')
PY
```

Expected: `manifest ok`

- [ ] **Step 3: Update `workflow.ts`**

Find:

```ts
import customerRenewalRiskReviewManifest from "./workflows/customer.renewal-risk-review.json";
```

Replace with:

```ts
import customerRenewalRiskReviewManifest from "./builtin-playbooks/customer.renewal-risk-review/manifest.json";
import customerRenewalRiskReviewDraft from "./builtin-playbooks/customer.renewal-risk-review/prompts/draft-risk-review.md" with { type: "text" };
```

Find:

```ts
export const CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW = loadWorkflowDefinition(
  customerRenewalRiskReviewManifest
);
```

Replace with:

```ts
export const CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW = loadPlaybookManifest({
  manifestJson: customerRenewalRiskReviewManifest,
  prompts: { "prompts/draft-risk-review.md": customerRenewalRiskReviewDraft },
}).workflow;
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/`
Expected: All previously passing tests still PASS.

- [ ] **Step 5: Run typecheck and biome**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/builtin-playbooks/customer.renewal-risk-review packages/core/src/workflow.ts
git commit -m "refactor(core): migrate customer.renewal-risk-review to playbook package"
```

---

## Task 7: Migrate `ops.weekly-status-digest` (extract 1 prompt)

**Files:**
- Create: `packages/core/src/builtin-playbooks/ops.weekly-status-digest/manifest.json`
- Create: `packages/core/src/builtin-playbooks/ops.weekly-status-digest/prompts/draft-status-digest.md`
- Modify: `packages/core/src/workflow.ts`

The source file's id is `operations.weekly-status-digest`. We keep that id (do not rename) to avoid breaking existing run records that reference it.

- [ ] **Step 1: Run the extraction script**

```bash
python3 <<'PY'
import json, os
src_path = 'packages/core/src/workflows/operations.weekly-status-digest.json'
pkg_dir = 'packages/core/src/builtin-playbooks/ops.weekly-status-digest'
os.makedirs(os.path.join(pkg_dir, 'prompts'), exist_ok=True)

src = json.load(open(src_path))
agent_steps = [s for s in src['steps'] if s.get('kind') == 'agent' and isinstance(s.get('prompt'), str)]
assert len(agent_steps) == 1, f"expected 1 agent step, found {len(agent_steps)}"
agent_step = agent_steps[0]

prompt_text = agent_step['prompt']
with open(os.path.join(pkg_dir, 'prompts', 'draft-status-digest.md'), 'w') as f:
    f.write(prompt_text)

agent_step['prompt'] = 'file:prompts/draft-status-digest.md'

manifest = {
    'schemaVersion': 1,
    'meta': {
        'id': src['id'],            # Keep 'operations.weekly-status-digest' — id is preserved
        'version': src['version'],
        'name': src['name'],
        'description': src.get('description', ''),
        'author': 'Tessera',
    },
    'workflow': src,
}
with open(os.path.join(pkg_dir, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')
print('ops.weekly-status-digest migrated')
PY
```

Expected output: `ops.weekly-status-digest migrated`

Note: the package directory is `ops.weekly-status-digest/` but the playbook id stays `operations.weekly-status-digest` (preserved from the source so existing run records keep working).

- [ ] **Step 2: Verify the manifest structure**

```bash
python3 <<'PY'
import json
m = json.load(open('packages/core/src/builtin-playbooks/ops.weekly-status-digest/manifest.json'))
assert m['schemaVersion'] == 1
assert m['meta']['id'] == 'operations.weekly-status-digest'
assert m['workflow']['id'] == 'operations.weekly-status-digest'
agent_steps = [s for s in m['workflow']['steps'] if s.get('kind') == 'agent']
assert len(agent_steps) == 1
assert agent_steps[0]['prompt'] == 'file:prompts/draft-status-digest.md'
print('manifest ok')
PY
```

Expected: `manifest ok`

- [ ] **Step 3: Update `workflow.ts`**

Find:

```ts
import operationsWeeklyStatusDigestManifest from "./workflows/operations.weekly-status-digest.json";
```

Replace with:

```ts
import operationsWeeklyStatusDigestManifest from "./builtin-playbooks/ops.weekly-status-digest/manifest.json";
import operationsWeeklyStatusDigestDraft from "./builtin-playbooks/ops.weekly-status-digest/prompts/draft-status-digest.md" with { type: "text" };
```

Find:

```ts
export const WEEKLY_STATUS_DIGEST_WORKFLOW = loadWorkflowDefinition(
  operationsWeeklyStatusDigestManifest
);
```

Replace with:

```ts
export const WEEKLY_STATUS_DIGEST_WORKFLOW = loadPlaybookManifest({
  manifestJson: operationsWeeklyStatusDigestManifest,
  prompts: { "prompts/draft-status-digest.md": operationsWeeklyStatusDigestDraft },
}).workflow;
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/`
Expected: All previously passing tests still PASS.

- [ ] **Step 5: Run typecheck and biome**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/builtin-playbooks/ops.weekly-status-digest packages/core/src/workflow.ts
git commit -m "refactor(core): migrate ops.weekly-status-digest to playbook package"
```

---

## Task 8: Remove the old `workflows/` directory and `loadWorkflowDefinition`

Now that all five workflows are loaded from packages, the old `workflows/` directory and the `loadWorkflowDefinition` function are dead code. Remove them.

**Files:**
- Delete: `packages/core/src/workflows/` (all 5 JSON files + directory)
- Modify: `packages/core/src/workflow.ts` (remove `loadWorkflowDefinition`)
- Modify: `packages/core/src/index.ts` (remove the `loadWorkflowDefinition` export)

- [ ] **Step 1: Verify nothing imports the old function before deleting**

Run:

```bash
grep -rn "loadWorkflowDefinition" packages/ apps/ --include="*.ts" --include="*.tsx"
```

Expected: only references inside `packages/core/src/workflow.ts` and `packages/core/src/index.ts`. If any other file in `packages/` or `apps/` references `loadWorkflowDefinition`, STOP and update those consumers to use `loadPlaybookManifest({ manifestJson }).workflow` instead before continuing.

- [ ] **Step 2: Delete the old JSON files and directory**

```bash
rm -r packages/core/src/workflows
```

- [ ] **Step 3: Remove `loadWorkflowDefinition` from `workflow.ts`**

Open `packages/core/src/workflow.ts`. Find the function definition (around line 49):

```ts
export function loadWorkflowDefinition(value: unknown): WorkflowDefinition {
  const definition = WorkflowDefinitionSchema.parse(value);
  const stepIds = new Set(definition.steps.map((step) => step.id));

  if (!stepIds.has(definition.start)) {
    throw new Error(`Unknown workflow start step: ${definition.start}`);
  }

  for (const step of definition.steps) {
    for (const next of [step.onSuccess, step.onFailure]) {
      if (next && !stepIds.has(next) && !TERMINAL_STEPS.has(next)) {
        throw new Error(`Unknown workflow transition from ${step.id}: ${next}`);
      }
    }
  }

  return definition;
}
```

Delete it entirely. Also remove the `TERMINAL_STEPS` constant if it is no longer referenced elsewhere in the file (search for `TERMINAL_STEPS` in the file — if the only usage was inside `loadWorkflowDefinition`, delete the constant declaration too).

Check:

```bash
grep -n "TERMINAL_STEPS\|loadWorkflowDefinition" packages/core/src/workflow.ts
```

If `TERMINAL_STEPS` still has references, keep it. If `loadWorkflowDefinition` has any remaining references in this file, those are bugs from earlier tasks — fix them by switching to `loadPlaybookManifest`.

- [ ] **Step 4: Remove the export from `index.ts`**

Open `packages/core/src/index.ts`. Find the line:

```ts
  loadWorkflowDefinition,
```

Delete it.

- [ ] **Step 5: Run typecheck and biome**

Run: `bun run check`
Expected: No errors. If typecheck fails with "Cannot find name 'loadWorkflowDefinition'", a consumer was missed in Step 1 — go back and fix it.

- [ ] **Step 6: Run the full test suite across all workspaces**

Run: `bun run --filter '*' test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/src/index.ts
git commit -m "refactor(core): remove legacy workflows/ directory and loadWorkflowDefinition"
```

---

## Task 9: End-to-end smoke verification

**Files:** None modified — this task only runs commands.

- [ ] **Step 1: Full check**

Run: `bun run check`
Expected: No errors.

- [ ] **Step 2: Full test suite**

Run: `bun run --filter '*' test`
Expected: All tests pass across `contracts`, `core`, `cli`, `plugin-sdk`, `sidecar`, and `ui`.

- [ ] **Step 3: Build the sidecar binary**

Run: `bun run --filter './apps/sidecar' build`
Expected: Builds successfully without errors. The new `with { type: "text" }` and JSON imports must resolve inside the compiled binary.

- [ ] **Step 4: Confirm the binary still starts and registers all five workflows**

Run:

```bash
TESSERA_DATA_DIR=/tmp/tessera-smoke-$$ ./apps/sidecar/dist/sidecar &
SIDECAR_PID=$!
sleep 2
# The sidecar prints a JSON line to stdout with its bearer token and address.
# Without that, the next request would require parsing it — instead just verify
# the process is alive and exit.
if kill -0 $SIDECAR_PID 2>/dev/null; then
  echo "sidecar started"
  kill $SIDECAR_PID
else
  echo "sidecar failed to start"
  exit 1
fi
```

Expected: `sidecar started` printed. If the sidecar fails to start, inspect the binary's stderr for the failure reason — most likely a missing JSON or markdown file in the bundle.

- [ ] **Step 5: Final commit (only if any cleanup changes were made in this task)**

If any files changed during smoke testing, commit them:

```bash
git status
# If nothing changed, skip this step.
git add -A
git commit -m "chore(core): smoke verification of playbook package migration"
```

---

## Self-Review Notes (built into the plan)

- **Spec coverage:** Section 1 (folder structure) → Tasks 3–7 create the directory layout. Section 2 (PlaybookManifestSchema, prompt resolution, file: prefix) → Tasks 1 and 2. Section "Migration of existing built-in workflows" → Tasks 3–8 perform the migration and remove the legacy format.
- **Out of scope (correctly deferred):** Dashboard kind, `id` / `layoutScript` / `layout` fields on `WorkflowOutputDeclaration`, asset serving, import/export, workspace activation, sample repo — all of these land in sub-plans B / C / D and are NOT included here.
- **Risk:** Bun's `with { type: "text" }` import attribute is the load-bearing mechanism for prompts. If a Bun version in CI doesn't support it, Task 5 will fail. Mitigation: the smoke test in Task 9 builds the compiled binary, which is the strictest exercise of the import path. If it fails, fall back to a build-step that inlines the prompts into the manifest JSON.
- **Behavior preservation:** every migration task runs the existing test suite without modification. If a test breaks, the migration is wrong — do not change tests to make them pass. The tests are the contract for behavior preservation.
