import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SkillDetail } from "@tessera/contracts";
import { z } from "zod";
import type { OptionalCapabilityManager } from "./optional-capabilities.js";

const PYTHON_RUNNER_CAPABILITY_ID = "python-runner";
const PYTHON_RUNNER_BINARY_NAME = "uv";

const PythonSkillManifestSchema = z
  .object({
    python: z
      .object({
        requirements: z.string().min(1).optional(),
        entrypoints: z.record(z.string().min(1), z.string().min(1)).default({}),
      })
      .optional(),
  })
  .passthrough();

export interface PythonSkillCommandInput {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PythonSkillCommandResult {
  stdout: string;
  stderr: string;
}

export type PythonSkillCommandRunner = (
  input: PythonSkillCommandInput
) => Promise<PythonSkillCommandResult>;

export type PythonSkillRunnerCommand =
  | {
      kind: "python";
      command: string;
    }
  | {
      kind: "uv";
      command: string;
    };

export interface PythonSkillRunInput {
  skillId: string;
  entrypoint: string;
  args?: string[];
}

export interface PythonSkillRunResult {
  skillId: string;
  entrypoint: string;
  scriptPath: string;
  environmentDir: string;
  stdout: string;
  stderr: string;
}

export interface PythonSkillRuntime {
  runPython(input: PythonSkillRunInput): Promise<PythonSkillRunResult>;
}

export interface PythonSkillRuntimeOptions {
  rootDir: string;
  workspaceRoot: string;
  loadSkill(skillId: string): Promise<SkillDetail>;
  capabilityManager?: OptionalCapabilityManager;
  runner?: PythonSkillRunnerCommand;
  commandRunner?: PythonSkillCommandRunner;
  platform?: NodeJS.Platform;
}

interface LoadedPythonSkill {
  skill: SkillDetail;
  skillDir: string;
  scriptPath: string;
  requirementsPath?: string;
  requirementsHash?: string;
}

export function createPythonSkillRuntime(options: PythonSkillRuntimeOptions): PythonSkillRuntime {
  const commandRunner = options.commandRunner ?? runCommand;
  const platform = options.platform ?? process.platform;

  async function runPython(input: PythonSkillRunInput): Promise<PythonSkillRunResult> {
    const loaded = await loadPythonSkill(options.loadSkill, input);
    const runner = await resolveRunner(options, platform);
    const environmentDir = environmentDirectory(options.rootDir, loaded);
    await ensureEnvironment({
      commandRunner,
      environmentDir,
      platform,
      runner,
      ...(loaded.requirementsPath !== undefined
        ? { requirementsPath: loaded.requirementsPath }
        : {}),
    });
    const pythonPath = pythonPathForEnvironment(environmentDir, platform);
    const result = await commandRunner({
      command: pythonPath,
      args: [loaded.scriptPath, ...(input.args ?? [])],
      cwd: options.workspaceRoot,
      env: {
        TESSERA_WORKSPACE_ROOT: options.workspaceRoot,
        TESSERA_SKILL_ID: loaded.skill.id,
      },
    });
    return {
      skillId: loaded.skill.id,
      entrypoint: input.entrypoint,
      scriptPath: loaded.scriptPath,
      environmentDir,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return { runPython };
}

async function loadPythonSkill(
  loadSkill: (skillId: string) => Promise<SkillDetail>,
  input: PythonSkillRunInput
): Promise<LoadedPythonSkill> {
  const skill = await loadSkill(input.skillId);
  if (!skill.path) throw new Error(`Skill ${input.skillId} has no filesystem path.`);
  const skillDir = await realpath(dirname(skill.path));
  const manifestPath = join(skillDir, "skill.json");
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = PythonSkillManifestSchema.parse(JSON.parse(manifestSource));
  const python = manifest.python;
  if (!python) throw new Error(`Skill ${skill.id} does not declare Python runtime metadata.`);
  const entrypointPath = python.entrypoints[input.entrypoint];
  if (!entrypointPath) {
    throw new Error(`Skill ${skill.id} has no declared Python entrypoint: ${input.entrypoint}.`);
  }
  const scriptPath = await containedFilePath(skillDir, entrypointPath, "Python script");
  const requirementsPath = python.requirements
    ? await containedFilePath(skillDir, python.requirements, "Python requirements")
    : undefined;
  const requirementsHash = requirementsPath
    ? createHash("sha256")
        .update(await readFile(requirementsPath))
        .digest("hex")
    : undefined;
  return {
    skill,
    skillDir,
    scriptPath,
    ...(requirementsPath !== undefined ? { requirementsPath } : {}),
    ...(requirementsHash !== undefined ? { requirementsHash } : {}),
  };
}

async function containedFilePath(
  root: string,
  relativePath: string,
  label: string
): Promise<string> {
  const target = resolve(root, relativePath);
  const targetRelative = relative(root, target);
  if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
    throw new Error(`${label} is outside the skill bundle.`);
  }
  const resolved = await realpath(target);
  const resolvedRelative = relative(root, resolved);
  if (resolvedRelative.startsWith("..") || isAbsolute(resolvedRelative)) {
    throw new Error(`${label} is outside the skill bundle.`);
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error(`${label} is not a file: ${relativePath}`);
  return resolved;
}

async function resolveRunner(
  options: PythonSkillRuntimeOptions,
  platform: NodeJS.Platform
): Promise<PythonSkillRunnerCommand> {
  if (options.runner) return options.runner;

  const managedRunner = await resolveManagedUv(options.capabilityManager);
  if (managedRunner) return managedRunner;

  return { kind: "python", command: platform === "win32" ? "python" : "python3" };
}

async function resolveManagedUv(
  capabilityManager: OptionalCapabilityManager | undefined
): Promise<PythonSkillRunnerCommand | undefined> {
  if (!capabilityManager) return undefined;
  const existing = await capabilityManager
    .resolveBinary(PYTHON_RUNNER_CAPABILITY_ID, PYTHON_RUNNER_BINARY_NAME)
    .catch(() => undefined);
  if (existing) return { kind: "uv", command: existing };

  const status = await capabilityManager.status(PYTHON_RUNNER_CAPABILITY_ID).catch(() => undefined);
  if (!status?.installAvailable) return undefined;
  await capabilityManager.install(PYTHON_RUNNER_CAPABILITY_ID);
  const installed = await capabilityManager
    .resolveBinary(PYTHON_RUNNER_CAPABILITY_ID, PYTHON_RUNNER_BINARY_NAME)
    .catch(() => undefined);
  return installed ? { kind: "uv", command: installed } : undefined;
}

async function ensureEnvironment(options: {
  commandRunner: PythonSkillCommandRunner;
  environmentDir: string;
  platform: NodeJS.Platform;
  requirementsPath?: string;
  runner: PythonSkillRunnerCommand;
}): Promise<void> {
  const markerPath = join(options.environmentDir, "tessera-python-skill.json");
  const existing = await stat(markerPath).catch(() => undefined);
  if (existing?.isFile()) return;

  await mkdir(options.environmentDir, { recursive: true });
  if (options.runner.kind === "uv") {
    await options.commandRunner({
      command: options.runner.command,
      args: ["venv", options.environmentDir],
    });
  } else {
    await options.commandRunner({
      command: options.runner.command,
      args: ["-m", "venv", options.environmentDir],
    });
  }

  if (options.requirementsPath) {
    const pythonPath = pythonPathForEnvironment(options.environmentDir, options.platform);
    if (options.runner.kind === "uv") {
      await options.commandRunner({
        command: options.runner.command,
        args: ["pip", "install", "--python", pythonPath, "-r", options.requirementsPath],
      });
    } else {
      await options.commandRunner({
        command: pythonPath,
        args: [
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
          "-r",
          options.requirementsPath,
        ],
      });
    }
  }

  await writeFile(
    markerPath,
    `${JSON.stringify({ installedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

function environmentDirectory(rootDir: string, loaded: LoadedPythonSkill): string {
  const skillComponent = safePathComponent(loaded.skill.id);
  const hash = createHash("sha256")
    .update(loaded.skillDir)
    .update("\0")
    .update(loaded.scriptPath)
    .update("\0")
    .update(loaded.requirementsPath ?? "")
    .update("\0")
    .update(loaded.requirementsHash ?? "")
    .digest("hex")
    .slice(0, 16);
  const root = resolve(rootDir);
  const directory = resolve(root, skillComponent, hash);
  const relativeDirectory = relative(root, directory);
  if (relativeDirectory.startsWith("..") || isAbsolute(relativeDirectory)) {
    throw new Error(`Python skill environment escapes the managed root: ${loaded.skill.id}`);
  }
  return directory;
}

function pythonPathForEnvironment(environmentDir: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? join(environmentDir, "Scripts", "python.exe")
    : join(environmentDir, "bin", "python");
}

function safePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function runCommand(input: PythonSkillCommandInput): Promise<PythonSkillCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(
        new Error(`${input.command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`)
      );
    });
  });
}
