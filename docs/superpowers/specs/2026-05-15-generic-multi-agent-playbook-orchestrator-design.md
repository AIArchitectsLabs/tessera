# Generic Multi-Agent Playbook Orchestrator Design

## Decision

Tessera should become a generic durable multi-agent playbook orchestrator. The
SEO/GEO blog article playbook should live in a separate playbook repository and
serve as a reference implementation, not as SEO-specific platform logic inside
Tessera.

Tessera owns orchestration, safety, durability, permissions, review surfaces,
artifact revision tracking, and transparency. Playbooks own domain logic:
prompts, scoring rubrics, score thresholds, branch planning, artifact schemas,
review forms, and constrained scripts that implement domain-specific analysis.
Phase 1 supports TypeScript scripts only; Python remains a later-phase
capability.

## Non-Goals

The following are explicitly out of scope for this design. Anything here that
later needs to change requires a separate spec.

- Native SEO/GEO concepts in the platform. Scoring, rubrics, intent
  classification, and content heuristics are playbook-owned.
- Inter-agent messaging or addressable agent identity. Nodes run prompts; work
  items are values, not actors.
- Arbitrary playbook dependencies (`node_modules`, lockfiles, virtualenvs,
  postinstall scripts). Phase 3 may revisit.
- Python script execution in Phase 1. Cross-platform interpreter assumptions are
  unsafe in a Tauri-distributed app; see *Script Execution And Dependencies*.
- Auto-committing intermediate revisions to the user's active git branch.
- A playbook marketplace, signing/trust model, or update channel in Phase 1.
- Mutating browser automation. Phase 1 research is read-only via web search and
  web fetch.

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
- TypeScript scripts in Phase 1, with Python reserved for a later sandboxed
  runtime.
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
- `script`: runs constrained TypeScript domain logic in Phase 1.
- `tool`: calls an approved Tessera tool such as web search or web fetch.
- `humanReview`: blocks for user approval, structured feedback, or direct
  artifact edits.
- `parallelMap`: dynamically generates work items and executes branches in
  auto-batched waves.
- `join`: merges parallel branch outputs.
- `condition`: routes based on structured output, approval state, score
  threshold, loop count, or error state.
- `artifactWrite`: materializes an artifact to a workspace file.

Scoring should not be a native runtime node, because rubric semantics belong to
the playbook and should not leak into the platform. The DSL may expose a
`score()` helper, but it should compile to a script node with a declared
scorecard output schema.

### DSL Example

The authoring layer is a thin TypeScript DSL whose only job is to emit a
normalized `PlaybookGraph`. A minimal article-style playbook should look like:

```ts
import { definePlaybook } from "@tessera/playbook-sdk";

export default definePlaybook({
  id: "content.seo-blog",
  version: "0.1.0",
  inputs: {
    focusKeywords: { type: "string[]", required: true },
    audience: { type: "string", required: true },
  },
  artifacts: {
    researchPlan: { schema: "./schemas/research-plan.schema.json" },
    brief: { schema: "./schemas/content-brief.schema.json", materialize: "brief.md" },
    article: { schema: "./schemas/article.schema.json", materialize: "article.md" },
    briefScorecard: { schema: "./schemas/brief-scorecard.schema.json" },
    articleScorecard: { schema: "./schemas/article-scorecard.schema.json" },
  },
  capabilities: ["web.search", "web.fetch"],
  limits: { maxBranches: 24, maxConcurrent: 6, maxTokens: 2_000_000 },
  flow: ({ step }) => {
    const plan = step.script("build-research-plan", {
      run: "./scripts/build-research-plan.ts",
      out: "researchPlan",
    });

    const findings = step.parallelMap("research", {
      items: { artifact: "researchPlan", path: "$.workItems" },
      branch: (item) =>
        step.agent("research-one", {
          prompt: "./prompts/research-serp.md",
          inputs: { item },
          tools: ["web.search", "web.fetch"],
          output: { schema: "./schemas/research-item.schema.json" },
        }),
    });

    const brief = step.agent("synthesize-brief", {
      prompt: "./prompts/synthesize-brief.md",
      inputs: { findings },
      output: "brief",
    });

    const briefScore = step.score("score-brief", {
      run: "./scripts/score-brief.ts",
      inputs: { brief },
      out: "briefScorecard",
    });

    const approvedBrief = step.humanReview("approve-brief", {
      artifact: "brief",
      scorecard: briefScore,
      actions: ["approve", "requestChanges", "editArtifact"],
      loopUntil: "approve",
    });

    const article = step.loop("write-and-review", {
      maxIterations: 3,
      body: (prev) =>
        step.agent("write-article", {
          prompt: "./prompts/write-article.md",
          inputs: { brief: approvedBrief, prev },
          output: "article",
        }),
      evaluate: (draft) =>
        step.score("score-article", {
          run: "./scripts/score-article.ts",
          inputs: { article: draft },
          out: "articleScorecard",
        }),
      until: { artifact: "articleScorecard", path: "$.pass", equals: true },
    });

    return step.humanReview("final-review", {
      artifact: "article",
      actions: ["approve", "requestChanges", "editArtifact"],
      loopUntil: "approve",
    });
  },
});
```

