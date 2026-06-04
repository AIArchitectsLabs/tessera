import {
  type HubSpotObjectMutationResult,
  HubSpotObjectMutationResultSchema,
  type HubSpotObjectReadResult,
  HubSpotObjectReadResultSchema,
  type HubSpotObjectSearchResult,
  HubSpotObjectSearchResultSchema,
  type HubSpotObjectType,
  type HubSpotSummaryResult,
  HubSpotSummaryResultSchema,
} from "@tessera/contracts";

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1100;

export class HubSpotConnectorError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2
  ) {
    super(message);
    this.name = "HubSpotConnectorError";
  }
}

export interface HubSpotConnectorOptions {
  accessToken?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  maxRetries?: number;
  retryDelayMs?: number;
}

type HubSpotObjectPayload = {
  id?: unknown;
  properties?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
};

async function hubspotJson(
  path: string,
  options: HubSpotConnectorOptions,
  init: RequestInit = {}
): Promise<unknown> {
  const accessToken = options.accessToken?.trim();
  if (!accessToken) {
    throw new HubSpotConnectorError(
      "HubSpot is not configured. Add a private app token in Settings > Integrations."
    );
  }

  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  let response: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    response = await (options.fetchImpl ?? fetch)(`${HUBSPOT_API_BASE}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) break;

    await delay(retryDelayMs(response, options.retryDelayMs));
  }

  if (!response?.ok) {
    throw new HubSpotConnectorError(
      `HubSpot request failed with ${response?.status ?? "unknown"}${
        response ? await describeResponse(response) : ""
      }`
    );
  }

  return response.json();
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, configuredDelayMs: number | undefined): number {
  if (configuredDelayMs !== undefined) return Math.max(0, configuredDelayMs);
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.ceil(retryAfterSeconds * 1000);
  }
  return DEFAULT_RETRY_DELAY_MS;
}

async function describeResponse(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return "";
  return `: ${text.slice(0, 500)}`;
}

function normalizeProperties(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const properties: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    properties[key] = String(raw);
  }
  return properties;
}

function normalizeObject(payload: HubSpotObjectPayload) {
  return {
    id: String(payload.id ?? ""),
    properties: normalizeProperties(payload.properties),
    ...(typeof payload.createdAt === "string" ? { createdAt: payload.createdAt } : {}),
    ...(typeof payload.updatedAt === "string" ? { updatedAt: payload.updatedAt } : {}),
    archived: payload.archived === true,
  };
}

function resultsFromPayload(payload: unknown): HubSpotObjectPayload[] {
  if (!payload || typeof payload !== "object") return [];
  const results = (payload as { results?: unknown }).results;
  return Array.isArray(results) ? (results as HubSpotObjectPayload[]) : [];
}

function totalFromPayload(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const total = (payload as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
}

async function countObjectType(
  objectType: HubSpotObjectType,
  options: HubSpotConnectorOptions
): Promise<number> {
  const payload = await hubspotJson(`/crm/v3/objects/${objectType}/search`, options, {
    method: "POST",
    body: JSON.stringify({ limit: 1, filterGroups: [] }),
  });
  return totalFromPayload(payload);
}

export async function hubspotSummary(
  options: HubSpotConnectorOptions
): Promise<HubSpotSummaryResult> {
  const contacts = await countObjectType("contacts", options);
  const companies = await countObjectType("companies", options);
  const deals = await countObjectType("deals", options);
  return HubSpotSummaryResultSchema.parse({ counts: { contacts, companies, deals } });
}

export async function hubspotSearchObjects(
  objectType: HubSpotObjectType,
  query: string,
  limit: number,
  options: HubSpotConnectorOptions
): Promise<HubSpotObjectSearchResult> {
  const payload = await hubspotJson(`/crm/v3/objects/${objectType}/search`, options, {
    method: "POST",
    body: JSON.stringify({
      limit,
      ...(query.trim() ? { query: query.trim() } : {}),
    }),
  });
  return HubSpotObjectSearchResultSchema.parse({
    objectType,
    results: resultsFromPayload(payload).map((item) => normalizeObject(item)),
  });
}

export async function hubspotReadObject(
  objectType: HubSpotObjectType,
  id: string,
  options: HubSpotConnectorOptions
): Promise<HubSpotObjectReadResult> {
  const payload = await hubspotJson(
    `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}`,
    options
  );
  return HubSpotObjectReadResultSchema.parse({
    objectType,
    result: normalizeObject(payload as HubSpotObjectPayload),
  });
}

export async function hubspotMutateObject(
  objectType: HubSpotObjectType,
  action: "create" | "update",
  properties: Record<string, string>,
  options: HubSpotConnectorOptions,
  id?: string
): Promise<HubSpotObjectMutationResult> {
  const isUpdate = action === "update";
  const payload = await hubspotJson(
    isUpdate
      ? `/crm/v3/objects/${objectType}/${encodeURIComponent(id ?? "")}`
      : `/crm/v3/objects/${objectType}`,
    options,
    {
      method: isUpdate ? "PATCH" : "POST",
      body: JSON.stringify({ properties }),
    }
  );
  return HubSpotObjectMutationResultSchema.parse({
    objectType,
    action,
    result: normalizeObject(payload as HubSpotObjectPayload),
  });
}
