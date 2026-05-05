# Gcal Read-Only Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add end-to-end read-only Google Calendar support to Tessera via `gcal list` and `gcal read`, using the existing shell tool path and desktop-managed integration credentials.

**Architecture:** Extend the existing integration settings model from Brave-only to Brave Search plus Google Calendar, then implement `gcal` CLI commands that fetch and normalize calendar events. Keep the current permission and task-runner shape intact by only adding shared contracts, CLI behavior, desktop integration wiring, and shell-runtime parsing for the new success payloads.

**Tech Stack:** Bun, TypeScript, Zod, Tauri 2 Rust, OS keychain integration, existing shell tool runtime

---

## File Structure

### Contracts and shared types

- Modify: `packages/contracts/src/index.ts`
  - Add `google-calendar` to integration provider enums and read/save/test request schemas.
  - Add normalized `GcalListResultSchema` and `GcalReadResultSchema`.
- Modify: `packages/contracts/src/integration-settings.test.ts`
  - Extend integration-provider coverage and add parsed `gcal` payload tests.

### CLI shell implementation

- Modify: `apps/cli/src/shell.ts`
  - Add `gcal list` and `gcal read` command handling, argument parsing, Google Calendar fetch helpers, and response normalization.
- Modify: `apps/cli/src/index.ts`
  - Update CLI help text to show `gcal`.
- Modify: `apps/cli/src/shell.test.ts`
  - Add failing/passing tests for `gcal list`, `gcal read`, and missing-credential behavior.

### Core shell runtime

- Modify: `packages/core/src/shell-runtime.ts`
  - Parse `gcal` stdout into the new contract schemas.
- Modify: `packages/core/src/shell-runtime.test.ts`
  - Add parsed `gcal` payload coverage.

### Desktop integration settings

- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`
  - Add `GoogleCalendar` provider, account label, settings redaction, and shared credential plumbing.
- Modify: `apps/desktop/src-tauri/src/lib.rs`
  - Route Google Calendar connection tests through `gcal list`.
- Modify: `apps/desktop/ui/src/lib/integrationSettings.ts`
  - Add provider label/export for Google Calendar.
- Modify: `apps/desktop/ui/src/lib/integrationSettings.test.ts`
  - Extend provider/helper coverage.
- Modify: `apps/desktop/ui/src/components/SettingsView.tsx`
  - Make the Integrations tab select state and copy work for multiple providers, including Google Calendar.

## Task 1: Extend shared contracts for Google Calendar

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/integration-settings.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Add tests to `packages/contracts/src/integration-settings.test.ts` that exercise the new provider and parsed payloads:

```ts
test("accepts Google Calendar as an integration provider", () => {
  const parsed = IntegrationSettingsReadSchema.parse({
    providers: {
      braveSearch: { provider: "brave-search", hasCredential: true },
      googleCalendar: { provider: "google-calendar", hasCredential: false },
    },
  });

  expect(parsed.providers.googleCalendar.provider).toBe("google-calendar");
  expect(parsed.providers.googleCalendar.hasCredential).toBe(false);
});

test("parses normalized gcal list payloads", () => {
  const parsed = GcalListResultSchema.parse({
    calendarId: "primary",
    events: [
      {
        id: "evt-1",
        title: "Weekly review",
        start: "2026-05-04T09:00:00Z",
        end: "2026-05-04T09:30:00Z",
        isAllDay: false,
      },
    ],
  });

  expect(parsed.events[0]?.title).toBe("Weekly review");
});

test("parses normalized gcal read payloads", () => {
  const parsed = GcalReadResultSchema.parse({
    calendarId: "primary",
    event: {
      id: "evt-1",
      title: "Weekly review",
      start: "2026-05-04",
      isAllDay: true,
    },
  });

  expect(parsed.event.isAllDay).toBe(true);
});
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run: `bun test packages/contracts/src/integration-settings.test.ts`

