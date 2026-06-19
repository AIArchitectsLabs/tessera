# Tessera Playbook Authoring Brief Template

Use this brief before generating or repairing an external Tessera playbook package. If a required field is unknown and cannot be inferred from local artifacts, stop and ask one focused question before creating files.

## Runtime Boundary

- Tessera is the only runtime.
- External agents may author, validate, repair, package, and test deterministic scripts or golden fixtures.
- External agents must not create standalone graph runners, `bin` entrypoints, dependency fields, lockfiles, local execution wrappers, or non-Tessera runtime paths.
- Graph runs, import smoke tests, artifact materialization, and capability exercises happen through Tessera.

## Package Identity

- Working title:
- External package path:
- Owning team/persona:
- Target Tessera version or validation command:
- Reference recipe, if any:

## Business Outcome

- Business decision this playbook supports:
- Primary user:
- Secondary users or reviewers:
- Operational cadence or trigger:
- Definition of a useful final packet:
- Explicit non-goals:

## Source Inventory

| Source | Capability | Access mode | Fixture/golden coverage | Notes |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Use registered Tessera capability ids. Current examples:

- `tool.workspace.read`
- `tool.workspace.write`
- `integration.calendar.events.read`
- `integration.crm.accounts.read`
- `integration.web.search`
- `integration.web.fetch`
- `integration.mail.messages.read`
- `integration.mail.drafts.write`
- `integration.drive.files.read`
- `integration.contacts.read`
- `integration.sheets.rows.write`
- `integration.docs.documents.write`
- `skill.meeting-prep`
- `skill.account-research`

For every source required by the business outcome, name the executable graph node that collects it. A source listed only in a prompt is not sufficient for a usable connector-backed playbook.

If a requested source, tool, skill, connector, or effect is not available in Tessera, record the platform gap instead of inventing a capability id.

## Data Requirements

- Input entities:
- Normalized intermediate records:
- Required provenance fields:
- Confidence or quality fields:
- Fields that must never be invented:
- Privacy or redaction rules:

## Graph Sketch

| Phase | Node kind | Inputs | Outputs | Schema required | Review required |
| --- | --- | --- | --- | --- | --- |
| Intake |  |  |  |  |  |
| Normalize |  |  |  |  |  |
| Analyze |  |  |  |  |  |
| Draft |  |  |  |  |  |
| Review |  |  |  |  |  |
| Materialize |  |  |  |  |  |

Production graph checks:

- Required sources/effects are graph nodes, not prompt-only instructions.
- Required runtime capabilities appear in `metadata.requiredCapabilities` and top-level `capabilities`.
- Optional sources have explicit source-gap handling.
- Effect nodes have approval, preview, idempotency, adapter, target, and materialization format.
- Agent skill requirements are declared/documented as capabilities; package scripts do not execute skills.

## Schema Plan

| Artifact | Schema path | Producer node | Consumer node(s) | Final materialization |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Rules:

- Every agent output must declare a schema.
- Every final artifact must be materializable as markdown, CSV, JSON, or PDF.
- Domain-specific schemas stay in the external playbook package.

## Prompt And Script Plan

| File | Purpose | Domain-specific? | Validation notes |
| --- | --- | --- | --- |
|  |  |  |  |

Rules:

- Prompt/script/schema refs must be package-relative.
- Scripts must be deterministic over declared inputs.
- Scripts may run in external package tests, but they must not execute the graph.

## Review Gates

- Human review points:
- Automatic review/rework loops:
- Rework exit condition:
- Maximum review loop count, if applicable:
- Downstream node after approval:
- Downstream node after requested changes:

## Final Artifacts

| Artifact | Format | Audience | Materialization rule | Acceptance check |
| --- | --- | --- | --- | --- |
|  | markdown/csv/json/pdf |  |  |  |

## Update And Upgrade Plan

- Package identity to preserve:
- Stable node/artifact ids to preserve:
- Version bump rule:
- Files future maintainers should edit for source changes:
- Files future maintainers should edit for prompt/schema/output changes:
- Validation command after every update:
- Import/re-import notes:

## Validation Plan

Required commands:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path>
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path> --json
```

If an installed Tessera CLI is available, also run:

```bash
tessera playbook validate <external-package-path>
tessera playbook validate <external-package-path> --json
```

Evidence to store:

- command
- exit code
- `ok`
- error/warning/info counts
- unresolved diagnostics
- repair notes

## No-Runner Checklist

- [ ] No `bin` entrypoint.
- [ ] No standalone runner script.
- [ ] No dependency fields or lockfiles.
- [ ] No local graph execution wrapper.
- [ ] No unsafe absolute or parent-directory refs.
- [ ] No dynamic imports, `require`, or dangerous imports.

## SDK Helper Candidate Notes

Record a candidate only when the need repeats across SEO/GEO, supply-chain, or a forward test.

| Candidate | Evidence source | Repeated friction | Domain-neutral? | Defer reason or promotion case |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
