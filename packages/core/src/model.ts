import type { Model } from "@mariozechner/pi-ai";
import type { AgentProviderConfig } from "@tessera/contracts";

export function resolveApiKey(
  config: AgentProviderConfig,
  credential?: string
): string | undefined {
  if (credential) return credential;

  if (config.provider === "openai-codex") {
    return undefined;
  }

  if (config.provider === "openai") {
    return process.env[config.apiKeyEnv];
  }

  if (config.provider === "anthropic") {
    return process.env[config.apiKeyEnv];
  }

  if (config.provider === "openrouter") {
    return process.env[config.apiKeyEnv];
  }

  if (config.provider === "google") {
    return process.env[config.apiKeyEnv];
  }

  if (!config.apiKeyEnv) return undefined;
  return process.env[config.apiKeyEnv];
}

export function createAgentModel(
  config: AgentProviderConfig
): Model<"openai-completions" | "anthropic-messages"> {
  if (config.provider === "openai-codex") {
    throw new Error("Codex OAuth requires a dedicated transport before task execution.");
  }

  if (config.provider === "openai") {
    return {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
  }

  if (config.provider === "anthropic") {
    return {
      id: config.model,
      name: config.model,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
  }

  if (config.provider === "openrouter") {
    return {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
      compat: {
        thinkingFormat: "openrouter",
      },
    };
  }

  if (config.provider === "google") {
    return {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      reasoning: true,
      input: ["text"],
      cost: geminiCostForModel(config.model),
      contextWindow: geminiContextWindowForModel(config.model),
      maxTokens: geminiMaxTokensForModel(config.model),
    };
  }

  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "local",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
  };
}

function geminiCostForModel(model: string) {
  if (model === "gemini-3.5-flash") {
    return { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 };
  }
  if (model === "gemini-3.1-pro-preview" || model === "gemini-3-flash-preview") {
    return { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 };
  }
  if (model.startsWith("gemini-3.1-flash-lite")) {
    return { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 };
  }
  if (model === "gemini-2.5-pro") {
    return { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
  }
  if (model === "gemini-2.5-flash") {
    return { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 };
  }
  if (model === "gemini-2.5-flash-lite") {
    return { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 };
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function geminiContextWindowForModel(model: string): number {
  if (model.startsWith("gemini-3")) return 1_048_576;
  return 1_048_576;
}

function geminiMaxTokensForModel(model: string): number {
  if (model.startsWith("gemini-3")) return 65_536;
  return 65_536;
}
