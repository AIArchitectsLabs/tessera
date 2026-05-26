# Playbook Zip Import Design

## Decision

Add a first-class Playbook import flow that lets a user choose a `.zip` or
`.playbook` archive from the Playbooks screen, validates it through the existing
graph playbook package installer, and makes the imported playbook appear in the
left Playbooks menu.

The import flow should use the graph package format already implemented in
Tessera. It should not introduce SEO-specific platform concepts. The SEO/GEO
blog reference playbook remains an external package and serves as the first
end-to-end import fixture.

## Current State

Implemented foundations:

- `packages/core/src/playbook-graph-package.ts` reads and validates source-first
  graph playbook packages from a local directory.
- `packages/core/src/playbook-graph-package-loader.ts` compiles `playbook.ts`
  into a normalized `PlaybookGraph` and validates package-relative references.
- `packages/core/src/playbook-graph-package-installer.ts` installs compiled
  graph packages into Tessera-managed storage, writes `install.json`, updates
  `latest.json`, saves the compiled graph cache, and rejects same-version source
  conflicts.
- `apps/sidecar/src/graph-playbook-registry.ts` can scan installed graph
  packages.
- `apps/sidecar/src/server.ts` exposes `POST /graph-playbooks/install`, but it
  accepts only a local source directory.
- `GET /playbooks` and `GET /playbooks/:id` currently return only built-in graph
  playbooks.
- `apps/desktop/ui/src/components/PlaybooksView.tsx` has a left Playbooks menu
  and refresh button, but no import button.

Missing user-facing slice:

1. A zip artifact for the external SEO/GEO reference playbook.
2. A desktop import affordance.
3. A sidecar zip extraction and staging layer.
4. Catalog/detail read paths that include imported playbooks.
5. UI behavior that selects the newly imported playbook and avoids duplicate
   sidebar entries after upgrades.

## User Flow

1. The user has a zip of the external SEO/GEO reference playbook.
2. The user opens Tessera and visits Playbooks.
3. The user clicks Import.
4. Tessera opens the OS file picker for `.playbook` and `.zip` files.
5. Tessera uploads the chosen path to the sidecar import endpoint.
6. The sidecar extracts the zip into a staging directory, finds the package root,
   validates and compiles the playbook, installs it, refreshes the registry, and
   returns import metadata.
7. The UI refreshes the playbook catalog, selects the imported playbook, and
   shows it in the left menu.
8. If the user later imports a newer version of the same playbook id, the menu
   shows the newer version as the current playbook instead of showing duplicates.

## Product Requirements

- The Playbooks sidebar has an Import control near Refresh.
- The file picker accepts `.playbook` and `.zip`.
- Import success leaves the imported playbook selected.
- Import failure uses the existing Playbooks error surface and gives a
  human-readable reason.
- The catalog shows one current entry per imported playbook id.
- Built-in playbooks remain visible and cannot be overwritten by an imported
  package with the same id.
- New runs of an imported playbook use the latest installed version.
- Existing runs keep their pinned compiled graph snapshot and source files.

## Package And Zip Shape

Accepted archive shapes:

```text
seo-geo-blog-reference-playbook.zip
  manifest.json
  playbook.ts
  prompts/*.md
  scripts/*.ts
  schemas/*.json
  layouts/*.json
  assets/*
```

or:

```text
seo-geo-blog-reference-playbook.zip
  seo-geo-blog-reference-playbook/
    manifest.json
    playbook.ts
    prompts/*.md
    scripts/*.ts
    schemas/*.json
    layouts/*.json
    assets/*
```

The sidecar should normalize either shape to a package root before calling the
existing installer. Archives with multiple candidate package roots should fail
with a clear error.

The first fixture is:

- Source repo: `/Users/utpal/Code/playbooks/seo-geo-blog-reference-playbook`
- Manifest id: `reference.seo-geo-blog-article`
- Manifest version: `0.1.0`
- Display name: `SEO/GEO Blog Article Reference Playbook`

## Import API

Add a sidecar endpoint:

```http
POST /graph-playbooks/import
```

Request:

```json
{
  "zipPath": "/absolute/path/reference.seo-geo-blog-article-0.1.0.playbook.zip"
}
```

Response:

```json
{
  "schemaVersion": 1,
  "status": "installed",
  "id": "reference.seo-geo-blog-article",
  "version": "0.1.0",
  "name": "SEO/GEO Blog Article Reference Playbook",
  "graphHash": "sha256:...",
  "sourceHash": "sha256:...",
  "warnings": []
}
```

`status` values:

- `installed`: first install for this playbook id.
- `updated`: a newer comparable version became the current sidebar entry.
- `unchanged`: the same version and source hash were already installed.
- `archived`: an older or incomparable version was installed but did not become
  the current sidebar entry.

