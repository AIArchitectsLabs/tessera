import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PdfPageRange } from "@tessera/contracts";
import { createOptionalCapabilityManager } from "./optional-capabilities.js";
import {
  createPdfDocument,
  extractPdfText,
  getPdfCapabilities,
  inspectPdfDocument,
  normalizePdfPageRange,
  renderPdfPages,
  transformPdfDocument,
  validatePdfDocument,
  writePdfPacketManifest,
} from "./pdf-service.js";

function samplePdf(text: string): string {
  return `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length ${text.length + 35} >>stream
BT /F1 24 Tf 100 100 Td (${text}) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
6 0 obj<< /Title (Sample Report) /Author (Tessera) >>endobj
trailer<< /Root 1 0 R /Info 6 0 R >>
%%EOF`;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lWf8UwAAAABJRU5ErkJggg==",
  "base64"
);

async function makeFixture() {
  const root = await mkdtemp("/tmp/tessera-pdf-service-");
  const pdfPath = join(root, "sample.pdf");
  await writeFile(pdfPath, samplePdf("Hello PDF"));
  const blankPdfPath = join(root, "blank.pdf");
  await writeFile(blankPdfPath, samplePdf(""));
  const longPdfPath = join(root, "long.pdf");
  await writeFile(longPdfPath, samplePdf("Hello PDF ".repeat(50)));
  const textPath = join(root, "notes.txt");
  await writeFile(textPath, "plain text");
  return {
    root,
    pdfPath,
    blankPdfPath,
    longPdfPath,
    textPath,
    missingPath: join(root, "missing.pdf"),
  };
}

