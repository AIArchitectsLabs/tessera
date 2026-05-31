import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import {
  type IntegrationSettingsRead,
  IntegrationSettingsReadSchema,
  type SearchProvider,
  SearchSettingsSchema,
  SheetsSupplierWorkbookHeaders,
  SheetsTableNameSchema,
} from "@tessera/contracts";
import {
  CORE_VERSION,
  type LoadedGraphPlaybookPackage,
  type WebSearchRuntime,
  executeWebSearch,
  loadGraphPlaybookPackage,
} from "@tessera/core";
import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  type CommandResult,
  type GoogleWorkspaceConnector,
  GoogleWorkspaceConnectorError,
  createGwsGoogleWorkspaceConnector,
  normalizeGwsError,
  runGwsCli,
  runGwsWriteCli,
} from "./google-connector.js";

const KEYCHAIN_SERVICE = "Tessera";
const BRAVE_SEARCH_ACCOUNT = "integration.brave-search";
const TAVILY_SEARCH_ACCOUNT = "integration.tavily";
const INTEGRATION_SETTINGS_FILE = "integration-settings.json";
const MAX_FETCH_BYTES = 1_000_000;
const BROWSER_HEADERS = {
  "user-agent": "Tessera/0.1.0 (+https://tessera.app)",
};
const GOOGLE_DOCS_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_SHEETS_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

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
  playbookCompilerVersion?: string;
  playbookScriptSdkVersion?: string;
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
    if (command === "playbook" && subcommand === "validate") {
      return await runPlaybookValidate(args, options);
    }

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

    if (command === "mail" && subcommand === "draft") {
      const payload = await runMailDraft(args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "mail" && subcommand === "send-draft") {
      const payload = await runMailSendDraft(args, options);
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

    if (command === "sheets") {
      const payload = await runSheetsCommand(subcommand, args, options);
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }

    if (command === "docs") {
      const payload = await runDocsCommand(subcommand, args, options);
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

type PlaybookValidationSeverity = "error" | "warning" | "info";
type LoadedPlaybookGraph = LoadedGraphPlaybookPackage["compiled"]["graph"];
type LoadedPlaybookGraphBranch = {
  start: string;
  nodes: LoadedPlaybookGraph["nodes"];
};

type PlaybookValidationDiagnostic = {
  code: string;
  severity: PlaybookValidationSeverity;
  message: string;
  path?: string;
  nodeId?: string;
  artifact?: string;
  ref?: string;
  repairHint: string;
};

type PlaybookValidationResult = {
  ok: boolean;
  summary: Record<"errors" | "warnings" | "info", number>;
  diagnostics: PlaybookValidationDiagnostic[];
};

const PLAYBOOK_USAGE = "Usage: playbook validate <path> [--json]";

async function runPlaybookValidate(
  args: string[],
  options: ExecuteCliCommandOptions
): Promise<CliCommandResult> {
  const parsed = parsePlaybookValidateArgs(args);
  const compilerVersion = options.playbookCompilerVersion ?? CORE_VERSION;
  const scriptSdkVersion = options.playbookScriptSdkVersion ?? CORE_VERSION;

  try {
    const loaded = await loadGraphPlaybookPackage({
      root: parsed.path,
      compilerVersion,
      scriptSdkVersion,
    });
    const diagnostics = collectAuthoringDiagnostics(loaded);
    const result = createPlaybookValidationResult(diagnostics);
    return {
      exitCode: result.ok ? 0 : 1,
      stdout: parsed.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatPlaybookValidationText(parsed.path, result),
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isUnreadablePathError(error)) {
      throw new CliCommandError(message, 2);
    }

    const diagnostic = diagnosticFromLoaderError(message);
    const result = createPlaybookValidationResult([diagnostic]);
    return {
      exitCode: 1,
      stdout: parsed.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatPlaybookValidationText(parsed.path, result),
      stderr: "",
    };
  }
}

function parsePlaybookValidateArgs(args: string[]): { path: string; json: boolean } {
  let json = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliCommandError(PLAYBOOK_USAGE);
    }
    positional.push(arg);
  }

  if (positional.length !== 1) {
    throw new CliCommandError(PLAYBOOK_USAGE);
  }

  return { path: positional[0] ?? "", json };
}

function isUnreadablePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

function createPlaybookValidationResult(
  diagnostics: PlaybookValidationDiagnostic[]
): PlaybookValidationResult {
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") summary.errors += 1;
    if (diagnostic.severity === "warning") summary.warnings += 1;
    if (diagnostic.severity === "info") summary.info += 1;
  }

  return {
    ok: summary.errors === 0,
    summary,
    diagnostics,
  };
}

function diagnosticFromLoaderError(message: string): PlaybookValidationDiagnostic {
  const lower = message.toLowerCase();
  let code = "package_validation_failed";
  let repairHint =
    "Fix the package, manifest, graph, or referenced source files, then run validation again.";

  if (lower.includes("source ref is missing")) {
    code = "missing_source_ref";
    repairHint =
      "Create the referenced package file or update the graph source ref to an existing package-relative file.";
  } else if (lower.includes("dangerous imports")) {
    code = "dangerous_import";
    repairHint =
      "Remove Node/runtime imports from the playbook package; keep domain logic in declared scripts and Tessera capabilities.";
  } else if (lower.includes("dynamic import") || lower.includes("require()")) {
    code = "disallowed_import_form";
    repairHint =
      "Use static ES imports only, and reference package-relative files or @tessera/plugin-sdk.";
  } else if (lower.includes("manifest") && lower.includes("match")) {
    code = "manifest_graph_mismatch";
    repairHint = "Make manifest id, version, and name match the default-exported graph.";
  } else if (lower.includes("unknown transition") || lower.includes("unknown start node")) {
    code = "invalid_graph_transition";
    repairHint =
      "Update start, onSuccess/onFailure, condition, or review transitions to target existing nodes or terminal states.";
  } else if (lower.includes("unknown artifact")) {
    code = "undeclared_artifact";
    repairHint =
      "Declare the artifact in graph.artifacts or update the node to use an existing artifact name.";
  } else if (lower.includes("undeclared capability") || lower.includes("undeclared agent tool")) {
    code = "undeclared_capability";
    repairHint =
      "Declare the capability in graph.capabilities or remove the tool reference from the node.";
  } else if (lower.includes("package.json") && lower.includes("dependencies")) {
    code = "disallowed_dependency_field";
    repairHint =
      "Remove dependency fields from package.json; external playbooks must rely only on Tessera SDK/contracts.";
  }

  return {
    code,
    severity: "error",
    message,
    repairHint,
  };
}

