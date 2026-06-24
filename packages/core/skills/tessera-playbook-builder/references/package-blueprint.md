# Package Blueprint

Use this reference when creating a playbook package from scratch. It distills the stable shape used by the SEO/GEO, supply-chain, and procurement reference playbooks.

## Folder Shape

Required or normally expected:

```text
<playbook-package>/
├── manifest.json
├── playbook.ts
├── PLAYBOOK.md
├── BUILD.md
├── build.ts
├── schemas/
│   └── *.schema.json
├── prompts/
│   └── *.md
├── scripts/
│   └── *.ts
├── tests/
│   └── *.test.ts
├── fixtures/
│   └── *.json
└── package.json (optional; no dependency fields, no bin)
```

Generated archives belong in `dist/` or the package root only after validation. Exclude generated archives, dependency directories, local metadata, lockfiles, and workspace artifacts from import payloads.

## Bootstrap Files

`manifest.json` declares:

- `schemaVersion`
- `id`
- `version`
- `name`
- `entrypoint`: usually `playbook.ts`

`playbook.ts` default-exports the graph and should declare:

- `schemaVersion`, `id`, `version`, `name`, `description`
- `metadata.requiredCapabilities`, `metadata.optionalCapabilities`, `metadata.outputs`, and `metadata.phases`
- `inputs`
- `artifacts` with schema refs
- `capabilities`
- `limits` for fanout/tool calls where relevant
- `start`
- `nodes`

Keep `manifest.json`, `playbook.ts`, and `package.json` version values in lockstep when `package.json` exists. Procurement-style packages may omit `package.json`; then lock `manifest.json` and `playbook.ts`.

## Production Grade Baseline

A generated package should be a maintainable Tessera workflow, not a demo skeleton:

- Use registered Tessera capability ids for tools, connectors, skills, and effects. New packages should prefer `tool.workspace.read`, `tool.workspace.write`, `integration.calendar.events.read`, `integration.crm.accounts.read`, `integration.web.search`, `integration.web.fetch`, `integration.mail.messages.read`, `integration.mail.drafts.write`, `integration.drive.files.read`, `integration.contacts.read`, `integration.sheets.rows.write`, `integration.docs.documents.write`, `skill.meeting-prep`, and `skill.account-research`.
- Put required capabilities in both `metadata.requiredCapabilities` and top-level `capabilities`; optional capabilities must have a useful missing-source path.
- Every required live source must be collected by an executable graph node and stored in a schema-backed raw-source artifact before an agent summarizes it.
- Every durable write must be an `effect` node with approval, preview, idempotency, and a materialization target.
- Every final run-result UI output must be declared in `metadata.outputs` with `kind` matching a produced artifact id or run output key, backed by a schema. Use `kind: "dashboard"` only for dashboard layouts.
- Agent skills are assignment requirements, not package-local scripts. Document any skill capability that an agent step depends on, but do not create a fake `skill` node or run a skill helper outside Tessera.
- `PLAYBOOK.md` must tell a future user how to update the workflow: sources, capabilities, graph nodes, schemas, prompts, review gates, outputs, version bumping, validation, and import.

## Graph Conventions

Common node kinds:

- `script` for deterministic package-local normalization, parsing, scoring, fan-in, structuring, and final formatting.
- `tool` for declared Tessera capabilities such as `integration.web.search`, `integration.web.fetch`, `integration.mail.messages.read`, or `tool.workspace.write`.
- `parallelMap` for bounded source fanout and branch fan-in.
- `agent` for draft, review, summarize, and rework steps with schema-backed outputs.
- `condition` for review/revision and data-presence routing.
- `humanReview` for explicit approve/request-changes pauses.
- `effect` for external writes.

Working source rule:

- If a requested playbook depends on a live source, add an executable `tool` or connector node for that source. Do not rely on an agent prompt to "use Gmail", "search the web", "read Drive", or "check the calendar" without a source node that actually produces evidence.
- Use registered capability ids in tool/effect nodes. Do not invent connector ids or capability names.
- Required live sources belong in `metadata.requiredCapabilities` and top-level `capabilities`; optional exploratory sources may be optional only when the playbook can still produce a useful final artifact without them.
- Source nodes should write schema-backed raw-source artifacts, and downstream scripts or agents should consume those artifacts explicitly.
- For email or Gmail workflows, prefer `integration.mail.messages.read` with `mail search` or `mail list`, a raw mail result artifact, and draft prompts that treat empty results as a source gap rather than inventing content.
- Fixture data is required for package-local tests, but fixture coverage must not replace live source nodes when the user asked for a connector-backed runtime workflow.

Effect nodes should be explicit about side effects:

- declare the capability
- require approval for workspace writes or other durable external writes
- use an idempotency key
- provide a preview with title and summary
- route approval to a downstream materialization or draft step

## Schema-First Authoring

Create schemas before writing prompts when possible.

Minimum schema set:

- normalized intake
- source/search/fetch/tool result
- source summary or normalized source record
- fan-in aggregate
- draft seed
- raw agent draft
- structured draft
- review result
- human feedback
- final materialized artifact

Every agent output must declare a schema. Every final artifact should have a distinct materializable schema rather than reusing a draft or review schema.

## Prompt And Script Rules

Prompts:

- consume compact schema-shaped inputs
- name the expected schema
- require evidence, assumptions, and no-invention behavior where relevant
- avoid runtime instructions
- route review findings into rework prompts

Scripts:

- are deterministic over inputs and fixtures
- do not import Tessera runtime internals
- tolerate empty, noisy, duplicate, partial, and irrelevant fixture data
- keep scoring thresholds and domain vocabulary in the package
- may be tested externally but must not execute the graph

## Dev Build Tooling

Include `build.ts` and `BUILD.md` for repeatable authoring, but keep them dev-only. They are not graph runtime files.

Recommended commands:

```text
bun run build.ts bump <major|minor|patch|x.y.z>
bun run build.ts package
bun run build.ts validate
bun run build.ts release [major|minor|patch]
bun run build.ts help
```

`build.ts validate` should:

- assert version lockstep
- run `bunx tsc --noEmit -p tsconfig.json` when `tsconfig.json` exists
- run focused package-local tests
- run Tessera `playbook validate <package-path>`

Support an explicit Tessera repo override such as `TESSERA_ROOT` or `TESSERA_REPO_ROOT`; do not hide hard-coded local paths as the only path.

`build.ts package` should:

- build a reproducible zip such as `dist/<package-name>-<version>.zip`
- use tracked files or a deterministic file walk
- exclude `build.ts`, `BUILD.md`, generated archives, local metadata, dependency directories, lockfiles, and any files intentionally outside the import payload

## Tests

Package-local tests may verify:

- version lockstep
- every schema parses as JSON
- package loading through Tessera graph package loader when the Tessera repo is available
- deterministic scripts over fixtures
- declared capabilities and final artifact/effect paths
- that draft-only intermediate artifacts are not accidentally final writes

Tests must not run the graph, exercise live connectors, handle human review pauses, or materialize final artifacts outside Tessera.

## Import Readiness

Before reporting completion:

- package folder exists with package-relative refs
- graph uses only declared, registered capabilities or documented legacy aliases during repair
- required live sources/effects have executable graph nodes, not prompt-only instructions
- build tooling is present and dev-only
- text validation passes
- JSON validation passes
- package-local tests pass or the gap is explained
- final artifacts are markdown, CSV, JSON, or PDF
- live capabilities are declared and fixture coverage is credential-free
- `PLAYBOOK.md` documents update/upgrade steps for maintainers
- no standalone runner, dependency fields, lockfiles, unsafe refs, or local graph execution wrappers exist
