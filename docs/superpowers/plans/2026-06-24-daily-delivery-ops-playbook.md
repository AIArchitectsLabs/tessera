# Daily Delivery Ops Playbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an external Tessera playbook at `/Users/utpal/Code/playbooks/ops.daily-delivery-summary/` that reads a meal-subscription Google Sheet, produces a daily ops report as a Tessera artifact, and creates a Gmail draft.

**Architecture:** Five sequential `tool` nodes read individual sheet tabs via `integration.drive.files.read`. A `script` node analyzes the merged raw data into a typed `reportData` artifact. An `agent` node formats it into a markdown `dailySummary`. A second `script` node wraps the summary into the Gmail draft request shape. A final `effect` node creates the Gmail draft.

**Tech Stack:** Bun (runtime + test runner), TypeScript strict, Tessera playbook graph schema v1, Google Drive `drive read` shell command, `integration.mail.drafts.write` effect.

## Global Constraints

- Playbook root: `/Users/utpal/Code/playbooks/ops.daily-delivery-summary/`
- Tessera repo root: `/Users/utpal/Code/projects/tessera`
- Schema version: `schemaVersion: 1` on manifest and playbook
- Capabilities declared in both `metadata.requiredCapabilities` and top-level `capabilities` array
- Every artifact must have a `schema` pointing to a file in `schemas/`
- `--sheet <name>` and `--range <A1:Z200>` must both be provided together for `drive read` on multi-tab spreadsheets
- Drive tool node args array uses `{{inputs.spreadsheetId}}` template for the file ID (resolved at runtime)
- Test runner: `bun test tests/analyze-deliveries.test.ts` (run from the playbook root)
- All scripts export a `default function run(context: unknown)` entry point that calls `nodeInputs(context)`
- `DriveReadResult` shape is `{ file: { rows: (string|number|boolean|null)[][] } }` for JSON format

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `manifest.json` | Create | Package metadata |
| `playbook.ts` | Create | Full graph definition (9 nodes) |
| `scripts/domain.ts` | Create | Shared types, `parseRows`, `parseSheetDate`, `nodeInputs`, `asString` |
| `scripts/analyze-deliveries.ts` | Create | Reads 5 raw sheet artifacts → `reportData` |
| `scripts/build-draft-request.ts` | Create | Wraps `dailySummary.text` → `gmailDraftRequest` |
| `schemas/sheet-rows.schema.json` | Create | Generic drive-read rows result (reused for 5 raw artifacts) |
| `schemas/report-data.schema.json` | Create | Typed analysis output schema |
| `schemas/daily-summary.schema.json` | Create | `{ text: string }` for Tessera artifact display |
| `schemas/gmail-draft-request.schema.json` | Create | Gmail draft effect payload schema |
| `prompts/format-daily-summary.md` | Create | Agent formatting prompt |
| `tests/analyze-deliveries.test.ts` | Create | Unit tests for analysis logic |

---

## Task 1: Scaffold directory and manifest

**Files:**
- Create: `/Users/utpal/Code/playbooks/ops.daily-delivery-summary/manifest.json`

**Interfaces:**
- Produces: `manifest.json` read by Tessera's playbook package loader

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p /Users/utpal/Code/playbooks/ops.daily-delivery-summary/{scripts,schemas,prompts,tests}
```

- [ ] **Step 2: Write manifest.json**

```json
{
  "schemaVersion": 1,
  "id": "ops.daily-delivery-summary",
  "version": "1.0.0",
  "name": "Daily Delivery Ops Summary",
  "description": "Reads a meal-subscription Google Sheet, produces a daily delivery roster with stats and exceptions as a Tessera artifact, and creates a Gmail draft.",
  "entrypoint": "playbook.ts"
}
```

- [ ] **Step 3: Verify manifest loads in Tessera validator**

```bash
bun run --cwd /Users/utpal/Code/projects/tessera apps/cli/src/index.ts playbook validate /Users/utpal/Code/playbooks/ops.daily-delivery-summary
```

Expected: validation error about missing `playbook.ts` — that confirms the manifest is read correctly. Any JSON parse error means fix the manifest.

- [ ] **Step 4: Commit**

```bash
cd /Users/utpal/Code/playbooks/ops.daily-delivery-summary
git init  # only if not already under the /Users/utpal/Code/playbooks git repo
git add manifest.json
git commit -m "feat: scaffold ops.daily-delivery-summary playbook"
```

---

## Task 2: Write all schemas

**Files:**
- Create: `schemas/sheet-rows.schema.json`
- Create: `schemas/report-data.schema.json`
- Create: `schemas/daily-summary.schema.json`
- Create: `schemas/gmail-draft-request.schema.json`

**Interfaces:**
- Consumed by: `playbook.ts` artifact declarations and agent node `output.schema`
- Produces: runtime validation contracts for all artifacts

- [ ] **Step 1: Write sheet-rows.schema.json** (reused for all 5 raw sheet artifacts)

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

- [ ] **Step 2: Write report-data.schema.json**

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

- [ ] **Step 3: Write daily-summary.schema.json**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Daily Summary",
  "type": "object",
  "required": ["text"],
  "properties": {
    "text": { "type": "string", "minLength": 1 },
    "usage": { "type": "object" }
  }
}
```

