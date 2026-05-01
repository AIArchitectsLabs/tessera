import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceGuard } from "./workspace-guard.js";
import { createWorkspaceToolDefinitions } from "./workspace-tools.js";

async function makeTools() {
  const root = await realpath(await mkdtemp("/tmp/tessera-workspace-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  const guard = await createWorkspaceGuard(root);
  return { root, tools: createWorkspaceToolDefinitions(guard) };
}

function tool(tools: ReturnType<typeof createWorkspaceToolDefinitions>, name: string) {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

describe("createWorkspaceToolDefinitions", () => {
  test("registers workspace tools without bash", async () => {
    const { tools } = await makeTools();

    expect(tools.map((item) => item.name).sort()).toEqual([
      "workspace_edit",
      "workspace_list",
      "workspace_read",
      "workspace_search",
      "workspace_write",
    ]);
  });

  test("reads and lists files inside the workspace", async () => {
    const { tools } = await makeTools();

    const read = await tool(tools, "workspace_read").execute(
      "call-1",
      { path: "src/index.ts" },
      undefined,
      undefined,
      undefined as never
    );
    const list = await tool(tools, "workspace_list").execute(
      "call-2",
      { path: "src" },
      undefined,
      undefined,
      undefined as never
    );

    expect(read.content[0]).toEqual({ type: "text", text: "export const value = 1;\n" });
    expect(list.content[0]).toEqual({ type: "text", text: "index.ts" });
  });

  test("searches inside the workspace", async () => {
    const { tools } = await makeTools();

    const result = await tool(tools, "workspace_search").execute(
      "call-1",
      { query: "value", path: "." },
      undefined,
      undefined,
      undefined as never
    );

    expect(result.content[0]).toEqual({ type: "text", text: "src/index.ts" });
  });

  test("writes and edits files inside the workspace without extra approval", async () => {
    const { root, tools } = await makeTools();

    await tool(tools, "workspace_write").execute(
      "call-1",
      { path: "src/new.ts", content: "const label = 'draft';\n" },
      undefined,
      undefined,
      undefined as never
    );
    await tool(tools, "workspace_edit").execute(
      "call-2",
      { path: "src/new.ts", oldText: "draft", newText: "final" },
      undefined,
      undefined,
      undefined as never
    );

    await expect(readFile(join(root, "src", "new.ts"), "utf8")).resolves.toBe(
      "const label = 'final';\n"
    );
  });

  test("denies writes outside the workspace", async () => {
    const { root, tools } = await makeTools();
    await writeFile(join(root, "..", "outside.txt"), "outside\n");

    await expect(
      tool(tools, "workspace_write").execute(
        "call-1",
        { path: "../outside.txt", content: "changed\n" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("outside the workspace");
  });

  test("denies symlink escape reads", async () => {
    const { root, tools } = await makeTools();
    const outside = join(root, "..", "symlink-target.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, "src", "outside-link.txt"));

    await expect(
      tool(tools, "workspace_read").execute(
        "call-1",
        { path: "src/outside-link.txt" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("outside the workspace");
  });
});
