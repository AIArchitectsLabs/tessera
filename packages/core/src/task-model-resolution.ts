import type {
  AgentProfile,
  AgentProviderConfig,
  ModelProvider,
  ModelProviderSettings,
  ModelSettingsRead,
  TaskExecutionConfig,
} from "@tessera/contracts";

const now = "1970-01-01T00:00:00.000Z";

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: "default",
  name: "Tessera",
  model: { mode: "default" },
  instructions: "You are Tessera's workspace agent. Work inside the selected workspace.",
  soul: "",
  skills: [],
  tools: [
    "workspace_read",
    "workspace_list",
    "workspace_search",
    "workspace_write",
    "workspace_edit",
  ],
  createdAt: now,
  updatedAt: now,
};

function apiKeyEnvFor(provider: Exclude<ModelProvider, "local">): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "OPENAI_API_KEY";
}

function providerSettingsToConfig(settings: ModelProviderSettings): AgentProviderConfig {
  if (settings.provider === "local") {
    return {
      provider: "local",
      model: settings.model,
      baseUrl: settings.baseUrl,
    };
  }

  return {
    provider: settings.provider,
    model: settings.model,
    apiKeyEnv: apiKeyEnvFor(settings.provider),
  };
}

function requiresCredential(provider: AgentProviderConfig): boolean {
  return (
    provider.provider === "openai" ||
    provider.provider === "anthropic" ||
    provider.provider === "openrouter"
  );
}

export function resolveTaskExecutionConfig(options: {
  agent?: AgentProfile;
  credential?: string;
  modelSettings: ModelSettingsRead;
}): TaskExecutionConfig {
  const agent = options.agent ?? DEFAULT_AGENT_PROFILE;
  const provider =
    agent.model.mode === "override"
      ? agent.model.provider
      : providerSettingsToConfig(
          options.modelSettings.providers[options.modelSettings.selectedProvider]
        );

  if (requiresCredential(provider) && !options.credential) {
    throw new Error(`${provider.provider} is not configured. Add an API key in Settings > Model.`);
  }

  return {
    agent,
    provider,
    ...(options.credential ? { credential: { apiKey: options.credential } } : {}),
  };
}