Expected: FAIL with schema/type errors mentioning missing `google-calendar`, `GcalListResultSchema`, or `GcalReadResultSchema`.

- [ ] **Step 3: Add the minimal shared schemas**

Update `packages/contracts/src/index.ts` with the new provider and result schemas:

```ts
export const IntegrationProviderSchema = z.enum(["brave-search", "google-calendar"]);

const GoogleCalendarIntegrationSettingsSchema = z.object({
  provider: z.literal("google-calendar"),
  hasCredential: z.boolean().default(false),
});

export const GcalEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.string().min(1),
  end: z.string().optional(),
  isAllDay: z.boolean(),
  organizerEmail: z.string().optional(),
  htmlLink: z.string().optional(),
});

export const GcalListResultSchema = z.object({
  calendarId: z.string().min(1),
  events: z.array(GcalEventSchema),
});

export const GcalReadResultSchema = z.object({
  calendarId: z.string().min(1),
  event: GcalEventSchema.extend({
    attendees: z
      .array(
        z.object({
          email: z.string().min(1),
          displayName: z.string().optional(),
          responseStatus: z.string().optional(),
        })
      )
      .optional(),
  }),
});
```

- [ ] **Step 4: Run the contract tests to verify they pass**

Run: `bun test packages/contracts/src/integration-settings.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/integration-settings.test.ts
git commit -m "Define shared contracts for read-only gcal support"
```

## Task 2: Implement `gcal` CLI commands test-first

**Files:**
- Modify: `apps/cli/src/shell.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/shell.test.ts`

- [ ] **Step 1: Write the failing CLI tests**

Add tests to `apps/cli/src/shell.test.ts` for `gcal list`, `gcal read`, and missing credential:

```ts
test("returns normalized gcal list results", async () => {
  const result = await executeCliCommand(["gcal", "list", "--limit", "1"], {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "evt-1",
              summary: "Weekly review",
              start: { dateTime: "2026-05-04T09:00:00Z" },
              end: { dateTime: "2026-05-04T09:30:00Z" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    getGoogleCalendarApiKey: async () => "google-test",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    calendarId: "primary",
    events: [
      {
        id: "evt-1",
        title: "Weekly review",
        start: "2026-05-04T09:00:00Z",
        end: "2026-05-04T09:30:00Z",
        isAllDay: false,
      },
    ],
  });
});

test("returns normalized gcal read results", async () => {
  const result = await executeCliCommand(["gcal", "read", "evt-1"], {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          id: "evt-1",
          summary: "Weekly review",
          start: { date: "2026-05-04" },
          end: { date: "2026-05-05" },
          attendees: [{ email: "owner@example.com", responseStatus: "accepted" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    getGoogleCalendarApiKey: async () => "google-test",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    calendarId: "primary",
    event: {
      id: "evt-1",
      title: "Weekly review",
      start: "2026-05-04",
      end: "2026-05-05",
      isAllDay: true,
      attendees: [{ email: "owner@example.com", responseStatus: "accepted" }],
    },
  });
});

test("returns a stable missing-credential error for gcal", async () => {
  const result = await executeCliCommand(["gcal", "list"], {
    fetchImpl: async () => new Response("", { status: 500 }),
    getGoogleCalendarApiKey: async () => null,
  });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Settings > Integrations");
});
```

- [ ] **Step 2: Run the CLI tests to verify they fail**

Run: `bun test apps/cli/src/shell.test.ts`

Expected: FAIL with `Unknown command: gcal list` or missing helper/type errors.

- [ ] **Step 3: Implement the minimal CLI behavior**

Update `apps/cli/src/shell.ts` to add a Google Calendar credential getter option and command handlers:

```ts
export interface ExecuteCliCommandOptions {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  getBraveApiKey?: () => Promise<string | null>;
  getGoogleCalendarApiKey?: () => Promise<string | null>;
}

if (command === "gcal" && subcommand === "list") {
  const payload = await runGcalList(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

if (command === "gcal" && subcommand === "read") {
  const payload = await runGcalRead(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}
```

