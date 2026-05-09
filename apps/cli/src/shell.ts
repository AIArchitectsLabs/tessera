import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import {
  type IntegrationSettingsRead,
  IntegrationSettingsReadSchema,
  type SearchProvider,
  SearchSettingsSchema,
} from "@tessera/contracts";
import { type WebSearchRuntime, executeWebSearch } from "@tessera/core";
import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  type CommandResult,
  type GoogleWorkspaceConnector,
  GoogleWorkspaceConnectorError,
  createGwsGoogleWorkspaceConnector,
  runGwsCli,
} from "./google-connector.js";

const KEYCHAIN_SERVICE = "Tessera";
const BRAVE_SEARCH_ACCOUNT = "integration.brave-search";
const TAVILY_SEARCH_ACCOUNT = "integration.tavily";
const INTEGRATION_SETTINGS_FILE = "integration-settings.json";
const MAX_FETCH_BYTES = 1_000_000;
const BROWSER_HEADERS = {
  "user-agent": "Tessera/0.1.0 (+https://tessera.app)",
};

export interface CliCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CliCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2
  ) {
    super(message);
    this.name = "CliCommandError";
  }
}

export interface ExecuteCliCommandOptions {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  getBraveApiKey?: () => Promise<string | null>;
  getTavilyApiKey?: () => Promise<string | null>;
  getSearchSettings?: () => Promise<IntegrationSettingsRead["search"]>;
  googleWorkspaceConnector?: GoogleWorkspaceConnector;
  runGwsCli?: (args: string[]) => Promise<CommandResult>;
}

