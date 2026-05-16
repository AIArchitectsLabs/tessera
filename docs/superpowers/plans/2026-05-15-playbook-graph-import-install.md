# Playbook Graph Import / Install Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Tessera install source-first graph playbook packages from disk, compile their TypeScript `playbook.ts` entrypoint into a normalized `PlaybookGraph`, validate package references, and cache the compiled graph using the compiler/cache foundation from Plan A.

**Architecture:** Add a graph-package import/install layer above the already implemented graph contracts, SDK helper, compiler metadata, and filesystem cache. The installer reads a package directory, validates a graph package manifest, collects package source files, compiles `playbook.ts` through a constrained import-time compiler, validates prompts/scripts/schemas/assets referenced by the graph, writes an installed package copy to Tessera-managed storage, and saves the compiled graph artifact in the content-addressed cache. Sidecar integration remains small: expose an install endpoint and rebuild an installed graph playbook registry. Runtime graph execution is explicitly deferred.

**Tech Stack:** TypeScript strict, Zod contracts, Bun test runner, Node `fs`/`path` APIs, existing `@tessera/plugin-sdk`, existing `@tessera/core` graph compile/cache helpers, existing sidecar server patterns.

**Depends on:** `docs/superpowers/plans/2026-05-15-playbook-graph-compiler-cache.md` — implemented through `2b9bf34`.

**Out of scope:** Durable graph execution, node memoization, human review UI, script-node sandbox execution, SEO/GEO reference playbook repo, marketplace/signing/update channel, arbitrary package dependencies, Python support, remote GitHub import, `.playbook` zip export.

---

## Decisions

- Plan B installs graph playbooks from a local source directory first. Zip export/import can reuse the same validation later.
- The source package entrypoint is `playbook.ts` and must default-export the result of `definePlaybook(...)`.
- Phase 1 compile is TypeScript-only and dependency-free. Packages must not include `node_modules`, lockfiles, postinstall scripts, or imports outside the package.
- Import-time compilation may run the playbook module, but only inside a tightly scoped compiler surface. Runtime execution still runs cached graphs, not authoring code.
- The installed package copy and compiled graph cache are separate:
  - Installed package copy preserves source files for audit/recompile.
  - Compiled graph cache stores validated graph artifacts by `graphHash`.
- A run in a later plan must pin a compiled graph snapshot/hash. It must not depend on `latest.json`.

---

## Package Shape

Accepted package directory:

```text
my-playbook/
  manifest.json
  playbook.ts
  prompts/
    *.md
  scripts/
    *.ts
  schemas/
    *.schema.json
  assets/
    ...
```

Minimal `manifest.json`:

```json
{
  "schemaVersion": 1,
  "id": "content.seo-blog",
  "version": "0.1.0",
  "name": "SEO Blog Article",
  "entrypoint": "playbook.ts"
}
```

The `id`, `version`, and `name` must match the compiled graph.

---

## File Structure

**New files:**

- `packages/contracts/src/playbook-graph-package.test.ts`
- `packages/core/src/playbook-graph-package.ts`
- `packages/core/src/playbook-graph-package.test.ts`
- `packages/core/src/playbook-graph-package-loader.ts`
- `packages/core/src/playbook-graph-package-loader.test.ts`
- `packages/core/src/playbook-graph-package-installer.ts`
- `packages/core/src/playbook-graph-package-installer.test.ts`
- `apps/sidecar/src/graph-playbook-registry.ts`
- `apps/sidecar/src/graph-playbook-registry.test.ts`

**Modified files:**

- `packages/contracts/src/index.ts`
- `packages/core/src/index.ts`
- `apps/sidecar/src/server.ts`

Optional UI files are intentionally deferred until the sidecar route is stable.

---

## Task 1: Add Graph Package Manifest Contracts

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/playbook-graph-package.test.ts`

- [ ] Add `PlaybookGraphPackageManifestSchema`:

```ts
export const PlaybookGraphPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).regex(/^[A-Za-z0-9._:-]+$/),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    entrypoint: PlaybookGraphSourceRefSchema.default("playbook.ts"),
  })
  .strict();
