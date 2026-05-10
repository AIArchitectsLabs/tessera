# Playbook Enhancements Design

## Decision

Extend the Playbook feature across three dimensions: (1) a folder-based playbook
package format that scales to complex authoring, (2) a Dashboard output type with
a manual-refresh pinned view powered by sidecar-side layout generator scripts,
and (3) global-install / workspace-activation portability with `.playbook` import
and export. A companion `tessera-playbooks` sample repo validates the schema
through five reference implementations covering distinct workflow shapes.

---

## Architecture

`WorkflowDefinition` evolves only through additive optional fields. A new
`PlaybookManifest` is a thin portability wrapper around it. Dashboard capability
lives inside `WorkflowOutputDeclaration` itself, so the runtime executes a
playbook the same way it executes the existing five workflows. The package
loader is the only new component between disk and the engine.

---

## 1. Playbook Package Structure

A playbook is a folder, not a single file. Authors get space for prompts,
scripts, layouts, tests, and assets. The same folder layout is used by:

- **Built-in playbooks**, bundled with the app at build time
- **Imported playbooks**, installed from a `.playbook` zip
- **Sample repo entries**, where each top-level folder is a complete package

```
pipeline-health/
├── PLAYBOOK.md              # Human-readable: purpose, authoring guide, use cases
├── manifest.json            # Meta + WorkflowDefinition (machine-readable)
├── prompts/                 # Agent step prompt files, referenced via file: prefix
│   └── draft-snapshot.md
├── layouts/                 # Static DashboardLayout JSON (fallback if no script)
│   └── dashboard.json
├── scripts/                 # Sidecar-side layout generator scripts
│   └── render-dashboard.ts  # Receives run outputs, returns DashboardLayout JSON
├── tests/
│   ├── fixtures/            # Sample inputs for test runs
│   └── golden/              # Expected DashboardLayout outputs for snapshot tests
└── assets/
    └── icon.png             # Shown on import screen and playbook catalog
```

**Rules:**
- Prompts use a magic prefix in the manifest's `prompt` field: `"file:prompts/draft-snapshot.md"`. The package loader inlines the file contents at load time so the engine never sees the indirection. `WorkflowAgentStep.prompt` stays a plain string in the runtime contract.
- Layout config lives **inside the output declaration** (see Section 2). The `outputs` block is no longer a separate map in `manifest.json`.
- If both `layout` (static path) and `layoutScript` are set on an output, the script wins. If neither is set, dashboard outputs fall back to a default raw-output renderer.
- Asset files are served by the sidecar over HTTP (see Section 4 — Asset Serving).

### Migration of existing built-in workflows

The five JSON files in `packages/core/src/workflows/*.json` are rewritten as full
playbook packages and bundled with the app under
`<appResourcesDir>/builtin-playbooks/<id>/`. The package loader treats them
identically to imported playbooks except they cannot be uninstalled and their
`meta.author` is fixed to `"Tessera"`. There is no parallel "legacy" format —
once this feature ships, all playbooks are packages.

