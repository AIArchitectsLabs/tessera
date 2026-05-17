# First-Party Built-in Graph Playbooks

Built-in graph playbooks live in `packages/core` and are loaded from the source folders under `packages/core/src/builtin-graph-playbooks/`. The shipped bundle is generated into `packages/core/src/builtin-graph-playbook-bundles.generated.ts`, and the loader entrypoint is `packages/core/src/builtin-graph-playbooks.ts`.

Use the built-in layout only for first-party playbooks. Do not copy this structure into plugins or app code.

## Package Layout

Each playbook gets one folder with a stable package id:

| Example path | Purpose |
| --- | --- |
| [`packages/core/src/builtin-graph-playbooks/demo.write-approval/`](../packages/core/src/builtin-graph-playbooks/demo.write-approval/) | Minimal script-only built-in |
| [`packages/core/src/builtin-graph-playbooks/customer.renewal-risk-review/`](../packages/core/src/builtin-graph-playbooks/customer.renewal-risk-review/) | Review flow with `humanReview` and `artifactWrite` |
| [`packages/core/src/builtin-graph-playbooks/ops.weekly-status-digest/`](../packages/core/src/builtin-graph-playbooks/ops.weekly-status-digest/) | Review flow with evidence sources |
| [`packages/core/src/builtin-graph-playbooks/ops.activity-snapshot/`](../packages/core/src/builtin-graph-playbooks/ops.activity-snapshot/) | Dashboard output example |
| [`packages/core/src/builtin-graph-playbooks/sales.meeting-brief/`](../packages/core/src/builtin-graph-playbooks/sales.meeting-brief/) | Review flow with an approval artifact |

Inside a playbook folder, keep files package-relative and stable:

- `manifest.json`
- `playbook.ts`
- `prompts/*.md`
- `prompts/*.md.d.ts` when TypeScript imports a markdown prompt
- `scripts/*.ts`
- `schemas/*.json`
- `layouts/*.json`

The package reader only collects those source files plus `manifest.json`. It ignores `assets/`, lockfiles, `node_modules/`, and executable hook directories.

## Manifest And Playbook Fields

`manifest.json` is the package entry manifest. It uses:

- `schemaVersion`
- `id`
- `version`
- `name`
- `description`
- `entrypoint` (`playbook.ts` by default)

See [`ops.activity-snapshot/manifest.json`](../packages/core/src/builtin-graph-playbooks/ops.activity-snapshot/manifest.json) and [`demo.write-approval/manifest.json`](../packages/core/src/builtin-graph-playbooks/demo.write-approval/manifest.json) for the current shape.

`playbook.ts` is the compiled graph source of truth. It exports one default object with the core graph fields:

- `schemaVersion`
- `id`
- `version`
- `name`
- `description`
- `metadata`
- `inputs`
- `artifacts`
- `capabilities`
- `limits`
- `start`
- `nodes`

Use [`customer.renewal-risk-review/playbook.ts`](../packages/core/src/builtin-graph-playbooks/customer.renewal-risk-review/playbook.ts) or [`sales.meeting-brief/playbook.ts`](../packages/core/src/builtin-graph-playbooks/sales.meeting-brief/playbook.ts) as the review-flow reference.

## Prompts, Schemas, Scripts, And Layouts

Keep supporting files under the matching subdirectory and reference them by package-relative path from `playbook.ts`:

- `prompts/*.md` holds agent prompts.
- `scripts/*.ts` holds script nodes.
- `schemas/*.json` holds artifact schemas.
- `layouts/*.json` holds dashboard layouts.

Examples:

- [`ops.activity-snapshot/prompts/draft-snapshot.md`](../packages/core/src/builtin-graph-playbooks/ops.activity-snapshot/prompts/draft-snapshot.md)
- [`ops.weekly-update/scripts/stageDraft.ts`](../packages/core/src/builtin-graph-playbooks/ops.weekly-update/scripts/stageDraft.ts)
- [`sales.meeting-brief/schemas/meetingBrief.schema.json`](../packages/core/src/builtin-graph-playbooks/sales.meeting-brief/schemas/meetingBrief.schema.json)
- [`ops.activity-snapshot/layouts/dashboard.json`](../packages/core/src/builtin-graph-playbooks/ops.activity-snapshot/layouts/dashboard.json)

If a prompt is imported from TypeScript, keep the matching `.md.d.ts` stub next to it. The current built-ins use that pattern for prompt files that are imported elsewhere.

## Review Nodes And Artifact Writes

Use `humanReview` when a playbook must pause on an artifact and wait for a decision. The current first-party examples are:

- [`customer.renewal-risk-review/playbook.ts`](../packages/core/src/builtin-graph-playbooks/customer.renewal-risk-review/playbook.ts)
- [`ops.weekly-status-digest/playbook.ts`](../packages/core/src/builtin-graph-playbooks/ops.weekly-status-digest/playbook.ts)
- [`sales.meeting-brief/playbook.ts`](../packages/core/src/builtin-graph-playbooks/sales.meeting-brief/playbook.ts)

Author `humanReview` nodes with:

- `artifact`
- `actions`
- `onApprove`
- `onRequestChanges`

Use `artifactWrite` when the review result should be written back into the workspace. Author it with:

- `artifact`
- `path`
- `onSuccess: "completed"`

See the `artifactWrite` nodes in the same three playbooks above for concrete field values.

## Dashboard Outputs

Dashboard playbooks declare their output in `metadata.outputs` with `kind: "dashboard"`. The current built-in example is [`ops.activity-snapshot/playbook.ts`](../packages/core/src/builtin-graph-playbooks/ops.activity-snapshot/playbook.ts).

For dashboard playbooks:

- Keep the output artifact and schema in `artifacts`, as in `artifacts.dashboard.schema` in [`ops.activity-snapshot/playbook.ts`](../packages/core/src/builtin-graph-playbooks/ops.activity-snapshot/playbook.ts).
- Use `layouts/dashboard.json` for a static layout.
- Use `layoutScript` only if the layout is generated by a script.
- Do not author `layoutData`; it is runtime materialization, not source input.

The dashboard layout schema is binding-based. Bindings point into the run outputs with dotted paths such as `draftSnapshot.openItems` and `draftSnapshot.summary`.

## Bundle Regeneration

Whenever you change any built-in graph package, regenerate the shipped bundle:

```bash
bun run scripts/generate-builtin-graph-playbook-bundles.ts
```

That command rewrites [`packages/core/src/builtin-graph-playbook-bundles.generated.ts`](../packages/core/src/builtin-graph-playbook-bundles.generated.ts). Commit the regenerated bundle together with the source package changes.

The generated bundle is keyed by playbook id, so keep the `manifest.json` id and the `playbook.ts` id aligned.

## Boundaries And Dependency Rules

- Keep built-in graph playbooks inside `packages/core/src/builtin-graph-playbooks/`.
- Do not add new npm/bun dependencies for built-in playbooks.
- Do not add dependency fields or `scripts.postinstall` to a package-local `package.json`.
- Do not add lockfiles inside a built-in package root.
- Keep package-relative paths contained within the playbook folder.

## Verification

Run the focused checks before merging built-in playbook changes:

```bash
bun test packages/core/src/builtin-graph-playbooks.test.ts
bun test packages/core/src/playbook-graph-package.test.ts packages/core/src/playbook-graph-package-loader.test.ts
bun run scripts/generate-builtin-graph-playbook-bundles.ts
bun run check
```
