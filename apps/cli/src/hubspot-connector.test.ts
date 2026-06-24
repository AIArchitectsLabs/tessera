import { describe, expect, test } from "bun:test";

import {
  HubSpotConnectorError,
  hubspotMutateObject,
  hubspotSearchObjects,
  hubspotSummary,
} from "./hubspot-connector.js";

describe("HubSpot connector", () => {
  test("retries HubSpot search once after a secondly rate limit", async () => {
    const calls: string[] = [];

    const result = await hubspotSearchObjects("contacts", "recent", 5, {
      accessToken: "pat-test",
      retryDelayMs: 0,
      fetchImpl: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({
              status: "error",
              message: "You have reached your secondly limit.",
              errorType: "RATE_LIMIT",
              policyName: "SECONDLY",
            }),
            { status: 429, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "101",
                properties: { firstname: "Alex", email: "alex@example.com" },
                archived: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      objectType: "contacts",
      results: [{ id: "101", properties: { email: "alex@example.com" } }],
    });
  });

  test("counts HubSpot object totals sequentially to avoid bursting search limits", async () => {
    const calls: string[] = [];

    const result = await hubspotSummary({
      accessToken: "pat-test",
      retryDelayMs: 0,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ total: calls.length, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(calls).toEqual([
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      "https://api.hubapi.com/crm/v3/objects/companies/search",
      "https://api.hubapi.com/crm/v3/objects/deals/search",
    ]);
    expect(result.counts).toEqual({ contacts: 1, companies: 2, deals: 3 });
  });

  test("throws a validation error before making any request when update is called without an id", async () => {
    let fetchCalled = false;
    const opts = {
      accessToken: "pat-test",
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    };

    await expect(
      hubspotMutateObject("contacts", "update", { firstname: "Alex" }, opts)
    ).rejects.toThrow(HubSpotConnectorError);

    await expect(
      hubspotMutateObject("contacts", "update", { firstname: "Alex" }, opts)
    ).rejects.toThrow("id is required for update");

    expect(fetchCalled).toBe(false);
  });
});
