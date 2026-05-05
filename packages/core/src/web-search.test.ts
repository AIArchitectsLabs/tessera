import { describe, expect, test } from "bun:test";
import { WebSearchResultSchema } from "@tessera/contracts";
import type { WebSearchCacheEntry, WebSearchRuntime } from "./web-search.js";
import { executeWebSearch } from "./web-search.js";

type SearchAdapterCall = {
  provider: "brave-search" | "tavily" | "duckduckgo";
  query: string;
  credential: string | undefined;
};

type TestRuntime = {
  calls: SearchAdapterCall[];
  adapters: NonNullable<WebSearchRuntime["adapters"]>;
  cache: Map<string, WebSearchCacheEntry>;
  now: () => number;
  getCredential: NonNullable<WebSearchRuntime["getCredential"]>;
};

function makeRuntime(): TestRuntime {
  const calls: SearchAdapterCall[] = [];
  const adapters: TestRuntime["adapters"] = {
    "brave-search": {
      async search(request: { query: string; credential?: string }) {
        calls.push({
          provider: "brave-search",
          query: request.query,
          credential: request.credential,
        });
        return {
          results: [
            {
              title: "Brave result",
              url: "https://example.com/brave",
              snippet: "brave snippet",
              source: "brave",
            },
          ],
        };
      },
    },
    tavily: {
      async search(request: { query: string; credential?: string }) {
        calls.push({ provider: "tavily", query: request.query, credential: request.credential });
        return {
          results: [
            {
              title: "Tavily result",
              url: "https://example.com/tavily",
              snippet: "tavily snippet",
              source: "tavily",
            },
          ],
        };
      },
    },
    duckduckgo: {
      async search(request: { query: string; credential?: string }) {
        calls.push({
          provider: "duckduckgo",
          query: request.query,
          credential: request.credential,
        });
        return {
          results: [
            {
              title: "DuckDuckGo result",
              url: "https://example.com/duckduckgo",
              snippet: "duckduckgo snippet",
              source: "duckduckgo",
            },
          ],
        };
      },
    },
  };

  return {
    calls,
    adapters,
    cache: new Map<string, WebSearchCacheEntry>(),
    now: () => 1_000,
    getCredential: (provider: "brave-search" | "tavily" | "duckduckgo") => {
      if (provider === "brave-search") return "brave-key";
      if (provider === "tavily") return "tavily-key";
      return undefined;
    },
  };
}