function formatPlaybookValidationText(path: string, result: PlaybookValidationResult): string {
  const lines = [
    result.ok ? `Playbook validation passed: ${path}` : `Playbook validation failed: ${path}`,
    `Summary: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s), ${result.summary.info} info`,
  ];

  for (const diagnostic of result.diagnostics) {
    const location = [diagnostic.path, diagnostic.nodeId, diagnostic.artifact]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    lines.push(
      `- [${diagnostic.severity}] ${diagnostic.code}${location ? ` (${location})` : ""}: ${diagnostic.message}`,
      `  Repair: ${diagnostic.repairHint}`
    );
  }

  return `${lines.join("\n")}\n`;
}

function collectAuthoringDiagnostics(
  loaded: LoadedGraphPlaybookPackage
): PlaybookValidationDiagnostic[] {
  const diagnostics: PlaybookValidationDiagnostic[] = [];
  collectGraphAuthoringDiagnostics({
    diagnostics,
    graph: loaded.compiled.graph,
    branch: { start: loaded.compiled.graph.start, nodes: loaded.compiled.graph.nodes },
    path: loaded.manifest.entrypoint,
  });

  if (!graphHasFinalMaterialization(loaded.compiled.graph)) {
    diagnostics.push({
      code: "missing_final_materialization",
      severity: "warning",
      message:
        "Graph has no artifactWrite node, workspace.write effect, or artifact materialize target.",
      path: loaded.manifest.entrypoint,
      repairHint:
        "Add a workspace.write effect, artifactWrite node, or materialize path for at least one final artifact.",
    });
  }

  return diagnostics;
}

function collectGraphAuthoringDiagnostics(options: {
  diagnostics: PlaybookValidationDiagnostic[];
  graph: LoadedPlaybookGraph;
  branch: LoadedPlaybookGraphBranch;
  path: string;
}): void {
  const declaredCapabilities = new Set(options.graph.capabilities);

  for (const node of options.branch.nodes) {
    if (node.kind === "tool" && !declaredCapabilities.has(node.capability)) {
      options.diagnostics.push({
        code: "undeclared_capability",
        severity: "error",
        message: `Tool node uses undeclared capability ${node.capability}.`,
        path: options.path,
        nodeId: node.id,
        ref: node.capability,
        repairHint:
          "Add the capability to graph.capabilities or update the node to use a declared capability.",
      });
    }

    if (node.kind === "agent") {
      for (const tool of node.tools) {
        if (!declaredCapabilities.has(tool)) {
          options.diagnostics.push({
            code: "undeclared_capability",
            severity: "error",
            message: `Agent node declares undeclared tool capability ${tool}.`,
            path: options.path,
            nodeId: node.id,
            ref: tool,
            repairHint:
              "Add the capability to graph.capabilities or remove it from the agent tool list.",
          });
        }
      }
      if (node.output !== undefined && node.output.schema === undefined) {
        options.diagnostics.push({
          code: "agent_output_missing_schema",
          severity: "error",
          message: "Agent output is missing a schema ref.",
          path: options.path,
          nodeId: node.id,
          ...(node.output.artifact === undefined ? {} : { artifact: node.output.artifact }),
          repairHint:
            "Declare node.output.schema so external-agent repair loops can validate structured output.",
        });
      }
    }

    if (node.kind === "parallelMap") {
      collectGraphAuthoringDiagnostics({
        diagnostics: options.diagnostics,
        graph: options.graph,
        branch: node.branch,
        path: `${options.path}#${node.id}.branch`,
      });
    }
  }
}

function graphHasFinalMaterialization(graph: LoadedPlaybookGraph): boolean {
  if (Object.values(graph.artifacts).some((artifact) => artifact.materialize !== undefined)) {
    return true;
  }

  return branchHasFinalWrite({ start: graph.start, nodes: graph.nodes });
}

