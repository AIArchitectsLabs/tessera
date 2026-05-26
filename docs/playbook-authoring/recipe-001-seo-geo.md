# Recipe 001: SEO/GEO Blog Article Playbook

This recipe turns `/Users/utpal/Code/playbooks/seo-geo-blog-reference-playbook` from an impressive specimen into a reusable authoring pattern. It is a Tessera docs mirror of the reference package, not a new runtime contract.

The reference playbook proves this shape:

1. Normalize user intake.
2. Derive a domain-specific research plan.
3. Fan out through declared read-only capabilities.
4. Normalize noisy source outputs into strict artifacts.
5. Give agents compact, schema-backed drafting seeds.
6. Store raw agent output first, then structure it deterministically.
7. Review, rework, and human-approve before final materialization.
8. Write only user-facing final artifacts.

## Reference Package

| Field | Value |
| --- | --- |
| Path | `/Users/utpal/Code/playbooks/seo-geo-blog-reference-playbook` |
| Manifest id | `reference.seo-geo-blog-article` |
| Version | `0.1.26` |
| Capabilities | `web.search`, `web.fetch`, `tool.workspace.write` |
| Final artifacts | `contentBrief`, `finalArticle` |
| Final materialized files | `SEO GEO Blog Article/Briefs/{{inputs.primaryKeyword}} - Content Brief.md`, `SEO GEO Blog Article/Articles/{{inputs.primaryKeyword}} - Final Article.md` |

## Validation Evidence

Text mode:

```bash
bun run --cwd apps/cli src/index.ts playbook validate /Users/utpal/Code/playbooks/seo-geo-blog-reference-playbook
```

Result:

```text
Playbook validation passed: /Users/utpal/Code/playbooks/seo-geo-blog-reference-playbook
Summary: 0 error(s), 0 warning(s), 0 info
```

JSON mode:

```bash
bun run --cwd apps/cli src/index.ts playbook validate /Users/utpal/Code/playbooks/seo-geo-blog-reference-playbook --json
```

Result:

```json
{
  "ok": true,
  "summary": {
    "errors": 0,
    "warnings": 0,
    "info": 0
  },
  "diagnostics": []
}
```

## Graph Pattern

| Stage | SEO/GEO node(s) | Reusable authoring pattern |
| --- | --- | --- |
| Intake normalization | `normalizeIntake` | Convert loose user inputs into one strict artifact before any planning or tool use. |
| Domain clustering | `clusterKeywords` | Derive domain-specific entities from normalized intake. New domains should replace this script, not Tessera runtime. |
| Dynamic research planning | `buildResearchPlan` | Produce bounded fanout work items with stable ids, query/focus metadata, and branch limits. |
| Parallel source collection | `researchFanout` | Use `parallelMap` for independent source work, with explicit generated item and concurrency limits. |
| Read-only tools | `searchSources`, `fetchTopSource` | Use declared capabilities only. Web, Gmail, feed, and other source access should stay capability-gated. |
| Branch normalization | `selectFetchCandidate`, `summarizeBranchResearch` | Make every branch emit one schema-shaped summary even when sources are weak or missing. |
| Fan-in aggregation | `aggregateResearch` | Merge branch outputs into a single evidence artifact with gaps and quality signals. |
| Compact agent seed | `prepareBriefDraftInput` | Distill large research into bounded agent input so agent prompts stay manageable. |
| Agent drafting | `draftBrief`, `draftArticle` | Let agents produce draft text or draft JSON, but keep output schemas explicit. |
| Raw-to-strict normalization | `structureContentBrief`, `structureArticleDraft` | Store raw agent output first, then transform it into strict domain artifacts with scripts. |
| Automated review | `reviewBrief`, `reviewArticle` | Use agent review artifacts to decide whether rework is needed. |
| Bounded rework | `reworkBrief`, `reworkArticle` | Allow a repair loop but return to a deterministic downstream step. Avoid unbounded automatic loops. |
| Human review | `humanBriefReview`, `finalReview` | Pause on the artifact the user should inspect, with request-changes routing back to rework. |
| Materialization | `writeContentBrief`, `writeFinalArticle` | Write only durable, user-facing outputs. Keep research and review artifacts internal. |

## File Inventory

