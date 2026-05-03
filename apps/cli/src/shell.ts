import { URL } from "node:url";
import { NodeHtmlMarkdown } from "node-html-markdown";

const KEYCHAIN_SERVICE = "Tessera";
const BRAVE_SEARCH_ACCOUNT = "integration.brave-search";
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

    throw new CliCommandError(
      `Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof CliCommandError ? error.exitCode : 1;
    return { exitCode, stdout: "", stderr: `${message}\n` };
  }
}

async function runWebSearch(args: string[], options: ExecuteCliCommandOptions) {
  const query = args.join(" ").trim();
  if (!query) {
    throw new CliCommandError("Usage: web-search search <query>");
  }

  const apiKey =
    (await options.getBraveApiKey?.()) ?? (await getBraveApiKeyFromSystem().catch(() => null));
  if (!apiKey) {
    throw new CliCommandError(
      "Brave Search is not configured. Add an API key in Settings > Integrations."
    );
  }

  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", "10");

  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json",
      "x-subscription-token": apiKey,
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

  const results = (payload.web?.results ?? [])
    .filter((item) => typeof item.title === "string" && typeof item.url === "string")
    .map((item) => ({
      title: item.title as string,
      url: item.url as string,
      ...(item.description ? { snippet: item.description } : {}),
      source: item.profile?.name || safeHostname(item.url as string),
    }));

  return { query, results };
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

async function readSecret(command: string[]): Promise<string | null> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    return null;
  }
  const value = stdout.trim();
  return value.length > 0 ? value : null;
}
