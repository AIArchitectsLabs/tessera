# Product Requirements Document: Tessera

## 1. Executive Summary

Tessera is an open-source Agent Workspace for business professionals. It turns
repeatable business work into guided, reviewable AI-assisted playbooks that run
from a local-first desktop app. Tessera should not become a general chatbot, a
CRM clone, or a Zapier clone. Its product wedge is governed execution: business
users connect the systems they already use, run production-grade playbooks, review
evidence and proposed actions, and approve writes through explicit checkpoints.

The next build focus is a Business Connector Pack plus a public portfolio of
production-grade open-source playbooks. Connectors make Tessera useful against
real business context. Playbooks make that utility repeatable, inspectable, and
shareable.

## 2. Product Thesis

Business users do not need a blank agent box. They need reliable workflows that
can read from common work systems, produce useful business artifacts, and stop
before unsafe writes. Tessera should win by combining:

- Local-first desktop execution and workspace materialization.
- Capability-scoped connectors with preview, approval, idempotency, and audit
  semantics.
- Portable playbook packages with schemas, prompts, scripts, fixtures, tests, and
  final artifacts.
- A public open-source playbook gallery that proves real workflows before a
  marketplace exists.

## 3. External Market Signal

This PRD was refreshed on 2026-06-26 with current connector signals.

- Zapier advertises more than 9,000 app connections and shows business app demand
  around Google Sheets, Gmail, Slack, Google Calendar, Google Drive, HubSpot,
  Notion, Google Forms, Mailchimp, Stripe, Microsoft Outlook, Airtable,
  Calendly, Trello, Google Docs, Salesforce, Jira, Zendesk, QuickBooks, Xero,
  GitHub, PayPal, Shopify, Intercom, and Microsoft Teams:
  https://zapier.com/apps
- Zapier's navigation clusters common business automation by RevOps, marketing,
  IT, HR, sales, customer support, leaders, executive assistants, lead
  management, sales pipeline, campaigns, customer support, data management,
  project management, and tickets/incidents:
  https://zapier.com/apps
- Anthropic's Model Context Protocol announcement frames MCP as an open standard
  for connecting AI assistants to data sources and names pre-built servers for
  Google Drive, Slack, GitHub, Git, Postgres, and Puppeteer:
  https://www.anthropic.com/news/model-context-protocol
- Okta's Businesses at Work 2026 report page says agentic AI adoption is still
  cautious, with governance, identity, and access risks as major concerns:
  https://www.okta.com/businesses-at-work/

Implication: Tessera should prioritize the connectors business users already
expect, but differentiate through local-first governance, explicit capability
contracts, and review-before-write playbooks rather than racing to maximize raw
connector count.

## 4. Target Audience

- Business operators and founders who need repeatable work across email,
  calendars, documents, spreadsheets, CRM, support, finance, and project systems.
- Consultants, analysts, and managers who handle sensitive client or company
  context and prefer local-first execution with explicit review gates.
- Workflow power users who are tired of rebuilding the same prompt chain and want
  reusable playbooks with schemas, fixtures, and predictable outputs.
- Open-source playbook authors who want a stable package contract for business
  workflows without reimplementing a runtime.

## 5. Current Product Baseline

The current repository already has the right spine:

- Tauri desktop app, Bun sidecar, React UI, shared Zod contracts, and a plugin SDK.
- Dashboard, inbox, task detail, workspace, playbook catalog, and settings
  surfaces.
- Built-in graph playbook examples for sales, operations, customer success, and
  dashboard output.
- External playbook authoring docs, validation guide, package contract, public
  docs, and reference recipe patterns.
- Capability and connector registry primitives with side-effect policy,
  preview/approval requirements, shell allowlists, and canonical capabilities.
- Current first-party connector coverage for workspace writes, web search/fetch,
  Google Workspace reads and approved external writes, plus HubSpot CLI support.

The product gap is no longer "invent the playbook concept." The gap is packaging
the concept into a business-user adoption loop:

