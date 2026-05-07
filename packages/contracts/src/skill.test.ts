import { describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  SkillDetailSchema,
  SkillListResultSchema,
  SkillSummarySchema,
  TOOL_POLICY_PRESET_DETAILS,
  TaskDetailSchema,
  TaskSkillActivationSchema,
} from "./index.js";

describe("skill contracts", () => {
  test("parses skill summaries and details with external provenance", () => {
    const summary = SkillSummarySchema.parse({
      id: "claude-code:research-synthesis",
      name: "research-synthesis",
      description: "Synthesize research into a concise brief.",
      source: "external",
      externalProvider: "claude-code",
      path: "/Users/test/.claude/skills/research-synthesis/SKILL.md",
      updatedAt: "2026-05-05T00:00:00.000Z",
      conflict: { shadowedSources: ["curated"] },
    });

    expect(summary.externalProvider).toBe("claude-code");
    expect(summary.conflict?.shadowedSources).toEqual(["curated"]);

    expect(
      SkillDetailSchema.parse({
        ...summary,
        content: "# Research Synthesis\n\nUse evidence before claims.",
      }).content
    ).toContain("Use evidence");
  });

  test("rejects invalid skill names and missing descriptions", () => {
    expect(
      SkillSummarySchema.safeParse({
        id: "Bad Name",
        name: "Bad Name",
        description: "Invalid",
        source: "curated",
      }).success
    ).toBe(false);

    expect(
      SkillSummarySchema.safeParse({
        id: "planning",
        name: "planning",
        description: "",
        source: "curated",
      }).success
    ).toBe(false);
  });

  test("round-trips skills on agent profiles and task details", () => {
    const profile = AgentProfileSchema.parse({
      id: "agent-1",
      name: "Researcher",
      model: { mode: "default" },
      skills: ["research-synthesis", "claude-code:pdf-workflows"],
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
    });
    expect(profile.skills).toEqual(["research-synthesis", "claude-code:pdf-workflows"]);

    const activeSkill = TaskSkillActivationSchema.parse({
      skillId: "research-synthesis",
      name: "research-synthesis",
      source: "curated",
      activatedAt: "2026-05-05T00:00:00.000Z",
      activatedByTurnId: "turn-1",
    });

    const detail = TaskDetailSchema.parse({
      id: "task-1",
      workspaceRoot: "/workspace/acme",
      title: "Research",
      status: "active",
      activeSkills: [activeSkill],
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
      turns: [],
      artifacts: [],
    });

    expect(detail.activeSkills).toEqual([activeSkill]);
  });

  test("exposes list result and skill tools in every policy preset", () => {
    expect(
      SkillListResultSchema.parse({
        skills: [
          {
            id: "planning",
            name: "planning",
            description: "Plan multi-step business work.",
            source: "curated",
          },
        ],
      }).skills
    ).toHaveLength(1);

    for (const details of Object.values(TOOL_POLICY_PRESET_DETAILS)) {
      expect(details.allowedTools).toContain("skill_list");
      expect(details.allowedTools).toContain("skill_load");
    }
  });
});
