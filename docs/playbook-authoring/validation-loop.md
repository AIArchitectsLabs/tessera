# Tessera Playbook Validation Loop

Use this loop when authoring or repairing an external Tessera playbook package.

## Commands

Repo-local fallback from the Tessera repo:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path>
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path> --json
```

Installed CLI, when available:

```bash
tessera playbook validate <external-package-path>
tessera playbook validate <external-package-path> --json
```

## Exit Codes

- `0`: validation completed with no errors.
- `1`: validation completed and found one or more errors.
- `2`: usage error, unreadable path, or internal validator failure.

## Repair Order

1. Fix `error` diagnostics first.
2. Fix `warning` diagnostics when publishing a reference playbook unless there is an explicit rationale.
3. Preserve useful `info` diagnostics as authoring guidance.
4. Re-run text and JSON validation after each repair pass.

## Evidence Format

Capture this evidence in the relevant plan, package notes, or forward-test artifact:

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

## Common Failure Classes

- missing prompt, script, or schema refs
- unsafe source paths
- unreachable nodes
- undeclared artifacts
- undeclared capabilities
- agent outputs without schemas
- artifact writes that cannot materialize final markdown, CSV, JSON, or PDF
- review loops that do not return to a sensible downstream step
- package/runtime version mismatches
- standalone runner metadata or local executor entrypoints
- dangerous imports and disallowed dependency fields
- live connector use without fixture coverage

## Stop Rules

Stop and repair before generation continues when:

- the authoring brief is incomplete in a way that changes graph shape
- the package assumes a non-Tessera runtime
- a validator error has no clear repair path
- a source requires credentials or production access that were not explicitly granted

Do not start SDK helper implementation from this loop. Record helper candidates in `sdk-helper-candidate-log.md` and revisit them in Phase 2B.