function branchHasFinalWrite(branch: LoadedPlaybookGraphBranch): boolean {
  for (const node of branch.nodes) {
    if (node.kind === "artifactWrite") return true;
    if (
      node.kind === "effect" &&
      node.adapterId === "workspace" &&
      node.effectId === "workspace.write"
    ) {
      return true;
    }
    if (node.kind === "parallelMap" && branchHasFinalWrite(node.branch)) return true;
  }
  return false;
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
      googleWorkspace: {
        provider: "google-workspace",
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

async function runMailDraft(args: string[], options: ExecuteCliCommandOptions) {
  const request = parseMailDraftArgs(args);
  return createGoogleWorkspaceConnector(options).createMailDraft({
    raw: buildMailDraftRaw(request),
  });
}

async function runMailSendDraft(args: string[], options: ExecuteCliCommandOptions) {
  const request = parseMailSendDraftArgs(args);
  return createGoogleWorkspaceConnector(options).sendMailDraft({ draftId: request.draftId });
}

async function runDriveSearch(args: string[], options: ExecuteCliCommandOptions) {
  const { query, limit } = parseDriveSearchArgs(args);
  return createGoogleWorkspaceConnector(options).searchDrive({ query, limit });
}

async function runDriveRead(args: string[], options: ExecuteCliCommandOptions) {
  return createGoogleWorkspaceConnector(options).readDriveFile(parseDriveReadArgs(args));
}

async function runContactsLookup(args: string[], options: ExecuteCliCommandOptions) {
  const { query, limit } = parseContactsLookupArgs(args);
  return createGoogleWorkspaceConnector(options).lookupContacts({ query, limit });
}

type WriteMode =
  | { mode: "dry-run"; idempotencyKey: string }
  | { mode: "execute"; approvalId: string; idempotencyKey: string };

type ParsedFlagArgs = { flags: Map<string, string>; mode: WriteMode };

const WRITE_EXECUTION_TOKEN_ENV = "TESSERA_GWS_WRITE_EXECUTION_TOKEN";

async function runSheetsCommand(
  subcommand: string | undefined,
  args: string[],
  options: ExecuteCliCommandOptions
) {
  if (subcommand === "rows.upsert") return runSheetsRowsUpsert(args, options);
  if (subcommand === "rows.append") return runSheetsRowsAppend(args, options);
  if (subcommand === "rows.updateStatus") return runSheetsRowsUpdateStatus(args, options);
  if (subcommand === "workbook.create") return runSheetsWorkbookCreate(args, options);
  throw new CliCommandError(
    "Unsupported sheets subcommand. Allowed: rows.upsert, rows.append, rows.updateStatus, workbook.create"
  );
}

async function runDocsCommand(
  subcommand: string | undefined,
  args: string[],
  options: ExecuteCliCommandOptions
) {
  if (subcommand === "documents.create") return runDocsDocumentsCreate(args, options);
  if (subcommand === "documents.appendText") return runDocsDocumentsAppendText(args, options);
  if (subcommand === "documents.replacePlaceholders")
    return runDocsDocumentsReplacePlaceholders(args, options);
  throw new CliCommandError(
    "Unsupported docs subcommand. Allowed: documents.create, documents.appendText, documents.replacePlaceholders"
  );
}

function parseWriteArgs(args: string[], usage: string, allowedFlags: string[]): ParsedFlagArgs {
  const flags = new Map<string, string>();
  let dryRun = false;
  let execute = false;
  const allowed = new Set([
    ...allowedFlags,
    "--dry-run",
    "--execute",
    "--approval",
    "--idempotency-key",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (!arg || !allowed.has(arg)) throw new CliCommandError(usage);
    const value = args[index + 1]?.trim();
    if (!value) throw new CliCommandError(usage);
    flags.set(arg, value);
    index += 1;
  }

  if (dryRun === execute) throw new CliCommandError(usage);
  const idempotencyKey = flags.get("--idempotency-key");
  if (!idempotencyKey) throw new CliCommandError(`${usage} (requires --idempotency-key <key>)`);
  if (execute) {
    const approvalId = flags.get("--approval");
    if (!approvalId) throw new CliCommandError(`${usage} (execute requires --approval <id>)`);
    assertSidecarWriteExecutionBinding(approvalId, idempotencyKey);
    return { flags, mode: { mode: "execute", approvalId, idempotencyKey } };
  }
  if (flags.has("--approval"))
    throw new CliCommandError(`${usage} (--approval is only valid with --execute)`);
  return { flags, mode: { mode: "dry-run", idempotencyKey } };
}

function assertSidecarWriteExecutionBinding(approvalId: string, idempotencyKey: string): void {
  const token = process.env[WRITE_EXECUTION_TOKEN_ENV]?.trim();
  if (!token) {
    throw new CliCommandError(
      "Google Workspace write execute requires a sidecar-consumed Action Inbox grant; --approval alone is not authority."
    );
  }
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      approvalId?: unknown;
      idempotencyKey?: unknown;
      expiresAt?: unknown;
    };
    if (parsed.approvalId !== approvalId || parsed.idempotencyKey !== idempotencyKey) {
      throw new Error("mismatched approval binding");
    }
    if (typeof parsed.expiresAt === "string" && Date.parse(parsed.expiresAt) <= Date.now()) {
      throw new Error("expired approval binding");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliCommandError(`Invalid Google Workspace write execution binding: ${reason}`);
  }
}

function requiredFlag(flags: Map<string, string>, name: string, usage: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new CliCommandError(usage);
  return value;
}

function parseTable(value: string, usage: string) {
  const parsed = SheetsTableNameSchema.safeParse(value);
  if (!parsed.success) throw new CliCommandError(`${usage} (unknown table: ${value})`);
  return parsed.data;
}

function parseJsonObject(value: string, usage: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliCommandError(`${usage} (invalid JSON object: ${reason})`);
  }
}

async function runGoogleWriteJson(
  options: ExecuteCliCommandOptions,
  command: string[],
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const runner = options.runGwsCli ?? runGwsWriteCli;
  const result = await runner(body ? [...command, "--json", JSON.stringify(body)] : command);
  if (result.exitCode !== 0) {
    throw new GoogleWorkspaceConnectorError(
      normalizeGwsError(result.stderr) ||
        `Google Workspace CLI exited with status ${result.exitCode}`,
      result.exitCode
    );
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new GoogleWorkspaceConnectorError("Google Workspace CLI returned invalid JSON output.");
  }
}

function headersForTable(table: keyof typeof SheetsSupplierWorkbookHeaders): readonly string[] {
  return SheetsSupplierWorkbookHeaders[table] as readonly string[];
}

function validateRowForTable(
  table: keyof typeof SheetsSupplierWorkbookHeaders,
  row: Record<string, unknown>,
  usage: string,
  extraColumns: string[] = []
): void {
  const allowed = new Set<string>([...headersForTable(table), ...extraColumns]);
  const unknown = Object.keys(row).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new CliCommandError(`${usage} (unsupported ${table} column(s): ${unknown.join(", ")})`);
  }
}

function changedCellsFromRow(row: Record<string, unknown>) {
  return Object.entries(row).map(([column, after]) => ({ column, after }));
}

type SheetCellValue = string | number | boolean | null;

interface SheetTableData {
  headers: string[];
  rows: SheetCellValue[][];
}

interface SheetProperties {
  sheetId: number;
  title: string;
}

interface CreatedWorkbookFile {
  spreadsheetId: string;
  spreadsheetUrl?: string;
  sheetSetup?: Record<string, unknown>;
}

