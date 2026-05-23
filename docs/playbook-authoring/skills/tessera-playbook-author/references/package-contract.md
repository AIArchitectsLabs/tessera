# Package Contract

Tessera is the only runtime. External agents may author, validate, repair, package, and test deterministic package-local scripts, but they must not run playbook graphs outside Tessera.

## Allowed Outside Tessera

- Edit package files.
- Run `playbook validate`.
- Repair diagnostics.
- Run deterministic script tests over fixtures.
- Run golden tests for domain normalization or scoring scripts.

## Not Allowed Outside Tessera

- Standalone graph runner.
- Local execution wrapper.
- `bin` entrypoint.
- Dependency fields or lockfiles.
- Vendored Tessera runtime internals.
- Graph run, import smoke, capability exercise, or final artifact materialization.

## Package Rules

- Use package-relative refs.
- Declare every capability used by tools or connectors.
- Declare schemas for every agent output.
- Materialize final artifacts as markdown, CSV, or JSON.
- Keep domain schemas, prompts, scoring, fixtures, and taxonomies in the external package.
- Keep Tessera runtime, connector policy, review pause handling, and artifact history in Tessera.

## Common Validator Failures

- missing prompt/script/schema refs
- unsafe source paths
- unreachable nodes
- undeclared artifacts or capabilities
- agent outputs without schemas
- final artifact writes without useful materialization
- review loops without clear downstream return
- standalone runner metadata
- dangerous imports or disallowed dependency fields