The DSL is sugar. Every call above lowers to nodes and transitions in the
compiled graph; the graph, not the DSL, is the source of truth at runtime. DSL
helpers such as `score()` and `loop()` must not become runtime primitives:
`score()` lowers to a script node, and `loop()` lowers to ordinary nodes,
conditions, transition edges, and loop counters. Runtime decisions are expressed
as declarative conditions over artifact paths, not arbitrary TypeScript
callbacks.

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

Playbook scripts in Phase 1 are TypeScript only, executed by Tessera's bundled
Bun runtime through a constrained script runner. The runner must expose only the
script SDK and tool API, with no direct network, arbitrary filesystem, process,
dynamic import, or worker-spawn capability. Do not rely on Bun `Worker` alone as
a security boundary unless the implementation verifies those restrictions across
supported platforms. This avoids shipping or assuming a Python interpreter on
user machines — a hard cross-platform constraint for a Tauri-distributed app.

Python is not supported in Phase 1. Phase 3 may introduce a sandboxed Python
runtime (likely Pyodide in a worker, or a vendored interpreter behind a
capability gate) once the trust and distribution story is designed.

Scripts are for domain logic and artifact transformation, not for owning
orchestration state.

In v1, scripts may use:

- Standard TypeScript and Bun standard library APIs that the constrained runner
  allows (pure computation, structured data, regex, text processing).
- Tessera's curated script SDK.
- Tessera-approved tools through the explicit script API.

In v1, scripts may not use:

