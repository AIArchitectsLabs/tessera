import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCliCommand } from "./shell.js";
import type { ExecuteCliCommandOptions } from "./shell.js";

describe("workspace cli shell commands", () => {
  test("returns normalized web search results", async () => {
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
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      query: "tessera",
      provider: "brave-search",
      capability: "search",
      cached: false,
      results: [
        {
          title: "Tessera",
          url: "https://example.com",
          snippet: "Agent workspace",
          source: "example.com",
          position: 1,
        },
      ],
    });
    expect(payload.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("uses the configured tavily provider when brave is unavailable", async () => {
    const options: ExecuteCliCommandOptions = {
      fetchImpl: async (input: string | URL | Request) => {
        expect(input instanceof Request ? input.url : String(input)).toContain("tavily");
        return new Response(
          JSON.stringify({
            query: "tessera",
            results: [
              {
                title: "Tessera",
                url: "https://example.com/tavily",
                content: "Tavily result",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
      getBraveApiKey: async () => null,
      getTavilyApiKey: async () => "tavily-test",
      getSearchSettings: async () => ({
        mode: "tavily",
        allowKeylessFallback: false,
        providers: {
          braveSearch: { provider: "brave-search", hasCredential: false },
          tavily: { provider: "tavily", hasCredential: true },
          duckduckgo: { provider: "duckduckgo", hasCredential: false },
        },
      }),
    };

    const result = await executeCliCommand(["web-search", "search", "tessera"], options);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      query: "tessera",
      provider: "tavily",
      capability: "search",
      cached: false,
      results: [
        {
          title: "Tessera",
          url: "https://example.com/tavily",
          snippet: "Tavily result",
          source: "example.com",
          position: 1,
        },
      ],
    });
    expect(payload.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("returns a stable missing-search error when no provider is configured", async () => {
    const result = await executeCliCommand(["web-search", "search", "tessera"], {
      fetchImpl: async () => new Response("", { status: 500 }),
      getBraveApiKey: async () => null,
      getTavilyApiKey: async () => null,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("No search provider is configured.");
  });

  test("loads persisted search settings for keyless fallback when none are injected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tessera-search-settings-"));
    const previousConfigDir = process.env.TESSERA_APP_CONFIG_DIR;
    process.env.TESSERA_APP_CONFIG_DIR = dir;

    try {
      await writeFile(
        join(dir, "integration-settings.json"),
        JSON.stringify({
          providers: {
            braveSearch: { provider: "brave-search" },
            googleCalendar: { provider: "google-calendar" },
          },
          search: {
            mode: "duckduckgo",
            allowKeylessFallback: true,
          },
        })
      );

      const result = await executeCliCommand(["web-search", "search", "tessera"], {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              AbstractText: "Tessera summary",
              AbstractURL: "https://example.com/tessera",
              Heading: "Tessera",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          ),
        getBraveApiKey: async () => null,
        getTavilyApiKey: async () => null,
      });

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        query: "tessera",
        provider: "duckduckgo",
        capability: "search",
        cached: false,
      });
    } finally {
      if (previousConfigDir === undefined) {
        process.env.TESSERA_APP_CONFIG_DIR = undefined;
      } else {
        process.env.TESSERA_APP_CONFIG_DIR = previousConfigDir;
      }
    }
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

  test("returns normalized gcal list results", async () => {
    let capturedArgs: string[] = [];
    const result = await executeCliCommand(["gcal", "list", "--limit", "1"], {
      runGwsCli: async (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                id: "evt-1",
                summary: "Weekly review",
                start: { dateTime: "2026-05-04T09:00:00Z" },
                end: { dateTime: "2026-05-04T09:30:00Z" },
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs.slice(0, 3)).toEqual(["calendar", "events", "list"]);
    expect(capturedArgs).toContain("--params");
    const params = JSON.parse(capturedArgs[capturedArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toMatchObject({
      calendarId: "primary",
      maxResults: 1,
      orderBy: "startTime",
      singleEvents: true,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      calendarId: "primary",
      events: [
        {
          id: "evt-1",
          title: "Weekly review",
          start: "2026-05-04T09:00:00Z",
          end: "2026-05-04T09:30:00Z",
          isAllDay: false,
        },
      ],
    });
  });

  test("returns normalized gcal read results", async () => {
    let capturedArgs: string[] = [];
    const result = await executeCliCommand(["gcal", "read", "evt-1"], {
      runGwsCli: async (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "evt-1",
            summary: "Weekly review",
            start: { date: "2026-05-04" },
            end: { date: "2026-05-05" },
            attendees: [{ email: "owner@example.com", responseStatus: "accepted" }],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs.slice(0, 3)).toEqual(["calendar", "events", "get"]);
    const params = JSON.parse(capturedArgs[capturedArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toEqual({
      calendarId: "primary",
      eventId: "evt-1",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      calendarId: "primary",
      event: {
        id: "evt-1",
        title: "Weekly review",
        start: "2026-05-04",
        end: "2026-05-05",
        isAllDay: true,
        attendees: [{ email: "owner@example.com", responseStatus: "accepted" }],
      },
    });
  });

  test("returns a stable missing-connection error for gcal", async () => {
    const result = await executeCliCommand(["gcal", "list"], {
      runGwsCli: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "auth token expired",
      }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Settings > Integrations");
  });
});
