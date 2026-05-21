# Supply Chain Playbook Authoring Plan

## Execution Status

Last updated: 2026-05-21

| Phase | Status | Owner lane | Next evidence required |
| --- | --- | --- | --- |
| 0. Lock the boundary | Planned | architect | Boundary note with explicit Tessera-vs-external ownership checks |
| 1. SEO/GEO recipe | Complete | writer | `docs/playbook-authoring/recipe-001-seo-geo.md`, `docs/playbook-authoring/authoring-checklist.md`, SEO/GEO validator evidence: 0 errors, 0 warnings, 0 info |
| 2A. Validation CLI first | Planned | executor + test-engineer | Text and JSON diagnostics, exit-code tests, failing fixture with repair hint |
| 2B. Minimal authoring SDK helpers | Planned | executor | Helpers justified by SEO/GEO or supply-chain usage, placeholder scaffold validation |
| 3. Supply-chain recipe | Complete | writer + architect | `/Users/utpal/Code/projects/supply-chain-risk-playbook/docs/recipe-002-supply-chain-risk.md` defines inputs, artifacts, graph phases, review gates, V1 free-source strategy, final outputs, and `riskSignal[]` provenance contract |
| 4. External supply-chain scaffold | Complete | executor | `/Users/utpal/Code/projects/supply-chain-risk-playbook` validates through Tessera CLI and package tests without live connector access |
| 5. V1 supply-chain flow | Planned | executor + test-engineer | Fixture-only final packet before live Gmail/web/feed paths |
| 6. Tessera import/runtime polish | Planned | executor | Import, capability preview, provenance trace, review surfaces, final output materialization |
| 7. Cookbook and agent authoring skill | Planned | writer | Cookbook docs and portable agent instructions tested by a third-playbook scaffold |

Status semantics: `Planned` means scoped in this plan but not yet proven by command output; upgrade to `In progress` or `Complete` only when the phase has fresh verification evidence.

## Deliverables Tracker

| Deliverable | Phase | Repository | Readiness | Verification gate |
| --- | --- | --- | --- | --- |
| Boundary architecture note | 0 | Tessera docs or `.omx/plans` follow-up | Not started | Confirms no supply-chain domain concepts enter Tessera core |
| `recipe-001-seo-geo.md` | 1 | Tessera docs mirror | Complete | New author can classify copy-vs-rewrite files |
| `authoring-checklist.md` | 1 | Tessera docs mirror | Complete | Checklist covers intake, schemas, prompts, scripts, review loops, fixtures, package validation |
| Validator CLI text mode | 2A | Tessera repo | Not started | `tessera playbook validate <path>` returns deterministic summary and exit codes |
| Validator CLI JSON mode | 2A | Tessera repo | Not started | `tessera playbook validate <path> --json` emits stable diagnostic codes and repair hints |
| Minimal SDK helpers | 2B | Tessera repo | Not started | Helpers are used by at least SEO/GEO or supply-chain and stay domain-neutral |
| Supply-chain recipe document | 3 | External supply-chain repo | Complete | `docs/recipe-002-supply-chain-risk.md` documents inputs, graph phases, artifacts, review gates, final outputs, V1 free-source strategy, and `riskSignal[]` provenance |
| External supply-chain scaffold | 4 | `/Users/utpal/Code/projects/supply-chain-risk-playbook` | Complete | Package loads through Tessera loader and validates without live connectors |
| Fixture-only V1 flow | 5 | External supply-chain repo | Not started | Fixtures produce risk registers and final disruption packet |
| Import/runtime polish | 6 | Tessera repo | Not started | Tessera imports package, previews capabilities, shows provenance, and writes final files |
| Cookbook and agent skill | 7 | Tessera docs and portable skill package | Not started | A third playbook can be scaffolded, validated, fixture-run, packaged, and imported |

## Requirements Summary

Build a reproducible Tessera playbook authoring workflow using two reference examples:

- Existing external SEO/GEO playbook as Recipe Example 001.
- New external supply-chain playbook as Recipe Example 002.

The supply-chain playbook must live outside the Tessera repository. Tessera remains the only runtime and execution platform. External agents such as Claude Code, Codex, Claude Cowork, Pi Agent, or Tessera's own agent may author, validate, repair, and package playbooks, but they do not execute them outside Tessera.

Non-goals:

- No standalone playbook runner.
- No external-agent execution path.
- No supply-chain-specific Tessera runtime or contract types.
- No new dependency model inside playbook packages.
- No paid/vendor supply-chain intelligence APIs in V1.
- No browser-only private systems or procurement-platform integrations in V1.

