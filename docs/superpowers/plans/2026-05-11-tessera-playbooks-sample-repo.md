# Tessera Playbooks Sample Repo Implementation Plan (Sub-plan D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a separate `tessera-playbooks` GitHub repository with five reference playbook packages, an authoring guide, and CI that validates each package against `PlaybookManifestSchema`, syntax-checks layout scripts, runs golden tests, and publishes `.playbook` zips as GitHub release artifacts.

**Architecture:** Standalone repo, no monorepo coupling. Each top-level folder is a complete playbook package (same shape as the built-ins in the Tessera repo). A small validation tool (run from the Tessera contracts package via `bunx` or a published CLI) loads each manifest, runs `loadPlaybookPackageFromDisk`, and asserts schema compliance. GitHub Actions on each PR runs validation + syntax checks + golden tests. On tag, a release workflow zips each folder into a `.playbook` file and attaches them to the GitHub release.

**Tech Stack:** TypeScript / Bun for validators and CI scripts. Markdown for `PLAYBOOK.md`. JSON for manifests and layouts. GitHub Actions for CI.

**Depends on:** Sub-plans A, B, C — merged. The `.playbook` import flow (sub-plan C) is needed before authors can usefully consume this repo.

**Spec reference:** `docs/superpowers/specs/2026-05-10-playbook-enhancements-design.md` Section 5 (Reference Use Cases).

**Out of scope:** Hosting decisions (GitHub repo only — no separate package registry), in-app browsing of the repo (sub-plan C also defers this), publishing to npm, automatic version bumps on tag.

---

## Repo Layout

```
tessera-playbooks/
├── README.md                          # Project intro + authoring standard
├── AUTHORING.md                       # Detailed authoring guide (PLAYBOOK.md required sections, binding semantics, layout script contract)
├── package.json                       # bun dependencies for the validator + CI scripts
├── tsconfig.json
├── tools/
│   ├── validate.ts                    # Validates every playbook folder against PlaybookManifestSchema
│   ├── package.ts                     # Zips each folder into a .playbook release artifact
│   └── golden.ts                      # Runs layout scripts against tests/fixtures and compares to tests/golden
├── .github/
│   └── workflows/
│       ├── validate.yml               # Runs on every PR: schema validation, syntax checks, golden tests
│       └── release.yml                # Runs on tag: builds .playbook zips, attaches to release
├── sales.meeting-brief/               # Reference playbook: multi-step agent, optional integrations
├── sales.pipeline-health/             # Reference playbook: dashboard + layout script
├── ops.competitive-intel/             # Reference playbook: web-only, standalone
├── ops.vendor-invoice-triage/         # Reference playbook: tool steps + write approval
└── ops.team-okr-tracker/              # Reference playbook: dashboard + multi-section + workspace read
```

---

## Task 1: Initialize the repository

**Files:** new GitHub repo `tessera-playbooks`, all root-level scaffolding.

NOTE: This task is executed OUTSIDE the Tessera repo. The implementer will create a new directory (e.g., `~/Code/projects/tessera-playbooks`) and `git init` it. Coordinate with the user before pushing to GitHub — the user owns the org / account.

- [ ] **Step 1: Ask the user where to create the repo**

If running interactively, ask: "Where should I create the `tessera-playbooks` directory? (default: a sibling of the Tessera repo at `~/Code/projects/tessera-playbooks`)". If the implementer cannot ask, use the default and report it.

- [ ] **Step 2: Initialize**

```bash
mkdir -p ~/Code/projects/tessera-playbooks
cd ~/Code/projects/tessera-playbooks
git init
```

- [ ] **Step 3: Author `README.md`**