export type PlaybookGraphPackageManifest = z.infer<typeof PlaybookGraphPackageManifestSchema>;
```

- [ ] Tests:
  - accepts minimal manifest
  - defaults `entrypoint` to `playbook.ts`
  - rejects absolute or escaping entrypoint paths
  - rejects unsupported schema version
  - rejects invalid package id

- [ ] Run:

```bash
bun test packages/contracts/src/playbook-graph-package.test.ts
bun run --filter './packages/contracts' typecheck
```

- [ ] Commit:

```bash
git add packages/contracts/src/index.ts packages/contracts/src/playbook-graph-package.test.ts
git commit -m "feat(contracts): add graph playbook package manifest"
```

Use Lore trailers.

---

## Task 2: Add Package Filesystem Scanner

**Files:**

- Create: `packages/core/src/playbook-graph-package.ts`
- Create: `packages/core/src/playbook-graph-package.test.ts`

- [ ] Implement:

```ts
export interface PlaybookGraphPackageFiles {
  root: string;
  manifestPath: string;
  manifest: PlaybookGraphPackageManifest;
  sourceFiles: Record<string, string>;
}

export function assertPackageRelativePath(relativePath: string): string;
export async function readPlaybookGraphPackage(root: string): Promise<PlaybookGraphPackageFiles>;
```

- [ ] Scanner behavior:
  - reads `manifest.json`
  - parses `PlaybookGraphPackageManifestSchema`
  - recursively collects package files as UTF-8 text for these directories/files:
    - `playbook.ts`
    - `manifest.json`
    - `prompts/**/*.md`
    - `scripts/**/*.ts`
    - `schemas/**/*.json`
  - ignores `assets/` for source hash in Phase 1 unless referenced by later artifact schemas
  - rejects:
    - `node_modules`
    - `package-lock.json`, `bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`
    - `package.json` containing `scripts.postinstall`
    - symlinks that point outside package root
    - hidden executable hook directories such as `.git/hooks`

- [ ] Tests:
  - reads manifest and source files
  - rejects missing manifest
  - rejects dependency directories/lockfiles
  - rejects escaping symlink
  - source file keys are stable package-relative paths

- [ ] Run:

```bash
bun test packages/core/src/playbook-graph-package.test.ts
bun run --filter './packages/core' typecheck
```

- [ ] Commit:

```bash
git add packages/core/src/playbook-graph-package.ts packages/core/src/playbook-graph-package.test.ts
git commit -m "feat(core): read graph playbook packages from disk"
```

Use Lore trailers.

---

## Task 3: Add Entrypoint Compiler Surface

**Files:**

- Create: `packages/core/src/playbook-graph-package-loader.ts`
- Create: `packages/core/src/playbook-graph-package-loader.test.ts`

- [ ] Implement:

```ts
export interface LoadGraphPlaybookPackageOptions {
  root: string;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

export interface LoadedGraphPlaybookPackage {
  root: string;
  manifest: PlaybookGraphPackageManifest;
  compiled: CompiledPlaybookGraph;
}

export async function loadGraphPlaybookPackage(
  options: LoadGraphPlaybookPackageOptions
): Promise<LoadedGraphPlaybookPackage>;
```

- [ ] Compiler strategy:
  - Use `readPlaybookGraphPackage(root)` to collect source.
  - Compile the manifest `entrypoint` with Bun in a temporary output directory.
  - The compiler process must:
    - set cwd to package root
    - allow imports only from package-relative files and `@tessera/plugin-sdk`
    - reject direct imports of `node:fs`, `node:child_process`, `node:net`, `node:http`, `node:https`, `node:worker_threads`
    - reject dynamic `import(...)`
    - reject imports outside package root
  - Load the compiled entrypoint and require a default exported object.
  - Pass that object into `compilePlaybookGraph(...)` with the collected `sourceFiles`.
  - Verify manifest id/version/name match compiled graph id/version/name.

Implementation note: if a fully sandboxed compiler cannot be achieved in this slice, implement a static import scanner plus an injected module-loader interface for tests. Do not claim runtime sandboxing. The hard security boundary belongs to the later script-runner plan.

- [ ] Tests:
  - loads a minimal package whose `playbook.ts` calls `definePlaybook`
  - rejects missing default export
  - rejects manifest/graph id mismatch
  - rejects `node:fs` import
  - rejects dynamic import
  - compile metadata changes when source changes

- [ ] Run:

```bash
bun test packages/core/src/playbook-graph-package-loader.test.ts
bun run --filter './packages/core' typecheck
```

- [ ] Commit:

```bash
git add packages/core/src/playbook-graph-package-loader.ts packages/core/src/playbook-graph-package-loader.test.ts
git commit -m "feat(core): compile graph playbook packages"
```

Use Lore trailers.

---

## Task 4: Add Installed Package Store

**Files:**

- Create: `packages/core/src/playbook-graph-package-installer.ts`
- Create: `packages/core/src/playbook-graph-package-installer.test.ts`

- [ ] Implement:

```ts
export interface InstallGraphPlaybookPackageOptions {
  sourceRoot: string;
  installRoot: string;
  cacheRoot: string;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

export interface InstalledGraphPlaybookPackage {
  installedRoot: string;
  compiledGraphPath: string;
  compiled: CompiledPlaybookGraph;
}

export async function installGraphPlaybookPackage(
  options: InstallGraphPlaybookPackageOptions
): Promise<InstalledGraphPlaybookPackage>;
```

- [ ] Installer behavior:
  - load and compile source package
  - copy accepted package files into `installRoot/<safePackageId>/<version>/`
  - use dot-free path segment encoding for package id/version
  - write an install metadata file:

```json
{
  "schemaVersion": 1,
  "playbookId": "...",
  "packageVersion": "...",
  "graphHash": "sha256:...",
  "sourceHash": "sha256:...",
  "installedAt": "..."
}
```

  - save compiled graph to `createPlaybookGraphCache(cacheRoot)`
  - update a per-playbook `latest.json` pointer under installed package store
  - use temp directory + atomic rename for install replacement

- [ ] Version behavior:
  - same id + same version + same source hash: idempotent success
  - same id + same version + different source hash: reject as conflict
  - same id + newer version: install side-by-side and update latest pointer
  - same id + older version: install allowed but latest pointer remains highest semver-like version only if comparison is unambiguous; otherwise keep current latest and return a warning

- [ ] Tests:
  - installs package and writes compiled graph cache
  - idempotent reinstall succeeds
  - same version with changed source rejects
  - new version updates latest pointer
  - install replacement is atomic enough that failed copy does not destroy existing install

- [ ] Run:

```bash
bun test packages/core/src/playbook-graph-package-installer.test.ts
bun run --filter './packages/core' typecheck
```

- [ ] Commit:

```bash
git add packages/core/src/playbook-graph-package-installer.ts packages/core/src/playbook-graph-package-installer.test.ts
git commit -m "feat(core): install compiled graph playbook packages"
```

Use Lore trailers.

---

## Task 5: Export Core Package APIs

**Files:**

- Modify: `packages/core/src/index.ts`

- [ ] Export:

```ts
export {
  assertPackageRelativePath,
  readPlaybookGraphPackage,
  type PlaybookGraphPackageFiles,
} from "./playbook-graph-package.js";
export {
  loadGraphPlaybookPackage,
  type LoadGraphPlaybookPackageOptions,
  type LoadedGraphPlaybookPackage,
} from "./playbook-graph-package-loader.js";
export {
  installGraphPlaybookPackage,
  type InstallGraphPlaybookPackageOptions,
  type InstalledGraphPlaybookPackage,
} from "./playbook-graph-package-installer.js";
```

- [ ] Run:

```bash
bun run --filter './packages/core' typecheck
```

- [ ] Commit:

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export graph playbook package APIs"
```

Use Lore trailers.

---

## Task 6: Add Sidecar Installed Graph Registry

**Files:**

- Create: `apps/sidecar/src/graph-playbook-registry.ts`
- Create: `apps/sidecar/src/graph-playbook-registry.test.ts`

- [ ] Implement:

```ts
export interface GraphPlaybookRegistryEntry {
  id: string;
  version: string;
  name: string;
  graphHash: string;
  installedRoot: string;
}

export async function loadInstalledGraphPlaybookRegistry(options: {
  installRoot: string;
  cacheRoot: string;
}): Promise<GraphPlaybookRegistryEntry[]>;
```

- [ ] Registry behavior:
  - scans installed package metadata
  - verifies referenced compiled graph exists in cache
  - skips corrupted entries without crashing sidecar startup
  - returns sorted entries by id/version

- [ ] Tests:
  - loads installed package entry
  - skips missing cache artifact
  - skips malformed install metadata

- [ ] Run:

```bash
bun test apps/sidecar/src/graph-playbook-registry.test.ts
bun run --filter './apps/sidecar' typecheck
```

- [ ] Commit:

```bash
git add apps/sidecar/src/graph-playbook-registry.ts apps/sidecar/src/graph-playbook-registry.test.ts
git commit -m "feat(sidecar): load installed graph playbook registry"
```

Use Lore trailers.

---

## Task 7: Add Sidecar Install Endpoint

**Files:**

- Modify: `apps/sidecar/src/server.ts`
- Add tests in the existing sidecar server test file, or create one if that pattern already exists.

- [ ] Add endpoint:

```http
POST /graph-playbooks/install
```

Body:

```json
{
  "sourceRoot": "/path/to/local/playbook"
}
```

Response:

```json
{
  "id": "content.seo-blog",
  "version": "0.1.0",
  "graphHash": "sha256:...",
  "sourceHash": "sha256:..."
}
```

- [ ] Behavior:
  - resolves install/cache roots from sidecar app data directory
  - calls `installGraphPlaybookPackage`
  - rebuilds in-memory graph playbook registry
  - returns structured errors for validation, conflict, and compile failure
  - does not add UI or auto-run installed playbooks

- [ ] Tests:
  - installs valid package through HTTP route
  - validation failure returns 400
  - conflict returns 409
  - registry includes package after successful install

- [ ] Run:

```bash
bun test apps/sidecar/src/server.test.ts apps/sidecar/src/graph-playbook-registry.test.ts
bun run --filter './apps/sidecar' typecheck
```

- [ ] Commit:

```bash
git add apps/sidecar/src/server.ts apps/sidecar/src/graph-playbook-registry.ts apps/sidecar/src/graph-playbook-registry.test.ts
git commit -m "feat(sidecar): install graph playbooks from local packages"
```

Use Lore trailers.

---

## Task 8: Final Verification

- [ ] Run targeted tests:

```bash
bun test packages/contracts/src/playbook-graph-package.test.ts
bun test packages/core/src/playbook-graph-package.test.ts packages/core/src/playbook-graph-package-loader.test.ts packages/core/src/playbook-graph-package-installer.test.ts
bun test apps/sidecar/src/graph-playbook-registry.test.ts
```

- [ ] Run full check:

```bash
bun run check
```

- [ ] If fixes are required, commit them with:

```bash
git commit -m "fix(playbooks): align graph package install foundation"
```

Use Lore trailers.

---

## Acceptance Criteria

- Tessera can read a local graph playbook source package.
- Tessera can compile package `playbook.ts` into a normalized `PlaybookGraph`.
- Tessera rejects dependency-bearing or unsafe Phase 1 packages.
- Tessera validates referenced prompts, scripts, and schemas exist inside the package.
- Tessera stores an installed source copy separately from the compiled graph cache.
- Tessera saves compiled graph artifacts through the existing cache.
- Sidecar can install a local package and rebuild an installed graph playbook registry.
- No graph runtime execution is introduced.
- `bun run check` passes.

---

## Follow-Up Plans

- **Plan C:** Durable graph runtime execution, run records, graph snapshot pinning, node queue, memo keys, and restart-safe resume. Landed in `docs/superpowers/plans/2026-05-16-playbook-graph-durable-runtime.md`.
- **Plan D:** Rich human review surfaces, artifact revision history UX, branch drill-down, and git-aware milestone commits.
- **Plan E:** Stronger OS/process sandbox hardening for graph script nodes before untrusted third-party packages.
- **Plan F:** SEO/GEO blog reference playbook repository.