| File or directory | Classification | How to reuse |
| --- | --- | --- |
| `manifest.json` | Copy shape, rewrite values | Keep the manifest structure; change id, version, name, and entrypoint metadata for the new playbook. |
| `playbook.ts` | Copy pattern, rewrite graph | Reuse the graph choreography, but replace SEO/GEO node ids, artifacts, prompts, scripts, and final paths with the new domain. |
| `PLAYBOOK.md` | Copy pattern, rewrite content | Keep the sections for what the package exercises, local checks, and boundary notes. Rewrite domain behavior. |
| `package.json` | Copy minimal shape | Keep private module package and test scripts. Do not add dependencies, `bin`, or standalone runner scripts. |
| `schemas/*.schema.json` | Rewrite | Treat schemas as the spine of the new playbook. Names and fields should be domain-owned. |
| `prompts/*.md` | Rewrite | Keep prompt roles such as draft, review, and rework. Replace all SEO/GEO instructions. |
| `scripts/normalizeIntake.ts` | Copy pattern, rewrite | Normalize loose input into a strict artifact for the new domain. |
| `scripts/buildResearchPlan.ts` | Copy pattern, rewrite | Generate bounded, typed fanout work. Replace SEO queries with domain source plans. |
| `scripts/selectFetchCandidate.ts` | Copy pattern, rewrite only if web fetch remains | Reuse the defensive candidate-selection idea; replace SEO-specific fallback URLs. |
| `scripts/summarizeResearch.ts` | Copy pattern, rewrite | Normalize source outputs into branch-level summaries. |
| `scripts/aggregateResearch.ts` | Copy pattern, rewrite | Merge branch summaries and preserve provenance, gaps, and quality signals. |
| `scripts/prepareBriefDraftInput.ts` | Copy pattern, rewrite | Compact large evidence into a bounded agent seed. |
| `scripts/structureContentBrief.ts` | Copy pattern, rewrite | Convert raw agent text into strict artifact JSON and markdown. |
| `scripts/structureArticleDraft.ts` | Copy pattern, rewrite | Use a domain equivalent when final authored content needs guardrails. |
| `scripts/scoreBrief.ts`, `scripts/scoreArticle.ts` | Copy pattern, rewrite | Keep deterministic scoring outside Tessera. Thresholds and criteria are domain-specific. |
| `tests/package.test.ts` | Copy pattern, rewrite assertions | Assert loader compatibility, graph shape, final outputs, capabilities, and no unwanted paths. |
| `tests/scripts.test.ts` | Copy pattern, rewrite fixtures | Prove scripts are deterministic before live connectors are enabled. |
| `tests/fixtures/*` | Rewrite | Fixtures should model the new domain and include negative/noisy cases. |
| `*.zip` package archives | Ignore | Generated release artifacts. Do not use as recipe source. |
| `.git`, `.DS_Store`, editor files | Ignore | Local metadata. |

## Generic Versus Domain-Specific

| Generic pattern | SEO/GEO-specific implementation |
| --- | --- |
| One normalized intake artifact starts the graph. | Topic, audience, primary keyword, secondary keywords, and article angle. |
| Source plans are explicit artifacts. | Keyword clusters and SERP research items. |
| Parallel source collection uses declared capabilities. | `web.search` and `web.fetch` for SEO/GEO research. |
| Branch output is normalized before fan-in. | Source summaries include SERP snippets, competitor insights, audience jobs, examples, and evidence. |
| Agent draft output is stored raw first. | Brief and article drafting prompts produce SEO/GEO content. |
| Scripts structure raw output into schema-shaped artifacts. | Content brief and final article schemas. |
| Review artifacts drive bounded rework. | Brief/article review scorecards and thresholds. |
| Human review gates final progress. | Brief review before article drafting; final article review before completion. |
| Artifact writes materialize only durable outputs. | Content brief and final article markdown paths. |

## Authoring Sequence For A New Playbook

1. Start with the domain problem and final user-facing artifacts.
2. Define schemas for intake, source plan, normalized source signal, aggregate evidence, draft output, review output, and final packet.
3. Write deterministic scripts before prompts.
4. Add a minimal graph that loads and validates with no live connector calls.
5. Add fixture tests for scripts and package shape.
6. Add capability-gated source nodes and keep their outputs normalized.
7. Add agent prompts only after the script/artifact contracts are stable.
8. Add review and rework loops with explicit downstream return points.
9. Add human review and final materialization.
10. Run `playbook validate` in text and JSON mode, then repair diagnostics before import.

## Boundary Rule

Do not move SEO/GEO identifiers, scoring fields, source taxonomies, prompt assumptions, or output formats into Tessera core. Tessera owns package loading, validation, execution, capabilities, review, artifact history, and materialization. The playbook package owns domain schemas, prompts, scripts, scoring, fixtures, and final templates.
