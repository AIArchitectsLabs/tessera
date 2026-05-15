# Generic Multi-Agent Playbook Orchestrator Design

## Decision

Tessera should become a generic durable multi-agent playbook orchestrator. The
SEO/GEO blog article playbook should live in a separate playbook repository and
serve as a reference implementation, not as SEO-specific platform logic inside
Tessera.

Tessera owns orchestration, safety, durability, permissions, review surfaces,
artifact revision tracking, and transparency. Playbooks own domain logic:
prompts, scoring rubrics, score thresholds, branch planning, artifact schemas,
review forms, and TypeScript or Python scripts that implement domain-specific
analysis.

## Platform Boundary

Tessera should provide generic primitives:

- A normalized `PlaybookGraph` runtime.
- A TypeScript DSL authoring layer that compiles to the graph at import/install
  time.
- Typed artifacts and artifact revision events.
- Agent, script, tool, human review, parallel map, join, condition, and artifact
  write nodes.
- Dynamic fan-out with Tessera-controlled ceilings.
- Auto-batched parallel execution waves.
- Fan-in synthesis.
- Structured human review actions.
- Loop-until-approved gates.
- Reviewer/writer agent loops.
- Durable checkpoints and restart-safe resume.
- Workspace git-aware artifact history.
- Permissioned tool access.
- Run trace, token usage, tool-call usage, and cost transparency.

Playbook packages should provide:

- DSL source that compiles into the graph.
- Prompts.
- TypeScript and Python scripts.
- Scoring rubrics and thresholds.
- Artifact schemas.
- Review forms and structured actions.
- Scorecard layouts.
- Domain-specific branch generation logic.
- Fixtures and golden tests.

Tessera should not have native SEO/GEO concepts. SEO score, GEO score, search
intent classifications, content gap heuristics, and article quality rubrics are
playbook-owned outputs.

## Runtime And Authoring Model

Tessera should execute a cached normalized `PlaybookGraph`, not arbitrary
orchestration code. The external playbook repo may contain a TypeScript DSL file
for authoring convenience, but the compiled graph is the install-time and
runtime truth.

The graph should contain:

- Input definitions with validation and UI metadata.
- Artifact definitions with declared schemas.
- Node definitions.
- Transition and condition rules.
- Capability requirements.
- Review action definitions.
- Limits and budget ceilings.
- Checkpoint policy.

Initial graph node types:

- `agent`: runs a prompt against declared inputs and artifacts, producing typed
  output.
- `script`: runs constrained TypeScript or Python domain logic.
- `tool`: calls an approved Tessera tool such as web search or web fetch.
- `humanReview`: blocks for user approval, structured feedback, or direct
  artifact edits.
- `parallelMap`: dynamically generates work items and executes branches in
  auto-batched waves.
- `join`: merges parallel branch outputs.
- `condition`: routes based on structured output, approval state, score
  threshold, loop count, or error state.
- `artifactWrite`: materializes an artifact to a workspace file.

Scoring should not be a native runtime node. The DSL may expose a `score()`
helper, but it should compile to a script node with a declared scorecard output
schema.

## Dynamic Parallel Work

Playbooks should support dynamic fan-out. A `parallelMap` node can generate work
items based on inputs or prior artifacts, such as keyword clusters, competitor
URLs, regions, or source types.

Each generated work item may carry:

- Stable id.
- Role.
- Input payload.
- Capability requirements.
- Expected output schema.

Tessera enforces workspace and platform ceilings:

- Maximum generated items.
- Maximum concurrent branches.
- Maximum total branches.
- Maximum total agent steps.
- Maximum runtime.
- Maximum tokens.
- Maximum external tool calls.
- Maximum fetches.

When generated work exceeds concurrency, Tessera auto-batches it in waves. The
run UI should show progress by item count, such as `Researching keyword clusters
5/18`. If hard limits would be exceeded, Tessera pauses with clear recovery
options instead of silently truncating.

Branch outputs must retain work item identity so fan-in synthesis and scorecards
can cite which keyword, competitor, source, or region produced each finding.

## Script Execution And Dependencies

Playbook scripts may be written in TypeScript or Python. Scripts are for domain
logic and artifact transformation, not for owning orchestration state.

In v1, scripts may use:

- Standard language libraries.
- Tessera's curated script SDK.
- Tessera-approved tools through the explicit script API.

In v1, scripts may not use:

- Arbitrary `node_modules`.
- Lockfiles or dependency install steps.
- Python virtualenvs.
- Vendored packages.
- Postinstall scripts.
- Direct network access.
- Arbitrary workspace filesystem access.

