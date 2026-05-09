import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { createWorkspaceGuard } from "./workspace-guard.js";
import { createWorkspaceToolDefinitions } from "./workspace-tools.js";

async function makeTools() {
  const root = await realpath(await mkdtemp("/tmp/tessera-workspace-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(root, "sample.pdf"), samplePdf("Hello PDF"));
  await copyFile(
    fileURLToPath(
      new URL("../node_modules/mammoth/test/test-data/single-paragraph.docx", import.meta.url)
    ),
    join(root, "brief.docx")
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Company", "ARR"],
      ["Acme", 1000],
      ["Globex", 2500],
    ]),
    "Accounts"
  );
  XLSX.writeFile(workbook, join(root, "accounts.xlsx"));
  const guard = await createWorkspaceGuard(root);
  return { root, tools: createWorkspaceToolDefinitions(guard) };
}

function samplePdf(text: string): string {
  return `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length ${text.length + 35} >>stream
BT /F1 24 Tf 100 100 Td (${text}) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
trailer<< /Root 1 0 R >>
%%EOF`;
}

function tool(tools: ReturnType<typeof createWorkspaceToolDefinitions>, name: string) {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (item?.type !== "text" || typeof item.text !== "string") {
    throw new Error("Expected a text tool result");
  }
  return item.text;
}

describe("createWorkspaceToolDefinitions", () => {
  test("registers workspace tools without bash", async () => {
    const { tools } = await makeTools();

    expect(tools.map((item) => item.name).sort()).toEqual([
      "workspace_edit",
      "workspace_extract",
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

  test("extracts readable content from PDF, DOCX, and XLSX files", async () => {
    const { tools } = await makeTools();

    const pdf = await tool(tools, "workspace_extract").execute(
      "call-pdf",
      { path: "sample.pdf" },
      undefined,
      undefined,
      undefined as never
    );
    const docx = await tool(tools, "workspace_extract").execute(
      "call-docx",
      { path: "brief.docx" },
      undefined,
      undefined,
      undefined as never
    );
    const xlsx = await tool(tools, "workspace_extract").execute(
      "call-xlsx",
      { path: "accounts.xlsx" },
      undefined,
      undefined,
      undefined as never
    );

    expect(resultText(pdf)).toContain("[Page 1]");
    expect(resultText(pdf)).toContain("Hello PDF");
    expect(resultText(docx)).toContain("Walking on imported air");
    expect(resultText(xlsx)).toContain("[Sheet: Accounts]");
    expect(resultText(xlsx)).toContain("Acme");
  });

  test("workspace_read routes supported document formats through extraction", async () => {
    const { tools } = await makeTools();

    const result = await tool(tools, "workspace_read").execute(
      "call-1",
      { path: "brief.docx" },
      undefined,
      undefined,
      undefined as never
    );

    expect(resultText(result)).toContain("Extracted from: brief.docx");
    expect(resultText(result)).toContain("Walking on imported air");
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

  test("calls onViolation when a tool is denied outside the workspace", async () => {
    const root = await realpath(await mkdtemp("/tmp/tessera-wt-violation-"));
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createWorkspaceToolDefinitions(guard, {
      onViolation: (toolName) => violations.push(toolName),
    });

    await expect(
      tool(tools, "workspace_write").execute(
        "call-1",
        { path: "../outside.txt", content: "x\n" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("outside the workspace");

    expect(violations).toEqual(["workspace_write"]);
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

  test("denies symlink escape in workspace_search", async () => {
    const { root, tools } = await makeTools();
    const outside = join(root, "..", "symlink-search-target.txt");
    await writeFile(outside, "secret\n");
    await symlink(outside, join(root, "src", "outside-search-link.txt"));

    await expect(
      tool(tools, "workspace_search").execute(
        "call-1",
        { query: "secret", path: "src" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("outside the workspace");
  });

  test("throws when oldText matches more than once in workspace_edit", async () => {
    const { root, tools } = await makeTools();
    await writeFile(join(root, "src", "dup.ts"), "const x = 1;\nconst x2 = 1;\n");

    await expect(
      tool(tools, "workspace_edit").execute(
        "call-1",
        { path: "src/dup.ts", oldText: "1", newText: "2" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("matches 2 times");
  });
});
