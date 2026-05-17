import { describe, expect, test } from "bun:test";
import {
  InboxCreateRequestSchema,
  InboxListResultSchema,
  InboxMessageSchema,
  InboxResolveRequestSchema,
  InboxSnoozeRequestSchema,
} from "./index.js";

const createdAt = "2026-05-05T10:00:00.000Z";

describe("inbox contracts", () => {
  test("accepts task-linked input required messages", () => {
    const parsed = InboxMessageSchema.parse({
      id: "inbox-1",
      source: "task",
      type: "input_required",
      severity: "warning",
      status: "open",
      workspaceRoot: "/workspace/acme",
      taskId: "task-1",
      title: "Clarification needed",
      body: "Pick a target audience before drafting.",
      context: {
        prompt: "Who is this launch announcement for?",
        fields: [{ id: "audience", label: "Audience", kind: "text" }],
      },
      actions: [{ id: "respond", label: "Respond", style: "primary" }],
      createdAt,
      updatedAt: createdAt,
      audit: [
        {
          id: "audit-1",
          messageId: "inbox-1",
          event: "created",
          actor: "system",
          createdAt,
        },
      ],
    });

    expect(parsed.taskId).toBe("task-1");
    expect(parsed.actions[0]?.id).toBe("respond");
  });

  test("accepts approval messages with permission context", () => {
    const parsed = InboxMessageSchema.parse({
      id: "inbox-approval",
      source: "task",
      type: "approval",
      severity: "critical",
      status: "open",
      title: "Approve workspace write",
      context: {
        approval: {
          toolId: "workspace.writeProbe",
          args: { path: "report.md" },
          capability: "write",
          risk: {
            mutates: true,
            destructive: false,
            external: false,
            reversible: true,
            dryRunSupported: false,
          },
          preview: "Write report.md",
          reasonCode: "write_requires_approval",
        },
      },
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
      createdAt,
      updatedAt: createdAt,
      audit: [],
    });

    expect(parsed.type).toBe("approval");
  });

  test("rejects secret-bearing fields in create requests", () => {
    const parsed = InboxCreateRequestSchema.safeParse({
      source: "integration",
      type: "credential",
      severity: "warning",
      title: "Credential needed",
      context: {
        provider: "google-workspace",
        credential: { apiKey: "sk-secret" },
      },
      actions: [{ id: "open-settings", label: "Open settings" }],
    });

    expect(parsed.success).toBe(false);
  });

  test("parses resolve and snooze requests", () => {
    expect(
      InboxResolveRequestSchema.parse({
        actionId: "respond",
        payload: { audience: "Founders" },
      }).actionId
    ).toBe("respond");

    expect(
      InboxSnoozeRequestSchema.parse({
        snoozedUntil: "2026-05-06T10:00:00.000Z",
      }).snoozedUntil
    ).toBe("2026-05-06T10:00:00.000Z");
  });

  test("parses list results without losing message details", () => {
    const parsed = InboxListResultSchema.parse({
      messages: [
        {
          id: "inbox-1",
          source: "task",
          type: "review",
          severity: "info",
          status: "resolved",
          title: "Review output",
          context: { artifactId: "artifact-1" },
          actions: [{ id: "acknowledge", label: "Acknowledge" }],
          resolvedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
          audit: [],
        },
      ],
    });

    expect(parsed.messages[0]?.context).toEqual({ artifactId: "artifact-1" });
  });
});