describe("executeWebSearch", () => {
  test("uses the preferred configured provider", async () => {
    const runtime = makeRuntime();

    const result = await executeWebSearch(
      {
        query: "  tessera   agent workspace  ",
        settings: {
          mode: "auto",
          allowKeylessFallback: false,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: true },
            tavily: { provider: "tavily", hasCredential: true },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      runtime
    );

    expect(runtime.calls).toEqual([
      { provider: "brave-search", query: "tessera agent workspace", credential: "brave-key" },
    ]);
    expect(result.provider).toBe("brave-search");
    expect(result.capability).toBe("search");
    expect(result.cached).toBe(false);
    expect(result.query).toBe("tessera agent workspace");
    expect(result.results[0]?.position).toBe(1);
    expect(WebSearchResultSchema.parse(result).results[0]?.source).toBe("brave");
  });

  test("uses keyless fallback only when explicitly enabled", async () => {
    const runtime = makeRuntime();

    await expect(
      executeWebSearch(
        {
          query: "tessera",
          settings: {
            mode: "auto",
            allowKeylessFallback: false,
            providers: {
              braveSearch: { provider: "brave-search", hasCredential: false },
              tavily: { provider: "tavily", hasCredential: false },
              duckduckgo: { provider: "duckduckgo", hasCredential: false },
            },
          },
        },
        runtime
      )
    ).rejects.toThrow("No search provider is configured.");

    expect(runtime.calls).toEqual([]);

    const fallbackResult = await executeWebSearch(
      {
        query: "tessera",
        settings: {
          mode: "auto",
          allowKeylessFallback: true,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: false },
            tavily: { provider: "tavily", hasCredential: false },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      runtime
    );

    expect(runtime.calls).toEqual([
      { provider: "duckduckgo", query: "tessera", credential: undefined },
    ]);
    expect(fallbackResult.provider).toBe("duckduckgo");
  });

  test("does not silently fail over when an explicit provider fails", async () => {
    const runtime = makeRuntime();
    const braveAdapter = runtime.adapters["brave-search"];
    if (!braveAdapter) {
      throw new Error("brave-search adapter is missing.");
    }
    braveAdapter.search = async () => {
      runtime.calls.push({ provider: "brave-search", query: "tessera", credential: "brave-key" });
      throw new Error("brave failed");
    };

    await expect(
      executeWebSearch(
        {
          query: "tessera",
          settings: {
            mode: "brave-search",
            allowKeylessFallback: true,
            providers: {
              braveSearch: { provider: "brave-search", hasCredential: true },
              tavily: { provider: "tavily", hasCredential: true },
              duckduckgo: { provider: "duckduckgo", hasCredential: false },
            },
          },
        },
        runtime
      )
    ).rejects.toThrow("brave failed");

    expect(runtime.calls).toEqual([
      { provider: "brave-search", query: "tessera", credential: "brave-key" },
    ]);
  });

  test("reuses cached results for the exact same query string within the ttl", async () => {
    const runtime = makeRuntime();
    const resultA = await executeWebSearch(
      {
        query: "tessera search",
        settings: {
          mode: "auto",
          allowKeylessFallback: false,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: true },
            tavily: { provider: "tavily", hasCredential: true },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      {
        ...runtime,
        cacheTtlMs: 10_000,
        now: () => 1_000,
      }
    );

    const resultB = await executeWebSearch(
      {
        query: "tessera search",
        settings: {
          mode: "auto",
          allowKeylessFallback: false,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: true },
            tavily: { provider: "tavily", hasCredential: true },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      {
        ...runtime,
        cacheTtlMs: 10_000,
        now: () => 5_000,
      }
    );

    expect(runtime.calls).toHaveLength(1);
    expect(resultA.cached).toBe(false);
    expect(resultB.cached).toBe(true);
    expect(resultB.provider).toBe(resultA.provider);
    expect(resultB.results).toEqual(resultA.results);
  });

  test("does not share a cache entry across whitespace variants", async () => {
    const runtime = makeRuntime();

    const resultA = await executeWebSearch(
      {
        query: "tessera search",
        settings: {
          mode: "auto",
          allowKeylessFallback: false,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: true },
            tavily: { provider: "tavily", hasCredential: true },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      {
        ...runtime,
        cacheTtlMs: 10_000,
        now: () => 1_000,
      }
    );

    const resultB = await executeWebSearch(
      {
        query: "tessera   search",
        settings: {
          mode: "auto",
          allowKeylessFallback: false,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: true },
            tavily: { provider: "tavily", hasCredential: true },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      {
        ...runtime,
        cacheTtlMs: 10_000,
        now: () => 2_000,
      }
    );

    expect(runtime.calls).toHaveLength(2);
    expect(resultA.cached).toBe(false);
    expect(resultB.cached).toBe(false);
    expect(resultB.query).toBe("tessera search");
  });

  test("does not retain cache state across calls when no cache is provided", async () => {
    const runtime = makeRuntime();
    const runtimeWithoutCache = {
      adapters: runtime.adapters,
      now: () => 1_000,
      getCredential: runtime.getCredential,
    };

    const resultA = await executeWebSearch(
      {
        query: "tessera search",
        settings: {
          mode: "auto",
          allowKeylessFallback: false,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: true },
            tavily: { provider: "tavily", hasCredential: true },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      runtimeWithoutCache
    );

    const resultB = await executeWebSearch(
      {
        query: "tessera search",
        settings: {
          mode: "auto",
          allowKeylessFallback: false,
          providers: {
            braveSearch: { provider: "brave-search", hasCredential: true },
            tavily: { provider: "tavily", hasCredential: true },
            duckduckgo: { provider: "duckduckgo", hasCredential: false },
          },
        },
      },
      {
        ...runtimeWithoutCache,
        now: () => 2_000,
      }
    );

    expect(runtime.calls).toHaveLength(2);
    expect(resultA.cached).toBe(false);
    expect(resultB.cached).toBe(false);
  });
});
