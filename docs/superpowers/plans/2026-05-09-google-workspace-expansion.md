# Google Workspace Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Tessera's Google Workspace integration beyond Calendar to support read-first Gmail, Drive, Contacts, Google Docs, and Google Sheets through the existing shell/tool surface.

**Architecture:** Keep one user-facing Google Workspace integration and one internal `GoogleWorkspaceConnector`. Add stable Tessera-owned schemas and shell commands for Gmail, Drive, and Contacts; cover Docs and Sheets through `drive read` export/normalization first because Docs and Sheets are Drive file types. Keep write actions out of this slice except the existing approval-gated command catalog placeholders.

**Tech Stack:** TypeScript, Bun tests, Zod contracts in `@tessera/contracts`, `gws` Google Workspace CLI subprocess adapter, existing shell runtime and CLI catalog.

---

## Current State

- `apps/cli/src/google-connector.ts` implements Calendar-only `GoogleWorkspaceConnector`.
- `apps/cli/src/shell.ts` handles `gcal list` and `gcal read` only.
- `packages/core/src/cli-catalog.ts` already lists `mail`, `drive`, and `contacts`, but CLI execution currently returns `Unknown command`.
- `packages/contracts/src/index.ts` has Calendar payload schemas but no Gmail/Drive/Contacts/Docs/Sheets result schemas.
- `packages/core/src/shell-runtime.ts` parses Calendar payloads, but passes unknown command payloads through raw JSON.
- Settings now correctly presents one **Google Workspace** integration.

## Scope

Implement read-first commands:

- `mail list [--limit <n>] [--query <q>]`
- `mail search <query> [--limit <n>]`
- `mail read <message-id>`
- `drive search <query> [--limit <n>]`
- `drive read <file-id> [--format text|markdown|csv|json]`
- `contacts lookup <query> [--limit <n>]`

Docs and Sheets are included through `drive read`:

- Google Docs: export as text or markdown-like text.
- Google Sheets: read values as structured tables when the file MIME type is a spreadsheet, with optional future `--range` support after the base path works.

Out of scope for this plan:

- Sending email.
- Creating/editing Drive files.
- Creating/editing Docs or Sheets.
- New OAuth setup UI. Existing `gws auth setup/login` remains the connection path.
- Adding separate `docs` and `sheets` shell command names in this slice.

## File Structure

- Modify `packages/contracts/src/index.ts`
  - Add normalized result schemas for mail, drive, and contacts.
  - Export inferred TypeScript result types.
- Modify `packages/contracts/src/integration-settings.test.ts`
  - Add schema coverage for new payloads.
- Modify `apps/cli/src/google-connector.ts`
  - Extend `GoogleWorkspaceConnector` with Gmail, Drive, and Contacts methods.
  - Keep all `gws` command construction and response normalization inside this file.
- Modify `apps/cli/src/shell.ts`
  - Add command routing and argument parsing for `mail`, `drive`, and `contacts`.
- Modify `apps/cli/src/shell.test.ts`
  - Add adapter-driven command tests that assert `gws` arguments and normalized stdout.
- Modify `packages/core/src/shell-runtime.ts`
  - Parse the new command payloads using contract schemas.
- Modify `packages/core/src/shell-runtime.test.ts`
  - Add runtime parsing tests for `mail`, `drive`, and `contacts`.
- Modify `apps/cli/src/index.ts`
  - Update CLI help to list `mail`, `drive`, and `contacts`.
- Modify `apps/desktop/ui/src/components/SettingsView.tsx`
  - Update Google Workspace copy to list enabled capabilities.
- Modify `apps/desktop/ui/src/components/SettingsView.test.tsx`
  - Update copy assertions.

---

### Task 1: Add Shared Payload Contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/integration-settings.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add these tests to `packages/contracts/src/integration-settings.test.ts` near the Calendar payload tests:

