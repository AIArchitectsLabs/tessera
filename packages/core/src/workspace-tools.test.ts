import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
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
  await writeFile(
    join(root, "deck.pptx"),
    minimalZip({
      "ppt/slides/slide1.xml": `
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:cSld><p:spTree><p:sp><p:txBody>
            <a:p><a:r><a:t>Pipeline review</a:t></a:r></a:p>
            <a:p><a:r><a:t>Acme renewal risk</a:t></a:r></a:p>
          </p:txBody></p:sp></p:spTree></p:cSld>
        </p:sld>`,
      "ppt/slides/slide2.xml": `
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:cSld><p:spTree><p:sp><p:txBody>
            <a:p><a:r><a:t>Next steps</a:t></a:r></a:p>
          </p:txBody></p:sp></p:spTree></p:cSld>
        </p:sld>`,
    })
  );
  const guard = await createWorkspaceGuard(root);
  return { root, tools: createWorkspaceToolDefinitions(guard) };
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function minimalZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const contentBytes = Buffer.from(content);
    const compressed = deflateRawSync(contentBytes);
    const checksum = crc32(contentBytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contentBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contentBytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
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

    expect(tools.map((item) => item.name)).toEqual([
      "workspace_read",
      "workspace_extract",
      "pdf_inspect",
      "pdf_extract",
      "pdf_validate",
      "workspace_list",
      "workspace_search",
      "workspace_write",
      "workspace_edit",
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

  test("extracts readable content from PDF through dedicated PDF tools", async () => {
    const { tools } = await makeTools();

    const pdf = await tool(tools, "pdf_extract").execute(
      "call-pdf",
      { path: "sample.pdf" },
      undefined,
      undefined,
      undefined as never
    );

    expect(resultText(pdf)).toContain("[Page 1]");
    expect(resultText(pdf)).toContain("Hello PDF");
  });

  test("workspace_extract defers PDF files to dedicated PDF tools", async () => {
    const { tools } = await makeTools();

    await expect(
      tool(tools, "workspace_extract").execute(
        "call-pdf",
        { path: "sample.pdf" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("Use pdf_inspect first");
  });

  test("extracts readable content from DOCX and XLSX files", async () => {
    const { tools } = await makeTools();

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

    expect(resultText(docx)).toContain("Walking on imported air");
    expect(resultText(xlsx)).toContain("[Sheet: Accounts]");
    expect(resultText(xlsx)).toContain("Acme");
  });

  test("workspace_extract extracts readable content from PPTX files", async () => {
    const { tools } = await makeTools();

    const pptx = await tool(tools, "workspace_extract").execute(
      "call-pptx",
      { path: "deck.pptx" },
      undefined,
      undefined,
      undefined as never
    );

    expect(resultText(pptx)).toContain("[Slide 1]");
    expect(resultText(pptx)).toContain("Pipeline review");
    expect(resultText(pptx)).toContain("Acme renewal risk");
    expect(resultText(pptx)).toContain("[Slide 2]");
    expect(resultText(pptx)).toContain("Next steps");
    expect(pptx.details).toMatchObject({
      path: "deck.pptx",
      fileType: "pptx",
    });
  });

  test("workspace_extract honors spreadsheet sheet and row limits", async () => {
    const { tools } = await makeTools();

    const xlsx = await tool(tools, "workspace_extract").execute(
      "call-xlsx",
      { path: "accounts.xlsx", sheet: "Accounts", maxRows: 2 },
      undefined,
      undefined,
      undefined as never
    );

    expect(resultText(xlsx)).toContain("[Sheet: Accounts]");
    expect(resultText(xlsx)).toContain("Acme");
    expect(resultText(xlsx)).not.toContain("Globex");
    expect(resultText(xlsx)).toContain("[1 more rows omitted]");
  });

  test("workspace_extract rejects missing spreadsheet sheets clearly", async () => {
    const { tools } = await makeTools();

    await expect(
      tool(tools, "workspace_extract").execute(
        "call-xlsx",
        { path: "accounts.xlsx", sheet: "Missing" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("Sheet not found: Missing");
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

  test("workspace_read defers PDF files to dedicated PDF tools", async () => {
    const { tools } = await makeTools();

    await expect(
      tool(tools, "workspace_read").execute(
        "call-1",
        { path: "sample.pdf" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("Use pdf_inspect first");
  });

  test("workspace_read truncates large text files with metadata", async () => {
    const { root, tools } = await makeTools();
    const largeText = `${"a".repeat(120_000)}\nlast line should be omitted\n`;
    await writeFile(join(root, "src", "large.log"), largeText);

    const result = await tool(tools, "workspace_read").execute(
      "call-1",
      { path: "src/large.log" },
      undefined,
      undefined,
      undefined as never
    );

    expect(resultText(result).length).toBeLessThan(largeText.length);
    expect(resultText(result)).toContain("[Output truncated]");
    expect(resultText(result)).not.toContain("last line should be omitted");
    expect(result.details).toMatchObject({
      path: "src/large.log",
      bytes: Buffer.byteLength(largeText),
      truncated: true,
      warnings: ["Output truncated to 100000 characters."],
    });
  });

  test("workspace_read can read a later byte window from a large text file", async () => {
    const { root, tools } = await makeTools();
    const firstChunk = "first chunk\n";
    const secondChunk = "second chunk\n";
    await writeFile(join(root, "src", "window.log"), `${firstChunk}${secondChunk}`);

    const result = await tool(tools, "workspace_read").execute(
      "call-1",
      {
        path: "src/window.log",
        offset: Buffer.byteLength(firstChunk),
        maxBytes: Buffer.byteLength(secondChunk),
      },
      undefined,
      undefined,
      undefined as never
    );

    expect(resultText(result)).toBe(secondChunk);
    expect(result.details).toMatchObject({
      path: "src/window.log",
      bytes: Buffer.byteLength(`${firstChunk}${secondChunk}`),
      offset: Buffer.byteLength(firstChunk),
      bytesRead: Buffer.byteLength(secondChunk),
      truncated: false,
    });
  });

  test("workspace_read rejects binary-looking files", async () => {
    const { root, tools } = await makeTools();
    await writeFile(join(root, "src", "image.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));

    await expect(
      tool(tools, "workspace_read").execute(
        "call-1",
        { path: "src/image.bin" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("appears to be binary");
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

  test("workspace_search does not expose PDF text outside the PDF workflow", async () => {
    const { tools } = await makeTools();

    const result = await tool(tools, "workspace_search").execute(
      "call-1",
      { query: "Hello PDF", path: "." },
      undefined,
      undefined,
      undefined as never
    );

    expect(result.content[0]).toEqual({ type: "text", text: "" });
    expect(result.details).toEqual({ query: "Hello PDF", matches: [] });
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
