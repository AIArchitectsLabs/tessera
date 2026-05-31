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
    google: { provider: "google", model: "gemini-3.5-flash", hasCredential: false },
    "openai-codex": { provider: "openai-codex", model: "gpt-5.4", hasCredential: false },
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
    expect(result.credential).toMatchObject({ apiKey: "sk-openai" });
    expect(result.runtime.toolPolicy.allowedTools).toContain("workspace_write");
    expect(result.agent.skills).toEqual([
      "planning",
      "research-synthesis",
      "word-docs",
      "pdf-workflows",
      "slide-decks",
      "spreadsheets",
      "workspace-delivery",
      "decision-briefs",
    ]);
    expect(result.runtime.compiledSummary).toContain("8 profile skills enabled");
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
          thinkingLevel: "high",
        },
      },
      instructions: "",
      soul: "",
      userContext: "",
      skills: [],
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
    expect(result.provider).toMatchObject({ thinkingLevel: "high" });
    expect(result.credential).toMatchObject({ apiKey: "sk-anthropic" });
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

  test("Codex OAuth is resolved as a distinct provider and still requires credentials", () => {
    expect(() =>
      resolveTaskExecutionConfig({
        agent: DEFAULT_AGENT_PROFILE,
        modelSettings: { ...settings, selectedProvider: "openai-codex" },
      })
    ).toThrow("openai-codex is not configured");

    const result = resolveTaskExecutionConfig({
      agent: DEFAULT_AGENT_PROFILE,
      credential: {
        authType: "codex-oauth",
        accessToken: "access-token",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      modelSettings: { ...settings, selectedProvider: "openai-codex" },
    });

    expect(result.provider).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(result.credential).toMatchObject({
      authType: "codex-oauth",
      accessToken: "access-token",
    });
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

  test("Google AI Studio uses the Gemini API key environment fallback and requires credentials", () => {
    expect(() =>
      resolveTaskExecutionConfig({
        agent: DEFAULT_AGENT_PROFILE,
        modelSettings: { ...settings, selectedProvider: "google" },
      })
    ).toThrow("google is not configured. Add an API key in Settings > Model.");

    const result = resolveTaskExecutionConfig({
      agent: DEFAULT_AGENT_PROFILE,
      credential: "gemini-key",
      modelSettings: { ...settings, selectedProvider: "google" },
    });

    expect(result.provider).toEqual({
      provider: "google",
      model: "gemini-3.5-flash",
      apiKeyEnv: "GOOGLE_AI_STUDIO_API_KEY",
    });
  });
});
