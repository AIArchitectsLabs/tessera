import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  type PdfExtractResult,
  PdfExtractResultSchema,
  type PdfInspectResult,
  PdfInspectResultSchema,
  type PdfPageRange,
  type PdfValidateResult,
  PdfValidateResultSchema,
} from "@tessera/contracts";
import { extractText } from "unpdf";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 100_000;
const NO_TEXT_LAYER_WARNING = {
  code: "no_text_layer",
  message: "No extractable text layer was found. OCR may be required for scanned pages.",
} as const;

export interface PdfDocumentOptions {
  displayPath?: string;
}

export interface PdfExtractOptions extends PdfDocumentOptions {
  pages?: PdfPageRange;
  maxChars?: number;
}

export interface PdfValidateOptions extends PdfDocumentOptions {
  expectedPageCount?: number;
  expectedTextPresent?: boolean;
}

export function normalizePdfPageRange(
  range: PdfPageRange | undefined,
  pageCount: number
): number[] {
  if (pageCount <= 0) return [];
  if (range === undefined) {
    return Array.from({ length: pageCount }, (_value, index) => index + 1);
  }

  const start = Math.max(1, range.start ?? 1);
  const end = Math.min(pageCount, range.end ?? pageCount);
  if (start > end) return [];

  return Array.from({ length: end - start + 1 }, (_value, index) => start + index);
}

export async function inspectPdfDocument(
  path: string,
  options: PdfDocumentOptions = {}
): Promise<PdfInspectResult> {
  assertPdfInput(path);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Path is not a file: ${path}`);
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large to inspect (${metadata.size} bytes). Maximum supported size is ${MAX_FILE_BYTES} bytes.`
    );
  }

  const pages = await readPdfPages(path);
  const pagesWithText = pages
    .map((text, index) => ({ pageNumber: index + 1, text: text.trim() }))
    .filter((page) => page.text.length > 0)
    .map((page) => page.pageNumber);
  const hasTextLayer = pagesWithText.length > 0;

  return PdfInspectResultSchema.parse({
    path: options.displayPath ?? basename(path),
    fileType: "pdf",
    bytes: metadata.size,
    pageCount: pages.length,
    encrypted: false,
    hasTextLayer,
    pagesWithText,
    metadata: {},
    engine: "unpdf",
    engineRuntime: "typescript",
    provenance: createProvenance(),
    warnings: hasTextLayer ? [] : [NO_TEXT_LAYER_WARNING],
  });
}

export async function extractPdfText(
  path: string,
  options: PdfExtractOptions = {}
): Promise<PdfExtractResult> {
  assertPdfInput(path);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Path is not a file: ${path}`);
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large to extract (${metadata.size} bytes). Maximum supported size is ${MAX_FILE_BYTES} bytes.`
    );
  }

  const pages = await readPdfPages(path);
  const selectedPageNumbers = normalizePdfPageRange(options.pages, pages.length);
  const selectedPages = selectedPageNumbers.map((pageNumber) => {
    const text = (pages[pageNumber - 1] ?? "").trim();
    return {
      pageNumber,
      text,
      charCount: text.length,
      ocr: false,
    };
  });
  const renderedPages = selectedPages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`);
  const body = renderedPages.join("\n\n");
  const formatted = `Extracted from: ${basename(path)}\nType: PDF\n\n${body}`;
  const maxChars = positiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  const truncated = formatted.length > maxChars;
  const text = truncated ? formatted.slice(0, maxChars) : formatted;
  const hasTextLayer = selectedPages.some((page) => page.text.length > 0);

  const warnings = truncated
    ? [
        {
          code: "output_truncated",
          message: `Output truncated to ${maxChars} characters.`,
        },
      ]
    : [];
  if (!hasTextLayer) warnings.push(NO_TEXT_LAYER_WARNING);

  return PdfExtractResultSchema.parse({
    path: options.displayPath ?? basename(path),
    fileType: "pdf",
    bytes: metadata.size,
    text,
    pages: selectedPages,
    truncated,
    engine: "unpdf",
    engineRuntime: "typescript",
    provenance: createProvenance(),
    warnings,
  });
}

export async function validatePdfDocument(
  path: string,
  options: PdfValidateOptions = {}
): Promise<PdfValidateResult> {
  assertPdfInput(path);
  const metadata = await stat(path).catch((error: unknown) => {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  });

  if (metadata === null) {
    return PdfValidateResultSchema.parse({
      path: options.displayPath ?? basename(path),
      exists: false,
      fileType: "pdf",
      bytes: 0,
      pageCount: 0,
      hasTextLayer: false,
      passed: false,
      checks: [
        {
          name: "file_exists",
          passed: false,
          message: "PDF file was not found.",
        },
      ],
      engine: "unpdf",
      engineRuntime: "typescript",
      provenance: createProvenance(),
      warnings: [],
    });
  }

  if (!metadata.isFile()) throw new Error(`Path is not a file: ${path}`);
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large to validate (${metadata.size} bytes). Maximum supported size is ${MAX_FILE_BYTES} bytes.`
    );
  }

  const pages = await readPdfPages(path);
  const hasTextLayer = pages.some((text) => text.trim().length > 0);
  const checks = [
    {
      name: "file_exists",
      passed: true,
      message: "PDF file exists.",
    },
    ...(options.expectedPageCount === undefined
      ? []
      : [
          {
            name: "page_count",
            passed: pages.length === options.expectedPageCount,
            message: `Expected ${options.expectedPageCount} pages, found ${pages.length}.`,
          },
        ]),
    ...(options.expectedTextPresent === undefined
      ? []
      : [
          {
            name: "text_present",
            passed: hasTextLayer === options.expectedTextPresent,
            message: options.expectedTextPresent
              ? "Expected extractable text to be present."
              : "Expected extractable text to be absent.",
          },
        ]),
  ];

  return PdfValidateResultSchema.parse({
    path: options.displayPath ?? basename(path),
    exists: true,
    fileType: "pdf",
    bytes: metadata.size,
    pageCount: pages.length,
    hasTextLayer,
    passed: checks.every((check) => check.passed),
    checks,
    engine: "unpdf",
    engineRuntime: "typescript",
    provenance: createProvenance(),
    warnings: hasTextLayer ? [] : [NO_TEXT_LAYER_WARNING],
  });
}

async function readPdfPages(path: string): Promise<string[]> {
  const buffer = await readFile(path);
  const result = await extractText(new Uint8Array(buffer), { mergePages: false });
  return result.text;
}

function assertPdfInput(path: string): void {
  if (extname(path).toLowerCase() !== ".pdf") {
    throw new Error(`Unsupported PDF input: ${path}`);
  }
}

function createProvenance() {
  return {
    createdAt: new Date().toISOString(),
    immutableSource: true as const,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
