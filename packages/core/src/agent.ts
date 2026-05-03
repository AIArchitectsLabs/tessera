import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  AgentMessageSummary,
  AgentToolResultSummary,
  AgentTurnRequest,
  AgentTurnResult,
  PermissionDecision,
} from "@tessera/contracts";
import { createAgentModel, resolveApiKey } from "./model.js";
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

export interface ExecuteAgentTurnOptions {
  cli: WorkspaceCliExecutor;
  request: AgentTurnRequest;
}

export async function executeAgentTurn(options: ExecuteAgentTurnOptions): Promise<AgentTurnResult> {
  const { request, cli } = options;
  const model = createAgentModel(request.provider);
  const apiKey = resolveApiKey(request.provider, request.credential?.apiKey);
  const permissionDecisions: PermissionDecision[] = [];
  const toolResults: AgentToolResultSummary[] = [];
  let messages: AgentMessageSummary[] = [];
  let error: string | undefined;

  if (
    (request.provider.provider === "openai" ||
      request.provider.provider === "anthropic" ||
      request.provider.provider === "openrouter") &&
    !apiKey
  ) {
    return {
      status: "error",
      messages,
      toolResults,
      permissionDecisions,
      error: `${request.provider.provider} is not configured. Add an API key in Settings > Model.`,
    };
  }

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
    ...(error ? { error } : {}),
  };
}
