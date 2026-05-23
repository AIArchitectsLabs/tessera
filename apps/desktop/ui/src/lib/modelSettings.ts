import type { AgentProviderConfig, ModelProvider } from "@tessera/contracts";

export interface ModelOption {
  label: string;
  value: string;
}

export const MODEL_PROVIDERS: ModelProvider[] = [
  "openai",
  "openai-codex",
  "anthropic",
  "openrouter",
  "google",
  "local",
];

export const MODEL_OPTIONS_BY_PROVIDER: Record<ModelProvider, ModelOption[]> = {
  openai: [
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
    { label: "GPT-4.1", value: "gpt-4.1" },
  ],
  "openai-codex": [
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
  ],
  anthropic: [
    { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
    { label: "Claude 3.7 Sonnet", value: "claude-3.7-sonnet" },
  ],
  openrouter: [
    { label: "Auto Router", value: "openrouter/auto" },
    { label: "Anthropic Claude Sonnet 4.6", value: "anthropic/claude-sonnet-4.6" },
    { label: "Anthropic Claude Opus 4.7", value: "anthropic/claude-opus-4.7" },
    { label: "Anthropic Claude Haiku 4.5", value: "anthropic/claude-haiku-4.5" },
    { label: "OpenAI GPT-5.5", value: "openai/gpt-5.5" },
    { label: "OpenAI GPT-5.4", value: "openai/gpt-5.4" },
    { label: "OpenAI GPT-5.4 Mini", value: "openai/gpt-5.4-mini" },
    { label: "OpenAI GPT Chat Latest", value: "openai/gpt-chat-latest" },
    { label: "Google Gemini 3.5 Flash", value: "google/gemini-3.5-flash" },
    { label: "Google Gemini 2.5 Pro", value: "google/gemini-2.5-pro" },
    { label: "Google Gemini 2.5 Flash", value: "google/gemini-2.5-flash" },
    { label: "DeepSeek V3.2", value: "deepseek/deepseek-v3.2" },
    { label: "DeepSeek R1", value: "deepseek/deepseek-r1" },
    { label: "Qwen 3.6 Plus", value: "qwen/qwen3.6-plus" },
    { label: "Qwen 3 Max", value: "qwen/qwen3-max" },
    { label: "Qwen 3 Coder", value: "qwen/qwen3-coder" },
    { label: "xAI Grok 4.3", value: "x-ai/grok-4.3" },
    { label: "Meta Llama 4 Maverick", value: "meta-llama/llama-4-maverick" },
    { label: "Mistral Medium 3.5", value: "mistralai/mistral-medium-3-5" },
    { label: "Z.ai GLM 4.6", value: "z-ai/glm-4.6" },
  ],
  google: [
    { label: "Gemini 3.5 Flash", value: "gemini-3.5-flash" },
    { label: "Gemini 3.1 Pro Preview", value: "gemini-3.1-pro-preview" },
    { label: "Gemini 3 Flash Preview", value: "gemini-3-flash-preview" },
    { label: "Gemini 3.1 Flash-Lite", value: "gemini-3.1-flash-lite" },
    { label: "Gemini 3.1 Flash-Lite Preview", value: "gemini-3.1-flash-lite-preview" },
    { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
    { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
    { label: "Gemini 2.5 Flash-Lite", value: "gemini-2.5-flash-lite" },
  ],
  local: [],
};

export function providerLabel(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "openai-codex":
      return "OpenAI Codex";
    case "anthropic":
      return "Anthropic";
    case "openrouter":
      return "OpenRouter";
    case "google":
      return "Google AI Studio";
    case "local":
      return "Local OpenAI-compatible";
  }
}

export function modelPlaceholderForProvider(provider: ModelProvider): string {
  return MODEL_OPTIONS_BY_PROVIDER[provider][0]?.value ?? "llama3.2";
}

export function modelOptionsForProvider(
  provider: ModelProvider,
  currentModel?: string
): ModelOption[] {
  const options = MODEL_OPTIONS_BY_PROVIDER[provider];
  if (!currentModel || options.some((option) => option.value === currentModel)) return options;
  return [{ label: `Current: ${currentModel}`, value: currentModel }, ...options];
}

export function defaultDraftForProvider(provider: ModelProvider): AgentProviderConfig {
  switch (provider) {
    case "openai":
      return {
        provider: "openai",
        model: modelPlaceholderForProvider("openai"),
        apiKeyEnv: "OPENAI_API_KEY",
      };
    case "openai-codex":
      return {
        provider: "openai-codex",
        model: modelPlaceholderForProvider("openai-codex"),
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
    case "google":
      return {
        provider: "google",
        model: modelPlaceholderForProvider("google"),
        apiKeyEnv: "GOOGLE_AI_STUDIO_API_KEY",
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
