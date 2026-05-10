# Google Workspace Client Next Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the bundled Google Workspace CLI bridge into a reliable Tessera Workspace client for Calendar, Gmail, Drive, Contacts, Docs, and Sheets, with clear connected state, explicit scopes, higher-fidelity read results, and a foundation for approval-gated writes.

**Architecture:** Keep `@googleworkspace/cli` as the only Google API execution layer. Tessera owns the product contract: provider naming, scope profiles, normalized result schemas, command UX, and approval boundaries. This phase should preserve the current `gcal`, `mail`, `drive`, and `contacts` shell commands while adding compatibility-safe contracts and better command behavior behind them.

**Tech Stack:** TypeScript, Bun tests, Zod contracts, Rust/Tauri commands, bundled `gws 0.22.5`, React Settings UI, existing shell runtime and CLI catalog.

---

## Current State

- `@googleworkspace/cli@0.22.5` is bundled into Tauri `externalBin` as `gws`.
- Desktop Rust owns app-scoped `gws` config paths and exposes `google_workspace_connect` / `google_workspace_disconnect`.
- Settings has a single Google Workspace integration panel and no longer stores direct Calendar REST API keys.
- CLI supports read commands for:
  - `gcal list`
  - `gcal read`
  - `mail list`
  - `mail search`
  - `mail read`
  - `drive search`
  - `drive read`
  - `contacts lookup`
- Docs and Sheets are currently reachable through `drive read`.

## Primary Risks To Fix

- Provider naming is still internally `google-calendar`, which will keep leaking Calendar-only assumptions.
- `mail list` can return low-value records because Gmail list responses are mostly IDs unless Tessera hydrates metadata with `messages.get`.
- `drive read` supports Google Docs and a single-sheet spreadsheet path, but does not expose ranges or multi-sheet selection.
- OAuth login currently depends on build-time client env and does not explicitly request a Tessera-owned read-only service profile.
- Settings can say "connected" but cannot show per-service health, missing scopes, or which Workspace services Tessera can use.
- Write commands exist in catalog placeholders but are not ready for safe execution.

## File Structure

- Modify `packages/contracts/src/index.ts`
  - Add `GoogleWorkspaceProviderSchema`, capability state schemas, and compatibility-safe integration read shapes.
  - Add richer Gmail, Drive, Docs, Sheets payload fields without breaking existing parsers.
- Modify `packages/contracts/src/integration-settings.test.ts`
  - Lock migration and payload compatibility behavior.
- Modify `apps/desktop/src-tauri/src/integration_settings.rs`
  - Persist a Google Workspace connected state and expose `googleWorkspace` while keeping `googleCalendar` as a legacy read alias during migration.
- Modify `apps/desktop/src-tauri/src/lib.rs`
  - Add explicit read-only OAuth profile args and per-service health checks.
- Modify `apps/desktop/ui/src/components/SettingsView.tsx`
  - Rename the card to Google Workspace and render service health rows.
- Modify `apps/desktop/ui/src/components/SettingsView.test.tsx`
  - Cover connect copy, health rendering, and legacy settings hydration.
- Modify `apps/cli/src/google-connector.ts`
  - Hydrate Gmail summaries, add Sheets range support, and improve Drive export handling.
- Modify `apps/cli/src/shell.ts`
  - Add argument parsing for `drive read --range`, `drive read --sheet`, and bounded hydrated mail list behavior.
- Modify `apps/cli/src/shell.test.ts`
  - Lock `gws` args and normalized output for hydrated Gmail and Sheets ranges.
- Modify `packages/core/src/cli-catalog.ts`
  - Keep read commands allowlisted and write commands blocked until write approval is implemented.
- Modify `packages/core/src/shell-runtime.ts`
  - Parse new optional fields while accepting old payloads.

---

### Task 1: Rename Integration Contract To Google Workspace With Legacy Compatibility

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/integration-settings.test.ts`
- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`

- [ ] **Step 1: Write failing contract tests**

Add tests that prove new reads expose `googleWorkspace` and old persisted settings with `googleCalendar` still parse:

```ts
test("integration settings exposes google workspace provider", () => {
  const parsed = IntegrationSettingsReadSchema.parse({
    providers: {
      braveSearch: { provider: "brave-search", hasCredential: false },
      googleWorkspace: { provider: "google-workspace", hasCredential: true },
      googleCalendar: { provider: "google-calendar", hasCredential: true },
    },
    search: {
      mode: "auto",
      allowKeylessFallback: true,
      providers: {
        braveSearch: { provider: "brave-search", hasCredential: false },
        tavily: { provider: "tavily", hasCredential: false },
        duckduckgo: { provider: "duckduckgo", hasCredential: false },
      },
    },
  });

  expect(parsed.providers.googleWorkspace.hasCredential).toBe(true);
  expect(parsed.providers.googleCalendar.hasCredential).toBe(true);
});
```

