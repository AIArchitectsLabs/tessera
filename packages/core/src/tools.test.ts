import { describe, expect, test } from "bun:test";
import type {
  BrowserToolResult,
  ClarifyResponse,
  ShellToolResult,
  TodoOperation,
} from "@tessera/contracts";
import { createTesseraTools, summarizeToolResult } from "./tools.js";

const spawnResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 1,
};

const shellResult: ShellToolResult = {
  command: "web-fetch",
  subcommand: "fetch",
  stdout: '{"url":"https://example.com"}',
  stderr: "",
  exitCode: 0,
  durationMs: 3,
};

describe("createTesseraTools", () => {
  test("registers the built-in tool surface", () => {
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "browser",
      "clarify",
      "notify",
      "shell",
      "todo",
      "workspace_ping",
      "workspace_write_probe",
    ]);
  });

  test("executes allowed shell commands through the shell runtime", async () => {
    const calls: Array<{ command: string; subcommand: string; args: string[] }> = [];
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
      shell: {
        async executeShell(call) {
          calls.push(call);
          return shellResult;
        },
      },
    });

    const shell = tools.find((tool) => tool.name === "shell");
    const result = await shell?.execute("call-1", {
      command: "web-fetch",
      subcommand: "fetch",
      args: ["https://example.com"],
    });

    expect(calls).toEqual([
      { command: "web-fetch", subcommand: "fetch", args: ["https://example.com"] },
    ]);
    expect(result?.content[0]?.type).toBe("text");
  });

  test("blocks approval-gated shell mutations without a grant", async () => {
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
      shell: {
        async executeShell() {
          return shellResult;
        },
      },
    });

    const shell = tools.find((tool) => tool.name === "shell");
    const result = await shell?.execute("call-1", {
      command: "mail",
      subcommand: "draft",
      args: ["--reply-to", "123"],
    });

    expect(result?.terminate).toBe(true);
    if (!result) {
      throw new Error("Expected shell result");
    }
    const summary = summarizeToolResult("shell", result, false);
    expect(summary.status).toBe("blocked");
  });

  test("routes browser actions through the browser runtime", async () => {
    const calls: string[] = [];
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
      browser: {
        async executeBrowser(input): Promise<BrowserToolResult> {
          calls.push(input.action);
          return { action: input.action, summary: "Opened page", pageId: "page-1" };
        },
      },
    });

    const browser = tools.find((tool) => tool.name === "browser");
    const result = await browser?.execute("call-1", {
      action: "open",
      url: "https://example.com",
    });

    expect(calls).toEqual(["open"]);
    expect(result?.content[0]?.type).toBe("text");
  });

  test("routes todo, clarify, and notify through the task runtime", async () => {
    const seen: { todo?: TodoOperation; clarify?: string; notify?: string } = {};
    const clarifyResponse: ClarifyResponse = {
      promptId: "prompt-1",
      selectedOptionId: "keep-going",
      cancelled: false,
    };
    const tools = createTesseraTools({
      cli: {
        async runWorkspaceCli() {
          return spawnResult;
        },
      },
      taskRuntime: {
        async applyTodo(operation) {
          seen.todo = operation;
          return { summary: "Todo updated." };
        },
        async requestClarify(request) {
          seen.clarify = request.promptId;
          return clarifyResponse;
        },
        async sendNotification(request) {
          seen.notify = request.title;
        },
      },
    });

    await tools
      .find((tool) => tool.name === "todo")
      ?.execute("call-1", { type: "remove", itemId: "item-1" });
    await tools
      .find((tool) => tool.name === "clarify")
      ?.execute("call-2", {
        promptId: "prompt-1",
        taskId: "task-1",
        message: "Choose one",
        createdAt: "2026-05-03T00:00:00.000Z",
      });
    await tools
      .find((tool) => tool.name === "notify")
      ?.execute("call-3", {
        title: "Ready",
        body: "Finished",
      });

    expect(seen.todo).toEqual({ type: "remove", itemId: "item-1" });
    expect(seen.clarify).toBe("prompt-1");
    expect(seen.notify).toBe("Ready");
  });
});
