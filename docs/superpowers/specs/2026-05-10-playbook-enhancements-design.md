# Playbook Enhancements Design

## Decision

Extend the Playbook feature across three dimensions: (1) a folder-based playbook
package format that scales to complex authoring, (2) a Dashboard output type with
a manual-refresh pinned view powered by sidecar-side layout generator scripts,
and (3) global-install / workspace-activation portability with `.playbook` import
and export. A companion `tessera-playbooks` sample repo validates the schema
through five reference implementations covering distinct workflow shapes.

---

## Architecture: Option C — Output-type-driven display inside PlaybookManifest

`WorkflowDefinition` stays the execution contract, unchanged. A new
`PlaybookManifest` is a thin portability wrapper around it. Dashboard capability
lives entirely inside `WorkflowOutputDeclaration.layout` — the execution engine
never sees display concerns, and new output types get new layout schemas without
touching shared types.

---

## 1. Playbook Package Structure

A playbook is a folder, not a single file. This matches how skills are organised
and gives authors space for prompts, scripts, schemas, tests, and assets.

```
pipeline-health/
├── PLAYBOOK.md              # Human-readable: purpose, authoring guide, use cases
├── manifest.json            # Meta + WorkflowDefinition (machine-readable)
├── prompts/                 # Agent step prompts, referenced by id from manifest
│   └── draft-snapshot.md
├── layouts/                 # Static DashboardLayout JSON (fallback if no script)
│   └── dashboard.json
├── scripts/                 # Sidecar-side layout generator scripts (Level 1)
│   └── render-dashboard.ts  # Receives run outputs, returns DashboardLayout JSON
├── schemas/                 # JSON Schema for input validation + form generation
│   └── inputs.json
├── tests/
│   ├── fixtures/            # Sample inputs for test runs
│   └── golden/              # Expected DashboardLayout outputs for snapshot tests
└── assets/
    └── icon.png             # Shown on import screen and playbook catalog
```

**Rules:**
- `manifest.json` references scripts by relative path: `"layoutScript": "scripts/render-dashboard.ts"`
- If both `layouts/` and `layoutScript` are present, the script takes precedence
- Scripts run in a restricted Bun child process: no network, no filesystem writes,
  no child processes. Input is the run output map via stdin; output must be valid
  `DashboardLayout` JSON via stdout
- The `.playbook` import format is a zip of this folder, validated before anything executes

### PLAYBOOK.md Required Sections

Every playbook in the sample repo must include these sections:

```markdown
# Playbook Name

## What this does
One paragraph. Business outcome, not technical description.

## When to use it
Bullet list of triggering situations.

## Required setup
Integrations or credentials needed before running.

## Inputs
Table: field name, type, description, example.

## Outputs
Artifacts or dashboard sections produced.

## Authoring notes
Non-obvious decisions, schema patterns used, known limitations.
```

---

## 2. Schema Design

### `manifest.json`

```ts
{
  schemaVersion: 1,                        // format version for forward compat
  meta: {
    id: "sales.pipeline-health",           // namespaced, stable, no spaces
    version: 1,
    name: "Pipeline Health",
    description: string,
    author?: string,
    tags?: string[],
    signature?: string,                    // future: local signing (Phase 7)
    exportedAt?: string,                   // set on export, absent in dev
  },
  workflow: WorkflowDefinition,            // existing schema, untouched
  outputs: {
    [outputKind: string]: {
      layoutScript?: string,               // relative: "scripts/render-dashboard.ts"
      layout?: string,                     // relative: "layouts/dashboard.json"
    }
  }
}
```

### `WorkflowOutputDeclaration` extension

Add `"dashboard"` to the `kind` enum. `layout` is only meaningful when
`kind === "dashboard"` and no `layoutScript` is configured:

```ts
{
  kind: "meetingBrief" | "businessBrief" | "statusDigest"
      | "sourceSummary" | "approvalRequest" | "dashboard",
  label: string,
  description?: string,
}
```

### `DashboardLayout`

What a layout script (or static `dashboard.json`) must produce:

```ts
{
  refreshLabel?: string,       // Button copy, e.g. "Refresh pipeline"
  sections: Array<
    | {
        type: "metrics";
        title?: string;
        items: { label: string; binding: string; unit?: string }[]
      }
    | { type: "list";  title: string; binding: string; emptyLabel?: string }
    | { type: "text";  title: string; binding: string }
    | { type: "table"; title: string; binding: string;
        columns: { key: string; label: string }[] }
  >
}
```

`binding` is a dot-path into the completed run's step output map
(e.g. `"draftSnapshot.riskItems"`). Pure declaration — no runtime logic.

### Layout Generator Script Contract

The sidecar passes run outputs in and expects a `DashboardLayout` back:

```ts
// Input (via stdin as JSON):
type RenderInput = {
  outputs: Record<string, unknown>;   // keyed by step id
  meta: { runId: string; completedAt: string; playbookId: string }
}

// Script must export a default function:
export default function render(input: RenderInput): DashboardLayout { ... }
```

**Sidecar execution steps:**
1. Run the script in a `Bun.spawn` child with `--no-network` and read-only tmpfs
2. Pass `RenderInput` via stdin as JSON
3. Read `DashboardLayout` from stdout
4. Validate against `DashboardLayoutSchema` (Zod) — reject if invalid
5. Store validated layout alongside the run record in SQLite