Run:

```bash
bun test packages/contracts/src/integration-settings.test.ts
```

Expected: fail until `google-workspace` and `googleWorkspace` are added.

- [ ] **Step 2: Extend contract schema compatibly**

In `packages/contracts/src/index.ts`, change provider enum and provider read shape:

```ts
export const GoogleWorkspaceProviderSchema = z.literal("google-workspace");

export const IntegrationProviderSchema = z.enum([
  "brave-search",
  "google-calendar",
  "google-workspace",
]);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

const GoogleWorkspaceIntegrationSettingsSchema = z.object({
  provider: z.literal("google-workspace"),
  hasCredential: z.boolean().default(false),
});
```

Then include both keys in `IntegrationSettingsReadSchema.providers`:

```ts
providers: z.object({
  braveSearch: BraveSearchIntegrationSettingsSchema,
  googleCalendar: GoogleCalendarIntegrationSettingsSchema,
  googleWorkspace: GoogleWorkspaceIntegrationSettingsSchema,
}),
```

Keep `googleCalendar` for one release as a deprecated alias so older UI/test fixtures do not break.

- [ ] **Step 3: Add Rust migration behavior**

In `apps/desktop/src-tauri/src/integration_settings.rs`, keep the persisted file small but return both read aliases:

```rust
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsRead {
    pub brave_search: ProviderRead,
    pub google_calendar: ProviderRead,
    pub google_workspace: ProviderRead,
}
```

When redacting, derive both `google_calendar.has_credential` and `google_workspace.has_credential` from the same persisted Google Workspace connection flag.

- [ ] **Step 4: Verify**

Run:

```bash
bun test packages/contracts/src/integration-settings.test.ts
cargo test integration_settings
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/integration-settings.test.ts apps/desktop/src-tauri/src/integration_settings.rs
git commit -m "Expose Google Workspace integration contract"
```

---

### Task 2: Add Explicit Read-Only OAuth Profile And Service Health

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`
- Modify: `apps/desktop/ui/src/components/SettingsView.tsx`
- Modify: `apps/desktop/ui/src/components/SettingsView.test.tsx`

- [ ] **Step 1: Write failing Rust tests for auth args**

Add a pure helper in `lib.rs`:

```rust
fn google_workspace_readonly_auth_args() -> Vec<&'static str> {
    vec![
        "auth",
        "login",
        "--readonly",
        "--services",
        "calendar,gmail,drive,people,docs,sheets",
    ]
}
```

Add a test:

```rust
#[test]
fn google_workspace_auth_uses_readonly_multi_service_profile() {
    assert_eq!(
        google_workspace_readonly_auth_args(),
        vec![
            "auth",
            "login",
            "--readonly",
            "--services",
            "calendar,gmail,drive,people,docs,sheets"
        ]
    );
}
```

Run:

```bash
cargo test google_workspace_auth_uses_readonly_multi_service_profile
```

Expected: fail until the helper is added and `google_workspace_connect` uses it.

- [ ] **Step 2: Use the profile in connect**

Change `google_workspace_connect` to call:

```rust
run_google_workspace_cli_command(app.clone(), &google_workspace_readonly_auth_args()).await
```

This uses `gws auth login --readonly --services calendar,gmail,drive,people,docs,sheets`, which is supported by the bundled `gws 0.22.5` help output.

- [ ] **Step 3: Add service health command result**

Add a Tauri command `google_workspace_health` returning:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleWorkspaceServiceHealth {
    service: String,
    ok: bool,
    message: String,
}
```

Health checks should run low-cost commands:

```text
gcal list --limit 1
mail list --limit 1
drive search "*" --limit 1
contacts lookup test --limit 1
```

Use the existing `run_workspace_cli_command` path so health checks validate Tessera's actual adapter, not only raw `gws`.

- [ ] **Step 4: Update Settings UI**

Render rows for Calendar, Gmail, Drive, Contacts, Docs, and Sheets:

```tsx
const GOOGLE_WORKSPACE_CAPABILITIES = [
  "Calendar",
  "Gmail",
  "Drive",
  "Contacts",
  "Docs",
  "Sheets",
];
```

When disconnected, show:

```text
Connect once to let Tessera read Calendar, Gmail, Drive, Contacts, Docs, and Sheets with Google Workspace.
```

When connected, show:

```text
Connected with read-only access.
```

- [ ] **Step 5: Verify**

Run:

