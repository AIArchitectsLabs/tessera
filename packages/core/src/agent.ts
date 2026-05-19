import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  AgentMessageSummary,
  AgentToolResultSummary,
  AgentTurnRequest,
  AgentTurnResult,
  ModelRuntimeCredential,
  PermissionDecision,
  TokenUsage,
} from "@tessera/contracts";
import { createAgentModel, resolveApiKey } from "./model.js";
import { normalizeTokenUsage, runCodexResponsesTurn } from "./pi-session.js";
import { createSpawnShellExecutor } from "./shell-runtime.js";
import { type WorkspaceCliExecutor, createTesseraTools, summarizeToolResult } from "./tools.js";

function summarizeMessage(message: unknown): AgentMessageSummary {
  if (!message || typeof message !== "object" || !("role" in message)) {
    return { role: "unknown" };
  }

  const role = String(message.role);
  if (!("content" in message)) return { role };

  const { content } = message;
  if (typeof content === "string") return { role, text: content };
  if (!Array.isArray(content)) return { role };

  const text = content
    .filter((item) => item && typeof item === "object" && "type" in item && item.type === "text")
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .filter((item) => item.length > 0)
    .join("\n");

  return text ? { role, text } : { role };
}

function statusFrom(
  toolResults: AgentToolResultSummary[],
  decisions: PermissionDecision[],
  error?: string
): AgentTurnResult["status"] {
  if (error) return "error";
  if (decisions.some((decision) => decision.decision === "deny")) return "denied";
  if (decisions.some((decision) => decision.decision === "ask")) return "blocked";
  if (toolResults.some((result) => result.status === "error")) return "error";
  return "completed";
}

function apiKeyFromCredential(credential?: ModelRuntimeCredential): string | undefined {
  if (credential && "apiKey" in credential) return credential.apiKey;
  return undefined;
}

function codexCredentialFromCredential(
  credential?: ModelRuntimeCredential
): Extract<ModelRuntimeCredential, { authType: "codex-oauth" }> | undefined {
  if (credential && "authType" in credential) return credential;
  return undefined;
}

export interface ExecuteAgentTurnOptions {
  cli: WorkspaceCliExecutor;
  request: AgentTurnRequest;
}

export async function executeAgentTurn(options: ExecuteAgentTurnOptions): Promise<AgentTurnResult> {
  const { request, cli } = options;
  const apiKey = resolveApiKey(request.provider, apiKeyFromCredential(request.credential));
  const permissionDecisions: PermissionDecision[] = [];
  const toolResults: AgentToolResultSummary[] = [];
  let messages: AgentMessageSummary[] = [];
  let usage: TokenUsage | undefined;
  let error: string | undefined;

  if (
    (request.provider.provider === "openai" ||
      request.provider.provider === "anthropic" ||
      request.provider.provider === "openrouter" ||
      request.provider.provider === "openai-codex") &&
    !apiKey &&
    !codexCredentialFromCredential(request.credential)
  ) {
    return {
      status: "error",
      messages,
      toolResults,
      permissionDecisions,
      error:
        request.provider.provider === "openai-codex"
          ? "openai-codex is not configured. Sign in with ChatGPT in Settings > Model."
          : `${request.provider.provider} is not configured. Add an API key in Settings > Model.`,
    };
  }

  if (request.provider.provider === "openai-codex") {
    const credential = codexCredentialFromCredential(request.credential);
    if (!credential) {
      return {
        status: "error",
        messages,
        toolResults,
        permissionDecisions,
        error: "openai-codex is not configured. Sign in with ChatGPT in Settings > Model.",
      };
    }
    try {
      const result = await runCodexResponsesTurn({
        credential,
        prompt: request.prompt,
        provider: request.provider,
        timeoutMs: request.timeoutMs,
      });
      return {
        status: "completed",
        messages: [{ role: "assistant", text: result.text }],
        toolResults,
        permissionDecisions,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        status: "error",
        messages,
        toolResults,
        permissionDecisions,
        error: message,
      };
    }
  }

  const model = createAgentModel(request.provider);

  const agent = new Agent({
    initialState: {
      systemPrompt:
        "You are Tessera's headless cognitive engine. Use tools only when they directly help the request. When the user explicitly asks you to search the web, look something up online, research current information, or fetch a URL, prefer the shell tool early. Use `web-search search ...` for web research queries and `web-fetch fetch <url>` when the user wants the contents of a specific public page.",
      model,
      tools: createTesseraTools({
        cli,
        grants: request.grants,
        onPermissionDecision(decision) {
          permissionDecisions.push(decision);
        },
        shell: createSpawnShellExecutor(cli),
      }),
      thinkingLevel: "off",
    },
    getApiKey(provider) {
      if (provider !== model.provider) return undefined;
      return apiKey;
    },
    toolExecution: "sequential",
  });

  agent.subscribe((event: AgentEvent) => {
    const eventUsage = normalizeTokenUsage(event);
    if (eventUsage) usage = eventUsage;

    if (event.type === "tool_execution_end") {
      toolResults.push(summarizeToolResult(event.toolName, event.result, event.isError));
    }

    if (event.type === "agent_end") {
      messages = event.messages.map((message) => summarizeMessage(message));
    }
  });

  const timer = setTimeout(() => agent.abort(), request.timeoutMs);
  try {
    await agent.prompt(request.prompt);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
  }

  return {
    status: statusFrom(toolResults, permissionDecisions, error),
    messages,
    toolResults,
    permissionDecisions,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  };
}
