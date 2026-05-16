import type {
  AgentProfile,
  AgentProviderConfig,
  ModelProvider,
  ModelProviderSettings,
  ModelRuntimeCredential,
  ModelSettingsRead,
  TaskExecutionConfig,
} from "@tessera/contracts";
import { compileAgentRuntimeContext } from "@tessera/contracts";

const now = "1970-01-01T00:00:00.000Z";

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: "default",
  name: "Tessera",
  model: { mode: "default" },
  description: "Built-in workspace agent for business planning, drafting, and delivery.",
  instructions:
    "Turn broad business requests into concrete plans, research syntheses, format-specific document workflows, workspace deliverables, and decision briefs. Prefer practical artifacts, explicit next steps, and verified workspace changes over abstract advice.",
  soul: "Direct, calm, and concise. Operate like a senior business partner who values clear decisions and finished work.",
  userContext:
    "You are helping a business operator or founder inside their current workspace. They want useful output quickly, not a tutorial.",
  skills: [
    "planning",
    "research-synthesis",
    "word-docs",
    "pdf-workflows",
    "slide-decks",
    "spreadsheets",
    "workspace-delivery",
    "decision-briefs",
  ],
  toolPolicyPreset: "workspace_editor",
  memoryDefaults:
    "Reuse workspace terminology, active project names, stakeholder names, and established deliverable formats when they are already present.",
  createdAt: now,
  updatedAt: now,
};

function apiKeyEnvFor(provider: Exclude<ModelProvider, "local" | "openai-codex">): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "google") return "GEMINI_API_KEY";
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

  if (settings.provider === "openai-codex") {
    return {
      provider: "openai-codex",
      model: settings.model,
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
    provider.provider === "openai-codex" ||
    provider.provider === "anthropic" ||
    provider.provider === "google" ||
    provider.provider === "openrouter"
  );
}

export function resolveTaskExecutionConfig(options: {
  agent?: AgentProfile;
  credential?: ModelRuntimeCredential | string;
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
    runtime: compileAgentRuntimeContext(agent),
    provider,
    ...(options.credential
      ? {
          credential:
            typeof options.credential === "string"
              ? { apiKey: options.credential }
              : options.credential,
        }
      : {}),
  };
}
