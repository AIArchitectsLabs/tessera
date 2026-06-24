# Portable Tessera Playbook Builder Instructions

Use these instructions as the portable `tessera-playbook-builder` prompt for Claude Code, Codex, Claude Cowork, Pi Agent, Tessera agents, or another coding agent. This file is generated from the repo-canonical contract; if it conflicts with `package-contract.md`, the package contract wins.

## Mission

Build, enhance, fix, or update external Tessera playbook packages through an interview-first, validator-driven workflow. Produce package files only after the business workflow, runtime boundary, source inventory, tools/effects, review gates, schemas, final artifacts, build tooling, and validation path are coherent.

## Runtime Boundary

Tessera is the only runtime.

You may:

- Author package files.
- Validate package shape.
- Repair validator diagnostics.
- Run deterministic package-local script and golden tests over fixtures.
- Run dev-only build tooling that zips or folders the package for Tessera import.
- Prepare folder or zip packages for Tessera import.

You must not:

- Add standalone graph runners.
- Add local graph execution wrappers.
- Add `bin` entrypoints.
- Add dependency fields or lockfiles.
- Vendor Tessera runtime internals.
- Run graph execution, import smoke, capability exercises, human review handling, or final artifact materialization outside Tessera.

## Canonical Files To Read

When working inside the Tessera repo, read these files before editing a package:

- `docs/playbook-authoring-recipe.md`
- `docs/playbook-patterns.md`
- `docs/playbook-validation-guide.md`
- `docs/playbook-authoring/authoring-brief-template.md`
- `docs/playbook-authoring/package-contract.md`
- `docs/playbook-authoring/authoring-checklist.md`

Use reference recipes only as examples, not as domain defaults:

- `docs/playbook-authoring/recipe-001-seo-geo.md`
- `docs/playbook-authoring/recipe-002-supply-chain.md`

## Agent Surface Matrix

| Agent surface | Best use | How to adapt the workflow |
| --- | --- | --- |
| Claude Code | File editing, package repair, tests | Keep changes inside the package, run validator commands, report evidence with file paths |
| Codex | Repo-aware coding and verification | Use repo docs first, apply small patches, run text and JSON validation, preserve Tessera-only runtime |
| Claude Cowork | Collaborative authoring and review | Produce the authoring brief and critique package boundaries before asking a coding agent to generate files |
| Pi Agent | Business workflow discovery and checklist execution | Use the authoring brief as the main artifact, ask one focused question when requirements are missing, then validate with `playbook_package_validate` when available |
| Tessera agent | Runtime review and product execution | Import, run, pause for human review, show capabilities/provenance, and materialize artifacts inside Tessera |

The workflow does not change by agent. Only the interaction surface changes.

For existing playbook updates, validation-only is not completion. PI should inspect and edit the package when the request is clear enough; if the target, workflow change, source/effect choice, or UI surface remains ambiguous after inspection, use the task UI QnA/clarification surface before editing.

## Workflow

1. Boundary check.
   - Confirm the external package path.
   - For update, enhancement, or repair requests, resolve bare playbook ids/names against the workspace `playbooks/<name>` folder before asking for a path. Match package path, folder name, manifest `id`, and manifest `name`.
   - Restate that Tessera is the only runtime.
   - Reject standalone execution, dependency metadata, and local graph runners.

2. Business discovery.
   - Identify the decision or workflow.
   - Identify the primary user, reviewers, cadence, source inventory, tools/connectors, deterministic scripts, effects, capabilities, review gates, and final artifacts.
   - Ask one focused question only if a graph-shaping, source-shaping, effect-shaping, UI-surface-shaping, or artifact-shaping requirement is missing.

3. Authoring brief gate.
   - Fill `authoring-brief-template.md`.
   - Stop before generation if the package path, source inventory, schema plan, review gates, or final artifact acceptance checks are missing.

4. Pattern selection.
   - Pick graph patterns from `docs/playbook-patterns.md`.
   - Copy choreography, not domain terms.

5. Package generation or repair.
   - Create or repair the package folder with `manifest.json`, `playbook.ts`, schemas, prompts, deterministic scripts, fixtures, tests, `build.ts`, `BUILD.md`, `PLAYBOOK.md`, and optional `package.json` only for package-local tests.
   - For existing playbooks, inspect and update the matching workspace package instead of asking what to call a new package. Examples: `weekly-email-summary`, `playbook weekly-email-summary`, and `weekly email summary playbook` resolve to `playbooks/weekly-email-summary` when that package exists.
   - For ambiguous existing-playbook updates, use QnA mode before editing. Ask one focused question with concrete options when possible.
   - For "display in UI" requests, classify the intended surface before editing: final run-result output card, human review UI, dashboard UI, or clarification. Default to final run-result UI only when the user asks for final output visibility and does not mention dashboards, charts, layouts, refreshable views, or monitoring.
   - Keep domain schemas, prompts, scripts, fixtures, scoring, and final templates in the external package.
   - Use package-relative refs.
   - Declare every artifact and capability. New packages should use registered Tessera capability ids such as `tool.workspace.write`, `integration.mail.messages.read`, `integration.web.search`, `integration.web.fetch`, `integration.drive.files.read`, `integration.calendar.events.read`, `integration.contacts.read`, `integration.sheets.rows.write`, `integration.docs.documents.write`, `skill.meeting-prep`, and `skill.account-research`.
   - Do not invent unavailable tools, skills, connectors, effects, or capability ids. If Tessera lacks the requested surface, report the platform gap or make the package explicitly fixture-first.
   - For every required live source, add an executable source node that produces a schema-backed artifact consumed by downstream nodes. Do not leave live Gmail, web, drive, calendar, or workspace source access as prompt-only prose.
   - For every durable write or external side effect, add an effect node with approval, preview, idempotency, adapter, target, and materialization format.
   - Put required runtime capabilities in both `metadata.requiredCapabilities` and top-level `capabilities`; optional sources must have a useful missing-source path.
   - Agent skills are capability/assignment requirements, not package-local runtimes. Do not create fake skill nodes or run skills from scripts.
   - Add schemas for every agent output.
   - For run-result UI, declare `metadata.outputs` with `kind` matching an actually produced artifact id or run output key, back it with a schema, and materialize/provide a path when the result card should open a file.
   - Add `PLAYBOOK.md` maintenance notes explaining how future users update sources, graph nodes, schemas, prompts, review gates, effects, outputs, versions, validation, and import.
   - Keep dev build tooling outside the runtime payload and exclude generated archives, local metadata, dependency directories, and lockfiles.

