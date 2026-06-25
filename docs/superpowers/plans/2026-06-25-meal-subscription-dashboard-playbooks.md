# Meal Subscription Dashboard Playbooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tessera dashboard output to the existing `ops.daily-delivery-summary` playbook and create a new `meals.tomorrow-orders` playbook showing tomorrow's delivery roster.

**Architecture:** Both playbooks read Google Sheets via `integration.drive.files.read` and render a three-section dashboard (metrics bar, roster table, exceptions list). The existing `analyzeDeliveries` function in `domain.ts` already accepts an optional `today` parameter — `meals.tomorrow-orders` uses this to compute tomorrow's date. Dashboard bindings use dot-path notation into the `reportData` artifact.

**Tech Stack:** Bun workspaces, TypeScript, `bun:test`, Tessera playbook graph SDK (`definePlaybook` from `@tessera/plugin-sdk`)

## Global Constraints

- All scripts must be TypeScript (`.ts`). No `.js`, `.py`, or other script types.
- Package contract: no cross-package imports. Each package must be self-contained.
- No `bin` entrypoints, no lockfiles, no `dependency` fields in package.json.
- Run `playbook validate` (Tessera CLI) to confirm zero errors before each commit.
- Test runner: `bun test <path>` from the package root.
- Dashboard binding paths use dot-notation into the artifact id, e.g. `reportData.stats.totalDeliveries`.
- Table column `key` values use dot-notation for nested fields, e.g. `meals.breakfast`.

---

## File Map

### Deliverable 1 — Extend `ops.daily-delivery-summary`

| Action | Path | Responsibility |
|---|---|---|
| **Modify** | `playbook.ts` | Add `dashboard` entry to `metadata.outputs` |
| **Create** | `layouts/dashboard.json` | Three-section dashboard layout bound to `reportData` |

### Deliverable 2 — New `meals.tomorrow-orders`

| Action | Path | Responsibility |
|---|---|---|
| **Create** | `meals.tomorrow-orders/manifest.json` | Package identity |
| **Create** | `meals.tomorrow-orders/playbook.ts` | Full graph: 5 fetch nodes → analyze → completed |
| **Create** | `meals.tomorrow-orders/layouts/dashboard.json` | Dashboard layout (same shape as Deliverable 1) |
| **Copy** | `meals.tomorrow-orders/schemas/sheet-rows.schema.json` | Raw sheet rows shape |
| **Copy** | `meals.tomorrow-orders/schemas/report-data.schema.json` | Analysis output shape |
| **Copy** | `meals.tomorrow-orders/scripts/domain.ts` | Shared types and utilities |
| **Create** | `meals.tomorrow-orders/scripts/analyze-tomorrow.ts` | Calls `analyzeDeliveries` with tomorrow's ISO date |
| **Create** | `meals.tomorrow-orders/tests/analyze-tomorrow.test.ts` | Verifies tomorrow date offset and correct day name |

---

## Task 1: Add dashboard output to `ops.daily-delivery-summary`

**Working directory:** `/Users/utpal/Code/playbooks/ops.daily-delivery-summary`

**Files:**
- Modify: `playbook.ts`
- Create: `layouts/dashboard.json`

**Interfaces:**
- Produces: dashboard output bound to `reportData` artifact (produced by the existing `analyzeDeliveries` node)

- [ ] **Step 1: Add dashboard entry to `metadata.outputs` in `playbook.ts`**

Open `playbook.ts`. The `metadata.outputs` array currently reads:

```ts
outputs: [
  { kind: "dailySummary", label: "Daily ops summary" },
],
```

Replace it with:

```ts
outputs: [
  { kind: "dailySummary", label: "Daily ops summary" },
  { kind: "dashboard", label: "Today's delivery roster", layout: "layouts/dashboard.json" },
],
```

- [ ] **Step 2: Create `layouts/dashboard.json`**

Create the file `layouts/dashboard.json` with this exact content:

