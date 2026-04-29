import type { Model } from "@mariozechner/pi-ai";
import type { AgentProviderConfig } from "@tessera/contracts";

export function resolveApiKey(config: AgentProviderConfig): string | undefined {
  if (config.provider === "openai") {
    return process.env[config.apiKeyEnv];
  }

  if (config.provider === "anthropic") {
    return process.env[config.apiKeyEnv];
  }

  if (config.provider === "openrouter") {
    return process.env[config.apiKeyEnv];
  }

  if (!config.apiKeyEnv) return undefined;
  return process.env[config.apiKeyEnv];
}

export function createAgentModel(
  config: AgentProviderConfig
): Model<"openai-completions" | "anthropic-messages"> {
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