- [ ] **Step 4: Write gmail-draft-request.schema.json**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Gmail Draft Request",
  "type": "object",
  "required": ["requests"],
  "additionalProperties": false,
  "properties": {
    "requests": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["command", "subcommand", "to", "subject", "body"],
        "additionalProperties": false,
        "properties": {
          "command": { "const": "mail" },
          "subcommand": { "const": "draft" },
          "to": { "type": "string", "minLength": 1 },
          "subject": { "type": "string", "minLength": 1 },
          "body": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add schemas/
git commit -m "feat: add artifact schemas for daily-delivery-summary playbook"
```

---

## Task 3: Write domain types and helpers

**Files:**
- Create: `scripts/domain.ts`

**Interfaces:**
- Produces (used by Tasks 4 and 5):
  - `type SheetRows` — shape of a DriveReadResult with rows
  - `type RosterEntry`
  - `type ExceptionEntry`
  - `type ReportData`
  - `function parseRows(sheetRows: SheetRows): Record<string, string>[]` — converts 2D rows array to header-keyed objects
  - `function parseSheetDate(value: string): Date | null` — parses "DD-Mon-YYYY"
  - `function nodeInputs(context: unknown): Record<string, unknown>`
  - `function asString(value: unknown, fallback?: string): string`
  - `function isRecord(value: unknown): value is Record<string, unknown>`
  - `function todayIso(): string` — returns "YYYY-MM-DD"

- [ ] **Step 1: Write scripts/domain.ts**

```typescript
export type SheetRows = {
  file: {
    rows: (string | number | boolean | null)[][];
  };
};

export type RosterEntry = {
  subscriptionId: string;
  customerName: string;
  phone: string;
  address: string;
  city: string;
  dietaryNotes: string;
  meals: {
    breakfast: string | null;
    lunch: string | null;
    dinner: string | null;
  };
};

export type ExceptionEntry = {
  kind:
    | "pause_resuming_today"
    | "missing_meal_pref"
    | "expiring_within_7_days"
    | "no_deliveries_today";
  subscriptionId: string | null;
  customerName: string | null;
  detail: string;
};

export type ReportData = {
  date: string;
  dayOfWeek: string;
  roster: RosterEntry[];
  stats: {
    totalDeliveries: number;
    breakfastCount: number;
    lunchCount: number;
    dinnerCount: number;
    pausedToday: number;
  };
  exceptions: ExceptionEntry[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value).trim() || fallback;
}

export function nodeInputs(context: unknown): Record<string, unknown> {
  if (!isRecord(context)) return {};
  const node = context.node;
  if (isRecord(node) && isRecord(node.inputs)) return node.inputs;
  if (isRecord(context.input)) return context.input;
  return context;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Parses "DD-Mon-YYYY" (e.g. "15-Jan-2024") into a UTC Date.
export function parseSheetDate(value: string): Date | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const month = months[match[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
}

// Converts a DriveReadResult rows array into header-keyed string records.
// First row is treated as headers; subsequent rows are data.
export function parseRows(sheetRows: SheetRows): Record<string, string>[] {
  const rows = sheetRows.file.rows;
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h ?? "").trim());
  return rows.slice(1).map((row) =>
    Object.fromEntries(
      headers.map((header, i) => [header, String(row[i] ?? "").trim()])
    )
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles (no errors)**

```bash
cd /Users/utpal/Code/playbooks/ops.daily-delivery-summary
bun run --cwd /Users/utpal/Code/projects/tessera tsc --noEmit --strict --moduleResolution bundler --module esnext --target esnext scripts/domain.ts 2>&1 | head -20
```

Expected: no output (no errors).

- [ ] **Step 3: Commit**

```bash
git add scripts/domain.ts
git commit -m "feat: add domain types and helpers for daily-delivery-summary"
```

---

## Task 4: Write analyze-deliveries script and tests

**Files:**
- Create: `scripts/analyze-deliveries.ts`
- Create: `tests/analyze-deliveries.test.ts`

**Interfaces:**
- Consumes: `SheetRows`, `parseRows`, `parseSheetDate`, `nodeInputs`, `RosterEntry`, `ExceptionEntry`, `ReportData` from `./domain`
- Produces: `function analyzeDeliveries(input: {...}): ReportData` — the pure analysis function
- Produces: `default function run(context: unknown)` — the script node entry point

- [ ] **Step 1: Write tests/analyze-deliveries.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { analyzeDeliveries } from "../scripts/analyze-deliveries";
import type { SheetRows } from "../scripts/domain";

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

const customers = rows(
  CUSTOMER_HEADERS,
  ["CUST001", "Priya Sharma", "+91 98400 11111", "priya@email.com", "12 MG Road", "Bengaluru", "15-Jan-2026", "Vegetarian"],
  ["CUST002", "Arjun Mehta", "+91 98400 22222", "arjun@email.com", "45 Koramangala 4th", "Bengaluru", "01-Feb-2026", "No onion/garlic"],
);

const subscriptions = rows(
  SUB_HEADERS,
  // SUB001: Active, expires 15-Jul-2026
  ["SUB001", "CUST001", "Priya Sharma", "6 Month", "15-Jan-2026", "15-Jul-2026", "0", "15-Jul-2026", "Active", ""],
  // SUB002: Active, expires 01-Sep-2026
  ["SUB002", "CUST002", "Arjun Mehta", "3 Month", "01-Jun-2026", "01-Sep-2026", "0", "01-Sep-2026", "Active", ""],
);

const noPauseLog = rows(PAUSE_HEADERS);

// SUB001: Mon-Fri. SUB002: Wed + Fri only.
const deliverySchedule = rows(
  SCHEDULE_HEADERS,
  ["SUB001", "Priya Sharma", "Active", "Y", "Y", "Y", "Y", "Y", "N", "N", "5", ""],
  ["SUB002", "Arjun Mehta", "Active", "N", "N", "Y", "N", "Y", "N", "N", "2", ""],
);

const mealPrefs = rows(
  MEAL_HEADERS,
  [
    "SUB001", "Priya Sharma", "Vegetarian",
    "Idli & Sambar", "Rice & Dal", "Roti & Dal Fry",        // Mon
    "Oats Porridge", "Roti & Sabzi", "Khichdi",              // Tue
    "", "", "",                                               // Wed (blank)
    "Idli & Sambar", "Pulao", "Palak Paneer & Roti",         // Thu
    "Poha", "Chapati & Paneer", "Dal Makhani & Rice",        // Fri
    "", "", "",                                               // Sat
    "", "", "",                                               // Sun
  ],
  [
    "SUB002", "Arjun Mehta", "No onion/garlic",
    "", "", "",                                               // Mon
    "", "", "",                                               // Tue
    "Upma", "Lemon Rice", "Palak Paneer & Roti",             // Wed
    "", "", "",                                               // Thu
    "Fruit Bowl", "Mixed Veg Thali", "Veg Pulao",            // Fri
    "", "", "",                                               // Sat
    "", "", "",                                               // Sun
  ],
);

const base = {
  customersRaw: customers,
  subscriptionsRaw: subscriptions,
  pauseLogRaw: noPauseLog,
  deliveryScheduleRaw: deliverySchedule,
  mealPrefsRaw: mealPrefs,
};

describe("analyzeDeliveries", () => {
  test("Monday: only SUB001 is scheduled, meals are correct", () => {
    // 2026-06-22 is a Monday
    const result = analyzeDeliveries({ ...base, today: "2026-06-22" });
    expect(result.dayOfWeek).toBe("Monday");
    expect(result.roster).toHaveLength(1);
    expect(result.roster[0].subscriptionId).toBe("SUB001");
    expect(result.roster[0].customerName).toBe("Priya Sharma");
    expect(result.roster[0].phone).toBe("+91 98400 11111");
    expect(result.roster[0].meals.breakfast).toBe("Idli & Sambar");
    expect(result.roster[0].meals.lunch).toBe("Rice & Dal");
    expect(result.roster[0].meals.dinner).toBe("Roti & Dal Fry");
    expect(result.roster[0].dietaryNotes).toBe("Vegetarian");
    expect(result.stats.totalDeliveries).toBe(1);
    expect(result.stats.breakfastCount).toBe(1);
    expect(result.stats.lunchCount).toBe(1);
    expect(result.stats.dinnerCount).toBe(1);
  });

  test("Wednesday: both SUB001 and SUB002 scheduled; SUB001 has missing_meal_pref", () => {
    // 2026-06-24 is a Wednesday
    const result = analyzeDeliveries({ ...base, today: "2026-06-24" });
    expect(result.roster).toHaveLength(2);
    const sub002 = result.roster.find((r) => r.subscriptionId === "SUB002");
    expect(sub002?.meals.breakfast).toBe("Upma");
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({ kind: "missing_meal_pref", subscriptionId: "SUB001" })
    );
  });

  test("Sunday: no deliveries → no_deliveries_today exception", () => {
    // 2026-06-28 is a Sunday
    const result = analyzeDeliveries({ ...base, today: "2026-06-28" });
    expect(result.roster).toHaveLength(0);
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({ kind: "no_deliveries_today" })
    );
    expect(result.stats.totalDeliveries).toBe(0);
  });

  test("paused SUB001 is excluded and counted in pausedToday", () => {
    const pauseLogOngoing = rows(
      PAUSE_HEADERS,
      ["SUB001", "Priya Sharma", "20-Jun-2026", "", "0", "Holiday", "No — ongoing"],
    );
    const result = analyzeDeliveries({ ...base, pauseLogRaw: pauseLogOngoing, today: "2026-06-22" });
    expect(result.roster).toHaveLength(0);
    expect(result.stats.pausedToday).toBe(1);
  });

  test("pause_resuming_today when pause ends on the run date", () => {
    const pauseLogResuming = rows(
      PAUSE_HEADERS,
      ["SUB001", "Priya Sharma", "15-Jun-2026", "22-Jun-2026", "7", "Holiday", "No"],
    );
    const result = analyzeDeliveries({ ...base, pauseLogRaw: pauseLogResuming, today: "2026-06-22" });
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({ kind: "pause_resuming_today", subscriptionId: "SUB001" })
    );
  });

  test("expiring_within_7_days when effective end date is ≤7 days away", () => {
    // today=2026-07-13 (Monday), SUB001 expires 2026-07-15 → 2 days
    const result = analyzeDeliveries({ ...base, today: "2026-07-13" });
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({ kind: "expiring_within_7_days", subscriptionId: "SUB001" })
    );
  });

  test("no expiry exception when end date is more than 7 days away", () => {
    // today=2026-06-22, SUB001 expires 2026-07-15 → 23 days
    const result = analyzeDeliveries({ ...base, today: "2026-06-22" });
    expect(result.exceptions.some((e) => e.kind === "expiring_within_7_days")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect all to FAIL (analyze-deliveries.ts does not exist yet)**

```bash
cd /Users/utpal/Code/playbooks/ops.daily-delivery-summary
bun test tests/analyze-deliveries.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '../scripts/analyze-deliveries'` or similar import error.

- [ ] **Step 3: Write scripts/analyze-deliveries.ts**

```typescript
import {
  parseRows,
  parseSheetDate,
  todayIso,
  nodeInputs,
  type SheetRows,
  type RosterEntry,
  type ExceptionEntry,
  type ReportData,
} from "./domain";

const DAY_NAMES: Record<number, string> = {
  0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday",
  4: "Thursday", 5: "Friday", 6: "Saturday",
};

const MEAL_COL_PREFIX: Record<number, string> = {
  0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat",
};

const SCHEDULE_COL: Record<number, string> = DAY_NAMES;

export function analyzeDeliveries(input: {
  customersRaw: SheetRows;
  subscriptionsRaw: SheetRows;
  pauseLogRaw: SheetRows;
  deliveryScheduleRaw: SheetRows;
  mealPrefsRaw: SheetRows;
  today?: string;
}): ReportData {
  const todayStr = input.today ?? todayIso();
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const dayIndex = todayDate.getUTCDay();
  const dayName = DAY_NAMES[dayIndex];
  const mealPrefix = MEAL_COL_PREFIX[dayIndex];
  const scheduleCol = SCHEDULE_COL[dayIndex];

  const customers = parseRows(input.customersRaw);
  const subscriptions = parseRows(input.subscriptionsRaw);
  const pauseLog = parseRows(input.pauseLogRaw);
  const deliverySchedule = parseRows(input.deliveryScheduleRaw);
  const mealPrefs = parseRows(input.mealPrefsRaw);

  const customerById = new Map(customers.map((c) => [c["Customer ID"], c]));
  const scheduleBySubId = new Map(deliverySchedule.map((s) => [s["Subscription ID"], s]));
  const mealPrefsBySubId = new Map(mealPrefs.map((m) => [m["Subscription ID"], m]));

  // Subscriptions with an open (ongoing) pause entry
  const pausedSubIds = new Set(
    pauseLog
      .filter((p) => {
        const end = p["Pause End"].trim();
        return !end || end.toLowerCase().includes("ongoing") || /^no\b/i.test(end);
      })
      .map((p) => p["Subscription ID"])
  );

  const activeSubscriptions = subscriptions.filter((s) => s["Status"] === "Active");

  const roster: RosterEntry[] = [];
  const exceptions: ExceptionEntry[] = [];
  let breakfastCount = 0;
  let lunchCount = 0;
  let dinnerCount = 0;

  for (const sub of activeSubscriptions) {
    const subId = sub["Subscription ID"];
    const customerName = sub["Customer Name"];

    if (pausedSubIds.has(subId)) continue;

    const schedule = scheduleBySubId.get(subId);
    if (!schedule || schedule[scheduleCol] !== "Y") continue;

    const customer = customerById.get(sub["Customer ID"]);
    const meals = mealPrefsBySubId.get(subId);
    const breakfast = meals?.[`${mealPrefix} — Breakfast`] || null;
    const lunch = meals?.[`${mealPrefix} — Lunch`] || null;
    const dinner = meals?.[`${mealPrefix} — Dinner`] || null;

    if (!breakfast && !lunch && !dinner) {
      exceptions.push({
        kind: "missing_meal_pref",
        subscriptionId: subId,
        customerName,
        detail: `No meal preferences set for ${dayName}`,
      });
    }

    if (breakfast) breakfastCount++;
    if (lunch) lunchCount++;
    if (dinner) dinnerCount++;

    roster.push({
      subscriptionId: subId,
      customerName,
      phone: customer?.["Phone"] ?? "",
      address: customer?.["Address"] ?? "",
      city: customer?.["City"] ?? "",
      dietaryNotes: meals?.["Dietary Notes"] ?? sub["Notes"] ?? "",
      meals: { breakfast, lunch, dinner },
    });

    const effectiveEndDate = parseSheetDate(sub["Effective End Date"]);
    if (effectiveEndDate) {
      const daysUntilExpiry = Math.floor(
        (effectiveEndDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysUntilExpiry >= 0 && daysUntilExpiry <= 7) {
        exceptions.push({
          kind: "expiring_within_7_days",
          subscriptionId: subId,
          customerName,
          detail: `Subscription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"} (${sub["Effective End Date"]})`,
        });
      }
    }
  }

  for (const p of pauseLog) {
    const pauseEnd = parseSheetDate(p["Pause End"]);
    if (!pauseEnd) continue;
    if (pauseEnd.toISOString().slice(0, 10) === todayStr) {
      exceptions.push({
        kind: "pause_resuming_today",
        subscriptionId: p["Subscription ID"],
        customerName: p["Customer Name"],
        detail: `Pause ends today, delivery resumes ${dayName}`,
      });
    }
  }

  if (roster.length === 0) {
    exceptions.push({
      kind: "no_deliveries_today",
      subscriptionId: null,
      customerName: null,
      detail: `No active subscriptions scheduled for ${dayName}`,
    });
  }

  return {
    date: todayStr,
    dayOfWeek: dayName,
    roster,
    stats: {
      totalDeliveries: roster.length,
      breakfastCount,
      lunchCount,
      dinnerCount,
      pausedToday: pausedSubIds.size,
    },
    exceptions,
  };
}