## Principles

1. Tessera owns execution; playbook repos own domain logic.
2. Extract SDK helpers from at least two real playbooks, not from abstraction alone.
3. Keep V1 free-source only: Gmail, web search/fetch, public APIs, public RSS/feeds.
4. Make schemas the spine of authoring.
5. Land validation before SDK convenience helpers.
6. Make validation teach authors and external agents what to fix.

## Target Repositories

Tessera repo:

- Authoring SDK surface.
- CLI validation/compile/package commands.
- Import/runtime support.
- Generic connector/capability contracts.
- Documentation and cookbook.

External SEO/GEO repo:

- Keep as advanced reference package.
- Add annotations and recipe documentation.
- Use to extract generic authoring patterns.

External supply-chain repo:

- Proposed path: `/Users/utpal/Code/projects/supply-chain-risk-playbook`
- Owns supply-chain prompts, schemas, scripts, tests, and fixtures.
- Imports only Tessera playbook SDK/contract packages.
- Never imports Tessera app internals or vendors Tessera source.
- Runs tests and validation locally, then imports into Tessera.

## Phase 0: Lock The Boundary

Outcome:

- A short architecture note describing what belongs in Tessera vs external playbook repos.

Tessera owns:

- Graph schema and compiler.
- Playbook package loader and validator.
- Durable execution.
- Human review.
- Artifact history.
- Capability permissions.
- Gmail/web adapters and fetched-feed parser conventions.
- Run trace and provenance.

External playbooks own:

- Domain schemas.
- Prompts.
- Domain scoring scripts.
- Domain-specific research plans.
- Fixtures and golden tests.
- Final artifact templates.

Acceptance criteria:

- No supply-chain domain concepts are added to Tessera contracts except generic evidence/capability primitives if needed.
- The external playbook can be loaded through Tessera's graph package loader.
- The plan explicitly rejects running playbooks outside Tessera.

Boundary matrix:

| Concern | Tessera owns | External playbook owns | Validation check |
| --- | --- | --- | --- |
| Runtime | Durable graph execution, review, artifact history | No runner | Reject standalone runner metadata or executor entrypoints |
| Capabilities | Declared tool/capability boundary | Required capability declarations | Error on undeclared tool/capability use |
| Domain logic | Generic artifact/provenance primitives only | Scoring, signal taxonomy, prompts, scripts | Warn on domain concepts proposed for Tessera core |
| Source safety | Package reader, source-ref validation, path containment | Package-relative refs only | Error on unsafe paths, missing refs, dangerous imports |
| Authoring UX | CLI diagnostics, JSON repair output | Tests and fixtures | Error/warning/info diagnostics with repair hints |

## Phase 1: Recipe From Existing SEO/GEO Playbook

Outcome:

- Convert the existing SEO/GEO playbook from "specimen" into Recipe Example 001.

Work:

- Add an annotated recipe document explaining the reusable pattern:
  - normalize intake
  - build dynamic plan
  - parallel fanout
  - fetch/summarize sources
  - aggregate findings
  - prepare compact agent seed
  - draft raw agent output
  - normalize raw output into a strict artifact
  - review and conditionally rework
  - human review
  - materialize final artifacts
- Identify which pieces are generic and which are SEO/GEO-specific.
- Extract a common authoring checklist.
- Add an inventory table mapping SEO/GEO files to reusable pattern versus domain-specific logic.
- Produce named deliverables:
  - `recipe-001-seo-geo.md`
  - `authoring-checklist.md`
  - a documented validator gap list, if the current package exposes missing validator affordances

Acceptance criteria:

- A new author can tell which files to copy, which files to rewrite, and which patterns to reuse.
- The recipe does not mention supply-chain-specific logic.
- SEO/GEO package tests still pass.
- SEO/GEO either passes `tessera playbook validate` or produces a tracked list of validator gaps.

## Phase 2A: Validation CLI First

Outcome:

- Add an author-facing validator before expanding SDK sugar.

CLI:

- `tessera playbook validate <path>`
- `tessera playbook validate <path> --json`

Repo-local fallback until the installed binary path is settled:

- `bun run --filter './apps/cli' -- playbook validate <path>`
- `bun run --filter './apps/cli' -- playbook validate <path> --json`

Diagnostics:

- `error`: blocks compile/import/run.
- `warning`: allowed but visible; should usually be fixed before publishing a reference playbook.
- `info`: guidance or improvement hints.

