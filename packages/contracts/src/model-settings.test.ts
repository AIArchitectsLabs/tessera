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
        openrouter: { provider: "openrouter", model: "openai/gpt-5.4", hasCredential: false },
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
  });

  test("accepts a save request with an optional replacement key", () => {
    const parsed = ModelSettingsSaveRequestSchema.parse({
      selectedProvider: "openai",
      provider: { provider: "openai", model: "gpt-5.4" },
      hasExistingCredential: true,
      credential: { apiKey: "sk-test" },
    });

    expect(parsed.credential?.apiKey).toBe("sk-test");
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

  test("accepts credential delete request for one provider", () => {
    const parsed = ModelCredentialDeleteRequestSchema.parse({ provider: "anthropic" });
    expect(parsed.provider).toBe("anthropic");
  });

  test("agent turn credential is separate from provider config", () => {
    const parsed = AgentTurnRequestSchema.parse({
      prompt: "Reply OK",
      provider: { provider: "openai", model: "gpt-5.4" },
      credential: { apiKey: "sk-test" },
    });

    expect(parsed.credential?.apiKey).toBe("sk-test");
    expect("apiKey" in parsed.provider).toBe(false);
  });
});