```bash
cargo test google_workspace
bun test apps/desktop/ui/src/components/SettingsView.test.tsx
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/integration_settings.rs apps/desktop/ui/src/components/SettingsView.tsx apps/desktop/ui/src/components/SettingsView.test.tsx
git commit -m "Use read-only Workspace auth profile"
```

---

### Task 3: Hydrate Gmail List And Search Results

**Files:**
- Modify: `apps/cli/src/google-connector.ts`
- Modify: `apps/cli/src/shell.test.ts`

- [ ] **Step 1: Write failing CLI test**

Add a test that proves `mail list` first calls `messages.list`, then calls `messages.get` with `format: "metadata"` for each returned ID:

```ts
test("hydrates mail list summaries with metadata", async () => {
  const calls: string[][] = [];
  const result = await executeCliCommand(["mail", "list", "--limit", "2"], {
    runGwsCli: async (args) => {
      calls.push(args);
      if (args.includes("list")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          id: args[args.indexOf("--params") + 1]?.includes("m1") ? "m1" : "m2",
          threadId: "t1",
          payload: {
            headers: [
              { name: "Subject", value: "Meeting prep" },
              { name: "From", value: "Alex <alex@example.com>" },
              { name: "Date", value: "Sat, 09 May 2026 09:00:00 +0000" },
            ],
          },
          snippet: "Review pricing",
          labelIds: ["INBOX"],
        }),
        stderr: "",
      };
    },
  });

  expect(result.exitCode).toBe(0);
  expect(calls.filter((call) => call.includes("get"))).toHaveLength(2);
  expect(JSON.parse(result.stdout).messages[0]).toMatchObject({
    id: "m1",
    subject: "Meeting prep",
    from: "Alex <alex@example.com>",
  });
});
```

- [ ] **Step 2: Implement bounded hydration**

In `listMailMessages`, after extracting IDs, call:

```ts
async function hydrateMailSummary(
  options: { runGwsCli: (args: string[]) => Promise<CommandResult> },
  messageId: string
): Promise<Record<string, unknown>> {
  return runGwsJson(options, [
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date", "To", "Cc"],
    }),
  ]).then((payload) => (isRecord(payload) ? payload : { id: messageId }));
}
```

Use `Promise.all` for the current limit. Keep the max parser limit capped at 25 in `parseMailListArgs` to avoid slow fan-out.

- [ ] **Step 3: Verify**

Run:

```bash
bun test apps/cli/src/shell.test.ts
```

Expected: shell tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/google-connector.ts apps/cli/src/shell.test.ts
git commit -m "Hydrate Gmail command summaries"
```

---

### Task 4: Add Sheets Range And Multi-Sheet Read Support

**Files:**
- Modify: `apps/cli/src/shell.ts`
- Modify: `apps/cli/src/google-connector.ts`
- Modify: `apps/cli/src/shell.test.ts`

- [ ] **Step 1: Write failing range test**

Add a test for:

```bash
drive read sheet-1 --format json --sheet Pipeline --range A1:C3
```

Expected `gws` values call params:

```json
{
  "spreadsheetId": "sheet-1",
  "range": "'Pipeline'!A1:C3"
}
```

- [ ] **Step 2: Extend shell args**

Change `parseDriveReadArgs` to return:

```ts
{
  fileId: string;
  format: "text" | "markdown" | "csv" | "json";
  sheet?: string;
  range?: string;
}
```

Accept only A1-style ranges with:

```ts
/^[A-Z]+[1-9][0-9]*:[A-Z]+[1-9][0-9]*$/
```

- [ ] **Step 3: Extend connector request**

Change `readDriveFile` request to:

```ts
readDriveFile(request: {
  fileId: string;
  format: "text" | "markdown" | "csv" | "json";
  sheet?: string;
  range?: string;
}): Promise<DriveReadResult>;
```

For Sheets:
- if `sheet` and `range` are provided, read exactly that range
- if neither is provided and the file has one sheet, keep current first-sheet behavior
- if multiple sheets exist and no sheet is provided, return a clear error listing the sheet names

- [ ] **Step 4: Verify**

Run:

```bash
bun test apps/cli/src/shell.test.ts
bun test packages/core/src/shell-runtime.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/shell.ts apps/cli/src/google-connector.ts apps/cli/src/shell.test.ts
git commit -m "Support Google Sheets range reads"
```

---

### Task 5: Improve Drive Export Fidelity For Docs And Binary Files

**Files:**
- Modify: `apps/cli/src/google-connector.ts`
- Modify: `apps/cli/src/shell.test.ts`

- [ ] **Step 1: Write failing Docs export test**

Add a test that proves Google Docs reads prefer Drive export when `--format markdown` is requested:

```ts
test("exports google docs as text through drive export", async () => {
  const calls: string[][] = [];
  const result = await executeCliCommand(["drive", "read", "doc-1", "--format", "markdown"], {
    runGwsCli: async (args) => {
      calls.push(args);
      if (args.includes("get")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "doc-1",
            name: "Brief",
            mimeType: "application/vnd.google-apps.document",
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "Brief body", stderr: "" };
    },
  });

  expect(result.exitCode).toBe(0);
  expect(calls.some((call) => call.includes("export"))).toBe(true);
  expect(JSON.parse(result.stdout).file.text).toBe("Brief body");
});
```

- [ ] **Step 2: Prefer export for Docs**

For Google Docs, call:

```text
gws drive files export --params {"fileId":"doc-1","mimeType":"text/plain"}
```

Keep the current `docs documents get` text walker as fallback if export fails.

- [ ] **Step 3: Make binary files explicit**

For non-Google binary MIME types, return a clear error unless `--format text`, `--format csv`, or `--format json` can parse the raw media output:

```text
Drive file "..." is binary or unsupported for text extraction. Download/open it from Drive instead.
```

- [ ] **Step 4: Verify**

Run:

```bash
bun test apps/cli/src/shell.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/google-connector.ts apps/cli/src/shell.test.ts
git commit -m "Improve Drive document extraction"
```

---

### Task 6: Prepare Approval-Gated Write Commands Without Enabling Them

**Files:**
- Modify: `packages/core/src/cli-catalog.ts`
- Modify: `packages/core/src/shell-runtime.test.ts`
- Modify: `apps/cli/src/shell.ts`

- [ ] **Step 1: Write tests that writes remain blocked**

Add tests for:

```ts
expect(() =>
  validateShellCall({ command: "mail", subcommand: "send", args: [] })
).toThrow("Unsupported shell command");

