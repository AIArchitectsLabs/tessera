/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { IntegrationProvider } from "@tessera/contracts";
import {
  INTEGRATION_PROVIDERS,
  KEYLESS_INTEGRATION_PROVIDERS,
  KEYLESS_SEARCH_PROVIDERS,
  SEARCH_MODE_OPTIONS,
  SEARCH_PROVIDERS,
  integrationLabel,
  integrationProviderSupportsCredential,
  searchModeLabel,
  searchProviderLabel,
  searchProviderSupportsCredential,
  shouldSendIntegrationCredential,
} from "./integrationSettings";

describe("integration settings UI helpers", () => {
  test("labels supported integration providers", () => {
    expect(integrationLabel("google-workspace")).toBe("Google Workspace");
  });

  test("labels supported search providers and modes", () => {
    expect(searchProviderLabel("brave-search")).toBe("Brave Search");
    expect(searchProviderLabel("tavily")).toBe("Tavily");
    expect(searchProviderLabel("duckduckgo")).toBe("DuckDuckGo");
    expect(searchModeLabel("auto")).toBe("Auto");
    expect(searchModeLabel("tavily")).toBe("Tavily");
  });

  test("omits blank credential replacements", () => {
    expect(shouldSendIntegrationCredential("")).toBe(false);
    expect(shouldSendIntegrationCredential("   ")).toBe(false);
    expect(shouldSendIntegrationCredential("brave-test")).toBe(true);
  });

  test("exports every supported integration provider", () => {
    const expected: IntegrationProvider[] = ["google-workspace"];
    expect(INTEGRATION_PROVIDERS).toEqual(expected);
  });

  test("exports every supported search provider and mode option", () => {
    expect(SEARCH_PROVIDERS).toEqual(["brave-search", "tavily", "duckduckgo"]);
    expect(SEARCH_MODE_OPTIONS).toEqual(["auto", "brave-search", "tavily", "duckduckgo"]);
  });

  test("marks DuckDuckGo as keyless", () => {
    expect(KEYLESS_SEARCH_PROVIDERS).toEqual(["duckduckgo"]);
    expect(searchProviderSupportsCredential("brave-search")).toBe(true);
    expect(searchProviderSupportsCredential("duckduckgo")).toBe(false);
  });

  test("marks Google Workspace as CLI-connected", () => {
    expect(KEYLESS_INTEGRATION_PROVIDERS).toEqual(["google-workspace"]);
    expect(integrationProviderSupportsCredential("google-workspace")).toBe(false);
  });
});