describe("pdf service", () => {
  test("reports bundled transform and optional render capability readiness", async () => {
    const result = await getPdfCapabilities({
      binaryRunner: async ({ command }) => {
        if (command === "tessera-pdf-render") {
          return { stdout: "tessera-pdf-render 1.0.0", stderr: "" };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    expect(result.tools).toEqual([
      {
        name: "pdf_inspect",
        available: true,
        requiredEngines: ["unpdf"],
      },
      {
        name: "pdf_extract",
        available: true,
        requiredEngines: ["unpdf"],
      },
      {
        name: "pdf_validate",
        available: true,
        requiredEngines: ["unpdf"],
      },
      {
        name: "pdf_render",
        available: true,
        requiredEngines: ["tessera-pdf-render"],
      },
      {
        name: "pdf_transform",
        available: true,
        requiredEngines: ["pdf-lib"],
      },
      {
        name: "pdf_create",
        available: true,
        requiredEngines: ["pdf-lib"],
      },
      {
        name: "pdf_manifest",
        available: true,
        requiredEngines: [],
      },
    ]);
    expect(result.engines).toContainEqual({
      engine: "tessera-pdf-render",
      engineRuntime: "binary",
      available: true,
      command: "tessera-pdf-render",
      version: "tessera-pdf-render 1.0.0",
      provides: ["pdf_render"],
    });
    expect(result.engines).toContainEqual({
      engine: "pdf-lib",
      engineRuntime: "typescript",
      available: true,
      provides: ["pdf_transform", "pdf_create"],
      message: "TypeScript PDF transforms and creation are bundled.",
    });
    expect(result.warnings).toEqual([]);
  });

  test("reports missing binary PDF engines without throwing", async () => {
    const result = await getPdfCapabilities({
      binaryRunner: async ({ command }) => {
        if (command === "tessera-pdf-render") {
          const error = new Error("missing");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        return { stdout: "", stderr: "" };
      },
    });

    expect(result.tools).toContainEqual({
      name: "pdf_render",
      available: false,
      requiredEngines: ["tessera-pdf-render"],
      message: "PDF engine unavailable: tessera-pdf-render",
    });
    expect(result.warnings).toContainEqual({
      code: "engine_unavailable",
      message: "A PDF render engine is unavailable; pdf_render cannot run.",
    });
  });

  test("normalizes undefined page ranges to all pages", () => {
    expect(normalizePdfPageRange(undefined, 3)).toEqual([1, 2, 3]);
  });

  test("normalizes partial and out-of-bounds page ranges", () => {
    expect(normalizePdfPageRange({ start: 2 }, 3)).toEqual([2, 3]);
    expect(normalizePdfPageRange({ end: 2 }, 3)).toEqual([1, 2]);
    expect(normalizePdfPageRange({ start: 4, end: 6 }, 3)).toEqual([]);
  });

  test("floors fractional page bounds", () => {
    const fractionalRange = { start: 1.2, end: 2.8 } as unknown as PdfPageRange;

    expect(normalizePdfPageRange(fractionalRange, 3)).toEqual([1, 2]);
  });

  test("inspects a simple text-layer PDF", async () => {
    const { pdfPath } = await makeFixture();

    const result = await inspectPdfDocument(pdfPath);

    expect(result).toMatchObject({
      path: "sample.pdf",
      fileType: "pdf",
      pageCount: 1,
      encrypted: false,
      hasTextLayer: true,
      pagesWithText: [1],
      metadata: {
        Author: "Tessera",
        PDFFormatVersion: "1.1",
        Title: "Sample Report",
      },
      engine: "unpdf",
      engineRuntime: "typescript",
      provenance: {
        immutableSource: true,
      },
    });
    expect(result.provenance.createdAt).toEqual(expect.any(String));
  });

  test("honors displayPath when inspecting and extracting", async () => {
    const { pdfPath } = await makeFixture();

    const inspected = await inspectPdfDocument(pdfPath, { displayPath: "reports/sample.pdf" });
    const extracted = await extractPdfText(pdfPath, { displayPath: "reports/sample.pdf" });

    expect(inspected.path).toBe("reports/sample.pdf");
    expect(extracted.path).toBe("reports/sample.pdf");
  });

  test("extracts page-scoped text with page metadata", async () => {
    const { pdfPath } = await makeFixture();

    const result = await extractPdfText(pdfPath, { pages: { start: 1, end: 1 } });

    expect(result.text).toBe("Extracted from: sample.pdf\nType: PDF\n\n[Page 1]\nHello PDF");
    expect(result.pages).toEqual([
      {
        pageNumber: 1,
        text: "Hello PDF",
        charCount: 9,
        ocr: false,
      },
    ]);
    expect(result.provenance).toMatchObject({
      immutableSource: true,
    });
    expect(result.provenance.createdAt).toEqual(expect.any(String));
  });

  test("extracts header-only text with an out-of-range page selection", async () => {
    const { pdfPath } = await makeFixture();

    const result = await extractPdfText(pdfPath, { pages: { start: 4, end: 6 } });

    expect(result.pages).toEqual([]);
    expect(result.text).toBe("Extracted from: sample.pdf\nType: PDF\n\n");
    expect(result.warnings).toEqual([
      {
        code: "page_range_out_of_bounds",
        message: "Requested page range does not overlap the PDF.",
      },
    ]);
  });

  test("truncates extracted text when maxChars is low", async () => {
    const { longPdfPath } = await makeFixture();

    const result = await extractPdfText(longPdfPath, { maxChars: 32 });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(32);
    expect(result.warnings).toContainEqual({
      code: "output_truncated",
      message: "Output truncated to 32 characters.",
    });
  });

  test("reports no_text_layer for a blank synthetic PDF", async () => {
    const { blankPdfPath } = await makeFixture();

    const result = await inspectPdfDocument(blankPdfPath);

    expect(result.hasTextLayer).toBe(false);
    expect(result.pagesWithText).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "no_text_layer",
        message: "No extractable text layer was found. OCR may be required for scanned pages.",
      },
    ]);
  });

  test("validates a PDF with expected page and text checks", async () => {
    const { pdfPath } = await makeFixture();

    const result = await validatePdfDocument(pdfPath, {
      expectedPageCount: 1,
      expectedTextPresent: true,
    });

    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      "file_exists",
      "page_count",
      "text_present",
    ]);
    expect(result.provenance).toMatchObject({
      immutableSource: true,
    });
    expect(result.provenance.createdAt).toEqual(expect.any(String));
  });

  test("renders selected pages with an injected binary runner", async () => {
    const { root, pdfPath } = await makeFixture();

    const result = await renderPdfPages(pdfPath, {
      outputDir: join(root, "renders"),
      pages: { start: 1, end: 1 },
      binaryRunner: async ({ args }) => {
        const outputPrefix = args.at(-1);
        if (typeof outputPrefix !== "string") throw new Error("missing output prefix");
        await writeFile(`${outputPrefix}-1.png`, Buffer.from("png"));
        return { stdout: "", stderr: "" };
      },
      dimensionsReader: async () => ({ width: 612, height: 792 }),
    });

    expect(result).toMatchObject({
      path: "sample.pdf",
      fileType: "pdf",
      outputs: [
        {
          pageNumber: 1,
          path: "sample-page-1.png",
          format: "png",
          width: 612,
          height: 792,
        },
      ],
      engine: "tessera-pdf-render",
      engineRuntime: "binary",
      provenance: { immutableSource: true },
    });
    expect(result.provenance.createdAt).toEqual(expect.any(String));
  });

  test("installs a managed render engine on first use when the path binary is missing", async () => {
    const { root, pdfPath } = await makeFixture();
    const payload = Buffer.from("#!/bin/sh\necho tessera-pdf-render\n");
    const capabilityManager = createOptionalCapabilityManager({
      rootDir: join(root, "capabilities"),
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "pdf-render",
          label: "PDF render engine",
          version: "1.0.0",
          binaries: [{ name: "tessera-pdf-render", relativePath: "tessera-pdf-render" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/tessera-pdf-render",
              sha256: sha256(payload),
              executableName: "tessera-pdf-render",
            },
          ],
        },
      ],
      download: async () => payload,
    });
    const commands: string[] = [];

    const result = await renderPdfPages(pdfPath, {
      outputDir: join(root, "renders"),
      pages: { start: 1, end: 1 },
      capabilityManager,
      binaryRunner: async ({ command, args }) => {
        commands.push(command);
        if (command === "tessera-pdf-render") {
          const error = new Error("missing");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        const outputPrefix = args.at(-1);
        if (typeof outputPrefix !== "string") throw new Error("missing output prefix");
        await writeFile(`${outputPrefix}-1.png`, Buffer.from("png"));
        return { stdout: "", stderr: "" };
      },
      dimensionsReader: async () => ({ width: 612, height: 792 }),
    });

    expect(commands).toEqual([
      join(root, "capabilities", "pdf-render", "1.0.0", "tessera-pdf-render"),
    ]);
    expect(result.outputs[0]?.path).toBe("sample-page-1.png");
  });

  test("installs an available managed render engine before falling back to PATH", async () => {
    const { root, pdfPath } = await makeFixture();
    const payload = Buffer.from("#!/bin/sh\necho tessera-pdf-render\n");
    const capabilityManager = createOptionalCapabilityManager({
      rootDir: join(root, "capabilities"),
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "pdf-render",
          label: "PDF render engine",
          version: "1.0.0",
          binaries: [{ name: "tessera-pdf-render", relativePath: "tessera-pdf-render" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/tessera-pdf-render",
              sha256: sha256(payload),
              executableName: "tessera-pdf-render",
            },
          ],
        },
      ],
      download: async () => payload,
    });
    const commands: string[] = [];

    const result = await renderPdfPages(pdfPath, {
      outputDir: join(root, "renders"),
      pages: { start: 1, end: 1 },
      capabilityManager,
      binaryRunner: async ({ command, args }) => {
        commands.push(command);
        if (command === "tessera-pdf-render") {
          throw new Error("PATH fallback should not run when managed install is available");
        }
        const outputPrefix = args.at(-1);
        if (typeof outputPrefix !== "string") throw new Error("missing output prefix");
        await writeFile(`${outputPrefix}-1.png`, Buffer.from("png"));
        return { stdout: "", stderr: "" };
      },
      dimensionsReader: async () => ({ width: 612, height: 792 }),
    });

    expect(commands).toEqual([
      join(root, "capabilities", "pdf-render", "1.0.0", "tessera-pdf-render"),
    ]);
    expect(result.outputs[0]?.path).toBe("sample-page-1.png");
  });

  test("creates a rotated PDF output with the bundled TypeScript transform engine", async () => {
    const { root, pdfPath } = await makeFixture();
    await mkdir(join(root, "out"), { recursive: true });
    const outputPath = join(root, "out", "rotated.pdf");

    const result = await transformPdfDocument({
      operation: "rotate",
      sources: [{ path: pdfPath }],
      outputPath,
      rotation: { degrees: 90, pages: { start: 1, end: 1 } },
      binaryRunner: async ({ command }) => {
        throw new Error(`unexpected binary transform command ${command}`);
      },
    });

    await expect(readFile(outputPath)).resolves.toEqual(expect.any(Buffer));
    expect(result).toMatchObject({
      outputPath: "rotated.pdf",
      fileType: "pdf",
      operation: "rotate",
      sourcePaths: ["sample.pdf"],
      pageMapping: [{ sourcePath: "sample.pdf", sourcePage: 1, outputPage: 1 }],
      engine: "pdf-lib",
      engineRuntime: "typescript",
      provenance: { immutableSource: true },
    });
    expect(result.provenance.createdAt).toEqual(expect.any(String));
  });

  test("creates a simple business PDF with text, tables, page breaks, images, and source provenance", async () => {
    const { root } = await makeFixture();
    const imagePath = join(root, "chart.png");
    await writeFile(imagePath, onePixelPng);
    const outputPath = join(root, "out", "brief.pdf");

    const result = await createPdfDocument({
      outputPath,
      displayOutputPath: "out/brief.pdf",
      title: "Quarterly Brief",
      sourcePaths: ["docs/source.md", "chart.png"],
      blocks: [
        { type: "heading", text: "Quarterly Brief", level: 1 },
        { type: "text", text: "Revenue grew while expenses stayed flat." },
        {
          type: "table",
          headers: ["Metric", "Value"],
          rows: [
            ["Revenue", "$1.2M"],
            ["Expenses", "$800K"],
          ],
        },
        { type: "image", path: imagePath, displayPath: "chart.png", width: 48, height: 48 },
        { type: "pageBreak" },
        { type: "heading", text: "Source Notes", level: 2 },
        { type: "text", text: "Prepared from finance workbook and chart export." },
      ],
    });
    const inspected = await inspectPdfDocument(outputPath, { displayPath: "out/brief.pdf" });
    const extracted = await extractPdfText(outputPath, { maxChars: 2000 });

    expect(result).toMatchObject({
      outputPath: "out/brief.pdf",
      fileType: "pdf",
      pageCount: 2,
      sourcePaths: ["docs/source.md", "chart.png"],
      engine: "pdf-lib",
      engineRuntime: "typescript",
      provenance: { immutableSource: true },
    });
    expect(result.provenance.createdAt).toEqual(expect.any(String));
    expect(inspected.pageCount).toBe(2);
    expect(extracted.text).toContain("Quarterly Brief");
    expect(extracted.text).toContain("Revenue");
    await expect(readFile(outputPath)).resolves.toEqual(expect.any(Buffer));
  });

  test("writes a packet manifest with summary counts", async () => {
    const { root, pdfPath } = await makeFixture();
    const outputPath = join(root, "out", "packet-manifest.json");

    const manifest = await writePdfPacketManifest({
      packetId: "packet-1",
      title: "Packet 1",
      outputPath,
      displayOutputPath: "out/packet-manifest.json",
      operations: [
        {
          operationId: "inspect-1",
          kind: "inspect",
          result: await inspectPdfDocument(pdfPath, {
            displayPath: "sample.pdf",
          }),
        },
      ],
      validations: [
        await validatePdfDocument(pdfPath, {
          displayPath: "sample.pdf",
          expectedPageCount: 1,
        }),
      ],
      warnings: [{ code: "manual_review", message: "Review terms manually." }],
    });
    const persisted = JSON.parse(await readFile(outputPath, "utf8"));

    expect(manifest).toMatchObject({
      manifestVersion: 1,
      packetId: "packet-1",
      outputPath: "out/packet-manifest.json",
      title: "Packet 1",
      sourcePaths: ["sample.pdf"],
      artifactPaths: [],
      summary: {
        operationCount: 1,
        validationCount: 1,
        failedValidationCount: 0,
        warningCount: 1,
      },
    });
    expect(persisted).toEqual(manifest);
    expect(manifest.provenance.createdAt).toEqual(expect.any(String));
  });

  test("returns a missing-file validation result without throwing", async () => {
    const { missingPath } = await makeFixture();

    const result = await validatePdfDocument(missingPath, {});

    expect(result.exists).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "file_exists",
      passed: false,
    });
  });

  test("rejects non-PDF files for inspection", async () => {
    const { textPath } = await makeFixture();

    expect(inspectPdfDocument(textPath)).rejects.toThrow("Unsupported PDF input");
  });
});
