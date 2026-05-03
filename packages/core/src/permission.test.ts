import { describe, expect, test } from "bun:test";
import type { PermissionGrant } from "@tessera/contracts";
import { type PermissionRequest, evaluatePermission } from "./permission.js";

const writableRisk = {
  mutates: true,
  destructive: false,
  external: true,
  reversible: true,
  dryRunSupported: false,
} as const;

describe("evaluatePermission", () => {
  test("allows browser read-only actions by default", () => {
    const decision = evaluatePermission({
      toolId: "browser",
      args: { action: "open", url: "https://example.com" },
      capability: "write",
      risk: writableRisk,
      preview: "browser open",
    });

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("browser_action_allowed");
  });

  test("asks for browser eval every time", () => {
    const decision = evaluatePermission({
      toolId: "browser",
      args: { action: "eval", expression: "document.title" },
      capability: "write",
      risk: writableRisk,
      preview: "browser eval",
    });

    expect(decision.decision).toBe("ask");
    if (decision.decision === "ask") {
      expect(decision.approval.reasonCode).toBe("browser_eval_requires_approval");
    }
  });

  test("allows configured shell reads and asks for drafts", () => {
    const allowDecision = evaluatePermission({
      toolId: "shell",
      args: { command: "web-fetch", subcommand: "fetch", args: ["https://example.com"] },
      capability: "write",
      risk: writableRisk,
      preview: "web-fetch fetch https://example.com",
    });
    const askDecision = evaluatePermission({
      toolId: "shell",
      args: { command: "mail", subcommand: "draft", args: ["123"] },
      capability: "write",
      risk: writableRisk,
      preview: "mail draft 123",
    });

    expect(allowDecision.decision).toBe("allow");
    expect(askDecision.decision).toBe("ask");
  });

  test("allows approval-gated shell calls after a tool grant", () => {
    const grants: PermissionGrant[] = [{ type: "tool", toolId: "shell" }];
    const decision = evaluatePermission(
      {
        toolId: "shell",
        args: { command: "gcal", subcommand: "create", args: ["--dry-run"] },
        capability: "write",
        risk: writableRisk,
        preview: "gcal create --dry-run",
      },
      grants
    );

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("shell_command_granted");
  });

  test("always allows todo, clarify, and notify", () => {
    const requests: PermissionRequest[] = [
      {
        toolId: "todo",
        args: { type: "replace" },
        capability: "write",
        risk: writableRisk,
        preview: "todo replace",
      },
      {
        toolId: "clarify",
        args: { promptId: "p" },
        capability: "write",
        risk: writableRisk,
        preview: "clarify",
      },
      {
        toolId: "notify",
        args: { title: "Done" },
        capability: "write",
        risk: writableRisk,
        preview: "notify",
      },
    ];

    for (const request of requests) {
      expect(evaluatePermission(request).decision).toBe("allow");
    }
  });

  test("denies destructive tools before specialized policy", () => {
    const decision = evaluatePermission({
      toolId: "shell",
      args: { command: "gcal", subcommand: "delete", args: ["evt-1"] },
      capability: "write",
      risk: { ...writableRisk, destructive: true },
      preview: "gcal delete evt-1",
    });

    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("destructive_tool_denied");
  });
});
