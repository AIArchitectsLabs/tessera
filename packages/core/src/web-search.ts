import type {
  IntegrationSettingsRead,
  SearchProvider,
  WebSearchResult,
} from "@tessera/contracts";
import { WebSearchResultSchema } from "@tessera/contracts";
import { z } from "zod";

const SEARCH_PROVIDER_ORDER: SearchProvider[] = ["brave-search", "tavily", "duckduckgo"];
const SEARCH_CAPABILITY = "search" as const;

const WebSearchResultItemSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  snippet: z.string().optional(),
  source: z.string().optional(),
});

const WebSearchAdapterResponseSchema = z.object({
  results: z.array(WebSearchResultItemSchema),
});

type WebSearchAdapterResponse = z.infer<typeof WebSearchAdapterResponseSchema>;

export interface WebSearchAdapterRequest {
  query: string;
  provider: SearchProvider;
  capability: typeof SEARCH_CAPABILITY;
  credential?: string;
  fetchImpl: typeof fetch;
}

export interface WebSearchAdapter {
  search(request: WebSearchAdapterRequest): Promise<WebSearchAdapterResponse>;
}

export interface WebSearchCacheEntry {
  expiresAt: number;
  result: WebSearchResult;
}

export type WebSearchCache = Map<string, WebSearchCacheEntry>;

export interface WebSearchRuntime {
  adapters?: Partial<Record<SearchProvider, WebSearchAdapter>>;
  cache?: WebSearchCache;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  getCredential?: (provider: SearchProvider) => string | undefined | Promise<string | undefined>;
  now?: () => number;
}

export interface ExecuteWebSearchOptions {
  query: string;
  settings: IntegrationSettingsRead["search"];
}

interface SearchProviderMetadata {
  credentialed: boolean;
  settingsKey: keyof IntegrationSettingsRead["search"]["providers"];
}

const SEARCH_PROVIDER_METADATA: Record<SearchProvider, SearchProviderMetadata> = {
  "brave-search": {
    credentialed: true,
    settingsKey: "braveSearch",
  },
  tavily: {
    credentialed: true,
    settingsKey: "tavily",
  },
  duckduckgo: {
    credentialed: false,
    settingsKey: "duckduckgo",
  },
};

function normalizeQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    throw new Error("Web search query must not be empty.");
  }
  return normalized;
}

function cacheKey(provider: SearchProvider, query: string): string {
  return `${provider}:${SEARCH_CAPABILITY}:${query}`;
}

function isProviderConfigured(
  settings: IntegrationSettingsRead["search"],
  provider: SearchProvider
): boolean {
  const metadata = SEARCH_PROVIDER_METADATA[provider];
  return settings.providers[metadata.settingsKey].hasCredential;
}

function resolveProvider(settings: IntegrationSettingsRead["search"]): SearchProvider {
  if (settings.mode !== "auto") {
    if (!SEARCH_PROVIDER_METADATA[settings.mode].credentialed) {
      return settings.mode;
    }
    if (isProviderConfigured(settings, settings.mode)) {
      return settings.mode;
    }
    throw new Error(`${settings.mode} is not configured.`);
  }

  for (const provider of SEARCH_PROVIDER_ORDER) {
    if (provider === "duckduckgo") {
      break;
    }
    if (isProviderConfigured(settings, provider)) {
      return provider;
    }
  }

  if (settings.allowKeylessFallback) {
    return "duckduckgo";
  }

  throw new Error("No search provider is configured.");
}

function resolveAdapter(provider: SearchProvider, runtime: WebSearchRuntime): WebSearchAdapter {
  const adapter = runtime.adapters?.[provider];
  if (!adapter) {
    throw new Error(`${provider} search adapter is not registered.`);
  }
  return adapter;
}

function buildWebSearchResult(
  query: string,
  provider: SearchProvider,
  cached: boolean,
  latencyMs: number,
  response: WebSearchAdapterResponse
): WebSearchResult {
  return WebSearchResultSchema.parse({
    query,
    provider,
    capability: SEARCH_CAPABILITY,
    cached,
    latencyMs,
    results: response.results.map((result, index) => ({
      ...result,
      position: index + 1,
    })),
  });
}

function getNow(runtime: WebSearchRuntime): number {
  return runtime.now?.() ?? Date.now();
}

function getCache(runtime: WebSearchRuntime): WebSearchCache {
  return runtime.cache ?? new Map<string, WebSearchCacheEntry>();
}

async function resolveCredential(
  provider: SearchProvider,
  settings: IntegrationSettingsRead["search"],
  runtime: WebSearchRuntime
): Promise<string | undefined> {
  if (!SEARCH_PROVIDER_METADATA[provider].credentialed) {
    return undefined;
  }
  if (!isProviderConfigured(settings, provider)) {
    throw new Error(`${provider} is not configured.`);
  }
  const credential = await runtime.getCredential?.(provider);
  if (!credential) {
    throw new Error(`${provider} credential is missing.`);
  }
  return credential;
}

export async function executeWebSearch(
  options: ExecuteWebSearchOptions,
  runtime: WebSearchRuntime = {}
): Promise<WebSearchResult> {
  const rawQuery = options.query;
  const query = normalizeQuery(rawQuery);
  const provider = resolveProvider(options.settings);
  const key = cacheKey(provider, rawQuery);
  const cache = getCache(runtime);
  const cachedEntry = cache.get(key);
  const now = getNow(runtime);

  if (cachedEntry && cachedEntry.expiresAt > now) {
    return buildWebSearchResult(query, provider, true, 0, {
      results: cachedEntry.result.results,
    });
  }

  const adapter = resolveAdapter(provider, runtime);
  const credential = await resolveCredential(provider, options.settings, runtime);
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const startedAt = now;
  const request: WebSearchAdapterRequest = {
    query,
    provider,
    capability: SEARCH_CAPABILITY,
    fetchImpl,
  };
  if (credential !== undefined) {
    request.credential = credential;
  }
  const response = WebSearchAdapterResponseSchema.parse(await adapter.search(request));
  const finishedAt = getNow(runtime);
  const result = buildWebSearchResult(query, provider, false, finishedAt - startedAt, response);

  cache.set(key, {
    expiresAt: startedAt + (runtime.cacheTtlMs ?? 30_000),
    result,
  });

  return result;
}