Output requirements:

- Human-readable summary.
- Machine-readable JSON suitable for external-agent repair loops.
- Stable diagnostic codes.
- File/path/node/artifact references where applicable.
- Deterministic exit codes.

JSON diagnostic shape:

```json
{
  "ok": false,
  "summary": {
    "errors": 1,
    "warnings": 1,
    "info": 1
  },
  "diagnostics": [
    {
      "code": "missing_schema_ref",
      "severity": "error",
      "message": "Artifact contentBrief references a missing schema file.",
      "path": "playbook.ts",
      "nodeId": "draftBrief",
      "artifact": "contentBrief",
      "ref": "schemas/contentBrief.schema.json",
      "repairHint": "Create the schema file or update the artifact schema ref."
    }
  ]
}
```

Exit codes:

- `0`: validation completed with no errors.
- `1`: validation completed and found one or more errors.
- `2`: CLI usage error, unreadable path, or internal validator failure.

Thin validator minimum:

- Wrap existing package reader, loader, compiler, and graph validation failures into diagnostics.
- Add only the cross-cutting checks needed for external-agent authoring repair loops.
- Defer domain-aware, policy-heavy, or heuristic diagnostics until SEO/GEO and supply-chain fixtures expose repeat failures.

Validation should catch:

- missing prompt/script/schema refs
- unsafe source paths
- unreachable nodes
- undeclared artifacts
- undeclared capabilities
- agent outputs without schemas
- artifact writes that cannot materialize a useful final artifact
- review paths that do not return to a sensible downstream step
- package/runtime version mismatches
- standalone runner metadata or local executor entrypoints
- dangerous imports and disallowed dependency fields
- live connector use that lacks fixture coverage

Acceptance criteria:

- SEO/GEO external package validates with the new CLI.
- Validator emits actionable human text and structured JSON.
- At least one failing fixture proves repair hints are useful.
- No substantial SDK helper expansion happens before this phase lands.

## Phase 2B: Minimal Authoring SDK Helpers

Outcome:

- Add only the SDK affordances needed by SEO/GEO plus the planned supply-chain playbook.

SDK candidates:

- `definePlaybook`
- artifact definition helpers
- node helpers for `script`, `tool`, `agent`, `parallelMap`, `condition`, `humanReview`, `artifactWrite`
- review/rework loop helper, only if it removes proven duplication
- test helpers for graph loading and script fixtures

CLI candidates after validation:

- `tessera playbook compile <path>`
- `tessera playbook package <path>`
- later: `tessera playbook init`

Acceptance criteria:

- Helpers are promoted only when they are used by SEO/GEO or needed by supply-chain and are not domain-specific.
- A placeholder supply-chain package scaffold validates before domain logic is added.
- Validation errors are author-facing and actionable.
- `tessera playbook init` remains deferred unless repeated scaffold errors prove it is needed.

## Phase 3: Supply Chain Playbook Recipe

Outcome:

- Define the external supply-chain playbook before implementation.

Working title:

- Supply Chain Early Warning and Disruption Response Playbook

V1 free sources:

Mandatory V1:

- Gmail connector for internal supplier/logistics signals.
- `web.search` and `web.fetch` for public news and pages.
- GDELT for broad news/event search.
- CBP RSS/CSMS feeds fetched as public URLs and parsed by playbook scripts.
- National Weather Service alerts fetched as public URLs and parsed by playbook scripts.

Optional V1 modules:

- FDA recalls for relevant industries.
- Curated trade-press URLs fetched through web tools.

Feed/API rule:

- Treat CBP, NWS, FDA, RSS, and similar public feeds as `web.fetch` plus external playbook parser scripts unless Tessera separately adds a generic feed capability.

Core final outputs:

- Executive Brief.md
- Risk Register.csv or Risk Register.md
- Mitigation Plan.md
- Supplier Outreach Drafts.md
- Evidence Appendix.md

Core normalized artifact:

```json
[
  {
    "sourceType": "gmail | web | gdelt | cbp | weather | recall",
    "entityType": "supplier | sku | material | port | lane | region",
    "entityName": "...",
    "signalType": "delay | congestion | recall | strike | weather | customs | shortage | financial_distress | quality",
    "severity": "low | medium | high",
    "confidence": "low | medium | high",
    "observedAt": "2026-05-21T00:00:00.000Z",
    "sourceQuality": "primary | official | trade_press | internal | weak",
    "evidence": "...",
    "rationale": "...",
    "source": {
      "url": "...",
      "messageId": "...",
      "threadId": "...",
      "feedId": "...",
      "title": "..."
    }
  }
]
```

