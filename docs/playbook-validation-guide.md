# Tessera Playbook Validation Guide

This guide is the validator-driven repair loop for external Tessera playbook packages. It is written for humans and coding agents that need deterministic feedback while authoring a playbook outside Tessera.

## Validation Contract

Validation proves package shape, references, capabilities, schemas, materialization declarations, and runtime-boundary safety. It does not run the graph.

The validator can be used by external agents because it is local, deterministic, and credential-free.

## Commands

From the Tessera repo:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path>
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path> --json
```

When an installed CLI is available and current:

```bash
tessera playbook validate <external-package-path>
tessera playbook validate <external-package-path> --json
```

## Exit Codes

- `0`: validation completed with no errors.
- `1`: validation completed and found one or more errors.
- `2`: usage error, unreadable path, or internal validator failure.

Warnings can still return `0`. Reference packages should fix warnings unless an accepted warning is recorded with rationale.

## Repair Loop

1. Run text validation.
2. Run JSON validation.
3. Group diagnostics by severity and code.
4. Fix errors first.
5. Re-run validation.
6. Fix warnings for reference packages.
7. Preserve useful info diagnostics as notes.
8. Record final evidence.

Do not make broad rewrites before reading the diagnostic code, message, path, and repair hint.

## JSON Evidence Shape

Record the final result in a plan, package note, or pull request:

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

For a repair pass, include what changed:

```json
{
  "diagnostic": "missing_schema_ref",
  "path": "schemas/finalPacket.schema.json",
  "repair": "added package-relative schema ref and updated producing node",
  "result": "cleared"
}
```

## Common Diagnostics And Repairs

| Failure class | Usual cause | Preferred repair |
| --- | --- | --- |
| Missing prompt, script, or schema ref | File path typo or missing file | Add the file or fix package-relative ref |
| Unsafe source path | Absolute path or `..` escape | Move file into package and use relative ref |
| Undeclared artifact | Node produces or consumes unknown id | Add artifact declaration or fix id |
| Undeclared capability | Tool or connector uses a capability not in graph metadata | Add required or optional capability |
| Agent output without schema | Prompt node returns structured content without contract | Add schema and update node output declaration |
| Final write cannot materialize | Output is draft-only or format is unsupported | Convert to markdown, CSV, JSON, or PDF final artifact |
| Review loop has unclear return | Request-changes branch does not rejoin downstream graph | Add feedback artifact and bounded rework path |
| Standalone runner metadata | `bin`, dependency fields, lockfile, or runtime script exists | Remove external runtime metadata |
| Dangerous import | Script imports runtime internals or unsafe modules | Rewrite as deterministic package-local logic |
| Package/runtime version mismatch | Package was built against stale compiler/runtime metadata | Revalidate with current Tessera CLI and rebuild archive |

## Agent Repair Protocol

Coding agents should follow this protocol:

1. State the package path and runtime boundary.
2. Run text and JSON validation.
3. Read diagnostics before editing.
4. Patch the smallest package-owned file set.
5. Re-run validation after each repair class.
6. Never add a standalone runner, dependency field, lockfile, or local graph executor to make validation easier.
7. Stop and report if the diagnostic implies missing Tessera platform behavior.

## Negative Repair Examples

Do not fix a missing graph-run smoke by adding:

```json
{
  "scripts": {
    "run": "node run-playbook.js"
  }
}
```

The correct repair is to validate package shape externally, then import and run through Tessera.

Do not fix missing live connector data by adding credentials to fixtures. The correct repair is to add credential-free fixture evidence and declare the live capability.

Do not fix a missing schema by weakening the output to free text. The correct repair is to add the schema and update the prompt or script to produce it.

## Stop Conditions

Stop and ask or report a blocker when:

- The authoring brief is incomplete in a way that changes graph shape.
- A source requires live credentials or production access.
- A diagnostic points to missing Tessera platform behavior.
- A repair would require standalone execution outside Tessera.
- Validation passes only after deleting meaningful tests, schemas, provenance, or review gates.

## Import Readiness Checklist

- [ ] Text validation passes.
- [ ] JSON validation passes.
- [ ] Errors are zero.
- [ ] Reference package warnings are zero or explicitly accepted.
- [ ] Final artifacts are materializable markdown, CSV, JSON, or PDF.
- [ ] Capabilities are declared and visible before run.
- [ ] Fixture path proves the workflow without live credentials.
- [ ] Folder and zip exclude generated junk and dependency directories.
- [ ] Import and runtime verification happen in Tessera.
