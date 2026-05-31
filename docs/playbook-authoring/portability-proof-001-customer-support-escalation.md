# Portability Proof 001: Customer Support Escalation Triage

This proof checks whether the Phase 7 cookbook can guide a third-domain playbook without SEO/GEO or supply-chain assumptions.

## Prompt Used

```text
Use the portable Tessera playbook author instructions to create an external playbook package at /tmp/customer-support-escalation-playbook.
Tessera is the only runtime. Start with an authoring brief. Ask one focused question if package path, source inventory, schema plan, review gate, or final artifact acceptance is missing. Generate files only after the brief is coherent. Validate in text and JSON modes and repair diagnostics until no errors remain.

Workflow: help a support manager review urgent customer issues and prepare a daily escalation packet.
Primary user: support manager.
Sources and capabilities: Gmail support-manager email threads through gmail.search, public status-page evidence through web.fetch, and final workspace outputs through tool.workspace.write.
Final artifacts: Daily Escalation Packet markdown, Escalation Register CSV, Evidence Appendix markdown.
```

## Boundary Result

The prompt gives a package path, workflow, user, sources, capabilities, and final artifact formats. The agent is ready to proceed to an authoring brief and scaffold package files, but must not add a local graph runner or execute the graph.

Allowed verification for the scaffold:

- `playbook validate` text mode.
- `playbook validate --json`.
- Package-local deterministic script and golden tests over fixtures.

Deferred to Tessera:

- Import smoke.
- Capability exercise.
- Human review pause.
- Final artifact materialization.

## Authoring Brief Skeleton

Runtime boundary:

- Tessera is the only runtime.
- External authoring may create package files, fixtures, schemas, prompts, deterministic scripts, and tests.
- No standalone graph runner, `bin` entrypoint, lockfile, dependency field, or local graph execution wrapper.

Package identity:

- Working title: Customer Support Escalation Triage
- External package path: `/tmp/customer-support-escalation-playbook`
- Owning persona: support manager
- Reference recipe: portable cookbook, not SEO/GEO or supply-chain

Business outcome:

- Help a support manager decide which urgent customer issues need escalation, owner assignment, and leadership attention today.
- Final packet audience: support leadership and cross-functional owners.
- Cadence: daily or manually triggered during incident periods.
- Useful final packet: prioritized escalation register, concise narrative summary, evidence appendix, owners, due dates, and assumptions.

Source inventory:

| Source | Capability | Access mode | Fixture/golden coverage | Notes |
| --- | --- | --- | --- | --- |
| Support-manager email threads | `gmail.search` | live connector later, fixture first | required | Needs privacy and redaction rules |
| Public status pages | `web.fetch` | public URL fetch later, fixture first | required | Exact URLs can be user input or package fixture data |
| Workspace final outputs | `tool.workspace.write` | Tessera effect after approval | Tessera runtime proof required | Required for markdown and CSV materialization |

Data requirements:

- Input entities: customer, account, ticket/thread, incident, product area, owner, due date.
- Normalized records: `escalationSignal[]`.
- Provenance fields: source kind, source ref, observed timestamp, customer/account, excerpt or summary, confidence.
- No-invention fields: customer identity, contract commitments, severity, owner, due date, outage state.

Graph sketch:

| Phase | Node kind | Inputs | Outputs | Schema required | Review required |
| --- | --- | --- | --- | --- | --- |
| Intake | script | user inputs and fixture selectors | normalized intake | yes | no |
| Source | tool or fixture script | Gmail/status inputs | raw source evidence | yes | no |
| Normalize | script/agent | raw evidence | `escalationSignal[]` | yes | no |
| Analyze | script/agent | signals | escalation register | yes | conditional |
| Draft | agent | register and evidence | daily packet draft | yes | yes |
| Review | humanReview | packet draft and register | approve or request changes | yes | yes |
| Materialize | effect | approved outputs | markdown/CSV artifacts | yes | no |

Schema plan:

- `schemas/intake.schema.json`
- `schemas/escalation-signal.schema.json`
- `schemas/escalation-register.schema.json`
- `schemas/escalation-packet.schema.json`
- `schemas/evidence-appendix.schema.json`
- `schemas/review-decision.schema.json`

Final artifacts:

| Artifact | Format | Audience | Materialization rule | Acceptance check |
| --- | --- | --- | --- | --- |
| Daily Escalation Packet | markdown | support leadership | approved packet summary | includes prioritized issues, owners, due dates, assumptions |
| Escalation Register | CSV | support manager | register rows | one row per escalation candidate |
| Evidence Appendix | markdown | reviewers | provenance summaries | every claim links to fixture/live source ref |

## Package Scaffold Checklist

A scaffold generated from this proof should include:

- `manifest.json`
- `playbook.ts`
- `PLAYBOOK.md`
- `schemas/*.schema.json`
- `prompts/draft-packet.md`
- `prompts/review-packet.md`
- `prompts/rework-packet.md`
- `scripts/normalize-intake.ts`
- `scripts/normalize-escalation-signals.ts`
- `scripts/build-escalation-register.ts`
- `scripts/materialize-packet.ts`
- `tests/fixtures/*`
- `tests/scripts.test.ts`

It should not include:

- `bin`
- dependency fields
- lockfiles
- `run-playbook.*`
- graph execution wrappers

## Expected Validation Path

```bash
bun run --cwd apps/cli src/index.ts playbook validate /tmp/customer-support-escalation-playbook
bun run --cwd apps/cli src/index.ts playbook validate /tmp/customer-support-escalation-playbook --json
```

Expected readiness target:

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

## Forward-Test Verdict

Prompt-level pass, with one guardrail:

- The cookbook provides enough generic structure to scaffold the customer-support playbook without SEO/GEO or supply-chain knowledge.
- Exact Gmail query scope, status-page URLs, privacy redaction policy, and owner assignment rules remain package/user requirements. If they are not provided, the agent should ask one focused question before finalizing schemas or prompts.
- This file is a prompt-level forward test, not the package/import proof. The actual third-playbook package proof is recorded in `docs/playbook-authoring/portability-proof-002-procurement-rfq-followup.md`.

No SDK helper is promoted from this proof alone. Record helper candidates only when repeated friction appears across reference packages or real validator diagnostics.
