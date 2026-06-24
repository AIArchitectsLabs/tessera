# Daily Delivery Ops Playbook — Design Spec

**Date:** 2026-06-24  
**Status:** Approved  
**Location:** `/Users/utpal/Code/playbooks/ops.daily-delivery-summary/`

---

## Overview

A Tessera playbook that reads a meal-subscription Google Sheet, generates a structured daily ops report as a Tessera artifact, and creates a Gmail draft ready to send. Triggered manually from the Tessera UI each morning.

The playbook is an **external playbook** living in `/Users/utpal/Code/playbooks/` alongside the existing `procurement.supplier-rfq-followup`, `seo-geo-blog-reference-playbook`, and `supply-chain-risk-playbook` packages. It follows the same `manifest.json` + `playbook.ts` + subdirectory convention.

---

## Google Sheet Source

**File:** `https://docs.google.com/spreadsheets/d/1QpUmKDxtzqvMLG5BtbcCsE8Y-Wx1YfIxK4-4zxL-sT0`

The spreadsheet has seven tabs. The playbook reads five source tabs directly (not the formula-computed Daily Orders View):

| Tab | Columns consumed |
|---|---|
| Customers | `Customer ID`, `Full Name`, `Phone`, `Address`, `City`, `Notes` |
| Subscriptions | `Subscription ID`, `Customer ID`, `Status`, `Effective End Date` |
| Pause Log | `Subscription ID`, `Pause Start`, `Pause End`, `Resumed?` |
| Delivery Schedule | `Subscription ID`, `Monday`–`Sunday` (Y/N) |
| Meal Preferences | `Subscription ID`, `Dietary Notes`, `{Day} — Breakfast`, `{Day} — Lunch`, `{Day} — Dinner` |

Reading source tabs directly (not the Daily Orders formula view) makes the playbook independent of Google Sheets formula evaluation.

---

## Graph Architecture

Four nodes in a linear pipeline:

```
[Fetch] → rawDeliveries → [Analyze] → reportData → [Format] → dailySummary → [Email Draft]
```

### Node 1 — Fetch

- **Type:** connector node
- **Capability:** `integration.drive.files.read`
- **Input:** `spreadsheetUrl` (from playbook input)
- **Output artifact:** `rawDeliveries`
- **Behaviour:** Reads the entire spreadsheet in one Drive API call. The Google connector's `readDriveFile` already handles `.google-apps.spreadsheet` MIME type and returns normalised tab data. No filtering or transformation here.

### Node 2 — Analyze

- **Type:** script node (`scripts/analyze-deliveries.ts`)
- **Input artifact:** `rawDeliveries`
- **Output artifact:** `reportData` (schema-validated against `schemas/report-data.schema.json`)
- **Logic:**
  1. Resolve today's date and day name (e.g. "Tuesday")
  2. Filter Subscriptions to `Status = Active`
  3. For each active subscription, check Delivery Schedule — does today's day column equal `Y`?
  4. Read today's meals from Meal Preferences: `{Day} — Breakfast`, `{Day} — Lunch`, `{Day} — Dinner`
  5. Join customer contact info from Customers (name, phone, address, city, dietary notes)
  6. Detect exceptions:
     - **`pause_resuming_today`** — Pause Log row where `Pause End = today` and `Resumed? = No`
     - **`missing_meal_pref`** — active subscription scheduled for today with blank meal preference cells
     - **`expiring_within_7_days`** — active subscription whose `Effective End Date` is within 7 calendar days
     - **`no_deliveries_today`** — zero active subscriptions scheduled for today (emitted as a single playbook-wide exception)
  7. Compute stats: total deliveries, breakfast/lunch/dinner counts, paused-today count

### Node 3 — Format

- **Type:** agent node
- **Prompt:** `prompts/format-daily-summary.md`
- **Input artifact:** `reportData`
- **Output artifact:** `dailySummary` (materialized as markdown — the visible Tessera artifact)
- **Behaviour:** Produces the formatted markdown report. Is the only node that uses natural language generation. Formatting rules are in the prompt file.

### Node 4 — Email Draft

- **Type:** effect node
- **Capability:** `integration.mail.drafts.write`
- **Input artifact:** `dailySummary`
- **Behaviour:** Creates a Gmail draft addressed to the user. Subject: `Daily Ops Summary — {dayOfWeek}, {date}`. Body: the `dailySummary` markdown content. User reviews and sends from Gmail.

---

## Playbook Inputs

| Field | Type | Required | Label | Notes |
|---|---|---|---|---|
| `spreadsheetUrl` | string | yes | Google Sheet URL | Paste from browser address bar |

---

## Artifacts

| Name | Type | Materialized | Purpose |
|---|---|---|---|
| `rawDeliveries` | JSON | no | Raw tab data from Drive; internal only |
| `reportData` | JSON | no | Structured analysis output; schema-validated |
| `dailySummary` | markdown | yes | Tessera artifact + Gmail draft body |

---

## `reportData` Schema

```ts
{
  date: string,         // "2026-06-24"
  dayOfWeek: string,    // "Tuesday"
  roster: Array<{
    subscriptionId: string,
    customerName: string,
    phone: string,
    address: string,
    city: string,
    dietaryNotes: string,
    meals: {
      breakfast: string | null,
      lunch: string | null,
      dinner: string | null
    }
  }>,
  stats: {
    totalDeliveries: number,
    breakfastCount: number,
    lunchCount: number,
    dinnerCount: number,
    pausedToday: number
  },
  exceptions: Array<{
    kind: "pause_resuming_today" | "missing_meal_pref" | "expiring_within_7_days" | "no_deliveries_today",
    subscriptionId: string | null,
    customerName: string | null,
    detail: string
  }>
}
```

---

## Report Format (`dailySummary`)

```markdown
# Daily Ops Summary — {dayOfWeek}, {date}

## Today's Deliveries ({count})

| # | Customer | Phone | Address | Breakfast | Lunch | Dinner | Dietary Notes |
|---|----------|-------|---------|-----------|-------|--------|---------------|
| 1 | Priya Sharma | +91 98400 11111 | 12 MG Road, Bengaluru | Idli & Sambar | Roti & Sabzi | Khichdi | Vegetarian |
...

## Summary

- **Total deliveries:** N
- **Breakfast:** N  **Lunch:** N  **Dinner:** N
- **Paused today:** N (name — subId)

## Exceptions ⚠️

- **{subId} / {customerName}** — {detail}
```

- Exceptions section is omitted if empty.
- Roster is replaced with "No deliveries scheduled for today" if `roster` is empty.
- Gmail draft subject: `Daily Ops Summary — {dayOfWeek}, {date}`

---

## Capabilities

```ts
requiredCapabilities: [
  "integration.drive.files.read",
  "integration.mail.drafts.write",
]
```

---

## File Layout

```
/Users/utpal/Code/playbooks/ops.daily-delivery-summary/
  manifest.json
  playbook.ts
  scripts/
    analyze-deliveries.ts
  schemas/
    report-data.schema.json
  prompts/
    format-daily-summary.md
```

---

## Trigger

Manual — run from Tessera UI. No scheduling in v1.

---

## Out of Scope (v1)

- Scheduled / automatic daily trigger
- WhatsApp or SMS notifications
- Writing dispatch status back to the sheet
- Multi-user / team email distribution
- PDF export of the report
