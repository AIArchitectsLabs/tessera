import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  type PdfExtractResult,
  PdfExtractResultSchema,
  type PdfInspectResult,
  PdfInspectResultSchema,
  type PdfPageRange,
  type PdfRenderResult,
  PdfRenderResultSchema,
  type PdfTransformOperation,
  type PdfTransformResult,
  PdfTransformResultSchema,
  type PdfValidateResult,
  PdfValidateResultSchema,
  type PdfWarning,
} from "@tessera/contracts";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 100_000;
const NO_TEXT_LAYER_WARNING: PdfWarning = {
  code: "no_text_layer",
  message: "No extractable text layer was found. OCR may be required for scanned pages.",
};
const PAGE_RANGE_OUT_OF_BOUNDS_WARNING: PdfWarning = {
  code: "page_range_out_of_bounds",
  message: "Requested page range does not overlap the PDF.",
};
type PdfDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

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

export interface BinaryRunnerInput {
  command: string;
  args: string[];
  cwd?: string;
}

export interface BinaryRunnerResult {
  stdout: string;
  stderr: string;
}

export type BinaryRunner = (input: BinaryRunnerInput) => Promise<BinaryRunnerResult>;

export interface PdfImageDimensions {
  width: number;
  height: number;
}

export type PdfImageDimensionsReader = (path: string) => Promise<PdfImageDimensions>;

export interface PdfRenderOptions extends PdfDocumentOptions {
  pages?: PdfPageRange;
  outputDir: string;
  displayOutputDir?: string;
  dpi?: number;
  binaryRunner?: BinaryRunner;
  dimensionsReader?: PdfImageDimensionsReader;
}

export interface PdfTransformSource {
  path: string;
  displayPath?: string;
  pages?: PdfPageRange;
}

export interface PdfTransformOptions {
  operation: PdfTransformOperation;
  sources: PdfTransformSource[];
  outputPath: string;
  displayOutputPath?: string;
  rotation?: {
    degrees: 90 | 180 | 270;
    pages?: PdfPageRange;
  };
  binaryRunner?: BinaryRunner;
}

export function normalizePdfPageRange(
  range: PdfPageRange | undefined,
  pageCount: number
): number[] {
  if (pageCount <= 0) return [];
  if (range === undefined) {
    return Array.from({ length: pageCount }, (_value, index) => index + 1);
  }

  const start = coercePageBound(range.start, 1);
  const end = coercePageBound(range.end, pageCount);
  if (start > pageCount || end < 1) return [];
  if (start > end) return [];

  const normalizedStart = Math.max(1, start);
  const normalizedEnd = Math.min(pageCount, end);
  if (normalizedStart > normalizedEnd) return [];

  return Array.from(
    { length: normalizedEnd - normalizedStart + 1 },
    (_value, index) => normalizedStart + index
  );
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

  const buffer = await readFile(path);
  const document = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const [pages, documentMetadata] = await Promise.all([
      readPdfPages(document),
      readPdfMetadata(document),
    ]);
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
      encrypted: documentMetadata.encrypted,
      hasTextLayer,
      pagesWithText,
      metadata: documentMetadata.metadata,
      engine: "unpdf",
      engineRuntime: "typescript",
      provenance: createProvenance(),
      warnings: hasTextLayer ? [] : [NO_TEXT_LAYER_WARNING],
    });
  } finally {
    await document.destroy();
  }
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

  const buffer = await readFile(path);
  const document = await getDocumentProxy(new Uint8Array(buffer));
  const pages = await readPdfPages(document).finally(() => document.destroy());
  const hasTextLayer = pages.some((text) => text.trim().length > 0);
  const documentWarnings = hasTextLayer ? [] : [NO_TEXT_LAYER_WARNING];
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
  const warnings: PdfWarning[] = [...documentWarnings];
  if (selectedPageNumbers.length === 0 && pages.length > 0) {
    warnings.push(PAGE_RANGE_OUT_OF_BOUNDS_WARNING);
  }
  if (truncated) {
    warnings.push({
      code: "output_truncated",
      message: `Output truncated to ${maxChars} characters.`,
    });
  }

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

