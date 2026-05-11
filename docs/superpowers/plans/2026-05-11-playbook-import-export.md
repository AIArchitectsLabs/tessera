# Playbook Import / Export + Workspace Activation Implementation Plan (Sub-plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make playbooks portable: export an installed playbook as a `.playbook` zip, import a `.playbook` from disk through an Action Inbox `artifact_review` flow, install to `~/.tessera/playbooks/<id>/`, manage version conflicts, support uninstall, expose asset files via the sidecar, and let each workspace activate or deactivate which installed playbooks appear in its catalog.

**Architecture:** A new disk-based package loader reads imported playbook folders at sidecar boot and refreshes on import/uninstall. Built-in playbooks continue to be statically imported (no behavior change). A new `WorkspacePlaybookConfigSchema` describes the per-workspace `activatedPlaybooks` list, stored at `<workspaceRoot>/.tessera/playbook-config.json`. Asset files are served by a new authenticated sidecar route. Import validation runs at unzip time (Zod parse + `bun build --no-bundle` syntax check for any layout scripts); the user approves via an `artifact_review` inbox message before files move from staging to the install directory.

**Tech Stack:** TypeScript strict, Bun, Zod, Bun zlib zip support (or `adm-zip` if needed), SQLite, React, Biome, Tauri.

**Depends on:** Sub-plan A (folder-based packages) — merged. Sub-plan B (dashboard output kind) — recommended but not strictly required.

**Spec reference:** `docs/superpowers/specs/2026-05-10-playbook-enhancements-design.md` Sections 1 (Package Structure), 2 (Schema — `WorkspacePlaybookConfig`), 4 (Import / Export / Lifecycle).

**Out of scope:** In-app sample-repo browsing, GitHub release auto-fetching, local signing (`meta.signature`), OS-level sandboxing of layout scripts.

---

## File Structure

**New files:**
- `packages/contracts/src/index.ts` — Add `WorkspacePlaybookConfigSchema`, `PlaybookExportMetadataSchema`, `PlaybookInstallSourceSchema`
- `packages/core/src/disk-playbook-loader.ts` — Reads a playbook package from a directory on disk
- `packages/core/src/disk-playbook-loader.test.ts` — Tests
- `apps/sidecar/src/playbook-installer.ts` — Zip unpack, validation pipeline, install to `~/.tessera/playbooks/<id>/`
- `apps/sidecar/src/playbook-installer.test.ts` — Tests
- `apps/sidecar/src/playbook-exporter.ts` — Zip a package folder + EXPORT.json
- `apps/sidecar/src/playbook-exporter.test.ts` — Tests
- `apps/sidecar/src/workspace-playbook-config.ts` — Read/write `<workspaceRoot>/.tessera/playbook-config.json`
- `apps/sidecar/src/workspace-playbook-config.test.ts` — Tests
- `apps/sidecar/src/asset-router.ts` — Sidecar HTTP route for `/playbooks/:id/assets/:filename` with path-traversal guard
- `apps/sidecar/src/asset-router.test.ts` — Tests
- `apps/desktop/ui/src/components/PlaybookImportDropzone.tsx` — File picker / drag-drop entry point
- `apps/desktop/ui/src/components/PlaybookImportDropzone.test.tsx` — Tests
- `apps/desktop/ui/src/components/WorkspacePlaybookSettings.tsx` — Multi-select activation list in Workspace Settings
- `apps/desktop/ui/src/components/WorkspacePlaybookSettings.test.tsx` — Tests

**Modified files:**
- `apps/sidecar/src/server.ts` — Add routes: `POST /playbooks/import`, `POST /playbooks/export`, `DELETE /playbooks/:id`, `GET /playbooks/:id/assets/:filename`, `GET /workspaces/:root/playbook-config`, `PUT /workspaces/:root/playbook-config`; refresh registry on install/uninstall; filter the playbook list by the workspace's `activatedPlaybooks`
- `apps/sidecar/src/inbox-store.ts` — Allow `artifact_review` message types to carry playbook-import payloads (already supported by the existing inbox schema; verify the payload shape covers what we need)
- `apps/desktop/src-tauri/src/lib.rs` — Add Tauri commands: `playbook_import`, `playbook_export`, `playbook_uninstall`, `playbook_workspace_config_get`, `playbook_workspace_config_set`
- `apps/desktop/ui/src/components/PlaybooksView.tsx` — Add Import button, per-playbook "Available in this workspace" toggle, per-playbook context menu (Export / Remove); filter catalog by workspace activation
- `apps/desktop/ui/src/components/InboxView.tsx` — Render `artifact_review` messages with playbook metadata + Install / Cancel actions

