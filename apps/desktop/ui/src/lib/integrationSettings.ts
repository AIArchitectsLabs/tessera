import type { IntegrationProvider, SearchMode, SearchProvider } from "@tessera/contracts";

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = ["google-calendar"];
export const SEARCH_PROVIDERS: SearchProvider[] = ["brave-search", "tavily", "duckduckgo"];
export const SEARCH_MODE_OPTIONS: SearchMode[] = ["auto", ...SEARCH_PROVIDERS];
export const KEYLESS_SEARCH_PROVIDERS: SearchProvider[] = ["duckduckgo"];

export function integrationLabel(provider: IntegrationProvider): string {
  switch (provider) {
    case "google-calendar":
      return "Google Calendar";
    case "brave-search":
      return "Brave Search";
  }
}

export function searchProviderLabel(provider: SearchProvider): string {
  switch (provider) {
    case "brave-search":
      return "Brave Search";
    case "tavily":
      return "Tavily";
    case "duckduckgo":
      return "DuckDuckGo";
  }
}

export function searchModeLabel(mode: SearchMode): string {
  return mode === "auto" ? "Auto" : searchProviderLabel(mode);
}

export function searchProviderSupportsCredential(provider: SearchProvider): boolean {
  return !KEYLESS_SEARCH_PROVIDERS.includes(provider);
}

export function shouldSendIntegrationCredential(value: string): boolean {
  return value.trim().length > 0;
}
