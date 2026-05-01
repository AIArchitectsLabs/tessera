import type { AgentProviderConfig, ModelProvider } from "@tessera/contracts";

export const MODEL_PROVIDERS: ModelProvider[] = ["openai", "anthropic", "openrouter", "local"];

export function providerLabel(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "openrouter":
      return "OpenRouter";
    case "local":
      return "Local OpenAI-compatible";
  }
}

export function modelPlaceholderForProvider(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
      return "gpt-5.4";
    case "anthropic":
      return "claude-sonnet-4-6";
    case "openrouter":
      return "openai/gpt-5.4";
    case "local":
      return "llama3.2";
  }
}

export function defaultDraftForProvider(provider: ModelProvider): AgentProviderConfig {
  switch (provider) {
    case "openai":
      return {
        provider: "openai",
        model: modelPlaceholderForProvider("openai"),
        apiKeyEnv: "OPENAI_API_KEY",
      };
    case "anthropic":
      return {
        provider: "anthropic",
        model: modelPlaceholderForProvider("anthropic"),
        apiKeyEnv: "ANTHROPIC_API_KEY",
      };
    case "openrouter":
      return {
        provider: "openrouter",
        model: modelPlaceholderForProvider("openrouter"),
        apiKeyEnv: "OPENROUTER_API_KEY",
      };
    case "local":
      return {
        provider: "local",
        model: modelPlaceholderForProvider("local"),
        baseUrl: "http://127.0.0.1:11434/v1",
      };
  }
}

export function shouldSendCredential(value: string): boolean {
  return value.trim().length > 0;
}
