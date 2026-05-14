import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPdfToolDefinitions } from "./pdf-tools.js";
import { createWorkspaceGuard } from "./workspace-guard.js";

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

async function makeFixture() {
  const root = await realpath(await mkdtemp("/tmp/tessera-pdf-tools-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "sample.pdf"), samplePdf("Hello PDF"));
  return { root };
}

const outsideMissingParentPath = join("/tmp", "tessera-pdf-tools-missing-parent", "outside.pdf");

function tool(tools: ReturnType<typeof createPdfToolDefinitions>, name: string) {
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

describe("createPdfToolDefinitions", () => {
  test("registers pdf tools in actual order", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);

    const tools = createPdfToolDefinitions(guard);

    expect(tools.map((item) => item.name)).toEqual([
      "pdf_capabilities",
      "pdf_inspect",
      "pdf_extract",
      "pdf_validate",
      "pdf_render",
      "pdf_transform",
      "pdf_manifest",
    ]);
  });

  test("reports PDF capabilities without requiring a workspace PDF", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const tools = createPdfToolDefinitions(guard, {
      binaryRunner: async ({ command }) => {
        if (command === "tessera-pdf-render") {
          return { stdout: "tessera-pdf-render 1.0.0", stderr: "" };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    const capabilities = await tool(tools, "pdf_capabilities").execute(
      "call-capabilities",
      {},
      undefined,
      undefined,
      undefined as never
    );

    expect(JSON.parse(resultText(capabilities))).toMatchObject({
      tools: [
        { name: "pdf_inspect", available: true },
        { name: "pdf_extract", available: true },
        { name: "pdf_validate", available: true },
        { name: "pdf_render", available: true },
        { name: "pdf_transform", available: true },
        { name: "pdf_manifest", available: true },
      ],
    });
  });

  test("inspects, extracts, and validates a workspace PDF", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const tools = createPdfToolDefinitions(guard);

    const inspected = await tool(tools, "pdf_inspect").execute(
      "call-inspect",
      { path: "docs/sample.pdf" },
      undefined,
      undefined,
      undefined as never
    );
    const extracted = await tool(tools, "pdf_extract").execute(
      "call-extract",
      { path: "docs/sample.pdf" },
      undefined,
      undefined,
      undefined as never
    );
    const validated = await tool(tools, "pdf_validate").execute(
      "call-validate",
      { path: "docs/sample.pdf" },
      undefined,
      undefined,
      undefined as never
    );

    expect(JSON.parse(resultText(inspected))).toMatchObject({
      path: "docs/sample.pdf",
      pageCount: 1,
      hasTextLayer: true,
    });
    expect(resultText(extracted)).toContain("Hello PDF");
    expect(JSON.parse(resultText(validated))).toMatchObject({
      path: "docs/sample.pdf",
      passed: true,
    });
  });

  test("denies inspection for an outside path with a missing parent directory", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createPdfToolDefinitions(guard, {
      onViolation(toolName) {
        violations.push(toolName);
      },
    });

    await expect(
      tool(tools, "pdf_inspect").execute(
        "call-denied",
        { path: outsideMissingParentPath },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_inspect"]);
  });

  test("denies extraction for an outside path with a missing parent directory", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createPdfToolDefinitions(guard, {
      onViolation(toolName) {
        violations.push(toolName);
      },
    });

    await expect(
      tool(tools, "pdf_extract").execute(
        "call-denied",
        { path: outsideMissingParentPath },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_extract"]);
  });

  test("denies validation for an outside path with a missing parent directory", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createPdfToolDefinitions(guard, {
      onViolation(toolName) {
        violations.push(toolName);
      },
    });

    await expect(
      tool(tools, "pdf_validate").execute(
        "call-denied",
        { path: outsideMissingParentPath },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_validate"]);
  });

  test("validates a missing workspace PDF without throwing", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const tools = createPdfToolDefinitions(guard);

    const validated = await tool(tools, "pdf_validate").execute(
      "call-missing",
      { path: "docs/missing.pdf" },
      undefined,
      undefined,
      undefined as never
    );

    expect(JSON.parse(resultText(validated))).toMatchObject({
      path: "docs/missing.pdf",
      exists: false,
      passed: false,
    });
  });

  test("renders a workspace PDF to a workspace output directory", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const tools = createPdfToolDefinitions(guard, {
      binaryRunner: async ({ args }) => {
        const outputPrefix = args.at(-1);
        if (typeof outputPrefix !== "string") throw new Error("missing output prefix");
        await writeFile(`${outputPrefix}-1.png`, Buffer.from("png"));
        return { stdout: "", stderr: "" };
      },
      dimensionsReader: async () => ({ width: 612, height: 792 }),
    });

    const rendered = await tool(tools, "pdf_render").execute(
      "call-render",
      { path: "docs/sample.pdf", outputDir: "renders", pages: { start: 1, end: 1 } },
      undefined,
      undefined,
      undefined as never
    );

    expect(JSON.parse(resultText(rendered))).toMatchObject({
      path: "docs/sample.pdf",
      outputs: [{ pageNumber: 1, path: "renders/sample-page-1.png", width: 612, height: 792 }],
    });
  });

  test("transforms a workspace PDF to a workspace output path", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const tools = createPdfToolDefinitions(guard, {
      binaryRunner: async ({ args }) => {
        const outputPath = args.at(-1);
        if (typeof outputPath !== "string") throw new Error("missing output path");
        await writeFile(outputPath, samplePdf("Rotated"));
        return { stdout: "", stderr: "" };
      },
    });

    const transformed = await tool(tools, "pdf_transform").execute(
      "call-transform",
      {
        operation: "rotate",
        sources: [{ path: "docs/sample.pdf" }],
        outputPath: "out/rotated.pdf",
        rotation: { degrees: 90, pages: { start: 1, end: 1 } },
      },
      undefined,
      undefined,
      undefined as never
    );

    expect(JSON.parse(resultText(transformed))).toMatchObject({
      outputPath: "out/rotated.pdf",
      operation: "rotate",
      sourcePaths: ["docs/sample.pdf"],
      pageMapping: [{ sourcePath: "docs/sample.pdf", sourcePage: 1, outputPage: 1 }],
    });
  });

  test("writes a PDF packet manifest to a workspace output path", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const tools = createPdfToolDefinitions(guard);
    const inspected = await tool(tools, "pdf_inspect").execute(
      "call-inspect",
      { path: "docs/sample.pdf" },
      undefined,
      undefined,
      undefined as never
    );
    const validated = await tool(tools, "pdf_validate").execute(
      "call-validate",
      { path: "docs/sample.pdf", expectedPageCount: 1 },
      undefined,
      undefined,
      undefined as never
    );

    const manifested = await tool(tools, "pdf_manifest").execute(
      "call-manifest",
      {
        packetId: "packet-1",
        title: "Sample packet",
        outputPath: "out/packet-manifest.json",
        operations: [
          {
            operationId: "inspect-1",
            kind: "inspect",
            result: JSON.parse(resultText(inspected)),
          },
        ],
        validations: [JSON.parse(resultText(validated))],
        warnings: [{ code: "manual_review", message: "Review the source PDF." }],
      },
      undefined,
      undefined,
      undefined as never
    );
    const persisted = JSON.parse(await readFile(join(root, "out", "packet-manifest.json"), "utf8"));

    expect(JSON.parse(resultText(manifested))).toMatchObject({
      packetId: "packet-1",
      outputPath: "out/packet-manifest.json",
      title: "Sample packet",
      sourcePaths: ["docs/sample.pdf"],
      summary: {
        operationCount: 1,
        validationCount: 1,
        failedValidationCount: 0,
        warningCount: 1,
      },
    });
    expect(persisted.packetId).toBe("packet-1");
  });

  test("denies render output directories outside the workspace", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createPdfToolDefinitions(guard, {
      onViolation(toolName) {
        violations.push(toolName);
      },
    });

    await expect(
      tool(tools, "pdf_render").execute(
        "call-denied",
        { path: "docs/sample.pdf", outputDir: "/tmp/tessera-outside-render" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_render"]);
  });

  test("denies transform output paths outside the workspace", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createPdfToolDefinitions(guard, {
      onViolation(toolName) {
        violations.push(toolName);
      },
    });

    await expect(
      tool(tools, "pdf_transform").execute(
        "call-denied",
        {
          operation: "rotate",
          sources: [{ path: "docs/sample.pdf" }],
          outputPath: "/tmp/tessera-outside-transform.pdf",
          rotation: { degrees: 90 },
        },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_transform"]);
  });

  test("denies manifest output paths outside the workspace", async () => {
    const { root } = await makeFixture();
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createPdfToolDefinitions(guard, {
      onViolation(toolName) {
        violations.push(toolName);
      },
    });

    await expect(
      tool(tools, "pdf_manifest").execute(
        "call-denied",
        {
          packetId: "packet-1",
          outputPath: "/tmp/tessera-outside-manifest.json",
          operations: [],
        },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_manifest"]);
  });
});
