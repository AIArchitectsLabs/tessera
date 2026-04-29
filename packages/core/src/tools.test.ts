import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "@tessera/contracts";
import { createTesseraTools, summarizeToolResult } from "./tools.js";

const spawnResult: SpawnResult = {
  stdout: '{"message":"pong"}\n',
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 3,
};

describe("createTesseraTools", () => {
  test("executes read tools through the CLI executor", async () => {
    const calls: string[][] = [];
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli(args) {
          calls.push(args);
          return spawnResult;
        },
      },
    });

    const ping = tools.find((tool) => tool.name === "workspace_ping");
    expect(ping).toBeDefined();

    const result = await ping?.execute("call-1", { message: "hello" });

    expect(calls).toEqual([["ping", "hello"]]);
    expect(result?.content[0]?.type).toBe("text");
  });

  test("rejects malformed tool arguments before execution", async () => {
    const calls: string[][] = [];
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli(args) {
          calls.push(args);
          return spawnResult;
        },
      },
    });

    const ping = tools.find((tool) => tool.name === "workspace_ping");

    await expect(ping?.execute("call-1", { message: 123 })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("routes ungranted writes to ask without calling the CLI executor", async () => {
    const calls: string[][] = [];
    const decisions: string[] = [];
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli(args) {
          calls.push(args);
          return spawnResult;
        },
      },
      onPermissionDecision(decision) {
        decisions.push(decision.decision);
      },
    });

    const writeProbe = tools.find((tool) => tool.name === "workspace_write_probe");
    const result = await writeProbe?.execute("call-1", {
      target: "lead",
      value: "qualified",
    });

    expect(calls).toEqual([]);
    expect(decisions).toEqual(["ask"]);
    expect(result?.terminate).toBe(true);
    if (!result) {
      throw new Error("Expected write probe result");
    }

    const summary = summarizeToolResult("workspace_write_probe", result, false);
    expect(summary.status).toBe("blocked");
    expect(summary.toolId).toBe("workspace.writeProbe");
  });

  test("allows granted write probes without mutating through the CLI", async () => {
    const calls: string[][] = [];
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli(args) {
          calls.push(args);
          return spawnResult;
        },
      },
      grants: [{ type: "tool", toolId: "workspace.writeProbe" }],
    });

    const writeProbe = tools.find((tool) => tool.name === "workspace_write_probe");
    const result = await writeProbe?.execute("call-1", {
      target: "lead",
      value: "qualified",
    });

    expect(calls).toEqual([]);
    expect(result?.terminate).toBe(true);
    expect(result?.details).toEqual({
      target: "lead",
      value: "qualified",
      mutated: false,
    });
  });
});