interface CreatedDocumentFile {
  documentId: string;
  documentUrl: string;
}

function quoteSheetsRangeTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function columnName(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function normalizeSheetValues(values: unknown): SheetCellValue[][] {
  if (!Array.isArray(values)) return [];
  return values.filter(Array.isArray).map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return "";
      if (["string", "number", "boolean"].includes(typeof cell)) return cell as SheetCellValue;
      return JSON.stringify(cell);
    })
  );
}

async function readSheetTable(
  options: ExecuteCliCommandOptions,
  spreadsheetId: string,
  table: keyof typeof SheetsSupplierWorkbookHeaders
): Promise<SheetTableData> {
  const range = `${quoteSheetsRangeTitle(table)}!A1:${columnName(headersForTable(table).length - 1)}`;
  const payload = await runGoogleWriteJson(options, [
    "sheets",
    "spreadsheets",
    "values",
    "get",
    "--params",
    JSON.stringify({ spreadsheetId, range }),
  ]);
  const values = normalizeSheetValues(payload.values);
  const headers = (values[0] ?? []).map((value) => String(value));
  if (headers.length === 0) {
    throw new CliCommandError(`${table} does not have a header row.`);
  }
  return { headers, rows: values.slice(1) };
}

function validateExistingHeaders(
  table: keyof typeof SheetsSupplierWorkbookHeaders,
  headers: string[],
  requiredHeaders: readonly string[] = headersForTable(table)
): void {
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new CliCommandError(`${table} is missing required header(s): ${missing.join(", ")}`);
  }
}

function rowObject(headers: string[], row: SheetCellValue[]): Record<string, SheetCellValue> {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
}

function rowValues(headers: string[], row: Record<string, unknown>): SheetCellValue[] {
  return headers.map((header) => {
    const value = row[header];
    if (value === undefined || value === null) return "";
    if (["string", "number", "boolean"].includes(typeof value)) return value as SheetCellValue;
    return JSON.stringify(value);
  });
}

function tableRowRange(
  table: keyof typeof SheetsSupplierWorkbookHeaders,
  rowNumber: number,
  columnCount: number
): string {
  return `${quoteSheetsRangeTitle(table)}!A${rowNumber}:${columnName(columnCount - 1)}${rowNumber}`;
}

function findRowIndexByKey(tableData: SheetTableData, keyColumn: string, keyValue: string): number {
  const keyColumnIndex = tableData.headers.indexOf(keyColumn);
  if (keyColumnIndex < 0) throw new CliCommandError(`Key column does not exist: ${keyColumn}`);
  return tableData.rows.findIndex((row) => String(row[keyColumnIndex] ?? "") === keyValue);
}

function sheetsCommitBase(
  operation: "upsert" | "append" | "updateStatus" | "createWorkbook",
  spreadsheetId: string,
  mode: Extract<WriteMode, { mode: "execute" }>
) {
  return {
    dryRun: false,
    operation,
    spreadsheetId,
    idempotencyKey: mode.idempotencyKey,
    approvalId: mode.approvalId,
  };
}

function sheetPropertiesFromSpreadsheet(payload: Record<string, unknown>): SheetProperties[] {
  const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
  return sheets.flatMap((sheet): SheetProperties[] => {
    const properties =
      sheet && typeof sheet === "object" && "properties" in sheet
        ? (sheet.properties as unknown)
        : undefined;
    if (!properties || typeof properties !== "object") return [];
    const record = properties as Record<string, unknown>;
    return typeof record.sheetId === "number" && typeof record.title === "string"
      ? [{ sheetId: record.sheetId, title: record.title }]
      : [];
  });
}

async function ensureWorkbookSheets(
  options: ExecuteCliCommandOptions,
  spreadsheetId: string,
  titles: string[]
): Promise<Record<string, unknown> | undefined> {
  const spreadsheet = await runGoogleWriteJson(options, [
    "sheets",
    "spreadsheets",
    "get",
    "--params",
    JSON.stringify({ spreadsheetId, fields: "sheets(properties(sheetId,title))" }),
  ]);
  const existing = sheetPropertiesFromSpreadsheet(spreadsheet);
  const requests: Record<string, unknown>[] = [];
  const claimedTitles = new Set(existing.map((sheet) => sheet.title));
  const firstTitle = titles[0];

  if (
    firstTitle &&
    existing[0] &&
    existing[0].title !== firstTitle &&
    !claimedTitles.has(firstTitle)
  ) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: existing[0].sheetId, title: firstTitle },
        fields: "title",
      },
    });
    claimedTitles.delete(existing[0].title);
    claimedTitles.add(firstTitle);
  }

  for (const title of titles) {
    if (claimedTitles.has(title)) continue;
    requests.push({ addSheet: { properties: { title } } });
    claimedTitles.add(title);
  }

  if (requests.length === 0) return undefined;
  return runGoogleWriteJson(
    options,
    ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId })],
    { requests }
  );
}

function canFallbackFromGoogleNativeFileCreate(error: unknown): boolean {
  return (
    error instanceof GoogleWorkspaceConnectorError &&
    /Google Workspace (needs additional access|denied this request)/i.test(error.message)
  );
}

