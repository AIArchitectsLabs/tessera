import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillRegistry, resolveSlashSkillInvocation } from "./skills.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tessera-skills-"));
  tempDirs.push(dir);
  return realpath(dir);
}

function writeSkill(root: string, slug: string, description = `Use ${slug}.`, body = "Do work.") {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n\n${body}\n`
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("skill registry", () => {
  test("ships the curated business and document skill core", async () => {
    const registry = createSkillRegistry();
    const skills = await registry.listSkills();
    const curatedSkills = skills.filter((skill) => skill.source === "curated");

    expect(curatedSkills.map((skill) => skill.id)).toEqual([
      "decision-briefs",
      "pdf-workflows",
      "planning",
      "research-synthesis",
      "slide-decks",
      "spreadsheets",
      "word-docs",
      "workspace-delivery",
    ]);
    for (const skillId of ["word-docs", "pdf-workflows", "slide-decks", "spreadsheets"]) {
      await expect(registry.loadSkill(skillId)).resolves.toMatchObject({
        id: skillId,
        source: "curated",
        content: expect.stringContaining("## Workflow"),
      });
    }
    await expect(registry.loadSkill("word-docs")).resolves.toMatchObject({
      source: "curated",
      content: expect.stringContaining("DOCX-style business writing"),
    });
    const pdfWorkflows = await registry.loadSkill("pdf-workflows");
    expect(pdfWorkflows).toMatchObject({
      source: "curated",
    });
    expect(pdfWorkflows.content).toContain(
      "Always inspect PDFs before extracting or changing them."
    );
    expect(pdfWorkflows.content).toContain("pdf_capabilities");
    expect(pdfWorkflows.content).toContain("Tessera-managed PDF render engine");
    expect(pdfWorkflows.content).toContain("bundled TypeScript transform engine");
    expect(pdfWorkflows.content).toContain("pdf_inspect");
    expect(pdfWorkflows.content).toContain("pdf_validate");
    expect(pdfWorkflows.content).toContain("pdf_render");
    expect(pdfWorkflows.content).toContain("pdf_transform");
    expect(pdfWorkflows.content).toContain("pdf_manifest");
    expect(pdfWorkflows.content).toContain("packet manifest");
    expect(pdfWorkflows.content).toContain("handoff");
    expect(pdfWorkflows.content).toContain("split, merge, reorder, and rotate");
    expect(pdfWorkflows.content).toContain("Preserve originals");
    await expect(registry.loadSkill("slide-decks")).resolves.toMatchObject({
      source: "curated",
      content: expect.stringContaining("slide-by-slide outline"),
    });
    await expect(registry.loadSkill("spreadsheets")).resolves.toMatchObject({
      source: "curated",
      content: expect.stringContaining("formulas and source data"),
    });
  });

  test("discovers owned skills with workspace precedence and conflict metadata", async () => {
    const curatedRoot = await tempRoot();
    const userRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const workspaceSkillsRoot = join(workspaceRoot, ".tessera", "skills");
    writeSkill(curatedRoot, "planning", "Curated planning.");
    writeSkill(userRoot, "planning", "User planning.");
    writeSkill(workspaceSkillsRoot, "planning", "Workspace planning.");

    const registry = createSkillRegistry({ curatedRoot, userRoot, workspaceRoot });
    const skills = await registry.listSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: "planning",
      name: "planning",
      description: "Workspace planning.",
      source: "workspace",
      conflict: { shadowedSources: ["user", "curated"] },
    });
  });

  test("lets workspace and user skills override curated document defaults", async () => {
    const userRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const workspaceSkillsRoot = join(workspaceRoot, ".tessera", "skills");
    writeSkill(userRoot, "word-docs", "User Word workflow.", "Use the user's house style.");
    writeSkill(
      workspaceSkillsRoot,
      "word-docs",
      "Workspace Word workflow.",
      "Use the workspace template."
    );

    const registry = createSkillRegistry({ userRoot, workspaceRoot });
    const skills = await registry.listSkills();
    const wordDocs = skills.find((skill) => skill.id === "word-docs");

    expect(wordDocs).toMatchObject({
      source: "workspace",
      description: "Workspace Word workflow.",
      conflict: { shadowedSources: ["user", "curated"] },
    });
    await expect(registry.loadSkill("word-docs")).resolves.toMatchObject({
      source: "workspace",
      content: expect.stringContaining("Use the workspace template."),
    });
  });

  test("discovers Claude Code and Codex skills as external opt-in candidates", async () => {
    const curatedRoot = await tempRoot();
    const claudeUserRoot = await tempRoot();
    const codexUserRoot = await tempRoot();
    writeSkill(curatedRoot, "planning", "Curated planning.");
    writeSkill(claudeUserRoot, "pdf-workflows", "Claude PDF workflow.");
    writeSkill(codexUserRoot, "review", "Codex review workflow.");

    const registry = createSkillRegistry({ curatedRoot, claudeUserRoot, codexUserRoot });
    const skills = await registry.listSkills();

    expect(skills.map((skill) => [skill.id, skill.source, skill.externalProvider])).toEqual([
      ["planning", "curated", undefined],
      ["claude-code:pdf-workflows", "external", "claude-code"],
      ["codex:review", "external", "codex"],
    ]);
  });

  test("loads only eligible skills for an agent and blocks path escape", async () => {
    const curatedRoot = await tempRoot();
    const outsideRoot = await tempRoot();
    writeSkill(curatedRoot, "planning", "Curated planning.", "Plan in phases.");
    writeSkill(outsideRoot, "escape", "Escaped skill.");
    symlinkSync(join(outsideRoot, "escape"), join(curatedRoot, "escape"));

    const registry = createSkillRegistry({ curatedRoot });

    await expect(
      registry.loadSkill("planning", { allowedSkillIds: ["planning"] })
    ).resolves.toMatchObject({
      id: "planning",
      content: expect.stringContaining("Plan in phases."),
    });
    await expect(registry.loadSkill("planning", { allowedSkillIds: [] })).rejects.toThrow(
      "not enabled"
    );
    await expect(registry.loadSkill("escape", { allowedSkillIds: ["escape"] })).rejects.toThrow(
      "outside"
    );
  });

  test("parses slash invocations and leaves unknown direct slash text alone", async () => {
    const curatedRoot = await tempRoot();
    writeSkill(curatedRoot, "planning", "Curated planning.");
    const registry = createSkillRegistry({ curatedRoot });

    await expect(
      resolveSlashSkillInvocation("/planning draft the launch plan", registry, {
        allowedSkillIds: ["planning"],
      })
    ).resolves.toMatchObject({
      skillId: "planning",
      instruction: "draft the launch plan",
    });

    await expect(
      resolveSlashSkillInvocation("/skill planning", registry, {
        allowedSkillIds: ["planning"],
      })
    ).resolves.toMatchObject({
      skillId: "planning",
      instruction: "Use the planning skill for this task.",
    });

    await expect(
      resolveSlashSkillInvocation("/skill missing do work", registry, {
        allowedSkillIds: ["planning"],
      })
    ).rejects.toThrow("Unknown skill");

    await expect(
      resolveSlashSkillInvocation("/not-a-skill do work", registry, {
        allowedSkillIds: ["planning"],
      })
    ).resolves.toBeUndefined();
  });
});