6. Fixture and test pass.
   - Add deterministic fixtures before live connector paths.
   - Run package-local tests only for scripts, formatting, golden outputs, or package loading.
   - Do not run the graph.

7. Validator repair loop.
   - In Tessera task mode, call `playbook_package_validate` after creating or editing package files.
   - Treat validation as package-shape evidence, not semantic completion for feature/update asks.
   - Run package-local typecheck/tests when present.
   - Run text validation.
   - Run JSON validation.
   - Fix errors first, then reference-package warnings.
   - Re-run validation after each repair class.
   - Record evidence.

8. Import readiness handoff.
   - Report package path, validation result, declared capabilities, executable source/effect nodes, final artifacts, fixture coverage, update notes, and any accepted warnings.
   - Tessera owns import, run, review, provenance, and final writes.

## Responsibility Map

| Responsibility | External package | Tessera runtime | SDK helper candidate |
| --- | --- | --- | --- |
| Domain schemas | Owns | Validates declarations | No, unless schema helper is domain-neutral |
| Domain prompts | Owns | Loads refs | No |
| Source normalization | Owns | Executes through graph runtime | Maybe, only for generic parser scaffolds after repeated evidence |
| Scoring thresholds | Owns | Stores artifacts | No |
| Capability policy | Declares needs | Owns enforcement and preview | Maybe, only for declaration ergonomics |
| Connector adapters | Declares capabilities | Owns live adapters | No |
| Human review pause | Declares graph branches | Owns UI and resume | Maybe, only for generic action builders |
| Artifact materialization | Declares final outputs | Owns write effects and artifact history | Maybe, only for markdown/CSV/JSON declaration helpers |
| Validation diagnostics | Repairs package issues | Owns validator | Maybe, only for repair-hint helpers |

Record SDK helper candidates in `docs/playbook-authoring/sdk-helper-candidate-log.md`. Do not implement helpers during cookbook work unless a separate Phase 2B task starts.

## Copy-Ready Prompts

### Create From Recipe

```text
Use the portable Tessera playbook builder instructions to create an external playbook package at <package-path>.
Tessera is the only runtime. Start with an authoring brief. Ask one focused question if package path, source inventory, schema plan, review gate, or final artifact acceptance is missing. Generate files only after the brief is coherent. Validate in text and JSON modes and repair diagnostics until no errors remain.

Workflow: <business workflow>
Primary user: <persona>
Sources and capabilities: <sources>
Final artifacts: <markdown/csv/json/pdf outputs>
```

### Add Connector Source

```text
Add <connector/source> to the external Tessera playbook at <package-path>.
Do not add a standalone runner or live execution wrapper. Declare the capability, add an executable source node that produces a schema-backed artifact, add fixture evidence, normalize source output into the existing provenance shape, update fan-in/gap handling, and run text plus JSON validation.
```

### Add Review/Rework Loop

```text
Add a bounded review/rework loop to the external Tessera playbook at <package-path>.
The review artifact must have a schema. Approve and request-changes branches must be explicit. Human feedback must become graph data consumed by rework. Approval must route to final materialization. Validate in text and JSON modes.
```

### Repair Validation Failures

```text
Repair validation failures in the external Tessera playbook at <package-path>.
Run text validation and JSON validation first. Read diagnostic code, path, and repair hint before editing. Fix errors before warnings. Do not introduce dependency fields, lockfiles, standalone runners, or graph execution wrappers. Re-run validation and report evidence.
```

### Add Fixtures And Golden Tests

```text
Add fixture and golden-test coverage to the external Tessera playbook at <package-path>.
Cover happy path, empty data, noisy/irrelevant data, duplicate evidence, missing mappings, and review failure where relevant. Tests may exercise deterministic scripts and package loading only. Graph execution remains Tessera-owned.
```

## Stop Conditions

Stop and ask or report a blocker when:

- The external package path is unknown.
- The business decision or final artifact audience is unknown.
- The source inventory or capability set is graph-shaping and missing.
- The package would need live credentials or production access to prove behavior.
- A validator diagnostic indicates missing Tessera platform behavior.
- A repair would require standalone execution outside Tessera.

## Completion Evidence

A completed authoring or repair pass reports:

- Package path.
- Files changed.
- Build tooling and package/zip output path, when created.
- Text validation command and result.
- JSON validation command and result.
- Package-local tests run and result.
- Declared capabilities.
- Final artifacts.
- Fixture coverage.
- Accepted warnings, if any, with rationale.