expect(() =>
  validateShellCall({ command: "drive", subcommand: "delete", args: [] })
).toThrow("Unsupported shell command");
```

- [ ] **Step 2: Add a write roadmap comment in catalog**

Keep the catalog read-only for Google Workspace except existing ask-placeholder commands. Add a short comment:

```ts
// Google Workspace write commands require a separate write-scope auth profile,
// dry-run previews, and Action Inbox approval before they are exposed here.
```

- [ ] **Step 3: Ensure CLI rejects unimplemented writes clearly**

In `apps/cli/src/shell.ts`, unknown write attempts should keep returning:

```text
Unknown command: mail send
```

Do not add `mail send`, `drive create`, `docs update`, or `sheets update` implementation in this phase.

- [ ] **Step 4: Verify**

Run:

```bash
bun test packages/core/src/shell-runtime.test.ts apps/cli/src/shell.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli-catalog.ts packages/core/src/shell-runtime.test.ts apps/cli/src/shell.ts
git commit -m "Keep Workspace writes behind approval design"
```

---

## Full Verification

Run after all tasks:

```bash
bun run build:sidecar
bun test apps/cli/src/shell.test.ts packages/core/src/shell-runtime.test.ts packages/contracts/src/integration-settings.test.ts apps/desktop/ui/src/components/SettingsView.test.tsx
cargo test integration_settings
cargo test google_workspace
bun run check
apps/desktop/src-tauri/binaries/gws-aarch64-apple-darwin auth login --help
```

Expected:
- `build:sidecar` copies `gws 0.22.5`.
- Bun tests pass.
- Rust tests pass.
- `bun run check` passes.
- `gws auth login --help` still shows `--readonly`, `--full`, `--scopes`, and `--services`.

Manual smoke, only when a real Google OAuth client is configured for the build:

```bash
TESSERA_GOOGLE_WORKSPACE_CLIENT_ID=<client-id> \
TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET=<client-secret> \
bun run --filter './apps/desktop/ui' dev
```

Then in Settings > Integrations:
1. Click **Connect Google Workspace**.
2. Complete Google OAuth.
3. Click **Test connection**.
4. Run a playbook that needs Calendar, Gmail, Drive, and Contacts context.

## Execution Order

1. Task 1 first, because provider naming and compatibility affect Settings and Tauri.
2. Task 2 next, because scope profile and health explain what the integration can actually do.
3. Task 3 and Task 4 can be implemented independently after Task 2.
4. Task 5 depends only on the current Drive read path.
5. Task 6 last, after read behavior is stable.

## Remaining Deliberate Deferrals

- Gmail send/reply/draft creation.
- Calendar create/update/delete.
- Drive create/update/delete/upload.
- Docs and Sheets editing.
- Incremental sync or background indexing.
- Admin, Chat, Meet, Slides, Forms, Keep, Classroom, and Tasks services.

These should be separate plans because they introduce write scopes, user approvals, audit records, and rollback expectations.
