import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type TSchema, Type } from "@mariozechner/pi-ai";
import type {
  AgentToolResultSummary,
  PermissionDecision,
  PermissionGrant,
  SpawnResult,
  ToolCapability,
  ToolRisk,
} from "@tessera/contracts";
import { z } from "zod";
import { evaluatePermission } from "./permission.js";

export interface WorkspaceCliExecutor {
  runWorkspaceCli(args: string[], timeoutMs?: number): Promise<SpawnResult>;
}

export interface ToolRegistryOptions {
  cli: WorkspaceCliExecutor;
  grants?: PermissionGrant[];
  onPermissionDecision?: (decision: PermissionDecision) => void;
}

interface TesseraToolDefinition<TArgs extends Record<string, unknown>> {
  id: string;
  agentName: string;
  label: string;
  description: string;
  capability: ToolCapability;
  risk: ToolRisk;
  parameters: TSchema;
  argsSchema: z.ZodType<TArgs>;
  preview: (args: TArgs) => string;
  execute: (args: TArgs) => Promise<AgentToolResult<unknown>>;
}

export function toolNameToId(name: string): string {
  if (name === "workspace_ping") return "workspace.ping";
  if (name === "workspace_write_probe") return "workspace.writeProbe";
  return name;
}

export function summarizeToolResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  isError: boolean
): AgentToolResultSummary {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const details = result.details;
  const decision =
    details && typeof details === "object" && "permissionDecision" in details
      ? (details.permissionDecision as PermissionDecision)
      : undefined;

  return {
    toolId: toolNameToId(toolName),
    status: decision?.decision === "ask" ? "blocked" : isError ? "error" : "success",
    text,
    details,
  };
}

function blockedToolResult(decision: PermissionDecision): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text:
          decision.decision === "ask"
            ? `Permission required before running ${decision.toolId}.`
            : `Permission denied for ${decision.toolId}: ${decision.reason}.`,
      },
    ],
    details: { permissionDecision: decision },
    terminate: true,
  };
}

function createAgentTool<TArgs extends Record<string, unknown>>(
  definition: TesseraToolDefinition<TArgs>,
  options: ToolRegistryOptions
): AgentTool<TSchema, unknown> {
  return {
    name: definition.agentName,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_toolCallId, params) {
      const args = definition.argsSchema.parse(params);
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
        return blockedToolResult(decision);
      }

      return definition.execute(args);
    },
  };
}

export function createTesseraTools(options: ToolRegistryOptions): AgentTool<TSchema, unknown>[] {
  const pingArgsSchema = z.object({
    message: z.string().optional(),
  });

  const writeProbeArgsSchema = z.object({
    target: z.string().min(1),
    value: z.string().min(1),
  });

  return [
    createAgentTool(
      {
        id: "workspace.ping",
        agentName: "workspace_ping",
        label: "Workspace ping",
        description: "Run the workspace CLI ping command. This is a read-only health check.",
        capability: "read",
        risk: {
          mutates: false,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: true,
        },
        parameters: Type.Object({
          message: Type.Optional(Type.String()),
        }),
        argsSchema: pingArgsSchema,
        preview: (args) => `workspace-cli ping${args.message ? ` ${args.message}` : ""}`,
        async execute(args) {
          const cliArgs = args.message ? ["ping", args.message] : ["ping"];
          const result = await options.cli.runWorkspaceCli(cliArgs);

          return {
            content: [
              {
                type: "text",
                text: result.stdout || result.stderr || `workspace-cli exited ${result.exitCode}`,
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
        id: "workspace.writeProbe",
        agentName: "workspace_write_probe",
        label: "Workspace write probe",
        description: "Probe the write permission path without mutating project or external data.",
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
        argsSchema: writeProbeArgsSchema,
        preview: (args) => `write-probe target=${args.target} value=${args.value}`,
        async execute(args) {
          return {
            content: [
              {
                type: "text",
                text: `Write probe accepted for ${args.target}. No mutation was performed.`,
              },
            ],
            details: { target: args.target, value: args.value, mutated: false },
            terminate: true,
          };
        },
      },
      options
    ),
  ];
}
