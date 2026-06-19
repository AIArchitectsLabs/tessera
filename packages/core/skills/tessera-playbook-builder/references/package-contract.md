# Package Contract

Tessera is the only runtime. External agents may author, validate, repair, package, and test deterministic package-local scripts, but they must not run playbook graphs outside Tessera.

## Allowed Outside Tessera

- Edit package files.
- Run `playbook validate`.
- Repair diagnostics.
- Run deterministic script tests over fixtures.
- Run golden tests for domain normalization or scoring scripts.
- Run dev-only build tooling that packages a folder or zip for Tessera import.

## Not Allowed Outside Tessera

- Standalone graph runner.
- Local execution wrapper.
- `bin` entrypoint.
- Dependency fields or lockfiles.
- Vendored Tessera runtime internals.
- Graph run, import smoke, capability exercise, or final artifact materialization.

## Package Rules

- Use package-relative refs.
- Declare every capability used by tools, connectors, skills, or effects.
- Prefer registered Tessera capability ids for new packages: `tool.workspace.read`, `tool.workspace.write`, `integration.calendar.events.read`, `integration.crm.accounts.read`, `integration.web.search`, `integration.web.fetch`, `integration.mail.messages.read`, `integration.mail.drafts.write`, `integration.drive.files.read`, `integration.contacts.read`, `integration.sheets.rows.write`, `integration.docs.documents.write`, `skill.meeting-prep`, and `skill.account-research`.
- Do not invent capability ids or connector ids. Use legacy aliases only when repairing a legacy package and document why they remain.
- When a playbook depends on a live connector or workspace source, include an executable graph node that collects that source and produces a declared artifact. Prompt-only source instructions are not a working connector-backed playbook.
- Put required live source capabilities in both `metadata.requiredCapabilities` and top-level `capabilities`; reserve `metadata.optionalCapabilities` for sources that can be missing without breaking the business outcome.
- Declare schemas for every agent output.
- Materialize final artifacts as markdown, CSV, JSON, or PDF.
- For final run-result UI, declare `metadata.outputs` with a `kind` that matches an actually produced artifact id or run output key; do not use a display label that has no produced value.
- Use `kind: "dashboard"` only for dashboard, chart, layout, refreshable monitoring, or similar dashboard surfaces.
- Keep domain schemas, prompts, scoring, fixtures, and taxonomies in the external package.
- Keep Tessera runtime, connector policy, review pause handling, and artifact history in Tessera.
- Keep packages maintainable: preserve package `id`, keep stable node/artifact ids where possible, version schema changes, update fixtures/tests with behavior changes, and document operator-facing update steps in `PLAYBOOK.md`.
- Dev build scripts may exist, but they must not be graph runtime files and should be excluded from import payloads when the package format expects runtime-only contents.
- `package.json`, when present, may define package-local tests only; it must not define `bin`, dependency fields, or runtime scripts such as `start`, `dev`, `serve`, `run`, `execute`, or `playbook`.

## Common Validator Failures

- missing prompt/script/schema refs
- unsafe source paths
- unreachable nodes
- undeclared artifacts or capabilities
- agent outputs without schemas
- final artifact writes without useful materialization
- review loops without clear downstream return
- standalone runner metadata
- dangerous imports or disallowed dependency fields
- invented or unsupported capability ids
- production source/effect described only in prompts