export default function run(context: unknown) {
  const inputs = nodeInputs(context);
  return analyzeDeliveries({
    customersRaw: inputs.customersRaw as SheetRows,
    subscriptionsRaw: inputs.subscriptionsRaw as SheetRows,
    pauseLogRaw: inputs.pauseLogRaw as SheetRows,
    deliveryScheduleRaw: inputs.deliveryScheduleRaw as SheetRows,
    mealPrefsRaw: inputs.mealPrefsRaw as SheetRows,
  });
}
```

- [ ] **Step 4: Run tests — expect all to PASS**

```bash
cd /Users/utpal/Code/playbooks/ops.daily-delivery-summary
bun test tests/analyze-deliveries.test.ts
```

Expected output:
```
✓ Monday: only SUB001 is scheduled, meals are correct
✓ Wednesday: both SUB001 and SUB002 scheduled; SUB001 has missing_meal_pref
✓ Sunday: no deliveries → no_deliveries_today exception
✓ paused SUB001 is excluded and counted in pausedToday
✓ pause_resuming_today when pause ends on the run date
✓ expiring_within_7_days when effective end date is ≤7 days away
✓ no expiry exception when end date is more than 7 days away

7 pass, 0 fail
```

If any test fails: read the failure message, fix `analyze-deliveries.ts`, and re-run. Do not modify the test file.

- [ ] **Step 5: Commit**

```bash
git add scripts/analyze-deliveries.ts tests/analyze-deliveries.test.ts
git commit -m "feat: add analyze-deliveries script with tests"
```

---

## Task 5: Write build-draft-request script

**Files:**
- Create: `scripts/build-draft-request.ts`

**Interfaces:**
- Consumes: `nodeInputs`, `isRecord` from `./domain`
- Consumes (at runtime via node inputs): `reportData: { date: string; dayOfWeek: string }`, `dailySummary: { text: string }`, `recipientEmail: string`
- Produces: `{ requests: [{ command: "mail", subcommand: "draft", to, subject, body }] }`

- [ ] **Step 1: Write scripts/build-draft-request.ts**

```typescript
import { nodeInputs, isRecord } from "./domain";

