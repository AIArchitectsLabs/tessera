import type { AgentSessionEvent, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AgentProfile, AgentProviderConfig } from "@tessera/contracts";
import { createWorkspaceGuard } from "./workspace-guard.js";
import { createWorkspaceToolDefinitions } from "./workspace-tools.js";

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
  prompt: string;
  provider: AgentProviderConfig;
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
  const assistantEvent = event.assistantMessageEvent as unknown;
  if (!assistantEvent || typeof assistantEvent !== "object") return "";
  if (!("type" in assistantEvent) || assistantEvent.type !== "text_delta") return "";
  if (!("delta" in assistantEvent) || typeof assistantEvent.delta !== "string") return "";
  return assistantEvent.delta;
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
    agent?: AgentProfile;
    conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
  }
): string {
  const { agent, conversationHistory } = options;
  const sections: string[] = [];
  if (agent?.instructions) sections.push(`Agent instructions:\n${agent.instructions}`);
  if (agent?.soul) sections.push(`Agent soul:\n${agent.soul}`);
  if (conversationHistory && conversationHistory.length > 0) {
    const lines = conversationHistory
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
      .join("\n");
    sections.push(`Prior conversation:\n${lines}`);
  }
  sections.push(`User task:\n${prompt}`);
  return sections.join("\n\n");
}

export async function runPiTaskTurn(options: RunPiTaskTurnOptions): Promise<PiTaskTurnResult> {
  const guard = await createWorkspaceGuard(options.workspaceRoot);
  let boundaryViolations = 0;
  const allTools = createWorkspaceToolDefinitions(guard, {
    onViolation: (_toolName) => {
      boundaryViolations++;
    },
  });
  const allowedTools = new Set(options.agent?.tools ?? allTools.map((tool) => tool.name));
  const customTools = allTools.filter((tool) => allowedTools.has(tool.name));

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
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    const delta = textDeltaFromEvent(event);
    if (delta) text += delta;
    if (event.type === "tool_execution_start") {
      options.onActivity?.(`Using ${event.toolName}`);
    }
  });

  try {
    await session.prompt(
      buildPrompt(options.prompt, {
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(options.conversationHistory !== undefined
          ? { conversationHistory: options.conversationHistory }
          : {}),
      })
    );
  } finally {
    unsubscribe();
    session.dispose();
  }

  return { text, boundaryViolations };
}