```ts
test("parses normalized mail list payloads", () => {
  const parsed = MailListResultSchema.parse({
    messages: [
      {
        id: "msg-1",
        threadId: "thread-1",
        subject: "Meeting prep",
        from: "Alex <alex@example.com>",
        date: "2026-05-09T09:00:00Z",
        snippet: "Can we review pricing before the call?",
        labels: ["INBOX", "UNREAD"],
      },
    ],
  });

  expect(parsed.messages[0]?.subject).toBe("Meeting prep");
});

test("parses normalized mail read payloads", () => {
  const parsed = MailReadResultSchema.parse({
    message: {
      id: "msg-1",
      threadId: "thread-1",
      subject: "Meeting prep",
      from: "Alex <alex@example.com>",
      to: ["sales@example.com"],
      date: "2026-05-09T09:00:00Z",
      text: "Can we review pricing before the call?",
      labels: ["INBOX"],
    },
  });

  expect(parsed.message.text).toContain("pricing");
});

test("parses normalized drive search payloads", () => {
  const parsed = DriveSearchResultSchema.parse({
    files: [
      {
        id: "file-1",
        name: "Discovery Notes",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-05-08T12:00:00Z",
        webViewLink: "https://docs.google.com/document/d/file-1/edit",
      },
    ],
  });

  expect(parsed.files[0]?.name).toBe("Discovery Notes");
});

test("parses normalized drive read payloads", () => {
  const parsed = DriveReadResultSchema.parse({
    file: {
      id: "file-1",
      name: "Discovery Notes",
      mimeType: "application/vnd.google-apps.document",
      text: "Customer notes",
    },
  });

  expect(parsed.file.text).toBe("Customer notes");
});

test("parses normalized contacts lookup payloads", () => {
  const parsed = ContactsLookupResultSchema.parse({
    contacts: [
      {
        resourceName: "people/c1",
        displayName: "Alex Rivera",
        emailAddresses: ["alex@example.com"],
        phoneNumbers: ["+1 555 0100"],
        organizations: ["Fomora"],
      },
    ],
  });

  expect(parsed.contacts[0]?.emailAddresses[0]).toBe("alex@example.com");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test packages/contracts/src/integration-settings.test.ts
```

Expected: fail with missing imports/names such as `MailListResultSchema`.

- [ ] **Step 3: Add schemas and type exports**

Add this block in `packages/contracts/src/index.ts` after the Calendar schemas:

```ts
export const MailMessageSummarySchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  subject: z.string().default("(no subject)"),
  from: z.string().optional(),
  date: z.string().optional(),
  snippet: z.string().optional(),
  labels: z.array(z.string()).default([]),
});
export type MailMessageSummary = z.infer<typeof MailMessageSummarySchema>;

export const MailListResultSchema = z.object({
  messages: z.array(MailMessageSummarySchema),
});
export type MailListResult = z.infer<typeof MailListResultSchema>;

export const MailReadResultSchema = z.object({
  message: MailMessageSummarySchema.extend({
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    text: z.string().default(""),
    html: z.string().optional(),
  }),
});
export type MailReadResult = z.infer<typeof MailReadResultSchema>;

export const DriveFileSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  modifiedTime: z.string().optional(),
  webViewLink: z.string().url().optional(),
});
export type DriveFileSummary = z.infer<typeof DriveFileSummarySchema>;

export const DriveSearchResultSchema = z.object({
  files: z.array(DriveFileSummarySchema),
});
export type DriveSearchResult = z.infer<typeof DriveSearchResultSchema>;

export const DriveReadResultSchema = z.object({
  file: DriveFileSummarySchema.extend({
    text: z.string().optional(),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional(),
  }),
});
export type DriveReadResult = z.infer<typeof DriveReadResultSchema>;

export const ContactSummarySchema = z.object({
  resourceName: z.string().min(1),
  displayName: z.string().min(1),
  emailAddresses: z.array(z.string()).default([]),
  phoneNumbers: z.array(z.string()).default([]),
  organizations: z.array(z.string()).default([]),
});
export type ContactSummary = z.infer<typeof ContactSummarySchema>;

export const ContactsLookupResultSchema = z.object({
  contacts: z.array(ContactSummarySchema),
});
export type ContactsLookupResult = z.infer<typeof ContactsLookupResultSchema>;
```

- [ ] **Step 4: Import schemas in tests**

Update the test imports in `packages/contracts/src/integration-settings.test.ts` to include:

```ts
ContactsLookupResultSchema,
DriveReadResultSchema,
DriveSearchResultSchema,
MailListResultSchema,
MailReadResultSchema,
```