---

## Task 1: Contract additions

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/playbook-lifecycle.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `packages/contracts/src/playbook-lifecycle.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  PlaybookExportMetadataSchema,
  PlaybookInstallSourceSchema,
  WorkspacePlaybookConfigSchema,
} from "./index.js";

describe("WorkspacePlaybookConfigSchema", () => {
  test("accepts a valid config", () => {
    const cfg = WorkspacePlaybookConfigSchema.parse({
      schemaVersion: 1,
      activatedPlaybooks: ["sales.meeting-brief", "ops.activity-snapshot"],
    });
    expect(cfg.activatedPlaybooks).toHaveLength(2);
  });

  test("defaults activatedPlaybooks to empty array", () => {
    const cfg = WorkspacePlaybookConfigSchema.parse({ schemaVersion: 1 });
    expect(cfg.activatedPlaybooks).toEqual([]);
  });

  test("rejects unknown schemaVersion", () => {
    expect(() =>
      WorkspacePlaybookConfigSchema.parse({ schemaVersion: 2, activatedPlaybooks: [] })
    ).toThrow();
  });
});

describe("PlaybookExportMetadataSchema", () => {
  test("accepts export metadata", () => {
    const m = PlaybookExportMetadataSchema.parse({
      schemaVersion: 1,
      exportedAt: "2026-05-11T00:00:00.000Z",
      exporterVersion: "0.1.0",
      format: "tessera.playbook",
    });
    expect(m.format).toBe("tessera.playbook");
  });
});

describe("PlaybookInstallSourceSchema", () => {
  test("accepts builtin and imported", () => {
    expect(PlaybookInstallSourceSchema.parse("builtin")).toBe("builtin");
    expect(PlaybookInstallSourceSchema.parse("imported")).toBe("imported");
  });

  test("rejects other values", () => {
    expect(() => PlaybookInstallSourceSchema.parse("custom")).toThrow();
  });
});
```

- [ ] **Step 2: Run test, expect failure**

- [ ] **Step 3: Add schemas**

In `packages/contracts/src/index.ts`, after the existing `PlaybookManifestSchema`:

```ts
export const PlaybookInstallSourceSchema = z.enum(["builtin", "imported"]);
export type PlaybookInstallSource = z.infer<typeof PlaybookInstallSourceSchema>;

export const PlaybookExportMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  exporterVersion: z.string().min(1),
  format: z.literal("tessera.playbook"),
});
export type PlaybookExportMetadata = z.infer<typeof PlaybookExportMetadataSchema>;

export const WorkspacePlaybookConfigSchema = z.object({
  schemaVersion: z.literal(1),
  activatedPlaybooks: z.array(z.string().min(1)).default([]),
});
export type WorkspacePlaybookConfig = z.infer<typeof WorkspacePlaybookConfigSchema>;
```

- [ ] **Step 4: Run tests, commit**

```bash
bun test packages/contracts/src/playbook-lifecycle.test.ts
bun run check
git add packages/contracts/src/index.ts packages/contracts/src/playbook-lifecycle.test.ts
git commit -m "feat(contracts): add playbook lifecycle schemas (export, install source, workspace config)"
```

---

## Task 2: Disk-based playbook loader

Reads a playbook package from a directory: `manifest.json` is parsed, `prompts/*.md` are loaded into a map, and the existing `loadPlaybookManifest()` (sub-plan A) is invoked to produce the final `PlaybookManifest`.

**Files:**
- Create: `packages/core/src/disk-playbook-loader.ts`
- Create: `packages/core/src/disk-playbook-loader.test.ts`

- [ ] **Step 1: Write tests using a tmp directory fixture**