export async function renderPdfPages(
  path: string,
  options: PdfRenderOptions
): Promise<PdfRenderResult> {
  assertPdfInput(path);
  const inspected = await inspectPdfDocument(path, {
    ...(options.displayPath !== undefined ? { displayPath: options.displayPath } : {}),
  });
  const selectedPages = normalizePdfPageRange(options.pages, inspected.pageCount);
  if (selectedPages.length === 0) {
    return PdfRenderResultSchema.parse({
      path: inspected.path,
      fileType: "pdf",
      outputs: [],
      engine: "pdftoppm",
      engineRuntime: "binary",
      provenance: createProvenance(),
      warnings: [PAGE_RANGE_OUT_OF_BOUNDS_WARNING],
    });
  }

  await mkdir(options.outputDir, { recursive: true });
  const outputPrefix = join(options.outputDir, `${basename(path, extname(path))}-page`);
  const firstPage = selectedPages[0] ?? 1;
  const lastPage = selectedPages.at(-1) ?? firstPage;
  await runPdfBinary(options.binaryRunner ?? defaultBinaryRunner, {
    command: "pdftoppm",
    args: [
      "-png",
      "-f",
      String(firstPage),
      "-l",
      String(lastPage),
      "-r",
      String(positiveInteger(options.dpi, 144)),
      path,
      outputPrefix,
    ],
  });

  const dimensionsReader = options.dimensionsReader ?? readPngDimensions;
  const outputs = await Promise.all(
    selectedPages.map(async (pageNumber) => {
      const outputPath = `${outputPrefix}-${pageNumber}.png`;
      const dimensions = await dimensionsReader(outputPath);
      return {
        pageNumber,
        path:
          options.displayOutputDir === undefined
            ? basename(outputPath)
            : `${options.displayOutputDir.replace(/\/$/, "")}/${basename(outputPath)}`,
        format: "png" as const,
        width: dimensions.width,
        height: dimensions.height,
      };
    })
  );

  return PdfRenderResultSchema.parse({
    path: inspected.path,
    fileType: "pdf",
    outputs,
    engine: "pdftoppm",
    engineRuntime: "binary",
    provenance: createProvenance(),
    warnings: [],
  });
}

export async function transformPdfDocument(
  options: PdfTransformOptions
): Promise<PdfTransformResult> {
  if (options.sources.length === 0) throw new Error("At least one PDF source is required.");
  for (const source of options.sources) {
    assertPdfInput(source.path);
  }
  assertPdfInput(options.outputPath);
  await mkdir(dirname(options.outputPath), { recursive: true });

  const inspectedSources = await Promise.all(
    options.sources.map(async (source) => ({
      source,
      inspected: await inspectPdfDocument(source.path, {
        displayPath: source.displayPath ?? basename(source.path),
      }),
    }))
  );
  const pageMapping = buildPageMapping(
    options.operation,
    inspectedSources,
    options.rotation?.pages
  );
  const args = buildQpdfArgs(options, inspectedSources);
  await runPdfBinary(options.binaryRunner ?? defaultBinaryRunner, {
    command: "qpdf",
    args,
  });

  return PdfTransformResultSchema.parse({
    outputPath: options.displayOutputPath ?? basename(options.outputPath),
    fileType: "pdf",
    operation: options.operation,
    sourcePaths: inspectedSources.map((item) => item.inspected.path),
    pageMapping,
    engine: "qpdf",
    engineRuntime: "binary",
    provenance: createProvenance(),
    warnings: [],
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

  const inspected =
    options.displayPath === undefined
      ? await inspectPdfDocument(path)
      : await inspectPdfDocument(path, { displayPath: options.displayPath });
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
            passed: inspected.pageCount === options.expectedPageCount,
            message: `Expected ${options.expectedPageCount} pages, found ${inspected.pageCount}.`,
          },
        ]),
    ...(options.expectedTextPresent === undefined
      ? []
      : [
          {
            name: "text_present",
            passed: inspected.hasTextLayer === options.expectedTextPresent,
            message: options.expectedTextPresent
              ? "Expected extractable text to be present."
              : "Expected extractable text to be absent.",
          },
        ]),
  ];

  return PdfValidateResultSchema.parse({
    path: inspected.path,
    exists: true,
    fileType: "pdf",
    bytes: inspected.bytes,
    pageCount: inspected.pageCount,
    hasTextLayer: inspected.hasTextLayer,
    passed: checks.every((check) => check.passed),
    checks,
    engine: inspected.engine,
    engineRuntime: inspected.engineRuntime,
    provenance: inspected.provenance,
    warnings: inspected.warnings,
  });
}

