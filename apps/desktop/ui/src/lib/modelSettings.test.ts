/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { AgentProviderConfigSchema, type ModelProvider } from "@tessera/contracts";
import {
  MODEL_PROVIDERS,
  defaultDraftForProvider,
  modelOptionsForProvider,
  modelPlaceholderForProvider,
  providerLabel,
  shouldSendCredential,
} from "./modelSettings";

describe("model settings UI helpers", () => {
  test("labels supported providers", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("openai-codex")).toBe("OpenAI Codex");
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("local")).toBe("Local OpenAI-compatible");
  });

  test("returns model placeholders", () => {
    expect(modelPlaceholderForProvider("openai")).toBe("gpt-5.4");
    expect(modelPlaceholderForProvider("openai-codex")).toBe("gpt-5.4");
    expect(modelPlaceholderForProvider("local")).toBe("llama3.2");
  });

  test("returns curated model options and preserves existing custom selections", () => {
    expect(modelOptionsForProvider("openai").map((option) => option.value)).toContain("gpt-5.5");
    expect(modelOptionsForProvider("openrouter").map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "openrouter/auto",
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5.4",
        "google/gemini-2.5-pro",
        "deepseek/deepseek-r1",
        "qwen/qwen3-coder",
      ])
    );
    expect(modelOptionsForProvider("local")).toEqual([]);
    expect(modelOptionsForProvider("openrouter", "custom/provider-model")[0]).toEqual({
      label: "Current: custom/provider-model",
      value: "custom/provider-model",
    });
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

  test("shows Codex OAuth as a selectable model provider", () => {
    expect(MODEL_PROVIDERS).toContain("openai-codex");
    expect(defaultDraftForProvider("openai-codex")).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
  });

  test("creates schema-valid defaults for every provider", () => {
    const expected: Record<ModelProvider, ReturnType<typeof defaultDraftForProvider>> = {
      openai: {
        provider: "openai",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      "openai-codex": {
        provider: "openai-codex",
        model: "gpt-5.4",
      },
      anthropic: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      openrouter: {
        provider: "openrouter",
        model: "openrouter/auto",
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
