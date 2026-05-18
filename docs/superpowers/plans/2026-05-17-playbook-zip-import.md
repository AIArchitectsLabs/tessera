# Playbook Zip Import Implementation Plan

> For agentic workers: implement task-by-task and keep each checkbox updated.
> This plan builds on the existing graph package installer instead of creating a
> parallel playbook format.
>
> **Consensus refinement:** use
> `.omx/plans/2026-05-17-playbook-zip-import-ralplan.md` for execution. The
> ralplan artifact adds the final Architect/Critic requirements around
> `packageVersion`, `sourceHash`, shared built-in/imported projection, stale
> latest handling, Playbooks UI visibility, and ZIP CRC/local-header validation.

**Goal:** Let a user import the external SEO/GEO reference playbook zip from the
Playbooks UI, validate and install it through the graph package pipeline, show it
in the left Playbooks menu, and make newer versions replace older visible
versions without breaking pinned historical runs.

**Spec reference:** `docs/superpowers/specs/2026-05-17-playbook-zip-import-design.md`

**Existing foundation:**

- `packages/core/src/playbook-graph-package.ts`
- `packages/core/src/playbook-graph-package-loader.ts`
- `packages/core/src/playbook-graph-package-installer.ts`
- `apps/sidecar/src/graph-playbook-registry.ts`
- `apps/sidecar/src/server.ts`
- `apps/desktop/ui/src/components/PlaybooksView.tsx`

**Out of scope:** marketplace, remote GitHub import, signing/trust UI, export,
uninstall, workspace activation, and same-version force replace.

## Decisions

- Import zip archives through a new `POST /graph-playbooks/import` endpoint.
- Keep `POST /graph-playbooks/install` for source-folder development flows.
- Use a sidecar-owned zip extractor, not a shell `unzip` dependency.
- Catalog views show only the latest installed version per playbook id.
- Full installed registry keeps all valid versions for pinned graph run source
  resolution.
- Reject imported packages whose id collides with a built-in playbook id.
- Reject same-version source conflicts with `409`; require a version bump.

## File Structure

New files:

- `apps/sidecar/src/zip-archive.ts`
- `apps/sidecar/src/zip-archive.test.ts`
- `apps/sidecar/src/graph-playbook-importer.ts`
- `apps/sidecar/src/graph-playbook-importer.test.ts`

Modified files:

- `packages/contracts/src/index.ts`
- `packages/contracts/src/playbook-graph-package.test.ts`
- `apps/sidecar/src/graph-playbook-registry.ts`
- `apps/sidecar/src/graph-playbook-registry.test.ts`
- `apps/sidecar/src/server.ts`
- `apps/sidecar/src/server.test.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/ui/src/components/PlaybooksView.tsx`
- `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

Optional manual fixture:

- `/private/tmp/reference.seo-geo-blog-article-0.1.0.playbook.zip`

## Task 0: Create The SEO Zip Fixture

- [ ] From `/Users/utpal/Code/projects/seo-geo-blog-reference-playbook`, create a
  zip that includes `manifest.json`, `playbook.ts`, `prompts/`, `scripts/`,
  `schemas/`, `assets/`, `PLAYBOOK.md`, `package.json`, and `tsconfig.json`.
- [ ] Name it
  `/private/tmp/reference.seo-geo-blog-article-0.1.0.playbook.zip`.
- [ ] Verify the source package still loads through Tessera's graph package
  loader before using it for UI QA.

Suggested command for the fixture only:

```bash
zip -r /private/tmp/reference.seo-geo-blog-article-0.1.0.playbook.zip manifest.json playbook.ts prompts scripts schemas assets PLAYBOOK.md package.json tsconfig.json
```

## Task 1: Add Import Result Contracts

Files:

- Modify `packages/contracts/src/index.ts`
- Extend `packages/contracts/src/playbook-graph-package.test.ts` or create a
  focused import result test.

- [ ] Add `GraphPlaybookImportStatusSchema` with `installed`, `updated`,
  `unchanged`, and `archived`.
- [ ] Add `GraphPlaybookImportResultSchema`:

```ts
export const GraphPlaybookImportResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: GraphPlaybookImportStatusSchema,
    id: z.string().min(1),
    version: z.string().min(1),
    name: z.string().min(1),
    graphHash: z.string().regex(/^sha256:/),
    sourceHash: z.string().regex(/^sha256:/),
    warnings: z.array(z.string()).default([]),
  })
  .strict();