1. Connect common tools.
2. Import or choose a credible playbook.
3. Run with clear setup/preflight.
4. Review evidence and proposed actions.
5. Approve only the writes the user understands.
6. Get a durable artifact and run history.

## 6. Product Principles

- Connector breadth follows playbook demand. Add connectors that unlock concrete
  published playbooks, not generic logo coverage.
- Read before write. Every connector should ship useful read-only capabilities
  before external write effects.
- Draft before send. External communication writes should create drafts or staged
  records first unless a later enterprise policy explicitly allows direct action.
- Capability contracts are product contracts. Every connector capability must
  declare scopes, side effects, idempotency, preview behavior, approval behavior,
  rate-limit/error behavior, and data policy.
- Core stays generic. Domain semantics belong in playbook packages until repeated
  evidence proves they should become platform primitives.
- Open-source playbooks must be production-grade. A published package needs
  schemas, fixtures, tests, validation evidence, capability docs, sample outputs,
  and a release artifact.

## 7. Connector Strategy

### 7.1 Connector Types

Tessera should support three integration lanes:

1. Native first-party connectors:
   - Best for high-demand systems and capabilities that need strong governance,
     previews, idempotency, and polished setup UX.
   - Examples: Google Workspace, Microsoft 365, Slack, HubSpot, Salesforce,
     workspace files, web search/fetch.
2. Managed plugin connectors:
   - Best for partner or community connectors that conform to Tessera's plugin SDK
     and capability registry but are not bundled into core.
   - Examples: Zendesk, Intercom, Jira, Stripe, QuickBooks, Xero, Airtable,
     Notion, GitHub, GitLab.
3. MCP bridge connectors:
   - Best for bring-your-own AI ecosystem integrations where the user accepts a
     more generic adapter.
   - Default to read-only, require explicit capability mapping, and route writes
     through Tessera previews and Action Inbox approvals.

### 7.2 P0 Connector Pack

P0 connectors are required for the next business-user adoption loop.

| Connector | Why it matters | Initial capabilities | Write posture |
| --- | --- | --- | --- |
| Google Workspace | Already partly implemented and central to email, calendar, docs, drive, sheets, and contacts workflows. | Gmail read, Calendar read, Drive read, Contacts read, Docs/Sheets/Gmail draft effects. | Draft/write only after preview and approval. |
| Microsoft 365 | Required for parity with business teams that live in Outlook, Teams, OneDrive, SharePoint, Excel, and Word. | Outlook mail/calendar read, OneDrive/SharePoint file read, Excel/Word read. | Draft email/doc/spreadsheet writes only after preview and approval. |
| Slack | High-demand team communication and incident/customer context source. | Channel/message search, thread read, user lookup, file link read. | Draft post or approval-gated post only after read coverage is trusted. |
| HubSpot | Already has CLI code and unlocks SMB sales/marketing/customer workflows. | Summary, contact/company/deal search/read. | Create/update only with preview, idempotency, and approval. |
| Salesforce | Enterprise CRM expectation and strong signal from integration ecosystems. | Account/contact/opportunity search/read. | Mutations deferred until read-only playbooks prove value. |
| Web search/fetch | Required by research, competitive intelligence, SEO/GEO, risk, and enrichment playbooks. | Search, fetch, provenance capture. | Read-only. |
| Workspace files | Core materialization path for durable artifacts. | Read selected workspace files, write generated artifacts. | Workspace writes require review/approval and boundary checks. |

### 7.3 P1 Connector Pack

P1 connectors should follow published playbook demand:

- Jira, GitHub, and GitLab for project, release, incident, and engineering ops
  briefings.
- Zendesk, Intercom, Freshdesk, and Help Scout for support escalation and customer
  success workflows.
- Stripe, QuickBooks Online, Xero, PayPal, and Shopify for revenue, reconciliation,
  and ecommerce ops workflows.
- Airtable, Notion, Trello, Asana, and Monday.com for lightweight operating
  systems used by small teams.
- Postgres, BigQuery, Snowflake, and CSV/Parquet folders for analytical and
  operations reporting workflows.

### 7.4 P2 Connector Pack

P2 connectors are valuable but should not block the next wedge:

