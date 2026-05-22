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

Capability examples:

- `gmail`
- `web.search`
- `web.fetch`
- public feed fetched through `web.fetch`
- package-local deterministic script over fixture data

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

## Schema Plan

| Artifact | Schema path | Producer node | Consumer node(s) | Final materialization |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Rules:

- Every agent output must declare a schema.
- Every final artifact must be materializable as markdown, CSV, or JSON.
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
|  | markdown/csv/json |  |  |  |

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
