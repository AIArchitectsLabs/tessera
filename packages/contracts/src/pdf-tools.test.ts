import { describe, expect, test } from "bun:test";
import {
  PdfEngineRuntimeSchema,
  PdfExtractResultSchema,
  PdfInspectResultSchema,
  PdfValidateResultSchema,
  TOOL_POLICY_PRESET_DETAILS,
} from "./index.js";

describe("pdf tool contracts", () => {
  test("parses PDF inspect results with engine provenance", () => {
    const result = PdfInspectResultSchema.parse({
      path: "contracts/master.pdf",
      fileType: "pdf",
      bytes: 2048,
      pageCount: 2,
      encrypted: false,
      hasTextLayer: true,
      pagesWithText: [1, 2],
      metadata: {},
      engine: "unpdf",
      engineRuntime: "typescript",
      warnings: [],
    });

    expect(result.pageCount).toBe(2);
    expect(result.engineRuntime).toBe("typescript");
  });

  test("parses PDF extract results with page-scoped text", () => {
    const result = PdfExtractResultSchema.parse({
      path: "contracts/master.pdf",
      fileType: "pdf",
      bytes: 2048,
      text: "Extracted from: master.pdf\nType: PDF\n\n[Page 1]\nHello",
      pages: [{ pageNumber: 1, text: "Hello", charCount: 5, ocr: false }],
      truncated: false,
      engine: "unpdf",
      engineRuntime: "typescript",
      warnings: [],
    });

    expect(result.pages[0]?.ocr).toBe(false);
    expect(result.text).toContain("[Page 1]");
  });

  test("parses PDF validation results", () => {
    const result = PdfValidateResultSchema.parse({
      path: "contracts/master.pdf",
      exists: true,
      fileType: "pdf",
      bytes: 2048,
      pageCount: 1,
      hasTextLayer: true,
      passed: true,
      checks: [
        {
          name: "file_exists",
          passed: true,
          message: "File exists inside the workspace.",
        },
      ],
      engine: "unpdf",
      engineRuntime: "typescript",
      warnings: [],
    });

    expect(result.passed).toBe(true);
  });

  test("keeps Python as an allowed engine runtime without granting execution", () => {
    expect(PdfEngineRuntimeSchema.parse("python")).toBe("python");
  });

  test("exposes read-only PDF tools in every policy preset", () => {
    for (const details of Object.values(TOOL_POLICY_PRESET_DETAILS)) {
      expect(details.allowedTools).toContain("pdf_inspect");
      expect(details.allowedTools).toContain("pdf_extract");
      expect(details.allowedTools).toContain("pdf_validate");
    }
  });
});
