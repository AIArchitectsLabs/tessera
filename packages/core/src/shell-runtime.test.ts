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
            results: [
              {
                title: "Tessera",
                url: "https://example.com",
                snippet: "Agent workspace",
                source: "example.com",
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
      results: [
        {
          title: "Tessera",
          url: "https://example.com",
          snippet: "Agent workspace",
          source: "example.com",
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
});
