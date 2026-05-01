/// <reference types="bun" />

import { AgentProviderConfigSchema, type ModelProvider } from "@tessera/contracts";
import { describe, expect, test } from "bun:test";
import {
  MODEL_PROVIDERS,
  defaultDraftForProvider,
  modelPlaceholderForProvider,
  providerLabel,
  shouldSendCredential,
} from "./modelSettings";

describe("model settings UI helpers", () => {
  test("labels supported providers", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("local")).toBe("Local OpenAI-compatible");
  });

  test("returns model placeholders", () => {
    expect(modelPlaceholderForProvider("openai")).toBe("gpt-5.4");
    expect(modelPlaceholderForProvider("local")).toBe("llama3.2");
  });

  test("omits blank credential replacements", () => {
    expect(shouldSendCredential("")).toBe(false);
    expect(shouldSendCredential("   ")).toBe(false);
    expect(shouldSendCredential("sk-test")).toBe(true);
  });

  test("creates local draft with base url", () => {
    expect(defaultDraftForProvider("local")).toEqual({
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
  });

  test("creates schema-valid defaults for every provider", () => {
    const expected: Record<ModelProvider, ReturnType<typeof defaultDraftForProvider>> = {
      openai: {
        provider: "openai",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      anthropic: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      openrouter: {
        provider: "openrouter",
        model: "openai/gpt-5.4",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      local: {
        provider: "local",
        model: "llama3.2",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    };

    for (const provider of MODEL_PROVIDERS) {
      const draft = defaultDraftForProvider(provider);

      expect(draft).toEqual(expected[provider]);
      expect(AgentProviderConfigSchema.parse(draft)).toEqual(expected[provider]);
    }
  });
});
