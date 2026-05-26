# Forward Test 001: Customer Support Escalation Triage

This evidence closes the Phase 2A.5 forward-test gate for `tessera-playbook-author` V0.

## Test Prompt

```text
Use $tessera-playbook-author to author a Customer Support Escalation Triage playbook.
The playbook should help a support manager review urgent customer issues and prepare a daily escalation packet.
We may use Gmail for support-manager email threads, web.fetch for public status-page evidence, and workspace writes for final markdown/CSV outputs.
```

## Skill Behavior Expected

- Start with the Tessera-only runtime boundary.
- Produce or critique an authoring brief before generating files.
- Stop before package generation because the prompt omits package path, exact source inventory, target schemas, review gates, and final artifact acceptance checks.
- Ask one focused next question instead of batching several questions.
- Record no SDK helper candidates because no repeated authoring friction has been observed yet.

## Authoring Brief Draft

Runtime boundary:

- Tessera is the only runtime.
- External authoring may prepare package files and validate them later.
- No standalone runner, `bin` entrypoint, lockfile, dependency field, or local graph execution wrapper should be created.

Package identity:

- Working title: Customer Support Escalation Triage Playbook
- External package path: unknown
- Owning persona: support manager
- Reference recipe: none selected yet

Business outcome:

- Help a support manager turn urgent customer issues into a daily escalation packet.
- Primary decision: which customer issues need escalation, owner assignment, and management attention today.
- Primary user: support manager.
- Final packet audience: support leadership and cross-functional owners.
- Non-goals: unknown.

Source inventory:

| Source | Capability | Access mode | Fixture/golden coverage | Notes |
| --- | --- | --- | --- | --- |
| Support-manager email threads | `gmail.search` | live connector later, fixture first | missing | Needs privacy/redaction policy |
| Public status pages | `web.fetch` | fetched public URLs | missing | Exact status-page URLs unknown |
| Workspace final outputs | `tool.workspace.write` | Tessera effect after approval | missing | Required for final markdown/CSV materialization |

Data requirements:

- Candidate entities: customer, account, ticket/thread, product area, incident, owner, severity, due date.
- Candidate normalized record: `escalationSignal[]`.
- Required provenance: source type, source ref, timestamp, customer/account, excerpt or summary, confidence.
- Fields that must never be invented: customer identity, severity, contractual commitments, owners, dates.

Graph sketch:

| Phase | Node kind | Inputs | Outputs | Schema required | Review required |
| --- | --- | --- | --- | --- | --- |
| Intake | tool | Gmail query and status URLs | raw source evidence | yes | no |
| Normalize | script/agent | raw source evidence | `escalationSignal[]` | yes | no |
| Analyze | agent/script | `escalationSignal[]` | prioritized escalation register | yes | conditional |
| Draft | agent | escalation register | daily packet draft | yes | yes |
| Review | humanReview | daily packet draft | approved or changes requested | yes | yes |
| Materialize | effect | approved packet | markdown/CSV/PDF outputs | yes | no |

Schema plan:

- `schemas/escalationSignal.schema.json`
- `schemas/escalationRegister.schema.json`
- `schemas/escalationPacket.schema.json`

Final artifact candidates:

- `Daily Escalation Packet.md`
- `Escalation Register.csv`
- `Evidence Appendix.md`

Validation plan:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path>
bun run --cwd apps/cli src/index.ts playbook validate <external-package-path> --json
```

## Stop Verdict

Stop before package generation.

Reason:

- External package path is unknown.
- Exact Gmail search scope, status-page URLs, privacy/redaction rules, schema fields, review actions, and final artifact acceptance checks are not yet specified.
- Generating files now would invent business rules and data contracts.

Next question:

```text
What external package path should this playbook use?
```

## SDK Helper Candidate Evidence

No SDK helper candidate is promoted from this test. The test exercised the interview-first brief gate but did not expose repeated package-authoring friction.

## Package Validation

No package files were generated or touched, so `playbook validate` was not applicable for this forward test.
