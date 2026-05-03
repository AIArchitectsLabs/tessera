import { describe, expect, test } from "bun:test";
import type { AgentProfile, ModelSettingsRead } from "@tessera/contracts";
import { DEFAULT_AGENT_PROFILE, resolveTaskExecutionConfig } from "./task-model-resolution.js";

const now = "2026-05-02T00:00:00.000Z";

const settings: ModelSettingsRead = {
  selectedProvider: "openai",
  providers: {
    openai: { provider: "openai", model: "gpt-5.4", hasCredential: true },
    anthropic: { provider: "anthropic", model: "claude-sonnet-4-6", hasCredential: false },
    openrouter: { provider: "openrouter", model: "openai/gpt-5.4", hasCredential: false },
    local: {
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
      hasCredential: false,
    },
  },
};

describe("resolveTaskExecutionConfig", () => {
  test("default agent uses global selected provider", () => {
    const result = resolveTaskExecutionConfig({
      agent: DEFAULT_AGENT_PROFILE,
      credential: "sk-openai",
      modelSettings: settings,
    });

    expect(result.provider).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(result.credential?.apiKey).toBe("sk-openai");
    expect(result.runtime.toolPolicy.allowedTools).toContain("workspace_write");
    expect("credential" in result.agent).toBe(false);
  });

  test("agent override uses override provider", () => {
    const agent: AgentProfile = {
      id: "writer",
      name: "Writer",
      model: {
        mode: "override",
        provider: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
      },
      instructions: "",
      soul: "",
      userContext: "",
      toolPolicyPreset: "read_only",
      memoryDefaults: "",
      createdAt: now,
      updatedAt: now,
    };

    const result = resolveTaskExecutionConfig({
      agent,
      credential: "sk-anthropic",
      modelSettings: settings,
    });

    expect(result.provider.provider).toBe("anthropic");
    expect(result.credential?.apiKey).toBe("sk-anthropic");
    expect(result.runtime.modelSource).toBe("profile_override");
  });

  test("cloud provider without credential fails before Pi session creation", () => {
    expect(() =>
      resolveTaskExecutionConfig({
        agent: DEFAULT_AGENT_PROFILE,
        modelSettings: settings,
      })
    ).toThrow("openai is not configured. Add an API key in Settings > Model.");
  });

  test("local provider without credential succeeds", () => {
    const result = resolveTaskExecutionConfig({
      agent: DEFAULT_AGENT_PROFILE,
      modelSettings: { ...settings, selectedProvider: "local" },
    });

    expect(result.provider).toEqual({
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(result.credential).toBeUndefined();
  });
});