- NetSuite, Microsoft Dynamics, Zoho CRM, and Marketo.
- DocuSign, Box, Dropbox, and Smartsheet.
- HRIS systems such as Workday, BambooHR, and Greenhouse.
- Domain-specific feeds for supply-chain, finance, legal, or compliance workflows.

## 8. Plugin And Capability Requirements

### 8.1 Canonical Capability Registry

The canonical capability registry must grow from coarse aliases into stable,
versioned connector capabilities. New capabilities should use explicit verbs and
side-effect level:

- `integration.microsoft.mail.messages.read`
- `integration.microsoft.calendar.events.read`
- `integration.microsoft.drive.files.read`
- `integration.slack.messages.read`
- `integration.slack.messages.draft`
- `integration.crm.contacts.read`
- `integration.crm.accounts.read`
- `integration.crm.deals.read`
- `integration.support.tickets.read`
- `integration.payments.transactions.read`
- `integration.accounting.invoices.read`
- `integration.project.issues.read`
- `integration.code.pull_requests.read`
- `integration.database.query.read`

Aliases may keep playbook authoring friendly, but runtime policy must resolve to
canonical ids before execution.

### 8.2 Connector Contract

Every connector must declare:

- Provider id, display name, auth type, required scopes, and data policy.
- Tools and effects with capability id, side effect, idempotency, preview
  requirement, approval requirement, timeout, retry policy, and rate-limit class.
- Dry-run/preview support for every write-capable effect.
- Error taxonomy with user-facing setup, permission, rate-limit, validation, and
  provider-outage states.
- Credential storage in OS-secure storage, never plaintext config.
- Test fixtures and mocked provider responses for package-level and sidecar tests.

### 8.3 MCP Bridge Contract

The MCP bridge must not bypass Tessera governance:

- MCP servers are disabled by default.
- Users install or register MCP servers explicitly.
- Tessera maps MCP tools to canonical capabilities before a playbook can use them.
- Unknown MCP tools are read-only unavailable until mapped.
- Write-capable MCP tools require preview/approval adapters or are blocked.
- MCP connector logs must include server id, tool id, input summary, capability id,
  approval id when applicable, and output reference.

## 9. Open-Source Playbook Strategy

Tessera should publish production-grade playbooks as standalone open-source
repositories or clearly versioned packages. The goal is to improve adoption by
showing concrete business outcomes, not by shipping toy examples.

### 9.1 Production-Grade Definition

A playbook is publishable only when it includes:

- `manifest.json`, `playbook.ts`, schemas, prompts, scripts, layouts when needed,
  fixtures, and tests.
- A `PLAYBOOK.md` explaining business outcome, required inputs, capabilities,
  expected artifacts, review gates, failure modes, and safe operating limits.
- Package-local deterministic tests for scripts and fixture normalization.
- Tessera validation in text and JSON mode with zero errors.
- Redacted sample data and expected sample outputs.
- Capability matrix with required/optional connectors and least-privilege scopes.
- Security notes covering data handling, external writes, and secrets.
- Screenshots or short run transcript from Tessera.
- Release archive suitable for import plus checksum.
- CI that runs package-local tests and Tessera validation.

### 9.2 Initial Open-Source Portfolio

Publish six credible packages in this order:

1. `sales.meeting-brief-plus`
   - Connectors: Google Workspace or Microsoft 365, HubSpot/Salesforce optional,
     web search/fetch.
   - Output: account meeting brief, stakeholder summary, risks, discovery
     questions, follow-up draft.
2. `customer.renewal-risk-review`
   - Connectors: CRM read, mail/drive read, Slack optional, support ticket read
     optional.
   - Output: renewal risk packet, save-plan recommendations, executive summary.
3. `support.escalation-triage`
   - Connectors: Zendesk/Intercom/Freshdesk, Slack, CRM, docs.
   - Output: escalation brief, customer timeline, recommended owner, response
     draft.
4. `ops.weekly-exec-digest`
   - Connectors: mail, calendar, drive/docs, Slack/Teams, Jira/GitHub optional.
   - Output: weekly operating digest, decisions, blockers, follow-ups.
