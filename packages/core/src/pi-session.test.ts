import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import type {
  AgentSessionEvent,
  ModelRegistry,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  type PiSessionFactory,
  type PiSessionLike,
  createTesseraModelRegistry,
  runPiTaskTurn,
} from "./pi-session.js";

class FakeSession implements PiSessionLike {
  capturedPrompts: string[] = [];
  private listeners: ((event: AgentSessionEvent) => void)[] = [];

  constructor(private readonly events: AgentSessionEvent[]) {}

  dispose(): void {}

  async prompt(text: string): Promise<void> {
    this.capturedPrompts.push(text);
    for (const event of this.events) {
      for (const listener of this.listeners) listener(event);
    }
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }
}

async function makeWorkspace() {
  return realpath(await mkdtemp("/tmp/tessera-pi-session-"));
}

describe("runPiTaskTurn", () => {
  test("creates a workspace-scoped Pi session and captures assistant text deltas", async () => {
    const workspaceRoot = await makeWorkspace();
    const seen: {
      customTools?: ToolDefinition[];
      workspaceRoot?: string;
      modelRegistry?: ModelRegistry;
      model?: unknown;
    } = {};
    const factory: PiSessionFactory = async (options) => {
      seen.customTools = options.customTools;
      seen.workspaceRoot = options.workspaceRoot;
      seen.modelRegistry = options.modelRegistry;
      seen.model = options.model;
      return new FakeSession([
        {
          type: "message_update",
          message: { role: "assistant", content: "" } as never,
          assistantMessageEvent: { type: "text_delta", delta: "Hello " } as never,
        },
        {
          type: "message_update",
          message: { role: "assistant", content: "" } as never,
          assistantMessageEvent: { type: "text_delta", delta: "workspace" } as never,
        },
      ]);
    };

    const result = await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft a note",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(result.text).toBe("Hello workspace");
    expect(seen.workspaceRoot).toBe(workspaceRoot);
    expect(seen.customTools?.map((item) => item.name).sort()).toEqual([
      "workspace_edit",
      "workspace_list",
      "workspace_read",
      "workspace_search",
      "workspace_write",
    ]);
    expect(seen.model).toBeDefined();
    expect(seen.modelRegistry).toBeDefined();
  });

  test("reports tool activity", async () => {
    const workspaceRoot = await makeWorkspace();
    const activity: string[] = [];
    const factory: PiSessionFactory = async () =>
      new FakeSession([
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "workspace_read",
          args: { path: "README.md" },
        },
      ]);

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      onActivity: (value) => activity.push(value),
      prompt: "Read",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(activity).toEqual(["Using workspace_read"]);
  });

  test("fails before session creation when cloud credentials are missing", async () => {
    const workspaceRoot = await makeWorkspace();
    let called = false;
    const factory: PiSessionFactory = async () => {
      called = true;
      return new FakeSession([]);
    };

    await expect(
      runPiTaskTurn({
        factory,
        prompt: "Draft",
        provider: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        workspaceRoot,
      })
    ).rejects.toThrow("Add an API key in Settings > Model");
    expect(called).toBe(false);
  });

  test("passes agent instructions and selected workspace tools into session setup", async () => {
    const workspaceRoot = await makeWorkspace();
    const seen: { customToolNames?: string[]; promptText?: string } = {};
    const factory: PiSessionFactory = async (options) => {
      seen.customToolNames = options.customTools.map((tool) => tool.name).sort();
      return new FakeSession([]);
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
      agent: {
        id: "writer",
        name: "Writer",
        model: { mode: "default" },
        instructions: "Write crisp updates.",
        soul: "Calm and direct.",
        skills: [],
        tools: ["workspace_read", "workspace_write"],
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
    });

    expect(seen.customToolNames).toEqual(["workspace_read", "workspace_write"]);
  });

  test("builds prompt with instructions, history, and task in order", async () => {
    const workspaceRoot = await makeWorkspace();
    let capturedSession: FakeSession | undefined;
    const factory: PiSessionFactory = async () => {
      capturedSession = new FakeSession([]);
      return capturedSession;
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
      agent: {
        id: "writer",
        name: "Writer",
        model: { mode: "default" },
        instructions: "Write crisp updates.",
        soul: "Calm and direct.",
        skills: [],
        tools: ["workspace_read", "workspace_write"],
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      conversationHistory: [
        { role: "user", content: "Hello" },
        { role: "agent", content: "Hi there" },
      ],
    });

    const prompt = capturedSession?.capturedPrompts[0] ?? "";
    expect(prompt).toContain("Agent instructions:\nWrite crisp updates.");
    expect(prompt).toContain("Agent soul:\nCalm and direct.");
    expect(prompt).toContain("Prior conversation:\nUser: Hello\nAssistant: Hi there");
    expect(prompt).toContain("User task:\nDraft");
    const instrIdx = prompt.indexOf("Agent instructions:");
    const histIdx = prompt.indexOf("Prior conversation:");
    const taskIdx = prompt.indexOf("User task:");
    expect(instrIdx).toBeLessThan(histIdx);
    expect(histIdx).toBeLessThan(taskIdx);
  });

  test("omits history block when conversationHistory is empty", async () => {
    const workspaceRoot = await makeWorkspace();
    let capturedSession: FakeSession | undefined;
    const factory: PiSessionFactory = async () => {
      capturedSession = new FakeSession([]);
      return capturedSession;
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(capturedSession?.capturedPrompts[0]).not.toContain("Prior conversation:");
  });

  test("returns boundaryViolations 0 when no violations occur", async () => {
    const workspaceRoot = await makeWorkspace();
    const factory: PiSessionFactory = async () => new FakeSession([]);

    const result = await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(result.boundaryViolations).toBe(0);
  });
});

describe("createTesseraModelRegistry", () => {
  test("does not require credentials for local providers", async () => {
    const result = await createTesseraModelRegistry({
      provider: {
        provider: "local",
        model: "llama3.2",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    });

    expect(result.model).toBeDefined();
    await expect(result.modelRegistry.authStorage.getApiKey("local")).resolves.toBeUndefined();
  });
});
