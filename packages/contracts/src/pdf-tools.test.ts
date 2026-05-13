import { describe, expect, test } from "bun:test";
import {
  PdfEngineRuntimeSchema,
  PdfExtractResultSchema,
  PdfInspectResultSchema,
  PdfPageRangeSchema,
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
      provenance: {
        createdAt: "2026-05-13T00:00:00.000Z",
        immutableSource: true,
      },
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
      provenance: {
        createdAt: "2026-05-13T00:00:00.000Z",
        immutableSource: true,
      },
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
      provenance: {
        createdAt: "2026-05-13T00:00:00.000Z",
        immutableSource: true,
      },
      warnings: [],
    });

    expect(result.passed).toBe(true);
  });

  test("rejects invalid page ranges", () => {
    expect(PdfPageRangeSchema.safeParse({}).success).toBe(false);
    expect(PdfPageRangeSchema.safeParse({ start: 5, end: 1 }).success).toBe(false);
  });

  test("rejects extra keys and invalid engine runtimes", () => {
    expect(
      PdfInspectResultSchema.safeParse({
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
        provenance: {
          createdAt: "2026-05-13T00:00:00.000Z",
          immutableSource: true,
        },
        warnings: [],
        extra: true,
      }).success
    ).toBe(false);

    expect(PdfEngineRuntimeSchema.safeParse("javascript").success).toBe(false);
  });

  test("keeps Python as an allowed engine runtime without granting execution", () => {
    expect(PdfEngineRuntimeSchema.parse("python")).toBe("python");
  });

  test("exposes read-only PDF tools in every policy preset", () => {
    for (const details of Object.values(TOOL_POLICY_PRESET_DETAILS)) {
      const workspaceExtractIndex = details.allowedTools.indexOf("workspace_extract");
      expect(workspaceExtractIndex).toBeGreaterThanOrEqual(0);
      expect(
        details.allowedTools.slice(workspaceExtractIndex + 1, workspaceExtractIndex + 4)
      ).toEqual(["pdf_inspect", "pdf_extract", "pdf_validate"]);
    }
  });
});
