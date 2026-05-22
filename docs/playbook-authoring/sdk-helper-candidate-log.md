# SDK Helper Candidate Log

Use this log to decide what belongs in Phase 2B. A helper should be promoted only when repeated authoring friction proves it is domain-neutral and worth making reusable.

## Promotion Standard

A candidate helper needs:

- repeated evidence from at least two sources, or one source plus a strong cross-domain rationale
- no domain-specific vocabulary in the proposed API
- clear reduction in package boilerplate or validator failures
- a migration path for SEO/GEO and supply-chain examples
- tests that prove the helper preserves existing validator behavior

Evidence sources:

- SEO/GEO recipe or package
- supply-chain recipe or package
- Phase 2A.5 third-domain forward test
- validator diagnostics from real package authoring

## Candidate Table

| Candidate | Evidence source | Repeated friction | Domain-neutral API shape | Decision |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Decision values:

- `promote in 2B`
- `defer`
- `reject as domain-specific`
- `needs more evidence`

## Candidate Note Template

```markdown
## Candidate: <name>

Evidence:

- <recipe/package/forward-test path>

Repeated friction:

- <what authors repeated or got wrong>

Domain-neutral shape:

- <possible API without domain vocabulary>

Rejected alternatives:

- <simpler docs-only or validator-only answer>

Decision:

- <promote/defer/reject/needs more evidence>
```

## Current Baseline

Phase 2A.5 creates the authoring contract and skill wrapper. Phase 2B should not begin until this log has evidence from the skill forward test in addition to SEO/GEO and supply-chain experience.