```markdown
# Tessera Playbooks

A collection of reference playbook packages for the [Tessera](https://github.com/<org>/tessera) Agent Workspace. Each folder is a fully self-contained playbook — drop the corresponding `.playbook` zip from the latest release into Tessera to install.

## What is a playbook?

A repeatable business job that Tessera prepares with your context. Playbooks declare a workflow, a set of agent prompts, optional dashboard layouts, and the integrations they need. Tessera runs them, surfaces results, and lets you refresh dashboards on demand.

## Reference playbooks

| Playbook | Purpose | Type |
|---|---|---|
| `sales.meeting-brief` | Prepare for a customer or prospect meeting | Document |
| `sales.pipeline-health` | Refreshable pipeline-health dashboard from a Google Sheet | Dashboard |
| `ops.competitive-intel` | Public-web competitive brief on a target company | Document |
| `ops.vendor-invoice-triage` | Triage and stage vendor invoices for approval | Document + approval |
| `ops.team-okr-tracker` | Refreshable team OKR tracker dashboard | Dashboard |

## Installing a playbook

1. Open the [Releases page](https://github.com/<org>/tessera-playbooks/releases) and download the `.playbook` zip you want.
2. In Tessera, open the Playbooks page → Import.
3. Pick the file. Review the import card in the Inbox.
4. Approve to install. The playbook appears in your catalog.

## Authoring your own

See `AUTHORING.md` for the full guide.
```

- [ ] **Step 4: Author `AUTHORING.md`**

Cover: folder layout, `PLAYBOOK.md` required sections (copied from the design spec), `manifest.json` shape with examples, prompt file conventions (`file:prompts/...`), dashboard layout schema with each section type, layout-script contract (RenderInput / DashboardLayout, 5s timeout, no network / no fs / no children), test conventions (`tests/fixtures` + `tests/golden`), and how to run validation locally.

- [ ] **Step 5: package.json + tsconfig.json**

`package.json`:

```json
{
  "name": "tessera-playbooks-tools",
  "private": true,
  "type": "module",
  "scripts": {
    "validate": "bun run tools/validate.ts",
    "golden": "bun run tools/golden.ts",
    "package": "bun run tools/package.ts"
  },
  "dependencies": {
    "@tessera/contracts": "github:<org>/tessera#main&path:packages/contracts",
    "@tessera/core": "github:<org>/tessera#main&path:packages/core",
    "zod": "^3.23.8"
  }
}
```

(Adjust the GitHub paths once the Tessera repo's package locations are confirmed. If the contracts/core packages aren't yet published as installable Git deps, fall back to vendoring the schemas into a small `tools/schemas.ts` for now.)

`tsconfig.json` mirrors Tessera's strict config.

- [ ] **Step 6: First commit**

```bash
git add README.md AUTHORING.md package.json tsconfig.json
git commit -m "chore: initialize tessera-playbooks scaffold"
```

---

## Task 2: Validation tool

The validator walks each top-level directory, calls `loadPlaybookPackageFromDisk` (from `@tessera/core`), and reports any failures. It also runs `bun build --no-bundle --target=bun` against any `scripts/*.ts` files to syntax-check them without executing.

**Files:**
- Create: `tools/validate.ts`

- [ ] **Step 1: Implement**

```ts
#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadPlaybookPackageFromDisk } from "@tessera/core";

const repoRoot = join(import.meta.dir, "..");
const failures: string[] = [];

for (const name of readdirSync(repoRoot)) {
  if (name.startsWith(".") || name === "tools" || name === "node_modules") continue;
  const full = join(repoRoot, name);
  if (!statSync(full).isDirectory()) continue;
  try {
    const manifest = loadPlaybookPackageFromDisk(full);
    console.log(`✓ ${name} — id=${manifest.meta.id} v${manifest.meta.version}`);
  } catch (err) {
    failures.push(`✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Syntax-check any scripts/
  const scriptsDir = join(full, "scripts");
  try {
    const scripts = readdirSync(scriptsDir).filter((f) => f.endsWith(".ts"));
    for (const script of scripts) {
      const result = Bun.spawnSync(["bun", "build", "--no-bundle", "--target=bun", join(scriptsDir, script)]);
      if (result.exitCode !== 0) {
        failures.push(`✗ ${name}/scripts/${script}: ${new TextDecoder().decode(result.stderr)}`);
      }
    }
  } catch {
    // No scripts directory — fine
  }
}