Implement small helpers with bounded argument parsing:

```ts
async function runGcalList(args: string[], options: ExecuteCliCommandOptions) {
  const { calendarId, limit } = parseGcalListArgs(args);
  const apiKey =
    (await options.getGoogleCalendarApiKey?.()) ??
    (await getIntegrationCredentialFromSystem("integration.google-calendar").catch(() => null));
  if (!apiKey) {
    throw new CliCommandError(
      "Google Calendar is not configured. Add an API key in Settings > Integrations."
    );
  }

  const endpoint = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  endpoint.searchParams.set("maxResults", String(limit));
  endpoint.searchParams.set("singleEvents", "true");
  endpoint.searchParams.set("orderBy", "startTime");
  endpoint.searchParams.set("timeMin", new Date().toISOString());

  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    headers: { ...BROWSER_HEADERS, authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  const payload = await response.json();
  return {
    calendarId,
    events: (payload.items ?? []).map(normalizeGcalEvent),
  };
}
```

Also update `apps/cli/src/index.ts` help text:

```ts
console.log("  gcal          Read Google Calendar events");
```

- [ ] **Step 4: Run the CLI tests to verify they pass**

Run: `bun test apps/cli/src/shell.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/index.ts apps/cli/src/shell.ts apps/cli/src/shell.test.ts
git commit -m "Implement read-only gcal shell commands"
```

## Task 3: Parse `gcal` results in the core shell runtime

**Files:**
- Modify: `packages/core/src/shell-runtime.ts`
- Modify: `packages/core/src/shell-runtime.test.ts`

- [ ] **Step 1: Write the failing shell-runtime test**

Add a test to `packages/core/src/shell-runtime.test.ts`:

```ts
test("parses successful gcal list payloads from workspace cli stdout", async () => {
  const executor = createSpawnShellExecutor({
    async runWorkspaceCli(): Promise<SpawnResult> {
      return {
        stdout: JSON.stringify({
          calendarId: "primary",
          events: [
            {
              id: "evt-1",
              title: "Weekly review",
              start: "2026-05-04T09:00:00Z",
              isAllDay: false,
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 12,
      };
    },
  });

  const result = await executor.executeShell({
    command: "gcal",
    subcommand: "list",
    args: [],
  });

  expect(result.parsed).toEqual({
    calendarId: "primary",
    events: [
      {
        id: "evt-1",
        title: "Weekly review",
        start: "2026-05-04T09:00:00Z",
        isAllDay: false,
      },
    ],
  });
});
```

- [ ] **Step 2: Run the shell-runtime test to verify it fails**

Run: `bun test packages/core/src/shell-runtime.test.ts`

Expected: FAIL because `gcal` payloads are not parsed yet.

- [ ] **Step 3: Implement minimal parsing support**

Update `packages/core/src/shell-runtime.ts`:

```ts
import { GcalListResultSchema, GcalReadResultSchema } from "@tessera/contracts";

function parseShellPayload(call: ShellToolCall, stdout: string): unknown {
  const json = JSON.parse(stdout);
  if (call.command === "web-search") return BraveSearchResultSchema.parse(json);
  if (call.command === "web-fetch") return WebFetchResultSchema.parse(json);
  if (call.command === "gcal" && call.subcommand === "list") {
    return GcalListResultSchema.parse(json);
  }
  if (call.command === "gcal" && call.subcommand === "read") {
    return GcalReadResultSchema.parse(json);
  }
  return json;
}
```

- [ ] **Step 4: Run the shell-runtime test to verify it passes**

Run: `bun test packages/core/src/shell-runtime.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/shell-runtime.ts packages/core/src/shell-runtime.test.ts
git commit -m "Parse normalized gcal shell results"
```

## Task 4: Extend desktop integration settings for Google Calendar