async function runSheetsRowsUpsert(args: string[], options: ExecuteCliCommandOptions) {
  const usage =
    "Usage: sheets rows.upsert --spreadsheet <id> --table <name> --key-column <column> --key-value <value> --row-json <row> [--dry-run|--execute --approval <id>] --idempotency-key <key>";
  const { flags, mode } = parseWriteArgs(args, usage, [
    "--spreadsheet",
    "--table",
    "--key-column",
    "--key-value",
    "--row-json",
  ]);
  const spreadsheetId = requiredFlag(flags, "--spreadsheet", usage);
  const table = parseTable(requiredFlag(flags, "--table", usage), usage);
  const keyColumn = requiredFlag(flags, "--key-column", usage);
  const keyValue = requiredFlag(flags, "--key-value", usage);
  const row = parseJsonObject(requiredFlag(flags, "--row-json", usage), usage);
  validateRowForTable(table, row, usage);
  if (!headersForTable(table).includes(keyColumn)) {
    throw new CliCommandError(`${usage} (key column is not valid for ${table}: ${keyColumn})`);
  }
  if (mode.mode === "execute") {
    const tableData = await readSheetTable(options, spreadsheetId, table);
    validateExistingHeaders(table, tableData.headers);
    if (!tableData.headers.includes(keyColumn)) {
      throw new CliCommandError(`${usage} (key column is not present in ${table}: ${keyColumn})`);
    }
    const existingIndex = findRowIndexByKey(tableData, keyColumn, keyValue);
    const before =
      existingIndex >= 0 ? rowObject(tableData.headers, tableData.rows[existingIndex] ?? []) : null;
    const after = { ...(before ?? {}), ...row };
    const values = [rowValues(tableData.headers, after)];
    if (existingIndex >= 0) {
      const updatedRange = tableRowRange(table, existingIndex + 2, tableData.headers.length);
      const updates = await runGoogleWriteJson(
        options,
        [
          "sheets",
          "spreadsheets",
          "values",
          "update",
          "--params",
          JSON.stringify({ spreadsheetId, range: updatedRange, valueInputOption: "USER_ENTERED" }),
        ],
        { values }
      );
      return {
        ...sheetsCommitBase("upsert", spreadsheetId, mode),
        table,
        updatedRange,
        updates,
      };
    }
    const appendRange = `${quoteSheetsRangeTitle(table)}!A1`;
    const updates = await runGoogleWriteJson(
      options,
      [
        "sheets",
        "spreadsheets",
        "values",
        "append",
        "--params",
        JSON.stringify({ spreadsheetId, range: appendRange, valueInputOption: "USER_ENTERED" }),
      ],
      { values }
    );
    return {
      ...sheetsCommitBase("upsert", spreadsheetId, mode),
      table,
      updatedRange:
        typeof updates.updates === "object" &&
        updates.updates !== null &&
        "updatedRange" in updates.updates
          ? String((updates.updates as Record<string, unknown>).updatedRange)
          : undefined,
      updates,
    };
  }
  return {
    dryRun: true,
    operation: "upsert",
    preview: {
      action: "upsert",
      spreadsheetId,
      table,
      key: { column: keyColumn, value: keyValue },
      before: null,
      after: row,
      changedCells: changedCellsFromRow(row),
      warnings: [
        "Preview only: current sheet state is re-read by the sidecar before approved execution.",
      ],
    },
    idempotencyKey: mode.idempotencyKey,
  };
}

async function runSheetsRowsAppend(args: string[], options: ExecuteCliCommandOptions) {
  const usage =
    "Usage: sheets rows.append --spreadsheet <id> --table <name> --row-json <row> --client-row-id <id> [--dry-run|--execute --approval <id>] --idempotency-key <key>";
  const { flags, mode } = parseWriteArgs(args, usage, [
    "--spreadsheet",
    "--table",
    "--row-json",
    "--client-row-id",
  ]);
  const spreadsheetId = requiredFlag(flags, "--spreadsheet", usage);
  const table = parseTable(requiredFlag(flags, "--table", usage), usage);
  const clientRowId = requiredFlag(flags, "--client-row-id", usage);
  const row = parseJsonObject(requiredFlag(flags, "--row-json", usage), usage);
  validateRowForTable(table, row, usage, ["tessera_client_row_id"]);
  const after = { ...row, tessera_client_row_id: clientRowId };
  if (mode.mode === "execute") {
    const tableData = await readSheetTable(options, spreadsheetId, table);
    validateExistingHeaders(table, tableData.headers);
    const clientRowIdColumn = tableData.headers.indexOf("tessera_client_row_id");
    if (clientRowIdColumn >= 0) {
      const existingIndex = tableData.rows.findIndex(
        (item) => String(item[clientRowIdColumn] ?? "") === clientRowId
      );
      if (existingIndex >= 0) {
        return {
          ...sheetsCommitBase("append", spreadsheetId, mode),
          table,
          updatedRange: tableRowRange(table, existingIndex + 2, tableData.headers.length),
          updates: { status: "already_exists", clientRowId },
        };
      }
    }
    const appendableRow = clientRowIdColumn >= 0 ? after : row;
    const updates = await runGoogleWriteJson(
      options,
      [
        "sheets",
        "spreadsheets",
        "values",
        "append",
        "--params",
        JSON.stringify({
          spreadsheetId,
          range: `${quoteSheetsRangeTitle(table)}!A1`,
          valueInputOption: "USER_ENTERED",
        }),
      ],
      { values: [rowValues(tableData.headers, appendableRow)] }
    );
    return {
      ...sheetsCommitBase("append", spreadsheetId, mode),
      table,
      updatedRange:
        typeof updates.updates === "object" &&
        updates.updates !== null &&
        "updatedRange" in updates.updates
          ? String((updates.updates as Record<string, unknown>).updatedRange)
          : undefined,
      updates,
    };
  }
  return {
    dryRun: true,
    operation: "append",
    preview: {
      action: "append",
      spreadsheetId,
      table,
      before: null,
      after,
      changedCells: changedCellsFromRow(after),
      warnings: [
        "Append is idempotent by tessera_client_row_id when that header exists; otherwise the single-use approval grant prevents direct replay.",
      ],
    },
    idempotencyKey: mode.idempotencyKey,
  };
}