Create `packages/core/src/disk-playbook-loader.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaybookPackageFromDisk } from "./disk-playbook-loader.js";

function makePackage(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `pkg-${name}-`));
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("loadPlaybookPackageFromDisk", () => {
  test("loads a tool-only package", () => {
    const root = makePackage("tool-only", {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        meta: { id: "demo", version: 1, name: "Demo" },
        workflow: {
          id: "demo",
          version: 1,
          name: "Demo",
          start: "ping",
          inputs: {},
          steps: [{ id: "ping", kind: "tool", toolId: "workspace.ping", args: {}, onSuccess: "completed" }],
        },
      }),
    });
    const manifest = loadPlaybookPackageFromDisk(root);
    expect(manifest.meta.id).toBe("demo");
  });

  test("loads a package with prompts/ directory", () => {
    const root = makePackage("with-prompt", {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        meta: { id: "p", version: 1, name: "P" },
        workflow: {
          id: "p",
          version: 1,
          name: "P",
          start: "draft",
          inputs: {},
          steps: [{ id: "draft", kind: "agent", prompt: "file:prompts/draft.md", onSuccess: "completed" }],
        },
      }),
      "prompts/draft.md": "Draft something interesting.",
    });
    const manifest = loadPlaybookPackageFromDisk(root);
    const step = manifest.workflow.steps[0];
    if (step.kind !== "agent") throw new Error("expected agent step");
    expect(step.prompt).toBe("Draft something interesting.");
  });

  test("throws when manifest.json is missing", () => {
    const root = makePackage("no-manifest", {});
    expect(() => loadPlaybookPackageFromDisk(root)).toThrow(/manifest\.json/);
  });

  test("throws when a referenced prompt file is missing", () => {
    const root = makePackage("missing-prompt", {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        meta: { id: "x", version: 1, name: "X" },
        workflow: {
          id: "x",
          version: 1,
          name: "X",
          start: "draft",
          inputs: {},
          steps: [{ id: "draft", kind: "agent", prompt: "file:prompts/missing.md", onSuccess: "completed" }],
        },
      }),
    });
    expect(() => loadPlaybookPackageFromDisk(root)).toThrow(/missing\.md/);
  });
});
```

- [ ] **Step 2: Implement**

Create `packages/core/src/disk-playbook-loader.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PlaybookManifest } from "@tessera/contracts";
import { loadPlaybookManifest } from "./playbook-loader.js";

export function loadPlaybookPackageFromDisk(packageRoot: string): PlaybookManifest {
  const manifestPath = join(packageRoot, "manifest.json");
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`Missing manifest.json in playbook package: ${manifestPath}`);
  }
  const manifestJson: unknown = JSON.parse(manifestRaw);
  const prompts = readPromptsDirectory(join(packageRoot, "prompts"));
  return loadPlaybookManifest({ manifestJson, prompts });
}

function readPromptsDirectory(promptsRoot: string): Record<string, string> {
  let entries: string[];
  try {
    entries = readdirSync(promptsRoot);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(promptsRoot, name);
    if (!statSync(full).isFile()) continue;
    out[`prompts/${name}`] = readFileSync(full, "utf8");
  }
  return out;
}
```

Add to `packages/core/src/index.ts`:

```ts
export { loadPlaybookPackageFromDisk } from "./disk-playbook-loader.js";
```

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/core/src/disk-playbook-loader.test.ts
bun run check
git add packages/core/src/disk-playbook-loader.ts packages/core/src/disk-playbook-loader.test.ts packages/core/src/index.ts
git commit -m "feat(core): add disk-based playbook package loader"
```

---

## Task 3: Workspace playbook config store

**Files:**
- Create: `apps/sidecar/src/workspace-playbook-config.ts`
- Create: `apps/sidecar/src/workspace-playbook-config.test.ts`

- [ ] **Step 1: Tests first**

Create `apps/sidecar/src/workspace-playbook-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspacePlaybookConfig, writeWorkspacePlaybookConfig } from "./workspace-playbook-config.js";

