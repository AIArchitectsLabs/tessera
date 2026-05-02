import { describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskExecutionConfigSchema,
} from "./index.js";

describe("agent profile contracts", () => {
  test("accepts default model mode", () => {
    const parsed = AgentProfileSchema.parse({
      id: "default",
      name: "Tessera",
      model: { mode: "default" },
      skills: [],
      tools: ["workspace_read"],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.model.mode).toBe("default");
  });

  test("accepts override model mode", () => {
    const parsed = AgentProfileSchema.parse({
      id: "writer",
      name: "Writer",
      model: {
        mode: "override",
        provider: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      skills: [],
      tools: ["workspace_read", "workspace_write"],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.model.mode).toBe("override");
  });

  test("rejects credentials embedded in agent profiles", () => {
    const parsed = AgentProfileSchema.safeParse({
      id: "bad",
      name: "Bad",
      model: {
        mode: "override",
        provider: { provider: "openai", model: "gpt-5.4" },
      },
      credential: { apiKey: "sk-secret" },
      skills: [],
      tools: [],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  test("task requests accept optional agent id and execution config", () => {
    const execution = {
      agent: {
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        skills: [],
        tools: ["workspace_read"],
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      provider: { provider: "openai", model: "gpt-5.4" },
      credential: { apiKey: "sk-runtime" },
    };

    expect(TaskExecutionConfigSchema.parse(execution).provider.provider).toBe("openai");
    expect(
      TaskCreateRequestSchema.parse({
        workspaceRoot: "/workspace/acme",
        initialInstruction: "Draft",
        agentId: "default",
        execution,
      }).agentId
    ).toBe("default");
    expect(
      TaskCreateTurnRequestSchema.parse({
        content: "Continue",
        agentId: "default",
        execution,
      }).agentId
    ).toBe("default");
  });
});