async function runSheetsRowsUpdateStatus(args: string[], options: ExecuteCliCommandOptions) {
  const usage =
    "Usage: sheets rows.updateStatus --spreadsheet <id> --table <name> --key-column <column> --key-value <value> --status <value> [--dry-run|--execute --approval <id>] --idempotency-key <key>";
  const { flags, mode } = parseWriteArgs(args, usage, [
    "--spreadsheet",
    "--table",
    "--key-column",
    "--key-value",
    "--status",
  ]);
  const spreadsheetId = requiredFlag(flags, "--spreadsheet", usage);
  const table = parseTable(requiredFlag(flags, "--table", usage), usage);
  const keyColumn = requiredFlag(flags, "--key-column", usage);
  const keyValue = requiredFlag(flags, "--key-value", usage);
  const status = requiredFlag(flags, "--status", usage);
  const statusColumn = headersForTable(table).find((header) => /status/i.test(header));
  if (!statusColumn)
    throw new CliCommandError(`${usage} (${table} does not expose a status-like column)`);
  if (!headersForTable(table).includes(keyColumn)) {
    throw new CliCommandError(`${usage} (key column is not valid for ${table}: ${keyColumn})`);
  }
  if (mode.mode === "execute") {
    const tableData = await readSheetTable(options, spreadsheetId, table);
    validateExistingHeaders(table, tableData.headers);
    const existingIndex = findRowIndexByKey(tableData, keyColumn, keyValue);
    if (existingIndex < 0) {
      throw new CliCommandError(`${table} row not found for ${keyColumn}=${keyValue}`);
    }
    const statusColumnIndex = tableData.headers.indexOf(statusColumn);
    if (statusColumnIndex < 0) {
      throw new CliCommandError(`${usage} (status column is not present in ${table})`);
    }
    const rowNumber = existingIndex + 2;
    const updatedRange = `${quoteSheetsRangeTitle(table)}!${columnName(statusColumnIndex)}${rowNumber}:${columnName(statusColumnIndex)}${rowNumber}`;
    const updates = await runGoogleWriteJson(
      options,
      [
        "sheets",
        "spreadsheets",
        "values",
        "update",
        "--params",
        JSON.stringify({ spreadsheetId, range: updatedRange, valueInputOption: "USER_ENTERED" }),
      ],
      { values: [[status]] }
    );
    return {
      ...sheetsCommitBase("updateStatus", spreadsheetId, mode),
      table,
      updatedRange,
      updates,
    };
  }
  return {
    dryRun: true,
    operation: "updateStatus",
    preview: {
      action: "updateStatus",
      spreadsheetId,
      table,
      key: { column: keyColumn, value: keyValue },
      before: null,
      after: { [statusColumn]: status },
      changedCells: [{ column: statusColumn, after: status }],
      warnings: [
        "Only the approved status-like column will be mutated after preview drift checks.",
      ],
    },
    idempotencyKey: mode.idempotencyKey,
  };
}

async function createWorkbookThroughSheets(
  options: ExecuteCliCommandOptions,
  title: string,
  sheets: { table: string; headers: string[] }[]
): Promise<CreatedWorkbookFile> {
  const created = await runGoogleWriteJson(
    options,
    [
      "sheets",
      "spreadsheets",
      "create",
      "--params",
      JSON.stringify({ fields: "spreadsheetId,spreadsheetUrl,sheets(properties(title))" }),
    ],
    {
      properties: { title },
      sheets: sheets.map((sheet) => ({ properties: { title: sheet.table } })),
    }
  );
  const spreadsheetId = typeof created.spreadsheetId === "string" ? created.spreadsheetId : "";
  if (!spreadsheetId) {
    throw new GoogleWorkspaceConnectorError(
      "Google Sheets create response did not include a spreadsheetId."
    );
  }
  return {
    spreadsheetId,
    ...(typeof created.spreadsheetUrl === "string"
      ? { spreadsheetUrl: created.spreadsheetUrl }
      : {}),
  };
}

async function createWorkbookThroughDrive(
  options: ExecuteCliCommandOptions,
  title: string,
  sheets: { table: string; headers: string[] }[]
): Promise<CreatedWorkbookFile> {
  let created: Record<string, unknown>;
  try {
    created = await runGoogleWriteJson(
      options,
      [
        "drive",
        "files",
        "create",
        "--params",
        JSON.stringify({ fields: "id,name,webViewLink,mimeType" }),
      ],
      {
        name: title,
        mimeType: GOOGLE_SHEETS_MIME_TYPE,
      }
    );
  } catch (error) {
    if (canFallbackFromGoogleNativeFileCreate(error)) {
      return createWorkbookThroughSheets(options, title, sheets);
    }
    throw error;
  }
  const spreadsheetId = typeof created.id === "string" ? created.id : "";
  if (!spreadsheetId) {
    throw new GoogleWorkspaceConnectorError(
      "Google Drive create response did not include a spreadsheet id."
    );
  }
  const sheetSetup = await ensureWorkbookSheets(
    options,
    spreadsheetId,
    sheets.map((sheet) => sheet.table)
  );
  return {
    spreadsheetId,
    ...(typeof created.webViewLink === "string" ? { spreadsheetUrl: created.webViewLink } : {}),
    ...(sheetSetup ? { sheetSetup } : {}),
  };
}

async function runSheetsWorkbookCreate(args: string[], options: ExecuteCliCommandOptions) {
  const usage =
    "Usage: sheets workbook.create --title <title> [--dry-run|--execute --approval <id>] --idempotency-key <key>";
  const { flags, mode } = parseWriteArgs(args, usage, ["--title"]);
  const title = requiredFlag(flags, "--title", usage);
  const sheets = Object.entries(SheetsSupplierWorkbookHeaders).map(([table, headers]) => ({
    table,
    headers: [...headers],
  }));
  if (mode.mode === "execute") {
    const { spreadsheetId, spreadsheetUrl, sheetSetup } = await createWorkbookThroughDrive(
      options,
      title,
      sheets
    );
    const data = sheets.map((sheet) => ({
      range: `${quoteSheetsRangeTitle(sheet.table)}!A1:${columnName(sheet.headers.length - 1)}1`,
      values: [sheet.headers],
    }));
    const updates = await runGoogleWriteJson(
      options,
      [
        "sheets",
        "spreadsheets",
        "values",
        "batchUpdate",
        "--params",
        JSON.stringify({ spreadsheetId }),
      ],
      { valueInputOption: "USER_ENTERED", data }
    );
    return {
      dryRun: false,
      operation: "createWorkbook",
      spreadsheetId,
      spreadsheetUrl,
      title,
      sheets,
      headers: Object.fromEntries(sheets.map((sheet) => [sheet.table, sheet.headers])),
      ...(sheetSetup ? { sheetSetup } : {}),
      updates,
      idempotencyKey: mode.idempotencyKey,
      approvalId: mode.approvalId,
    };
  }
  return {
    dryRun: true,
    operation: "createWorkbook",
    title,
    sheets,
    headers: Object.fromEntries(sheets.map((sheet) => [sheet.table, sheet.headers])),
    idempotencyKey: mode.idempotencyKey,
  };
}

