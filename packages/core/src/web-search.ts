import {
  type SearchProvider,
  type WebSearchResult,
  WebSearchResultSchema,
} from "@tessera/contracts";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE = new Map<string, CachedSearchResult>();
const SEARCH_PROVIDER_ORDER: SearchProvider[] = ["brave-search", "tavily", "duckduckgo"];

type SearchProviderResult = {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
};

type CachedSearchResult = {
  expiresAt: number;
  value: WebSearchResult;
};

type SearchProviderSettings = {
  provider: SearchProvider;
  hasCredential: boolean;
};

type SearchProviderSettingsRecord = {
  braveSearch: SearchProviderSettings & { provider: "brave-search" };
  tavily: SearchProviderSettings & { provider: "tavily" };
  duckduckgo: SearchProviderSettings & { provider: "duckduckgo" };
};

type SearchAdapterResponse = {
  results: SearchProviderResult[];
};

type MaybePromise<T> = T | Promise<T>;

export interface ExecuteWebSearchOptions {
  query: string;
  settings: {
    mode: "auto" | SearchProvider;
    allowKeylessFallback: boolean;
    providers: SearchProviderSettingsRecord;
  };
}

export interface WebSearchRuntime {
  adapters: Record<
    SearchProvider,
    {
      search(request: { query: string; credential?: string }): MaybePromise<SearchAdapterResponse>;
    }
  >;
  cache?: Map<string, unknown>;
  cacheTtlMs?: number;
  getCredential(provider: SearchProvider): MaybePromise<string | undefined>;
  now(): number;
}

export async function executeWebSearch(
  options: ExecuteWebSearchOptions,
  runtime: WebSearchRuntime
): Promise<WebSearchResult> {
  const query = normalizeQuery(options.query);
  if (!query) {
    throw new Error("Search query is required.");
  }

  const target = await resolveSearchTarget(options, runtime);
  const cache: Map<string, unknown> = runtime.cache ?? DEFAULT_CACHE;
  const cacheKey = `${target.provider}::search::${query}`;
  const cached = asCachedSearchResult(cache.get(cacheKey));
  const now = runtime.now();
  if (cached && cached.expiresAt > now) {
    return WebSearchResultSchema.parse({
      ...cached.value,
      cached: true,
    });
  }

  const startedAt = now;
  const adapter = runtime.adapters[target.provider];
  const payload = await adapter.search(
    target.credential ? { query, credential: target.credential } : { query }
  );
  const result = WebSearchResultSchema.parse({
    query,
    provider: target.provider,
    capability: "search",
    cached: false,
    latencyMs: Math.max(0, runtime.now() - startedAt),
    results: payload.results.map((item, index) => ({
      ...item,
      position: index + 1,
    })),
  });

  cache.set(cacheKey, {
    expiresAt: runtime.now() + (runtime.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
    value: result,
  });
  return result;
}

async function resolveSearchTarget(
  options: ExecuteWebSearchOptions,
  runtime: WebSearchRuntime
): Promise<{ provider: SearchProvider; credential?: string }> {
  if (options.settings.mode !== "auto") {
    return resolveConfiguredProvider(options.settings.mode, options, runtime);
  }

  for (const provider of SEARCH_PROVIDER_ORDER) {
    const resolved = await resolveEligibleProvider(provider, options, runtime);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("No search provider is configured.");
}

async function resolveConfiguredProvider(
  provider: SearchProvider,
  options: ExecuteWebSearchOptions,
  runtime: WebSearchRuntime
): Promise<{ provider: SearchProvider; credential?: string }> {
  const resolved = await resolveEligibleProvider(provider, options, runtime);
  if (!resolved) {
    throw new Error("No search provider is configured.");
  }
  return resolved;
}

async function resolveEligibleProvider(
  provider: SearchProvider,
  options: ExecuteWebSearchOptions,
  runtime: WebSearchRuntime
): Promise<{ provider: SearchProvider; credential?: string } | undefined> {
  const configured = getProviderSettings(options.settings.providers, provider);

  if (provider === "duckduckgo") {
    if (!options.settings.allowKeylessFallback) {
      return undefined;
    }
    return { provider };
  }

  if (!configured.hasCredential) {
    return undefined;
  }

  const credential = await runtime.getCredential(provider);
  if (!credential) {
    return undefined;
  }

  return { provider, credential };
}

function getProviderSettings(
  providers: SearchProviderSettingsRecord,
  provider: SearchProvider
): SearchProviderSettings {
  if (provider === "brave-search") return providers.braveSearch;
  if (provider === "tavily") return providers.tavily;
  return providers.duckduckgo;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function asCachedSearchResult(value: unknown): CachedSearchResult | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<CachedSearchResult>;
  if (typeof candidate.expiresAt !== "number" || !candidate.value) {
    return undefined;
  }

  return candidate as CachedSearchResult;
}
