import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceBoundaryError, createWorkspaceGuard } from "./workspace-guard.js";

async function makeWorkspace() {
  const root = await realpath(await mkdtemp("/tmp/tessera-workspace-guard-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  return root;
}

describe("createWorkspaceGuard", () => {
  test("canonicalizes an existing workspace root", async () => {
    const root = await makeWorkspace();
    const guard = await createWorkspaceGuard(join(root, "."));

    expect(guard.root).toBe(root);
  });

  test("rejects a missing workspace root", async () => {
    await expect(createWorkspaceGuard("/tmp/tessera-missing-workspace-root")).rejects.toThrow();
  });

  test("allows paths inside the workspace", async () => {
    const root = await makeWorkspace();
    const guard = await createWorkspaceGuard(root);

    await expect(guard.resolveInsideWorkspace("src/index.ts")).resolves.toBe(
      join(root, "src", "index.ts")
    );
    await expect(guard.isInsideWorkspace("src/index.ts")).resolves.toBe(true);
  });

  test("rejects traversal outside the workspace", async () => {
    const root = await makeWorkspace();
    const outside = join(root, "..", "outside.txt");
    await writeFile(outside, "outside\n");
    const guard = await createWorkspaceGuard(root);

    await expect(guard.resolveInsideWorkspace("../outside.txt")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError
    );
    await expect(guard.isInsideWorkspace("../outside.txt")).resolves.toBe(false);
  });

  test("rejects absolute paths outside the workspace", async () => {
    const root = await makeWorkspace();
    const outside = join(root, "..", "absolute-outside.txt");
    await writeFile(outside, "outside\n");
    const guard = await createWorkspaceGuard(root);

    await expect(guard.resolveInsideWorkspace(outside)).rejects.toBeInstanceOf(
      WorkspaceBoundaryError
    );
  });

  test("rejects symlinks that resolve outside the workspace", async () => {
    const root = await makeWorkspace();
    const outside = join(root, "..", "symlink-outside.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, "src", "outside-link.txt"));
    const guard = await createWorkspaceGuard(root);

    await expect(guard.resolveInsideWorkspace("src/outside-link.txt")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError
    );
  });

  test("allows creating a new file under an existing workspace directory", async () => {
    const root = await makeWorkspace();
    const guard = await createWorkspaceGuard(root);

    await expect(guard.resolveInsideWorkspaceForCreate("src/new-file.ts")).resolves.toBe(
      join(root, "src", "new-file.ts")
    );
  });

  test("allows creating files inside missing nested workspace directories", async () => {
    const root = await makeWorkspace();
    const guard = await createWorkspaceGuard(root);

    await expect(
      guard.resolveInsideWorkspaceForCreate("SEO GEO Blog Article/Briefs/content-brief.md")
    ).resolves.toBe(join(root, "SEO GEO Blog Article", "Briefs", "content-brief.md"));
  });

  test("rejects creating a new file outside the workspace", async () => {
    const root = await makeWorkspace();
    const guard = await createWorkspaceGuard(root);

    await expect(guard.resolveInsideWorkspaceForCreate("../new-file.ts")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError
    );
  });

  test("rejects creating through a missing child of an escaping symlink", async () => {
    const root = await makeWorkspace();
    const outside = join(root, "..", "outside-dir");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, "src", "outside-dir-link"));
    const guard = await createWorkspaceGuard(root);

    await expect(
      guard.resolveInsideWorkspaceForCreate("src/outside-dir-link/new-file.ts")
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });
});
