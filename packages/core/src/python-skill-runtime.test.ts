import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillDetail } from "@tessera/contracts";
import { type PythonSkillCommandInput, createPythonSkillRuntime } from "./python-skill-runtime.js";

async function writePythonSkill(root: string) {
  const skillDir = join(root, "pdf");
  await mkdir(join(skillDir, "scripts"), { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: pdf\ndescription: PDF workflows.\n---\n\n# PDF\n"
  );
  await writeFile(
    join(skillDir, "skill.json"),
    JSON.stringify(
      {
        python: {
          requirements: "requirements.txt",
          entrypoints: {
            tables: "scripts/tables.py",
          },
        },
      },
      null,
      2
    )
  );
  await writeFile(join(skillDir, "requirements.txt"), "pdfplumber==0.11.7\n");
  await writeFile(join(skillDir, "scripts", "tables.py"), "print('tables')\n");
  return {
    skillDir,
    detail: {
      id: "pdf",
      name: "pdf",
      description: "PDF workflows.",
      source: "workspace",
      path: join(skillDir, "SKILL.md"),
      content: "# PDF\n",
    } satisfies SkillDetail,
  };
}

describe("python skill runtime", () => {
  test("creates a cached skill environment and runs a declared Python entrypoint", async () => {
    const root = await mkdtemp("/tmp/tessera-python-skill-");
    const workspaceRoot = join(root, "workspace");
    const envRoot = join(root, "envs");
    await mkdir(workspaceRoot, { recursive: true });
    const { detail, skillDir } = await writePythonSkill(root);
    const resolvedSkillDir = await realpath(skillDir);
    const commands: PythonSkillCommandInput[] = [];
    const runtime = createPythonSkillRuntime({
      rootDir: envRoot,
      workspaceRoot,
      runner: { kind: "python", command: "/managed/python" },
      loadSkill: async () => detail,
      commandRunner: async (input) => {
        commands.push(input);
        return input.args.some((arg) => arg.endsWith("tables.py"))
          ? { stdout: "ok\n", stderr: "" }
          : { stdout: "", stderr: "" };
      },
    });

    const result = await runtime.runPython({
      skillId: "pdf",
      entrypoint: "tables",
      args: ["docs/source.pdf"],
    });

    expect(result).toMatchObject({
      skillId: "pdf",
      entrypoint: "tables",
      stdout: "ok\n",
      stderr: "",
    });
    expect(result.scriptPath).toBe(join(resolvedSkillDir, "scripts", "tables.py"));
    expect(result.environmentDir).toStartWith(join(envRoot, "pdf"));
    expect(commands.map((command) => command.command)).toEqual([
      "/managed/python",
      join(result.environmentDir, "bin", "python"),
      join(result.environmentDir, "bin", "python"),
    ]);
    expect(commands[0]?.args).toEqual(["-m", "venv", result.environmentDir]);
    expect(commands[1]?.args).toEqual([
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "-r",
      join(resolvedSkillDir, "requirements.txt"),
    ]);
    expect(commands[2]).toMatchObject({
      args: [join(resolvedSkillDir, "scripts", "tables.py"), "docs/source.pdf"],
      cwd: workspaceRoot,
    });

    await writeFile(join(skillDir, "requirements.txt"), "pdfplumber==0.11.8\n");
    const secondResult = await runtime.runPython({
      skillId: "pdf",
      entrypoint: "tables",
    });

    expect(secondResult.environmentDir).not.toBe(result.environmentDir);
    expect(commands.slice(3).map((command) => command.command)).toEqual([
      "/managed/python",
      join(secondResult.environmentDir, "bin", "python"),
      join(secondResult.environmentDir, "bin", "python"),
    ]);
    expect(commands[4]?.args).toEqual([
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "-r",
      join(resolvedSkillDir, "requirements.txt"),
    ]);
  });

  test("uses the Windows Python launcher fallback on win32", async () => {
    const root = await mkdtemp("/tmp/tessera-python-skill-");
    const workspaceRoot = join(root, "workspace");
    const { detail } = await writePythonSkill(root);
    const commands: PythonSkillCommandInput[] = [];
    const runtime = createPythonSkillRuntime({
      rootDir: join(root, "envs"),
      workspaceRoot,
      platform: "win32",
      loadSkill: async () => detail,
      commandRunner: async (input) => {
        commands.push(input);
        return { stdout: "", stderr: "" };
      },
    });

    await runtime.runPython({ skillId: "pdf", entrypoint: "tables" });

    expect(commands[0]?.command).toBe("python");
    expect(commands[1]?.command).toEndWith("Scripts/python.exe");
  });

  test("rejects undeclared Python entrypoints", async () => {
    const root = await mkdtemp("/tmp/tessera-python-skill-");
    const workspaceRoot = join(root, "workspace");
    const { detail } = await writePythonSkill(root);
    const runtime = createPythonSkillRuntime({
      rootDir: join(root, "envs"),
      workspaceRoot,
      runner: { kind: "python", command: "/managed/python" },
      loadSkill: async () => detail,
      commandRunner: async () => ({ stdout: "", stderr: "" }),
    });

    await expect(runtime.runPython({ skillId: "pdf", entrypoint: "missing" })).rejects.toThrow(
      /declared Python entrypoint/
    );
  });

  test("rejects Python scripts that escape the skill bundle", async () => {
    const root = await mkdtemp("/tmp/tessera-python-skill-");
    const workspaceRoot = join(root, "workspace");
    const { detail, skillDir } = await writePythonSkill(root);
    await writeFile(
      join(skillDir, "skill.json"),
      JSON.stringify({
        python: {
          entrypoints: {
            escape: "../escape.py",
          },
        },
      })
    );
    await writeFile(join(root, "escape.py"), "print('escape')\n");
    const runtime = createPythonSkillRuntime({
      rootDir: join(root, "envs"),
      workspaceRoot,
      runner: { kind: "python", command: "/managed/python" },
      loadSkill: async () => detail,
      commandRunner: async () => ({ stdout: "", stderr: "" }),
    });

    await expect(runtime.runPython({ skillId: "pdf", entrypoint: "escape" })).rejects.toThrow(
      /outside the skill bundle/
    );
  });
});