Acceptance criteria:

- The recipe defines inputs, artifacts, graph phases, review gates, and final outputs.
- Every connector/source maps into the common `riskSignal[]` shape with provenance, severity, and confidence.
- The playbook can run with manual CSV/JSON fixtures before live connector access.
- The `riskSignal[]` schema stays inside the external supply-chain repo.

## Phase 4: External Supply Chain Repo Scaffold

Outcome:

- Create the external repo as a loadable Tessera playbook package.

Proposed layout:

```text
supply-chain-risk-playbook/
  README.md
  PLAYBOOK.md
  package.json
  manifest.json
  playbook.ts
  prompts/
    summarize-gmail-signal.md
    summarize-external-risk.md
    draft-mitigation-plan.md
    review-mitigation-plan.md
    rework-mitigation-plan.md
    draft-executive-brief.md
    draft-supplier-outreach.md
  schemas/
    normalizedIntake.schema.json
    supplyChainEntityMap.schema.json
    gmailSignalSearchPlan.schema.json
    riskSignal.schema.json
    riskSignalFanIn.schema.json
    mergedRiskEvidence.schema.json
    supplierRiskRegister.schema.json
    skuExposureRegister.schema.json
    laneRiskRegister.schema.json
    scenarioImpactAssessment.schema.json
    mitigationPlan.schema.json
    mitigationReview.schema.json
    executiveBrief.schema.json
    supplierOutreachDrafts.schema.json
    finalDisruptionPacket.schema.json
  scripts/
    normalizeIntake.ts
    parseSupplierTable.ts
    parseInventoryTable.ts
    extractSupplyChainEntities.ts
    buildGmailSignalSearchPlan.ts
    buildExternalRiskResearchPlan.ts
    normalizeRiskSignal.ts
    aggregateRiskSignals.ts
    scoreSupplierRisk.ts
    scoreSkuExposure.ts
    scoreLaneRisk.ts
    modelScenarioImpact.ts
    structureMitigationPlan.ts
    prepareFinalPacket.ts
  tests/
    fixtures/
    fixture-contract.md
    scripts.test.ts
    package.test.ts
```

Acceptance criteria:

- The initial scaffold validates with a minimal graph before domain scripts are complete.
- The package loads through Tessera's graph package loader.
- The graph contains at least one connector/tool fanout path and one review/rework loop.
- Fixtures prove the package can produce risk registers without live APIs.
- The package has no standalone execution path and does not vendor Tessera source.

## Phase 5: V1 Supply Chain Flow

Outcome:

- Implement an end-to-end V1 flow using fixtures first, then live Gmail/web/feed capabilities.

Graph phases:

1. Normalize intake.
2. Parse supplier/SKU/lane/inventory files.
3. Extract supply-chain entities.
4. Validate the graph and fixture contract before any live connector work.
5. Build Gmail signal search plan.
6. Search/summarize Gmail signals.
7. Build external risk research plan.
8. Fan out through public web/feed sources.
9. Normalize all source outputs into `riskSignal[]`.
10. Merge internal and external evidence.
11. Score supplier, SKU, and lane risk.
12. Model disruption scenarios.
13. Draft mitigation plan.
14. Review and optionally rework mitigation plan.
15. Draft executive brief and supplier outreach.
16. Human review.
17. Materialize final packet.

Acceptance criteria:

- Fixture-only end-to-end run produces the risk register and final packet before live Gmail/web/feed paths are enabled.
- Gmail and web/feed evidence are distinguishable in provenance.
- Risk scores are traceable to source evidence.
- Human review can request changes and return to the appropriate rework node.
- Negative fixtures cover noisy feed items, irrelevant Gmail threads, missing supplier mappings, and duplicate evidence.

## Phase 6: Tessera Import And Runtime Polish

Outcome:

- Make the external supply-chain package feel first-class inside Tessera.

Work:

- Import external package from folder or package archive.
- Show required capabilities before run.
- Show Gmail/web/feed source provenance in run trace.
- Show review surfaces for risk register and mitigation plan.
- Materialize multiple final outputs.

Acceptance criteria:

- User can import the external repo into Tessera.
- User can run it from Tessera against fixture inputs.
- User can review, request changes, and approve final outputs.
- Final files are written inside the selected workspace.
- Capability preview shows Gmail, web search/fetch, and any public feed URL access before live runs.
- Provenance is visible in the review surface or run trace for Gmail and web/fetched feed evidence.