The script SDK should stay generic. Useful SDK utilities include markdown
parsing, heading extraction, link extraction, text statistics, schema
validation, safe JSON helpers, and readability primitives. Domain scoring
formulae and weights remain in the playbook.

All external access must go through Tessera-approved tools and capabilities so
permissions, source attribution, traces, and cost tracking stay centralized.

## Import, Compile, And Cache

External playbook repos should be source-first. Tessera compiles the DSL during
import/install and caches the compiled graph in Tessera-managed storage.

Install flow:

1. Load `manifest.json`.
2. Compile the authoring entrypoint, such as `playbook.ts`, with Tessera's DSL
   compiler.
3. Emit a normalized `PlaybookGraph`.
4. Validate graph schema, node references, transitions, artifact schemas,
   prompts, scripts, capabilities, limits, and review actions.
5. Reject arbitrary dependency usage in v1.
6. Hash source files, prompts, scripts, schemas, and assets.
7. Store the compiled graph and compile metadata in the filesystem cache.
8. Load the cached graph at runtime.

Compile metadata should include:

```json
{
  "schemaVersion": 1,
  "playbookId": "content.seo-blog",
  "sourceVersion": 1,
  "compilerVersion": "0.1.0",
  "graphSchemaVersion": 1,
  "sourceHash": "sha256:...",
  "compiledAt": "2026-05-15T00:00:00.000Z"
}
```

Tessera should recompile when the source hash, compiler version, graph schema
version, or package version changes.

## Durable Execution

Playbook runs should survive app restarts.

Every run should persist:

- Run id.
- Playbook id and version.
- Compiled graph hash.
- Input snapshot.
- Approved limits and budget.
- Current status.
- Node queue.
- Parallel branch item state.
- Artifact references.
- Review state.
- Assignment metadata.

Every node should checkpoint before and after execution. Completed node outputs
should be persisted so restarts do not repeat finished work. In-flight work
interrupted by shutdown should become `interrupted` and resume according to the
node retry policy.

On restart, Tessera may auto-resume safe pending work inside the already
approved plan and budget. Tessera should pause before continuing if resume would
require new external calls beyond the approved plan, workspace mutation, changed
credentials or providers, higher budget, or ambiguous error recovery. Human
review gates always pause.

## Human Review And Artifact Revisions

Human review should be structured. A `humanReview` node can expose
playbook-declared actions such as:

- Approve.
- Request changes.
- Edit artifact.
- Comment on section.
- Adjust inputs.
- Regenerate section.
- Accept or reject suggestion.
- Request more research.

Users should be able to directly edit reviewable artifacts and provide
structured feedback. Agent revision steps consume the current artifact version
plus review events.

Artifacts should be first-class records with version history. Each version
records provenance: agent, script, tool, user edit, imported file, or finalizer.
Reviewable artifacts should usually be materialized as Markdown workspace files,
with optional JSON sidecars when structured data is needed.

## Git-Aware History

Tessera should detect whether the workspace is a git repo. It should not commit
every internal draft revision automatically to the user's active branch.

Default behavior:

- Intermediate revisions live in Tessera run history and workspace diffs.
- Meaningful milestones may create explicit git commits after user approval.
- Suggested milestones include approved brief, article ready for final review,
  and final approved article.
- Commit behavior should be configurable per playbook or workspace, with the
  default leaning toward user confirmation at milestone boundaries.

If Tessera creates a commit, the message should identify the playbook, artifact,
run id, and approval state.

## Research Capability Phasing

Phase 1 research should use generic web search and web fetch capabilities. This
is enough to support keyword research, ranking-page discovery, source gathering,
and basic content gap analysis.

Phase 2 should add richer browser/SERP observation capabilities for playbooks
that need rendered ranking pages, SERP feature observation, snippets, People
Also Ask, AI answer contexts, and page interaction.

## SEO/GEO Blog Playbook Reference Implementation

The SEO/GEO blog playbook should live in a separate repository. Its purpose is
to prove the generic orchestrator with a realistic multi-agent workflow.

Expected package shape:

```text
seo-blog-playbook/
  PLAYBOOK.md
  manifest.json
  playbook.ts
  prompts/
    research-serp.md
    analyze-competitor.md
    synthesize-brief.md
    write-article.md
    review-article.md
    revise-article.md
  scripts/
    build-research-plan.ts
    normalize-keywords.ts
    score-brief.ts
    score-article.py
  schemas/
    research-item.schema.json
    content-brief.schema.json
    article-scorecard.schema.json
  tests/
    fixtures/
    golden/
  assets/
    icon.png
```

