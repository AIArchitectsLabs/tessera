import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
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

    expect(tools.map((item) => item.name)).toEqual(["pdf_inspect", "pdf_extract", "pdf_validate"]);
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

  test("denies inspection outside the workspace", async () => {
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
        { path: join("/tmp", "outside.pdf") },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_inspect"]);
  });

  test("denies extraction outside the workspace", async () => {
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
        { path: join("/tmp", "outside.pdf") },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/outside.*workspace/i);

    expect(violations).toEqual(["pdf_extract"]);
  });

  test("denies validation outside the workspace", async () => {
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
        { path: join("/tmp", "outside.pdf") },
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
});