## Phase 7: Cookbook And Agent Authoring Skill

Outcome:

- Make the process reproducible for Claude Code, Codex, Claude Cowork, Pi Agent, and Tessera itself.

Deliverables:

- `docs/playbook-authoring-recipe.md`
- `docs/playbook-patterns.md`
- `docs/playbook-validation-guide.md`
- portable `tessera-playbook-author` skill/instructions
- validator-driven repair loop guidance
- example prompts for external agents:
  - create a new playbook from recipe
  - add a connector source
  - add a review/rework loop
  - repair validation failures
  - add fixtures and golden tests

Acceptance criteria:

- An external agent can scaffold a third playbook using the recipe.
- The third playbook can scaffold, validate, fixture-run, package, and import without needing supply-chain or SEO-specific knowledge.
- The cookbook clearly separates SDK helpers, domain scripts, and runtime responsibilities.
- Agent prompts explicitly forbid external playbook execution and reinforce Tessera-only runtime.

## Risks And Mitigations

Risk: SDK becomes too abstract before real usage.

- Mitigation: Promote helpers only after SEO/GEO and supply-chain both justify them, or one playbook clearly needs a generic primitive.

Risk: Supply-chain logic leaks into Tessera core.

- Mitigation: Keep risk scoring, signal taxonomy, and output formats inside the external playbook unless they are truly generic capability/provenance structures.

Risk: Gmail evidence creates privacy or overreach concerns.

- Mitigation: Require explicit Gmail capability declaration, source summaries, and message-level provenance without exposing unnecessary email body text in final outputs.

Risk: Free feeds are noisy and inconsistent.

- Mitigation: Normalize every source into `riskSignal` with confidence and source quality fields, then let scoring scripts penalize weak evidence.

Risk: Playbook is too complex to validate early.

- Mitigation: Build fixture-first and add live connector paths after deterministic scripts and schemas pass.

Risk: Cross-repo version drift between Tessera, SEO/GEO, and the external supply-chain package creates confusing validation or import failures.

- Mitigation: Pin compiler/script SDK versions in compile metadata, include package/runtime version mismatch diagnostics, and validate both external reference packages after Tessera CLI/SDK changes.

## Verification Evidence Contract

Every implementation lane should report evidence in this shape before marking a phase complete:

- `PASS/FAIL` command line, exact path under test, and one-line output summary.
- Diagnostic code coverage for validator changes, including at least one negative fixture and repair hint.
- Boundary evidence for domain leakage checks: no supply-chain schemas, scoring terms, or source taxonomies added to Tessera core unless promoted as generic capability/provenance primitives.
- External package evidence: package-relative refs, no standalone runner metadata, no vendored Tessera source, and no live connector requirement for fixture tests.
- Runtime evidence: import/load result, capability preview, provenance visibility, review/rework behavior, and final materialized outputs.

## Verification Steps

For Tessera SDK/CLI changes:

```bash
bun test packages/core/src/playbook-graph-package.test.ts packages/core/src/playbook-graph-package-loader.test.ts
bun run check
```

For SEO/GEO reference:

```bash
bun test
tessera playbook validate /Users/utpal/Code/projects/seo-geo-blog-reference-playbook
```

For external supply-chain package:

```bash
bun test
tessera playbook validate /Users/utpal/Code/projects/supply-chain-risk-playbook
tessera playbook compile /Users/utpal/Code/projects/supply-chain-risk-playbook
```

## Available Agent Types Roster

- `explore`: map current Tessera CLI, loader, compiler, SDK, and validation surfaces.
- `planner`: sequence SDK/CLI/playbook phases and maintain acceptance criteria.
- `architect`: review Tessera-vs-external-repo boundaries and capability contracts.
- `executor`: implement bounded Tessera CLI/SDK/package-loader changes.
- `test-engineer`: design fixture, validator, and package-loader test coverage.
- `verifier`: validate final evidence, command output, and acceptance criteria.
- `writer`: produce cookbook, recipe, and agent-authoring skill documentation.
- `critic`: challenge over-abstraction, domain leakage, and weak verification gates.

## Follow-Up Staffing Guidance

Ralph path:

- Use `$ralph` after the plan is approved when the next goal is sequential delivery of Phase 2A validation CLI.
- Suggested roles: one `executor` for CLI/validator implementation, one `test-engineer` for diagnostics and fixture tests, one `verifier` for final validation.
- Suggested reasoning: `executor` high, `test-engineer` medium, `verifier` high.
- Reasoning: Phase 2A has a clear critical path and benefits from a single owner keeping validation behavior coherent.