5. `finance.invoice-payment-reconciliation`
   - Connectors: Stripe, QuickBooks/Xero, Google Sheets/Excel.
   - Output: reconciliation exceptions, follow-up drafts, ledger update preview.
6. `procurement.rfq-follow-up`
   - Connectors: Gmail/Outlook, Sheets/Excel, Drive/SharePoint, web fetch.
   - Output: supplier response tracker, follow-up drafts, shortlist packet.

Keep the existing SEO/GEO and supply-chain recipes as reference patterns, but
graduate them only after they meet the production-grade checklist.

## 10. What To Build Next

### 10.1 Recommended Next Initiative

Build the Business Connector Pack foundation and use it to ship two open-source
playbooks end-to-end. This creates a visible adoption loop and forces connector,
plugin, playbook, docs, and UX work to converge.

### 10.2 First Milestone: Connector Substrate Hardening

Scope:

- Version canonical capabilities and add provider-specific capability ids.
- Promote HubSpot from CLI-only usage into the graph connector registry.
- Add connector setup/readiness states to Integration Settings and playbook
  preflight.
- Add shared connector error taxonomy and user-facing remediation messages.
- Add dry-run/preview requirements to every external write effect.
- Add tests proving unmapped/unknown connector capabilities cannot run.

Acceptance criteria:

- A playbook cannot start when a required connector capability is unavailable.
- Optional connector capabilities display as optional and do not block start.
- Write effects cannot execute without preview and approval when marked external
  or write.
- HubSpot read capabilities can be declared by a graph playbook and resolved
  through the connector registry.

### 10.3 Second Milestone: Google Workspace GA Playbook Wedge

Scope:

- Make Google Workspace setup reliable enough for beta: OAuth metadata setup,
  credential storage, connection test, capability preflight, and clear failure
  states.
- Publish one production-grade Google Workspace playbook:
  `procurement.rfq-follow-up` or `ops.weekly-exec-digest`.
- Include Gmail draft or Sheets/Docs write effects only behind preview and
  approval.

Acceptance criteria:

- A fresh user can connect Google Workspace and run the playbook using documented
  sample data.
- The playbook produces a durable artifact and at least one approved draft/write
  effect.
- The package has tests, fixtures, validation evidence, docs, and an importable
  release archive.

### 10.4 Third Milestone: Slack Plus CRM Read Pack

Scope:

- Add Slack read connector: channel search, thread read, user lookup.
- Add HubSpot graph connector read capabilities.
- Add Salesforce read-only connector for accounts, contacts, and opportunities.
- Publish `sales.meeting-brief-plus` or `customer.renewal-risk-review` using CRM
  read plus mail/drive/web evidence.

Acceptance criteria:

- A playbook can combine CRM, mail/drive, web, and Slack evidence into one
  schema-backed artifact.
- CRM and Slack writes are deferred or blocked unless a preview/approval path is
  implemented.
- The open-source package documents how to run with HubSpot first and Salesforce
  as an optional provider.

### 10.5 Fourth Milestone: Microsoft 365 Parity

Scope:

- Add Microsoft 365 auth and read capabilities for Outlook mail/calendar,
  OneDrive/SharePoint files, and Excel/Word reads.
- Add Teams read exploration only if Microsoft Graph permissions and UX are clear.
- Port the Google Workspace playbook to Microsoft 365.

Acceptance criteria:

- The same playbook pattern can run on Google Workspace or Microsoft 365 with
  provider-specific setup and shared artifact contracts.
- Microsoft writes are deferred until read flows are reliable and reviewed.

### 10.6 Fifth Milestone: MCP Bridge Beta

Scope:

- Register local MCP servers as managed, disabled-by-default plugins.
- Map selected MCP tools to canonical read capabilities.
- Block unmapped and write-capable MCP tools by default.
- Validate MCP-backed read-only playbooks with Postgres or GitHub before any
  external writes are allowed.

Acceptance criteria:

- Users can see exactly which MCP server and tool a playbook wants to use.
- A playbook cannot call an unmapped MCP tool.
- MCP run logs include capability ids and output references.