- [ ] **Step 5: Run tests to verify pass**

Run:

```bash
bun test packages/contracts/src/integration-settings.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/integration-settings.test.ts
git commit -m "feat(contracts): add workspace payload schemas"
```

---

### Task 2: Extend the Google Workspace Connector Interface

**Files:**
- Modify: `apps/cli/src/google-connector.ts`

- [ ] **Step 1: Add contract imports**

Update the import block:

```ts
import type {
  ContactsLookupResult,
  DriveReadResult,
  DriveSearchResult,
  GcalListResult,
  GcalReadResult,
  MailListResult,
  MailReadResult,
} from "@tessera/contracts";
import {
  ContactsLookupResultSchema,
  DriveReadResultSchema,
  DriveSearchResultSchema,
  GcalListResultSchema,
  GcalReadResultSchema,
  MailListResultSchema,
  MailReadResultSchema,
} from "@tessera/contracts";
```

- [ ] **Step 2: Extend connector interface**

Add these methods to `GoogleWorkspaceConnector`:

```ts
listMail(request: { limit: number; query?: string }): Promise<MailListResult>;
searchMail(request: { query: string; limit: number }): Promise<MailListResult>;
readMail(request: { messageId: string }): Promise<MailReadResult>;
searchDrive(request: { query: string; limit: number }): Promise<DriveSearchResult>;
readDriveFile(request: { fileId: string; format: "text" | "markdown" | "csv" | "json" }): Promise<DriveReadResult>;
lookupContacts(request: { query: string; limit: number }): Promise<ContactsLookupResult>;
```

- [ ] **Step 3: Add helper normalizer shells**

Add these functions below the Calendar normalizers:

```ts
function extractArray(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function normalizeMailSummary(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: stringField(item, "id"),
    threadId: stringField(item, "threadId"),
    subject: stringField(item, "subject") || headerValue(item, "Subject") || "(no subject)",
    from: stringField(item, "from") || headerValue(item, "From"),
    date: stringField(item, "date") || headerValue(item, "Date"),
    snippet: stringField(item, "snippet"),
    labels: Array.isArray(item.labelIds) ? item.labelIds.filter((value) => typeof value === "string") : [],
  };
}

function headerValue(item: Record<string, unknown>, name: string): string {
  const payload = item.payload;
  if (!isRecord(payload) || !Array.isArray(payload.headers)) return "";
  const header = payload.headers.filter(isRecord).find((value) => value.name === name);
  return typeof header?.value === "string" ? header.value : "";
}

function normalizeDriveFile(item: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    id: stringField(item, "id"),
    name: stringField(item, "name") || "Untitled",
    mimeType: stringField(item, "mimeType"),
  };
  copyStringField(item, normalized, "modifiedTime");
  copyStringField(item, normalized, "webViewLink");
  return normalized;
}

function normalizeContact(item: Record<string, unknown>): Record<string, unknown> {
  return {
    resourceName: stringField(item, "resourceName"),
    displayName: firstString(item.names, "displayName") || "Unnamed contact",
    emailAddresses: stringArray(item.emailAddresses, "value"),
    phoneNumbers: stringArray(item.phoneNumbers, "value"),
    organizations: stringArray(item.organizations, "name"),
  };
}

function firstString(value: unknown, key: string): string {
  if (!Array.isArray(value)) return "";
  const record = value.filter(isRecord).find((item) => typeof item[key] === "string");
  return record && typeof record[key] === "string" ? record[key] : "";
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => item[key]).filter((item): item is string => typeof item === "string" && item.length > 0);
}
```

- [ ] **Step 4: Run typecheck to verify new interface compiles after Task 3 implementation**

Do not run yet if Task 3 is not implemented. This task intentionally adds method signatures that Task 3 will fulfill.

---

### Task 3: Implement Gmail, Drive, and Contacts Adapter Methods

**Files:**
- Modify: `apps/cli/src/google-connector.ts`
- Test: `apps/cli/src/shell.test.ts` in Task 5

- [ ] **Step 1: Implement Gmail list/search/read**

Inside `createGwsGoogleWorkspaceConnector`, add:

