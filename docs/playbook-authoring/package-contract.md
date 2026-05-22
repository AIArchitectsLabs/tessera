# Tessera External Playbook Package Contract

This contract is the source of truth for external playbook package authoring. The local `tessera-playbook-author` skill should point back here instead of becoming a separate standard.

## Runtime Contract

Tessera is the only runtime. External packages are authored outside Tessera, but they are loaded, validated, imported, run, reviewed, and materialized by Tessera.

Allowed outside Tessera:

- Author package files.
- Validate package shape through `playbook validate`.
- Repair validator diagnostics.
- Run deterministic script tests over package fixtures.
- Run golden tests for domain normalization, scoring, and formatting functions.

Not allowed outside Tessera:

- Standalone graph runners.
- Local execution wrappers that simulate Tessera graph runtime.
- `bin` entrypoints.
- Dependency fields or lockfiles.
- Package-local copies of Tessera runtime internals.
- Graph runs, import smoke tests, capability exercises, or artifact materialization.

## Required Package Surface

The exact filenames may vary by package format, but every package must expose:

- playbook graph definition
- prompt refs
- script refs, when scripts are used
- schema refs for agent outputs and structured artifacts
- declared artifacts
- declared capabilities
- fixture/golden inputs for deterministic package-local tests
- final materialization targets for markdown, CSV, or JSON outputs

## Ownership Boundary

Tessera owns:

- graph loading and validation
- durable execution
- human review pauses
- artifact history
- capability policy
- connector adapters
- run trace and provenance surfaces

External playbooks own:

- domain schemas
- domain prompts
- scoring scripts
- source normalization
- fixtures and golden examples
- final output templates
- domain taxonomies

## File Reference Rules

- Use package-relative refs.
- Do not use absolute paths.
- Do not use parent-directory escapes.
- Do not rely on symlinks that leave the package.
- Do not reference generated files that cannot be recreated or validated.

## Agent Output Rules

- Every agent output must declare a schema.
- Prompts should tell agents to produce schema-conformant output.
- Review/rework loops must return to a clear downstream node.
- Human review actions must have explicit approved and change-requested paths.

## Artifact Rules

- Every declared final artifact must be materializable.
- Supported V1 materialization targets are markdown, CSV, and JSON.
- Final artifacts should identify their audience and acceptance check.
- Draft-only intermediate artifacts should not masquerade as final outputs.

## Capability Rules

- Every tool or connector use must be declared.
- Use generic capabilities such as Gmail, web search, web fetch, or package-local deterministic scripts.
- Public feeds should be modeled as `web.fetch` plus package-local parsing unless Tessera adds a generic feed capability.
- Domain-specific connector semantics stay in the external package until promoted as a generic Tessera primitive.

## Validation Expectations

A package is not ready for import until `playbook validate` returns no errors. Reference playbooks should aim for zero warnings and record any accepted warning with rationale.
