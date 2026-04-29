import { describe, expect, test } from "bun:test";
import { AgentProviderConfigSchema } from "@tessera/contracts";
import { createAgentModel } from "./model.js";

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
