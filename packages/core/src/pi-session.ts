import { Type } from "@mariozechner/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  defineTool,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentProfile,
  AgentProviderConfig,
  AgentRuntimeContext,
  ShellToolCall,
  SkillDetail,
  SkillSummary,
  TaskSkillActivation,
  TaskTodo,
  TodoOperation,
} from "@tessera/contracts";
import { compileAgentRuntimeContext } from "@tessera/contracts";
import { findCliCommand, formatShellPreview } from "./cli-catalog.js";
import { createTaskToolDefinitions } from "./task-tools.js";
import type { ShellExecutor } from "./tools.js";
import { createWorkspaceGuard } from "./workspace-guard.js";
import { createWorkspaceToolDefinitions } from "./workspace-tools.js";

const TESSERA_SYSTEM_PROMPT = `You are Tessera, an AI workspace assistant for business professionals.

Your purpose is to help users complete business tasks — strategy, planning, research, writing, analysis, operations, and more. You are not limited to coding; you can help with any knowledge-work objective.

When a user asks what you can do, frame your capabilities around their business needs:
- **Research & Analysis**: Market research, competitive analysis, data interpretation, trend spotting
- **Strategy & Planning**: Business plans, go-to-market strategies, OKRs, roadmaps
- **Writing & Communication**: Reports, proposals, emails, presentations, documentation
- **Operations**: Process design, workflow optimization, checklists, SOPs
- **Creative Work**: Brainstorming, content creation, naming, messaging frameworks
- **Technical Support**: Code, scripts, data processing, integrations — when the task requires it

You have access to workspace tools that let you read text files, extract readable content from PDF/Word/Excel files, write files, search, and organize files within the user's workspace. Use these to deliver tangible outputs — documents, plans, analyses — not just advice.

When the user explicitly asks for web research, current online information, or the contents of a URL, proactively use the shell tool early instead of only answering from memory. Use \`web-search search ...\` for search queries and \`web-fetch fetch <url>\` for a specific public page.

Be direct, professional, and action-oriented. Focus on delivering results, not describing your capabilities at length. When given a task, plan briefly then execute.`;

type PiSessionEventListener = (event: AgentSessionEvent) => void;

export interface PiSessionLike {
  dispose(): void;
  prompt(text: string): Promise<void>;
  subscribe(listener: PiSessionEventListener): () => void;
}

export interface PiSessionFactoryOptions {
  customTools: ToolDefinition[];
  // Pi SDK's Model type is not publicly exported; callers pass it opaquely.
  model?: unknown;
  modelRegistry: ModelRegistry;
  workspaceRoot: string;
}

export type PiSessionFactory = (options: PiSessionFactoryOptions) => Promise<PiSessionLike>;

export interface RunPiTaskTurnOptions {
  agent?: AgentProfile;
  conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
  credential?: string;
  factory?: PiSessionFactory;
  onActivity?: (activity: string) => void;
  onToolStart?: (tool: { name: string; args: unknown }) => void;
  prompt: string;
  provider: AgentProviderConfig;
  runtime?: AgentRuntimeContext;
  shell?: ShellExecutor;
  skillRuntime?: {
    activeSkills?: TaskSkillActivation[];
    allowedSkillIds?: string[];
    listSkills(): Promise<SkillSummary[]>;
    loadSkill(skillId: string): Promise<SkillDetail>;
  };
  taskRuntime?: {
    applyTodo(operation: TodoOperation): Promise<TaskTodo | undefined>;
  };
  workspaceRoot: string;
}

export interface PiTaskTurnResult {
  text: string;
  boundaryViolations: number;
}

function providerBaseUrl(provider: AgentProviderConfig): string {
  if (provider.provider === "anthropic") return "https://api.anthropic.com";
  if (provider.provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider.provider === "local") return provider.baseUrl;
  return "https://api.openai.com/v1";
}

function providerApi(provider: AgentProviderConfig): string {
  if (provider.provider === "anthropic") return "anthropic-messages";
  return "openai-completions";
}

function providerRequiresCredential(provider: AgentProviderConfig): boolean {
  return (
    provider.provider === "openai" ||
    provider.provider === "anthropic" ||
    provider.provider === "openrouter"
  );
}

