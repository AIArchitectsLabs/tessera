import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type PlaybookGraphGitMilestoneCommitRequest,
  PlaybookGraphGitMilestoneCommitRequestSchema,
  type PlaybookGraphGitMilestoneCommitResult,
  PlaybookGraphGitMilestoneCommitResultSchema,
  type PlaybookGraphGitMilestonePreview,
  PlaybookGraphGitMilestonePreviewSchema,
} from "@tessera/contracts";
import { createWorkspaceGuard } from "./workspace-guard.js";

export interface GitServiceCommandInput {
  command: string;
  args: string[];
  cwd: string;
}

export interface GitServiceCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitServiceCommandRunner = (
  input: GitServiceCommandInput
) => Promise<GitServiceCommandResult>;

export interface GraphGitMilestoneServiceOptions {
  commandRunner?: GitServiceCommandRunner;
  gitPath?: string;
  now?: () => string;
}

export interface GraphGitMilestonePreviewInput {
  runId: string;
  actionSpecId: string;
  workspaceRoot: string;
  affectedPaths?: string[];
  message?: string;
  dirtyPolicy?: "clean_only" | "allow_selected_paths";
}

function isSameOrChild(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function isUnsafePath(path: string): boolean {
  return (
    !path.trim() ||
    path.includes("\0") ||
    path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")
  );
}

async function defaultCommandRunner(
  input: GitServiceCommandInput
): Promise<GitServiceCommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolveCommand({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

function assertGitSuccess(command: GitServiceCommandResult, label: string): string {
  if (command.exitCode !== 0) {
    throw new Error(`${label} failed: ${command.stderr || command.stdout || "unknown git error"}`);
  }
  return command.stdout.trim();
}

function assertGitSuccessRaw(command: GitServiceCommandResult, label: string): string {
  if (command.exitCode !== 0) {
    throw new Error(`${label} failed: ${command.stderr || command.stdout || "unknown git error"}`);
  }
  return command.stdout;
}

function parseStatus(stdout: string): Array<{
  status: string;
  gitPath: string;
  previousGitPath?: string;
}> {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: Array<{ status: string; gitPath: string; previousGitPath?: string }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const statusText = field.slice(0, 2);
    const gitPath = field.slice(3);
    if (!gitPath) continue;
    const status = statusText.trim() || statusText;
    const isRenameOrCopy = statusText.includes("R") || statusText.includes("C");
    const previousGitPath = isRenameOrCopy ? fields[index + 1] : undefined;
    if (isRenameOrCopy) index += 1;
    entries.push({
      status,
      gitPath,
      ...(previousGitPath ? { previousGitPath } : {}),
    });
  }
  return entries;
}

function defaultMilestoneMessage(runId: string, actionSpecId: string): string {
  return `Record graph run milestone ${runId}\n\nGraph-Run: ${runId}\nAction-Spec: ${actionSpecId}`;
}

function milestoneCommitMessage(message: string, runId: string, actionSpecId: string): string {
  const trailers = [`Graph-Run: ${runId}`, `Action-Spec: ${actionSpecId}`];
  const missing = trailers.filter((trailer) => !message.includes(trailer));
  if (missing.length === 0) return message;
  return `${message.trimEnd()}\n\n${missing.join("\n")}`;
}

function relativePath(root: string, target: string): string {
  const path = relative(root, target);
  return path || ".";
}

async function resolveGitContext(
  workspaceRoot: string,
  commandRunner: GitServiceCommandRunner,
  gitPath: string
): Promise<{
  workspaceRoot: string;
  gitRoot: string;
  branch: string;
}> {
  const workspace = await createWorkspaceGuard(workspaceRoot);
  const gitRootOutput = assertGitSuccess(
    await commandRunner({
      command: gitPath,
      args: ["rev-parse", "--show-toplevel"],
      cwd: workspace.root,
    }),
    "git rev-parse --show-toplevel"
  );
  const gitRoot = await realpath(resolve(gitRootOutput));
  if (!isSameOrChild(gitRoot, workspace.root)) {
    throw new Error("Workspace root is outside the resolved git repository");
  }
  const branch = assertGitSuccess(
    await commandRunner({
      command: gitPath,
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: gitRoot,
    }),
    "git rev-parse --abbrev-ref HEAD"
  );
  return { workspaceRoot: workspace.root, gitRoot, branch };
}

async function resolveAffectedPaths(input: {
  workspaceRoot: string;
  gitRoot: string;
  affectedPaths: string[];
}): Promise<Set<string>> {
  const workspace = await createWorkspaceGuard(input.workspaceRoot);
  const selected = new Set<string>();
  for (const path of input.affectedPaths) {
    if (isUnsafePath(path) || isAbsolute(path)) {
      throw new Error(`Milestone affected path must be workspace-relative: ${path}`);
    }
    const absolutePath = await workspace.resolveInsideWorkspaceForCreate(path);
    selected.add(relativePath(input.gitRoot, absolutePath));
  }
  return selected;
}

export function createGraphGitMilestoneService(options: GraphGitMilestoneServiceOptions = {}) {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const gitPath = options.gitPath ?? "git";
  const now = options.now ?? (() => new Date().toISOString());

  async function preview(
    input: GraphGitMilestonePreviewInput
  ): Promise<PlaybookGraphGitMilestonePreview> {
    try {
      const context = await resolveGitContext(input.workspaceRoot, commandRunner, gitPath);
      const affectedPaths = input.affectedPaths
        ? await resolveAffectedPaths({
            workspaceRoot: context.workspaceRoot,
            gitRoot: context.gitRoot,
            affectedPaths: input.affectedPaths,
          })
        : undefined;
      const statusOutput = assertGitSuccessRaw(
        await commandRunner({
          command: gitPath,
          args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          cwd: context.gitRoot,
        }),
        "git status"
      );
      const changedFiles = parseStatus(statusOutput).map((entry) => {
        const absolutePath = resolve(context.gitRoot, entry.gitPath);
        const insideWorkspace = isSameOrChild(context.workspaceRoot, absolutePath);
        const workspacePath = insideWorkspace
          ? relativePath(context.workspaceRoot, absolutePath)
          : entry.gitPath;
        return {
          path: workspacePath,
          status: entry.status,
          allowed: insideWorkspace && (!affectedPaths || affectedPaths.has(entry.gitPath)),
          ...(entry.previousGitPath ? { previousPath: entry.previousGitPath } : {}),
        };
      });
      const dirtyPolicy = input.dirtyPolicy ?? "allow_selected_paths";
      const unavailableReason =
        dirtyPolicy === "clean_only" && changedFiles.length > 0
          ? "Workspace has uncommitted changes"
          : undefined;
      return PlaybookGraphGitMilestonePreviewSchema.parse({
        schemaVersion: 1,
        available: unavailableReason === undefined,
        unavailableReason,
        workspaceRoot: context.workspaceRoot,
        gitRoot: context.gitRoot,
        branch: context.branch,
        changedFiles,
        proposedMessage: input.message ?? defaultMilestoneMessage(input.runId, input.actionSpecId),
        dirtyPolicy,
        unsupportedFeatures: ["push", "branch switching", "rollback"],
      });
    } catch (error) {
      return PlaybookGraphGitMilestonePreviewSchema.parse({
        schemaVersion: 1,
        available: false,
        unavailableReason: error instanceof Error ? error.message : "Git milestone unavailable",
        changedFiles: [],
        proposedMessage: input.message ?? defaultMilestoneMessage(input.runId, input.actionSpecId),
        dirtyPolicy: input.dirtyPolicy ?? "allow_selected_paths",
        unsupportedFeatures: ["push", "branch switching", "rollback"],
      });
    }
  }

  async function commit(
    input: PlaybookGraphGitMilestoneCommitRequest
  ): Promise<PlaybookGraphGitMilestoneCommitResult> {
    const request = PlaybookGraphGitMilestoneCommitRequestSchema.parse(input);
    const context = await resolveGitContext(request.workspaceRoot, commandRunner, gitPath);
    const affectedPaths = await resolveAffectedPaths({
      workspaceRoot: context.workspaceRoot,
      gitRoot: context.gitRoot,
      affectedPaths: request.affectedPaths,
    });
    const before = await preview({
      runId: request.runId,
      actionSpecId: request.actionSpecId,
      workspaceRoot: context.workspaceRoot,
      affectedPaths: request.affectedPaths,
      message: request.message,
      dirtyPolicy: "allow_selected_paths",
    });
    const selectedChanges = before.changedFiles.filter((file) => file.allowed);
    if (selectedChanges.length === 0) {
      throw new Error("No selected dirty files are available for a graph run milestone commit");
    }
    if (before.changedFiles.some((file) => file.path.includes(".."))) {
      throw new Error("Git status returned a path outside the workspace");
    }
    const gitRelativePaths = [...affectedPaths].sort();
    const commitMessage = milestoneCommitMessage(
      request.message,
      request.runId,
      request.actionSpecId
    );
    const indexSnapshotTree = assertGitSuccess(
      await commandRunner({ command: gitPath, args: ["write-tree"], cwd: context.gitRoot }),
      "git write-tree"
    );
    try {
      assertGitSuccess(
        await commandRunner({
          command: gitPath,
          args: ["add", "--", ...gitRelativePaths],
          cwd: context.gitRoot,
        }),
        "git add"
      );
      assertGitSuccess(
        await commandRunner({
          command: gitPath,
          args: ["commit", "-m", commitMessage, "--", ...gitRelativePaths],
          cwd: context.gitRoot,
        }),
        "git commit"
      );
    } catch (error) {
      try {
        assertGitSuccess(
          await commandRunner({
            command: gitPath,
            args: ["read-tree", indexSnapshotTree],
            cwd: context.gitRoot,
          }),
          "git read-tree"
        );
      } catch (restoreError) {
        const failure = error instanceof Error ? error.message : String(error);
        const restore = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(`${failure}; index restore failed: ${restore}`);
      }
      throw error;
    }
    const commitHash = assertGitSuccess(
      await commandRunner({
        command: gitPath,
        args: ["rev-parse", "HEAD"],
        cwd: context.gitRoot,
      }),
      "git rev-parse HEAD"
    );
    const after = await preview({
      runId: request.runId,
      actionSpecId: request.actionSpecId,
      workspaceRoot: context.workspaceRoot,
      affectedPaths: request.affectedPaths,
      message: request.message,
      dirtyPolicy: "allow_selected_paths",
    });
    return PlaybookGraphGitMilestoneCommitResultSchema.parse({
      evidence: {
        schemaVersion: 1,
        runId: request.runId,
        actionSpecId: request.actionSpecId,
        affectedPaths: request.affectedPaths,
        commitHash,
        committedAt: now(),
        trailers: {
          "Graph-Run": request.runId,
          "Action-Spec": request.actionSpecId,
        },
      },
      preview: after,
    });
  }

  return { preview, commit };
}