**Files:**
- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/ui/src/lib/integrationSettings.ts`
- Modify: `apps/desktop/ui/src/lib/integrationSettings.test.ts`
- Modify: `apps/desktop/ui/src/components/SettingsView.tsx`

- [ ] **Step 1: Write the failing integration-helper test**

Extend `apps/desktop/ui/src/lib/integrationSettings.test.ts`:

```ts
test("labels Google Calendar", () => {
  expect(integrationLabel("google-calendar")).toBe("Google Calendar");
});

test("exports supported integration providers in UI order", () => {
  const expected: IntegrationProvider[] = ["brave-search", "google-calendar"];
  expect(INTEGRATION_PROVIDERS).toEqual(expected);
});
```

- [ ] **Step 2: Run the UI helper test to verify it fails**

Run: `bun test apps/desktop/ui/src/lib/integrationSettings.test.ts`

Expected: FAIL because `google-calendar` is not in the helper exports yet.

- [ ] **Step 3: Implement the minimal desktop integration changes**

Update `apps/desktop/ui/src/lib/integrationSettings.ts`:

```ts
export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  "brave-search",
  "google-calendar",
];

export function integrationLabel(provider: IntegrationProvider): string {
  switch (provider) {
    case "brave-search":
      return "Brave Search";
    case "google-calendar":
      return "Google Calendar";
  }
}
```

Update `apps/desktop/src-tauri/src/integration_settings.rs`:

```rust
pub enum IntegrationProvider {
    BraveSearch,
    GoogleCalendar,
}

impl IntegrationProvider {
    pub fn account(self) -> &'static str {
        match self {
            Self::BraveSearch => "integration.brave-search",
            Self::GoogleCalendar => "integration.google-calendar",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::BraveSearch => "Brave Search",
            Self::GoogleCalendar => "Google Calendar",
        }
    }
}
```

Extend the redacted settings shape:

```rust
pub struct SettingsProviders {
    pub brave_search: ProviderConfig,
    pub google_calendar: ProviderConfig,
}

pub struct ReadProviders {
    pub brave_search: ProviderSettings,
    pub google_calendar: ProviderSettings,
}
```

Update `apps/desktop/src-tauri/src/lib.rs` connection-test routing:

```rust
let command = match request.provider {
    integration_settings::IntegrationProvider::BraveSearch => vec!["web-search", "search", "tessera"],
    integration_settings::IntegrationProvider::GoogleCalendar => vec!["gcal", "list"],
};

let result = run_workspace_cli_command(&app, &command, credential.as_deref()).await?;
```

In `apps/desktop/ui/src/components/SettingsView.tsx`, make integration selection read from the selected provider instead of hardcoding Brave:

```ts
const hasIntegrationCredential =
  selectedIntegration === "brave-search"
    ? integrations?.providers.braveSearch.hasCredential ?? false
    : integrations?.providers.googleCalendar.hasCredential ?? false;
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `bun test apps/desktop/ui/src/lib/integrationSettings.test.ts`

Expected: PASS

- [ ] **Step 5: Run full verification**

Run: `bun run check`

Expected: PASS

Run: `bun run --filter '*' test`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/integration_settings.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/ui/src/lib/integrationSettings.ts apps/desktop/ui/src/lib/integrationSettings.test.ts apps/desktop/ui/src/components/SettingsView.tsx
git commit -m "Add Google Calendar integration settings support"
```

## Self-Review

- Spec coverage:
  - `gcal list` and `gcal read` behavior are covered by Task 2 and Task 3.
  - Google Calendar integration settings are covered by Task 4.
  - Normalized payload contracts are covered by Task 1.
  - Read-only architecture and existing shell path are preserved across all tasks.
- Placeholder scan:
  - No `TBD`, `TODO`, or generic “handle this later” steps remain.
- Type consistency:
  - Plan uses `google-calendar`, `GcalListResultSchema`, and `GcalReadResultSchema` consistently across contracts, CLI, runtime, and UI.
