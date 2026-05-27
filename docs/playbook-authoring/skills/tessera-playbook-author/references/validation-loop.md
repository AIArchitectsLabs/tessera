# Validation Loop

Run package-local checks first when present, then validation from the Tessera repo unless the installed CLI is known to be current.

Common package-local checks:

```bash
bunx tsc --noEmit -p <external-package-path>/tsconfig.json
bun test <external-package-path>/tests
bun run <external-package-path>/build.ts validate
```

Use whichever commands the package actually defines. Do not add dependency installs or live connector checks just to make tests pass.

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

1. Fix package-local type or unit-test failures that block validation.
2. Fix validator errors.
3. Fix warnings for reference playbooks unless explicitly accepted.
4. Preserve info diagnostics as guidance.
5. Re-run package-local checks plus text and JSON validation.

## Evidence To Capture

- command
- exit code
- `ok`
- error/warning/info counts
- unresolved diagnostics
- repair notes
- package-local tests and typecheck result
- zip or folder import payload path when packaging was requested

## Stop Rules

Stop instead of repairing blindly when:

- the authoring brief is incomplete
- a diagnostic implies missing Tessera platform behavior
- credentials or production access are required
- fixing the package would introduce a standalone runtime
