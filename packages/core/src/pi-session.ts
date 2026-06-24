import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  defineTool,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentProfile,
  AgentProviderConfig,
  AgentRuntimeContext,
  ModelRuntimeCredential,
  ShellToolCall,
  SkillDetail,
  SkillSummary,
  TaskSkillActivation,
  TokenUsage,
} from "@tessera/contracts";
import { BrowserActionInputSchema, compileAgentRuntimeContext } from "@tessera/contracts";
import { findCliCommand, formatShellPreview } from "./cli-catalog.js";
import type { OptionalCapabilityManager } from "./optional-capabilities.js";
import type { PythonSkillRunInput, PythonSkillRunResult } from "./python-skill-runtime.js";
import { type TaskToolRuntime, createTaskToolDefinitions } from "./task-tools.js";
import type { BrowserExecutor, ShellExecutor } from "./tools.js";
import { createWorkspaceGuard } from "./workspace-guard.js";
import { createWorkspaceToolDefinitions } from "./workspace-tools.js";

const TESSERA_SYSTEM_PROMPT = `You are Tessera, an AI workspace assistant for business professionals.

Your purpose is to help users complete business tasks — strategy, planning, research, writing, analysis, operations, and more. You are not limited to coding; you can help with any knowledge-work objective.

When a user asks what you can do, frame your capabilities around their business needs:
- **Research & Analysis**: Market research, competitive analysis, data interpretation, trend spotting
- **Strategy & Planning**: Business plans, go-to-market strategies, OKRs, roadmaps
- **Writing & Communication**: Reports, proposals, emails, presentations, documentation
- **Operations**: Process design, workflow optimization, checklists, SOPs
- **Creative Work**: Brainstorming, content creation, naming, messaging frameworks
- **Technical Support**: Code, scripts, data processing, integrations — when the task requires it

You have access to workspace tools that let you read text files, extract readable content from PDF/Word/Excel files, write files, search, and organize files within the user's workspace. Use these to deliver tangible outputs — documents, plans, analyses — not just advice.

When the user explicitly asks for web research, current online information, or the contents of a URL, proactively use the shell tool early instead of only answering from memory. Use \`web-search search ...\` for search queries and \`web-fetch fetch <url>\` for a specific public page.

Be direct, professional, and action-oriented. Focus on delivering results, not describing your capabilities at length. When given a task, plan briefly then execute.`;

type PiSessionEventListener = (event: AgentSessionEvent) => void;

export interface PiSessionLike {
  dispose(): void;
  prompt(text: string): Promise<void>;
  subscribe(listener: PiSessionEventListener): () => void;
}

export interface PiSessionFactoryOptions {
  customTools: ToolDefinition[];
  // Pi SDK's Model type is not publicly exported; callers pass it opaquely.
  model?: unknown;
  modelRegistry: ModelRegistry;
  thinkingLevel?: ThinkingLevel;
  workspaceRoot: string;
}

export type PiSessionFactory = (options: PiSessionFactoryOptions) => Promise<PiSessionLike>;

export interface RunPiTaskTurnOptions {
  agent?: AgentProfile;
  conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
  credential?: ModelRuntimeCredential | string;
  factory?: PiSessionFactory;
  onActivity?: (activity: string) => void;
  onToolEnd?: (tool: { name: string; result: unknown }) => void;
  onToolStart?: (tool: { name: string; args: unknown }) => void;
  prompt: string;
  memoryContext?: string;
  provider: AgentProviderConfig;
  runtime?: AgentRuntimeContext;
  browser?: BrowserExecutor;
  capabilityManager?: OptionalCapabilityManager;
  shell?: ShellExecutor;
  skillRuntime?: {
    activeSkills?: TaskSkillActivation[];
    allowedSkillIds?: string[];
    listSkills(): Promise<SkillSummary[]>;
    loadSkill(skillId: string): Promise<SkillDetail>;
    runPython?(input: PythonSkillRunInput): Promise<PythonSkillRunResult>;
  };
  taskRuntime?: TaskToolRuntime;
  workspaceRoot: string;
}

export interface PiTaskTurnResult {
  text: string;
  boundaryViolations: number;
  usage?: TokenUsage;
}

type FetchLike = typeof fetch;