function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

async function createDocumentThroughDocs(
  options: ExecuteCliCommandOptions,
  title: string
): Promise<CreatedDocumentFile> {
  const created = await runGoogleWriteJson(options, ["docs", "documents", "create"], { title });
  const documentId = typeof created.documentId === "string" ? created.documentId : "";
  if (!documentId) {
    throw new GoogleWorkspaceConnectorError(
      "Google Docs create response did not include a documentId."
    );
  }
  return {
    documentId,
    documentUrl: documentUrl(documentId),
  };
}

async function createDocumentThroughDrive(
  options: ExecuteCliCommandOptions,
  title: string
): Promise<CreatedDocumentFile> {
  let created: Record<string, unknown>;
  try {
    created = await runGoogleWriteJson(
      options,
      [
        "drive",
        "files",
        "create",
        "--params",
        JSON.stringify({ fields: "id,name,webViewLink,mimeType" }),
      ],
      { name: title, mimeType: GOOGLE_DOCS_MIME_TYPE }
    );
  } catch (error) {
    if (canFallbackFromGoogleNativeFileCreate(error)) {
      return createDocumentThroughDocs(options, title);
    }
    throw error;
  }
  const documentId = typeof created.id === "string" ? created.id : "";
  if (!documentId) {
    throw new GoogleWorkspaceConnectorError(
      "Google Drive create response did not include a document id."
    );
  }
  return {
    documentId,
    documentUrl:
      typeof created.webViewLink === "string" ? created.webViewLink : documentUrl(documentId),
  };
}

function documentEndIndex(payload: Record<string, unknown>): number {
  const body = payload.body;
  const content =
    body && typeof body === "object" && "content" in body
      ? (body as { content?: unknown }).content
      : undefined;
  if (!Array.isArray(content)) return 1;
  const endIndexes = content
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => item.endIndex)
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  const maxEnd = Math.max(1, ...endIndexes);
  return Math.max(1, maxEnd - 1);
}

async function runDocsDocumentsCreate(args: string[], options: ExecuteCliCommandOptions) {
  const usage =
    "Usage: docs documents.create --title <title> [--text <text>|--text-file <path>] [--dry-run|--execute --approval <id>] --idempotency-key <key>";
  const { flags, mode } = parseWriteArgs(args, usage, ["--title", "--text", "--text-file"]);
  const title = requiredFlag(flags, "--title", usage);
  const text = await readInlineOrFileText(flags, usage);
  if (mode.mode === "execute") {
    const { documentId, documentUrl: createdDocumentUrl } = await createDocumentThroughDrive(
      options,
      title
    );
    if (text) {
      await runGoogleWriteJson(
        options,
        ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId })],
        { requests: [{ insertText: { location: { index: 1 }, text } }] }
      );
    }
    return {
      dryRun: false,
      operation: "createDocument",
      title,
      documentId,
      documentUrl: createdDocumentUrl,
      textPreview: text || undefined,
      idempotencyKey: mode.idempotencyKey,
      approvalId: mode.approvalId,
    };
  }
  return {
    dryRun: true,
    operation: "createDocument",
    target: { title },
    preview: {
      text,
      warnings: ["Preview only: document creation requires Action Inbox approval."],
    },
    idempotencyKey: mode.idempotencyKey,
  };
}

async function runDocsDocumentsAppendText(args: string[], options: ExecuteCliCommandOptions) {
  const usage =
    "Usage: docs documents.appendText --document <id> --text <text> [--dry-run|--execute --approval <id>] --idempotency-key <key>";
  const { flags, mode } = parseWriteArgs(args, usage, ["--document", "--text"]);
  const documentId = requiredFlag(flags, "--document", usage);
  const text = requiredFlag(flags, "--text", usage);
  if (mode.mode === "execute") {
    const document = await runGoogleWriteJson(options, [
      "docs",
      "documents",
      "get",
      "--params",
      JSON.stringify({ documentId, fields: "body/content(endIndex),revisionId" }),
    ]);
    const update = await runGoogleWriteJson(
      options,
      ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId })],
      {
        requests: [{ insertText: { location: { index: documentEndIndex(document) }, text } }],
      }
    );
    return buildDocsCommit("appendText", documentId, mode, update);
  }
  return {
    dryRun: true,
    operation: "appendText",
    target: { documentId },
    preview: {
      text,
      warnings: ["Preview only: current document end position is re-read before execution."],
    },
    idempotencyKey: mode.idempotencyKey,
  };
}

async function runDocsDocumentsReplacePlaceholders(
  args: string[],
  options: ExecuteCliCommandOptions
) {
  const usage =
    "Usage: docs documents.replacePlaceholders --document <id> --replacements-json <json> [--dry-run|--execute --approval <id>] --idempotency-key <key>";
  const { flags, mode } = parseWriteArgs(args, usage, ["--document", "--replacements-json"]);
  const documentId = requiredFlag(flags, "--document", usage);
  const replacements = parseStringRecord(requiredFlag(flags, "--replacements-json", usage), usage);
  if (mode.mode === "execute") {
    const requests = Object.entries(replacements).map(([containsText, replaceText]) => ({
      replaceAllText: {
        containsText: { text: containsText, matchCase: true },
        replaceText,
      },
    }));
    const update = await runGoogleWriteJson(
      options,
      ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId })],
      { requests }
    );
    return buildDocsCommit("replacePlaceholders", documentId, mode, update);
  }
  return {
    dryRun: true,
    operation: "replacePlaceholders",
    target: { documentId },
    preview: {
      replacements,
      warnings: ["Only explicit placeholder tokens are eligible for replacement."],
    },
    idempotencyKey: mode.idempotencyKey,
  };
}