async function readPdfPages(document: PdfDocumentProxy): Promise<string[]> {
  const result = await extractText(document, { mergePages: false });
  return result.text;
}

async function readPdfMetadata(document: PdfDocumentProxy): Promise<{
  encrypted: boolean;
  metadata: Record<string, string>;
}> {
  const meta = await getMeta(document);
  const info = sanitizeMetadataRecord(meta.info);
  const xmp = metadataObjectToRecord(meta.metadata);
  return {
    encrypted: info.EncryptFilterName !== undefined && info.EncryptFilterName.length > 0,
    metadata: {
      ...info,
      ...xmp,
    },
  };
}

function metadataObjectToRecord(metadata: unknown): Record<string, string> {
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "getAll" in metadata &&
    typeof metadata.getAll === "function"
  ) {
    return sanitizeMetadataRecord(metadata.getAll());
  }
  return {};
}

function sanitizeMetadataRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const entries = Object.entries(value)
    .filter((entry): entry is [string, unknown] => entry[1] !== null && entry[1] !== undefined)
    .map(([key, item]) => [key, metadataValueToString(item)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

function metadataValueToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

async function defaultBinaryRunner(input: BinaryRunnerInput): Promise<BinaryRunnerResult> {
  const result = await execFileAsync(input.command, input.args, {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runPdfBinary(runner: BinaryRunner, input: BinaryRunnerInput): Promise<void> {
  try {
    await runner(input);
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw new Error(`PDF engine unavailable: ${input.command}`);
    }
    throw error;
  }
}

function buildQpdfArgs(
  options: PdfTransformOptions,
  inspectedSources: Array<{ source: PdfTransformSource; inspected: PdfInspectResult }>
): string[] {
  switch (options.operation) {
    case "merge":
      return [
        "--empty",
        "--pages",
        ...inspectedSources.flatMap((item) => [
          item.source.path,
          qpdfRange(item.source.pages, item.inspected.pageCount),
        ]),
        "--",
        options.outputPath,
      ];
    case "split":
    case "reorder": {
      const first = inspectedSources[0];
      if (!first) throw new Error("At least one PDF source is required.");
      return [
        first.source.path,
        "--pages",
        first.source.path,
        qpdfRange(first.source.pages, first.inspected.pageCount),
        "--",
        options.outputPath,
      ];
    }
    case "rotate": {
      const first = inspectedSources[0];
      if (!first) throw new Error("At least one PDF source is required.");
      if (inspectedSources.length !== 1) throw new Error("Rotate expects exactly one PDF source.");
      const degrees = options.rotation?.degrees;
      if (degrees === undefined) throw new Error("Rotate requires rotation degrees.");
      const pages = qpdfRange(options.rotation?.pages, first.inspected.pageCount);
      return [first.source.path, `--rotate=+${degrees}:${pages}`, options.outputPath];
    }
  }
}

function buildPageMapping(
  operation: PdfTransformOperation,
  inspectedSources: Array<{ source: PdfTransformSource; inspected: PdfInspectResult }>,
  rotationPages?: PdfPageRange
) {
  const mappings: Array<{ sourcePath: string; sourcePage: number; outputPage: number }> = [];
  let outputPage = 1;
  for (const item of inspectedSources) {
    const range = operation === "rotate" ? rotationPages : item.source.pages;
    const pages = normalizePdfPageRange(range, item.inspected.pageCount);
    for (const page of pages) {
      mappings.push({
        sourcePath: item.inspected.path,
        sourcePage: page,
        outputPage,
      });
      outputPage++;
    }
    if (operation === "split" || operation === "reorder" || operation === "rotate") break;
  }
  return mappings;
}

function qpdfRange(range: PdfPageRange | undefined, pageCount: number): string {
  const pages = normalizePdfPageRange(range, pageCount);
  if (pages.length === 0) throw new Error("PDF page range does not overlap the source document.");
  return pagesToRange(pages);
}

function pagesToRange(pages: number[]): string {
  const first = pages[0];
  const last = pages.at(-1);
  if (first === undefined || last === undefined) throw new Error("PDF page range is empty.");
  return first === last ? String(first) : `${first}-${last}`;
}

async function readPngDimensions(path: string): Promise<PdfImageDimensions> {
  const buffer = await readFile(path);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`Rendered output is not a PNG: ${path}`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
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

function coercePageBound(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return positiveInteger(value, fallback);
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

function isCommandNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