### PLAYBOOK.md required sections

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
  schemaVersion: 1,                        // Format version for forward compat
  meta: {
    id: "sales.pipeline-health",           // Namespaced, stable, no spaces
    version: 1,                            // Integer, monotonically increasing
    name: "Pipeline Health",
    description: string,
    author?: string,
    tags?: string[],
    signature?: string,                    // Future: local signing (Phase 7)
  },
  workflow: WorkflowDefinition,            // Existing schema (additive changes only)
}
```

`exportedAt` and other export-time metadata are **not** written into
`manifest.json`. They live in a separate `EXPORT.json` written into the zip
during export and ignored on import (see Section 4 — Export).

### `WorkflowDefinition` additive changes

Two optional, backward-compatible additions:

```ts
WorkflowOutputDeclaration {
  id?: string,                             // Stable per-playbook output id (NEW)
  kind: "meetingBrief" | "businessBrief" | "statusDigest"
      | "sourceSummary" | "approvalRequest" | "dashboard",   // "dashboard" added
  label: string,
  description?: string,
  layoutScript?: string,                   // Relative path: "scripts/render.ts" (NEW)
  layout?: string,                         // Relative path: "layouts/dashboard.json" (NEW)
}
```

`id` becomes required only when a playbook declares more than one output of the
same `kind`. Keying by `id` resolves the multiple-outputs-same-kind ambiguity
that a kind-keyed map could not.

`layoutScript` and `layout` are meaningful only when `kind === "dashboard"`.
The engine ignores both fields; the package loader and the dashboard renderer
are the only consumers.

### `DashboardLayout`

The contract for static `dashboard.json` files and layout script return values:

```ts
{
  refreshLabel?: string,                   // Button copy, e.g. "Refresh pipeline"
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

### Layout generator script contract

```ts
// Input passed via stdin as JSON
type RenderInput = {
  outputs: Record<string, unknown>;        // Keyed by step id
  meta: { runId: string; completedAt: string; playbookId: string }
}

// Script must export a default function
export default function render(input: RenderInput): DashboardLayout { ... }
```

### Layout script execution

The sidecar runs the script using `Bun.spawn` with the following constraints:

1. **Process isolation only** — the script runs as a separate Bun process with
   no shared memory or handles to the sidecar. This is *not* an OS-level
   sandbox; the script can in principle read files, open network sockets, and
   spawn children. Treat it as untrusted code that you have chosen to run.
2. **Hard timeout: 5 seconds.** On timeout, the spawn is killed and the run
   completes successfully but with `dashboardLayout: null`. The UI falls back
   to a raw-outputs renderer and shows a "Layout generation failed" notice.
3. **Output validation.** Stdout is parsed as JSON and validated against
   `DashboardLayoutSchema` (Zod). Validation failures use the same fallback as
   timeout.
4. **No bundled dependencies.** Scripts may import from Node/Bun stdlib only.
   The sidecar runs the script with `--no-install` and rejects packages with a
   `node_modules` directory or any non-stdlib import.
5. **Result is persisted alongside the run record** (new SQLite column
   `dashboard_layout_json` on `workflow_runs`).

OS-level sandboxing (`sandbox-exec` on macOS, `landlock`/`seccomp` on Linux,
AppContainer on Windows) is tracked as a follow-up under Phase 7's signing and
sandboxing work and is explicitly out of scope for this phase. The Action Inbox
`artifact_review` flow (Section 4) is the user-consent layer that compensates
for the absence of OS sandboxing in this phase.

### Workspace playbook config

A new file `<workspaceRoot>/.tessera/playbook-config.json`:

```ts
{
  schemaVersion: 1,
  activatedPlaybooks: string[],            // Installed playbook ids active in this workspace
}
```

Created lazily on first workspace open after this feature ships. Built-in
playbooks are auto-activated in every workspace by default; their ids are
included in `activatedPlaybooks` on creation.

---

## 3. Dashboard UX & Refresh

### Catalog

Dashboard playbooks show a `Dashboard` badge in the catalog.

Once run at least once in the current workspace, dashboard playbooks pin to a
**Dashboards** section at the top of the catalog, above one-shot document
playbooks. A never-run dashboard appears in the main catalog.

### Guided flow

Dashboard playbooks reuse the existing four-state guided flow
(Start → Preparing → Review → Result). Only the Result state differs:

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

### Refresh behaviour

- Refresh re-runs the full workflow with the inputs from the last successful run
- The intake form is pre-filled with previous inputs; the user may edit before confirming
- While refreshing, the existing snapshot stays visible — no blank/loading flash
- "Last updated" label becomes "Refreshing…" during the run
- On completion the layout re-renders in place
- On failure the old snapshot is preserved with a "Refresh failed" notice
- Each refresh is a new run record in SQLite — full history is retained
- The dashboard always displays the most recent successfully completed run
- **Concurrent refresh:** if Refresh is clicked while a refresh is already in
  flight, the second click is dropped and a "Refresh already in progress" toast
  is shown. No queueing, no parallel runs.

---

## 4. Import / Export / Lifecycle

### Scope: global install, workspace activation

Playbooks are installed once at the Tessera level in
`~/.tessera/playbooks/<id>/` (the same `TESSERA_DATA_DIR` root the sidecar
already uses). Each workspace's `activatedPlaybooks` list controls which
installed playbooks appear in that workspace's catalog. Run history is always
workspace-scoped regardless of install scope.

### Activation UX

- On import, the new playbook is **auto-activated in the current workspace only**
- Catalog has a per-playbook "Available in this workspace" toggle
- Workspace Settings shows a multi-select list of all installed playbooks for bulk activation/deactivation

### Export

- Catalog context menu: "Export playbook…"
- Tessera zips the package folder and adds an `EXPORT.json` at the zip root:
  ```ts
  {
    schemaVersion: 1,
    exportedAt: string,                    // ISO timestamp
    exporterVersion: string,               // Tessera app version
    format: "tessera.playbook",
  }
  ```
- The package's own `manifest.json` is **not modified** during export
- File saved as `<id>-v<version>.playbook`
- Only package contents are exported — no run history, no credentials, no workspace data
- `meta.signature` will be populated here once local signing (Phase 7) exists

### Import

1. User drops a `.playbook` file or picks via file dialog
2. Tessera unzips to a staging directory and validates:
   - `EXPORT.json` schema (used for display only — version, exporter)
   - `manifest.json` parses and passes `PlaybookManifestSchema` (Zod)
   - `WorkflowDefinition` passes `WorkflowDefinitionSchema`
   - All file references in the manifest resolve (prompts, layouts, scripts)
   - Layout scripts pass syntax check via `bun build --no-bundle --target=bun`
     (parse only, no execution)
3. **Version conflict resolution.** If `<id>` already installed:
   - Same version → reject with "already installed"
   - Older version → reject with "newer version installed"
   - Newer version → flag as upgrade in the inbox message
4. An Action Inbox message of type `artifact_review` is created showing:
   playbook name, author, version, description, required capabilities, tools
   used, layout script presence, upgrade indicator (if applicable), and
   Install / Cancel actions
5. User approves from Inbox → staged package is moved to
   `~/.tessera/playbooks/<id>/`. On upgrade, the previous version directory is
   replaced atomically (rename to `.old`, move new in, delete `.old` on success)
6. The id is added to the current workspace's `activatedPlaybooks`. Other
   workspaces that previously had the id activated keep the entry (it now
   points to the new version)

### Uninstall

- Catalog context menu: "Remove playbook…"
- Confirmation dialog lists the workspaces where the playbook is currently activated
- On confirm: delete `~/.tessera/playbooks/<id>/`, remove the id from every
  workspace's `activatedPlaybooks` list
- Built-in playbooks cannot be uninstalled (Remove option hidden)

### Built-in playbook upgrades

When the app version bumps and a bundled built-in playbook's manifest changes,
Tessera silently picks up the new version on next launch. The package loader
diffs the bundled `<appResourcesDir>/builtin-playbooks/<id>/manifest.json`
against any cached copy and refreshes its in-memory registry without prompting
the user. Imported playbooks are never touched by app upgrades — they remain at
the version the user explicitly imported.

### Asset serving

The sidecar exposes `GET /playbooks/:id/assets/:filename` returning the file
from the playbook's `assets/` directory. Bearer token required (same auth as
all other sidecar endpoints). The Tauri webview's CSP already permits
`connect-src 'self' ipc: http://ipc.localhost`, so the UI loads icons via the
sidecar URL injected at boot. Path traversal is blocked (asset filenames must
match `^[a-zA-Z0-9._-]+$`).

