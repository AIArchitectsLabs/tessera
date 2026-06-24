# Tessera Playbook Patterns

Use these patterns when designing external Tessera playbooks. They describe reusable graph shapes without importing domain vocabulary from the SEO/GEO or supply-chain reference packages.

## Pattern: Normalize Intake First

Use when user input may arrive as free text, copied rows, URLs, records, or partial forms.

Shape:

- Input artifact: raw user input.
- Script node: normalize into stable fields with ids.
- Output artifact: `normalizedIntake`.
- Downstream nodes read only normalized fields.

Rules:

- Preserve user-provided values.
- Record missing fields as gaps instead of inventing them.
- Keep fallback defaults explicit.
- Test string, array, object, empty, and malformed inputs.

## Pattern: Capability-Declared Source Collection

Use when the playbook needs Gmail, web search, web fetch, files, feeds, or workspace data.

Shape:

- Graph declares every required and optional capability.
- Tool or connector nodes produce raw source evidence.
- Fixture nodes or package fixtures cover source behavior before live paths.
- Source metadata carries kind, reference, timestamp, confidence, and access mode.

Rules:

- A live source requirement must become an executable graph node, not only prose in an agent prompt.
- Required sources should be listed in `metadata.requiredCapabilities` and top-level `capabilities`; optional sources should be optional only when the final artifact remains useful without them.
- Public feeds are modeled as `integration.web.fetch` plus package-local parsing until Tessera adds a generic feed capability.
- Connector-specific semantics stay inside the package.
- The start surface should make capabilities visible before running.
- Live connector access is not required for fixture validation.
- For email/Gmail workflows, use `integration.mail.messages.read` with `mail search` or `mail list`, emit a raw mail artifact, and make downstream nodes preserve empty-source diagnostics.

## Pattern: Source Normalization

Use when raw source data needs domain-specific parsing.

Shape:

- Input artifact: raw source evidence.
- Script or agent node: normalize into domain records.
- Output artifact: typed record array such as `<domain>Signal[]`.

Rules:

- Keep provenance on every record.
- Include confidence or source-quality fields when the final decision depends on evidence strength.
- Mark irrelevant evidence as filtered instead of silently discarding it when auditability matters.
- Deduplicate by stable source and domain ids.

## Pattern: Fan-In With Gaps

Use when multiple source branches need to become one decision-ready artifact.

Shape:

- Inputs: normalized records from multiple branches.
- Script node: merge, deduplicate, score, and summarize gaps.
- Outputs: register or queue plus `sourceGaps`.

Rules:

- Preserve source kind and source reference.
- Keep scoring thresholds package-owned.
- Expose missing evidence as reviewable gaps.
- Avoid letting one noisy source dominate without source-quality weighting.

## Pattern: Draft, Review, Rework

Use when an agent-generated artifact needs quality control before the user sees final output.

Shape:

- Draft node produces structured artifact.
- Review node produces schema-shaped review result.
- Conditional node routes pass to human review or fail to rework.
- Rework node consumes original draft plus review findings.
- Loop has an explicit maximum or exit condition.

Rules:

- Review output includes pass/fail, findings, severity, and revision instructions.
- Rework prompts consume the previous artifact and feedback.
- Do not create unbounded loops.
- Keep review criteria domain-owned.

## Pattern: Human Review With Feedback As Data

Use when a human must approve or request changes before final writes.

Shape:

- Human review node pauses on inspectable artifacts.
- Approve branch moves to final materialization.
- Request-changes branch writes feedback as an artifact.
- Rework branch consumes the feedback artifact.

Rules:

- Use product-level labels such as approve and request changes.
- The feedback textbox is part of the graph data path, not a UI-only note.
- Approval should describe what will happen next.
- Stop/deny should not perform workspace writes.

## Pattern: Materialize Final Outputs

Use when the playbook must create durable workspace artifacts.

Shape:

- Input artifact: approved final content or records.
- Materialization effect writes markdown, CSV, JSON, or PDF.
- Run output links to the committed artifact record.

Rules:

- Do not materialize intermediate drafts as final outputs.
- Every final artifact has an audience and acceptance check.
- Markdown is best for narrative packets.
- CSV is best for queues, ledgers, and registers.
- JSON is best for machine-readable downstream use.

## Pattern: Fixture-First Future Connector Upgrade

Use when live Gmail, web, feed, or external-source behavior is planned later and the package is explicitly fixture-first for now. Do not use this pattern when the user asked for a working connector-backed playbook.

Shape:

- Fixture source path proves normalization and fan-in.
- Optional live source capability is documented as future work, not as current runtime behavior.
- Runtime note explains live adapter requirements when the adapter is not registered.
- Later connector work replaces fixture source nodes or command-plan outputs with live effect nodes.

Rules:

- Do not block package validation on live credentials.
- Do not list future live sources as required capabilities or claim the package is connector-backed until executable source nodes exist.
- Keep fixture data realistic enough to exercise provenance, gaps, duplicates, and noise.
- Treat command plans as transitional only; do not call them final live writes.

## Pattern: Third-Playbook Portability Test

Use when deciding whether the cookbook is reusable beyond existing examples.

Shape:

- Pick a domain that is not SEO/GEO or supply-chain.
- Create only an authoring brief first.
- Stop before generation if path, sources, schemas, or review gates are underspecified.
- Record whether the recipe forced a domain-specific assumption.

Rules:

- Customer support escalation is the current forward-test example.
- A successful portability test can end with a stop verdict when generation would invent requirements.
- Do not promote SDK helpers from one forward test alone.

## Anti-Patterns

Avoid:

- Copying reference-domain schemas into a new domain.
- Adding a package-local graph runner to make tests easier.
- Validating only happy-path fixtures.
- Letting prompts invent missing source facts.
- Claiming live source support without executable source collection nodes.
- Writing final artifacts before approval.
- Hiding connector provenance in narrative text only.
- Treating feed parsing, risk scoring, or content scoring as Tessera core behavior before it is proven generic.
