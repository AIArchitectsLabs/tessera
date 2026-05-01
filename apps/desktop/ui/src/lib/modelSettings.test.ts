// @ts-nocheck -- UI package typecheck does not currently load Bun test module types.
import { describe, expect, test } from "bun:test";
import {
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
});
