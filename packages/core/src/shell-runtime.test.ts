import { describe, expect, test } from "bun:test";
import type { ShellToolCall, SpawnResult } from "@tessera/contracts";
import {
  ShellExecutionError,
  ShellValidationError,
  createSpawnShellExecutor,
  validateShellCall,
} from "./shell-runtime.js";

describe("shell runtime", () => {
  test("rejects unsupported shell commands", () => {
    expect(() =>
      validateShellCall({
        command: "web-search",
        subcommand: "not-real",
        args: [],
      })
    ).toThrow(ShellValidationError);
  });

  test("keeps unimplemented Workspace writes unsupported", () => {
    expect(() =>
      validateShellCall({
        command: "mail",
        subcommand: "send",
        args: [],
      })
    ).toThrow("Unsupported shell command");

    expect(() =>
      validateShellCall({
        command: "drive",
        subcommand: "delete",
        args: [],
      })
    ).toThrow("Unsupported shell command");
  });

  test("parses successful web-search payloads from workspace cli stdout", async () => {
    const calls: string[][] = [];
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(args): Promise<SpawnResult> {
        calls.push(args);
        return {
          stdout: JSON.stringify({
            query: "tessera",
            provider: "brave-search",
            capability: "search",
            cached: false,
            latencyMs: 12,
            results: [
              {
                title: "Tessera",
                url: "https://example.com",
                snippet: "Agent workspace",
                source: "example.com",
                position: 1,
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
      command: "web-search",
      subcommand: "search",
      args: ["tessera"],
    });

    expect(calls).toEqual([["web-search", "search", "tessera"]]);
    expect(result.parsed).toEqual({
      query: "tessera",
      provider: "brave-search",
      capability: "search",
      cached: false,
      latencyMs: 12,
      results: [
        {
          title: "Tessera",
          url: "https://example.com",
          snippet: "Agent workspace",
          source: "example.com",
          position: 1,
        },
      ],
    });
  });

  test("throws a stable error when cli stdout is invalid json", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: "not-json",
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 4,
        };
      },
    });

    await expect(
      executor.executeShell({
        command: "web-fetch",
        subcommand: "fetch",
        args: ["https://example.com"],
      })
    ).rejects.toThrow(ShellExecutionError);
  });

  test("throws a stable error when cli exits non-zero", async () => {
    const call: ShellToolCall = {
      command: "web-search",
      subcommand: "search",
      args: ["tessera"],
    };
    const calls: string[][] = [];
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(args): Promise<SpawnResult> {
        calls.push(args);
        return {
          stdout: "",
          stderr: "Brave Search is not configured. Add an API key in Settings > Integrations.",
          exitCode: 2,
          signal: null,
          durationMs: 8,
        };
      },
    });

    await expect(executor.executeShell(call)).rejects.toThrow(
      "Brave Search is not configured. Add an API key in Settings > Integrations."
    );
    expect(calls).toHaveLength(1);
  });

  test("retries retryable web-fetch terminations once", async () => {
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(args, timeoutMs): Promise<SpawnResult> {
        const call: { args: string[]; timeoutMs?: number } = { args };
        if (timeoutMs !== undefined) call.timeoutMs = timeoutMs;
        calls.push(call);
        if (calls.length === 1) {
          return {
            stdout: "",
            stderr: "",
            exitCode: 143,
            signal: "SIGTERM",
            durationMs: 20_000,
          };
        }
        return {
          stdout: JSON.stringify({
            url: "https://example.com/post",
            title: "Example",
            markdown: "# Example\n\nFetched on retry.",
            diagnostics: { status: 200, contentType: "text/html" },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 35,
        };
      },
    });

    const result = await executor.executeShell({
      command: "web-fetch",
      subcommand: "fetch",
      args: ["https://example.com/post"],
    });

    expect(calls).toEqual([
      { args: ["web-fetch", "fetch", "https://example.com/post"], timeoutMs: 45_000 },
      { args: ["web-fetch", "fetch", "https://example.com/post"], timeoutMs: 45_000 },
    ]);
    expect(result.parsed).toMatchObject({
      url: "https://example.com/post",
      markdown: "# Example\n\nFetched on retry.",
    });
  });

  test("reports the final web-fetch error after retry exhaustion", async () => {
    const calls: string[][] = [];
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(args): Promise<SpawnResult> {
        calls.push(args);
        return {
          stdout: "",
          stderr: "",
          exitCode: 143,
          signal: "SIGTERM",
          durationMs: 45_000,
        };
      },
    });

    await expect(
      executor.executeShell({
        command: "web-fetch",
        subcommand: "fetch",
        args: ["https://example.com/slow"],
      })
    ).rejects.toThrow("web-fetch fetch https://example.com/slow exited 143");
    expect(calls).toHaveLength(2);
  });

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

  test("parses successful mail list payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            messages: [
              {
                id: "msg-1",
                subject: "Meeting prep",
                labels: ["INBOX"],
              },
            ],
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 9,
        };
      },
    });

    const result = await executor.executeShell({
      command: "mail",
      subcommand: "list",
      args: [],
    });

    expect(result.parsed).toEqual({
      messages: [
        {
          id: "msg-1",
          subject: "Meeting prep",
          labels: ["INBOX"],
        },
      ],
    });
  });

  test("parses successful mail read payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            message: {
              id: "msg-1",
              subject: "Meeting prep",
              labels: ["INBOX"],
              to: ["sales@example.com"],
              text: "Can we review pricing before the call?",
            },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 9,
        };
      },
    });

    const result = await executor.executeShell({
      command: "mail",
      subcommand: "read",
      args: ["msg-1"],
    });

    expect(result.parsed).toEqual({
      message: {
        id: "msg-1",
        subject: "Meeting prep",
        labels: ["INBOX"],
        to: ["sales@example.com"],
        cc: [],
        text: "Can we review pricing before the call?",
      },
    });
  });

  test("parses successful mail draft payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            draft: {
              id: "draft-1",
              messageId: "msg-1",
              threadId: "thread-1",
            },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 9,
        };
      },
    });

    const result = await executor.executeShell({
      command: "mail",
      subcommand: "draft",
      args: [],
    });

    expect(result.parsed).toEqual({
      draft: {
        id: "draft-1",
        messageId: "msg-1",
        threadId: "thread-1",
      },
    });
  });

  test("parses successful mail send-draft payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            message: {
              id: "msg-1",
              threadId: "thread-1",
              snippet: "sent",
              labels: ["SENT"],
            },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 9,
        };
      },
    });

    const result = await executor.executeShell({
      command: "mail",
      subcommand: "send-draft",
      args: ["draft-1"],
    });

    expect(result.parsed).toEqual({
      message: {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "sent",
        labels: ["SENT"],
      },
    });
  });

  test("parses successful drive search payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            files: [
              {
                id: "file-1",
                name: "Discovery Notes",
                mimeType: "application/vnd.google-apps.document",
                webViewLink: "https://docs.google.com/document/d/file-1/edit",
              },
            ],
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 11,
        };
      },
    });

    const result = await executor.executeShell({
      command: "drive",
      subcommand: "search",
      args: ["notes"],
    });

    expect(result.parsed).toEqual({
      files: [
        {
          id: "file-1",
          name: "Discovery Notes",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://docs.google.com/document/d/file-1/edit",
        },
      ],
    });
  });

  test("parses successful drive read payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            file: {
              id: "file-1",
              name: "Discovery Notes",
              mimeType: "application/vnd.google-apps.document",
              text: "Customer notes",
            },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 11,
        };
      },
    });

    const result = await executor.executeShell({
      command: "drive",
      subcommand: "read",
      args: ["file-1"],
    });

    expect(result.parsed).toEqual({
      file: {
        id: "file-1",
        name: "Discovery Notes",
        mimeType: "application/vnd.google-apps.document",
        text: "Customer notes",
      },
    });
  });

  test("parses sheets dry-run previews and commit payloads from workspace cli stdout", async () => {
    const previewExecutor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            dryRun: true,
            operation: "upsert",
            idempotencyKey: "idem-1",
            preview: {
              action: "upsert",
              spreadsheetId: "sheet-1",
              table: "Suppliers",
              key: { column: "supplier id", value: "sup-1" },
              before: null,
              after: { "supplier id": "sup-1" },
              changedCells: [{ column: "supplier id", after: "sup-1" }],
            },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 8,
        };
      },
    });

    await expect(
      previewExecutor.executeShell({ command: "sheets", subcommand: "rows.upsert", args: [] })
    ).resolves.toMatchObject({ parsed: { dryRun: true, operation: "upsert" } });

    const commitExecutor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            dryRun: false,
            operation: "append",
            spreadsheetId: "sheet-1",
            table: "Suppliers",
            updatedRange: "Suppliers!A2:G2",
            idempotencyKey: "idem-1",
            approvalId: "approval-1",
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 8,
        };
      },
    });

    await expect(
      commitExecutor.executeShell({ command: "sheets", subcommand: "rows.append", args: [] })
    ).resolves.toMatchObject({ parsed: { dryRun: false, operation: "append" } });
  });

  test("parses docs dry-run previews and commit payloads from workspace cli stdout", async () => {
    const previewExecutor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            dryRun: true,
            operation: "createDocument",
            target: { title: "RFQ" },
            preview: { text: "Hello" },
            idempotencyKey: "idem-doc",
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 8,
        };
      },
    });

    await expect(
      previewExecutor.executeShell({ command: "docs", subcommand: "documents.create", args: [] })
    ).resolves.toMatchObject({ parsed: { dryRun: true, operation: "createDocument" } });

    const commitExecutor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            dryRun: false,
            operation: "appendText",
            documentId: "doc-1",
            idempotencyKey: "idem-doc",
            approvalId: "approval-doc",
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 8,
        };
      },
    });

    await expect(
      commitExecutor.executeShell({ command: "docs", subcommand: "documents.appendText", args: [] })
    ).resolves.toMatchObject({ parsed: { dryRun: false, operation: "appendText" } });
  });

  test("rejects unsupported raw sheets and docs write subcommands", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        throw new Error("should not spawn unsupported commands");
      },
    });

    await expect(
      executor.executeShell({ command: "sheets", subcommand: "range.write", args: [] })
    ).rejects.toThrow(/Unsupported shell command/);
    await expect(
      executor.executeShell({ command: "docs", subcommand: "documents.batchUpdate", args: [] })
    ).rejects.toThrow(/Unsupported shell command/);
  });

  test("parses successful contacts lookup payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            contacts: [
              {
                resourceName: "people/c1",
                displayName: "Alex Rivera",
                emailAddresses: ["alex@example.com"],
                phoneNumbers: ["+1 555 0100"],
                organizations: ["Fomora"],
              },
            ],
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 10,
        };
      },
    });

    const result = await executor.executeShell({
      command: "contacts",
      subcommand: "lookup",
      args: ["Alex Rivera"],
    });

    expect(result.parsed).toEqual({
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
  });

  test("parses successful HubSpot summary and object search payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(args): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify(
            args[1] === "summary"
              ? { counts: { contacts: 10, companies: 4, deals: 2 } }
              : {
                  objectType: "contacts",
                  results: [
                    {
                      id: "101",
                      properties: { firstname: "Alex", email: "alex@example.com" },
                      archived: false,
                    },
                  ],
                }
          ),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 10,
        };
      },
    });

    const summary = await executor.executeShell({
      command: "hubspot",
      subcommand: "summary",
      args: [],
    });
    expect(summary.parsed).toEqual({ counts: { contacts: 10, companies: 4, deals: 2 } });

    const search = await executor.executeShell({
      command: "hubspot",
      subcommand: "contacts",
      args: ["search", "alex"],
    });
    expect(search.parsed).toMatchObject({
      objectType: "contacts",
      results: [{ id: "101", properties: { email: "alex@example.com" } }],
    });
  });

  test("parses successful HubSpot mutation payloads from workspace cli stdout", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            objectType: "deals",
            action: "update",
            result: {
              id: "301",
              properties: { dealstage: "closedwon" },
              archived: false,
            },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 10,
        };
      },
    });

    const result = await executor.executeShell({
      command: "hubspot",
      subcommand: "deals",
      args: ["update", "301", "--properties-json", "{}"],
    });

    expect(result.parsed).toMatchObject({
      objectType: "deals",
      action: "update",
      result: { id: "301", properties: { dealstage: "closedwon" } },
    });
  });

  test("wraps schema failures from workspace cli stdout in ShellExecutionError", async () => {
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
        return {
          stdout: JSON.stringify({
            contacts: [
              {
                resourceName: "people/c1",
              },
            ],
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 10,
        };
      },
    });

    await expect(
      executor.executeShell({
        command: "contacts",
        subcommand: "lookup",
        args: ["Alex Rivera"],
      })
    ).rejects.toThrow(ShellExecutionError);
  });
});