```

- [ ] Export inferred types.
- [ ] Test valid statuses, default warnings, and invalid hash rejection.

Run:

```bash
bun test packages/contracts/src/playbook-graph-package.test.ts
bun run --filter './packages/contracts' typecheck
```

## Task 2: Add A Safe Zip Extractor

Files:

- Create `apps/sidecar/src/zip-archive.ts`
- Create `apps/sidecar/src/zip-archive.test.ts`

- [ ] Implement `extractZipArchive(options)` with:
  - `zipPath`
  - `destinationRoot`
  - `maxCompressedBytes`
  - `maxUncompressedBytes`
  - `maxEntries`
- [ ] Parse the central directory and local file headers directly.
- [ ] Support only stored and deflated entries.
- [ ] Reject zip64, encrypted entries, multi-disk archives, unsupported
  compression methods, and malformed offsets.
- [ ] Reject path traversal: absolute paths, drive letters, UNC paths, `..`,
  empty segments, and backslash traversal.
- [ ] Reject or skip symlink entries.
- [ ] Preserve normal package files with stable relative paths.
- [ ] Cleanly report validation errors without leaking temp paths into user copy
  except where useful for debugging.

Tests:

- [ ] Extracts a minimal archive with `manifest.json` and `playbook.ts`.
- [ ] Extracts a single top-level folder archive.
- [ ] Rejects `../manifest.json`.
- [ ] Rejects absolute and Windows drive-letter paths.
- [ ] Rejects encrypted or unsupported compression method fixtures.
- [ ] Enforces max file count and uncompressed byte limits.

Run:

```bash
bun test apps/sidecar/src/zip-archive.test.ts
bun run --filter './apps/sidecar' typecheck
```

## Task 3: Add The Graph Playbook Importer

Files:

- Create `apps/sidecar/src/graph-playbook-importer.ts`
- Create `apps/sidecar/src/graph-playbook-importer.test.ts`

- [ ] Implement `importGraphPlaybookArchive(options)`:
  - Extract zip to a staging directory.
  - Resolve package root from either archive root or one top-level directory.
  - Reject multiple candidate roots.
  - Reject built-in id collisions.
  - Call `installGraphPlaybookPackage`.
  - Compute import status from previous and new latest metadata.
  - Always remove staging on success and failure.
- [ ] Return `GraphPlaybookImportResult`.
- [ ] Preserve installer warnings.
- [ ] Surface same-version source conflicts as a conflict result to the server
  layer, not as a generic 500.

Tests:

- [ ] Fresh SEO-shaped archive returns `installed`.
- [ ] Exact reimport returns `unchanged`.
- [ ] Newer version returns `updated` and changes latest.
- [ ] Older version returns `archived` and keeps latest.
- [ ] Same version with different source throws a conflict.
- [ ] Built-in id collision throws a conflict.
- [ ] Invalid archive cleans staging.

Run:

```bash
bun test apps/sidecar/src/graph-playbook-importer.test.ts
bun run --filter './apps/sidecar' typecheck
```

## Task 4: Wire Imported Playbooks Into The Catalog

Files:

- Modify `apps/sidecar/src/graph-playbook-registry.ts`
- Modify `apps/sidecar/src/graph-playbook-registry.test.ts`
- Modify `apps/sidecar/src/server.ts`
- Modify `apps/sidecar/src/server.test.ts`

- [ ] Keep the full installed registry for graph run source lookup.
- [ ] Add a latest/catalog projection that returns one installed entry per
  playbook id by reading `latest.json`.
- [ ] Include enough data to build `PlaybookSummary` and `PlaybookDetail`:
  compiled graph, graph hash, installed root, and package source files when
  needed.
- [ ] Update `GET /playbooks` to include built-ins plus latest imported
  playbooks.
- [ ] Update `GET /playbooks/:id` to resolve imported latest playbooks.
- [ ] Add `POST /graph-playbooks/import` to `server.ts`.
- [ ] Return `400` for invalid zip/package input and `409` for same-version
  conflict or built-in id collision.
- [ ] Keep `POST /graph-playbooks/install` behavior unchanged.

Tests:

- [ ] `/playbooks` includes an imported playbook after import.
- [ ] `/playbooks/:id` returns detail for an imported playbook.
- [ ] Newer import updates the visible graph hash/version and does not duplicate
  the menu entry.
- [ ] Older import does not replace the visible latest entry.
- [ ] `graph_run_create` works with an imported playbook id/hash.
- [ ] Same-version changed source returns 409.
- [ ] Built-in collision returns 409.

Run:

```bash
bun test apps/sidecar/src/zip-archive.test.ts apps/sidecar/src/graph-playbook-importer.test.ts apps/sidecar/src/graph-playbook-registry.test.ts apps/sidecar/src/server.test.ts
bun run --filter './apps/sidecar' typecheck
```

## Task 5: Add The Tauri Import Command

Files:

- Modify `apps/desktop/src-tauri/src/lib.rs`

- [ ] Add `playbook_import(zip_path: String)`.
- [ ] Trim and require a non-empty absolute path.
- [ ] POST `{ zipPath }` to `/graph-playbooks/import`.
- [ ] Parse and return JSON.
- [ ] Register the command in `invoke_handler`.
- [ ] Add Rust unit coverage where existing command helper tests make that
  practical; otherwise rely on UI and sidecar tests for behavior.

Run:

```bash
cargo check -p tessera
```

## Task 6: Add The Playbooks UI Import Flow

Files:

- Modify `apps/desktop/ui/src/components/PlaybooksView.tsx`
- Modify `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