Inputs:

- Focus keywords.
- Associated keywords.
- Target audience or persona.
- Region and language.
- Brand or product context.
- Funnel stage.
- Desired article type.
- Tone and voice constraints.
- Competitor URLs to include or exclude.
- Source constraints.
- SEO/GEO score targets.
- Maximum research budget or depth.

Flow:

1. Normalize intake and cluster keywords.
2. Generate a dynamic research plan.
3. Run heterogeneous research roles in parallel waves.
4. Synthesize research into search intent, content gaps, recommended angle,
   outline candidates, source plan, and assumptions.
5. Generate a structured content brief.
6. Score the brief with a playbook-owned script.
7. Run user brief review until approved.
8. Generate the article from the approved brief.
9. Run reviewer/writer refinement loops with loop limits.
10. Score the article with a playbook-owned script.
11. Run final user review until approved.
12. Write final article, scorecard, source summary, and optional milestone git
    commit.

Research roles may include:

- SERP analyst.
- Competitor content reviewer.
- Content gap analyst.
- GEO answer analyst.
- Source finder.
- Fact checker.

Scorecard outputs should show rubric dimensions, weights, evidence, pass/fail
notes, recommendations, and source links. Tessera displays the scorecard as a
structured artifact without interpreting SEO/GEO semantics natively.

## Phasing

### Phase 1: Generic Durable Orchestrator MVP

Platform:

- Compiled graph cache from DSL at import/install.
- Core graph nodes: `agent`, `script`, `tool`, `humanReview`, `parallelMap`,
  `join`, `condition`, and `artifactWrite`.
- TypeScript DSL compiler.
- TypeScript and Python constrained script steps.
- Standard libraries plus Tessera script SDK only.
- Dynamic fan-out with auto-batched waves.
- Typed artifacts and artifact version events.
- Structured review actions.
- Loop limits.
- Restart-safe run checkpoints.
- Web search and web fetch tool capabilities.
- Run trace with token/tool usage.
- Workspace file artifact writes.
- Git detection and optional milestone commits.

Reference playbook:

- SEO/GEO blog playbook repo.
- Keyword clustering and research plan scripts.
- Parallel web search/fetch research.
- Content gap synthesis.
- Content brief review loop.
- Article writer/reviewer loop.
- Playbook-owned scorecard scripts.
- Final review loop.

### Phase 2: Rich Research And UX

Platform:

- Browser/SERP observation capability.
- Richer artifact diff UI.
- Structured section-level comments.
- Workspace scratch refs or stronger git revision UI.
- Dashboard scorecard views.
- Budget planner before launch.
- Saved review templates.
- Branch retry and partial rerun controls.

Reference playbook:

- SERP feature extraction.
- Rendered ranking-page analysis.
- People Also Ask and snippet observation where available.
- Stronger GEO answer-readiness checks.
- Improved citation and source validation.

### Phase 3: Playbook Ecosystem Hardening

Platform:

- Signing and trust model.
- Internal/private playbook registries.
- Trusted dependency bundle design.
- Dependency and license audits.
- Stronger script sandboxing.
- Playbook test runner.
- Marketplace or repo update flow.
- Compatibility checks across Tessera versions.

Arbitrary playbook dependencies remain out of Phase 1 because trust,
reproducibility, and support burden are larger risks than raw capability.

## Risks And Mitigations

- **Runaway cost from dynamic fan-out.** Mitigate with platform ceilings,
  pre-launch estimates, auto-batched waves, and pause-on-hard-limit behavior.
- **Unsafe script behavior.** Mitigate with no arbitrary dependencies, explicit
  tool APIs, timeouts, output validation, and install-time review.
- **Opaque scores.** Mitigate by requiring scorecards to expose rubric rows,
  weights, evidence, and recommendations.
- **Noisy git history.** Mitigate by storing intermediate revisions in Tessera
  run history and committing only user-approved milestones.
- **Restart duplication.** Mitigate with per-node checkpoints, persisted
  artifact references, and idempotency-aware retry policy.
- **DSL/runtime drift.** Mitigate by compiling to a versioned graph schema and
  caching source hash plus compiler metadata.

## Spec Self-Review

This spec intentionally avoids SEO-specific platform primitives. It defines
scoring as playbook-owned script output, preserves Tessera as the generic
orchestrator, and keeps arbitrary dependencies out of v1. The main open design
work is implementation sequencing across contracts, core runtime, sidecar
persistence, desktop review UI, script SDK, and the external reference playbook
repo.
