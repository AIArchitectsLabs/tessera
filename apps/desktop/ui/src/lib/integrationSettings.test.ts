/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { IntegrationProvider } from "@tessera/contracts";
import {
  INTEGRATION_PROVIDERS,
  integrationLabel,
  shouldSendIntegrationCredential,
} from "./integrationSettings";

describe("integration settings UI helpers", () => {
  test("labels supported integration providers", () => {
    expect(integrationLabel("brave-search")).toBe("Brave Search");
    expect(integrationLabel("google-calendar")).toBe("Google Calendar");
  });

  test("omits blank credential replacements", () => {
    expect(shouldSendIntegrationCredential("")).toBe(false);
    expect(shouldSendIntegrationCredential("   ")).toBe(false);
    expect(shouldSendIntegrationCredential("brave-test")).toBe(true);
  });

  test("exports every supported integration provider", () => {
    const expected: IntegrationProvider[] = ["brave-search", "google-calendar"];
    expect(INTEGRATION_PROVIDERS).toEqual(expected);
  });
});
