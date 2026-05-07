import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSkillRegistry } from "@tessera/core";

export function packagedCuratedSkillsRoot(): string | undefined {
  const envRoot = process.env.TESSERA_CURATED_SKILLS_DIR;
  if (envRoot && existsSync(envRoot)) return envRoot;

  const executableRoot = join(dirname(process.execPath), "skills");
  return existsSync(executableRoot) ? executableRoot : undefined;
}

export function createTesseraSkillRegistry(options: { workspaceRoot?: string } = {}) {
  const curatedRoot = packagedCuratedSkillsRoot();
  return createSkillRegistry({
    ...options,
    ...(curatedRoot ? { curatedRoot, includeDefaultRoots: true } : {}),
  });
}
