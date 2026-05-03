import type { IntegrationProvider } from "@tessera/contracts";

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = ["brave-search"];

export function integrationLabel(provider: IntegrationProvider): string {
  switch (provider) {
    case "brave-search":
      return "Brave Search";
  }
}

export function shouldSendIntegrationCredential(value: string): boolean {
  return value.trim().length > 0;
}
