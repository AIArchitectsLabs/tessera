import { describe, expect, test } from "bun:test";
import {
  PdfCapabilitiesResultSchema,
  PdfEngineRuntimeSchema,
  PdfExtractResultSchema,
  PdfInspectResultSchema,
  PdfPacketManifestSchema,
  PdfPageRangeSchema,
  PdfRenderResultSchema,
  PdfTransformResultSchema,
  PdfValidateResultSchema,
  TOOL_POLICY_PRESET_DETAILS,
} from "./index.js";

describe("pdf tool contracts", () => {
  test("parses PDF capability readiness results", () => {
    const result = PdfCapabilitiesResultSchema.parse({
      engines: [
        {
          engine: "unpdf",
          engineRuntime: "typescript",
          available: true,
          provides: ["pdf_inspect", "pdf_extract", "pdf_validate"],
          message: "TypeScript PDF text extraction is bundled.",
        },
        {
          engine: "tessera-pdf-render",
          engineRuntime: "binary",
          available: false,
          command: "tessera-pdf-render",
          provides: ["pdf_render"],
          message: "PDF engine unavailable: tessera-pdf-render",
          install: {
            capabilityId: "pdf-render",
            available: true,
            installed: false,
            version: "1.0.0",
            sizeBytes: 42_000_000,
          },
        },
      ],
      tools: [
        {
          name: "pdf_render",
          available: false,
          requiredEngines: ["tessera-pdf-render"],
          message: "Install a PDF render engine before rendering PDF pages.",
        },
      ],
      warnings: [
        {
          code: "engine_unavailable",
          message: "A PDF render engine is unavailable; pdf_render cannot run.",
        },
      ],
    });

    expect(result.tools[0]?.available).toBe(false);
    expect(result.engines[0]?.engineRuntime).toBe("typescript");
  });

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

  test("parses PDF render results with generated page images", () => {
    const result = PdfRenderResultSchema.parse({
      path: "contracts/master.pdf",
      fileType: "pdf",
      outputs: [
        {
          pageNumber: 1,
          path: "renders/master-page-1.png",
          format: "png",
          width: 612,
          height: 792,
        },
      ],
      engine: "tessera-pdf-render",
      engineRuntime: "binary",
      provenance: {
        createdAt: "2026-05-14T00:00:00.000Z",
        immutableSource: true,
      },
      warnings: [],
    });

    expect(result.outputs[0]?.path).toBe("renders/master-page-1.png");
    expect(result.engineRuntime).toBe("binary");
  });

  test("parses PDF transform results with source mapping", () => {
    const result = PdfTransformResultSchema.parse({
      outputPath: "out/packet.pdf",
      fileType: "pdf",
      operation: "merge",
      sourcePaths: ["a.pdf", "b.pdf"],
      pageMapping: [
        { sourcePath: "a.pdf", sourcePage: 1, outputPage: 1 },
        { sourcePath: "b.pdf", sourcePage: 1, outputPage: 2 },
      ],
      engine: "pdf-lib",
      engineRuntime: "typescript",
      provenance: {
        createdAt: "2026-05-14T00:00:00.000Z",
        immutableSource: true,
      },
      warnings: [],
    });

    expect(result.operation).toBe("merge");
    expect(result.pageMapping).toHaveLength(2);
  });

  test("parses PDF packet manifests with operation summaries", () => {
    const result = PdfPacketManifestSchema.parse({
      manifestVersion: 1,
      packetId: "packet-2026-05-14",
      outputPath: "out/packet-manifest.json",
      title: "Board packet assembly",
      sourcePaths: ["docs/a.pdf", "docs/b.pdf"],
      artifactPaths: ["out/packet.pdf"],
      operations: [
        {
          operationId: "op-1",
          kind: "transform",
          result: {
            outputPath: "out/packet.pdf",
            fileType: "pdf",
            operation: "merge",
            sourcePaths: ["docs/a.pdf", "docs/b.pdf"],
            pageMapping: [
              { sourcePath: "docs/a.pdf", sourcePage: 1, outputPage: 1 },
              { sourcePath: "docs/b.pdf", sourcePage: 1, outputPage: 2 },
            ],
            engine: "pdf-lib",
            engineRuntime: "typescript",
            provenance: {
              createdAt: "2026-05-14T00:00:00.000Z",
              immutableSource: true,
            },
            warnings: [],
          },
        },
      ],
      validations: [
        {
          path: "out/packet.pdf",
          exists: true,
          fileType: "pdf",
          bytes: 2048,
          pageCount: 2,
          hasTextLayer: true,
          passed: true,
          checks: [{ name: "file_exists", passed: true, message: "PDF file exists." }],
          engine: "unpdf",
          engineRuntime: "typescript",
          provenance: {
            createdAt: "2026-05-14T00:00:00.000Z",
            immutableSource: true,
          },
          warnings: [],
        },
      ],
      warnings: [{ code: "manual_review", message: "Signature page needs review." }],
      summary: {
        operationCount: 1,
        validationCount: 1,
        failedValidationCount: 0,
        warningCount: 1,
      },
      provenance: {
        createdAt: "2026-05-14T00:00:00.000Z",
        immutableSource: true,
      },
    });

    expect(result.summary.operationCount).toBe(1);
    expect(result.artifactPaths).toEqual(["out/packet.pdf"]);
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

  test("exposes PDF tools in every policy preset", () => {
    for (const details of Object.values(TOOL_POLICY_PRESET_DETAILS)) {
      const workspaceExtractIndex = details.allowedTools.indexOf("workspace_extract");
      expect(workspaceExtractIndex).toBeGreaterThanOrEqual(0);
      expect(
        details.allowedTools.slice(workspaceExtractIndex + 1, workspaceExtractIndex + 8)
      ).toEqual([
        "pdf_capabilities",
        "pdf_inspect",
        "pdf_extract",
        "pdf_validate",
        "pdf_render",
        "pdf_transform",
        "pdf_manifest",
      ]);
    }
  });
});
