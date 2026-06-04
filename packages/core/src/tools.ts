import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type TSchema, Type } from "@mariozechner/pi-ai";
import type {
  AgentToolResultSummary,
  BrowserActionInput,
  BrowserToolResult,
  ClarifyRequest,
  ClarifyResponse,
  NotifyRequest,
  PermissionDecision,
  PermissionGrant,
  ShellToolCall,
  ShellToolResult,
  SpawnResult,
  TodoOperation,
  ToolCapability,
  ToolRisk,
} from "@tessera/contracts";
import { z } from "zod";
import { formatShellPreview } from "./cli-catalog.js";
import { evaluatePermission } from "./permission.js";
import { validateShellCall } from "./shell-runtime.js";

export interface WorkspaceCliExecutor {
  runWorkspaceCli(
    args: string[],
    timeoutMs?: number,
    envOverrides?: Record<string, string>
  ): Promise<SpawnResult>;
}

export interface ShellExecutor {
  executeShell(call: ShellToolCall): Promise<ShellToolResult>;
}

export interface BrowserExecutor {
  executeBrowser(input: BrowserActionInput): Promise<BrowserToolResult>;
}

export interface TaskToolRuntime {
  applyTodo(operation: TodoOperation): Promise<{ summary: string; todo?: unknown }>;
  requestClarify(request: ClarifyRequest): Promise<ClarifyResponse>;
  sendNotification(request: NotifyRequest): Promise<void>;
}

export interface ToolRegistryOptions {
  browser?: BrowserExecutor;
  cli: WorkspaceCliExecutor;
  grants?: PermissionGrant[];
  onPermissionDecision?: (decision: PermissionDecision) => void;
  shell?: ShellExecutor;
  taskRuntime?: TaskToolRuntime;
}

interface TesseraToolDefinition<TArgs extends Record<string, unknown>, TResult = unknown> {
  id: string;
  agentName: string;
  label: string;
  description: string;
  capability: ToolCapability;
  risk: ToolRisk;
  parameters: TSchema;
  argsSchema: z.ZodType<TArgs>;
  preview: (args: TArgs) => string;
  execute: (args: TArgs) => Promise<AgentToolResult<TResult>>;
}

function textFromContent(content: Array<{ type: string; text?: string }> | undefined): string {
  return (
    content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n") ?? ""
  );
}

export function toolNameToId(name: string): string {
  if (name === "workspace_ping") return "workspace.ping";
  if (name === "workspace_write_probe") return "workspace.writeProbe";
  return name.replace(/_/g, ".");
}

export function summarizeToolResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  isError: boolean
): AgentToolResultSummary {
  const toolId = toolNameToId(toolName);
  const text = textFromContent(result.content as Array<{ type: string; text?: string }>) || toolId;

  if (isError) {
    return { toolId, status: "error", text, details: result.details };
  }

  return {
    toolId,
    status: result.terminate ? "blocked" : "success",
    text,
    details: result.details,
  };
}

function blockedToolResult(toolId: string, decision: PermissionDecision): AgentToolResult<unknown> {
  const message =
    decision.decision === "deny"
      ? `${toolId} was denied by policy.`
      : `${toolId} is waiting for approval.`;
  return {
    content: [{ type: "text", text: message }],
    details: decision,
    terminate: true,
  };
}

function createAgentTool<TArgs extends Record<string, unknown>, TResult>(
  definition: TesseraToolDefinition<TArgs, TResult>,
  options: ToolRegistryOptions
): AgentTool<TSchema, unknown> {
  return {
    name: definition.agentName,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_toolCallId: string, rawArgs: unknown) {
      const args = definition.argsSchema.parse(rawArgs);
      const decision = evaluatePermission(
        {
          toolId: definition.id,
          args,
          capability: definition.capability,
          risk: definition.risk,
          preview: definition.preview(args),
        },
        options.grants
      );
      options.onPermissionDecision?.(decision);
      if (decision.decision !== "allow") {
        return blockedToolResult(definition.id, decision);
      }
      return definition.execute(args);
    },
  };
}

function missingRuntimeResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: { configured: false },
  };
}