- [ ] Import `open` from `@tauri-apps/plugin-dialog`.
- [ ] Add an Import icon button beside Refresh.
- [ ] Use `.playbook` and `.zip` filters.
- [ ] Track `importingPlaybook`.
- [ ] Disable Import, Refresh, and Run while importing.
- [ ] On cancel, leave state unchanged.
- [ ] On success, refresh the catalog, select the imported id, and load its
  detail/runs.
- [ ] Show warnings or import status in the existing Playbooks message surface.
- [ ] Preserve the existing no-landing-page Playbooks experience.

Tests:

- [ ] Import button opens the file picker with the expected extensions.
- [ ] Cancel does not invoke `playbook_import`.
- [ ] Successful import invokes `playbook_import` with the chosen path.
- [ ] Successful import refreshes playbooks and selects the imported playbook.
- [ ] Failed import renders the error message.

Run:

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
bun run --filter './apps/desktop/ui' typecheck
```

## Task 7: End-To-End Manual QA

- [ ] Build or run the desktop app.
- [ ] Import
  `/private/tmp/reference.seo-geo-blog-article-0.1.0.playbook.zip`.
- [ ] Confirm `SEO/GEO Blog Article Reference Playbook` appears in the left
  Playbooks menu.
- [ ] Select it and confirm detail/preflight loads.
- [ ] Start a run far enough to prove graph hash resolution works.
- [ ] Create or simulate a `0.2.0` archive and import it.
- [ ] Confirm the sidebar still has one SEO/GEO entry and it points at `0.2.0`.
- [ ] Reimport `0.1.0` and confirm it does not replace the current `0.2.0`
  entry.

## Final Verification

Run focused checks:

```bash
bun test packages/contracts/src/playbook-graph-package.test.ts
bun test packages/core/src/playbook-graph-package.test.ts packages/core/src/playbook-graph-package-loader.test.ts packages/core/src/playbook-graph-package-installer.test.ts
bun test apps/sidecar/src/zip-archive.test.ts apps/sidecar/src/graph-playbook-importer.test.ts apps/sidecar/src/graph-playbook-registry.test.ts apps/sidecar/src/server.test.ts
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
cargo check -p tessera
bun run check
```

Completion evidence:

- Imported SEO/GEO zip visible in Playbooks sidebar.
- Newer import replaces the visible older version.
- Same-version changed source conflict is clear and tested.
- Existing graph run snapshot/source behavior remains intact.

## ADR

**Decision:** Add zip import as a thin staging layer over the existing graph
package installer.

**Drivers:** Reuse validated package compilation, keep Tessera generic, preserve
run reproducibility, and make the Playbooks UI usable for external package
testing.

**Alternatives considered:**

- Import from a source folder only. Rejected because the user flow starts from a
  shareable zip.
- Use shell `unzip`. Rejected for the shipped app because it is not a stable
  cross-platform dependency.
- Force-replace same-version packages. Rejected because package versions should
  be immutable once runs can pin graph hashes.

**Consequences:** The first slice needs a small zip reader, but it avoids a new
runtime dependency and keeps import validation centralized in the package
installer.

**Follow-ups:** Export, uninstall, workspace activation, package signing, and
asset/icon preservation should each get separate specs.
