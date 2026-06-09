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

## Graph Conventions

Common node kinds:

- `script` for deterministic package-local normalization, parsing, scoring, fan-in, structuring, and final formatting.
- `tool` for declared Tessera capabilities such as `web.search`, `web.fetch`, `gmail.search`, or `tool.workspace.write`.
- `parallelMap` for bounded source fanout and branch fan-in.
- `agent` for draft, review, summarize, and rework steps with schema-backed outputs.
- `condition` for review/revision and data-presence routing.
- `humanReview` for explicit approve/request-changes pauses.
- `effect` for external writes.

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
- build tooling is present and dev-only
- text validation passes
- JSON validation passes
- package-local tests pass or the gap is explained
- final artifacts are markdown, CSV, JSON, or PDF
- live capabilities are declared and fixture coverage is credential-free
- no standalone runner, dependency fields, lockfiles, unsafe refs, or local graph execution wrappers exist
