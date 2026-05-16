import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GitServiceCommandInput,
  type GitServiceCommandResult,
  createGraphGitMilestoneService,
} from "./git-service.js";

function commandKey(input: GitServiceCommandInput): string {
  return input.args.join(" ");
}

function gitSuccess(stdout = ""): GitServiceCommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function gitFailure(stderr: string): GitServiceCommandResult {
  return { stdout: "", stderr, exitCode: 1 };
}

describe("createGraphGitMilestoneService", () => {
  test("previews workspace-scoped dirty files without mutating git state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-git-service-"));
    const canonicalRoot = await realpath(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const calls: GitServiceCommandInput[] = [];
    const service = createGraphGitMilestoneService({
      commandRunner: async (input) => {
        calls.push(input);
        switch (commandKey(input)) {
          case "rev-parse --show-toplevel":
            return gitSuccess(`${root}\n`);
          case "rev-parse --abbrev-ref HEAD":
            return gitSuccess("main\n");
          case "status --porcelain=v1 -z --untracked-files=all":
            return gitSuccess(" M workspace/src/a.ts\0?? outside.txt\0");
          default:
            throw new Error(`unexpected git command: ${commandKey(input)}`);
        }
      },
    });
    try {
      const preview = await service.preview({
        runId: "run-1",
        actionSpecId: "action-1",
        workspaceRoot,
        affectedPaths: ["src/a.ts"],
      });

      expect(preview.available).toBe(true);
      expect(preview.gitRoot).toBe(canonicalRoot);
      expect(preview.branch).toBe("main");
      expect(preview.changedFiles).toEqual([
        { path: "src/a.ts", status: "M", allowed: true },
        { path: "outside.txt", status: "??", allowed: false },
      ]);
      expect(calls.map((call) => commandKey(call))).toEqual([
        "rev-parse --show-toplevel",
        "rev-parse --abbrev-ref HEAD",
        "status --porcelain=v1 -z --untracked-files=all",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("commits only explicitly selected workspace paths and returns durable evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-git-service-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const calls: GitServiceCommandInput[] = [];
    let statusCalls = 0;
    const service = createGraphGitMilestoneService({
      now: () => "2026-05-16T00:00:00.000Z",
      commandRunner: async (input) => {
        calls.push(input);
        switch (commandKey(input)) {
          case "rev-parse --show-toplevel":
            return gitSuccess(`${root}\n`);
          case "rev-parse --abbrev-ref HEAD":
            return gitSuccess("main\n");
          case "status --porcelain=v1 -z --untracked-files=all":
            statusCalls += 1;
            return gitSuccess(statusCalls === 1 ? " M workspace/src/a.ts\0" : "");
          case "write-tree":
            return gitSuccess("tree-before\n");
          case "add -- workspace/src/a.ts":
            return gitSuccess();
          case "rev-parse HEAD":
            return gitSuccess("abc123\n");
          default:
            if (
              input.args[0] === "commit" &&
              input.args[1] === "-m" &&
              input.args[2]?.includes("Graph-Run: run-1") &&
              input.args[2]?.includes("Action-Spec: action-1") &&
              input.args.slice(3).join(" ") === "-- workspace/src/a.ts"
            ) {
              return gitSuccess("[main abc123] Record milestone\n");
            }
            throw new Error(`unexpected git command: ${commandKey(input)}`);
        }
      },
    });
    try {
      const result = await service.commit({
        runId: "run-1",
        actionSpecId: "action-1",
        workspaceRoot,
        affectedPaths: ["src/a.ts"],
        message: "Record milestone",
      });

      expect(result.evidence).toEqual({
        schemaVersion: 1,
        runId: "run-1",
        actionSpecId: "action-1",
        affectedPaths: ["src/a.ts"],
        commitHash: "abc123",
        committedAt: "2026-05-16T00:00:00.000Z",
        trailers: {
          "Graph-Run": "run-1",
          "Action-Spec": "action-1",
        },
      });
      expect(calls.map((call) => commandKey(call))).not.toContain("push");
      expect(calls.map((call) => inputCommandName(call))).not.toContain("checkout");
      expect(calls.map((call) => inputCommandName(call))).not.toContain("reset");
      expect(calls.map((call) => inputCommandName(call))).not.toContain("merge");
      expect(calls.map((call) => inputCommandName(call))).not.toContain("rebase");
      const commitCall = calls.find((call) => call.args[0] === "commit");
      expect(commitCall?.args[2]).toContain("Graph-Run: run-1");
      expect(commitCall?.args[2]).toContain("Action-Spec: action-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parses nul-delimited status paths with spaces, quotes, newlines, and backslashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-git-service-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const service = createGraphGitMilestoneService({
      commandRunner: async (input) => {
        switch (commandKey(input)) {
          case "rev-parse --show-toplevel":
            return gitSuccess(`${root}\n`);
          case "rev-parse --abbrev-ref HEAD":
            return gitSuccess("main\n");
          case "status --porcelain=v1 -z --untracked-files=all":
            return gitSuccess(
              [
                " M workspace/src/has space.ts",
                '?? workspace/src/quote"file.ts',
                " A workspace/src/line\nbreak.ts",
                " M workspace/src/back\\slash.ts",
                "",
              ].join("\0")
            );
          default:
            throw new Error(`unexpected git command: ${commandKey(input)}`);
        }
      },
    });
    try {
      const preview = await service.preview({
        runId: "run-1",
        actionSpecId: "action-1",
        workspaceRoot,
      });

      expect(preview.changedFiles.map((file) => file.path)).toEqual([
        "src/has space.ts",
        'src/quote"file.ts',
        "src/line\nbreak.ts",
        "src/back\\slash.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses rename and copy destinations for allowed matching and display", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-git-service-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const service = createGraphGitMilestoneService({
      commandRunner: async (input) => {
        switch (commandKey(input)) {
          case "rev-parse --show-toplevel":
            return gitSuccess(`${root}\n`);
          case "rev-parse --abbrev-ref HEAD":
            return gitSuccess("main\n");
          case "status --porcelain=v1 -z --untracked-files=all":
            return gitSuccess(
              [
                "R  workspace/src/new-name.ts",
                "workspace/src/old-name.ts",
                "C  workspace/src/copied.ts",
                "workspace/src/source.ts",
                "",
              ].join("\0")
            );
          default:
            throw new Error(`unexpected git command: ${commandKey(input)}`);
        }
      },
    });
    try {
      const preview = await service.preview({
        runId: "run-1",
        actionSpecId: "action-1",
        workspaceRoot,
        affectedPaths: ["src/new-name.ts"],
      });

      expect(preview.changedFiles).toEqual([
        {
          path: "src/new-name.ts",
          previousPath: "workspace/src/old-name.ts",
          status: "R",
          allowed: true,
        },
        {
          path: "src/copied.ts",
          previousPath: "workspace/src/source.ts",
          status: "C",
          allowed: false,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores the pre-existing index snapshot when commit fails after staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-git-service-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const calls: GitServiceCommandInput[] = [];
    const service = createGraphGitMilestoneService({
      commandRunner: async (input) => {
        calls.push(input);
        switch (commandKey(input)) {
          case "rev-parse --show-toplevel":
            return gitSuccess(`${root}\n`);
          case "rev-parse --abbrev-ref HEAD":
            return gitSuccess("main\n");
          case "status --porcelain=v1 -z --untracked-files=all":
            return gitSuccess(" M workspace/src/a.ts\0");
          case "write-tree":
            return gitSuccess("tree-before\n");
          case "add -- workspace/src/a.ts":
            return gitSuccess();
          case "read-tree tree-before":
            return gitSuccess();
          default:
            if (input.args[0] === "commit") return gitFailure("commit failed");
            throw new Error(`unexpected git command: ${commandKey(input)}`);
        }
      },
    });
    try {
      await expect(
        service.commit({
          runId: "run-1",
          actionSpecId: "action-1",
          workspaceRoot,
          affectedPaths: ["src/a.ts"],
          message: "Record milestone",
        })
      ).rejects.toThrow("git commit failed");
      expect(calls.map((call) => commandKey(call))).toContain("read-tree tree-before");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe affected paths before staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-git-service-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const calls: GitServiceCommandInput[] = [];
    const service = createGraphGitMilestoneService({
      commandRunner: async (input) => {
        calls.push(input);
        if (commandKey(input) === "rev-parse --show-toplevel") return gitSuccess(`${root}\n`);
        if (commandKey(input) === "rev-parse --abbrev-ref HEAD") return gitSuccess("main\n");
        throw new Error(`unexpected git command: ${commandKey(input)}`);
      },
    });
    try {
      await expect(
        service.commit({
          runId: "run-1",
          actionSpecId: "action-1",
          workspaceRoot,
          affectedPaths: ["../outside.txt"],
          message: "Record milestone",
        })
      ).rejects.toThrow("workspace-relative");
      expect(calls.map((call) => commandKey(call))).not.toContain("add -- ../outside.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function inputCommandName(input: GitServiceCommandInput): string | undefined {
  return input.args[0];
}
