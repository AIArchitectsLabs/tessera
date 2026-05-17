import { afterEach, describe, expect, test } from "bun:test";
import { executeAgentTurn } from "./agent.js";
import type { WorkspaceCliExecutor } from "./tools.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("executeAgentTurn", () => {
  test("preserves token usage returned by Codex Responses turns", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              output: [
                {
                  content: [
                    {
                      type: "output_text",
                      text: "Done",
                    },
                  ],
                },
              ],
              usage: {
                input_tokens: 1200,
                output_tokens: 340,
                total_tokens: 1540,
                input_tokens_details: {
                  cached_tokens: 200,
                },
                output_tokens_details: {
                  reasoning_tokens: 25,
                },
              },
            },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          headers: {
            "content-type": "text/event-stream",
          },
        }
      )) as unknown as typeof fetch;

    const cli: WorkspaceCliExecutor = {
      runWorkspaceCli: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 0,
      }),
    };

    const result = await executeAgentTurn({
      cli,
      request: {
        prompt: "Summarize the meeting.",
        provider: { provider: "openai-codex", model: "gpt-5.4" },
        credential: {
          authType: "codex-oauth",
          accessToken: "access-token",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        grants: [],
        timeoutMs: 60_000,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      cachedInputTokens: 200,
      reasoningTokens: 25,
    });
  });
});
