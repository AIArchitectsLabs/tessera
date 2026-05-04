# Gcal Read-Only Tool Design

## Summary

Add a real read-only Google Calendar tool to Tessera's existing shell-backed tool
surface. This slice implements `gcal list` and `gcal read` end to end so task
agents can inspect calendar data through the current `shell` tool path without
adding write behavior, approval UX changes, or a broader Google integration
bundle.

The goal is to make calendar access genuinely usable while keeping the first
implementation narrow, testable, and consistent with the current architecture:

- the desktop app owns saved credentials and settings UI
- the sidecar/task runner keeps invoking the existing shell tool contract
- the CLI layer performs the external API call and returns normalized JSON
- the permission policy continues to allow read-only calendar actions by default

## Goals

- Make `gcal list` work through the existing `shell` tool.
- Make `gcal read` work through the existing `shell` tool.
- Add a user-facing integration settings entry for Google Calendar credentials.
- Return stable, compact event payloads rather than raw provider responses.
- Preserve the existing tool-policy model where read-only calendar actions are
  allowed and calendar mutations remain out of scope.

## Non-Goals

- Do not implement `gcal create`, `gcal update`, or `gcal delete`.
- Do not add approval UX for calendar writes in this slice.
- Do not build shared Google auth for Calendar, Mail, Drive, and Contacts all at
  once.
- Do not add background sync, push notifications, or offline caching.
- Do not redesign the shell tool contract or Pi task execution path.

## Product Behavior

Users configure a Google Calendar credential in Settings > Integrations, similar
in spirit to the existing Brave Search setup. Once configured, agents may use the
existing `shell` tool with:

- `gcal list ...` to list upcoming or matching events
- `gcal read <event-id>` to fetch details for one event

These calls are read-only and should be allowed under the current permission
model. If the integration is not configured, the command fails with a clear
actionable message that points the user to Settings > Integrations.

The first UI does not expose advanced Google account management. It only needs a
single credential/configuration path that allows Tessera to call the Google
Calendar read APIs successfully.

## Command Contract

The existing shell tool contract already includes `gcal` in shared schemas and
permission policy. This slice makes that contract real.

Supported subcommands:

### `gcal list`

Purpose: list calendar events in a bounded window.

Expected invocation shape:

```text
gcal list [query-or-flags...]
```

For the first slice, the CLI should support a simple, deterministic argument
shape rather than a broad free-form parser:

- no args: list upcoming events from the primary calendar
- optional `--limit <n>` for result size
- optional `--calendar <id>` for non-primary calendar lookup

The agent prompting layer can continue to generate plain argument arrays, but the
CLI implementation should only accept the documented flags above.

### `gcal read`

Purpose: fetch one event by id.

Expected invocation shape:

```text
gcal read <event-id> [--calendar <id>]
```

`event-id` is required. `--calendar <id>` defaults to the primary calendar.

## Returned Payload Shape

The CLI should return normalized JSON that is small and stable enough for agent
consumption and tests.

### `gcal list` result

```ts
type GcalListResult = {
  calendarId: string;
  events: Array<{
    id: string;
    title: string;
    status?: string;
    description?: string;
    location?: string;
    start: string;
    end?: string;
    isAllDay: boolean;
    organizerEmail?: string;
    htmlLink?: string;
  }>;
};
```

### `gcal read` result

```ts
type GcalReadResult = {
  calendarId: string;
  event: {
    id: string;
    title: string;
    status?: string;
    description?: string;
    location?: string;
    start: string;
    end?: string;
    isAllDay: boolean;
    organizerEmail?: string;
    attendees?: Array<{
      email: string;
      displayName?: string;
      responseStatus?: string;
    }>;
    htmlLink?: string;
  };
};
```

Normalization rules:

- map provider summary/title to `title`
- return ISO-ish string values exactly as supplied by the provider for date/time
  fields