---

## 3. Dashboard UX & Refresh

### Catalog

Dashboard playbooks show a `Dashboard` badge in the playbook catalog.

Once run at least once, they are pinned to a **Dashboards** section at the top
of the Playbooks catalog, above one-shot document playbooks. A never-run
dashboard appears in the main catalog like any other playbook.

### Guided Flow

Dashboard playbooks follow the same four-state guided flow as document playbooks
(Start → Preparing → Review → Result). The Result state differs:

```
┌─────────────────────────────────────────────────┐
│  Pipeline Health          Last updated: 2h ago  │
│                                    [Refresh]    │
├─────────────────────────────────────────────────┤
│  [metric] 14 open deals   [metric] 3 at risk    │
├─────────────────────────────────────────────────┤
│  At-Risk Renewals                               │
│  • Acme Corp — renewal in 12 days               │
│  • Globex — no activity in 30 days              │
├─────────────────────────────────────────────────┤
│  This Week's Pipeline Movement                  │
│  Three deals advanced to proposal stage...      │
└─────────────────────────────────────────────────┘
```

### Refresh Behaviour

- Refresh re-runs the full workflow with the same inputs stored from the last run
- The intake form is pre-filled with previous inputs; the user may edit before confirming
- While refreshing, the existing snapshot stays visible — no blank/loading flash
- "Last updated" label becomes "Refreshing…" during the run
- On completion the layout re-renders in place
- On failure the old snapshot is preserved with a "Refresh failed" notice
- Each refresh is a new run record in SQLite — full history is retained
- The dashboard always displays the most recent successfully completed run

---

## 4. Import / Export

### Scope: Global Install, Workspace Activation

Playbooks are installed once at the Tessera level in
`~/.tessera/playbooks/<id>/` (the same `TESSERA_DATA_DIR` root the sidecar
already uses). Each workspace maintains an `activatedPlaybooks` list in its
`.tessera/config.json` — a lightweight array of playbook ids controlling which
installed playbooks appear in that workspace's catalog. Run history is always
workspace-scoped regardless of install scope.

This gives install-once convenience without cross-workspace catalog pollution.

### Export

- Any installed playbook can be exported via catalog context menu: "Export playbook…"
- Tessera zips the package folder, sets `meta.exportedAt` in `manifest.json`,
  saves as `<id>-v<version>.playbook`
- Only package contents are exported — no run history, no credentials, no workspace data
- `meta.signature` will be populated here once local signing (Phase 7) exists

### Import

1. User drops a `.playbook` file or picks via file dialog
2. Tessera unzips and validates:
   - Schema version check
   - `manifest.json` parses and passes `PlaybookManifestSchema` (Zod)
   - `WorkflowDefinition` passes `WorkflowDefinitionSchema`
   - Layout script syntax check via `bun --check` (no execution)
3. An Action Inbox message of type `artifact_review` is created showing:
   playbook name, author, description, required capabilities, tools used,
   whether a layout script is present, and Install / Cancel actions
4. User approves from Inbox → playbook installed to `~/.tessera/playbooks/<id>/`
5. Installed playbook becomes available for workspace activation

---

## 5. Reference Use Cases (tessera-playbooks repo)

Five playbooks authored to stress-test distinct schema patterns:

| Folder | Output | Script | Integrations | Stress-tests |
|---|---|---|---|---|
| `sales.meeting-brief` | Document (`meetingBrief`) | No | Calendar, mail, contacts | Multi-step agent, optional integrations |
| `sales.pipeline-health` | Dashboard | Yes | CRM, calendar | Dashboard output, layout generator |
| `ops.competitive-intel` | Document (`businessBrief`) | No | Web search only | Standalone, no auth required |
| `ops.vendor-invoice-triage` | Document + approval | No | Drive, mail | Tool steps, HITL write approval |
| `ops.team-okr-tracker` | Dashboard | Yes | Drive, calendar | Multi-section layout, workspace read |

### Sample Repo Structure

```
tessera-playbooks/
├── README.md                  # Authoring standard, schema reference, CI instructions
├── sales.meeting-brief/
├── sales.pipeline-health/
├── ops.competitive-intel/
├── ops.vendor-invoice-triage/
└── ops.team-okr-tracker/
```

**CI (GitHub Actions):**
- Schema validation: parse every `manifest.json` against `PlaybookManifestSchema`
- Layout script syntax: `bun --check scripts/*.ts` on every package that has scripts
- Golden tests: run layout scripts against fixture inputs, diff against `golden/` outputs
- On tag: package each folder as a `.playbook` zip and attach to the GitHub release

---

## Out of Scope for This Phase

- Scheduled / automatic refresh (manual only for now)
- Level 2 sandboxed UI bundles (iframe) — deferred to post-Phase 7 signing pipeline
- Workspace-level playbook authoring UI (edit `manifest.json` in-app)
- Playbook marketplace or discovery beyond the sample repo
- `meta.signature` population (awaits Phase 7 Workflow Compiler)
- Multi-workspace sync or cloud backup of installed playbooks