function buildDocsCommit(
  operation: "appendText" | "replacePlaceholders",
  documentId: string,
  mode: Extract<WriteMode, { mode: "execute" }>,
  update: Record<string, unknown> = {}
) {
  return {
    dryRun: false,
    operation,
    documentId,
    documentUrl: documentUrl(documentId),
    revisionId:
      typeof update.writeControl === "object" &&
      update.writeControl !== null &&
      "requiredRevisionId" in update.writeControl
        ? String((update.writeControl as Record<string, unknown>).requiredRevisionId)
        : undefined,
    idempotencyKey: mode.idempotencyKey,
    approvalId: mode.approvalId,
  };
}

function parseStringRecord(value: string, usage: string): Record<string, string> {
  const parsed = parseJsonObject(value, usage);
  const invalid = Object.entries(parsed).find(([, item]) => typeof item !== "string");
  if (invalid)
    throw new CliCommandError(`${usage} (replacement for ${invalid[0]} must be a string)`);
  return parsed as Record<string, string>;
}

async function readInlineOrFileText(
  flags: Map<string, string>,
  usage: string
): Promise<string | undefined> {
  const text = flags.get("--text");
  const textFile = flags.get("--text-file");
  if (text && textFile)
    throw new CliCommandError(`${usage} (use only one of --text or --text-file)`);
  if (textFile) {
    try {
      return await readFile(textFile, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliCommandError(`${usage} (could not read --text-file: ${reason})`);
    }
  }
  return text;
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
      limit = Math.min(parsed, 25);
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
      limit = Math.min(parsed, 25);
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

const MAIL_DRAFT_USAGE =
  "Usage: mail draft --to <address> --subject <subject> --body <body> [--cc <cc>] [--bcc <bcc>]";

function parseMailDraftArgs(args: string[]): {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
} {
  let to = "";
  let cc: string | undefined;
  let bcc: string | undefined;
  let subject = "";
  let body = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      throw new CliCommandError(MAIL_DRAFT_USAGE);
    }
    if (arg === "--to") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError(MAIL_DRAFT_USAGE);
      }
      validateHeaderValue(value);
      to = value;
      index += 1;
      continue;
    }
    if (arg === "--cc") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError(MAIL_DRAFT_USAGE);
      }
      validateHeaderValue(value);
      cc = value;
      index += 1;
      continue;
    }
    if (arg === "--bcc") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError(MAIL_DRAFT_USAGE);
      }
      validateHeaderValue(value);
      bcc = value;
      index += 1;
      continue;
    }
    if (arg === "--subject") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError(MAIL_DRAFT_USAGE);
      }
      validateHeaderValue(value);
      subject = value;
      index += 1;
      continue;
    }
    if (arg === "--body") {
      const value = args[index + 1];
      if (value === undefined || value === "") {
        throw new CliCommandError(MAIL_DRAFT_USAGE);
      }
      body = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliCommandError(MAIL_DRAFT_USAGE);
    }
    throw new CliCommandError(MAIL_DRAFT_USAGE);
  }

  if (!to || !subject || !body) {
    throw new CliCommandError(MAIL_DRAFT_USAGE);
  }

  return {
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    subject,
    body,
  };
}

function parseMailSendDraftArgs(args: string[]): { draftId: string } {
  const draftId = args[0]?.trim();
  if (!draftId || args.length !== 1) {
    throw new CliCommandError("Usage: mail send-draft <draftId>");
  }
  return { draftId };
}

function buildMailDraftRaw(request: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
  const lines = [
    `To: ${request.to}`,
    ...(request.cc ? [`Cc: ${request.cc}`] : []),
    ...(request.bcc ? [`Bcc: ${request.bcc}`] : []),
    `Subject: ${request.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset="UTF-8"`,
    "Content-Transfer-Encoding: 8bit",
    "",
    request.body.replace(/\r?\n/g, "\r\n"),
  ];
  const source = `${lines.join("\r\n")}\r\n`;
  return Buffer.from(source, "utf8").toString("base64url");
}

function validateHeaderValue(value: string) {
  if (/\r|\n/.test(value)) {
    throw new CliCommandError("mail headers cannot contain line breaks");
  }
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
  sheet?: string;
  range?: string;
} {
  const fileId = args[0]?.trim();
  if (!fileId) {
    throw new CliCommandError("Usage: drive read <fileId> [--format text|markdown|csv|json]");
  }

  let format: "text" | "markdown" | "csv" | "json" = "text";
  let sheet = "";
  let range = "";
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
    if (arg === "--sheet") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new CliCommandError(
          "Usage: drive read <fileId> [--format text|markdown|csv|json] [--sheet <name>] [--range <A1:B2>]"
        );
      }
      sheet = value;
      index += 1;
      continue;
    }
    if (arg === "--range") {
      const value = args[index + 1]?.trim();
      if (!value || !/^[A-Z]+[1-9][0-9]*:[A-Z]+[1-9][0-9]*$/.test(value)) {
        throw new CliCommandError(
          "Usage: drive read <fileId> [--format text|markdown|csv|json] [--sheet <name>] [--range <A1:B2>]"
        );
      }
      range = value;
      index += 1;
      continue;
    }
    throw new CliCommandError(
      "Usage: drive read <fileId> [--format text|markdown|csv|json] [--sheet <name>] [--range <A1:B2>]"
    );
  }

  if ((sheet && !range) || (!sheet && range)) {
    throw new CliCommandError(
      "Usage: drive read <fileId> [--format text|markdown|csv|json] [--sheet <name>] [--range <A1:B2>]"
    );
  }

  return { fileId, format, ...(sheet ? { sheet } : {}), ...(range ? { range } : {}) };
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