```ts
async listMail(request) {
  const payload = await runGwsJson(options, [
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
    JSON.stringify({
      userId: "me",
      maxResults: request.limit,
      ...(request.query ? { q: request.query } : {}),
    }),
  ]);
  return MailListResultSchema.parse({
    messages: extractArray(payload, ["messages"]).map((message) => normalizeMailSummary(message)),
  });
},

async searchMail(request) {
  return this.listMail(request);
},

async readMail(request) {
  const payload = await runGwsJson(options, [
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify({
      userId: "me",
      id: request.messageId,
      format: "full",
    }),
  ]);
  const message = isRecord(payload) ? payload : {};
  return MailReadResultSchema.parse({
    message: {
      ...normalizeMailSummary(message),
      to: headerValue(message, "To").split(",").map((item) => item.trim()).filter(Boolean),
      cc: headerValue(message, "Cc").split(",").map((item) => item.trim()).filter(Boolean),
      text: decodeMailText(message),
    },
  });
},
```

Also add:

```ts
function decodeMailText(item: Record<string, unknown>): string {
  const payload = item.payload;
  if (!isRecord(payload)) return stringField(item, "text");
  const direct = decodeBase64Url(stringField(payload, "body.data"));
  if (direct) return direct;
  if (!Array.isArray(payload.parts)) return "";
  for (const part of payload.parts.filter(isRecord)) {
    if (part.mimeType === "text/plain") {
      const body = part.body;
      if (isRecord(body)) return decodeBase64Url(stringField(body, "data"));
    }
  }
  return "";
}

function decodeBase64Url(value: string): string {
  if (!value) return "";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8").trim();
}
```

- [ ] **Step 2: Implement Drive search/read**

Inside `createGwsGoogleWorkspaceConnector`, add:

```ts
async searchDrive(request) {
  const payload = await runGwsJson(options, [
    "drive",
    "files",
    "list",
    "--params",
    JSON.stringify({
      pageSize: request.limit,
      q: `name contains '${escapeDriveQuery(request.query)}' or fullText contains '${escapeDriveQuery(request.query)}'`,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    }),
  ]);
  return DriveSearchResultSchema.parse({
    files: extractArray(payload, ["files"]).map((file) => normalizeDriveFile(file)),
  });
},

async readDriveFile(request) {
  const metadataPayload = await runGwsJson(options, [
    "drive",
    "files",
    "get",
    "--params",
    JSON.stringify({
      fileId: request.fileId,
      fields: "id,name,mimeType,modifiedTime,webViewLink",
    }),
  ]);
  const metadata = normalizeDriveFile(isRecord(metadataPayload) ? metadataPayload : {});
  const content = await readDriveContent(options, request.fileId, stringField(metadata, "mimeType"), request.format);
  return DriveReadResultSchema.parse({
    file: {
      ...metadata,
      ...content,
    },
  });
},
```

Add helpers:

```ts
function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function readDriveContent(
  options: { runGwsCli: (args: string[]) => Promise<CommandResult> },
  fileId: string,
  mimeType: string,
  format: "text" | "markdown" | "csv" | "json"
): Promise<Record<string, unknown>> {
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    const payload = await runGwsJson(options, [
      "sheets",
      "spreadsheets",
      "values",
      "get",
      "--params",
      JSON.stringify({ spreadsheetId: fileId, range: "A1:Z100" }),
    ]);
    return { rows: Array.isArray((payload as { values?: unknown }).values) ? (payload as { values: unknown[] }).values : [] };
  }

  if (mimeType === "application/vnd.google-apps.document") {
    const payload = await runGwsJson(options, [
      "docs",
      "documents",
      "get",
      "--params",
      JSON.stringify({ documentId: fileId }),
    ]);
    return { text: extractDocText(payload) };
  }

  const payload = await runGwsJson(options, [
    "drive",
    "files",
    "get",
    "--params",
    JSON.stringify({ fileId, alt: "media" }),
  ]);
  return { text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) };
}

function extractDocText(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const body = payload.body;
  if (!isRecord(body) || !Array.isArray(body.content)) return "";
  const parts: string[] = [];
  for (const block of body.content.filter(isRecord)) {
    const paragraph = block.paragraph;
    if (!isRecord(paragraph) || !Array.isArray(paragraph.elements)) continue;
    for (const element of paragraph.elements.filter(isRecord)) {
      const textRun = element.textRun;
      if (isRecord(textRun) && typeof textRun.content === "string") parts.push(textRun.content);
    }
  }
  return parts.join("").trim();
}
```