```json
{
  "refreshLabel": "Re-run for today",
  "sections": [
    {
      "type": "metrics",
      "title": "Today's stats",
      "items": [
        { "label": "Deliveries", "binding": "reportData.stats.totalDeliveries" },
        { "label": "Breakfast",  "binding": "reportData.stats.breakfastCount" },
        { "label": "Lunch",      "binding": "reportData.stats.lunchCount" },
        { "label": "Dinner",     "binding": "reportData.stats.dinnerCount" },
        { "label": "Paused",     "binding": "reportData.stats.pausedToday" }
      ]
    },
    {
      "type": "table",
      "title": "Delivery roster",
      "binding": "reportData.roster",
      "columns": [
        { "key": "customerName",    "label": "Customer" },
        { "key": "city",            "label": "City" },
        { "key": "meals.breakfast", "label": "Breakfast" },
        { "key": "meals.lunch",     "label": "Lunch" },
        { "key": "meals.dinner",    "label": "Dinner" },
        { "key": "dietaryNotes",    "label": "Dietary notes" }
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

- [ ] **Step 3: Verify the existing tests still pass**

```bash
bun test tests/analyze-deliveries.test.ts
```

Expected output: all 6 tests pass, no failures.

- [ ] **Step 4: Validate the package**

```bash
playbook validate .
```

Expected: `✓ No errors` (zero errors, zero warnings or any accepted warnings already present).

- [ ] **Step 5: Commit**

```bash
git add playbook.ts layouts/dashboard.json
git commit -m "feat(ops.daily-delivery-summary): add dashboard output with roster and stats"
```

---

## Task 2: Scaffold `meals.tomorrow-orders` package

**Working directory:** `/Users/utpal/Code/playbooks`

**Files:**
- Create: `meals.tomorrow-orders/manifest.json`
- Create: `meals.tomorrow-orders/schemas/sheet-rows.schema.json`
- Create: `meals.tomorrow-orders/schemas/report-data.schema.json`
- Create: `meals.tomorrow-orders/scripts/domain.ts`

**Interfaces:**
- Produces: package skeleton consumed by Tasks 3 and 4

- [ ] **Step 1: Create the package directory structure**

```bash
mkdir -p meals.tomorrow-orders/schemas
mkdir -p meals.tomorrow-orders/scripts
mkdir -p meals.tomorrow-orders/layouts
mkdir -p meals.tomorrow-orders/tests
```

- [ ] **Step 2: Create `meals.tomorrow-orders/manifest.json`**

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

- [ ] **Step 3: Copy `schemas/sheet-rows.schema.json` from the sibling package**

Copy verbatim from `ops.daily-delivery-summary/schemas/sheet-rows.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Drive Sheet Rows",
  "type": "object",
  "required": ["file"],
  "properties": {
    "file": {
      "type": "object",
      "required": ["rows"],
      "properties": {
        "rows": {
          "type": "array",
          "items": {
            "type": "array",
            "items": {
              "oneOf": [
                { "type": "string" },
                { "type": "number" },
                { "type": "boolean" },
                { "type": "null" }
              ]
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Copy `schemas/report-data.schema.json` from the sibling package**

Copy verbatim from `ops.daily-delivery-summary/schemas/report-data.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Report Data",
  "type": "object",
  "required": ["date", "dayOfWeek", "roster", "stats", "exceptions"],
  "additionalProperties": false,
  "properties": {
    "date": { "type": "string", "minLength": 1 },
    "dayOfWeek": { "type": "string", "minLength": 1 },
    "roster": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["subscriptionId", "customerName", "phone", "address", "city", "dietaryNotes", "meals"],
        "additionalProperties": false,
        "properties": {
          "subscriptionId": { "type": "string" },
          "customerName": { "type": "string" },
          "phone": { "type": "string" },
          "address": { "type": "string" },
          "city": { "type": "string" },
          "dietaryNotes": { "type": "string" },
          "meals": {
            "type": "object",
            "required": ["breakfast", "lunch", "dinner"],
            "additionalProperties": false,
            "properties": {
              "breakfast": { "type": ["string", "null"] },
              "lunch": { "type": ["string", "null"] },
              "dinner": { "type": ["string", "null"] }
            }
          }
        }
      }
    },
    "stats": {
      "type": "object",
      "required": ["totalDeliveries", "breakfastCount", "lunchCount", "dinnerCount", "pausedToday"],
      "additionalProperties": false,
      "properties": {
        "totalDeliveries": { "type": "number" },
        "breakfastCount": { "type": "number" },
        "lunchCount": { "type": "number" },
        "dinnerCount": { "type": "number" },
        "pausedToday": { "type": "number" }
      }
    },
    "exceptions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["kind", "subscriptionId", "customerName", "detail"],
        "additionalProperties": false,
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["pause_resuming_today", "missing_meal_pref", "expiring_within_7_days", "no_deliveries_today"]
          },
          "subscriptionId": { "type": ["string", "null"] },
          "customerName": { "type": ["string", "null"] },
          "detail": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Copy `scripts/domain.ts` from the sibling package**

Copy verbatim from `ops.daily-delivery-summary/scripts/domain.ts`. Do not modify it. It exports types and pure utilities: `SheetRows`, `RosterEntry`, `ExceptionEntry`, `ReportData`, `isRecord`, `asString`, `nodeInputs`, `todayIso`, `parseSheetDate`, `parseRows`.

- [ ] **Step 6: Copy `scripts/analyze-deliveries.ts` from the sibling package**

Copy verbatim from `ops.daily-delivery-summary/scripts/analyze-deliveries.ts`. Do not modify it. This file exports `analyzeDeliveries` — the function that `analyze-tomorrow.ts` (Task 3) will call. It is copied here rather than imported cross-package because the Tessera package contract forbids cross-package imports.

- [ ] **Step 7: Commit the scaffold**

```bash
cd meals.tomorrow-orders
git add manifest.json schemas/ scripts/domain.ts scripts/analyze-deliveries.ts
git commit -m "feat(meals.tomorrow-orders): scaffold package with schemas and domain scripts"
```

---

## Task 3: Implement `analyze-tomorrow.ts` with tests

**Working directory:** `/Users/utpal/Code/playbooks/meals.tomorrow-orders`

**Files:**
- Create: `scripts/analyze-tomorrow.ts`
- Create: `tests/analyze-tomorrow.test.ts`

**Interfaces:**
- Consumes: `analyzeDeliveries(input: { ..., today?: string }): ReportData` from `./analyze-deliveries`
- Consumes: `nodeInputs(context: unknown): Record<string, unknown>` from `./domain`
- Consumes: `SheetRows` type from `./domain`
- Produces: default export `run(context: unknown): ReportData` — Tessera script node entry point

- [ ] **Step 1: Write the failing test**

Create `tests/analyze-tomorrow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { analyzeDeliveries } from "../scripts/analyze-deliveries";
import type { SheetRows } from "../scripts/domain";

// Minimal fixture — just enough to verify the date offset and day resolution.
const CUSTOMER_HEADERS = [
  "Customer ID", "Full Name", "Phone", "Email", "Address", "City", "Join Date", "Notes",
];
const SUB_HEADERS = [
  "Subscription ID", "Customer ID", "Customer Name", "Plan Type",
  "Start Date", "End Date", "Total Pause Days", "Effective End Date", "Status", "Notes",
];
const PAUSE_HEADERS = [
  "Subscription ID", "Customer Name", "Pause Start", "Pause End", "Pause Days", "Reason", "Resumed?",
];
const SCHEDULE_HEADERS = [
  "Subscription ID", "Customer Name", "Status",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "Delivery Days/Wk", "Next Delivery Date",
];
const MEAL_HEADERS = [
  "Subscription ID", "Customer Name", "Dietary Notes",
  "Mon — Breakfast", "Mon — Lunch", "Mon — Dinner",
  "Tue — Breakfast", "Tue — Lunch", "Tue — Dinner",
  "Wed — Breakfast", "Wed — Lunch", "Wed — Dinner",
  "Thu — Breakfast", "Thu — Lunch", "Thu — Dinner",
  "Fri — Breakfast", "Fri — Lunch", "Fri — Dinner",
  "Sat — Breakfast", "Sat — Lunch", "Sat — Dinner",
  "Sun — Breakfast", "Sun — Lunch", "Sun — Dinner",
];

function rows(headers: string[], ...data: string[][]): SheetRows {
  return { file: { rows: [headers, ...data] } };
}

const emptyFixture = {
  customersRaw: rows(CUSTOMER_HEADERS),
  subscriptionsRaw: rows(SUB_HEADERS),
  pauseLogRaw: rows(PAUSE_HEADERS),
  deliveryScheduleRaw: rows(SCHEDULE_HEADERS),
  mealPrefsRaw: rows(MEAL_HEADERS),
};

// Verifies tomorrowIso logic: passing "today" as Monday should make the
// analysis run for Tuesday.
function tomorrowOf(todayIso: string): string {
  const d = new Date(todayIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("tomorrowIso offset", () => {
  test("one day ahead of a Monday is Tuesday", () => {
    // 2026-06-22 is Monday, tomorrow is 2026-06-23 (Tuesday)
    const tomorrow = tomorrowOf("2026-06-22");
    expect(tomorrow).toBe("2026-06-23");
    const result = analyzeDeliveries({ ...emptyFixture, today: tomorrow });
    expect(result.dayOfWeek).toBe("Tuesday");
  });

  test("one day ahead of a Saturday is Sunday", () => {
    // 2026-06-27 is Saturday, tomorrow is 2026-06-28 (Sunday)
    const tomorrow = tomorrowOf("2026-06-27");
    expect(tomorrow).toBe("2026-06-28");
    const result = analyzeDeliveries({ ...emptyFixture, today: tomorrow });
    expect(result.dayOfWeek).toBe("Sunday");
  });

  test("one day ahead of Sunday is Monday", () => {
    // 2026-06-28 is Sunday, tomorrow is 2026-06-29 (Monday)
    const tomorrow = tomorrowOf("2026-06-28");
    expect(tomorrow).toBe("2026-06-29");
    const result = analyzeDeliveries({ ...emptyFixture, today: tomorrow });
    expect(result.dayOfWeek).toBe("Monday");
  });

  test("result date field equals tomorrow's ISO string", () => {
    const today = "2026-06-22";
    const tomorrow = tomorrowOf(today);
    const result = analyzeDeliveries({ ...emptyFixture, today: tomorrow });
    expect(result.date).toBe(tomorrow);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (these tests use `analyzeDeliveries` directly)**

```bash
bun test tests/analyze-tomorrow.test.ts
```

Expected: all 4 tests PASS (they test `tomorrowOf` + `analyzeDeliveries` directly, not the `run` export which doesn't exist yet).

- [ ] **Step 3: Create `scripts/analyze-tomorrow.ts`**

```ts
import { analyzeDeliveries } from "./analyze-deliveries";
import { nodeInputs, type SheetRows } from "./domain";

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

- [ ] **Step 4: Re-run tests to confirm still passing**

```bash
bun test tests/analyze-tomorrow.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/analyze-tomorrow.ts tests/analyze-tomorrow.test.ts
git commit -m "feat(meals.tomorrow-orders): add analyze-tomorrow script with date-offset tests"
```

---

## Task 4: Write `playbook.ts` and dashboard layout for `meals.tomorrow-orders`

**Working directory:** `/Users/utpal/Code/playbooks/meals.tomorrow-orders`

**Files:**
- Create: `playbook.ts`
- Create: `layouts/dashboard.json`

**Interfaces:**
- Consumes: `analyze-tomorrow.ts` default export `run(context): ReportData` (Task 3)
- Consumes: `schemas/sheet-rows.schema.json`, `schemas/report-data.schema.json` (Task 2)
- Produces: Tessera playbook with `dashboard` output and `reportData` artifact

- [ ] **Step 1: Create `playbook.ts`**

```ts
import { definePlaybook } from "@tessera/plugin-sdk";

export default definePlaybook({
  schemaVersion: 1,
  id: "meals.tomorrow-orders",
  version: "1.0.0",
  name: "Tomorrow's Delivery Orders",
  description:
    "Dashboard showing tomorrow's meal delivery roster from the subscription Google Sheet.",
  metadata: {
    category: "operations",
    businessUseCase: "Preview tomorrow's delivery schedule before the day starts",
    requiredCapabilities: ["integration.drive.files.read"],
    optionalCapabilities: [],
    outputs: [
      { kind: "dashboard", label: "Tomorrow's delivery roster", layout: "layouts/dashboard.json" },
    ],
    phases: ["Fetch", "Analyze"],
  },
  inputs: {
    spreadsheetId: {
      type: "string",
      required: true,
      label: "Google Sheet ID",
      description: "The spreadsheet ID from the URL (the long string between /d/ and /edit).",
      placeholder: "1QpUmKDxtzqvMLG5BtbcCsE8Y-Wx1YfIxK4-4zxL-sT0",
      order: 1,
      group: "Sheet",
      ui: { control: "text" },
    },
  },
  artifacts: {
    customersRaw:        { schema: "schemas/sheet-rows.schema.json" },
    subscriptionsRaw:    { schema: "schemas/sheet-rows.schema.json" },
    pauseLogRaw:         { schema: "schemas/sheet-rows.schema.json" },
    deliveryScheduleRaw: { schema: "schemas/sheet-rows.schema.json" },
    mealPrefsRaw:        { schema: "schemas/sheet-rows.schema.json" },
    reportData:          { schema: "schemas/report-data.schema.json" },
  },
  capabilities: ["integration.drive.files.read"],
  limits: {
    maxTotalAgentSteps: 0,
    maxExternalToolCalls: 5,
    maxRuntimeMs: 120000,
  },
  start: "fetchCustomers",
  nodes: [
    {
      id: "fetchCustomers",
      label: "Read Customers sheet",
      kind: "tool",
      capability: "integration.drive.files.read",
      args: {
        command: "drive",
        subcommand: "read",
        args: ["{{inputs.spreadsheetId}}", "--format", "json", "--sheet", "Customers", "--range", "A1:Z200"],
      },
      outputArtifact: "customersRaw",
      onSuccess: "fetchSubscriptions",
    },
    {
      id: "fetchSubscriptions",
      label: "Read Subscriptions sheet",
      kind: "tool",
      capability: "integration.drive.files.read",
      args: {
        command: "drive",
        subcommand: "read",
        args: ["{{inputs.spreadsheetId}}", "--format", "json", "--sheet", "Subscriptions", "--range", "A1:Z200"],
      },
      outputArtifact: "subscriptionsRaw",
      onSuccess: "fetchPauseLog",
    },
    {
      id: "fetchPauseLog",
      label: "Read Pause Log sheet",
      kind: "tool",
      capability: "integration.drive.files.read",
      args: {
        command: "drive",
        subcommand: "read",
        args: ["{{inputs.spreadsheetId}}", "--format", "json", "--sheet", "Pause Log", "--range", "A1:Z200"],
      },
      outputArtifact: "pauseLogRaw",
      onSuccess: "fetchDeliverySchedule",
    },
    {
      id: "fetchDeliverySchedule",
      label: "Read Delivery Schedule sheet",
      kind: "tool",
      capability: "integration.drive.files.read",
      args: {
        command: "drive",
        subcommand: "read",
        args: ["{{inputs.spreadsheetId}}", "--format", "json", "--sheet", "Delivery Schedule", "--range", "A1:Z200"],
      },
      outputArtifact: "deliveryScheduleRaw",
      onSuccess: "fetchMealPrefs",
    },
    {
      id: "fetchMealPrefs",
      label: "Read Meal Preferences sheet",
      kind: "tool",
      capability: "integration.drive.files.read",
      args: {
        command: "drive",
        subcommand: "read",
        args: ["{{inputs.spreadsheetId}}", "--format", "json", "--sheet", "Meal Preferences", "--range", "A1:Z200"],
      },
      outputArtifact: "mealPrefsRaw",
      onSuccess: "analyzeTomorrow",
    },
    {
      id: "analyzeTomorrow",
      label: "Analyze tomorrow's deliveries",
      kind: "script",
      run: "scripts/analyze-tomorrow.ts",
      inputs: {
        customersRaw:        { artifact: "customersRaw" },
        subscriptionsRaw:    { artifact: "subscriptionsRaw" },
        pauseLogRaw:         { artifact: "pauseLogRaw" },
        deliveryScheduleRaw: { artifact: "deliveryScheduleRaw" },
        mealPrefsRaw:        { artifact: "mealPrefsRaw" },
      },
      outputArtifact: "reportData",
      onSuccess: "completed",
    },
  ],
});
```

- [ ] **Step 2: Create `layouts/dashboard.json`**

```json
{
  "refreshLabel": "Re-run for tomorrow",
  "sections": [
    {
      "type": "metrics",
      "title": "Tomorrow's stats",
      "items": [
        { "label": "Deliveries", "binding": "reportData.stats.totalDeliveries" },
        { "label": "Breakfast",  "binding": "reportData.stats.breakfastCount" },
        { "label": "Lunch",      "binding": "reportData.stats.lunchCount" },
        { "label": "Dinner",     "binding": "reportData.stats.dinnerCount" },
        { "label": "Paused",     "binding": "reportData.stats.pausedToday" }
      ]
    },
    {
      "type": "table",
      "title": "Tomorrow's roster",
      "binding": "reportData.roster",
      "columns": [
        { "key": "customerName",    "label": "Customer" },
        { "key": "city",            "label": "City" },
        { "key": "meals.breakfast", "label": "Breakfast" },
        { "key": "meals.lunch",     "label": "Lunch" },
        { "key": "meals.dinner",    "label": "Dinner" },
        { "key": "dietaryNotes",    "label": "Dietary notes" }
      ]
    },
    {
      "type": "list",
      "title": "Exceptions",
      "binding": "reportData.exceptions",
      "emptyLabel": "No exceptions for tomorrow"
    }
  ]
}
```

- [ ] **Step 3: Validate the new package**

```bash
playbook validate .
```

Expected: `✓ No errors`.

- [ ] **Step 4: Commit**

```bash
git add playbook.ts layouts/dashboard.json
git commit -m "feat(meals.tomorrow-orders): add playbook graph and dashboard layout"
```

---

## Task 5: Final validation of both packages

**Working directory:** `/Users/utpal/Code/playbooks`

- [ ] **Step 1: Run all tests in `ops.daily-delivery-summary`**

```bash
cd ops.daily-delivery-summary && bun test
```

Expected: all 6 tests in `tests/analyze-deliveries.test.ts` pass.

- [ ] **Step 2: Run all tests in `meals.tomorrow-orders`**

```bash
cd ../meals.tomorrow-orders && bun test
```

Expected: all 4 tests in `tests/analyze-tomorrow.test.ts` pass.

- [ ] **Step 3: Validate `ops.daily-delivery-summary`**

```bash
cd ../ops.daily-delivery-summary && playbook validate .
```

Expected: `✓ No errors`.

- [ ] **Step 4: Validate `meals.tomorrow-orders`**

```bash
cd ../meals.tomorrow-orders && playbook validate .
```

Expected: `✓ No errors`.

- [ ] **Step 5: Final commit (if any loose files remain)**

```bash
cd ..
git status
# If anything is unstaged, add and commit it:
git add -A
git commit -m "chore: finalize meal subscription dashboard playbooks"
```
