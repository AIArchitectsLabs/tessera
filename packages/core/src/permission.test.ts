import { describe, expect, test } from "bun:test";
import type { PermissionGrant } from "@tessera/contracts";
import { type PermissionRequest, evaluatePermission } from "./permission.js";

const baseRequest: PermissionRequest = {
  toolId: "workspace.writeProbe",
  args: { target: "lead", value: "qualified" },
  capability: "write",
  risk: {
    mutates: true,
    destructive: false,
    external: false,
    reversible: true,
    dryRunSupported: true,
  },
  preview: "write-probe target=lead value=qualified",
};

describe("evaluatePermission", () => {
  test("allows read tools by default", () => {
    const decision = evaluatePermission({
      ...baseRequest,
      toolId: "workspace.ping",
      args: {},
      capability: "read",
      risk: {
        mutates: false,
        destructive: false,
        external: false,
        reversible: true,
        dryRunSupported: true,
      },
      preview: "workspace-cli ping",
    });

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("read_tool_allowed");
  });

  test("asks for ungranted writes", () => {
    const decision = evaluatePermission(baseRequest);

    expect(decision.decision).toBe("ask");
    expect(decision.toolId).toBe("workspace.writeProbe");
    if (decision.decision === "ask") {
      expect(decision.approval.reasonCode).toBe("write_requires_approval");
      expect(decision.approval.args).toEqual(baseRequest.args);
    }
  });

  test("allows tool-level grants", () => {
    const grants: PermissionGrant[] = [{ type: "tool", toolId: "workspace.writeProbe" }];

    const decision = evaluatePermission(baseRequest, grants);

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("write_tool_granted");
  });

  test("allows exact grants independent of object key order", () => {
    const grants: PermissionGrant[] = [
      {
        type: "exact",
        toolId: "workspace.writeProbe",
        args: { value: "qualified", target: "lead" },
      },
    ];

    const decision = evaluatePermission(baseRequest, grants);

    expect(decision.decision).toBe("allow");
  });

  test("denies destructive tools before grant checks", () => {
    const decision = evaluatePermission(
      {
        ...baseRequest,
        risk: {
          ...baseRequest.risk,
          destructive: true,
        },
      },
      [{ type: "tool", toolId: "workspace.writeProbe" }]
    );

    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("destructive_tool_denied");
  });
});