- compute `isAllDay` from date-only start/end fields
- omit absent optional fields instead of returning null-heavy payloads
- never return OAuth tokens, refresh tokens, or raw provider credential material

## Integration Settings Design

The current integration settings path is Brave-only. This slice extends the same
pattern to support Google Calendar credentials/configuration.

Required updates:

- shared contracts add a Google Calendar integration provider
- desktop integration settings state and labels include Google Calendar
- Tauri credential persistence supports a Google Calendar account entry
- connection-test logic validates that the supplied credential can access the
  Calendar read API

The first version should keep the saved integration model minimal. Tessera needs
enough information to perform authenticated read requests, but the settings model
should not become a generic Google account manager.

## Architecture

### Desktop UI

Settings continues to be the place where users add or replace the saved external
integration credential. The Integrations screen gains a Google Calendar option
next to Brave Search and surfaces:

- whether a credential is present
- save/update action
- test connection action
- delete credential action

### Tauri/Desktop Credential Bridge

Tauri remains the secret boundary. The desktop layer stores the Google Calendar
credential in the OS keychain under a Tessera-owned account identifier and keeps
redacted integration settings in the existing JSON-backed settings record.

### CLI Layer

`apps/cli/src/shell.ts` gains real handling for:

- `gcal list`
- `gcal read`

The CLI is responsible for:

- validating CLI args
- loading the saved credential through the existing integration bridge pattern
- calling the Google Calendar API
- normalizing the response to the shared payload shape
- returning JSON on stdout

### Core / Sidecar

The core shell runtime and sidecar task runner already understand the `gcal`
command shape. This slice should require only narrow changes there:

- parsed payload schemas for `gcal list` and `gcal read`
- any prompt/help text updates that improve agent use of the command

The permission model remains unchanged: `gcal list` and `gcal read` are read
operations and are allowed by default.

## Error Handling

Expected failures should be explicit and user-actionable:

- missing credential: tell the user Google Calendar is not configured and point
  to Settings > Integrations
- invalid args: print exact usage for `gcal list` or `gcal read`
- unauthorized or expired credential: report auth failure without leaking secret
  values
- missing event id: return not found for `gcal read`
- upstream API failure: return a concise status-based error

The CLI should keep the existing convention of returning structured JSON only on
successful execution. Failures should surface through stderr and non-zero exit
codes so the shell runtime can preserve its current behavior.

## Testing Strategy

This slice should follow test-first implementation.

Required tests:

- contract tests for the new Google Calendar integration provider shape
- CLI tests for `gcal list` success payload normalization
- CLI tests for `gcal read` success payload normalization
- CLI tests for missing credential behavior
- CLI tests for invalid subcommand/arg usage
- core shell-runtime tests for parsed `gcal` payload handling
- permission tests confirming `gcal list` and `gcal read` stay allowed

Verification commands:

```bash
bun run check
bun run --filter '*' test
```

## Implementation Plan Shape

Implementation should be split into small reversible steps:

1. Extend contracts for the integration provider and parsed `gcal` payloads.
2. Add failing CLI tests for `gcal list` and `gcal read`.
3. Implement CLI argument parsing and payload normalization.
4. Extend desktop integration settings and Tauri keychain handling.
5. Update shell runtime parsing/tests and any prompt text that references shell
   tool usage.
6. Run full verification and polish error messages.

## Risks And Mitigations

- Google auth scope could sprawl:
  Keep this slice Calendar-read-only and avoid designing shared Google plumbing
  for unrelated products.
- Raw provider payloads could leak into the agent surface:
  Normalize results at the CLI boundary and test the exact output shape.
- Integration UX could become confusing if it overfits one provider:
  Reuse the existing provider-picker/settings pattern rather than inventing a new
  screen.

## Decision

Implement the minimal real integration approach: end-to-end read-only Google
Calendar support via `gcal list` and `gcal read`, using the existing shell tool
architecture and desktop-managed credential boundary.