function formatDisplayDate(dateIso: string): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${day} ${months[month - 1]} ${year}`;
}

export function buildDraftRequest(input: {
  reportData: { date: string; dayOfWeek: string };
  dailySummaryText: string;
  recipientEmail: string;
}): {
  requests: Array<{
    command: "mail";
    subcommand: "draft";
    to: string;
    subject: string;
    body: string;
  }>;
} {
  const displayDate = formatDisplayDate(input.reportData.date);
  return {
    requests: [
      {
        command: "mail",
        subcommand: "draft",
        to: input.recipientEmail,
        subject: `Daily Ops Summary — ${input.reportData.dayOfWeek}, ${displayDate}`,
        body: input.dailySummaryText,
      },
    ],
  };
}

export default function run(context: unknown) {
  const inputs = nodeInputs(context);
  const reportData = inputs.reportData as { date: string; dayOfWeek: string };
  const dailySummary = isRecord(inputs.dailySummary) ? inputs.dailySummary : {};
  const dailySummaryText = typeof dailySummary.text === "string" ? dailySummary.text : "";
  const recipientEmail = typeof inputs.recipientEmail === "string" ? inputs.recipientEmail : "";
  return buildDraftRequest({ reportData, dailySummaryText, recipientEmail });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/build-draft-request.ts
git commit -m "feat: add build-draft-request script"
```