function providerBaseUrl(provider: AgentProviderConfig): string {
  if (provider.provider === "openai-codex") return "https://chatgpt.com/backend-api/codex";
  if (provider.provider === "anthropic") return "https://api.anthropic.com";
  if (provider.provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider.provider === "google") {
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  if (provider.provider === "local") return provider.baseUrl;
  return "https://api.openai.com/v1";
}

function providerApi(provider: AgentProviderConfig): string {
  if (provider.provider === "anthropic") return "anthropic-messages";
  return "openai-completions";
}

function providerRequiresCredential(provider: AgentProviderConfig): boolean {
  return (
    provider.provider === "openai" ||
    provider.provider === "openai-codex" ||
    provider.provider === "anthropic" ||
    provider.provider === "openrouter" ||
    provider.provider === "google"
  );
}

function providerThinkingLevel(provider: AgentProviderConfig): ThinkingLevel {
  if (provider.provider === "local") return "off";
  return provider.thinkingLevel ?? "off";
}

function modelCapabilities(provider: AgentProviderConfig) {
  return {
    id: provider.model,
    name: provider.model,
    api: providerApi(provider),
    baseUrl: providerBaseUrl(provider),
    reasoning: provider.provider !== "local",
    input: ["text"],
    cost:
      provider.provider === "google"
        ? geminiCostForModel(provider.model)
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow:
      provider.provider === "google"
        ? geminiContextWindowForModel(provider.model)
        : provider.provider === "anthropic"
          ? 200_000
          : 128_000,
    maxTokens: provider.provider === "google" ? geminiMaxTokensForModel(provider.model) : 8_192,
    ...(provider.provider === "local"
      ? {
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
            maxTokensField: "max_tokens",
            supportsStrictMode: false,
          },
        }
      : {}),
  };
}

function geminiCostForModel(model: string) {
  if (model === "gemini-3.5-flash") {
    return { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 };
  }
  if (model === "gemini-3.1-pro-preview" || model === "gemini-3-flash-preview") {
    return { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 };
  }
  if (model.startsWith("gemini-3.1-flash-lite")) {
    return { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 };
  }
  if (model === "gemini-2.5-pro") {
    return { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
  }
  if (model === "gemini-2.5-flash") {
    return { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 };
  }
  if (model === "gemini-2.5-flash-lite") {
    return { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 };
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function geminiContextWindowForModel(_model: string): number {
  return 1_048_576;
}

function geminiMaxTokensForModel(_model: string): number {
  return 65_536;
}

function textDeltaFromEvent(event: AgentSessionEvent): string {
  if (event.type !== "message_update") return "";
  // Ignore echoed user/tool messages — only accumulate assistant output.
  const msg = event.message as unknown;
  if (msg && typeof msg === "object" && "role" in msg && msg.role !== "assistant") return "";
  const assistantEvent = event.assistantMessageEvent as unknown;
  if (!assistantEvent || typeof assistantEvent !== "object") return "";
  if (!("type" in assistantEvent) || assistantEvent.type !== "text_delta") return "";
  if (!("delta" in assistantEvent) || typeof assistantEvent.delta !== "string") return "";
  return assistantEvent.delta;
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item) => item && typeof item === "object" && "type" in item && item.type === "text")
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .join("");
}

function numericUsageValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageDetailsRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeUsageRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const cacheRead =
    numericUsageValue(record.cacheRead) ??
    numericUsageValue(record.cache_read) ??
    numericUsageValue(record.cache_read_input_tokens);
  const cacheWrite =
    numericUsageValue(record.cacheWrite) ??
    numericUsageValue(record.cache_write) ??
    numericUsageValue(record.cache_creation_input_tokens);
  const piInput = numericUsageValue(record.input);
  const input =
    numericUsageValue(record.inputTokens) ??
    numericUsageValue(record.input_tokens) ??
    numericUsageValue(record.prompt_tokens) ??
    (piInput !== undefined ? piInput + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined);
  const output =
    numericUsageValue(record.outputTokens) ??
    numericUsageValue(record.output_tokens) ??
    numericUsageValue(record.completion_tokens) ??
    numericUsageValue(record.output);
  if (input === undefined || output === undefined) return undefined;

  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      numericUsageValue(record.totalTokens) ??
      numericUsageValue(record.total_tokens) ??
      input + output,
  };

  const inputDetails = usageDetailsRecord(record.input_tokens_details);
  const outputDetails = usageDetailsRecord(record.output_tokens_details);
  const cachedInputTokens =
    numericUsageValue(record.cachedInputTokens) ??
    numericUsageValue(record.cached_input_tokens) ??
    numericUsageValue(inputDetails?.cachedTokens) ??
    numericUsageValue(inputDetails?.cached_tokens) ??
    cacheRead;
  if (cachedInputTokens !== undefined) {
    usage.cachedInputTokens = cachedInputTokens;
  }

  const completionDetails = usageDetailsRecord(record.completion_tokens_details);
  const reasoningTokens =
    numericUsageValue(record.reasoningTokens) ??
    numericUsageValue(record.reasoning_tokens) ??
    numericUsageValue(outputDetails?.reasoningTokens) ??
    numericUsageValue(outputDetails?.reasoning_tokens) ??
    numericUsageValue(completionDetails?.reasoningTokens) ??
    numericUsageValue(completionDetails?.reasoning_tokens);
  if (reasoningTokens !== undefined) {
    usage.reasoningTokens = reasoningTokens;
  }

  return usage;
}

