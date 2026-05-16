import { describe, expect, test } from "bun:test";
import {
  AgentTurnRequestSchema,
  ModelCredentialDeleteRequestSchema,
  ModelProviderSettingsSchema,
  ModelSettingsReadSchema,
  ModelSettingsSaveRequestSchema,
} from "./index.js";

describe("model settings contracts", () => {
  test("parses redacted settings without API key values", () => {
    const parsed = ModelSettingsReadSchema.parse({
      selectedProvider: "openai",
      providers: {
        openai: { provider: "openai", model: "gpt-5.4", hasCredential: true },
        anthropic: { provider: "anthropic", model: "claude-sonnet-4-6", hasCredential: false },
        google: { provider: "google", model: "gemini-2.5-pro", hasCredential: false },
        openrouter: { provider: "openrouter", model: "openai/gpt-5.4", hasCredential: false },
        "openai-codex": { provider: "openai-codex", model: "gpt-5.4", hasCredential: false },
        local: {
          provider: "local",
          model: "llama3.2",
          baseUrl: "http://127.0.0.1:11434/v1",
          hasCredential: false,
        },
      },
    });

    expect(parsed.providers.openai.hasCredential).toBe(true);
    expect("apiKey" in parsed.providers.openai).toBe(false);
    expect(parsed.providers["openai-codex"].provider).toBe("openai-codex");
  });

  test("accepts a save request with an optional replacement key", () => {
    const parsed = ModelSettingsSaveRequestSchema.parse({
      selectedProvider: "openai",
      provider: { provider: "openai", model: "gpt-5.4" },
      hasExistingCredential: true,
      credential: { apiKey: "sk-test" },
    });

    expect(parsed.credential).toMatchObject({ apiKey: "sk-test" });
    expect(parsed.hasExistingCredential).toBe(true);
  });

  test("rejects a save request when selected and configured providers differ", () => {
    expect(() =>
      ModelSettingsSaveRequestSchema.parse({
        selectedProvider: "openai",
        provider: { provider: "anthropic", model: "claude-sonnet-4-6" },
      })
    ).toThrow();
  });

  test("accepts local provider settings without credentials", () => {
    const parsed = ModelProviderSettingsSchema.parse({
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
      hasCredential: false,
    });

    expect(parsed.provider).toBe("local");
  });

  test("accepts Google AI Studio provider settings and save requests", () => {
    const settings = ModelProviderSettingsSchema.parse({
      provider: "google",
      model: "gemini-2.5-pro",
      hasCredential: true,
    });

    const request = ModelSettingsSaveRequestSchema.parse({
      selectedProvider: "google",
      provider: { provider: "google", model: "gemini-2.5-pro" },
      credential: { apiKey: "AIza-test" },
    });

    expect(settings.provider).toBe("google");
    expect(request.provider.provider).toBe("google");
    expect(request.credential?.apiKey).toBe("AIza-test");
  });

  test("accepts credential delete request for one provider", () => {
    const parsed = ModelCredentialDeleteRequestSchema.parse({ provider: "openai-codex" });
    expect(parsed.provider).toBe("openai-codex");
  });

  test("agent turn credential is separate from provider config", () => {
    const parsed = AgentTurnRequestSchema.parse({
      prompt: "Reply OK",
      provider: { provider: "openai", model: "gpt-5.4", thinkingLevel: "medium" },
      credential: { apiKey: "sk-test" },
    });

    expect(parsed.credential).toMatchObject({ apiKey: "sk-test" });
    expect("apiKey" in parsed.provider).toBe(false);
    expect(parsed.provider).toMatchObject({ thinkingLevel: "medium" });
  });

  test("agent turn accepts Codex OAuth runtime credentials without API key shape", () => {
    const parsed = AgentTurnRequestSchema.parse({
      prompt: "Reply OK",
      provider: { provider: "openai-codex", model: "gpt-5.4" },
      credential: {
        authType: "codex-oauth",
        accessToken: "access-token",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        accountId: "acct_test",
      },
    });

    expect(parsed.credential).toMatchObject({
      authType: "codex-oauth",
      accessToken: "access-token",
      accountId: "acct_test",
    });
  });

  test("agent turn accepts Google AI Studio provider config", () => {
    const parsed = AgentTurnRequestSchema.parse({
      prompt: "Reply OK",
      provider: { provider: "google", model: "gemini-2.5-pro", apiKeyEnv: "GEMINI_API_KEY" },
      credential: { apiKey: "AIza-test" },
    });

    expect(parsed.provider.provider).toBe("google");
  });
});