export function createTesseraTools(options: ToolRegistryOptions): AgentTool<TSchema, unknown>[] {
  const shellArgsSchema = z.object({
    command: z.enum([
      "web-search",
      "web-fetch",
      "gcal",
      "mail",
      "drive",
      "sheets",
      "docs",
      "contacts",
      "hubspot",
    ]),
    subcommand: z.string().min(1),
    args: z.array(z.string()).default([]),
  });
  const browserArgsSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("open"), url: z.string().min(1) }),
    z.object({
      action: z.literal("snap"),
      pageId: z.string().min(1).optional(),
      fullPage: z.boolean().default(false),
    }),
    z.object({
      action: z.literal("see"),
      pageId: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
    }),
    z.object({
      action: z.literal("click"),
      pageId: z.string().min(1).optional(),
      selector: z.string().min(1),
    }),
    z.object({
      action: z.literal("type"),
      pageId: z.string().min(1).optional(),
      selector: z.string().min(1),
      text: z.string(),
      submit: z.boolean().default(false),
    }),
    z.object({
      action: z.literal("select"),
      pageId: z.string().min(1).optional(),
      selector: z.string().min(1),
      value: z.string().min(1),
    }),
    z.object({ action: z.literal("back"), pageId: z.string().min(1).optional() }),
    z.object({ action: z.literal("reload"), pageId: z.string().min(1).optional() }),
    z.object({
      action: z.literal("eval"),
      pageId: z.string().min(1).optional(),
      expression: z.string().min(1),
    }),
    z.object({ action: z.literal("close"), pageId: z.string().min(1).optional() }),
  ]);
  const todoArgsSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("create"),
      items: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          status: z.enum(["pending", "in_progress", "completed"]),
          note: z.string().optional(),
          order: z.number().int().nonnegative(),
        })
      ),
    }),
    z.object({
      type: z.literal("replace"),
      items: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          status: z.enum(["pending", "in_progress", "completed"]),
          note: z.string().optional(),
          order: z.number().int().nonnegative(),
        })
      ),
    }),
    z.object({
      type: z.literal("set_status"),
      itemId: z.string().min(1),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
    z.object({
      type: z.literal("append"),
      item: z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed"]),
        note: z.string().optional(),
        order: z.number().int().nonnegative(),
      }),
    }),
    z.object({ type: z.literal("remove"), itemId: z.string().min(1) }),
  ]);
  const clarifyArgsSchema = z.object({
    promptId: z.string().min(1),
    taskId: z.string().min(1),
    message: z.string().min(1),
    detail: z.string().optional(),
    allowFreeform: z.boolean().default(true),
    options: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional(),
        })
      )
      .default([]),
    createdAt: z.string().datetime(),
  });
  const notifyArgsSchema = z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    actionLabel: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  });

  return [
    createAgentTool(
      {
        id: "workspace.ping",
        agentName: "workspace_ping",
        label: "Workspace Ping",
        description: "Run the workspace CLI health check.",
        capability: "read",
        risk: {
          mutates: false,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: true,
        },
        parameters: Type.Object({
          message: Type.String(),
        }),
        argsSchema: z.object({
          message: z.string().min(1),
        }),
        preview: (args) => `ping ${args.message}`,
        async execute(args) {
          const result = await options.cli.runWorkspaceCli(["ping", args.message]);
          return {
            content: [{ type: "text", text: `Pinged workspace: ${args.message}` }],
            details: result,
          };
        },
      },
      options
    ),
    createAgentTool(
      {
        id: "workspace.writeProbe",
        agentName: "workspace_write_probe",
        label: "Workspace Write Probe",
        description: "Dry-run write probe used by workflow approval steps.",
        capability: "write",
        risk: {
          mutates: true,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: true,
        },
        parameters: Type.Object({
          target: Type.String(),
          value: Type.String(),
        }),
        argsSchema: z.object({
          target: z.string().min(1),
          value: z.string().min(1),
        }),
        preview: (args) => `write-probe target=${args.target} value=${args.value}`,
        async execute(args) {
          return {
            content: [{ type: "text", text: `Write probe ready for ${args.target}.` }],
            details: {
              target: args.target,
              value: args.value,
              mutated: false,
            },
          };
        },
      },
      options
    ),
    createAgentTool(
      {
        id: "shell",
        agentName: "shell",
        label: "Shell",
        description: "Run approved built-in CLI commands.",
        capability: "write",
        risk: {
          mutates: true,
          destructive: false,
          external: true,
          reversible: true,
          dryRunSupported: true,
        },
        parameters: Type.Object({
          command: Type.String(),
          subcommand: Type.String(),
          args: Type.Optional(Type.Array(Type.String())),
        }),
        argsSchema: shellArgsSchema,
        preview: (args) => formatShellPreview(args),
        async execute(args) {
          validateShellCall(args);
          if (!options.shell) {
            return missingRuntimeResult("Shell runtime is not configured.");
          }
          const result = await options.shell.executeShell(args);
          return {
            content: [
              {
                type: "text",
                text:
                  result.stdout || result.stderr || `${result.command} exited ${result.exitCode}`,
              },
            ],
            details: result,
          };
        },
      },
      options
    ),
    createAgentTool(
      {
        id: "browser",
        agentName: "browser",
        label: "Browser",
        description: "Drive a browser through structured actions.",
        capability: "write",
        risk: {
          mutates: true,
          destructive: false,
          external: true,
          reversible: true,
          dryRunSupported: false,
        },
        parameters: Type.Object({
          action: Type.String(),
        }),
        argsSchema: browserArgsSchema,
        preview: (args) => `browser ${args.action}`,
        async execute(args) {
          if (!options.browser) {
            return missingRuntimeResult("Browser runtime is not configured.");
          }
          const result = await options.browser.executeBrowser(args);
          return {
            content: [
              { type: "text", text: result.summary ?? `Browser ${result.action} complete.` },
            ],
            details: result,
          };
        },
      },
      options
    ),
    createAgentTool(
      {
        id: "todo",
        agentName: "todo",
        label: "Todo",
        description: "Manage the current task checklist.",
        capability: "write",
        risk: {
          mutates: true,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: false,
        },
        parameters: Type.Object({ type: Type.String() }),
        argsSchema: todoArgsSchema,
        preview: (args) => `todo ${args.type}`,
        async execute(args) {
          if (!options.taskRuntime) {
            return missingRuntimeResult("Todo runtime is not configured.");
          }
          const result = await options.taskRuntime.applyTodo(args);
          return {
            content: [{ type: "text", text: result.summary }],
            details: result.todo,
          };
        },
      },
      options
    ),
    createAgentTool(
      {
        id: "clarify",
        agentName: "clarify",
        label: "Clarify",
        description: "Ask the user a blocking clarification question.",
        capability: "write",
        risk: {
          mutates: false,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: false,
        },
        parameters: Type.Object({
          promptId: Type.String(),
          taskId: Type.String(),
          message: Type.String(),
        }),
        argsSchema: clarifyArgsSchema,
        preview: () => "clarify",
        async execute(args) {
          if (!options.taskRuntime) {
            return missingRuntimeResult("Clarify runtime is not configured.");
          }
          const response = await options.taskRuntime.requestClarify(args);
          return {
            content: [
              {
                type: "text",
                text: response.cancelled
                  ? "Clarify request was cancelled."
                  : (response.selectedOptionId ??
                    response.freeform ??
                    "Clarify response received."),
              },
            ],
            details: response,
          };
        },
      },
      options
    ),
    createAgentTool(
      {
        id: "notify",
        agentName: "notify",
        label: "Notify",
        description: "Send a desktop notification.",
        capability: "write",
        risk: {
          mutates: false,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: false,
        },
        parameters: Type.Object({
          title: Type.String(),
          body: Type.String(),
        }),
        argsSchema: notifyArgsSchema,
        preview: (args) => `notify ${args.title}`,
        async execute(args) {
          if (!options.taskRuntime) {
            return missingRuntimeResult("Notify runtime is not configured.");
          }
          await options.taskRuntime.sendNotification(args);
          return {
            content: [{ type: "text", text: `Notification sent: ${args.title}` }],
            details: args,
          };
        },
      },
      options
    ),
  ];
}
