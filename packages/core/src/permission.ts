import type {
  PermissionDecision,
  PermissionGrant,
  ToolCapability,
  ToolRisk,
} from "@tessera/contracts";

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

  if (request.capability === "read") {
    return {
      decision: "allow",
      toolId: request.toolId,
      reason: "read_tool_allowed",
    };
  }

  if (hasToolGrant(grants, request) || hasExactGrant(grants, request)) {
    return {
      decision: "allow",
      toolId: request.toolId,
      reason: "write_tool_granted",
    };
  }

  return {
    decision: "ask",
    toolId: request.toolId,
    reason: "write_requires_approval",
    approval: {
      toolId: request.toolId,
      args: request.args,
      capability: request.capability,
      risk: request.risk,
      preview: request.preview,
      reasonCode: "write_requires_approval",
    },
  };
}
