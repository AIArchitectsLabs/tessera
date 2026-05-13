import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extractPdfText,
  inspectPdfDocument,
  normalizePdfPageRange,
  validatePdfDocument,
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
trailer<< /Root 1 0 R >>
%%EOF`;
}

async function makeFixture() {
  const root = await mkdtemp("/tmp/tessera-pdf-service-");
  const pdfPath = join(root, "sample.pdf");
  await writeFile(pdfPath, samplePdf("Hello PDF"));
  const textPath = join(root, "notes.txt");
  await writeFile(textPath, "plain text");
  return { root, pdfPath, textPath, missingPath: join(root, "missing.pdf") };
}

describe("pdf service", () => {
  test("normalizes undefined page ranges to all pages", () => {
    expect(normalizePdfPageRange(undefined, 3)).toEqual([1, 2, 3]);
  });

  test("normalizes partial and out-of-bounds page ranges", () => {
    expect(normalizePdfPageRange({ start: 2 }, 3)).toEqual([2, 3]);
    expect(normalizePdfPageRange({ end: 2 }, 3)).toEqual([1, 2]);
    expect(normalizePdfPageRange({ start: 4, end: 6 }, 3)).toEqual([]);
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
      engine: "unpdf",
      engineRuntime: "typescript",
      provenance: {
        immutableSource: true,
      },
    });
    expect(result.provenance.createdAt).toEqual(expect.any(String));
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
