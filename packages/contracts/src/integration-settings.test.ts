import { describe, expect, test } from "bun:test";
import {
  BraveSearchResultSchema,
  GcalListResultSchema,
  GcalReadResultSchema,
  IntegrationConnectionTestRequestSchema,
  IntegrationCredentialDeleteRequestSchema,
  IntegrationSettingsReadSchema,
  IntegrationSettingsSaveRequestSchema,
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

    expect(parsed.provider).toBe("brave-search");
    expect(parsed.credential?.apiKey).toBe("brave-test");
  });

  test("accepts delete and test requests for brave search", () => {
    expect(
      IntegrationCredentialDeleteRequestSchema.parse({ provider: "brave-search" }).provider
    ).toBe("brave-search");
    expect(
      IntegrationConnectionTestRequestSchema.parse({
        provider: "brave-search",
        credential: { apiKey: "brave-test" },
      }).provider
    ).toBe("brave-search");
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
});
