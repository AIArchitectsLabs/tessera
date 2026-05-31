# Tessera Playbook Authoring Recipe

Use this recipe to create or repair an external Tessera playbook package from a business workflow idea. It is portable across Claude Code, Codex, Claude Cowork, Pi Agent, Tessera agents, and other coding agents because it relies on repository files, validator output, and package-local fixtures instead of a specific agent runtime.

## Non-Negotiable Boundary

Tessera is the only runtime for playbook graphs. External agents may author package files, repair diagnostics, run deterministic script tests over fixtures, and package the result. They must not run the graph outside Tessera.

Allowed outside Tessera:

- Edit prompts, schemas, scripts, templates, fixtures, and tests inside the external package.
- Run `playbook validate` in text and JSON modes.
- Run package-local deterministic unit tests for scripts and golden fixtures.
- Zip or folder-package the playbook for Tessera import.

Not allowed outside Tessera:

- Standalone graph runners or local execution wrappers.
- `bin` entrypoints, dependency fields, lockfiles, or runtime scripts such as `start`, `serve`, `run`, or `execute`.
- Vendored Tessera runtime internals.
- Graph execution, import smoke, connector capability exercise, human review handling, or final artifact materialization.

## Inputs

Start with these artifacts:

- Business workflow prompt from the user.
- External package path.
- Tessera validation command, usually:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path>
```

- Existing canonical contract:
  - `docs/playbook-authoring/authoring-brief-template.md`
  - `docs/playbook-authoring/package-contract.md`
  - `docs/playbook-authoring/authoring-checklist.md`
  - `docs/playbook-authoring/validation-loop.md`

Reference examples:

- SEO/GEO content workflow: `docs/playbook-authoring/recipe-001-seo-geo.md`
- Supply-chain operational workflow: `docs/playbook-authoring/recipe-002-supply-chain.md`
- Third-domain forward test: `docs/playbook-authoring/forward-test-001-customer-support-escalation.md`
- Third-playbook validation/import proof: `docs/playbook-authoring/portability-proof-002-procurement-rfq-followup.md`

## Step 1: Write The Authoring Brief

Before generating files, fill the brief shape from `docs/playbook-authoring/authoring-brief-template.md`.

The brief must name:

- Runtime boundary and external package path.
- Business decision or workflow the playbook improves.
- Primary user, reviewer, and final artifact audience.
- Source inventory with capabilities, access mode, and fixture coverage.
- Domain entities and normalized intermediate records.
- Provenance, confidence, quality, privacy, and no-invention rules.
- Graph sketch from intake through materialization.
- Schema plan for every agent output and final artifact.
- Human review and rework gates.
- Validation commands and evidence location.

If any field would change graph shape and cannot be inferred, ask one focused question and stop before generation.

## Step 2: Choose Graph Patterns

Use `docs/playbook-patterns.md` to pick only the patterns the workflow needs. Most business playbooks combine:

- Intake normalization.
- Source collection with declared capabilities.
- Package-local source normalization scripts.
- Fan-in with provenance and gaps.
- Draft artifact generation.
- Automatic review and bounded rework.
- Human review with approve and request-changes branches.
- Final artifact materialization as markdown, CSV, JSON, or PDF.

Do not copy domain terms from reference playbooks. Copy graph choreography and package structure; rewrite schemas, prompts, scripts, scoring, fixtures, and final templates.

## Step 3: Build Schemas First

Create schemas before prompts and scripts when possible.

Minimum schema expectations:

- Every agent output has a schema.
- Every final artifact has a materializable shape.
- Source records include provenance.
- Review outputs include pass/fail, findings, and revision instructions.
- Rework inputs include prior artifact plus review findings or human feedback.

Keep domain-specific schemas inside the external package. Promote only generic capability, provenance, or materialization primitives into Tessera.

## Step 4: Author Deterministic Scripts

Scripts are package-local helpers for shaping data. They may run in package tests, but they must not execute the graph.

Use scripts for:

- Input normalization.
- Source parsing and deduplication.
- Confidence, severity, priority, or quality scoring.
- Fan-in and gap summaries.
- Conversion from draft records to final markdown, CSV, JSON, or PDF structures.

Every script should tolerate empty, noisy, duplicate, and partial fixture data. Keep thresholds and scoring vocabulary domain-owned.

## Step 5: Write Prompts Around Schemas

Prompts should consume compact schema-shaped inputs and produce schema-conformant outputs. They should not include runtime instructions such as how to run the graph.

Prompt rules:

- Name the exact output schema.
- Include no-invention rules.
- Ask for evidence references and assumptions when needed.
- Keep review prompts structured.
- Make rework prompts consume prior artifact plus explicit feedback.
- Reinforce that Tessera owns execution, review pauses, and final writes.

## Step 6: Add Fixtures And Golden Tests

Every reference-quality playbook needs fixture coverage before live connector paths.

Fixture expectations:

- Happy path.
- Empty or missing source path.
- Noisy or irrelevant source path.
- Duplicate evidence path.
- Missing required domain mapping path.
- Review failure or request-changes path when relevant.

Package-local tests can verify deterministic scripts and graph package loading. They must not run the graph.

## Step 7: Validate, Repair, Repeat

Run the validator in text mode first:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path>
```