function modelCapabilities(provider: AgentProviderConfig) {
  return {
    id: provider.model,
    name: provider.model,
    api: providerApi(provider),
    baseUrl: providerBaseUrl(provider),
    reasoning: provider.provider !== "local",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: provider.provider === "anthropic" ? 200_000 : 128_000,
    maxTokens: 8_192,
    ...(provider.provider === "local"
      ? {
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
            maxTokensField: "max_tokens",
            supportsStrictMode: false,
          },
        }
      : {}),
  };
}

function textDeltaFromEvent(event: AgentSessionEvent): string {
  if (event.type !== "message_update") return "";
  // Ignore echoed user/tool messages — only accumulate assistant output.
  const msg = event.message as unknown;
  if (msg && typeof msg === "object" && "role" in msg && msg.role !== "assistant") return "";
  const assistantEvent = event.assistantMessageEvent as unknown;
  if (!assistantEvent || typeof assistantEvent !== "object") return "";
  if (!("type" in assistantEvent) || assistantEvent.type !== "text_delta") return "";
  if (!("delta" in assistantEvent) || typeof assistantEvent.delta !== "string") return "";
  return assistantEvent.delta;
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item) => item && typeof item === "object" && "type" in item && item.type === "text")
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .join("");
}

function defaultFactory(): PiSessionFactory {
  return async ({ customTools, model, modelRegistry, workspaceRoot }) => {
    const { session } = await createAgentSession({
      authStorage: modelRegistry.authStorage,
      customTools,
      cwd: workspaceRoot,
      model: model as never, // SDK requires the opaque Model object; no public type to use here
      modelRegistry,
      noTools: "all",
      sessionManager: SessionManager.inMemory(),
      tools: customTools.map((tool) => tool.name),
    });
    return session;
  };
}

export async function createTesseraModelRegistry(options: {
  credential?: string;
  provider: AgentProviderConfig;
}): Promise<{ model: unknown; modelRegistry: ModelRegistry }> {
  const authStorage = AuthStorage.inMemory();
  if (options.credential) {
    authStorage.setRuntimeApiKey(options.provider.provider, options.credential);
  }
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  if (providerRequiresCredential(options.provider) && !options.credential) {
    throw new Error(
      `${options.provider.provider} is not configured. Add an API key in Settings > Model.`
    );
  }

  let model = modelRegistry.find(options.provider.provider, options.provider.model);
  if (!model) {
    modelRegistry.registerProvider(options.provider.provider, {
      ...(options.provider.provider === "local"
        ? { apiKey: "tessera-local-placeholder", authHeader: false }
        : {}),
      baseUrl: providerBaseUrl(options.provider),
      models: [modelCapabilities(options.provider) as never],
    });
    model = modelRegistry.find(options.provider.provider, options.provider.model);
  }

  if (!model) {
    throw new Error(
      `Could not resolve model: ${options.provider.provider}/${options.provider.model}`
    );
  }

  return { model, modelRegistry };
}

function buildPrompt(
  prompt: string,
  options: {
    agentInstructions?: string;
    activeSkillContent?: string;
    conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
  }
): string {
  const { conversationHistory } = options;
  const sections: string[] = [];

  // Tessera identity + any agent-specific instructions go first so the model
  // always sees our business-oriented framing regardless of the SDK system prompt.
  const identity = [TESSERA_SYSTEM_PROMPT, options.agentInstructions].filter(Boolean).join("\n\n");
  if (identity) sections.push(identity);

  if (options.activeSkillContent) {
    sections.push(options.activeSkillContent);
  }

  if (conversationHistory && conversationHistory.length > 0) {
    const lines = conversationHistory
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
      .join("\n");
    sections.push(`Prior conversation:\n${lines}`);
  }
  sections.push(
    "Response requirement:\nAfter using tools, always end your turn with a concise user-visible response summarizing what you did, where any deliverable was saved, and any relevant caveat. Do not end with only tool calls."
  );
  sections.push(`User task:\n${prompt}`);
  return sections.join("\n\n");
}

