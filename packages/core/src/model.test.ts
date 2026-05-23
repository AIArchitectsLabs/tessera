import { describe, expect, test } from "bun:test";
import { AgentProviderConfigSchema } from "@tessera/contracts";
import { createAgentModel, resolveApiKey } from "./model.js";

describe("createAgentModel", () => {
  test("creates a direct OpenAI model", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "openai",
      model: "gpt-5.4",
    });

    const model = createAgentModel(config);

    expect(model.provider).toBe("openai");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
    expect(model.id).toBe("gpt-5.4");
  });

  test("creates a direct Anthropic model", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    const model = createAgentModel(config);

    expect(model.provider).toBe("anthropic");
    expect(model.api).toBe("anthropic-messages");
    expect(model.baseUrl).toBe("https://api.anthropic.com");
    expect(model.id).toBe("claude-sonnet-4-6");
  });

  test("creates an OpenRouter OpenAI-compatible model", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "openrouter",
      model: "openai/gpt-5.4",
    });

    const model = createAgentModel(config);

    expect(model.provider).toBe("openrouter");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(model.id).toBe("openai/gpt-5.4");
  });

  test("creates a Google AI Studio OpenAI-compatible Gemini model with cost metadata", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "google",
      model: "gemini-3.5-flash",
    });

    const model = createAgentModel(config);

    expect(model.provider).toBe("google");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(model.id).toBe("gemini-3.5-flash");
    expect(model.contextWindow).toBe(1_048_576);
    expect(model.maxTokens).toBe(65_536);
    expect(model.cost).toEqual({ input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 });
  });

  test("does not route Codex OAuth through the standard OpenAI-compatible model path", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    expect(() => createAgentModel(config)).toThrow("Codex OAuth requires a dedicated transport");
  });

  test("creates a local OpenAI-compatible model", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
    });

    const model = createAgentModel(config);

    expect(model.provider).toBe("local");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(model.id).toBe("llama3.2");
  });

  test("rejects unknown providers", () => {
    const parsed = AgentProviderConfigSchema.safeParse({
      provider: "unknown",
      model: "test",
    });

    expect(parsed.success).toBe(false);
  });

  test("rejects malformed local endpoints", () => {
    const parsed = AgentProviderConfigSchema.safeParse({
      provider: "local",
      model: "test",
      baseUrl: "not-a-url",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("resolveApiKey", () => {
  test("returns in-memory credential before env fallback", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "openai",
      model: "gpt-5.4",
    });
    const previous = process.env.OPENAI_API_KEY;

    process.env.OPENAI_API_KEY = "sk-env";

    try {
      expect(resolveApiKey(config, "sk-memory")).toBe("sk-memory");
    } finally {
      if (previous === undefined) {
        process.env.OPENAI_API_KEY = undefined;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  test("falls back to env when no in-memory credential is supplied", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "openai",
      model: "gpt-5.4",
    });
    const previous = process.env.OPENAI_API_KEY;

    process.env.OPENAI_API_KEY = "sk-env";

    try {
      expect(resolveApiKey(config)).toBe("sk-env");
    } finally {
      if (previous === undefined) {
        process.env.OPENAI_API_KEY = undefined;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  test("falls back to Google AI Studio env key for Gemini", () => {
    const config = AgentProviderConfigSchema.parse({
      provider: "google",
      model: "gemini-3.5-flash",
    });
    const previous = process.env.GOOGLE_AI_STUDIO_API_KEY;

    process.env.GOOGLE_AI_STUDIO_API_KEY = "gemini-env";

    try {
      expect(resolveApiKey(config)).toBe("gemini-env");
    } finally {
      if (previous === undefined) {
        process.env.GOOGLE_AI_STUDIO_API_KEY = undefined;
      } else {
        process.env.GOOGLE_AI_STUDIO_API_KEY = previous;
      }
    }
  });
});