- [ ] **Step 3: Implement Contacts lookup**

Inside `createGwsGoogleWorkspaceConnector`, add:

```ts
async lookupContacts(request) {
  const payload = await runGwsJson(options, [
    "people",
    "people",
    "searchContacts",
    "--params",
    JSON.stringify({
      query: request.query,
      pageSize: request.limit,
      readMask: "names,emailAddresses,phoneNumbers,organizations",
    }),
  ]);
  return ContactsLookupResultSchema.parse({
    contacts: extractArray(payload, ["results"])
      .map((result) => (isRecord(result.person) ? result.person : result))
      .map((person) => normalizeContact(person)),
  });
},
```

- [ ] **Step 4: Verify connector typecheck**

Run:

```bash
bun run --filter './apps/cli' typecheck
```

Expected: pass.

---

### Task 4: Add CLI Argument Parsing and Command Routing

**Files:**
- Modify: `apps/cli/src/shell.ts`

- [ ] **Step 1: Add command handlers in `executeCliCommand`**

Add after `gcal` handlers:

```ts
if (command === "mail" && subcommand === "list") {
  const payload = await runMailList(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

if (command === "mail" && subcommand === "search") {
  const payload = await runMailSearch(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

if (command === "mail" && subcommand === "read") {
  const payload = await runMailRead(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

if (command === "drive" && subcommand === "search") {
  const payload = await runDriveSearch(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

if (command === "drive" && subcommand === "read") {
  const payload = await runDriveRead(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

if (command === "contacts" && subcommand === "lookup") {
  const payload = await runContactsLookup(args, options);
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}
```

- [ ] **Step 2: Add argument parsers**

Add below Calendar parsers:

```ts
function parseLimitFlag(args: string[], usage: string, defaultLimit = 10): { limit: number; rest: string[] } {
  const rest: string[] = [];
  let limit = defaultLimit;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed <= 0) throw new CliCommandError(usage);
      limit = parsed;
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { limit, rest };
}

function parseMailListArgs(args: string[]): { limit: number; query?: string } {
  const { limit, rest } = parseLimitFlag(args, "Usage: mail list [--limit <n>] [--query <q>]");
  const queryIndex = rest.indexOf("--query");
  if (queryIndex === -1) {
    if (rest.length > 0) throw new CliCommandError("Usage: mail list [--limit <n>] [--query <q>]");
    return { limit };
  }
  const query = rest[queryIndex + 1]?.trim();
  if (!query || rest.length !== 2) throw new CliCommandError("Usage: mail list [--limit <n>] [--query <q>]");
  return { limit, query };
}

function parseRequiredQuery(args: string[], usage: string): { query: string; limit: number } {
  const { limit, rest } = parseLimitFlag(args, usage);
  const query = rest.join(" ").trim();
  if (!query) throw new CliCommandError(usage);
  return { query, limit };
}

function parseReadId(args: string[], usage: string): string {
  const id = args[0]?.trim();
  if (!id || args.length !== 1) throw new CliCommandError(usage);
  return id;
}

function parseDriveReadArgs(args: string[]): { fileId: string; format: "text" | "markdown" | "csv" | "json" } {
  const fileId = args[0]?.trim();
  if (!fileId) throw new CliCommandError("Usage: drive read <file-id> [--format text|markdown|csv|json]");
  let format: "text" | "markdown" | "csv" | "json" = "text";
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--format") throw new CliCommandError("Usage: drive read <file-id> [--format text|markdown|csv|json]");
    const value = args[index + 1];
    if (!["text", "markdown", "csv", "json"].includes(value ?? "")) {
      throw new CliCommandError("Usage: drive read <file-id> [--format text|markdown|csv|json]");
    }
    format = value as "text" | "markdown" | "csv" | "json";
    index += 1;
  }
  return { fileId, format };
}
```

- [ ] **Step 3: Add runner functions**

Add below `runGcalRead`:

