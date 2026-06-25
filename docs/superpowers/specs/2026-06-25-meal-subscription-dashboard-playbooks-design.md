# Meal Subscription Dashboard Playbooks — Design Spec

**Date:** 2026-06-25
**Status:** Approved
**Scope:** Two playbooks — extend `ops.daily-delivery-summary` with a dashboard output, and create `meals.tomorrow-orders`

---

## Overview

The meal subscription business needs a daily read-only ops view in Tessera. Google Sheets remains the write layer (customers, subscriptions, meal plans are edited directly in the sheet). Tessera is the view layer only.

Two deliverables:

1. **`ops.daily-delivery-summary` — dashboard output added.** The existing playbook already produces a Gmail draft. We add a Tessera dashboard alongside it with no changes to the graph nodes.
2. **`meals.tomorrow-orders` — new playbook.** Dashboard showing tomorrow's delivery roster. No email draft.

`meals.week-view` is deferred.

---

## Google Sheet Source

**Spreadsheet ID:** `1QpUmKDxtzqvMLG5BtbcCsE8Y-Wx1YfIxK4-4zxL-sT0`

Five tabs consumed by both playbooks:

| Tab | Key columns |
|---|---|
| Customers | Customer ID, Full Name, Phone, Address, City, Notes |
| Subscriptions | Subscription ID, Customer ID, Customer Name, Status, Effective End Date |
| Pause Log | Subscription ID, Customer Name, Pause End |
| Delivery Schedule | Subscription ID, Monday–Sunday (Y/N) |
| Meal Preferences | Subscription ID, Dietary Notes, `{Day} — Breakfast/Lunch/Dinner` |

---

## Deliverable 1: Extend `ops.daily-delivery-summary`

**Location:** `/Users/utpal/Code/playbooks/ops.daily-delivery-summary/`

### What changes

No graph changes. Two additions only:

**A. `playbook.ts` — add dashboard to `metadata.outputs`**

```ts
metadata: {
  outputs: [
    { kind: "dailySummary", label: "Daily ops summary" },
    { kind: "dashboard", label: "Today's delivery roster", layout: "layouts/dashboard.json" },
  ],
}
```

**B. New file `layouts/dashboard.json`**

The dashboard binds to the `reportData` artifact produced by `analyzeDeliveries`. Three sections:

```json
{
  "refreshLabel": "Re-run for today",
  "sections": [
    {
      "type": "metrics",
      "title": "Today's stats",
      "items": [
        { "label": "Deliveries", "binding": "reportData.stats.totalDeliveries" },
        { "label": "Breakfast", "binding": "reportData.stats.breakfastCount" },
        { "label": "Lunch",     "binding": "reportData.stats.lunchCount" },
        { "label": "Dinner",    "binding": "reportData.stats.dinnerCount" },
        { "label": "Paused",    "binding": "reportData.stats.pausedToday" }
      ]
    },
    {
      "type": "table",
      "title": "Delivery roster",
      "binding": "reportData.roster",
      "columns": [
        { "key": "customerName",  "label": "Customer" },
        { "key": "city",          "label": "City" },
        { "key": "meals.breakfast", "label": "Breakfast" },
        { "key": "meals.lunch",     "label": "Lunch" },
        { "key": "meals.dinner",    "label": "Dinner" },
        { "key": "dietaryNotes",  "label": "Dietary notes" }
      ]
    },
    {
      "type": "list",
      "title": "Exceptions",
      "binding": "reportData.exceptions",
      "emptyLabel": "No exceptions today"
    }
  ]
}
```

### What stays the same

All graph nodes (fetchCustomers → fetchSubscriptions → fetchPauseLog → fetchDeliverySchedule → fetchMealPrefs → analyzeDeliveries → formatSummary → buildDraftRequest → createEmailDraft) are unchanged. The Gmail draft approval gate and idempotency key are unchanged.

---

## Deliverable 2: `meals.tomorrow-orders`

**Location:** `/Users/utpal/Code/playbooks/meals.tomorrow-orders/`

### Purpose

Shows tomorrow's delivery roster as a Tessera dashboard. No email output.

### Package structure

```
meals.tomorrow-orders/
├── manifest.json
├── playbook.ts
├── layouts/
│   └── dashboard.json
├── schemas/
│   ├── sheet-rows.schema.json      (copy from ops.daily-delivery-summary)
│   └── report-data.schema.json     (copy from ops.daily-delivery-summary)
└── scripts/
    ├── domain.ts                   (copy from ops.daily-delivery-summary)
    └── analyze-tomorrow.ts         (new — wraps analyzeDeliveries with tomorrow's date)
```

### `manifest.json`

```json
{
  "schemaVersion": 1,
  "id": "meals.tomorrow-orders",
  "version": "1.0.0",
  "name": "Tomorrow's Delivery Orders",
  "description": "Dashboard showing tomorrow's meal delivery roster from the subscription Google Sheet.",
  "entrypoint": "playbook.ts"
}
```

### Graph

Identical 5-node fetch chain as `ops.daily-delivery-summary`, then a single `analyzeDeliveries` script node, then `completed`. No agent node, no email node.

```
fetchCustomers → fetchSubscriptions → fetchPauseLog → fetchDeliverySchedule → fetchMealPrefs → analyzeTomorrow → completed
```

Capabilities: `integration.drive.files.read` only.

### `scripts/analyze-tomorrow.ts`

```ts
import { analyzeDeliveries, nodeInputs, type SheetRows } from "./domain";

function tomorrowIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default function run(context: unknown) {
  const inputs = nodeInputs(context);
  return analyzeDeliveries({
    customersRaw:        inputs.customersRaw as SheetRows,
    subscriptionsRaw:    inputs.subscriptionsRaw as SheetRows,
    pauseLogRaw:         inputs.pauseLogRaw as SheetRows,
    deliveryScheduleRaw: inputs.deliveryScheduleRaw as SheetRows,
    mealPrefsRaw:        inputs.mealPrefsRaw as SheetRows,
    today: tomorrowIso(),
  });
}
```

### `layouts/dashboard.json`

Same three-section layout as the today dashboard, with updated labels:

- `refreshLabel`: `"Re-run for tomorrow"`
- Metrics title: `"Tomorrow's stats"`
- Table title: `"Tomorrow's roster"`
- Exceptions `emptyLabel`: `"No exceptions for tomorrow"`

### Playbook inputs

Same as `ops.daily-delivery-summary` minus `recipientEmail`:

| Input | Type | Control | Required |
|---|---|---|---|
| spreadsheetId | string | text | yes |

---

## Code Sharing

`domain.ts`, `sheet-rows.schema.json`, and `report-data.schema.json` are copied into `meals.tomorrow-orders/`. The Tessera package contract prohibits cross-package imports. At ~92 lines, `domain.ts` is small enough that duplication is acceptable. If the type definitions need to change, both packages are updated together.

---

## What Is Not Extended

The `analyzeDeliveries` function in `domain.ts` is not modified. It already accepts `today?: string` — this is the hook used by `meals.tomorrow-orders` to compute tomorrow's date. No changes to the core analysis logic.

---

## Out of Scope

- `meals.week-view` — deferred
- Any write-back to Google Sheets — the Sheet remains the write layer
- Customer, subscription, or meal plan CRUD in Tessera
