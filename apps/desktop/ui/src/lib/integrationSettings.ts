import type { IntegrationProvider } from "@tessera/contracts";

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = ["brave-search", "google-calendar"];

export function integrationLabel(provider: IntegrationProvider): string {
  switch (provider) {
    case "brave-search":
      return "Brave Search";
    case "google-calendar":
      return "Google Calendar";
  }
}

export function shouldSendIntegrationCredential(value: string): boolean {
  return value.trim().length > 0;
}
