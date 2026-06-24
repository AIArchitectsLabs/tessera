import type { AgentProfile } from "@tessera/contracts";

const LEGACY_DEFAULT_SKILL_SETS = [
  [
    "planning",
    "research-synthesis",
    "word-docs",
    "pdf-workflows",
    "slide-decks",
    "spreadsheets",
    "workspace-delivery",
    "decision-briefs",
  ],
  [
    "planning",
    "research-synthesis",
    "word-docs",
    "pdf-workflows",
    "slide-decks",
    "spreadsheets",
    "workspace-delivery",
    "decision-briefs",
    "tessera-playbook-builder",
  ],
  [
    "planning",
    "research-synthesis",
    "word-docs",
    "pdf-workflows",
    "slide-decks",
    "spreadsheets",
    "workspace-delivery",
    "decision-briefs",
    "tessera-playbook-builder",
    "tessera-playbook-debugger",
  ],
];

const PLATFORM_PLAYBOOK_SKILLS = ["tessera-playbook-builder", "tessera-playbook-debugger"] as const;

function sameSkillSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((skill) => rightSet.has(skill));
}

function mergeDefaultSkills(base: AgentProfile, override: AgentProfile): string[] {
  if (override.skills.length === 0) return base.skills;
  if (LEGACY_DEFAULT_SKILL_SETS.some((skills) => sameSkillSet(override.skills, skills))) {
    return base.skills;
  }
  const missingPlatformSkills = PLATFORM_PLAYBOOK_SKILLS.filter(
    (skill) => !override.skills.includes(skill)
  );
  if (missingPlatformSkills.length === 0) return override.skills;
  return [...override.skills, ...missingPlatformSkills];
}

export function mergeDefaultAgentProfile(
  base: AgentProfile,
  override: AgentProfile | undefined
): AgentProfile {
  if (!override) return base;

  return {
    ...override,
    id: base.id,
    name: base.name,
    model: base.model,
    skills: mergeDefaultSkills(base, override),
  };
}