function buildAgentInstructions(
  agent: AgentProfile | undefined,
  runtime: AgentRuntimeContext | undefined,
  options?: { hasTaskChecklistTool?: boolean }
): string | undefined {
  if (!agent && !runtime && !options?.hasTaskChecklistTool) return undefined;

  const sections = [
    agent?.instructions ? `Agent instructions:\n${agent.instructions}` : "",
    agent?.soul ? `Agent soul:\n${agent.soul}` : "",
    agent?.userContext ? `User context:\n${agent.userContext}` : "",
    agent?.memoryDefaults ? `Memory defaults:\n${agent.memoryDefaults}` : "",
    runtime?.toolPolicy.approvalMode === "ask"
      ? "Tool policy:\nAsk for approval before using mutating workspace tools."
      : "",
    options?.hasTaskChecklistTool
      ? "Task checklist guidance:\nWhen the user asks for a plan, checklist, or other multi-step work, create or update the task checklist early with the todo tool and keep it current as you work. Move items to in_progress or completed as the work advances, and make sure finished work is reflected in the checklist before you end your turn."
      : "",
    options?.hasTaskChecklistTool
      ? "Task clarification guidance:\nIf progress is blocked by missing requirements, ambiguity, or a decision only the user can make, use the clarify tool instead of guessing. Prefer clarify early before taking irreversible or highly branchy action."
      : "",
    options?.hasTaskChecklistTool
      ? "Web research guidance:\nWhen the user asks you to search the web, check current online information, or fetch the contents of a public URL, use the shell tool early. Prefer `web-search search ...` for research queries and `web-fetch fetch <url>` for specific pages."
      : "",
    "Skill guidance:\nUse skill_list to discover enabled procedural skills and skill_load to load a specific skill when it would materially improve the work. Active task skills are already included in this prompt and should be followed when relevant.",
  ].filter(Boolean);

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function createSkillToolDefinitions(
  skillRuntime?: RunPiTaskTurnOptions["skillRuntime"]
): ToolDefinition[] {
  if (!skillRuntime) return [];

  return [
    defineTool({
      name: "skill_list",
      label: "List Skills",
      description: "List procedural skills enabled for this agent and task.",
      promptSnippet: "skill_list: list enabled procedural skills.",
      parameters: Type.Object({}),
      async execute() {
        const skills = await skillRuntime.listSkills();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ skills }),
            },
          ],
          details: { skills },
        };
      },
    }),
    defineTool({
      name: "skill_load",
      label: "Load Skill",
      description: "Load the full instruction content for one enabled skill.",
      promptSnippet: "skill_load: load full instructions for a specific enabled skill.",
      parameters: Type.Object({
        skillId: Type.String(),
      }),
      async execute(_toolCallId, params) {
        const input = params as { skillId?: string };
        if (!input.skillId) throw new Error("skillId is required");
        const skill = await skillRuntime.loadSkill(input.skillId);
        return {
          content: [
            {
              type: "text",
              text: skill.content,
            },
          ],
          details: { skill },
        };
      },
    }),
  ];
}

async function activeSkillContent(
  skillRuntime?: RunPiTaskTurnOptions["skillRuntime"]
): Promise<string | undefined> {
  if (!skillRuntime?.activeSkills || skillRuntime.activeSkills.length === 0) return undefined;
  const sections: string[] = [];
  for (const active of skillRuntime.activeSkills) {
    const skill = await skillRuntime.loadSkill(active.skillId).catch(() => undefined);
    if (!skill) continue;
    sections.push(`Active skill: ${skill.name}\n${skill.content}`);
  }
  return sections.length > 0 ? `Active task skills:\n\n${sections.join("\n\n")}` : undefined;
}

