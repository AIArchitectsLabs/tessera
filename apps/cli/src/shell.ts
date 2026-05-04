import { URL } from "node:url";
import { NodeHtmlMarkdown } from "node-html-markdown";

const KEYCHAIN_SERVICE = "Tessera";
const BRAVE_SEARCH_ACCOUNT = "integration.brave-search";
const GOOGLE_CALENDAR_ACCOUNT = "integration.google-calendar";
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
  getGoogleCalendarApiKey?: () => Promise<string | null>;
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

async function runGcalList(args: string[], options: ExecuteCliCommandOptions) {
  const { calendarId, limit } = parseGcalListArgs(args);
  const apiKey =
    (await options.getGoogleCalendarApiKey?.()) ??
    (await getGoogleCalendarApiKeyFromSystem().catch(() => null));
  if (!apiKey) {
    throw new CliCommandError(
      "Google Calendar is not configured. Add an API key in Settings > Integrations."
    );
  }

  const endpoint = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  endpoint.searchParams.set("maxResults", String(limit));
  endpoint.searchParams.set("singleEvents", "true");
  endpoint.searchParams.set("orderBy", "startTime");
  endpoint.searchParams.set("timeMin", new Date().toISOString());

  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new CliCommandError(
      `Google Calendar request failed with ${response.status}${await describeResponse(response)}`
    );
  }

  const payload = (await response.json()) as { items?: Array<Record<string, unknown>> };
  return {
    calendarId,
    events: (payload.items ?? []).map((item) => normalizeGcalEvent(item)),
  };
}

async function runGcalRead(args: string[], options: ExecuteCliCommandOptions) {
  const { calendarId, eventId } = parseGcalReadArgs(args);
  const apiKey =
    (await options.getGoogleCalendarApiKey?.()) ??
    (await getGoogleCalendarApiKeyFromSystem().catch(() => null));
  if (!apiKey) {
    throw new CliCommandError(
      "Google Calendar is not configured. Add an API key in Settings > Integrations."
    );
  }

  const endpoint = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  );

  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new CliCommandError(
      `Google Calendar request failed with ${response.status}${await describeResponse(response)}`
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return {
    calendarId,
    event: normalizeGcalEvent(payload, true),
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

function normalizeGcalEvent(
  item: Record<string, unknown>,
  includeAttendees = false
): Record<string, unknown> {
  const startValue = readGcalDate(item.start);
  const endValue = readGcalDate(item.end);
  const allDay = isGcalAllDay(item.start);
  const normalized: Record<string, unknown> = {
    id: typeof item.id === "string" ? item.id : "",
    title: typeof item.summary === "string" ? item.summary : "Untitled event",
    start: startValue,
    isAllDay: allDay,
  };

  if (typeof item.status === "string") normalized.status = item.status;
  if (typeof item.description === "string") normalized.description = item.description;
  if (typeof item.location === "string") normalized.location = item.location;
  if (typeof endValue === "string" && endValue.length > 0) normalized.end = endValue;
  if (typeof item.htmlLink === "string") normalized.htmlLink = item.htmlLink;

  const organizer = item.organizer;
  if (organizer && typeof organizer === "object" && typeof organizer.email === "string") {
    normalized.organizerEmail = organizer.email;
  }

  if (includeAttendees && Array.isArray(item.attendees)) {
    normalized.attendees = item.attendees
      .filter((attendee): attendee is Record<string, unknown> => !!attendee && typeof attendee === "object")
      .map((attendee) => ({
        email: typeof attendee.email === "string" ? attendee.email : "",
        ...(typeof attendee.displayName === "string"
          ? { displayName: attendee.displayName }
          : {}),
        ...(typeof attendee.responseStatus === "string"
          ? { responseStatus: attendee.responseStatus }
          : {}),
      }))
      .filter((attendee) => attendee.email.length > 0);
  }

  return normalized;
}

function readGcalDate(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (typeof value.dateTime === "string") return value.dateTime;
  if (typeof value.date === "string") return value.date;
  return "";
}

function isGcalAllDay(value: unknown): boolean {
  return !!value && typeof value === "object" && typeof value.date === "string";
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

async function getGoogleCalendarApiKeyFromSystem(): Promise<string | null> {
  const envValue = process.env.TESSERA_GOOGLE_CALENDAR_API_KEY?.trim();
  if (envValue) {
    return envValue;
  }

  if (process.platform === "darwin") {
    return readSecret([
      "security",
      "find-generic-password",
      "-a",
      GOOGLE_CALENDAR_ACCOUNT,
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
      GOOGLE_CALENDAR_ACCOUNT,
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