---

## Task 6: Write the format prompt

**Files:**
- Create: `prompts/format-daily-summary.md`

**Interfaces:**
- Consumes: `reportData` artifact injected into the agent context
- Produces: `{ text: string }` conforming to `schemas/daily-summary.schema.json`

- [ ] **Step 1: Write prompts/format-daily-summary.md**

```markdown
# Format Daily Delivery Summary

You are formatting a daily meal delivery ops report for a small subscription business.

Input artifact:

- `reportData`: structured analysis output with `date`, `dayOfWeek`, `roster`, `stats`, and `exceptions`.

Return JSON that conforms to `schemas/daily-summary.schema.json`: `{ "text": "<markdown report>" }`.

## Report format

Produce a single markdown string in the `text` field:

```
# Daily Ops Summary — {dayOfWeek}, {DD Month YYYY}

## Today's Deliveries ({roster.length})

| # | Customer | Phone | Address | Breakfast | Lunch | Dinner | Dietary Notes |
|---|----------|-------|---------|-----------|-------|--------|---------------|
| 1 | {customerName} | {phone} | {address}, {city} | {breakfast or —} | {lunch or —} | {dinner or —} | {dietaryNotes or —} |

## Summary

- **Total deliveries:** {totalDeliveries}
- **Breakfast:** {breakfastCount}  **Lunch:** {lunchCount}  **Dinner:** {dinnerCount}
- **Paused today:** {pausedToday}