export async function executeCliCommand(
  argv: string[],
  options: ExecuteCliCommandOptions = {}
): Promise<CliCommandResult> {
  try {
    const [command, subcommand, ...args] = argv;
    if (command === "web-search" && subcommand === "search") {
      const payload = await runWebSearch(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "web-fetch" && subcommand === "fetch") {
      const payload = await runWebFetch(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "gcal" && subcommand === "list") {
      const payload = await runGcalList(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "gcal" && subcommand === "read") {
      const payload = await runGcalRead(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "mail" && subcommand === "list") {
      const payload = await runMailList(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "mail" && subcommand === "search") {
      const payload = await runMailSearch(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "mail" && subcommand === "read") {
      const payload = await runMailRead(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "drive" && subcommand === "search") {
      const payload = await runDriveSearch(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "drive" && subcommand === "read") {
      const payload = await runDriveRead(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "contacts" && subcommand === "lookup") {
      const payload = await runContactsLookup(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    throw new CliCommandError(
      `Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode =
      error instanceof CliCommandError
        ? error.exitCode
        : error instanceof GoogleWorkspaceConnectorError
          ? error.exitCode
          : 1;
    return { exitCode, stdout: "", stderr: `${message}\n` };
  }
}

async function runWebSearch(args: string[], options: ExecuteCliCommandOptions) {
  const query = args.join(" ").trim();
  if (!query) {
    throw new CliCommandError("Usage: web-search search <query>");
  }

  try {
    const searchContext = await resolveSearchContext(options);
    return await executeWebSearch(
      {
        query,
        settings: searchContext.settings,
      },
      createWebSearchRuntime(searchContext)
    );
  } catch (error) {
    throw error instanceof CliCommandError
      ? error
      : new CliCommandError(error instanceof Error ? error.message : String(error));
  }
}

type SearchCredentialState = {
  braveSearch?: string;
  tavily?: string;
};

type SearchContext = {
  settings: IntegrationSettingsRead["search"];
  credentials: SearchCredentialState;
  fetchImpl: typeof fetch;
};

function createWebSearchRuntime(context: SearchContext): WebSearchRuntime {
  return {
    cache: new Map(),
    adapters: {
      "brave-search": {
        search: async (request) => searchBraveResults(request),
      },
      tavily: {
        search: async (request) => searchTavilyResults(request),
      },
      duckduckgo: {
        search: async (request) => searchDuckDuckGoResults(request),
      },
    },
    fetchImpl: context.fetchImpl,
    getCredential: (provider) => {
      if (provider === "brave-search") {
        return context.credentials.braveSearch;
      }
      if (provider === "tavily") {
        return context.credentials.tavily;
      }
      return undefined;
    },
  };
}

async function resolveSearchContext(options: ExecuteCliCommandOptions): Promise<SearchContext> {
  const settings =
    (await options.getSearchSettings?.()) ??
    (await loadSearchSettingsFromSystem().catch(() => null)) ??
    getDefaultSearchSettings();
  const [braveSearch, tavily] = await Promise.all([
    resolveSearchCredential("brave-search", options),
    resolveSearchCredential("tavily", options),
  ]);
  const credentials: SearchCredentialState = {};
  if (braveSearch) {
    credentials.braveSearch = braveSearch;
  }
  if (tavily) {
    credentials.tavily = tavily;
  }

  return {
    settings: {
      ...settings,
      providers: {
        ...settings.providers,
        braveSearch: {
          ...settings.providers.braveSearch,
          hasCredential: Boolean(braveSearch),
        },
        tavily: {
          ...settings.providers.tavily,
          hasCredential: Boolean(tavily),
        },
      },
    },
    credentials,
    fetchImpl: (options.fetchImpl ?? fetch) as typeof fetch,
  };
}

async function loadSearchSettingsFromSystem(): Promise<IntegrationSettingsRead["search"] | null> {
  const appConfigDir = process.env.TESSERA_APP_CONFIG_DIR?.trim();
  if (!appConfigDir) {
    return null;
  }

  const path = join(appConfigDir, INTEGRATION_SETTINGS_FILE);
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as { search?: unknown };
  if (!parsed.search) {
    return null;
  }

  const persisted = SearchSettingsSchema.parse(parsed.search);
  return {
    ...getDefaultSearchSettings(),
    mode: persisted.mode,
    allowKeylessFallback: persisted.allowKeylessFallback,
  };
}

function getDefaultSearchSettings(): IntegrationSettingsRead["search"] {
  return IntegrationSettingsReadSchema.parse({
    providers: {
      braveSearch: {
        provider: "brave-search",
        hasCredential: false,
      },
      googleCalendar: {
        provider: "google-calendar",
        hasCredential: false,
      },
    },
  }).search;
}

async function resolveSearchCredential(
  provider: SearchProvider,
  options: ExecuteCliCommandOptions
): Promise<string | undefined> {
  if (provider === "brave-search") {
    if (options.getBraveApiKey) {
      return normalizeCredentialValue(await options.getBraveApiKey());
    }
    return (await getBraveApiKeyFromSystem().catch(() => null)) ?? undefined;
  }

  if (provider === "tavily") {
    if (options.getTavilyApiKey) {
      return normalizeCredentialValue(await options.getTavilyApiKey());
    }
    return (await getTavilyApiKeyFromSystem().catch(() => null)) ?? undefined;
  }

  return undefined;
}

type SearchAdapterRequest = {
  query: string;
  provider: SearchProvider;
  capability: "search";
  credential?: string;
  fetchImpl: typeof fetch;
};

type SearchAdapterResponse = {
  results: Array<{
    title: string;
    url: string;
    snippet?: string;
    source?: string;
  }>;
};

async function searchBraveResults(request: SearchAdapterRequest): Promise<SearchAdapterResponse> {
  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set("q", request.query);
  endpoint.searchParams.set("count", "10");

  const response = await request.fetchImpl(endpoint, {
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json",
      "x-subscription-token": request.credential ?? "",
    },
  });

  if (!response.ok) {
    throw new CliCommandError(
      `Brave Search request failed with ${response.status}${await describeResponse(response)}`
    );
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        profile?: { name?: string };
      }>;
    };
  };

  return {
    results: (payload.web?.results ?? [])
      .filter((item) => typeof item.title === "string" && typeof item.url === "string")
      .map((item) =>
        buildSearchResult(
          item.title as string,
          item.url as string,
          item.description,
          item.profile?.name || safeHostname(item.url as string)
        )
      ),
  };
}

async function searchTavilyResults(request: SearchAdapterRequest): Promise<SearchAdapterResponse> {
  const endpoint = new URL("https://api.tavily.com/search");

  const response = await request.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json",
      authorization: `Bearer ${request.credential ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: request.query,
      search_depth: "basic",
      max_results: 10,
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    throw new CliCommandError(
      `Tavily request failed with ${response.status}${await describeResponse(response)}`
    );
  }

  const payload = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      snippet?: string;
      raw_content?: string | null;
      favicon?: string | null;
    }>;
  };

  return {
    results: (payload.results ?? [])
      .filter((item) => typeof item.title === "string" && typeof item.url === "string")
      .map((item) =>
        buildSearchResult(
          item.title as string,
          item.url as string,
          item.content || item.snippet || undefined,
          safeHostname(item.url as string)
        )
      ),
  };
}

async function searchDuckDuckGoResults(
  request: SearchAdapterRequest
): Promise<SearchAdapterResponse> {
  const endpoint = new URL("https://api.duckduckgo.com/");
  endpoint.searchParams.set("q", request.query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("no_html", "1");
  endpoint.searchParams.set("no_redirect", "1");
  endpoint.searchParams.set("skip_disambig", "1");
  endpoint.searchParams.set("t", "tessera");

  const response = await request.fetchImpl(endpoint, {
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new CliCommandError(
      `DuckDuckGo request failed with ${response.status}${await describeResponse(response)}`
    );
  }

  const payload = (await response.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: unknown[];
  };

  const results: SearchAdapterResponse["results"] = [];
  if (
    typeof payload.AbstractText === "string" &&
    payload.AbstractText.trim().length > 0 &&
    typeof payload.AbstractURL === "string" &&
    payload.AbstractURL.trim().length > 0
  ) {
    results.push(
      buildSearchResult(
        payload.Heading?.trim() || request.query,
        payload.AbstractURL,
        payload.AbstractText.trim(),
        safeHostname(payload.AbstractURL)
      )
    );
  }

  collectDuckDuckGoTopics(payload.RelatedTopics, results);
  return { results };
}

function collectDuckDuckGoTopics(topics: unknown, results: SearchAdapterResponse["results"]): void {
  if (!Array.isArray(topics)) {
    return;
  }

  for (const topic of topics) {
    if (!topic || typeof topic !== "object") {
      continue;
    }

    const record = topic as Record<string, unknown>;
    if (Array.isArray(record.Topics)) {
      collectDuckDuckGoTopics(record.Topics, results);
      continue;
    }

    if (
      typeof record.Text === "string" &&
      record.Text.trim().length > 0 &&
      typeof record.FirstURL === "string" &&
      record.FirstURL.trim().length > 0
    ) {
      results.push(
        buildSearchResult(
          record.Text.trim(),
          record.FirstURL,
          record.Text.trim(),
          safeHostname(record.FirstURL)
        )
      );
    }
  }
}

function buildSearchResult(
  title: string,
  url: string,
  snippet?: string,
  source?: string
): SearchAdapterResponse["results"][number] {
  const result: SearchAdapterResponse["results"][number] = { title, url };
  if (snippet) {
    result.snippet = snippet;
  }
  if (source) {
    result.source = source;
  }
  return result;
}

async function runWebFetch(args: string[], options: ExecuteCliCommandOptions) {
  const rawUrl = args[0]?.trim();
  if (!rawUrl) {
    throw new CliCommandError("Usage: web-fetch fetch <url>");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliCommandError(`Invalid URL: ${rawUrl}`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new CliCommandError(`Unsupported URL protocol: ${url.protocol}`);
  }

  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: {
      ...BROWSER_HEADERS,
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new CliCommandError(
      `Web fetch failed with ${response.status}${await describeResponse(response)}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!isSupportedContentType(contentType)) {
    throw new CliCommandError(`Unsupported content type: ${contentType || "unknown"}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BYTES) {
    throw new CliCommandError(`Fetched page is too large (${contentLength} bytes).`);
  }

  const html = await response.text();
  if (!html.trim()) {
    throw new CliCommandError("Fetched page was empty.");
  }
  if (html.length > MAX_FETCH_BYTES) {
    throw new CliCommandError(`Fetched page is too large (${html.length} bytes).`);
  }

  const extracted = extractReadableMarkdown(html);
  if (!extracted.markdown) {
    throw new CliCommandError("Could not extract readable page content.");
  }

  return {
    url: response.url || rawUrl,
    ...(extracted.title ? { title: extracted.title } : {}),
    markdown: extracted.markdown,
    ...(extracted.author ? { author: extracted.author } : {}),
    ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
    diagnostics: {
      status: response.status,
      ...(contentType ? { contentType } : {}),
    },
  };
}

async function runGcalList(args: string[], options: ExecuteCliCommandOptions) {
  const { calendarId, limit } = parseGcalListArgs(args);
  return createGoogleWorkspaceConnector(options).listCalendarEvents({ calendarId, limit });
}

async function runGcalRead(args: string[], options: ExecuteCliCommandOptions) {
  const { calendarId, eventId } = parseGcalReadArgs(args);
  return createGoogleWorkspaceConnector(options).readCalendarEvent({ calendarId, eventId });
}

async function runMailList(args: string[], options: ExecuteCliCommandOptions) {
  const { limit, query } = parseMailListArgs(args);
  return createGoogleWorkspaceConnector(options).listMail({ limit, ...(query ? { query } : {}) });
}

async function runMailSearch(args: string[], options: ExecuteCliCommandOptions) {
  const { query, limit } = parseMailSearchArgs(args);
  return createGoogleWorkspaceConnector(options).searchMail({ query, limit });
}

async function runMailRead(args: string[], options: ExecuteCliCommandOptions) {
  const { messageId } = parseMailReadArgs(args);
  return createGoogleWorkspaceConnector(options).readMail({ messageId });
}

async function runDriveSearch(args: string[], options: ExecuteCliCommandOptions) {
  const { query, limit } = parseDriveSearchArgs(args);
  return createGoogleWorkspaceConnector(options).searchDrive({ query, limit });
}

async function runDriveRead(args: string[], options: ExecuteCliCommandOptions) {
  const { fileId, format } = parseDriveReadArgs(args);
  return createGoogleWorkspaceConnector(options).readDriveFile({ fileId, format });
}

async function runContactsLookup(args: string[], options: ExecuteCliCommandOptions) {
  const { query, limit } = parseContactsLookupArgs(args);
  return createGoogleWorkspaceConnector(options).lookupContacts({ query, limit });
}

function createGoogleWorkspaceConnector(
  options: ExecuteCliCommandOptions
): GoogleWorkspaceConnector {
  return (
    options.googleWorkspaceConnector ??
    createGwsGoogleWorkspaceConnector({
      runGwsCli: options.runGwsCli ?? runGwsCli,
    })
  );
}

async function describeResponse(response: Response): Promise<string> {
  const text = (await response.text()).trim().slice(0, 200);
  return text ? `: ${text}` : "";
}

function isSupportedContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("text/html") || normalized.startsWith("application/xhtml+xml");
}

function extractReadableMarkdown(html: string) {
  const rootHtml = pickPrimaryHtml(html);
  const cleaned = rootHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<(nav|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, "");

  const title =
    readMetaTag(html, "property", "og:title") ||
    readMetaTag(html, "name", "twitter:title") ||
    readTagText(html, "title") ||
    readTagText(cleaned, "h1");
  const author =
    readMetaTag(html, "name", "author") || readMetaTag(html, "property", "article:author");
  const publishedAt =
    readMetaTag(html, "property", "article:published_time") ||
    readMetaTag(html, "name", "publish_date") ||
    readTimeDatetime(html);
  const markdown = normalizeMarkdown(
    NodeHtmlMarkdown.translate(cleaned, {
      bulletMarker: "-",
      codeFence: "```",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      strongDelimiter: "**",
    })
  );

  return { title: title || undefined, author: author || undefined, publishedAt, markdown };
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function stripTags(html: string, collapseWhitespace = true): string {
  const text = html.replace(/<[^>]+>/g, " ");
  return collapseWhitespace ? text.replace(/\s+/g, " ").trim() : text;
}

function pickPrimaryHtml(html: string): string {
  return (
    matchTagBody(html, "main") ??
    matchTagBody(html, "article") ??
    matchTagBody(html, "body") ??
    html
  );
}

function matchTagBody(html: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return match?.[1];
}

function readTagText(html: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return match ? decodeHtmlEntities(stripTags(match[1] ?? "")) : "";
}

function readMetaTag(html: string, attribute: "name" | "property", value: string): string {
  const match = new RegExp(
    `<meta\\s+[^>]*${attribute}=(["'])${escapeRegExp(value)}\\1[^>]*content=(["'])([\\s\\S]*?)\\2[^>]*>`,
    "i"
  ).exec(html);
  return match?.[3] ? decodeHtmlEntities(match[3]).trim() : "";
}

function readTimeDatetime(html: string): string | undefined {
  const match = /<time\b[^>]*datetime=(["'])([\s\S]*?)\1[^>]*>/i.exec(html);
  return match?.[2]?.trim() || undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function parseGcalListArgs(args: string[]): { calendarId: string; limit: number } {
  let calendarId = "primary";
  let limit = 10;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed <= 0) {
        throw new CliCommandError("Usage: gcal list [--limit <n>] [--calendar <id>]");
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg === "--calendar") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError("Usage: gcal list [--limit <n>] [--calendar <id>]");
      }
      calendarId = value;
      index += 1;
      continue;
    }
    throw new CliCommandError("Usage: gcal list [--limit <n>] [--calendar <id>]");
  }

  return { calendarId, limit };
}

function parseGcalReadArgs(args: string[]): { calendarId: string; eventId: string } {
  const eventId = args[0]?.trim();
  if (!eventId) {
    throw new CliCommandError("Usage: gcal read <event-id> [--calendar <id>]");
  }

  let calendarId = "primary";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--calendar") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError("Usage: gcal read <event-id> [--calendar <id>]");
      }
      calendarId = value;
      index += 1;
      continue;
    }
    throw new CliCommandError("Usage: gcal read <event-id> [--calendar <id>]");
  }

  return { calendarId, eventId };
}

function parseMailListArgs(args: string[]): { limit: number; query?: string } {
  let limit = 10;
  let query = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      throw new CliCommandError("Usage: mail list [--limit <n>] [--query <query>]");
    }
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) {
        throw new CliCommandError("Usage: mail list [--limit <n>] [--query <query>]");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliCommandError("Usage: mail list [--limit <n>] [--query <query>]");
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg === "--query") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError("Usage: mail list [--limit <n>] [--query <query>]");
      }
      query = value;
      index += 1;
      continue;
    }
    throw new CliCommandError("Usage: mail list [--limit <n>] [--query <query>]");
  }

  return query ? { limit, query } : { limit };
}

function parseMailSearchArgs(args: string[]): { query: string; limit: number } {
  let limit = 10;
  const queryParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      throw new CliCommandError("Usage: mail search <query> [--limit <n>]");
    }
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) {
        throw new CliCommandError("Usage: mail search <query> [--limit <n>]");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliCommandError("Usage: mail search <query> [--limit <n>]");
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliCommandError("Usage: mail search <query> [--limit <n>]");
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new CliCommandError("Usage: mail search <query> [--limit <n>]");
  }

  return { query, limit };
}

function parseMailReadArgs(args: string[]): { messageId: string } {
  const messageId = args[0]?.trim();
  if (!messageId || args.length !== 1) {
    throw new CliCommandError("Usage: mail read <messageId>");
  }
  return { messageId };
}

function parseDriveSearchArgs(args: string[]): { query: string; limit: number } {
  let limit = 10;
  const queryParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      throw new CliCommandError("Usage: drive search <query> [--limit <n>]");
    }
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) {
        throw new CliCommandError("Usage: drive search <query> [--limit <n>]");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliCommandError("Usage: drive search <query> [--limit <n>]");
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliCommandError("Usage: drive search <query> [--limit <n>]");
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new CliCommandError("Usage: drive search <query> [--limit <n>]");
  }

  return { query, limit };
}

function parseDriveReadArgs(args: string[]): {
  fileId: string;
  format: "text" | "markdown" | "csv" | "json";
} {
  const fileId = args[0]?.trim();
  if (!fileId) {
    throw new CliCommandError("Usage: drive read <fileId> [--format text|markdown|csv|json]");
  }

  let format: "text" | "markdown" | "csv" | "json" = "text";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--format") {
      const value = args[index + 1];
      if (value === "text" || value === "markdown" || value === "csv" || value === "json") {
        format = value;
        index += 1;
        continue;
      }
      throw new CliCommandError("Usage: drive read <fileId> [--format text|markdown|csv|json]");
    }
    throw new CliCommandError("Usage: drive read <fileId> [--format text|markdown|csv|json]");
  }

  return { fileId, format };
}

