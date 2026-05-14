import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyCuratedSkills } from "./build-sidecar.ts";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-build-sidecar-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("build-sidecar", () => {
  test("copies curated skills into the packaged binaries directory", async () => {
    const root = tempRoot();
    const binDir = join(root, "apps/desktop/src-tauri/binaries");
    const sourceSkillDir = join(root, "packages/core/skills/pdf-workflows");
    const bundledSkillPath = join(binDir, "skills/pdf-workflows/SKILL.md");
    await mkdir(sourceSkillDir, { recursive: true });
    await mkdir(join(binDir, "skills/pdf-workflows"), { recursive: true });
    writeFileSync(join(sourceSkillDir, "SKILL.md"), "current curated pdf skill\n");
    writeFileSync(bundledSkillPath, "stale bundled pdf skill\n");

    copyCuratedSkills({ repoRoot: root, binDir });

    await expect(readFile(bundledSkillPath, "utf8")).resolves.toBe("current curated pdf skill\n");
  });
});