Team path:

- Use `$team` when working across Tessera validation, SEO/GEO recipe annotations, and the external supply-chain scaffold in parallel.
- Suggested lanes:
  - `executor`: Tessera validation CLI and JSON diagnostics.
  - `writer`: SEO/GEO Recipe Example 001 and authoring checklist.
  - `executor`: external supply-chain scaffold and fixtures.
  - `test-engineer`: package validation, negative fixtures, and import smoke checks.
  - `architect`: boundary and capability review.
- Suggested reasoning: `executor` high for validator and scaffold lanes, `writer` high, `test-engineer` medium, `architect` high.
- Reasoning: these lanes have mostly disjoint write scopes and can converge around the validator contract.

Launch hints:

```text
$ralph .omx/plans/2026-05-21-supply-chain-playbook-authoring-plan.md
$team .omx/plans/2026-05-21-supply-chain-playbook-authoring-plan.md
```

Team verification path:

- Team proves each lane with local tests, validation output, and changed-file summaries.
- Ralph or a final verifier then performs cross-lane integration: SEO/GEO validates, supply-chain scaffold validates, CLI diagnostics work in text and JSON modes, and no playbook execution path exists outside Tessera.

## Goal-Mode Follow-Up Suggestions

- `$ultragoal`: best default if this becomes a durable multi-phase product goal spanning SDK, CLI, docs, and external playbook repos.
- `$autoresearch-goal`: useful if the immediate next step is researching free public supply-chain feeds and their reliability before implementation.
- `$performance-goal`: not a primary fit unless later validator/import performance becomes a measurable bottleneck.

## ADR

Decision:

- Build the playbook authoring system through two external reference packages: SEO/GEO and supply-chain. Keep the supply-chain playbook outside the Tessera repo. Choose a validation-first spine with a small SDK-helper allowance after validation is useful.

Drivers:

- Need a reproducible authoring recipe.
- Need to avoid SEO-specific SDK bias.
- Need to prove connector-backed evidence and multi-output business workflows.
- Need Tessera to stay the only runtime.

Alternatives considered:

- Build a large SDK first: rejected because it risks abstract helpers with no proof of utility.
- Build a full validator before supply-chain exists: rejected because it risks freezing rules too early; start with a thin validator and grow from failing fixtures.
- Build supply-chain playbook inside Tessera: rejected because it weakens the external package boundary.
- Make playbooks runnable in external agents: rejected because Tessera must own permissions, durability, review, and provenance.

Why chosen:

- Two external examples create the right extraction pressure: one content/research workflow and one operational risk workflow.

Consequences:

- Early work is slightly slower because validation, SDK, and external package structure must evolve together.
- The resulting authoring recipe should be much more reusable.
- The first validator should stay intentionally narrow, then expand from SEO/GEO and supply-chain fixture failures.

Changelog:

- Added execution status, deliverables tracking, verification evidence expectations, and decision-owner follow-ups so the plan can be used as a team execution artifact instead of only a strategy narrative.
- Applied consensus review feedback by splitting validation before SDK helpers, adding JSON diagnostics and exit codes, clarifying feed ownership, adding fixture-first gates, and adding execution staffing guidance.
- Applied Critic optional improvements by adding a repo-local validation invocation fallback, defining the thin validator minimum, and adding cross-repo version drift mitigation.

Follow-ups:

| Decision | Default recommendation | Owner lane | Needed before | Resolution evidence |
| --- | --- | --- | --- | --- |
| Exact external repo path/name | Use `/Users/utpal/Code/projects/supply-chain-risk-playbook` unless an existing repo already owns this domain | leader + executor | Phase 4 scaffold | Repo exists with README, manifest, package metadata, and no Tessera source vendoring |
| `tessera playbook init` timing | Defer until after the first supply-chain scaffold exposes repeated scaffold errors | executor + test-engineer | Phase 2B completion review | Validator/scaffold error log showing whether init would remove real repetition |
| Mandatory vs optional free feeds | Keep Gmail, web search/fetch, GDELT, CBP CSMS/RSS, and NWS mandatory; keep FDA recalls and trade press optional for V1 | architect + writer | Phase 3 recipe finalization | Recipe maps every mandatory source into `riskSignal[]` with fixture coverage |

Open follow-ups should remain decisions, not implementation blockers, until their `Needed before` phase starts.
