import { describe, expect, test } from "bun:test";
import {
  BraveSearchResultSchema,
  GcalListResultSchema,
  GcalReadResultSchema,
  IntegrationConnectionTestResultSchema,
  IntegrationConnectionTestRequestSchema,
  IntegrationCredentialDeleteRequestSchema,
  IntegrationSettingsReadSchema,
  IntegrationSettingsSaveRequestSchema,
  WebSearchResultSchema,
  WebFetchResultSchema,
} from "./index.js";

describe("integration settings contracts", () => {
  test("parses redacted integration settings without secret values", () => {
    const parsed = IntegrationSettingsReadSchema.parse({
      providers: {
        braveSearch: {
          provider: "brave-search",
          hasCredential: true,
        },
        googleCalendar: {
          provider: "google-calendar",
          hasCredential: false,
        },
      },
    });

    expect(parsed.providers.braveSearch.hasCredential).toBe(true);
    expect(parsed.providers.googleCalendar.provider).toBe("google-calendar");
    expect(parsed.providers.googleCalendar.hasCredential).toBe(false);
    expect("apiKey" in parsed.providers.braveSearch).toBe(false);
  });

  test("accepts save requests with an optional replacement key", () => {
    const parsed = IntegrationSettingsSaveRequestSchema.parse({
      provider: "brave-search",
      hasExistingCredential: true,
      credential: { apiKey: "brave-test" },
    });

    expect("provider" in parsed).toBe(true);
    if (!("provider" in parsed)) {
      throw new Error("Expected provider request variant");
    }
    expect(parsed.provider).toBe("brave-search");
    expect(parsed.credential?.apiKey).toBe("brave-test");
  });

  test("accepts Tavily save requests without a top-level provider", () => {
    const parsed = IntegrationSettingsSaveRequestSchema.parse({
      searchProvider: "tavily",
      hasExistingCredential: false,
      credential: { apiKey: "tavily-test" },
      search: {
        mode: "tavily",
        allowKeylessFallback: true,
      },
    });

    expect("searchProvider" in parsed).toBe(true);
    if (!("searchProvider" in parsed)) {
      throw new Error("Expected search provider request variant");
    }
    expect(parsed.searchProvider).toBe("tavily");
    expect(parsed.search?.mode).toBe("tavily");
    expect(parsed.search?.allowKeylessFallback).toBe(true);
  });

  test("rejects mixed provider combinations", () => {
    expect(() =>
      IntegrationSettingsSaveRequestSchema.parse({
        provider: "google-calendar",
        searchProvider: "tavily",
        hasExistingCredential: false,
      })
    ).toThrow();
    expect(() =>
      IntegrationCredentialDeleteRequestSchema.parse({
        provider: "google-calendar",
        searchProvider: "tavily",
      })
    ).toThrow();
    expect(() =>
      IntegrationConnectionTestRequestSchema.parse({
        provider: "google-calendar",
        searchProvider: "tavily",
        credential: { apiKey: "test" },
      })
    ).toThrow();
  });

  test("accepts delete and test requests for search providers", () => {
    const deleteRequest = IntegrationCredentialDeleteRequestSchema.parse({
      searchProvider: "tavily",
    });
    expect("searchProvider" in deleteRequest).toBe(true);
    if (!("searchProvider" in deleteRequest)) {
      throw new Error("Expected search provider delete variant");
    }
    expect(deleteRequest.searchProvider).toBe("tavily");

    const testRequest = IntegrationConnectionTestRequestSchema.parse({
      searchProvider: "tavily",
      credential: { apiKey: "brave-test" },
    });
    expect("searchProvider" in testRequest).toBe(true);
    if (!("searchProvider" in testRequest)) {
      throw new Error("Expected search provider test variant");
    }
    expect(testRequest.searchProvider).toBe("tavily");
  });

  test("parses connection test results with search-provider provenance", () => {
    const parsed = IntegrationConnectionTestResultSchema.parse({
      ok: true,
      message: "Connection test succeeded",
      searchProvider: "tavily",
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.searchProvider).toBe("tavily");
  });

  test("parses normalized gcal list payloads", () => {
    const parsed = GcalListResultSchema.parse({
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

    expect(parsed.events[0]?.title).toBe("Weekly review");
  });

  test("parses normalized gcal read payloads", () => {
    const parsed = GcalReadResultSchema.parse({
      calendarId: "primary",
      event: {
        id: "evt-1",
        title: "Weekly review",
        start: "2026-05-04",
        isAllDay: true,
      },
    });

    expect(parsed.event.isAllDay).toBe(true);
  });
});

describe("shell parsed payload contracts", () => {
  test("parses brave search payloads", () => {
    const parsed = BraveSearchResultSchema.parse({
      query: "tessera agent workspace",
      results: [
        {
          title: "Tessera",
          url: "https://example.com",
          snippet: "Agent workspace for business users.",
          source: "example.com",
        },
      ],
    });

    expect(parsed.results[0]?.source).toBe("example.com");
  });

  test("parses fetched page payloads with diagnostics", () => {
    const parsed = WebFetchResultSchema.parse({
      url: "https://example.com/article",
      title: "Example Article",
      markdown: "# Example Article\n\nHello world.",
      author: "Author Name",
      publishedAt: "2026-05-03",
      diagnostics: {
        status: 200,
        contentType: "text/html; charset=utf-8",
      },
    });

    expect(parsed.diagnostics.status).toBe(200);
    expect(parsed.markdown).toContain("Hello world");
  });

  test("parses web search payloads with provider metadata", () => {
    const parsed = WebSearchResultSchema.parse({
      query: "tessera agent workspace",
      provider: "brave-search",
      capability: "search",
      cached: false,
      latencyMs: 123,
      results: [
        {
          title: "Tessera",
          url: "https://example.com",
          snippet: "Agent workspace for business users.",
          source: "example.com",
          position: 1,
        },
      ],
    });

    expect(parsed.provider).toBe("brave-search");
    expect(parsed.results[0]?.position).toBe(1);
  });
});

describe("integration search settings contracts", () => {
  test("parses search settings with provider credential state", () => {
    const parsed = IntegrationSettingsReadSchema.parse({
      providers: {
        braveSearch: {
          provider: "brave-search",
          hasCredential: true,
        },
        googleCalendar: {
          provider: "google-calendar",
          hasCredential: false,
        },
      },
      search: {
        mode: "auto",
        allowKeylessFallback: true,
        providers: {
          braveSearch: {
            provider: "brave-search",
            hasCredential: true,
          },
          tavily: {
            provider: "tavily",
            hasCredential: false,
          },
          duckduckgo: {
            provider: "duckduckgo",
            hasCredential: false,
          },
        },
      },
    });

    expect(parsed.search.mode).toBe("auto");
    expect(parsed.search.allowKeylessFallback).toBe(true);
    expect(parsed.search.providers.duckduckgo.provider).toBe("duckduckgo");
  });

  test("fills default search settings when omitted", () => {
    const parsed = IntegrationSettingsReadSchema.parse({
      providers: {
        braveSearch: {
          provider: "brave-search",
          hasCredential: false,
        },
        googleCalendar: {
          provider: "google-calendar",
          hasCredential: false,
        },
      },
    });

    expect(parsed.search.mode).toBe("auto");
    expect(parsed.search.allowKeylessFallback).toBe(false);
    expect(parsed.search.providers.tavily.hasCredential).toBe(false);
  });
});