```ts
async function runMailList(args: string[], options: ExecuteCliCommandOptions) {
  return createGoogleWorkspaceConnector(options).listMail(parseMailListArgs(args));
}

async function runMailSearch(args: string[], options: ExecuteCliCommandOptions) {
  return createGoogleWorkspaceConnector(options).searchMail(
    parseRequiredQuery(args, "Usage: mail search <query> [--limit <n>]")
  );
}

async function runMailRead(args: string[], options: ExecuteCliCommandOptions) {
  return createGoogleWorkspaceConnector(options).readMail({
    messageId: parseReadId(args, "Usage: mail read <message-id>"),
  });
}

async function runDriveSearch(args: string[], options: ExecuteCliCommandOptions) {
  return createGoogleWorkspaceConnector(options).searchDrive(
    parseRequiredQuery(args, "Usage: drive search <query> [--limit <n>]")
  );
}

async function runDriveRead(args: string[], options: ExecuteCliCommandOptions) {
  return createGoogleWorkspaceConnector(options).readDriveFile(parseDriveReadArgs(args));
}

async function runContactsLookup(args: string[], options: ExecuteCliCommandOptions) {
  return createGoogleWorkspaceConnector(options).lookupContacts(
    parseRequiredQuery(args, "Usage: contacts lookup <query> [--limit <n>]")
  );
}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
bun run --filter './apps/cli' typecheck
```

Expected: pass.

---

### Task 5: Add CLI Tests for New Commands

**Files:**
- Modify: `apps/cli/src/shell.test.ts`

- [ ] **Step 1: Add Gmail command tests**

Add tests near the Calendar tests:

```ts
test("returns normalized mail search results", async () => {
  let capturedArgs: string[] = [];
  const result = await executeCliCommand(["mail", "search", "pricing", "--limit", "2"], {
    runGwsCli: async (args) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          messages: [{ id: "msg-1", threadId: "thread-1", snippet: "Pricing details" }],
        }),
        stderr: "",
      };
    },
  });

  expect(result.exitCode).toBe(0);
  expect(capturedArgs.slice(0, 4)).toEqual(["gmail", "users", "messages", "list"]);
  const params = JSON.parse(capturedArgs[capturedArgs.indexOf("--params") + 1] ?? "{}");
  expect(params).toMatchObject({ userId: "me", q: "pricing", maxResults: 2 });
  expect(JSON.parse(result.stdout)).toMatchObject({
    messages: [{ id: "msg-1", threadId: "thread-1", snippet: "Pricing details" }],
  });
});

test("returns normalized mail read results", async () => {
  const result = await executeCliCommand(["mail", "read", "msg-1"], {
    runGwsCli: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Hello",
        payload: {
          headers: [
            { name: "Subject", value: "Meeting prep" },
            { name: "From", value: "Alex <alex@example.com>" },
            { name: "To", value: "Sales <sales@example.com>" },
          ],
          parts: [{ mimeType: "text/plain", body: { data: "SGVsbG8=" } }],
        },
      }),
      stderr: "",
    }),
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    message: {
      id: "msg-1",
      subject: "Meeting prep",
      text: "Hello",
    },
  });
});
```

- [ ] **Step 2: Add Drive command tests**

Add:

```ts
test("returns normalized drive search results", async () => {
  const result = await executeCliCommand(["drive", "search", "discovery", "--limit", "1"], {
    runGwsCli: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        files: [
          {
            id: "file-1",
            name: "Discovery Notes",
            mimeType: "application/vnd.google-apps.document",
          },
        ],
      }),
      stderr: "",
    }),
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    files: [
      {
        id: "file-1",
        name: "Discovery Notes",
        mimeType: "application/vnd.google-apps.document",
      },
    ],
  });
});

test("returns normalized Google Doc content through drive read", async () => {
  const calls: string[][] = [];
  const result = await executeCliCommand(["drive", "read", "doc-1"], {
    runGwsCli: async (args) => {
      calls.push(args);
      if (args.slice(0, 3).join(" ") === "drive files get") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "doc-1",
            name: "Discovery Notes",
            mimeType: "application/vnd.google-apps.document",
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: "Customer notes" } }] } },
            ],
          },
        }),
        stderr: "",
      };
    },
  });

  expect(calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
    "drive files get",
    "docs documents get",
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    file: {
      id: "doc-1",
      text: "Customer notes",
    },
  });
});
```

