import type {
  PermissionDecision,
  PermissionGrant,
  ShellToolCall,
  ToolCapability,
  ToolRisk,
} from "@tessera/contracts";
import { findCliCommand } from "./cli-catalog.js";

export interface PermissionRequest {
  toolId: string;
  args: Record<string, unknown>;
  capability: ToolCapability;
  risk: ToolRisk;
  preview: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hasToolGrant(grants: PermissionGrant[], request: PermissionRequest): boolean {
  return grants.some((grant) => grant.type === "tool" && grant.toolId === request.toolId);
}

function hasExactGrant(grants: PermissionGrant[], request: PermissionRequest): boolean {
  const requestArgs = stableStringify(request.args);
  return grants.some(
    (grant) =>
      grant.type === "exact" &&
      grant.toolId === request.toolId &&
      stableStringify(grant.args) === requestArgs
  );
}

function allow(toolId: string, reason: string): PermissionDecision {
  return { decision: "allow", toolId, reason };
}

function ask(request: PermissionRequest, reason: string): PermissionDecision {
  return {
    decision: "ask",
    toolId: request.toolId,
    reason,
    approval: {
      toolId: request.toolId,
      args: request.args,
      capability: request.capability,
      risk: request.risk,
      preview: request.preview,
      reasonCode: reason,
    },
  };
}

function shellDecision(
  request: PermissionRequest,
  grants: PermissionGrant[]
): PermissionDecision | undefined {
  if (request.toolId !== "shell") return undefined;
  const policy = findCliCommand(request.args as ShellToolCall);
  if (!policy) {
    return {
      decision: "deny",
      toolId: request.toolId,
      reason: "shell_command_denied",
    };
  }
  if (policy.approval === "allow") {
    return allow(request.toolId, "shell_command_allowed");
  }
  if (hasToolGrant(grants, request) || hasExactGrant(grants, request)) {
    return allow(request.toolId, "shell_command_granted");
  }
  return ask(request, "shell_command_requires_approval");
}

function browserDecision(
  request: PermissionRequest,
  grants: PermissionGrant[]
): PermissionDecision | undefined {
  if (request.toolId !== "browser") return undefined;
  const action = typeof request.args.action === "string" ? request.args.action : "";
  if (["open", "snap", "see", "back", "reload", "close"].includes(action)) {
    return allow(request.toolId, "browser_action_allowed");
  }
  if (action === "eval") {
    return ask(request, "browser_eval_requires_approval");
  }
  if (["click", "type", "select"].includes(action)) {
    if (hasToolGrant(grants, request) || hasExactGrant(grants, request)) {
      return allow(request.toolId, "browser_action_granted");
    }
    return ask(request, "browser_action_requires_approval");
  }
  return {
    decision: "deny",
    toolId: request.toolId,
    reason: "browser_action_denied",
  };
}

export function evaluatePermission(
  request: PermissionRequest,
  grants: PermissionGrant[] = []
): PermissionDecision {
  if (request.risk.destructive) {
    return {
      decision: "deny",
      toolId: request.toolId,
      reason: "destructive_tool_denied",
    };
  }

  if (request.toolId === "todo" || request.toolId === "clarify" || request.toolId === "notify") {
    return allow(request.toolId, `${request.toolId}_tool_allowed`);
  }

  const shell = shellDecision(request, grants);
  if (shell) return shell;

  const browser = browserDecision(request, grants);
  if (browser) return browser;

  if (request.capability === "read") {
    return allow(request.toolId, "read_tool_allowed");
  }

  if (hasToolGrant(grants, request) || hasExactGrant(grants, request)) {
    return allow(request.toolId, "write_tool_granted");
  }

  return ask(request, "write_requires_approval");
}
