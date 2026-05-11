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
  private _agentState = { systemPrompt: "" };

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

  get agent() {
    return { state: this._agentState };
  }

  get capturedSystemPrompt(): string {
    return this._agentState.systemPrompt;
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
      "workspace_extract",
      "workspace_list",
      "workspace_read",
      "workspace_search",
      "workspace_write",
    ]);
    expect(seen.model).toBeDefined();
    expect(seen.modelRegistry).toBeDefined();
  });

  test("captures token usage from nested SDK event payloads", async () => {
    const workspaceRoot = await makeWorkspace();
    const factory: PiSessionFactory = async () =>
      new FakeSession([
        {
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Draft ready." }],
            usage: {
              input_tokens: 12,
              output_tokens: 6,
              total_tokens: 18,
              cachedInputTokens: 3,
            },
          } as never,
          toolResults: [],
        },
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Draft ready." }],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 8,
                total_tokens: 28,
                reasoningTokens: 5,
              },
            } as never,
          ],
        },
      ]);

    const result = await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft a note",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
      reasoningTokens: 5,
    });
  });

  test("ignores message_end for user messages and returns only assistant text", async () => {
    const workspaceRoot = await makeWorkspace();
    // Mirrors the real SDK event sequence from runAgentLoop:
    // message_start + message_end for user prompt, then assistant streaming, then turn_end + agent_end.
    const factory: PiSessionFactory = async () =>
      new FakeSession([
        // SDK emits message_end for the user message before calling the model
        {
          type: "message_end",
          message: {
            role: "user",
            content: "User task:\nWhat is the capital of Italy?",
            timestamp: 0,
          } as never,
        },
        // Assistant streams its answer
        {
          type: "message_update",
          message: { role: "assistant", content: [] } as never,
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Rome is the capital of Italy.",
          } as never,
        },
        // turn_end carries the final assistant message
        {
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Rome is the capital of Italy." }],
          } as never,
          toolResults: [],
        },
        // agent_end includes both user and assistant messages; must not pick up user text
        {
          type: "agent_end",
          messages: [
            {
              role: "user",
              content: "User task:\nWhat is the capital of Italy?",
              timestamp: 0,
            } as never,
            {
              role: "assistant",
              content: [{ type: "text", text: "Rome is the capital of Italy." }],
            } as never,
          ],
        },
      ]);

    const result = await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "What is the capital of Italy?",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(result.text).toBe("Rome is the capital of Italy.");
  });

  test("falls back to finalized assistant message when no text deltas are emitted", async () => {
    const workspaceRoot = await makeWorkspace();
    const factory: PiSessionFactory = async () =>
      new FakeSession([
        {
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Rome is the capital of Italy." }],
          } as never,
          toolResults: [],
        },
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Rome is the capital of Italy." }],
            } as never,
          ],
        },
      ]);

    const result = await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "What is the capital of Italy?",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(result.text).toBe("Rome is the capital of Italy.");
  });

  test("reports tool activity", async () => {
    const workspaceRoot = await makeWorkspace();
    const activity: string[] = [];
    const tools: Array<{ name: string; args: unknown }> = [];
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
      onToolStart: (tool) => tools.push(tool),
      prompt: "Read",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(activity).toEqual(["Using workspace_read"]);
    expect(tools).toEqual([{ name: "workspace_read", args: { path: "README.md" } }]);
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
        userContext: "",
        skills: [],
        toolPolicyPreset: "elevated_with_approval",
        memoryDefaults: "",
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
    });

    expect(seen.customToolNames).toEqual([
      "workspace_edit",
      "workspace_extract",
      "workspace_list",
      "workspace_read",
      "workspace_search",
      "workspace_write",
    ]);
  });

  test("builds prompt with identity, history, and task", async () => {
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
        userContext: "Support an operations leader.",
        skills: [],
        toolPolicyPreset: "elevated_with_approval",
        memoryDefaults: "Reuse the weekly update format.",
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      conversationHistory: [
        { role: "user", content: "Hello" },
        { role: "agent", content: "Hi there" },
      ],
    });

    const prompt = capturedSession?.capturedPrompts[0] ?? "";
    const systemPrompt = capturedSession?.capturedSystemPrompt ?? "";

    expect(prompt).toContain("Write crisp updates.");
    expect(prompt).toContain("Calm and direct.");
    expect(prompt).toContain("Support an operations leader.");
    expect(prompt).toContain("Reuse the weekly update format.");
    expect(prompt).toContain("Ask for approval before using mutating workspace tools.");
    expect(prompt).toContain("Prior conversation:\nUser: Hello\nAssistant: Hi there");
    expect(prompt).toContain("User task:\nDraft");
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

  test("returns boundaryViolations 1 when a workspace tool is denied", async () => {
    const workspaceRoot = await makeWorkspace();
    const factory: PiSessionFactory = async (factoryOpts) => {
      const outsidePath = "../escape.txt";
      const writeTool = factoryOpts.customTools.find((t) => t.name === "workspace_write");
      if (writeTool) {
        await writeTool
          .execute(
            "call-1",
            { path: outsidePath, content: "x" },
            undefined,
            undefined,
            undefined as never
          )
          .catch(() => {});
      }
      return new FakeSession([]);
    };

    const result = await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot,
    });

    expect(result.boundaryViolations).toBe(1);
  });

  test("exposes the todo tool when taskRuntime is provided", async () => {
    const workspaceRoot = await makeWorkspace();
    const seen: { operations: unknown[]; toolNames?: string[] } = { operations: [] };
    const factory: PiSessionFactory = async (factoryOpts) => {
      seen.toolNames = factoryOpts.customTools.map((tool) => tool.name).sort();
      const todoTool = factoryOpts.customTools.find((tool) => tool.name === "todo");
      await todoTool?.execute(
        "call-1",
        {
          type: "append",
          item: {
            id: "todo-1",
            label: "Draft plan",
            status: "pending",
            order: 0,
          },
        },
        undefined,
        undefined,
        undefined as never
      );
      return new FakeSession([]);
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      taskRuntime: {
        async applyTodo(operation) {
          seen.operations.push(operation);
          return {
            updatedAt: "2026-05-03T00:00:00.000Z",
            items: [
              {
                id: "todo-1",
                label: "Draft plan",
                status: "pending",
                order: 0,
              },
            ],
          };
        },
      },
      workspaceRoot,
    });

    expect(seen.toolNames).toContain("todo");
    expect(seen.operations).toEqual([
      {
        type: "append",
        item: {
          id: "todo-1",
          label: "Draft plan",
          status: "pending",
          order: 0,
        },
      },
    ]);
  });

  test("exposes the shell tool when a shell executor is provided", async () => {
    const workspaceRoot = await makeWorkspace();
    const seen: { toolNames?: string[]; calls: unknown[] } = { calls: [] };
    const factory: PiSessionFactory = async (factoryOpts) => {
      seen.toolNames = factoryOpts.customTools.map((tool) => tool.name).sort();
      const shellTool = factoryOpts.customTools.find((tool) => tool.name === "shell");
      await shellTool?.execute(
        "call-1",
        {
          command: "web-fetch",
          subcommand: "fetch",
          args: ["https://example.com"],
        },
        undefined,
        undefined,
        undefined as never
      );
      return new FakeSession([]);
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Fetch the page",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      shell: {
        async executeShell(call) {
          seen.calls.push(call);
          return {
            command: "web-fetch",
            subcommand: "fetch",
            stdout: '{"url":"https://example.com","markdown":"Hello","diagnostics":{"status":200}}',
            stderr: "",
            exitCode: 0,
            durationMs: 5,
            parsed: {
              url: "https://example.com",
              markdown: "Hello",
              diagnostics: { status: 200 },
            },
          };
        },
      },
      workspaceRoot,
    });

    expect(seen.toolNames).toContain("shell");
    expect(seen.calls).toEqual([
      {
        command: "web-fetch",
        subcommand: "fetch",
        args: ["https://example.com"],
      },
    ]);
  });

  test("exposes the browser tool when a browser executor is provided", async () => {
    const workspaceRoot = await makeWorkspace();
    const seen: { toolNames?: string[]; calls: unknown[] } = { calls: [] };
    const factory: PiSessionFactory = async (factoryOpts) => {
      seen.toolNames = factoryOpts.customTools.map((tool) => tool.name).sort();
      const browserTool = factoryOpts.customTools.find((tool) => tool.name === "browser");
      await browserTool?.execute(
        "call-1",
        {
          action: "open",
          url: "https://example.com",
        },
        undefined,
        undefined,
        undefined as never
      );
      return new FakeSession([]);
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Open the page",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      browser: {
        async executeBrowser(input) {
          seen.calls.push(input);
          return {
            action: input.action,
            summary: "Opened https://example.com",
            sessionId: "session-1",
            pageId: "page-1",
            url: "https://example.com",
          };
        },
      },
      workspaceRoot,
    });

    expect(seen.toolNames).toContain("browser");
    expect(seen.calls).toEqual([
      {
        action: "open",
        url: "https://example.com",
      },
    ]);
  });

  test("exposes skill tools and preloads active task skills", async () => {
    const workspaceRoot = await makeWorkspace();
    let capturedSession: FakeSession | undefined;
    const seen: { toolNames?: string[]; loaded?: unknown } = {};
    const factory: PiSessionFactory = async (factoryOpts) => {
      seen.toolNames = factoryOpts.customTools.map((tool) => tool.name).sort();
      const skillLoad = factoryOpts.customTools.find((tool) => tool.name === "skill_load");
      seen.loaded = await skillLoad?.execute(
        "call-1",
        { skillId: "planning" },
        undefined,
        undefined,
        undefined as never
      );
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
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        instructions: "",
        soul: "",
        userContext: "",
        skills: ["planning"],
        toolPolicyPreset: "workspace_editor",
        memoryDefaults: "",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
      },
      skillRuntime: {
        allowedSkillIds: ["planning"],
        activeSkills: [
          {
            skillId: "planning",
            name: "planning",
            source: "curated",
            activatedAt: "2026-05-05T00:00:00.000Z",
          },
        ],
        async listSkills() {
          return [
            {
              id: "planning",
              name: "planning",
              description: "Plan work.",
              source: "curated",
            },
          ];
        },
        async loadSkill(skillId) {
          return {
            id: skillId,
            name: "planning",
            description: "Plan work.",
            source: "curated",
            content: "# Planning\n\nBreak work into verifiable steps.",
          };
        },
      },
    });

    expect(seen.toolNames).toContain("skill_list");
    expect(seen.toolNames).toContain("skill_load");
    expect(seen.loaded).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Break work") }],
    });
    expect(capturedSession?.capturedPrompts[0]).toContain("Active skill: planning");
    expect(capturedSession?.capturedPrompts[0]).toContain("Break work into verifiable steps.");
  });

  test("does not allow approval-gated shell subcommands in task mode", async () => {
    const workspaceRoot = await makeWorkspace();
    const factory: PiSessionFactory = async (factoryOpts) => {
      const shellTool = factoryOpts.customTools.find((tool) => tool.name === "shell");
      await expect(
        shellTool?.execute(
          "call-1",
          {
            command: "mail",
            subcommand: "draft",
            args: ["123"],
          },
          undefined,
          undefined,
          undefined as never
        )
      ).rejects.toThrow("requires approval");
      return new FakeSession([]);
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft an email",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      shell: {
        async executeShell() {
          throw new Error("should not be called");
        },
      },
      workspaceRoot,
    });
  });

  test("nudges task mode to use todo for plans and multi-step work", async () => {
    const workspaceRoot = await makeWorkspace();
    let capturedSession: FakeSession | undefined;
    const factory: PiSessionFactory = async () => {
      capturedSession = new FakeSession([]);
      return capturedSession;
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Plan the launch checklist and execute it step by step.",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      taskRuntime: {
        async applyTodo() {
          return undefined;
        },
      },
      workspaceRoot,
    });

    expect(capturedSession?.capturedPrompts[0]).toContain(
      "When the user asks for a plan, checklist, or other multi-step work, create or update the task checklist early with the todo tool and keep it current as you work."
    );
    expect(capturedSession?.capturedPrompts[0]).toContain(
      "Move items to in_progress or completed as the work advances, and make sure finished work is reflected in the checklist before you end your turn."
    );
  });

  test("nudges task mode to use clarify when blocked by ambiguity", async () => {
    const workspaceRoot = await makeWorkspace();
    let capturedSession: FakeSession | undefined;
    const factory: PiSessionFactory = async () => {
      capturedSession = new FakeSession([]);
      return capturedSession;
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Draft the plan, but ask me if any requirement is unclear.",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      taskRuntime: {
        async applyTodo() {
          return undefined;
        },
      },
      workspaceRoot,
    });

    expect(capturedSession?.capturedPrompts[0]).toContain(
      "If progress is blocked by missing requirements, ambiguity, or a decision only the user can make, use the clarify tool instead of guessing. Prefer clarify early before taking irreversible or highly branchy action."
    );
  });

  test("nudges task mode to use shell early for explicit web research requests", async () => {
    const workspaceRoot = await makeWorkspace();
    let capturedSession: FakeSession | undefined;
    const factory: PiSessionFactory = async () => {
      capturedSession = new FakeSession([]);
      return capturedSession;
    };

    await runPiTaskTurn({
      credential: "sk-test",
      factory,
      prompt: "Search the web for the latest pricing and fetch the official FAQ page.",
      provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      shell: {
        async executeShell() {
          return {
            command: "web-search",
            subcommand: "search",
            stdout: "{}",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          };
        },
      },
      taskRuntime: {
        async applyTodo() {
          return undefined;
        },
      },
      workspaceRoot,
    });

    expect(capturedSession?.capturedPrompts[0]).toContain(
      "When the user asks you to search the web, check current online information, or fetch the contents of a public URL, use the shell tool early."
    );
    expect(capturedSession?.capturedPrompts[0]).toContain("web-search search ...");
    expect(capturedSession?.capturedPrompts[0]).toContain("web-fetch fetch <url>");
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