## 11. User Experience Requirements

- Settings must group integrations by business surface: Workspace, Communication,
  CRM, Support, Projects, Finance, Data, Browser/MCP.
- Each connector card must show state: Not connected, Connected, Needs setup,
  Needs repair, Limited, Read-only, or Disabled.
- Playbook preflight must explain required and optional capabilities in business
  language.
- Run screens must show evidence sources, draft outputs, review actions, and
  external write previews before approval.
- Imported playbooks must show publisher, version, capability request, required
  credentials, validation result, sample outputs, and security notes.
- Business users should never need to understand raw capability ids, but authors
  and reviewers should be able to inspect them.

## 12. Security And Governance Requirements

- Bind local transport to secure local channels and keep existing bearer token,
  host/origin, CORS, and CSP constraints.
- Store connector credentials in OS-secure storage.
- Default new connectors to read-only until preview/approval/idempotency behavior
  is implemented and tested.
- Treat direct sends, record mutations, payment/accounting writes, support ticket
  updates, CRM updates, and project-management updates as external writes.
- Every external write must have a preview, an idempotency key, an approval id,
  and an audit event.
- Playbooks must not smuggle business logic into UI code. UI remains declarative
  and rendered by Tessera.
- External packages cannot include standalone graph runners, dependency lockfiles,
  `bin` entrypoints, or package-local runtime copies.

## 13. Success Metrics

### Activation Metrics

- New user can import and run one production-grade playbook in under 10 minutes
  after connector setup.
- At least 80% of beta playbook runs reach completed or review-needed state
  without sidecar/UI errors.
- At least two connectors are connected by 50% of active beta users.

### Playbook Metrics

- Six production-grade open-source playbooks published.
- Every published playbook has CI, fixtures, validation evidence, sample outputs,
  and an importable release archive.
- At least three playbooks exercise a live connector read capability.
- At least two playbooks exercise an approved external draft/write effect.

### Connector Metrics

- P0 connector setup success rate is tracked by provider and error class.
- Required capability preflight catches missing credentials before run start.
- No external write executes without preview and approval.

## 14. Out Of Scope For This PRD

- A public marketplace with ratings, payments, publishing workflows, or remote
  install.
- Arbitrary workflow-supplied executable UI code.
- Direct, unattended external writes such as sending email, posting Slack
  messages, updating CRM records, or moving money.
- General-purpose Zapier-like connector count expansion.
- Enterprise SSO, centralized admin policy, and organization-wide audit export.
- Full background scheduling or cron-style autonomous operations.
- A built-in CRM, ERP, helpdesk, finance, or project-management product surface.

## 15. Decision Record

Decision: Build next around a governed Business Connector Pack and a public
production-grade playbook portfolio.

Drivers:

- Business users judge usefulness by whether Tessera can safely operate across the
  systems they already use.
- The repo already has playbook runtime, package, validation, and connector
  primitives, so the next bottleneck is adoption packaging.
- External market signals strongly favor Google/Microsoft workspace apps, Slack,
  CRM, support, project, finance, data, and MCP/plugin ecosystems.

Alternatives considered:

- Build a broad marketplace first. Rejected because the runtime needs credible
  connector-backed packages and validation evidence before a marketplace matters.
- Build hundreds of connectors first. Rejected because Tessera should win on
  governed playbooks, not raw connector count.
- Keep third-party connectors deferred until all identity/memory work is complete.
  Rejected because business-user adoption requires real context connectors, while
  governance can be preserved by staging read-only capabilities first and gating
  writes.

Consequences:

- Connector work must be tied to named playbooks and acceptance criteria.
- Public playbooks become product surface and must be maintained like production
  examples.
- Capability taxonomy and integration settings become near-term product
  foundations.

Follow-ups:

- Create implementation plans for Connector Substrate Hardening, Google Workspace
  GA Playbook Wedge, Slack plus CRM Read Pack, Microsoft 365 Parity, and MCP
  Bridge Beta.
- Decide which two playbooks become the first public production-grade releases.