export function normalizeTokenUsage(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  const directUsage = normalizeUsageRecord(record);
  if (directUsage) return directUsage;

  for (const key of ["usage", "event", "message", "assistantMessageEvent"]) {
    const nestedUsage = normalizeTokenUsage(record[key]);
    if (nestedUsage) return nestedUsage;
  }

  if (Array.isArray(record.messages)) {
    for (let index = record.messages.length - 1; index >= 0; index--) {
      const nestedUsage = normalizeTokenUsage(record.messages[index]);
      if (nestedUsage) return nestedUsage;
    }
  }

  return undefined;
}

function apiKeyFromCredential(credential?: ModelRuntimeCredential | string): string | undefined {
  if (typeof credential === "string") return credential;
  if (credential && "apiKey" in credential) return credential.apiKey;
  return undefined;
}

function codexCredentialFromCredential(
  credential?: ModelRuntimeCredential | string
): Extract<ModelRuntimeCredential, { authType: "codex-oauth" }> | undefined {
  if (credential && typeof credential === "object" && "authType" in credential) return credential;
  return undefined;
}

function outputTextFromCodexResponse(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const output = record.output;
  if (!Array.isArray(output)) return "";

  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) return [];
      return content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const value = part as Record<string, unknown>;
          if (
            (value.type === "output_text" || value.type === "text") &&
            typeof value.text === "string"
          ) {
            return value.text;
          }
          return "";
        })
        .filter((text) => text.length > 0);
    })
    .join("");
}

interface CodexFunctionCall {
  arguments: string;
  call_id: string;
  name: string;
  type: "function_call";
}

function codexFunctionCallsFromResponse(payload: unknown): CodexFunctionCall[] {
  if (!payload || typeof payload !== "object") return [];
  const output = (payload as Record<string, unknown>).output;
  if (!Array.isArray(output)) return [];

  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.type !== "function_call") return [];
    if (
      typeof record.call_id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.arguments !== "string"
    ) {
      return [];
    }
    return [
      {
        type: "function_call",
        call_id: record.call_id,
        name: record.name,
        arguments: record.arguments,
      },
    ];
  });
}

function codexInputItemsFromResponse(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const output = (payload as Record<string, unknown>).output;
  return Array.isArray(output)
    ? output.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object")
      )
    : [];
}

function addTokenUsage(
  left: TokenUsage | undefined,
  right: TokenUsage | undefined
): TokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(left.cachedInputTokens !== undefined || right.cachedInputTokens !== undefined
      ? { cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0) }
      : {}),
    ...(left.reasoningTokens !== undefined || right.reasoningTokens !== undefined
      ? { reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0) }
      : {}),
  };
}