describe("workspace playbook config", () => {
  test("returns empty config when file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const cfg = readWorkspacePlaybookConfig(root);
    expect(cfg.activatedPlaybooks).toEqual([]);
  });

  test("round-trips activated playbooks", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    writeWorkspacePlaybookConfig(root, { schemaVersion: 1, activatedPlaybooks: ["a", "b"] });
    const cfg = readWorkspacePlaybookConfig(root);
    expect(cfg.activatedPlaybooks).toEqual(["a", "b"]);
  });

  test("ignores duplicate ids on write", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    writeWorkspacePlaybookConfig(root, { schemaVersion: 1, activatedPlaybooks: ["a", "a", "b"] });
    const cfg = readWorkspacePlaybookConfig(root);
    expect(cfg.activatedPlaybooks).toEqual(["a", "b"]);
  });

  test("returns empty config when file is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const cfgPath = join(root, ".tessera", "playbook-config.json");
    writeFileSync(cfgPath, "{not-json", { flag: "w" });
    // Note: writing without mkdir will fail; the test verifies behavior when the file exists but is malformed.
    // Use writeWorkspacePlaybookConfig with a valid value first, then overwrite with garbage:
    writeWorkspacePlaybookConfig(root, { schemaVersion: 1, activatedPlaybooks: [] });
    writeFileSync(cfgPath, "{not-json");
    const cfg = readWorkspacePlaybookConfig(root);
    expect(cfg.activatedPlaybooks).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `apps/sidecar/src/workspace-playbook-config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type WorkspacePlaybookConfig, WorkspacePlaybookConfigSchema } from "@tessera/contracts";

function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".tessera", "playbook-config.json");
}

export function readWorkspacePlaybookConfig(workspaceRoot: string): WorkspacePlaybookConfig {
  const path = configPath(workspaceRoot);
  if (!existsSync(path)) {
    return { schemaVersion: 1, activatedPlaybooks: [] };
  }
  try {
    const raw = readFileSync(path, "utf8");
    return WorkspacePlaybookConfigSchema.parse(JSON.parse(raw));
  } catch {
    return { schemaVersion: 1, activatedPlaybooks: [] };
  }
}

export function writeWorkspacePlaybookConfig(
  workspaceRoot: string,
  config: WorkspacePlaybookConfig
): void {
  const path = configPath(workspaceRoot);
  mkdirSync(join(path, ".."), { recursive: true });
  const deduped: WorkspacePlaybookConfig = {
    ...config,
    activatedPlaybooks: [...new Set(config.activatedPlaybooks)],
  };
  writeFileSync(path, JSON.stringify(deduped, null, 2) + "\n");
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test apps/sidecar/src/workspace-playbook-config.test.ts
bun run check
git add apps/sidecar/src/workspace-playbook-config.ts apps/sidecar/src/workspace-playbook-config.test.ts
git commit -m "feat(sidecar): add workspace playbook config store"
```

---

## Task 4: Playbook installer module

Unpacks a `.playbook` zip into a staging directory, validates the package, moves it into `~/.tessera/playbooks/<id>/`. Detects version conflicts. Provides the inbox `artifact_review` payload.

**Files:**
- Create: `apps/sidecar/src/playbook-installer.ts`
- Create: `apps/sidecar/src/playbook-installer.test.ts`

- [ ] **Step 1: Design the API**

```ts
export interface StagedImport {
  stagingDir: string;
  manifest: PlaybookManifest;
  exportMetadata?: PlaybookExportMetadata;
  conflict?: "same-version" | "older-version" | "upgrade";
}

export async function stagePlaybookImport(options: { zipPath: string; installRoot: string }): Promise<StagedImport>;
export function installStagedPlaybook(staged: StagedImport, installRoot: string): { installedAt: string };
export function uninstallPlaybook(playbookId: string, installRoot: string): void;
```

- [ ] **Step 2: Write tests using temporary directories and zip fixtures**

The tests need to:
- Create a small playbook package in a tmp dir
- Zip it (use Bun's native zip via `node:zlib` + a small helper, or add `adm-zip` as a dependency if needed — check `package.json` first)
- Stage and install
- Test version conflicts by installing twice with different `meta.version`

For brevity in this plan, write tests for at least these scenarios:
1. Successful stage + install of a fresh package
2. Re-importing the same version returns `conflict: "same-version"`
3. Importing an older version returns `conflict: "older-version"`
4. Importing a newer version returns `conflict: "upgrade"` and replaces the install directory atomically (rename to `.old`, move new in, delete `.old`)
5. Uninstall removes the directory

- [ ] **Step 3: Implement**

Implementation outline:
- Use `Bun.spawn(["unzip", ...])` for unzip (cross-platform issue: `unzip` may not exist on Windows; add a fallback using `adm-zip` if needed). For sub-plan C scope, accept `unzip` requirement on dev machines and document it; the production path is the Tauri app which can ship `unzip` as an external binary later.
- Stage to `<TESSERA_DATA_DIR>/staging/<random-id>/`
- Validate: `loadPlaybookPackageFromDisk(stagingDir)` will throw if invalid
- If a `scripts/` directory exists, syntax-check each `.ts` file via `bun build --no-bundle --target=bun <file>`; reject on any non-zero exit
- Read `EXPORT.json` if present and parse via `PlaybookExportMetadataSchema` (optional — missing is fine for local imports)
- Compare `manifest.meta.version` against any existing install at `installRoot/<id>/manifest.json`
- `installStagedPlaybook` does the atomic rename + move

- [ ] **Step 4: Tests + commit**

```bash
bun test apps/sidecar/src/playbook-installer.test.ts
bun run check
git add apps/sidecar/src/playbook-installer.ts apps/sidecar/src/playbook-installer.test.ts
git commit -m "feat(sidecar): add playbook installer with version-conflict resolution"
```

---

## Task 5: Playbook exporter module

Zip a playbook directory + `EXPORT.json` into a `.playbook` file at a user-chosen destination.

**Files:**
- Create: `apps/sidecar/src/playbook-exporter.ts`
- Create: `apps/sidecar/src/playbook-exporter.test.ts`

- [ ] **Step 1: API**

```ts
export interface ExportPlaybookOptions {
  packageRoot: string;
  destinationPath: string;
  exporterVersion: string;
}

export async function exportPlaybook(options: ExportPlaybookOptions): Promise<{ exportedAt: string }>;
```

- [ ] **Step 2: Implementation outline**

- Create a temporary directory, copy the package contents into it (skip nothing — include `prompts/`, `scripts/`, `layouts/`, `assets/`, `tests/` if present)
- Write `EXPORT.json` at the temp root:
  ```ts
  {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exporterVersion: options.exporterVersion,
    format: "tessera.playbook",
  }
  ```
- Zip the temp directory to `options.destinationPath` (use `zip -r` via `Bun.spawn` or `adm-zip`)
- The package's own `manifest.json` is NOT modified during export

- [ ] **Step 3: Tests**

Cover at least:
- Round-trip: export then re-import produces a manifest identical to the original
- `EXPORT.json` is present in the resulting zip
- The original `manifest.json` is byte-identical before and after export
- A package with `scripts/`, `prompts/`, `layouts/`, `assets/` round-trips all four

- [ ] **Step 4: Commit**

```bash
bun test apps/sidecar/src/playbook-exporter.test.ts
bun run check
git add apps/sidecar/src/playbook-exporter.ts apps/sidecar/src/playbook-exporter.test.ts
git commit -m "feat(sidecar): add playbook exporter with EXPORT.json"
```

---

## Task 6: Asset router with path-traversal protection

**Files:**
- Create: `apps/sidecar/src/asset-router.ts`
- Create: `apps/sidecar/src/asset-router.test.ts`

- [ ] **Step 1: Tests for path-traversal protection**

Cover:
- Valid filename like `icon.png` resolves and returns 200 with correct bytes
- Filename like `../etc/passwd` is rejected with 400
- Filename with `\` is rejected with 400
- Filename with leading `/` is rejected with 400
- Unknown asset returns 404
- Unknown playbook id returns 404

- [ ] **Step 2: Implementation outline**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;

export function readPlaybookAsset(options: {
  installRoot: string;
  playbookId: string;
  filename: string;
}): { kind: "ok"; bytes: Buffer; contentType: string } | { kind: "not_found" } | { kind: "invalid_filename" } {
  if (!SAFE_FILENAME.test(options.filename)) return { kind: "invalid_filename" };
  if (!SAFE_FILENAME.test(options.playbookId)) return { kind: "invalid_filename" };
  const assetPath = resolve(options.installRoot, options.playbookId, "assets", options.filename);
  const expectedPrefix = resolve(options.installRoot, options.playbookId, "assets") + "/";
  if (!assetPath.startsWith(expectedPrefix)) return { kind: "invalid_filename" };
  if (!existsSync(assetPath)) return { kind: "not_found" };
  return {
    kind: "ok",
    bytes: readFileSync(assetPath),
    contentType: guessContentType(options.filename),
  };
}

function guessContentType(filename: string): string {
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
```

- [ ] **Step 3: Tests + commit**

```bash
bun test apps/sidecar/src/asset-router.test.ts
bun run check
git add apps/sidecar/src/asset-router.ts apps/sidecar/src/asset-router.test.ts
git commit -m "feat(sidecar): add playbook asset router with traversal guard"
```

---

## Task 7: Wire imported playbooks into the sidecar registry

The sidecar boots, loads built-in playbooks (as today), then scans `~/.tessera/playbooks/` and loads each imported package via `loadPlaybookPackageFromDisk`. Registry is rebuilt whenever an install/uninstall occurs.

**Files:**
- Modify: `apps/sidecar/src/server.ts`

- [ ] **Step 1: Add a registry refresh function**

```ts
function rebuildPlaybookRegistry() {
  // Start from built-ins (existing static imports)
  const registry = new Map<string, { definition: WorkflowDefinition; packageRoot: string }>(builtinRegistry);
  // Scan imported playbooks
  const importedRoot = join(TESSERA_DATA_DIR, "playbooks");
  if (existsSync(importedRoot)) {
    for (const id of readdirSync(importedRoot)) {
      const root = join(importedRoot, id);
      if (!statSync(root).isDirectory()) continue;
      try {
        const manifest = loadPlaybookPackageFromDisk(root);
        registry.set(manifest.workflow.id, { definition: manifest.workflow, packageRoot: root });
      } catch (err) {
        console.error(`Failed to load imported playbook ${id}:`, err);
      }
    }
  }
  return registry;
}

let playbookRegistry = rebuildPlaybookRegistry();
```

Replace the existing `workflowRegistry` initialization with `playbookRegistry`. After install/uninstall (Task 8), call `playbookRegistry = rebuildPlaybookRegistry()`.

- [ ] **Step 2: Filter the catalog by workspace activation**

`GET /playbooks?workspace=<workspaceRoot>` should:
- Read the workspace's `activatedPlaybooks` list via `readWorkspacePlaybookConfig`
- Treat all built-ins as auto-active (always included)
- Imported playbooks are included only if their id is in `activatedPlaybooks`

- [ ] **Step 3: Run tests + commit**

```bash
bun test apps/sidecar/src/
bun run check
git add apps/sidecar/src/server.ts
git commit -m "feat(sidecar): load imported playbooks from ~/.tessera/playbooks/"
```

---

## Task 8: Sidecar HTTP routes for import / export / uninstall

**Files:**
- Modify: `apps/sidecar/src/server.ts`

- [ ] **Step 1: `POST /playbooks/import`**

Accepts JSON body `{ zipPath: string, workspaceRoot: string }`. Stages the import, creates an `artifact_review` inbox message with the manifest + conflict info, returns the message id. The actual file move happens when the inbox message is resolved.

- [ ] **Step 2: Inbox resolution → install**

When an `artifact_review` inbox message with action `install` is resolved, the existing inbox-resolve path needs to know how to perform the install. Either:
- Add a `payload.kind` discriminator to inbox payloads, OR
- Use an in-memory map of `messageId -> StagedImport` inside the sidecar, keyed by the inbox message id

The in-memory map is simpler and acceptable because the inbox message is persisted but the staged-import directory is meaningful only for the sidecar's lifetime — if the sidecar restarts before the message is resolved, the staged directory is cleaned up and the message becomes a no-op `Install failed: staging expired`.

Wire the install path to call `installStagedPlaybook(...)` then `playbookRegistry = rebuildPlaybookRegistry()`.

- [ ] **Step 3: Auto-activate in current workspace**

After install, append the playbook id to the workspace's `activatedPlaybooks` list (deduplicated).

- [ ] **Step 4: `POST /playbooks/export`**

Accepts `{ playbookId: string, destinationPath: string }`. Resolves the package root from the registry. Built-ins can be exported too (their package root is in the source tree). Calls `exportPlaybook(...)`. Returns the resulting file path.

- [ ] **Step 5: `DELETE /playbooks/:id`**

Refuses to delete a built-in (return 400). Calls `uninstallPlaybook(id, ~/.tessera/playbooks)`. Strips the id from every workspace's `activatedPlaybooks` list — for now, only the *current* workspace (sub-plan D may extend to all known workspaces). Rebuilds the registry.

- [ ] **Step 6: `GET /playbooks/:id/assets/:filename`**

Delegates to `readPlaybookAsset(...)`. Returns 200 with the correct `Content-Type`, 404 for missing assets, 400 for invalid filenames. Requires the bearer token like every other sidecar route.

- [ ] **Step 7: Workspace config endpoints**

- `GET /workspaces/<encodedPath>/playbook-config` → returns the workspace's config
- `PUT /workspaces/<encodedPath>/playbook-config` → writes the config (validates against schema first)

Use base64url-encoded workspace paths in the URL to avoid path-segment issues.

- [ ] **Step 8: Tests + commit**

End-to-end test in `apps/sidecar/src/server.test.ts` covering: import → inbox message → resolve → registry includes the new playbook → playbook appears in catalog for the workspace.

```bash
bun test apps/sidecar/src/
bun run check
git add apps/sidecar/src/server.ts
git commit -m "feat(sidecar): HTTP routes for playbook import/export/uninstall/asset/config"
```

---

## Task 9: Tauri proxy commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the commands**

```rust
#[tauri::command]
async fn playbook_import(state: tauri::State<'_, SidecarHandle>, zip_path: String, workspace_root: String) -> Result<serde_json::Value, String> { ... }

#[tauri::command]
async fn playbook_export(state: tauri::State<'_, SidecarHandle>, playbook_id: String, destination_path: String) -> Result<serde_json::Value, String> { ... }

#[tauri::command]
async fn playbook_uninstall(state: tauri::State<'_, SidecarHandle>, playbook_id: String) -> Result<(), String> { ... }

#[tauri::command]
async fn playbook_workspace_config_get(state: tauri::State<'_, SidecarHandle>, workspace_root: String) -> Result<serde_json::Value, String> { ... }

#[tauri::command]
async fn playbook_workspace_config_set(state: tauri::State<'_, SidecarHandle>, workspace_root: String, activated_playbooks: Vec<String>) -> Result<(), String> { ... }
```

Each one is a thin `proxy_post` / `proxy_get` / `proxy_put` / `proxy_delete` call to the matching sidecar route. Register all five in `invoke_handler!`.

For file picking, add a small bridge command:

```rust
#[tauri::command]
async fn playbook_pick_file_to_import(app: tauri::AppHandle) -> Result<Option<String>, String> {
  // Use tauri-plugin-dialog to open a file picker filtered to *.playbook
}
```

- [ ] **Step 2: Cargo build + smoke**

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run check
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Tauri commands for playbook import/export/uninstall/config"
```

---

## Task 10: `<PlaybookImportDropzone>` UI

**Files:**
- Create: `apps/desktop/ui/src/components/PlaybookImportDropzone.tsx`
- Create: `apps/desktop/ui/src/components/PlaybookImportDropzone.test.tsx`

- [ ] **Step 1: Build the component**

- Renders a button + drag-drop area
- Clicking the button calls `invoke("playbook_pick_file_to_import")` and, on a result, calls `invoke("playbook_import", { zipPath, workspaceRoot })`
- Drag-drop accepts files with extension `.playbook`
- After triggering import, a toast says "Import staged — review in the Inbox"
- Errors are toasted (no UI crash)

- [ ] **Step 2: Add tests covering click and the error path**

- [ ] **Step 3: Commit**

```bash
bun test apps/desktop/ui/src/components/PlaybookImportDropzone.test.tsx
git add apps/desktop/ui/src/components/PlaybookImportDropzone.tsx apps/desktop/ui/src/components/PlaybookImportDropzone.test.tsx
git commit -m "feat(ui): playbook import drop-zone component"
```

---

## Task 11: Render `artifact_review` inbox messages with Install/Cancel actions

**Files:**
- Modify: `apps/desktop/ui/src/components/InboxView.tsx`

- [ ] **Step 1: Detect the message kind**

When an inbox message has `type === "artifact_review"` and the structured `context` contains a `playbookManifest` field, render a specialised card showing:
- Playbook name + version + author
- Description
- Required capabilities (calendar / mail / drive / etc.) and tools used
- "Layout script present" indicator if applicable
- Upgrade indicator if `context.conflict === "upgrade"` (show the prior version side-by-side)
- Two actions: Install (resolves with action `install`) and Cancel (resolves with action `cancel`)

- [ ] **Step 2: Wire actions through existing inbox-resolve Tauri commands**

The action handler calls the existing `inbox_resolve` Tauri command with the message id + selected action. The sidecar's resolve handler (Task 8) does the install or cleanup.

- [ ] **Step 3: Test + commit**

```bash
bun test apps/desktop/ui/src/components/InboxView.test.tsx
git add apps/desktop/ui/src/components/InboxView.tsx apps/desktop/ui/src/components/InboxView.test.tsx
git commit -m "feat(ui): render artifact_review inbox messages for playbook imports"
```

---

## Task 12: Per-playbook "Available in this workspace" toggle + Export / Remove context menu

**Files:**
- Modify: `apps/desktop/ui/src/components/PlaybooksView.tsx`

- [ ] **Step 1: Add an activation toggle**

For imported playbooks (not built-ins), render a small toggle next to the playbook card: "Available in this workspace". Toggling it updates the workspace config via `playbook_workspace_config_set`.

- [ ] **Step 2: Per-playbook context menu**

Right-click (or three-dot menu) on a playbook card shows:
- Export playbook… (calls `playbook_pick_destination` then `playbook_export`)
- Remove playbook… (imported only; built-ins hide this option)

The Remove flow shows a confirmation dialog listing the workspaces where the playbook is currently activated.

- [ ] **Step 3: Commit**

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
bun run check
git add apps/desktop/ui/src/components/PlaybooksView.tsx
git commit -m "feat(ui): playbook activation toggle + export/remove menu"
```

---

## Task 13: `<WorkspacePlaybookSettings>` in Workspace Settings

A bulk-management page accessible from Workspace Settings: a multi-select list of all installed playbooks (built-ins + imported), with checkboxes for "Available in this workspace". Built-ins are always checked and disabled (auto-activated).

**Files:**
- Create: `apps/desktop/ui/src/components/WorkspacePlaybookSettings.tsx`
- Create: `apps/desktop/ui/src/components/WorkspacePlaybookSettings.test.tsx`
- Modify: wherever the Workspace Settings panel is rendered to add a new tab/section

- [ ] **Step 1: Implement the component**

Show two lists: "Built-in playbooks" (read-only) and "Imported playbooks" (checkable). Save on change via `playbook_workspace_config_set`.

- [ ] **Step 2: Test + commit**

```bash
bun test apps/desktop/ui/src/components/WorkspacePlaybookSettings.test.tsx
git add apps/desktop/ui/src/components/WorkspacePlaybookSettings.tsx apps/desktop/ui/src/components/WorkspacePlaybookSettings.test.tsx
git commit -m "feat(ui): WorkspacePlaybookSettings activation management"
```

---

## Task 14: Built-in upgrade detection

When the app launches a new version, bundled built-in playbook manifests may have changed. Detect that and silently refresh in-memory registry — no user prompt.

**Files:**
- Modify: `apps/sidecar/src/server.ts`

- [ ] **Step 1: Hash bundled manifests at boot**

For each built-in playbook id, compute a hash of its manifest content + meta.version. Compare against a cached hash stored in `~/.tessera/builtin-playbook-hashes.json`. If different (or first boot), update the cache file silently. The registry already loads from the static imports, so no runtime data movement is needed — but log the upgrade for diagnostics:

```ts
console.info(`Built-in playbook ${id} upgraded from v${oldVersion} to v${newVersion}`);
```

- [ ] **Step 2: Test + commit**

A small unit test that writes a stale hash file, restarts the registry-building code in isolation, and confirms the cache file is updated and no inbox message is created.

```bash
bun test apps/sidecar/src/
git add apps/sidecar/src/server.ts
git commit -m "feat(sidecar): silent built-in playbook upgrade detection"
```

---

## Task 15: End-to-end smoke verification

- [ ] **Step 1: Full check + tests**

```bash
bun run check
bun run --filter '*' test
```

- [ ] **Step 2: Build the sidecar binary**

```bash
bun run --filter './apps/sidecar' build
```

- [ ] **Step 3: Manual smoke**

Run `bun run dev`, open the desktop app:

1. Export `ops.activity-snapshot` (built-in dashboard from sub-plan B) — saves a `.playbook` file
2. Drag the `.playbook` file back into the dropzone — verify inbox message appears with the right metadata
3. Approve from inbox — verify the playbook (with a renamed id for the test) appears in the catalog
4. Toggle "Available in this workspace" off — playbook disappears from catalog
5. Toggle on — reappears
6. Right-click → Remove playbook — confirmation dialog → confirm → playbook disappears, install directory deleted
7. Verify built-in upgrade: bump `meta.version` in `packages/core/src/builtin-playbooks/ops.activity-snapshot/manifest.json` to 2, rebuild + restart, confirm the version change is reflected without any user prompt

- [ ] **Step 4: Final commit (if smoke uncovered fixes)**

---

## Self-Review Notes

- **Spec coverage:** Section 1 (package format reuse), Section 2 (`WorkspacePlaybookConfig`), Section 4 (import/export/uninstall/activation/asset serving), Open Question on built-in upgrades (Task 14).
- **Cross-platform concern:** Tasks 4–5 use system `unzip` / `zip` via `Bun.spawn`. Windows may not ship these. Acceptable for sub-plan C; sub-plan D can switch to a JS zip library (`fflate` or `adm-zip`) if Windows is a target before then.
- **Backslash path-traversal hardening:** noted in sub-plan A's final review — add path-separator normalization (`replace(/\\/g, "/")`) to `playbook-loader.ts` as a small standalone change before Task 4, since Task 4 is the moment user-supplied package paths first enter the loader.
- **Risk:** Inbox message → staged install coupling lives in sidecar memory; if the sidecar crashes between staging and approval, the inbox message becomes a no-op. Worth documenting as a known limitation, not a blocker for sub-plan C.
- **Test infrastructure:** Several tasks require zip/unzip test helpers. Add a small `apps/sidecar/src/test-helpers/zip.ts` early (during Task 4) so it's reused by Tasks 5 and 8 instead of being duplicated.