## Exceptions ⚠️

- **{subscriptionId} / {customerName}** — {detail}
```

## Rules

- Format the date as "Tuesday, 24 June 2026" (day name first, then DD Month YYYY).
- Use `—` for null or blank meal values and blank dietary notes.
- Omit the `## Exceptions ⚠️` section entirely if `exceptions` is an empty array.
- If `roster` is empty, replace the table with: "No deliveries scheduled for today."
- Do not add commentary, greetings, or sign-offs — only the report.
- Do not invent values not present in `reportData`.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/format-daily-summary.md
git commit -m "feat: add format-daily-summary agent prompt"
```

---

## Task 7: Wire up playbook.ts and validate

**Files:**
- Create: `playbook.ts`

**Interfaces:**
- Consumes: all schemas, scripts, and prompts created in Tasks 1–6
- Produces: valid Tessera graph playbook importable from the UI

The graph has 9 nodes in sequence:
```
fetchCustomers → fetchSubscriptions → fetchPauseLog → fetchDeliverySchedule →
fetchMealPrefs → analyzeDeliveries → formatSummary → buildDraftRequest → createEmailDraft
```

- [ ] **Step 1: Write playbook.ts**

```typescript
export default {
  schemaVersion: 1,
  id: "ops.daily-delivery-summary",
  version: "1.0.0",
  name: "Daily Delivery Ops Summary",
  description:
    "Reads a meal-subscription Google Sheet, produces a daily delivery roster with stats and exceptions, and creates a Gmail draft.",
  metadata: {
    category: "operations",
    businessUseCase: "Generate and send daily meal delivery dispatch summary",
    requiredCapabilities: [
      "integration.drive.files.read",
      "integration.mail.drafts.write",
    ],
    optionalCapabilities: [],
    outputs: [
      { kind: "dailySummary", label: "Daily ops summary" },
    ],
    phases: ["Fetch", "Analyze", "Format", "Draft"],
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
    recipientEmail: {
      type: "string",
      required: true,
      label: "Recipient email",
      description: "Email address the Gmail draft will be addressed to.",
      placeholder: "you@gmail.com",
      order: 2,
      group: "Email",
      ui: { control: "text" },
    },
  },
  artifacts: {
    customersRaw: { schema: "schemas/sheet-rows.schema.json" },
    subscriptionsRaw: { schema: "schemas/sheet-rows.schema.json" },
    pauseLogRaw: { schema: "schemas/sheet-rows.schema.json" },
    deliveryScheduleRaw: { schema: "schemas/sheet-rows.schema.json" },
    mealPrefsRaw: { schema: "schemas/sheet-rows.schema.json" },
    reportData: { schema: "schemas/report-data.schema.json" },
    dailySummary: { schema: "schemas/daily-summary.schema.json" },
    gmailDraftRequest: { schema: "schemas/gmail-draft-request.schema.json" },
  },
  capabilities: [
    "integration.drive.files.read",
    "integration.mail.drafts.write",
  ],
  limits: {
    maxTotalAgentSteps: 10,
    maxExternalToolCalls: 6,
    maxRuntimeMs: 300000,
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
        args: [
          "{{inputs.spreadsheetId}}",
          "--format", "json",
          "--sheet", "Customers",
          "--range", "A1:Z200",
        ],
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
        args: [
          "{{inputs.spreadsheetId}}",
          "--format", "json",
          "--sheet", "Subscriptions",
          "--range", "A1:Z200",
        ],
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
        args: [
          "{{inputs.spreadsheetId}}",
          "--format", "json",
          "--sheet", "Pause Log",
          "--range", "A1:Z200",
        ],
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
        args: [
          "{{inputs.spreadsheetId}}",
          "--format", "json",
          "--sheet", "Delivery Schedule",
          "--range", "A1:Z200",
        ],
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
        args: [
          "{{inputs.spreadsheetId}}",
          "--format", "json",
          "--sheet", "Meal Preferences",
          "--range", "A1:Z200",
        ],
      },
      outputArtifact: "mealPrefsRaw",
      onSuccess: "analyzeDeliveries",
    },
    {
      id: "analyzeDeliveries",
      label: "Analyze today's deliveries",
      kind: "script",
      run: "scripts/analyze-deliveries.ts",
      inputs: {
        customersRaw: { artifact: "customersRaw" },
        subscriptionsRaw: { artifact: "subscriptionsRaw" },
        pauseLogRaw: { artifact: "pauseLogRaw" },
        deliveryScheduleRaw: { artifact: "deliveryScheduleRaw" },
        mealPrefsRaw: { artifact: "mealPrefsRaw" },
      },
      outputArtifact: "reportData",
      onSuccess: "formatSummary",
    },
    {
      id: "formatSummary",
      label: "Format daily summary",
      kind: "agent",
      prompt: "prompts/format-daily-summary.md",
      inputs: {
        reportData: { artifact: "reportData" },
      },
      tools: [],
      output: {
        artifact: "dailySummary",
        schema: "schemas/daily-summary.schema.json",
        style: { consume: true, purpose: "draft" },
      },
      onSuccess: "buildDraftRequest",
    },
    {
      id: "buildDraftRequest",
      label: "Build Gmail draft request",
      kind: "script",
      run: "scripts/build-draft-request.ts",
      inputs: {
        reportData: { artifact: "reportData" },
        dailySummary: { artifact: "dailySummary" },
        recipientEmail: { input: "recipientEmail" },
      },
      outputArtifact: "gmailDraftRequest",
      onSuccess: "createEmailDraft",
    },
    {
      id: "createEmailDraft",
      label: "Create Gmail draft",
      kind: "effect",
      effectId: "mail.draft",
      capability: "integration.mail.drafts.write",
      adapterId: "google-workspace",
      sideEffect: "external",
      approval: "required",
      idempotency: "required",
      idempotencyKey: "mail.draft:ops.daily-delivery-summary:{{inputs.spreadsheetId}}",
      input: {
        sourceArtifact: "gmailDraftRequest",
        value: { artifact: "gmailDraftRequest" },
        target: {
          kind: "external",
          reference: "gmail:drafts:ops.daily-delivery-summary",
          connectorId: "google-workspace",
          label: "Daily ops summary Gmail draft",
        },
      },
      preview: {
        schemaVersion: 1,
        title: "Create Gmail draft",
        summary: "Create the daily delivery ops summary as a Gmail draft ready to send.",
      },
      onSuccess: "completed",
    },
  ],
};
```

- [ ] **Step 2: Run Tessera validator**

```bash
bun run --cwd /Users/utpal/Code/projects/tessera apps/cli/src/index.ts playbook validate /Users/utpal/Code/playbooks/ops.daily-delivery-summary
```

Expected: `✓ Playbook validated successfully` or similar. If there are errors, read them and fix `playbook.ts`. Common issues:
- Missing capability in `capabilities` array — add it
- Schema path not found — check schema file names match `artifacts` declarations
- `strict()` field rejection — remove unknown fields

- [ ] **Step 3: Import playbook in Tessera desktop and confirm it appears**

Open Tessera desktop. Go to the playbook import screen. Import from path `/Users/utpal/Code/playbooks/ops.daily-delivery-summary`. Confirm the playbook appears with name "Daily Delivery Ops Summary" and shows the two input fields (Google Sheet ID, Recipient email).

- [ ] **Step 4: Commit**

```bash
git add playbook.ts
git commit -m "feat: wire up ops.daily-delivery-summary playbook graph"
```