if (failures.length > 0) {
  console.error("\nValidation failures:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log("\nAll playbooks valid.");
```

- [ ] **Step 2: Commit**

```bash
git add tools/validate.ts
git commit -m "feat: validate.ts — schema + script syntax check"
```

---

## Task 3: Golden-tests tool

For each playbook with a layout script, run the script against `tests/fixtures/*.json` and compare the resulting layout to `tests/golden/*.json`.

**Files:**
- Create: `tools/golden.ts`

- [ ] **Step 1: Implement**

```ts
#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const failures: string[] = [];

for (const name of readdirSync(repoRoot)) {
  if (name.startsWith(".") || name === "tools" || name === "node_modules") continue;
  const root = join(repoRoot, name);
  if (!statSync(root).isDirectory()) continue;

  const fixturesDir = join(root, "tests", "fixtures");
  const goldenDir = join(root, "tests", "golden");
  const scriptsDir = join(root, "scripts");
  if (!existsSync(fixturesDir) || !existsSync(goldenDir) || !existsSync(scriptsDir)) continue;

  const scripts = readdirSync(scriptsDir).filter((f) => f.endsWith(".ts"));
  for (const script of scripts) {
    const scriptPath = join(scriptsDir, script);
    const baseName = script.replace(/\.ts$/, "");
    for (const fixtureName of readdirSync(fixturesDir)) {
      if (!fixtureName.endsWith(".json")) continue;
      const fixturePath = join(fixturesDir, fixtureName);
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
      const proc = Bun.spawnSync({
        cmd: ["bun", "run", scriptPath],
        stdin: new TextEncoder().encode(JSON.stringify(fixture)),
      });
      if (proc.exitCode !== 0) {
        failures.push(`✗ ${name}/${script} on ${fixtureName}: exit ${proc.exitCode} — ${new TextDecoder().decode(proc.stderr)}`);
        continue;
      }
      const got = JSON.parse(new TextDecoder().decode(proc.stdout));
      const goldenPath = join(goldenDir, `${baseName}.${fixtureName}`);
      if (!existsSync(goldenPath)) {
        failures.push(`✗ ${name}/${script}: missing golden ${goldenPath}`);
        continue;
      }
      const expected = JSON.parse(readFileSync(goldenPath, "utf8"));
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        failures.push(`✗ ${name}/${script} on ${fixtureName}: layout mismatch`);
      } else {
        console.log(`✓ ${name}/${script} on ${fixtureName}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("\nGolden failures:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log("\nAll golden tests pass.");
```

- [ ] **Step 2: Commit**

```bash
git add tools/golden.ts
git commit -m "feat: golden.ts — layout script golden tests"
```

---

## Task 4: Packaging tool

Zip each top-level folder into a `<id>-v<version>.playbook` file. Used by the release workflow.

**Files:**
- Create: `tools/package.ts`

- [ ] **Step 1: Implement**

```ts
#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const outDir = join(repoRoot, "dist");
mkdirSync(outDir, { recursive: true });

for (const name of readdirSync(repoRoot)) {
  if (name.startsWith(".") || name === "tools" || name === "node_modules" || name === "dist") continue;
  const root = join(repoRoot, name);
  if (!statSync(root).isDirectory()) continue;

  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const version = manifest.meta.version;
  const id = manifest.meta.id;
  const tempRoot = join(tmpdir(), `pack-${id}-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });

  cpSync(root, tempRoot, { recursive: true });
  writeFileSync(
    join(tempRoot, "EXPORT.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        exporterVersion: "tessera-playbooks/ci",
        format: "tessera.playbook",
      },
      null,
      2
    ) + "\n"
  );

  const outFile = join(outDir, `${id}-v${version}.playbook`);
  const result = Bun.spawnSync(["zip", "-r", outFile, "."], { cwd: tempRoot });
  if (result.exitCode !== 0) {
    console.error(`✗ ${id}: zip failed`);
    process.exit(1);
  }
  rmSync(tempRoot, { recursive: true });
  console.log(`✓ ${outFile}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add tools/package.ts
git commit -m "feat: package.ts — build .playbook release artifacts"
```

---

## Task 5: Author `sales.meeting-brief`

Mirror the Tessera built-in `sales.meeting-brief` package as a sample-repo entry. The point is to give authors a complete reference. Include `PLAYBOOK.md` (the built-in doesn't have one).

**Files:**
- Create: `sales.meeting-brief/PLAYBOOK.md`
- Create: `sales.meeting-brief/manifest.json`
- Create: `sales.meeting-brief/prompts/draft-brief.md`

- [ ] **Step 1: Copy the manifest and prompt from Tessera**

Copy `packages/core/src/builtin-playbooks/sales.meeting-brief/manifest.json` from the Tessera repo to `sales.meeting-brief/manifest.json` in the playbooks repo. Copy the prompt file similarly.

- [ ] **Step 2: Author `PLAYBOOK.md`**

Use the required-sections template from the spec. Document the inputs, what gets produced, the integrations (calendar / mail / contacts) and the fact that the playbook works without any of them.

- [ ] **Step 3: Add fixtures + golden tests (none needed — no layout script)**

This playbook produces a document, not a dashboard, so `tests/` is empty. The validator still parses the manifest.

- [ ] **Step 4: Commit**

```bash
bun run validate
git add sales.meeting-brief
git commit -m "feat: add sales.meeting-brief reference playbook"
```

---

## Task 6: Author `sales.pipeline-health` (dashboard + layout script)

The flagship dashboard example. Reads a Google Sheet (acting as an informal CRM source — column names documented in `PLAYBOOK.md`), produces a structured snapshot, and a layout script renders it.

**Files:**
- Create: `sales.pipeline-health/PLAYBOOK.md`
- Create: `sales.pipeline-health/manifest.json`
- Create: `sales.pipeline-health/prompts/draft-snapshot.md`
- Create: `sales.pipeline-health/scripts/render-dashboard.ts`
- Create: `sales.pipeline-health/tests/fixtures/example-snapshot.json`
- Create: `sales.pipeline-health/tests/golden/render-dashboard.example-snapshot.json`

- [ ] **Step 1: Author the manifest**

Inputs: `sheetUrl` (the Google Sheet to read), `team` (label for the snapshot).

Outputs: one `kind: "dashboard"` declaration referencing `scripts/render-dashboard.ts`.

Steps: one tool step that reads the sheet via the existing `drive` capability, one agent step that synthesizes a snapshot from the rows.

- [ ] **Step 2: Author the prompt**

Tell the agent to output a JSON object: `{ openDeals: number, atRisk: number, riskItems: [{ name, daysToRenewal }], movementSummary: string, deals: [{ name, stage, owner, lastTouch }] }`.

- [ ] **Step 3: Write the layout script**

```ts
type RenderInput = {
  outputs: Record<string, unknown>;
  meta: { runId: string; completedAt: string; playbookId: string };
};

type DashboardLayout = {
  refreshLabel?: string;
  sections: Array<
    | { type: "metrics"; title?: string; items: { label: string; binding: string; unit?: string }[] }
    | { type: "list"; title: string; binding: string; emptyLabel?: string }
    | { type: "text"; title: string; binding: string }
    | { type: "table"; title: string; binding: string; columns: { key: string; label: string }[] }
  >;
};

const input = JSON.parse(await Bun.stdin.text()) as RenderInput;
const snapshot = (input.outputs as Record<string, unknown>).draftSnapshot as Record<string, unknown> | undefined;
const atRisk = typeof snapshot?.atRisk === "number" ? snapshot.atRisk : 0;

const layout: DashboardLayout = {
  refreshLabel: "Refresh pipeline",
  sections: [
    {
      type: "metrics",
      title: "Pipeline",
      items: [
        { label: "Open deals", binding: "draftSnapshot.openDeals" },
        { label: "At-risk renewals", binding: "draftSnapshot.atRisk" },
      ],
    },
    ...(atRisk > 0
      ? [{ type: "list" as const, title: "At-risk accounts", binding: "draftSnapshot.riskItems", emptyLabel: "No accounts at risk." }]
      : []),
    { type: "text", title: "This week", binding: "draftSnapshot.movementSummary" },
    {
      type: "table",
      title: "Open deals",
      binding: "draftSnapshot.deals",
      columns: [
        { key: "name", label: "Account" },
        { key: "stage", label: "Stage" },
        { key: "owner", label: "Owner" },
        { key: "lastTouch", label: "Last touch" },
      ],
    },
  ],
};

process.stdout.write(JSON.stringify(layout));
```

- [ ] **Step 4: Author fixture + golden**

Fixture (`tests/fixtures/example-snapshot.json`):

```json
{
  "outputs": {
    "draftSnapshot": {
      "openDeals": 14,
      "atRisk": 3,
      "riskItems": [{ "name": "Acme", "daysToRenewal": 12 }, { "name": "Globex", "daysToRenewal": 30 }, { "name": "Initech", "daysToRenewal": 7 }],
      "movementSummary": "Three deals advanced to proposal stage this week.",
      "deals": [{ "name": "Acme", "stage": "Proposal", "owner": "Pat", "lastTouch": "2 days ago" }]
    }
  },
  "meta": { "runId": "fixture", "completedAt": "2026-05-11T00:00:00.000Z", "playbookId": "sales.pipeline-health" }
}
```

Golden file: run the script once with the fixture, capture the output, save it as `tests/golden/render-dashboard.example-snapshot.json`. (The implementer should generate this by running `bun run scripts/render-dashboard.ts < tests/fixtures/example-snapshot.json` and pasting the output.)

- [ ] **Step 5: PLAYBOOK.md**

Document the Google Sheet column expectations: `account`, `stage`, `owner`, `last_touch`, `renewal_date`. Show an example sheet structure.

- [ ] **Step 6: Validate + commit**

```bash
bun run validate
bun run golden
git add sales.pipeline-health
git commit -m "feat: add sales.pipeline-health dashboard playbook"
```

---

## Task 7: Author `ops.competitive-intel`

A standalone playbook — uses only the existing `web` capability (Brave Search / web fetch). No integrations required, so it works in any workspace.

**Files:**
- Create: `ops.competitive-intel/PLAYBOOK.md`
- Create: `ops.competitive-intel/manifest.json`
- Create: `ops.competitive-intel/prompts/draft-intel.md`

- [ ] **Step 1: Author the manifest**

Inputs: `targetCompany` (string), `focusAreas` (string array).

Outputs: one `kind: "businessBrief"` declaration. No dashboard, no script.

Steps: one agent step using `web` capability to research the company.

- [ ] **Step 2: Prompt + PLAYBOOK.md**

Document that this playbook needs only the Brave Search integration. No mail / calendar / drive required.

- [ ] **Step 3: Validate + commit**

```bash
bun run validate
git add ops.competitive-intel
git commit -m "feat: add ops.competitive-intel reference playbook"
```

---

## Task 8: Author `ops.vendor-invoice-triage`

Showcases the HITL write-approval pattern. Tool steps read invoices from Drive, the agent classifies them, a final tool step writes a triage doc that pauses for user approval before being committed.

**Files:**
- Create: `ops.vendor-invoice-triage/PLAYBOOK.md`
- Create: `ops.vendor-invoice-triage/manifest.json`
- Create: `ops.vendor-invoice-triage/prompts/classify-invoices.md`

- [ ] **Step 1: Author the manifest**

Inputs: `month` (e.g., "2026-05"), `driveFolderId` (string).

Outputs: `meetingBrief`-style document + `approvalRequest`.

Steps:
1. `tool: drive.search` to list invoices in the month
2. `tool: drive.read` (per invoice) to fetch contents
3. `agent`: classify and summarize
4. `tool: workspace.writeProbe` (write-approval step — pauses execution)

- [ ] **Step 2: Prompt + PLAYBOOK.md**

Document required integrations: Drive (read), workspace write.

- [ ] **Step 3: Validate + commit**

```bash
bun run validate
git add ops.vendor-invoice-triage
git commit -m "feat: add ops.vendor-invoice-triage reference playbook"
```

---

## Task 9: Author `ops.team-okr-tracker`

Second dashboard reference. Reads OKR data from a Google Doc / Sheet, produces a refreshable view.

**Files:**
- Create: `ops.team-okr-tracker/PLAYBOOK.md`
- Create: `ops.team-okr-tracker/manifest.json`
- Create: `ops.team-okr-tracker/prompts/draft-okr-snapshot.md`
- Create: `ops.team-okr-tracker/scripts/render-dashboard.ts`
- Create: `ops.team-okr-tracker/tests/fixtures/example-okrs.json`
- Create: `ops.team-okr-tracker/tests/golden/render-dashboard.example-okrs.json`

- [ ] **Step 1: Manifest**

Inputs: `okrDocUrl`, `quarter`.

Outputs: `kind: "dashboard"` with `layoutScript: "scripts/render-dashboard.ts"`.

- [ ] **Step 2: Script**

Render four sections: a metrics block (OKRs on track / at-risk / off-track counts), a list of at-risk OKRs, a table of key results, a text summary.

- [ ] **Step 3: Fixtures + golden**

- [ ] **Step 4: PLAYBOOK.md + commit**

```bash
bun run validate
bun run golden
git add ops.team-okr-tracker
git commit -m "feat: add ops.team-okr-tracker dashboard playbook"
```

---

## Task 10: GitHub Actions CI

**Files:**
- Create: `.github/workflows/validate.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: validate.yml**

```yaml
name: validate
on:
  pull_request:
  push:
    branches: [main]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run validate
      - run: bun run golden
```

- [ ] **Step 2: release.yml**

```yaml
name: release
on:
  push:
    tags: ["v*"]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run validate
      - run: bun run package
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/*.playbook
          generate_release_notes: true
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows
git commit -m "ci: validate on PR, release .playbook artifacts on tag"
```

---

## Task 11: First release

- [ ] **Step 1: Push to GitHub**

Confirm with the user the repo name and org. Then:

```bash
git remote add origin git@github.com:<org>/tessera-playbooks.git
git push -u origin main
```

- [ ] **Step 2: Tag and push**

```bash
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **Step 3: Verify release artifacts**

Wait for the release workflow to complete. Check the GitHub Releases page — confirm five `.playbook` files are attached.

- [ ] **Step 4: End-to-end import test**

Download one `.playbook` file from the release. In the Tessera desktop app, use the Import dropzone to install it. Confirm:
- Inbox shows the artifact_review message
- Approval installs the playbook to `~/.tessera/playbooks/<id>/`
- The playbook appears in the catalog and can be run

If any of the five playbooks fails to import or run, file an issue in `tessera-playbooks` describing the failure, then fix it as a follow-up commit / new tag.

---

## Self-Review Notes

- **Spec coverage:** Section 5 — five reference playbooks with the exact use cases from the spec table.
- **Dependencies:** This sub-plan assumes sub-plans B and C are merged and shipped — without B, dashboard playbooks have no rendering target; without C, there is no import path.
- **Integration assumptions:** The dashboard playbooks use Google Sheets / Drive — these depend on the existing Google Workspace integration in Tessera. If a user hasn't configured Google Workspace, they should be able to install the playbook (it won't fail validation) but running it will surface an "integration unavailable" error from Tessera. This is the expected graceful-degradation behavior.
- **CI risk:** The validator depends on `@tessera/core` being installable as a Git dependency. If that's not possible (private repo, monorepo path), Task 1 Step 5 falls back to vendoring schemas into `tools/schemas.ts`. The implementer should pick the simplest approach that works at the time.
- **Cross-platform:** The packaging tool uses system `zip`. GitHub Actions runners have it; local users running `bun run package` need it. Worth noting in `AUTHORING.md`.
- **Future work (not in this plan):** A small Tessera-side "Browse sample repo" command that fetches the latest GitHub release and offers one-click install. Out of scope for D.
