# Validation Loop

Run validation from the Tessera repo unless the installed CLI is known to be current.

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path>
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path> --json
```

When available:

```bash
tessera playbook validate <external-package-path>
tessera playbook validate <external-package-path> --json
```

## Repair Order

1. Fix errors.
2. Fix warnings for reference playbooks unless explicitly accepted.
3. Preserve info diagnostics as guidance.
4. Re-run text and JSON validation.

## Evidence To Capture

- command
- exit code
- `ok`
- error/warning/info counts
- unresolved diagnostics
- repair notes

## Stop Rules

Stop instead of repairing blindly when:

- the authoring brief is incomplete
- a diagnostic implies missing Tessera platform behavior
- credentials or production access are required
- fixing the package would introduce a standalone runtime