The existing `POST /graph-playbooks/install` source-folder endpoint should stay
available for development and tests.

## Version And Replacement Semantics

Imported playbook packages are immutable by `(id, version, sourceHash)`.

- Same id, same version, same source hash: idempotent success.
- Same id, same version, different source hash: reject with `409`; the author
  must bump the version.
- Same id, newer comparable version: install side-by-side, update `latest.json`,
  and show only the newer version in the sidebar.
- Same id, older comparable version: install for audit/run repair, keep current
  latest in the sidebar.
- Incomparable versions: preserve current latest when possible and return a
  warning.

This gives the user the product behavior they expect - the new version replaces
the old one in the menu - without destroying old source snapshots needed by
in-flight or historical runs.

## Catalog Semantics

Keep two installed-playbook read models:

- Full installed registry: all valid installed versions, used by graph run source
  resolution when resuming pinned runs.
- Catalog registry: one latest entry per playbook id, used by `/playbooks` and
  `/playbooks/:id`.

`GET /playbooks` should return:

1. Built-in graph playbooks.
2. Latest imported graph playbooks whose ids do not collide with built-ins.

`GET /playbooks/:id` should resolve imported playbooks as well as built-ins.
Imported detail generation can reuse the existing graph detail projection, but
it must load the compiled graph from the cache and read package source files
from `installedRoot` so dashboard layouts and script source resolution keep
working.

## Zip Extraction And Validation

Do not rely on shelling out to `unzip` for the shipped app. Implement a small
sidecar archive utility for zip files using Node/Bun-compatible buffer and zlib
APIs.

Extraction rules:

- Reject archives larger than a conservative limit, for example 25 MB compressed
  and 100 MB uncompressed.
- Reject zip64, encrypted, multi-disk, and unsupported compression methods in
  the first slice.
- Allow only stored and deflated entries.
- Reject absolute paths, drive-letter paths, UNC paths, `..` segments, and
  backslash traversal.
- Reject or skip symlink entries. The existing package reader also rejects
  escaping symlinks after extraction.
- Limit file count, for example 1,000 entries.
- Extract into a random staging directory under Tessera-managed temp storage.
- Remove staging directories after install success or failure.

Package validation remains owned by the existing graph package reader, loader,
and installer:

- Manifest schema parse.
- Package-relative path enforcement.
- `node_modules`, lockfile, dependency, and `postinstall` rejection.
- Static TypeScript graph extraction.
- Dangerous import and dynamic import rejection.
- Prompt, script, schema, layout, node, artifact, and transition validation.
- Source and graph hashing.

## Desktop UX

The Playbooks sidebar keeps the current calm layout:

- Header: `Playbooks`
- Icon buttons: Import, Refresh

Import button behavior:

- Uses the Tauri dialog plugin to choose one file.
- Shows a loading state while importing.
- Disables Import, Refresh, and Run while the import is in progress.
- On success, refreshes the catalog and selects the imported playbook.
- On warning, shows the warning in the existing Playbooks error/info region.
- On cancel, does nothing.

No separate marketplace, gallery, or import wizard is needed for this slice.

## Non-Goals

- Remote GitHub import.
- Marketplace discovery.
- Package signing or trust policy UI.
- Export from Tessera.
- Workspace activation filters.
- Uninstall UI.
- Same-version force replace.
- Native SEO/GEO concepts in Tessera.

## Acceptance Criteria

- A zip of the external SEO/GEO reference playbook can be imported through the
  Playbooks UI.
- The sidecar validates and installs the archive through the existing graph
  package installer.
- The imported playbook appears in the left Playbooks menu without restarting
  Tessera.
- Starting a run for the imported playbook resolves the compiled graph from the
  cache.
- Importing a newer version of the same playbook id updates the visible sidebar
  entry instead of adding a duplicate.
- Reimporting the exact same archive succeeds idempotently.
- Reimporting the same version with different source returns a 409 with clear
  copy.
- Built-in playbooks remain protected from imported id collisions.
- Targeted sidecar, core, Tauri command, and Playbooks UI tests pass.

## Risks

- Zip parsing can quietly become a security surface. Keep the first extractor
  intentionally small and reject unsupported features.
- The existing installed registry returns all versions. The UI must use a latest
  catalog projection, not the full source-resolution registry.
- Same-version force replacement is tempting for local development, but it
  weakens run reproducibility. Keep it out of the product flow.
- The current package reader ignores assets for source install. That is fine for
  sidebar visibility, but catalog icons should remain a follow-up unless the
  package reader starts preserving assets deliberately.
