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
    const executor = createSpawnShellExecutor({
      async runWorkspaceCli(): Promise<SpawnResult> {
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