Then run JSON mode for repair automation:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path> --json
```

Repair order:

1. Errors.
2. Warnings for reference playbooks, unless explicitly accepted.
3. Info diagnostics as guidance.

Record evidence in the package notes, plan artifact, or pull request:

```json
{
  "command": "bun run --cwd apps/cli src/index.ts playbook validate <path> --json",
  "exitCode": 0,
  "ok": true,
  "summary": {
    "errors": 0,
    "warnings": 0,
    "info": 0
  },
  "unresolvedDiagnostics": [],
  "repairNotes": []
}
```

Use `docs/playbook-validation-guide.md` for the full repair loop.

## Step 8: Package And Import Through Tessera

A package is ready for Tessera import when:

- Validation has zero errors.
- Reference packages have zero unaccepted warnings.
- Required capabilities are declared.
- Fixture inputs can produce final artifacts through Tessera.
- Final outputs are markdown, CSV, JSON, or PDF.
- Provenance is visible enough for review.
- The folder or zip excludes generated junk, dependency directories, lockfiles, and local metadata.

Import and run behavior is verified in Tessera, not through an external runner.

## Agent Prompt Templates

### Create A New Playbook From Recipe

```text
Use the Tessera playbook authoring recipe to create an external playbook package at <package-path>.
Tessera is the only runtime. Start by filling the authoring brief, ask one focused question if a graph-shaping requirement is missing, then create package files only after the brief is coherent. Validate in text and JSON modes and repair diagnostics until there are no errors.
Workflow: <business workflow>
Primary user: <persona>
Final artifacts: <markdown/csv/json/pdf outputs>
Sources and capabilities: <source inventory>
```

### Add A Connector Source

```text
Add <source> to the external playbook at <package-path>.
Do not add a standalone runner or live execution path. Declare the capability, add fixture evidence, normalize the source into the existing provenance schema, update fan-in and gap handling, and run text plus JSON validation.
```

### Add A Review/Rework Loop

```text
Add a bounded review and rework loop to <package-path>.
The review output must have a schema, approve/request-changes branches must be explicit, human feedback must become graph data, and approval must return to final materialization. Validate and record evidence.
```

### Repair Validation Failures

```text
Repair validator diagnostics for <package-path>.
Run text and JSON validation, fix errors first, then warnings, and do not introduce dependency fields, lockfiles, local graph runners, or runtime wrappers. Preserve Tessera-only runtime ownership.
```

### Add Fixtures And Golden Tests

```text
Add fixture and golden-test coverage to <package-path>.
Cover happy path, empty data, noisy data, duplicate evidence, missing mappings, and review failure where relevant. Tests may exercise deterministic scripts and package loading only; graph execution remains Tessera-owned.
```

## Stop Conditions

Stop and ask or report a blocker when:

- The external package path is unknown.
- The business outcome, final artifact audience, or review gate is unknown.
- The package would need credentials or production access to prove fixture behavior.
- A validator diagnostic implies missing Tessera platform behavior.
- A proposed repair would require standalone execution outside Tessera.
