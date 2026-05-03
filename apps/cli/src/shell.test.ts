import { describe, expect, test } from "bun:test";
import { executeCliCommand } from "./shell.js";

describe("workspace cli shell commands", () => {
  test("returns structured brave search results", async () => {
    const result = await executeCliCommand(["web-search", "search", "tessera"], {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Tessera",
                  url: "https://example.com",
                  description: "Agent workspace",
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        ),
      getBraveApiKey: async () => "brave-test",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      query: "tessera",
      results: [
        {
          title: "Tessera",
          url: "https://example.com",
          snippet: "Agent workspace",
          source: "example.com",
        },
      ],
    });
  });

  test("returns a stable missing-credential error for brave search", async () => {
    const result = await executeCliCommand(["web-search", "search", "tessera"], {
      fetchImpl: async () => new Response("", { status: 500 }),
      getBraveApiKey: async () => null,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Settings > Integrations");
  });

  test("returns markdown extraction for fetched html pages", async () => {
    const result = await executeCliCommand(["web-fetch", "fetch", "https://example.com/post"], {
      fetchImpl: async () =>
        new Response(
          `<!doctype html><html><head><title>Example Post</title><meta name="author" content="A. Writer"></head><body><main><h1>Example Post</h1><p>Hello world.</p></main></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        ),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      url: "https://example.com/post",
      title: "Example Post",
      markdown: "# Example Post\n\nHello world.",
      author: "A. Writer",
      diagnostics: {
        status: 200,
        contentType: "text/html; charset=utf-8",
      },
    });
  });

  test("fails clearly on unsupported content types", async () => {
    const result = await executeCliCommand(["web-fetch", "fetch", "https://example.com/file.pdf"], {
      fetchImpl: async () =>
        new Response("%PDF", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unsupported content type");
  });
});