- [ ] **Step 3: Add Contacts test**

Add:

```ts
test("returns normalized contact lookup results", async () => {
  const result = await executeCliCommand(["contacts", "lookup", "alex"], {
    runGwsCli: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        results: [
          {
            person: {
              resourceName: "people/c1",
              names: [{ displayName: "Alex Rivera" }],
              emailAddresses: [{ value: "alex@example.com" }],
              organizations: [{ name: "Fomora" }],
            },
          },
        ],
      }),
      stderr: "",
    }),
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    contacts: [
      {
        resourceName: "people/c1",
        displayName: "Alex Rivera",
        emailAddresses: ["alex@example.com"],
        phoneNumbers: [],
        organizations: ["Fomora"],
      },
    ],
  });
});
```

- [ ] **Step 4: Run CLI tests**

Run:

```bash
bun test apps/cli/src/shell.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/google-connector.ts apps/cli/src/shell.ts apps/cli/src/shell.test.ts
git commit -m "feat(cli): add read-only workspace commands"
```

---

### Task 6: Parse New Payloads in Shell Runtime

**Files:**
- Modify: `packages/core/src/shell-runtime.ts`
- Modify: `packages/core/src/shell-runtime.test.ts`

- [ ] **Step 1: Add parser imports**

Update imports:

```ts
ContactsLookupResultSchema,
DriveReadResultSchema,
DriveSearchResultSchema,
MailListResultSchema,
MailReadResultSchema,
```

- [ ] **Step 2: Update `parseShellPayload`**

Add:

```ts
if (call.command === "mail" && (call.subcommand === "list" || call.subcommand === "search")) {
  return MailListResultSchema.parse(json);
}
if (call.command === "mail" && call.subcommand === "read") {
  return MailReadResultSchema.parse(json);
}
if (call.command === "drive" && call.subcommand === "search") {
  return DriveSearchResultSchema.parse(json);
}
if (call.command === "drive" && call.subcommand === "read") {
  return DriveReadResultSchema.parse(json);
}
if (call.command === "contacts" && call.subcommand === "lookup") {
  return ContactsLookupResultSchema.parse(json);
}
```

- [ ] **Step 3: Add runtime tests**

Add one representative test per command family:

```ts
test("parses successful mail payloads from workspace cli stdout", async () => {
  const executor = createSpawnShellExecutor({
    async runWorkspaceCli(): Promise<SpawnResult> {
      return {
        stdout: JSON.stringify({ messages: [{ id: "msg-1", subject: "Hello", labels: [] }] }),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 5,
      };
    },
  });

  const result = await executor.executeShell({ command: "mail", subcommand: "list", args: [] });
  expect(result.parsed).toEqual({ messages: [{ id: "msg-1", subject: "Hello", labels: [] }] });
});

test("parses successful drive payloads from workspace cli stdout", async () => {
  const executor = createSpawnShellExecutor({
    async runWorkspaceCli(): Promise<SpawnResult> {
      return {
        stdout: JSON.stringify({
          files: [{ id: "file-1", name: "Doc", mimeType: "application/vnd.google-apps.document" }],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 5,
      };
    },
  });

  const result = await executor.executeShell({ command: "drive", subcommand: "search", args: ["Doc"] });
  expect(result.parsed).toEqual({
    files: [{ id: "file-1", name: "Doc", mimeType: "application/vnd.google-apps.document" }],
  });
});

test("parses successful contacts payloads from workspace cli stdout", async () => {
  const executor = createSpawnShellExecutor({
    async runWorkspaceCli(): Promise<SpawnResult> {
      return {
        stdout: JSON.stringify({
          contacts: [{ resourceName: "people/c1", displayName: "Alex", emailAddresses: [] }],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 5,
      };
    },
  });

  const result = await executor.executeShell({
    command: "contacts",
    subcommand: "lookup",
    args: ["alex"],
  });
  expect(result.parsed).toEqual({
    contacts: [{ resourceName: "people/c1", displayName: "Alex", emailAddresses: [] }],
  });
});
```

- [ ] **Step 4: Run runtime tests**

Run:

```bash
bun test packages/core/src/shell-runtime.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/shell-runtime.ts packages/core/src/shell-runtime.test.ts
git commit -m "feat(core): parse workspace shell payloads"
```