function createShellToolDefinition(shell?: ShellExecutor): ToolDefinition[] {
  if (!shell) return [];

  return [
    defineTool({
      name: "shell",
      label: "Shell",
      description: "Run approved built-in CLI commands for web search and web fetch.",
      promptSnippet:
        "shell: run built-in read-only commands like web-search search <query> and web-fetch fetch <url>.",
      parameters: Type.Object({
        command: Type.String(),
        subcommand: Type.String(),
        args: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params) {
        const call = params as ShellToolCall;
        const policy = findCliCommand(call);
        if (!policy || policy.approval !== "allow") {
          throw new Error(
            `${formatShellPreview(call)} requires approval and is not available in task mode.`
          );
        }
        const result = await shell.executeShell({
          command: call.command,
          subcommand: call.subcommand,
          args: call.args ?? [],
        });
        return {
          content: [
            {
              type: "text",
              text: result.stdout || result.stderr || `${formatShellPreview(call)} completed.`,
            },
          ],
          details: result,
        };
      },
    }),
  ];
}

export async function runPiTaskTurn(options: RunPiTaskTurnOptions): Promise<PiTaskTurnResult> {
  const guard = await createWorkspaceGuard(options.workspaceRoot);
  let boundaryViolations = 0;
  const allTools = createWorkspaceToolDefinitions(guard, {
    onViolation: (_toolName) => {
      boundaryViolations++;
    },
  });
  const taskTools = createTaskToolDefinitions(options.taskRuntime);
  const shellTools = createShellToolDefinition(options.shell);
  const skillTools = createSkillToolDefinitions(options.skillRuntime);
  const runtime =
    options.runtime ?? (options.agent ? compileAgentRuntimeContext(options.agent) : undefined);
  const toolDefinitions = [...allTools, ...taskTools, ...shellTools, ...skillTools];
  const allowedTools = new Set(
    runtime?.toolPolicy.allowedTools ?? toolDefinitions.map((tool) => tool.name)
  );
  const customTools = toolDefinitions.filter((tool) => allowedTools.has(tool.name));

  const { model, modelRegistry } = await createTesseraModelRegistry({
    ...(options.credential ? { credential: options.credential } : {}),
    provider: options.provider,
  });

  const session = await (options.factory ?? defaultFactory())({
    customTools,
    model,
    modelRegistry,
    workspaceRoot: guard.root,
  });

  const agentInstructions = buildAgentInstructions(options.agent, runtime, {
    hasTaskChecklistTool: taskTools.some((tool) => tool.name === "todo"),
  });
  const activeSkills = await activeSkillContent(options.skillRuntime);

  let text = "";
  let finalizedText = "";
  let modelError: string | undefined;

  const unsubscribe = session.subscribe((event) => {
    const delta = textDeltaFromEvent(event);
    if (delta) text += delta;
    if (event.type === "tool_execution_start") {
      options.onActivity?.(`Using ${event.toolName}`);
      options.onToolStart?.({
        name: event.toolName,
        args: "args" in event ? event.args : undefined,
      });
    }
    // The SDK fires message_end for user messages too (before the model call).
    // Only capture text from assistant messages so we don't pick up the echoed prompt.
    if (event.type === "message_end" || event.type === "turn_end") {
      const assistantMsg = event.message as {
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
      };
      if (assistantMsg?.role === "assistant") {
        // Capture any error from the model API so we can surface it.
        if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
          modelError =
            assistantMsg.errorMessage ||
            `Model call failed (stopReason: ${assistantMsg.stopReason})`;
        }
        const nextText = textFromMessage(event.message);
        if (nextText.trim()) finalizedText = nextText;
      }
    }
    if (event.type === "agent_end") {
      // agent_end.messages includes user messages; skip them.
      for (const message of [...event.messages].reverse()) {
        const m = message as { role?: string; stopReason?: string; errorMessage?: string };
        if (m?.role !== "assistant") continue;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          modelError = m.errorMessage || `Model call failed (stopReason: ${m.stopReason})`;
          break;
        }
        const nextText = textFromMessage(message);
        if (nextText.trim()) {
          finalizedText = nextText;
          break;
        }
      }
    }
  });

  try {
    await session.prompt(
      buildPrompt(options.prompt, {
        ...(agentInstructions ? { agentInstructions } : {}),
        ...(activeSkills ? { activeSkillContent: activeSkills } : {}),
        ...(options.conversationHistory !== undefined
          ? { conversationHistory: options.conversationHistory }
          : {}),
      })
    );
  } finally {
    unsubscribe();
    session.dispose();
  }

  // Surface model errors so task-runner can mark the task as failed with a real message.
  if (modelError && !finalizedText && !text) {
    throw new Error(modelError);
  }

  // Prefer the finalized message content (turn_end/agent_end) as it is authoritative;
  // fall back to accumulated deltas only if the SDK did not emit a finalized message.
  return { text: finalizedText || text, boundaryViolations };
}