function parseContactsLookupArgs(args: string[]): { query: string; limit: number } {
  let limit = 10;
  const queryParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      throw new CliCommandError("Usage: contacts lookup <query> [--limit <n>]");
    }
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) {
        throw new CliCommandError("Usage: contacts lookup <query> [--limit <n>]");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliCommandError("Usage: contacts lookup <query> [--limit <n>]");
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliCommandError("Usage: contacts lookup <query> [--limit <n>]");
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new CliCommandError("Usage: contacts lookup <query> [--limit <n>]");
  }

  return { query, limit };
}

function normalizeCredentialValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

async function getBraveApiKeyFromSystem(): Promise<string | null> {
  const envValue = process.env.TESSERA_BRAVE_SEARCH_API_KEY?.trim();
  if (envValue) {
    return envValue;
  }

  if (process.platform === "darwin") {
    return readSecret([
      "security",
      "find-generic-password",
      "-a",
      BRAVE_SEARCH_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
  }

  if (process.platform === "linux") {
    return readSecret([
      "secret-tool",
      "lookup",
      "service",
      KEYCHAIN_SERVICE,
      "account",
      BRAVE_SEARCH_ACCOUNT,
    ]);
  }

  return null;
}

async function getTavilyApiKeyFromSystem(): Promise<string | null> {
  const envValue = process.env.TESSERA_TAVILY_API_KEY?.trim();
  if (envValue) {
    return envValue;
  }

  if (process.platform === "darwin") {
    return readSecret([
      "security",
      "find-generic-password",
      "-a",
      TAVILY_SEARCH_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
  }

  if (process.platform === "linux") {
    return readSecret([
      "secret-tool",
      "lookup",
      "service",
      KEYCHAIN_SERVICE,
      "account",
      TAVILY_SEARCH_ACCOUNT,
    ]);
  }

  return null;
}

async function readSecret(command: string[]): Promise<string | null> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    return null;
  }
  const value = stdout.trim();
  return value.length > 0 ? value : null;
}