- Arbitrary `node_modules`.
- Lockfiles or dependency install steps.
- Vendored packages.
- Postinstall scripts.
- Direct network access.
- Arbitrary workspace filesystem access.
- `eval`, dynamic `import()` of user-provided paths, or worker spawn.

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
  "packageVersion": "0.1.0",
  "compilerVersion": "0.1.0",
  "graphSchemaVersion": 1,
  "scriptSdkVersion": "0.1.0",
  "sourceHash": "sha256:...",
  "graphHash": "sha256:...",
  "compiledAt": "2026-05-15T00:00:00.000Z"
}
```

Tessera should recompile when the source hash, compiler version, graph schema
version, script SDK version, or package version changes.

The compiled graph cache is an install/startup optimization, not the only copy
of runtime truth. When a run starts, Tessera stores an immutable compiled graph
snapshot or a content-addressed graph blob reference under the run record. A
cache eviction or playbook reinstall must not make an in-flight run
unresumable.

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

### Resume Semantics

LLM and tool calls are non-deterministic, so durable execution must be
memoization, not replay.

There are two separate caches:

1. **Compiled graph cache.** Keyed by playbook source hash, compiler version,
   graph schema version, script SDK version, and package version. It speeds up
   import/startup.
2. **Run memo cache.** Scoped to a single run and keyed by deterministic node
   execution identity. It prevents duplicate LLM/tool/script work on resume.

The run memo key should be explicit, not a vague `resolvedInputsHash`. It should
be a stable hash over:

- `runId` and pinned `graphHash`.
- `nodePath`, including branch id and loop iteration.
- Node spec hash: prompt text, script source, output schema, retry policy,
  declared tool allowlist, and declared capability requirements.
- Resolved execution context: selected agent profile fingerprint, provider,
  model id, model settings fingerprint, script SDK version, tool adapter
  versions, and non-secret integration/account fingerprints.
- Resolved input snapshot: primitive input values, branch item payload, artifact
  version ids and content hashes, review event ids, and materialized file hashes
  for artifacts the node consumes.
- Tool request shape for tool nodes: capability id, provider adapter, query or
  URL, region/language options, headers policy, and fetch/search options.

The first successful execution of a node persists the memo entry:
`nodeMemoKey → output, outputArtifactVersions, provenance, tokenUsage,
toolCalls, startedAt, completedAt`.

On resume, Tessera looks up `nodeMemoKey`. If a successful memo entry exists,
the output is reused verbatim and the node is not re-prompted, re-fetched, or
re-run. If the entry is absent, failed, schema-invalid, or marked
`interrupted`, the node follows its retry policy.

A run is pinned at start to an immutable compiled graph snapshot. If the
playbook is upgraded mid-run, the in-flight run continues against the pinned
snapshot; subsequent runs use the new compile. If the pinned graph snapshot is
missing or fails its hash check, Tessera must pause the run as `needs_repair`
instead of silently falling back to the latest installed playbook.

Invalidation is downstream and version-based:

- Editing a reviewable artifact creates a new artifact version and invalidates
  only downstream memo keys that consume that artifact version.
- Changing user input after a review gate creates a new input snapshot and
  invalidates only downstream consumers.
- Changing prompts, scripts, schemas, capability declarations, or tool allowlist
  creates a new compiled graph hash and affects new runs only; existing runs keep
  their pinned graph unless the user explicitly restarts or migrates the run.
- Changing model/provider/account settings during a run pauses before the next
  affected node. If the user approves continuation, the new fingerprint becomes
  part of future node memo keys; completed memoized outputs are not recomputed.
- Budget changes do not invalidate completed outputs. They only control whether
  queued work may continue.

Script nodes are assumed pure over their declared inputs and are always
memoized. Tool calls such as web search and web fetch are memoized by full
request shape within a single run so retries do not double-charge; across runs
they re-execute unless the playbook explicitly opts into cross-run caching with
a TTL. Cross-run cached web results must include retrieval time and source URL
metadata so scorecards can disclose freshness.

`agent` nodes whose output failed schema validation are not cached as
successful outputs; the retry-with-feedback loop (see *Schema Validation
Failures*) re-runs them. Failed attempts may still be stored as diagnostic
events for traceability.

### Schema Validation Failures

When an `agent` node's structured output fails its declared schema:

1. The runtime retries with the validation error appended to the prompt,
   up to a per-node `maxSchemaRetries` (default 2).
2. If retries are exhausted, the node transitions to `failed`. A `condition`
   node on the failure edge may route to a recovery branch; otherwise the run
   pauses for human review with the offending output attached.

Scripts that fail schema validation are a hard fail with no retry — script
output is deterministic, so the playbook is buggy.

If an agent node can call tools during execution, each approved tool call should
also be recorded as a child event with its own deterministic request key. A fully
completed agent node is memoized as a single output, but interrupted agent nodes
may reuse completed child tool-call results during retry where the adapter can
prove the request shape is identical. This prevents resume from duplicating web
search/fetch cost while avoiding partial LLM transcript replay as a correctness
requirement.

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
    score-article.ts
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
- TypeScript constrained script steps.
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

## Open Questions

These need answers before implementation begins. Listed in roughly the order
that blocks others.

1. **`manifest.json` schema.** Fields: id, semver, compiler version range,
   declared capabilities, declared inputs, entrypoint, asset map. Needs a
   concrete draft.
2. **Capability grant flow.** Install-time prompt listing declared capabilities,
   then per-run reaffirmation if the budget or scope materially exceeds prior
   approvals? Or per-tool first-use prompt? Pick one.
3. **"Auto-batched wave" semantics.** Semaphore with `maxConcurrent` (preferred)
   vs barrier-synchronized batches. Branch-failure policy: fail-fast,
   continue-on-error, or quorum.
4. **Cancellation model.** User cancel → drain to next checkpoint, hard-abort
   in-flight model calls, or both with a soft/hard distinction in the UI.
5. **Mid-run budget breach.** Pause for re-approval (preferred for tokens/cost),
   hard-fail (preferred for runtime), or graceful finalize. Probably differs per
   limit type — enumerate.
6. **Retry/idempotency policy per node type.** Default attempts, backoff, which
   failures are retryable, which tool calls are considered idempotent.
7. **Review during `parallelMap`.** Can a single branch raise a review, or only
   the join? Affects UI substantially.
8. **Reviewer/writer loop state.** How feedback accumulates across iterations
   (rolling summary vs full transcript), where the prior scorecard enters the
   writer prompt, and how partial approvals interact with `loopUntil`.
9. **Script SDK distribution.** Imported as `@tessera/script-sdk`? Types shipped
   alongside the playbook compiler? How are SDK versions pinned per playbook?
10. **Cross-run tool-call caching.** Off by default — confirm, and design the
    opt-in surface (per-capability TTL?).
11. **Script runner enforcement.** Verify whether Bun worker/subprocess
    isolation can actually remove FS/network/process/dynamic-import access on
    macOS, Windows, and Linux. If not, Phase 1 needs an explicit interpreter
    wrapper or allowlisted host-function model before importing third-party
    playbooks.
