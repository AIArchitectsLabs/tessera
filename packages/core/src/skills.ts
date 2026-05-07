import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExternalSkillProvider,
  SkillDetail,
  SkillSource,
  SkillSummary,
} from "@tessera/contracts";
import { SkillDetailSchema, SkillSummarySchema } from "@tessera/contracts";

interface SkillCandidate {
  summary: SkillSummary;
  content?: string;
  contained: boolean;
}

export interface SkillRegistryOptions {
  curatedRoot?: string;
  userRoot?: string;
  workspaceRoot?: string;
  claudeUserRoot?: string;
  claudeWorkspaceRoot?: string;
  codexUserRoot?: string;
  codexWorkspaceRoot?: string;
}

export interface SkillEligibility {
  allowedSkillIds?: string[];
}

export interface SkillRegistry {
  listSkills(eligibility?: SkillEligibility): Promise<SkillSummary[]>;
  loadSkill(skillId: string, eligibility?: SkillEligibility): Promise<SkillDetail>;
}

const DEFAULT_CURATED_SKILLS_ROOT = fileURLToPath(new URL("../skills", import.meta.url));

function defaultRoot(...parts: string[]): string {
  return join(homedir(), ...parts);
}

function markdownFrontmatter(text: string): { metadata: Record<string, string>; body: string } {
  if (!text.startsWith("---\n")) return { metadata: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { metadata: {}, body: text };
  const raw = text.slice(4, end).trim();
  const metadata: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    metadata[match[1] ?? ""] = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { metadata, body: text.slice(end + 4).trim() };
}

function externalId(provider: ExternalSkillProvider, name: string): string {
  return `${provider}:${name}`;
}

async function isInside(path: string, root: string): Promise<boolean> {
  const [resolvedPath, resolvedRoot] = await Promise.all([realpath(path), realpath(root)]);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

async function scanRoot(options: {
  root: string | undefined;
  source: SkillSource;
  externalProvider?: ExternalSkillProvider;
}): Promise<SkillCandidate[]> {
  if (!options.root || !existsSync(options.root)) return [];
  const entries = await readdir(options.root, { withFileTypes: true }).catch(() => []);
  const candidates: SkillCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = join(options.root, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const text = await readFile(skillPath, "utf8").catch(() => "");
    if (!text) continue;
    const { metadata, body } = markdownFrontmatter(text);
    const name = metadata.name ?? entry.name;
    const id = options.externalProvider ? externalId(options.externalProvider, name) : name;
    const fileStat = await stat(skillPath).catch(() => undefined);
    const parsed = SkillSummarySchema.safeParse({
      id,
      name,
      description: metadata.description ?? "",
      source: options.source,
      externalProvider: options.externalProvider,
      path: skillPath,
      updatedAt: fileStat?.mtime.toISOString(),
    });
    if (!parsed.success) continue;

    candidates.push({
      summary: parsed.data,
      content: body || text,
      contained: await isInside(skillPath, options.root).catch(() => false),
    });
  }

  return candidates;
}

function sourceRank(source: SkillSource): number {
  if (source === "workspace") return 3;
  if (source === "user") return 2;
  if (source === "curated") return 1;
  return 0;
}

function applyOwnedPrecedence(candidates: SkillCandidate[]): SkillCandidate[] {
  const owned = candidates.filter((candidate) => candidate.summary.source !== "external");
  const external = candidates.filter((candidate) => candidate.summary.source === "external");
  const byName = new Map<string, SkillCandidate[]>();
  for (const candidate of owned) {
    const list = byName.get(candidate.summary.name) ?? [];
    list.push(candidate);
    byName.set(candidate.summary.name, list);
  }

  const resolved: SkillCandidate[] = [];
  for (const list of byName.values()) {
    const sorted = list.sort((a, b) => sourceRank(b.summary.source) - sourceRank(a.summary.source));
    const winner = sorted[0];
    if (!winner) continue;
    const shadowedSources = sorted.slice(1).map((candidate) => candidate.summary.source);
    resolved.push({
      ...winner,
      summary:
        shadowedSources.length > 0
          ? { ...winner.summary, conflict: { shadowedSources } }
          : winner.summary,
    });
  }

  return [...resolved, ...external].sort((a, b) => {
    if (a.summary.source === "external" && b.summary.source !== "external") return 1;
    if (a.summary.source !== "external" && b.summary.source === "external") return -1;
    return a.summary.id.localeCompare(b.summary.id);
  });
}

function defaultAllowed(eligibility?: SkillEligibility): Set<string> | undefined {
  return eligibility?.allowedSkillIds ? new Set(eligibility.allowedSkillIds) : undefined;
}

function isAllowed(summary: SkillSummary, allowed: Set<string> | undefined): boolean {
  if (!allowed) return true;
  return allowed.has(summary.id) || allowed.has(summary.name);
}

export function createSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistry {
  const useHomeDefaults = options.curatedRoot === undefined;

  async function candidates(): Promise<SkillCandidate[]> {
    const curated = await scanRoot({
      root: options.curatedRoot ?? DEFAULT_CURATED_SKILLS_ROOT,
      source: "curated",
    });

    return applyOwnedPrecedence([
      ...curated,
      ...(await scanRoot({
        root: options.userRoot ?? (useHomeDefaults ? defaultRoot(".tessera", "skills") : undefined),
        source: "user",
      })),
      ...(await scanRoot({
        root: options.workspaceRoot ? join(options.workspaceRoot, ".tessera", "skills") : undefined,
        source: "workspace",
      })),
      ...(await scanRoot({
        root:
          options.claudeUserRoot ??
          (useHomeDefaults ? defaultRoot(".claude", "skills") : undefined),
        source: "external",
        externalProvider: "claude-code",
      })),
      ...(await scanRoot({
        root:
          options.claudeWorkspaceRoot ??
          (options.workspaceRoot ? join(options.workspaceRoot, ".claude", "skills") : undefined),
        source: "external",
        externalProvider: "claude-code",
      })),
      ...(await scanRoot({
        root:
          options.codexUserRoot ?? (useHomeDefaults ? defaultRoot(".codex", "skills") : undefined),
        source: "external",
        externalProvider: "codex",
      })),
      ...(await scanRoot({
        root:
          options.codexWorkspaceRoot ??
          (options.workspaceRoot ? join(options.workspaceRoot, ".codex", "skills") : undefined),
        source: "external",
        externalProvider: "codex",
      })),
    ]);
  }

  return {
    async listSkills(eligibility) {
      const allowed = defaultAllowed(eligibility);
      return (await candidates())
        .filter((candidate) => candidate.contained)
        .map((candidate) => candidate.summary)
        .filter((summary) => isAllowed(summary, allowed));
    },
    async loadSkill(skillId, eligibility) {
      const all = await candidates();
      const candidate = all.find(
        (item) => item.summary.id === skillId || item.summary.name === skillId
      );
      if (!candidate) throw new Error(`Unknown skill: ${skillId}`);
      if (!candidate.contained) {
        throw new Error(`Skill ${skillId} is outside its configured skill root.`);
      }
      if (!isAllowed(candidate.summary, defaultAllowed(eligibility))) {
        throw new Error(`Skill ${skillId} is not enabled for this agent.`);
      }
      return SkillDetailSchema.parse({
        ...candidate.summary,
        content: candidate.content ?? "",
      });
    },
  };
}

export async function resolveSlashSkillInvocation(
  text: string,
  registry: SkillRegistry,
  eligibility?: SkillEligibility
): Promise<{ skillId: string; instruction: string } | undefined> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [head = "", ...tail] = trimmed.slice(1).split(/\s+/);
  if (!head) return undefined;

  if (head === "skill") {
    const [rawSkill, ...rest] = tail;
    if (!rawSkill) throw new Error("Missing skill name after /skill.");
    const detail = await registry.loadSkill(rawSkill, eligibility).catch((error) => {
      if (error instanceof Error && error.message.startsWith("Unknown skill")) {
        throw new Error(`Unknown skill: ${rawSkill}`);
      }
      throw error;
    });
    const instruction = rest.join(" ").trim() || `Use the ${detail.name} skill for this task.`;
    return { skillId: detail.id, instruction };
  }

  const detail = await registry.loadSkill(head, eligibility).catch((error) => {
    if (error instanceof Error && error.message.startsWith("Unknown skill")) return undefined;
    throw error;
  });
  if (!detail) return undefined;
  const instruction = tail.join(" ").trim() || `Use the ${detail.name} skill for this task.`;
  return { skillId: detail.id, instruction };
}
