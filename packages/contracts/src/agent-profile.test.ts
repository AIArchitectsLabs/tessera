import { describe, expect, test } from "bun:test";
import {
  AGENT_PROFILE_TEMPLATES,
  AgentProfileSchema,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskExecutionConfigSchema,
  compileAgentRuntimeContext,
  resolveToolPolicyPreset,
} from "./index.js";

describe("agent profile contracts", () => {
  test("accepts default model mode", () => {
    const parsed = AgentProfileSchema.parse({
      id: "default",
      name: "Tessera",
      model: { mode: "default" },
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.model.mode).toBe("default");
    expect(parsed.toolPolicyPreset).toBe("workspace_editor");
    expect(parsed.userContext).toBe("");
  });

  test("accepts override model mode", () => {
    const parsed = AgentProfileSchema.parse({
      id: "writer",
      name: "Writer",
      model: {
        mode: "override",
        provider: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      instructions: "Deliver clean drafts.",
      soul: "Calm.",
      userContext: "This agent supports a COO.",
      toolPolicyPreset: "elevated_with_approval",
      memoryDefaults: "Remember weekly reporting format.",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.model.mode).toBe("override");
    expect(parsed.toolPolicyPreset).toBe("elevated_with_approval");
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
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  test("resolves tool policy presets into concrete capabilities", () => {
    const readOnly = resolveToolPolicyPreset("read_only");
    expect(readOnly.approvalMode).toBe("never");
    expect(readOnly.allowedTools).toContain("workspace_read");
    expect(readOnly.allowedTools).toContain("workspace_extract");
    expect(readOnly.allowedTools).toContain("todo");
    expect(readOnly.allowedTools).toContain("skill_list");
    expect(readOnly.allowedTools).toContain("skill_load");
    expect(resolveToolPolicyPreset("elevated_with_approval")).toMatchObject({
      approvalMode: "ask",
    });
  });

  test("compiles runtime summaries for the task inspector", () => {
    const profile = AgentProfileSchema.parse({
      id: "ops",
      name: "Ops",
      templateId: "business-operator",
      model: { mode: "default" },
      instructions: "Drive concrete next steps.",
      soul: "Brief and direct.",
      userContext: "Supports business operators.",
      skills: ["planning", "research-synthesis"],
      toolPolicyPreset: "workspace_editor",
      memoryDefaults: "Reuse prior meeting doc formats.",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    const runtime = compileAgentRuntimeContext(profile);
    expect(runtime.templateLabel).toBe("Business Operator");
    expect(runtime.toolPolicy.allowedTools).toContain("workspace_write");
    expect(runtime.toolPolicy.allowedTools).toContain("workspace_extract");
    expect(runtime.toolPolicy.allowedTools).toContain("todo");
    expect(runtime.sectionSummaries.instructions).toContain("Drive concrete next steps");
    expect(runtime.compiledSummary).toContain("2 profile skills enabled");
  });

  test("exposes built-in agent profile templates", () => {
    expect(AGENT_PROFILE_TEMPLATES.map((template) => template.id)).toEqual([
      "business-operator",
      "research-analyst",
      "exec-partner",
    ]);
  });

  test("task requests accept optional agent id and execution config", () => {
    const runtime = compileAgentRuntimeContext(
      AgentProfileSchema.parse({
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      })
    );
    const execution = {
      agent: {
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      runtime,
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