### Sample repo install path

For this phase, the sample repo (`tessera-playbooks`) supports manual install
only:

1. User browses the GitHub repo or releases page
2. Downloads a `.playbook` zip from a tagged release
3. Imports via the local file drop / dialog flow above

In-app sample-repo browsing and one-click install is tracked as a follow-up
and is out of scope for this phase.

---

## 5. Reference Use Cases (`tessera-playbooks` repo)

Five playbooks authored to stress-test distinct schema patterns. None require
integrations that don't already exist in Tessera (Google Workspace + brave-search).

| Folder | Output | Script | Integrations | Stress-tests |
|---|---|---|---|---|
| `sales.meeting-brief` | Document (`meetingBrief`) | No | Calendar, mail, contacts | Multi-step agent, optional integrations |
| `sales.pipeline-health` | Dashboard | Yes | Drive (Sheets-as-CRM), calendar | Dashboard output, layout generator |
| `ops.competitive-intel` | Document (`businessBrief`) | No | Web search only | Standalone, no auth required |
| `ops.vendor-invoice-triage` | Document + approval | No | Drive, mail | Tool steps, HITL write approval |
| `ops.team-okr-tracker` | Dashboard | Yes | Drive, calendar | Multi-section layout, workspace read |

`sales.pipeline-health` uses a Google Sheet as an informal CRM source — the
playbook documents the expected sheet column shape in `PLAYBOOK.md` so users
can adapt their own sheet. A first-class CRM integration is out of scope.

### Sample repo structure

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
- Layout script syntax: `bun build --no-bundle --target=bun scripts/*.ts` on packages with scripts
- Golden tests: run layout scripts against fixture inputs, diff against `golden/` outputs
- On tag: package each folder as a `.playbook` zip and attach to the GitHub release

---

## Out of Scope for This Phase

- Scheduled / automatic refresh (manual only for now)
- OS-level sandboxing of layout scripts (process isolation + Inbox consent only)
- Level 2 sandboxed UI bundles (iframe) — deferred to post-Phase 7 signing pipeline
- Workspace-level playbook authoring UI (edit `manifest.json` in-app)
- In-app sample-repo browsing or one-click install
- `meta.signature` population (awaits Phase 7 Workflow Compiler)
- Multi-workspace sync or cloud backup of installed playbooks
- First-class CRM integration (Sheets-as-CRM is the documented pattern)