---

### Task 7: Update CLI Help and Settings Copy

**Files:**
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/desktop/ui/src/components/SettingsView.tsx`
- Modify: `apps/desktop/ui/src/components/SettingsView.test.tsx`

- [ ] **Step 1: Update CLI help**

In `apps/cli/src/index.ts`, change the Google command help block to:

```ts
console.log("  gcal          Read Google Calendar events");
console.log("  mail          Read and search Gmail");
console.log("  drive         Search and read Drive, Docs, and Sheets files");
console.log("  contacts      Look up Google contacts");
```

- [ ] **Step 2: Update Settings copy**

In the Google Workspace card section, change the explanatory copy to:

```tsx
Google Workspace uses the bundled CLI. Calendar, Gmail, Drive, Docs, Sheets, and Contacts are enabled for read-only workspace context.
```

- [ ] **Step 3: Update Settings test assertion**

In `apps/desktop/ui/src/components/SettingsView.test.tsx`, update the workspace integration test:

```ts
expect(within(section).getByText(/Gmail, Drive, Docs, Sheets, and Contacts/)).toBeTruthy();
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test apps/desktop/ui/src/components/SettingsView.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/index.ts apps/desktop/ui/src/components/SettingsView.tsx apps/desktop/ui/src/components/SettingsView.test.tsx
git commit -m "chore(settings): describe workspace capabilities"
```

---

### Task 8: Verify Against Real `gws` Command Shapes

**Files:**
- Modify only if verification reveals a mismatch:
  - `apps/cli/src/google-connector.ts`
  - `apps/cli/src/shell.test.ts`

- [ ] **Step 1: Check local `gws` availability**

Run:

```bash
gws --version
```

Expected: prints a version. If missing, install or point `TESSERA_GWS_CLI_PATH` to the bundled binary before continuing.

- [ ] **Step 2: Verify schemas for used methods**

Run:

```bash
gws schema gmail.users.messages.list
gws schema gmail.users.messages.get
gws schema drive.files.list
gws schema drive.files.get
gws schema docs.documents.get
gws schema sheets.spreadsheets.values.get
gws schema people.people.searchContacts
```

Expected: each command prints JSON schema or method metadata and exits 0.

- [ ] **Step 3: Dry-run representative commands**

Run:

```bash
gws gmail users messages list --params '{"userId":"me","maxResults":1}' --dry-run
gws drive files list --params '{"pageSize":1,"fields":"files(id,name,mimeType,modifiedTime,webViewLink)"}' --dry-run
gws people people searchContacts --params '{"query":"alex","pageSize":1,"readMask":"names,emailAddresses,phoneNumbers,organizations"}' --dry-run
```

Expected: each command shows the intended API request and exits 0.

- [ ] **Step 4: Patch command paths if discovery names differ**

If any schema or dry-run command fails because the generated command path differs, update only the relevant command array in `apps/cli/src/google-connector.ts` and update the matching expected `capturedArgs` assertion in `apps/cli/src/shell.test.ts`.

- [ ] **Step 5: Run full checks**

Run:

```bash
bun test apps/cli/src/shell.test.ts packages/core/src/shell-runtime.test.ts packages/contracts/src/integration-settings.test.ts
bun run check
cargo test integration_settings
```

Expected: all pass.

- [ ] **Step 6: Commit verification corrections**

If files changed:

```bash
git add apps/cli/src/google-connector.ts apps/cli/src/shell.test.ts
git commit -m "fix(cli): align workspace commands with gws discovery"
```

If no files changed, do not create a commit.

---

## Self-Review

- Spec coverage: Gmail is covered by `mail list/search/read`; Drive is covered by `drive search/read`; Contacts is covered by `contacts lookup`; Docs and Sheets are covered through `drive read`.
- Placeholder scan: no placeholder implementation steps are left. The one conditional verification step is explicit about the commands to run and the files to patch if `gws` discovery names differ.
- Type consistency: `GoogleWorkspaceConnector` method names match the CLI runner names and normalized contract schemas.
- Scope control: write actions remain outside the implementation. Existing approval-gated catalog entries are not activated unless future work implements them.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-google-workspace-expansion.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