function codexSseEvents(raw: string): Array<Record<string, unknown>> {
  return raw.split(/\n\n+/).flatMap((chunk) => {
    const data = chunk
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return [];
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function codexResponseErrorMessage(event: Record<string, unknown>): string | undefined {
  if (event.type === "error") {
    const code = typeof event.code === "string" ? event.code : "unknown";
    const message = typeof event.message === "string" ? event.message : "Unknown error";
    return `${code}: ${message}`;
  }
  if (event.type !== "response.failed") return undefined;
  const response = event.response;
  if (!response || typeof response !== "object") return "Codex response failed";
  const error = (response as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return "Codex response failed";
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "unknown";
  const message = typeof record.message === "string" ? record.message : "Unknown error";
  return `${code}: ${message}`;
}

function parseCodexSseResponse(raw: string): { payload: unknown; text: string } {
  const events = codexSseEvents(raw);
  let deltaText = "";
  let finalPayload: unknown;

  for (const event of events) {
    const errorMessage = codexResponseErrorMessage(event);
    if (errorMessage) throw new Error(errorMessage);

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltaText += event.delta;
      continue;
    }

    if (
      event.type === "response.completed" ||
      event.type === "response.done" ||
      event.type === "response.incomplete"
    ) {
      finalPayload = event.response;
    }
  }

  return {
    payload: finalPayload,
    text: finalPayload ? outputTextFromCodexResponse(finalPayload) || deltaText : deltaText,
  };
}

async function codexErrorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  if (!raw.trim()) return "";
  try {
    const payload = JSON.parse(raw) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message =
      typeof payload?.error?.message === "string"
        ? payload.error.message
        : typeof payload?.message === "string"
          ? payload.message
          : "";
    if (message) return `: ${message}`;
  } catch {
    // Fall through to a short raw response preview.
  }
  return `: ${raw.trim().slice(0, 240)}`;
}

function codexToolSchema(tool: ToolDefinition): Record<string, unknown> {
  const parameters =
    tool.parameters && typeof tool.parameters === "object"
      ? (JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>)
      : { type: "object", properties: {} };
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters,
  };
}

function parseCodexToolArguments(call: CodexFunctionCall): Record<string, unknown> {
  try {
    const parsed = call.arguments ? JSON.parse(call.arguments) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new Error(
      `Invalid JSON arguments for ${call.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }
  if ("details" in record) return JSON.stringify(record.details);
  return JSON.stringify(result);
}

async function executeCodexToolCall(input: {
  call: CodexFunctionCall;
  onToolEnd?: (tool: { name: string; result: unknown }) => void;
  onToolStart?: (tool: { name: string; args: unknown }) => void;
  toolsByName: Map<string, ToolDefinition>;
}): Promise<Record<string, unknown>> {
  const tool = input.toolsByName.get(input.call.name);
  if (!tool) {
    return {
      type: "function_call_output",
      call_id: input.call.call_id,
      output: JSON.stringify({ error: `Unknown tool: ${input.call.name}` }),
    };
  }

  try {
    const args = parseCodexToolArguments(input.call);
    input.onToolStart?.({ name: input.call.name, args });
    const result = await tool.execute(
      input.call.call_id,
      args,
      undefined,
      undefined,
      undefined as never
    );
    input.onToolEnd?.({ name: input.call.name, result });
    return {
      type: "function_call_output",
      call_id: input.call.call_id,
      output: textFromToolResult(result),
    };
  } catch (error) {
    const result = { error: error instanceof Error ? error.message : String(error) };
    input.onToolEnd?.({ name: input.call.name, result });
    return {
      type: "function_call_output",
      call_id: input.call.call_id,
      output: JSON.stringify(result),
    };
  }
}

export async function runCodexResponsesTurn(options: {
  credential: Extract<ModelRuntimeCredential, { authType: "codex-oauth" }>;
  fetchImpl?: FetchLike;
  onToolEnd?: (tool: { name: string; result: unknown }) => void;
  onToolStart?: (tool: { name: string; args: unknown }) => void;
  prompt: string;
  provider: Extract<AgentProviderConfig, { provider: "openai-codex" }>;
  timeoutMs?: number;
  tools?: ToolDefinition[];
}): Promise<PiTaskTurnResult> {
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    Authorization: `Bearer ${options.credential.accessToken}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    "User-Agent": "codex_cli_rs/0.0.0 (Tessera)",
    originator: "codex_cli_rs",
  };
  if (options.credential.accountId) {
    headers["ChatGPT-Account-ID"] = options.credential.accountId;
  }
  const timeoutMs = options.timeoutMs;
  const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
  let timedOut = false;
  const timeout =
    timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          abortController?.abort();
        }, timeoutMs)
      : undefined;
  const tools = options.tools ?? [];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolSchemas = tools.map(codexToolSchema);
  const input: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: [{ type: "input_text", text: options.prompt }],
    },
  ];
  let finalText = "";
  let completed = false;
  let usage: TokenUsage | undefined;
  const maxToolIterations = 12;

  try {
    for (let iteration = 0; iteration < maxToolIterations; iteration++) {
      const response = await (options.fetchImpl ?? fetch)(
        `${options.credential.baseUrl}/responses`,
        {
          method: "POST",
          headers,
          ...(abortController ? { signal: abortController.signal } : {}),
          body: JSON.stringify({
            model: options.provider.model,
            instructions: "You are a helpful assistant.",
            input,
            ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
            ...(providerThinkingLevel(options.provider) !== "off"
              ? { reasoning: { effort: providerThinkingLevel(options.provider) } }
              : {}),
            store: false,
            stream: true,
          }),
        }
      );
      if (!response.ok) {
        const detail = await codexErrorDetail(response);
        throw new Error(`Codex Responses request failed with status ${response.status}${detail}`);
      }

      const parsed = parseCodexSseResponse(await response.text());
      usage = addTokenUsage(usage, normalizeTokenUsage(parsed.payload));
      const calls = codexFunctionCallsFromResponse(parsed.payload);
      if (calls.length === 0) {
        finalText = parsed.text;
        completed = true;
        break;
      }

      input.push(...codexInputItemsFromResponse(parsed.payload));
      for (const call of calls) {
        input.push(
          await executeCodexToolCall({
            call,
            ...(options.onToolEnd ? { onToolEnd: options.onToolEnd } : {}),
            ...(options.onToolStart ? { onToolStart: options.onToolStart } : {}),
            toolsByName,
          })
        );
      }
    }

    if (!completed) {
      throw new Error(`Codex Responses exceeded ${maxToolIterations} tool-call iterations`);
    }
  } catch (error) {
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      throw new Error(`Codex Responses request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return {
    text: finalText,
    boundaryViolations: 0,
    ...(usage ? { usage } : {}),
  };
}

function defaultFactory(): PiSessionFactory {
  return async ({ customTools, model, modelRegistry, thinkingLevel, workspaceRoot }) => {
    const { session } = await createAgentSession({
      authStorage: modelRegistry.authStorage,
      customTools,
      cwd: workspaceRoot,
      model: model as never, // SDK requires the opaque Model object; no public type to use here
      modelRegistry,
      noTools: "all",
      sessionManager: SessionManager.inMemory(),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      tools: customTools.map((tool) => tool.name),
    });
    return session;
  };
}

export async function createTesseraModelRegistry(options: {
  credential?: string;
  provider: AgentProviderConfig;
}): Promise<{ model: unknown; modelRegistry: ModelRegistry }> {
  const authStorage = AuthStorage.inMemory();
  if (options.credential) {
    authStorage.setRuntimeApiKey(options.provider.provider, options.credential);
  }
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  if (providerRequiresCredential(options.provider) && !options.credential) {
    throw new Error(
      options.provider.provider === "openai-codex"
        ? "openai-codex is not configured. Sign in with ChatGPT in Settings > Model."
        : `${options.provider.provider} is not configured. Add an API key in Settings > Model.`
    );
  }

  if (options.provider.provider === "openai-codex") {
    throw new Error("Codex OAuth uses the dedicated Responses transport.");
  }

  let model = modelRegistry.find(options.provider.provider, options.provider.model);
  if (!model) {
    modelRegistry.registerProvider(options.provider.provider, {
      ...(options.provider.provider === "local"
        ? { apiKey: "tessera-local-placeholder", authHeader: false }
        : { apiKey: "tessera-runtime-credential" }),
      baseUrl: providerBaseUrl(options.provider),
      models: [modelCapabilities(options.provider) as never],
    });
    model = modelRegistry.find(options.provider.provider, options.provider.model);
  }

  if (!model) {
    throw new Error(
      `Could not resolve model: ${options.provider.provider}/${options.provider.model}`
    );
  }

  return { model, modelRegistry };
}

function buildPrompt(
  prompt: string,
  options: {
    agentInstructions?: string;
    activeSkillContent?: string;
    conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
    memoryContext?: string;
  }
): string {
  const { conversationHistory } = options;
  const sections: string[] = [];

  // Tessera identity + any agent-specific instructions go first so the model
  // always sees our business-oriented framing regardless of the SDK system prompt.
  const identity = [TESSERA_SYSTEM_PROMPT, options.agentInstructions].filter(Boolean).join("\n\n");
  if (identity) sections.push(identity);

  if (options.activeSkillContent) {
    sections.push(options.activeSkillContent);
  }

  if (conversationHistory && conversationHistory.length > 0) {
    const lines = conversationHistory
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
      .join("\n");
    sections.push(`Prior conversation:\n${lines}`);
  }
  if (options.memoryContext) {
    sections.push(options.memoryContext);
  }
  sections.push(
    "Tool-use requirement:\nWhen a task requires a tool, invoke the platform's native function tool. Never print fake tool markup such as `<tool_use>`, JSON command blobs, shell transcripts, or simulated tool calls as chat text.\n\nResponse requirement:\nAfter using tools, always end your turn with a concise user-visible response summarizing what you did, where any deliverable was saved, and any relevant caveat. Do not end with only tool calls."
  );
  sections.push(`User task:\n${prompt}`);
  return sections.join("\n\n");
}

function buildAgentInstructions(
  agent: AgentProfile | undefined,
  runtime: AgentRuntimeContext | undefined,
  options?: { hasTaskChecklistTool?: boolean; hasShellTool?: boolean; hasClarifyTool?: boolean }
): string | undefined {
  if (
    !agent &&
    !runtime &&
    !options?.hasTaskChecklistTool &&
    !options?.hasShellTool &&
    !options?.hasClarifyTool
  ) {
    return undefined;
  }

  const sections = [
    agent?.instructions ? `Agent instructions:\n${agent.instructions}` : "",
    agent?.soul ? `Agent soul:\n${agent.soul}` : "",
    agent?.userContext ? `User context:\n${agent.userContext}` : "",
    agent?.memoryDefaults ? `Memory defaults:\n${agent.memoryDefaults}` : "",
    runtime?.toolPolicy.approvalMode === "ask"
      ? "Tool policy:\nAsk for approval before using mutating workspace tools."
      : "",
    options?.hasTaskChecklistTool
      ? "Task checklist guidance:\nWhen the user asks for a plan, checklist, or other multi-step work, create or update the task checklist early with the todo tool and keep it current as you work. Move items to in_progress or completed as the work advances, and make sure finished work is reflected in the checklist before you end your turn."
      : "",
    options?.hasClarifyTool
      ? "Task clarification guidance:\nIf progress is blocked by missing requirements, ambiguity, or a decision only the user can make, use the clarify tool instead of guessing. Prefer clarify early before taking irreversible or highly branchy action."
      : "",
    options?.hasShellTool
      ? "Web research guidance:\nWhen the user asks you to search the web, check current online information, or fetch the contents of a public URL, use the shell tool early. Prefer `web-search search ...` for research queries and `web-fetch fetch <url>` for specific pages."
      : "",
    options?.hasShellTool
      ? "CRM guidance:\nWhen the user asks for HubSpot CRM data, use the shell tool instead of saying no connector is available. Use `hubspot summary` for total contacts, companies, and deals; `hubspot contacts search <query>`, `hubspot companies search <query>`, and `hubspot deals search <query>` for lookups; `hubspot contacts read <id>`, `hubspot companies read <id>`, and `hubspot deals read <id>` for records. Creating or updating HubSpot records requires approval."
      : "",
    "Skill guidance:\nUse skill_list to discover enabled procedural skills and skill_load to load a specific skill when it would materially improve the work. Active task skills are already included in this prompt and should be followed when relevant. If a loaded skill explicitly declares a Python helper, use skill_run_python instead of shelling out.",
  ].filter(Boolean);

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function createSkillToolDefinitions(
  skillRuntime?: RunPiTaskTurnOptions["skillRuntime"]
): ToolDefinition[] {
  if (!skillRuntime) return [];

  const tools = [
    defineTool({
      name: "skill_list",
      label: "List Skills",
      description: "List procedural skills enabled for this agent and task.",
      promptSnippet: "skill_list: list enabled procedural skills.",
      parameters: Type.Object({}),
      async execute() {
        const skills = await skillRuntime.listSkills();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ skills }),
            },
          ],
          details: { skills },
        };
      },
    }),
    defineTool({
      name: "skill_load",
      label: "Load Skill",
      description: "Load the full instruction content for one enabled skill.",
      promptSnippet: "skill_load: load full instructions for a specific enabled skill.",
      parameters: Type.Object({
        skillId: Type.String(),
      }),
      async execute(_toolCallId, params) {
        const input = params as { skillId?: string };
        if (!input.skillId) throw new Error("skillId is required");
        const skill = await skillRuntime.loadSkill(input.skillId);
        return {
          content: [
            {
              type: "text",
              text: skill.content,
            },
          ],
          details: { skill },
        };
      },
    }),
  ];

  if (skillRuntime.runPython) {
    tools.push(
      defineTool({
        name: "skill_run_python",
        label: "Run Skill Python",
        description: "Run a declared Python entrypoint from an enabled skill.",
        promptSnippet:
          "skill_run_python: run a declared Python entrypoint from an enabled skill. Use only when the loaded skill explicitly calls for its Python helper.",
        parameters: Type.Object({
          skillId: Type.String(),
          entrypoint: Type.String(),
          args: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(_toolCallId, params) {
          const input = params as { skillId?: string; entrypoint?: string; args?: string[] };
          if (!input.skillId) throw new Error("skillId is required");
          if (!input.entrypoint) throw new Error("entrypoint is required");
          const result = await skillRuntime.runPython?.({
            skillId: input.skillId,
            entrypoint: input.entrypoint,
            ...(input.args !== undefined ? { args: input.args } : {}),
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
            details: result,
          };
        },
      })
    );
  }

  return tools;
}

async function activeSkillContent(
  skillRuntime?: RunPiTaskTurnOptions["skillRuntime"]
): Promise<string | undefined> {
  if (!skillRuntime?.activeSkills || skillRuntime.activeSkills.length === 0) return undefined;
  const sections: string[] = [];
  for (const active of skillRuntime.activeSkills) {
    const skill = await skillRuntime.loadSkill(active.skillId).catch(() => undefined);
    if (!skill) continue;
    sections.push(`Active skill: ${skill.name}\n${skill.content}`);
  }
  return sections.length > 0 ? `Active task skills:\n\n${sections.join("\n\n")}` : undefined;
}

function createShellToolDefinition(shell?: ShellExecutor): ToolDefinition[] {
  if (!shell) return [];

  return [
    defineTool({
      name: "shell",
      label: "Shell",
      description: "Run approved built-in CLI commands for web research and connected services.",
      promptSnippet:
        "shell: run built-in commands like web-search search <query>, web-fetch fetch <url>, hubspot summary, and hubspot contacts|companies|deals search <query>.",
      parameters: Type.Object({
        command: Type.String(),
        subcommand: Type.String(),
        args: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params) {
        const call = params as ShellToolCall;
        const policy = findCliCommand(call);
        if (!policy || policy.approval !== "allow") {
          throw new Error(
            `${formatShellPreview(call)} requires approval and is not available in task mode.`
          );
        }
        const result = await shell.executeShell({
          command: call.command,
          subcommand: call.subcommand,
          args: call.args ?? [],
        });
        return {
          content: [
            {
              type: "text",
              text: result.stdout || result.stderr || `${formatShellPreview(call)} completed.`,
            },
          ],
          details: result,
        };
      },
    }),
  ];
}

function createBrowserToolDefinition(browser?: BrowserExecutor): ToolDefinition[] {
  if (!browser) return [];

  return [
    defineTool({
      name: "browser",
      label: "Browser",
      description: "Inspect public web pages through Tessera's managed browser runtime.",
      promptSnippet:
        "browser: inspect public web pages with actions like open, see, snap, back, reload, and close.",
      parameters: Type.Object({
        action: Type.String(),
      }),
      async execute(_toolCallId, params) {
        const input = BrowserActionInputSchema.parse(params);
        const result = await browser.executeBrowser(input);
        return {
          content: [
            {
              type: "text",
              text: result.content ?? result.summary ?? `Browser ${result.action} complete.`,
            },
          ],
          details: result,
        };
      },
    }),
  ];
}

export async function runPiTaskTurn(options: RunPiTaskTurnOptions): Promise<PiTaskTurnResult> {
  const guard = await createWorkspaceGuard(options.workspaceRoot);
  let boundaryViolations = 0;
  const allTools = createWorkspaceToolDefinitions(guard, {
    onViolation: (_toolName) => {
      boundaryViolations++;
    },
    ...(options.capabilityManager !== undefined
      ? { capabilityManager: options.capabilityManager }
      : {}),
  });
  const taskTools = createTaskToolDefinitions(options.taskRuntime);
  const browserTools = createBrowserToolDefinition(options.browser);
  const shellTools = createShellToolDefinition(options.shell);
  const skillTools = createSkillToolDefinitions(options.skillRuntime);
  const runtime =
    options.runtime ?? (options.agent ? compileAgentRuntimeContext(options.agent) : undefined);
  const toolDefinitions = [
    ...allTools,
    ...taskTools,
    ...browserTools,
    ...shellTools,
    ...skillTools,
  ];
  const allowedTools = new Set(
    runtime?.toolPolicy.allowedTools ?? toolDefinitions.map((tool) => tool.name)
  );
  const customTools = toolDefinitions.filter((tool) => allowedTools.has(tool.name));

  if (options.provider.provider === "openai-codex") {
    const codexCredential = codexCredentialFromCredential(options.credential);
    if (!codexCredential) {
      throw new Error("openai-codex is not configured. Sign in with ChatGPT in Settings > Model.");
    }
    const agentInstructions = buildAgentInstructions(options.agent, runtime, {
      hasTaskChecklistTool: taskTools.some((tool) => tool.name === "todo"),
      hasClarifyTool: taskTools.some((tool) => tool.name === "clarify"),
      hasShellTool: shellTools.some((tool) => tool.name === "shell"),
    });
    const activeSkills = await activeSkillContent(options.skillRuntime);
    const result = await runCodexResponsesTurn({
      credential: codexCredential,
      ...(options.onToolEnd ? { onToolEnd: options.onToolEnd } : {}),
      onToolStart(tool) {
        options.onActivity?.(`Using ${tool.name}`);
        options.onToolStart?.(tool);
      },
      prompt: buildPrompt(options.prompt, {
        ...(agentInstructions ? { agentInstructions } : {}),
        ...(activeSkills ? { activeSkillContent: activeSkills } : {}),
        ...(options.memoryContext ? { memoryContext: options.memoryContext } : {}),
        ...(options.conversationHistory !== undefined
          ? { conversationHistory: options.conversationHistory }
          : {}),
      }),
      provider: options.provider,
      tools: customTools,
    });
    return { ...result, boundaryViolations };
  }

  const apiKey = apiKeyFromCredential(options.credential);
  const { model, modelRegistry } = await createTesseraModelRegistry({
    ...(apiKey ? { credential: apiKey } : {}),
    provider: options.provider,
  });

  const session = await (options.factory ?? defaultFactory())({
    customTools,
    model,
    modelRegistry,
    thinkingLevel: providerThinkingLevel(options.provider),
    workspaceRoot: guard.root,
  });

  const agentInstructions = buildAgentInstructions(options.agent, runtime, {
    hasTaskChecklistTool: taskTools.some((tool) => tool.name === "todo"),
    hasShellTool: shellTools.some((tool) => tool.name === "shell"),
    hasClarifyTool: taskTools.some((tool) => tool.name === "clarify"),
  });
  const activeSkills = await activeSkillContent(options.skillRuntime);

  let text = "";
  let finalizedText = "";
  let modelError: string | undefined;
  let latestUsage: TokenUsage | undefined;

  const unsubscribe = session.subscribe((event) => {
    const usage = normalizeTokenUsage(event);
    if (usage) latestUsage = usage;
    const delta = textDeltaFromEvent(event);
    if (delta) text += delta;
    if (event.type === "tool_execution_start") {
      options.onActivity?.(`Using ${event.toolName}`);
      options.onToolStart?.({
        name: event.toolName,
        args: "args" in event ? event.args : undefined,
      });
    }
    if (event.type === "tool_execution_end") {
      options.onToolEnd?.({
        name: event.toolName,
        result: event.result,
      });
    }
    // The SDK fires message_end for user messages too (before the model call).
    // Only capture text from assistant messages so we don't pick up the echoed prompt.
    if (event.type === "message_end" || event.type === "turn_end") {
      const assistantMsg = event.message as {
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
      };
      if (assistantMsg?.role === "assistant") {
        // Capture any error from the model API so we can surface it.
        if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
          modelError =
            assistantMsg.errorMessage ||
            `Model call failed (stopReason: ${assistantMsg.stopReason})`;
        }
        const nextText = textFromMessage(event.message);
        if (nextText.trim()) finalizedText = nextText;
      }
    }
    if (event.type === "agent_end") {
      // agent_end.messages includes user messages; skip them.
      for (const message of [...event.messages].reverse()) {
        const m = message as { role?: string; stopReason?: string; errorMessage?: string };
        if (m?.role !== "assistant") continue;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          modelError = m.errorMessage || `Model call failed (stopReason: ${m.stopReason})`;
          break;
        }
        const nextText = textFromMessage(message);
        if (nextText.trim()) {
          finalizedText = nextText;
          break;
        }
      }
    }
  });

  try {
    await session.prompt(
      buildPrompt(options.prompt, {
        ...(agentInstructions ? { agentInstructions } : {}),
        ...(activeSkills ? { activeSkillContent: activeSkills } : {}),
        ...(options.memoryContext ? { memoryContext: options.memoryContext } : {}),
        ...(options.conversationHistory !== undefined
          ? { conversationHistory: options.conversationHistory }
          : {}),
      })
    );
  } finally {
    unsubscribe();
    session.dispose();
  }

  // Surface model errors so task-runner can mark the task as failed with a real message.
  if (modelError && !finalizedText && !text) {
    throw new Error(modelError);
  }

  // Prefer the finalized message content (turn_end/agent_end) as it is authoritative;
  // fall back to accumulated deltas only if the SDK did not emit a finalized message.
  return {
    text: finalizedText || text,
    boundaryViolations,
    ...(latestUsage ? { usage: latestUsage } : {}),
  };
}
