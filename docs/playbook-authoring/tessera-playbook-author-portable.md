# Portable Tessera Playbook Author Instructions

Use these instructions as the portable `tessera-playbook-author` prompt for Claude Code, Codex, Claude Cowork, Pi Agent, Tessera agents, or another coding agent. This file is generated from the repo-canonical contract; if it conflicts with `package-contract.md`, the package contract wins.

## Mission

Author or repair external Tessera playbook packages through an interview-first, validator-driven workflow. Produce package files only after the business workflow, runtime boundary, source inventory, tools/effects, review gates, schemas, final artifacts, build tooling, and validation path are coherent.

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
| Pi Agent | Business workflow discovery and checklist execution | Use the authoring brief as the main artifact, ask one focused question when requirements are missing |
| Tessera agent | Runtime review and product execution | Import, run, pause for human review, show capabilities/provenance, and materialize artifacts inside Tessera |

The workflow does not change by agent. Only the interaction surface changes.

## Workflow

1. Boundary check.
   - Confirm the external package path.
   - Restate that Tessera is the only runtime.
   - Reject standalone execution, dependency metadata, and local graph runners.

2. Business discovery.
   - Identify the decision or workflow.
   - Identify the primary user, reviewers, cadence, source inventory, tools/connectors, deterministic scripts, effects, capabilities, review gates, and final artifacts.
   - Ask one focused question only if a graph-shaping, source-shaping, effect-shaping, or artifact-shaping requirement is missing.

3. Authoring brief gate.
   - Fill `authoring-brief-template.md`.
   - Stop before generation if the package path, source inventory, schema plan, review gates, or final artifact acceptance checks are missing.

4. Pattern selection.
   - Pick graph patterns from `docs/playbook-patterns.md`.
   - Copy choreography, not domain terms.

5. Package generation or repair.
   - Create or repair the package folder with `manifest.json`, `playbook.ts`, schemas, prompts, deterministic scripts, fixtures, tests, `build.ts`, `BUILD.md`, `PLAYBOOK.md`, and optional `package.json` only for package-local tests.
   - Keep domain schemas, prompts, scripts, fixtures, scoring, and final templates in the external package.
   - Use package-relative refs.
   - Declare every artifact and capability.
   - Add schemas for every agent output.
   - Keep dev build tooling outside the runtime payload and exclude generated archives, local metadata, dependency directories, and lockfiles.

6. Fixture and test pass.
   - Add deterministic fixtures before live connector paths.
   - Run package-local tests only for scripts, formatting, golden outputs, or package loading.
   - Do not run the graph.

7. Validator repair loop.
   - Run package-local typecheck/tests when present.
   - Run text validation.
   - Run JSON validation.
   - Fix errors first, then reference-package warnings.
   - Re-run validation after each repair class.
   - Record evidence.

8. Import readiness handoff.
   - Report package path, validation result, declared capabilities, final artifacts, fixture coverage, and any accepted warnings.
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
Use the portable Tessera playbook author instructions to create an external playbook package at <package-path>.
Tessera is the only runtime. Start with an authoring brief. Ask one focused question if package path, source inventory, schema plan, review gate, or final artifact acceptance is missing. Generate files only after the brief is coherent. Validate in text and JSON modes and repair diagnostics until no errors remain.

Workflow: <business workflow>
Primary user: <persona>
Sources and capabilities: <sources>
Final artifacts: <markdown/csv/json/pdf outputs>
```

### Add Connector Source

```text
Add <connector/source> to the external Tessera playbook at <package-path>.
Do not add a standalone runner or live execution wrapper. Declare the capability, add fixture evidence, normalize source output into the existing provenance shape, update fan-in/gap handling, and run text plus JSON validation.
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
