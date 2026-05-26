# Tessera And External Playbook Boundary

This note closes Phase 0 of the supply-chain playbook authoring plan. It defines the line between the Tessera platform and externally authored playbook packages.

## Runtime Rule

Tessera is the only runtime. External agents and external repositories may author, validate, repair, package, and test deterministic package scripts or golden fixtures, but they must not execute playbook graphs through a standalone runner.

External playbook packages must not define `bin` entrypoints, standalone runner scripts, dependency fields, lockfiles, or local execution wrappers. The package should load through Tessera's graph package loader and validate through `playbook validate`.

## Tessera Owns

- Graph schema and validation.
- Package loading, path containment, source-ref checks, and unsafe import rejection.
- Durable graph execution.
- Artifact history and materialization.
- Human review pauses and review action routing.
- Capability declarations and runtime capability policy.
- Generic connector adapters such as Gmail, web search, and web fetch.
- Generic run trace and provenance surfaces.
- Author-facing validation diagnostics.

## External Playbooks Own

- Domain schemas.
- Domain prompts.
- Domain scoring scripts.
- Domain-specific research/source plans.
- Domain-specific source normalization.
- Fixtures, golden tests, and negative/noisy examples.
- Final output templates and final packet shapes.
- Domain taxonomies such as SEO/GEO content requirements or supply-chain `riskSignal[]`.

## Supply-Chain-Specific Boundary

The supply-chain playbook keeps these inside `/Users/utpal/Code/playbooks/supply-chain-risk-playbook`:

- `riskSignal[]` schema and provenance fields.
- Supplier, SKU, lane, material, port, and region entity mapping.
- Severity/confidence/source-quality scoring.
- Supplier/SKU/lane risk registers.
- Mitigation-plan, outreach, executive-brief, and disruption-packet schemas.
- Feed-specific parsing for CBP, NWS, FDA, GDELT, RSS, or trade press when those are added.

Tessera should not gain supply-chain-specific contract types, sidecar routes, UI concepts, or runtime behavior unless a later phase deliberately promotes a truly generic primitive.

## Validation Evidence

The boundary is enforced by generic validator behavior:

- Package refs must be package-relative and contained.
- Missing prompt/script/schema refs fail validation.
- Undeclared artifacts and capabilities fail validation.
- Agent outputs without schemas fail validation.
- Missing final materialization is surfaced as a warning.
- Dependency fields, lockfiles, `bin`, and standalone runner scripts are rejected.
- Dangerous imports and dynamic import forms are rejected.

## Current Reference Packages

| Package | Boundary evidence |
| --- | --- |
| `/Users/utpal/Code/playbooks/seo-geo-blog-reference-playbook` | SEO/GEO semantics, scoring, prompts, schemas, and final article/brief templates stay external. Tessera validation passes with 0 diagnostics. |
| `/Users/utpal/Code/playbooks/supply-chain-risk-playbook` | Supply-chain risk taxonomy, `riskSignal[]`, prompts, schemas, scripts, fixtures, and final disruption packet stay external. Tessera validation passes with 0 diagnostics. |
