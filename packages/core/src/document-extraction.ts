import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as mammoth from "mammoth";
import { extractText } from "unpdf";
import * as XLSX from "xlsx";

const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_ROWS = 100;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const supportedExtensions = new Set([".pdf", ".docx", ".xlsx", ".xls"]);

export interface DocumentExtractionOptions {
  sheet?: string;
  maxChars?: number;
  maxRows?: number;
  pages?: {
    start?: number;
    end?: number;
  };
}

export interface DocumentExtractionResult {
  text: string;
  details: {
    path: string;
    fileType: "pdf" | "docx" | "xlsx" | "xls";
    bytes: number;
    truncated: boolean;
    warnings: string[];
  };
}

export function isExtractableDocumentPath(path: string): boolean {
  return supportedExtensions.has(extname(path).toLowerCase());
}

export async function extractWorkspaceDocument(
  path: string,
  options: DocumentExtractionOptions = {}
): Promise<DocumentExtractionResult> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Path is not a file: ${path}`);
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large to extract (${metadata.size} bytes). Maximum supported size is ${MAX_FILE_BYTES} bytes.`
    );
  }

  const extension = extname(path).toLowerCase();
  const warnings: string[] = [];
  let body: string;

  if (extension === ".pdf") {
    body = await extractPdf(path, options);
  } else if (extension === ".docx") {
    body = await extractDocx(path);
  } else if (extension === ".xlsx" || extension === ".xls") {
    body = await extractSpreadsheet(path, options);
  } else {
    throw new Error(`Unsupported document format: ${extension || "unknown"}`);
  }

  const formatted = `Extracted from: ${basename(path)}\nType: ${labelForExtension(extension)}\n\n${body.trim()}`;
  const limited = limitText(
    formatted,
    positiveInteger(options.maxChars, DEFAULT_MAX_CHARS),
    warnings
  );

  return {
    text: limited.text,
    details: {
      path: basename(path),
      fileType: extension.slice(1) as DocumentExtractionResult["details"]["fileType"],
      bytes: metadata.size,
      truncated: limited.truncated,
      warnings,
    },
  };
}

async function extractPdf(path: string, options: DocumentExtractionOptions): Promise<string> {
  const buffer = await readFile(path);
  const result = await extractText(new Uint8Array(buffer), { mergePages: false });
  const pages = result.text;
  const start = Math.max(1, positiveInteger(options.pages?.start, 1));
  const end = Math.min(pages.length, positiveInteger(options.pages?.end, pages.length));
  if (start > end) return "";

  return pages
    .slice(start - 1, end)
    .map((page, index) => `[Page ${start + index}]\n${page.trim()}`)
    .join("\n\n");
}

async function extractDocx(path: string): Promise<string> {
  const result = await mammoth.extractRawText({ path });
  return result.value;
}

async function extractSpreadsheet(
  path: string,
  options: DocumentExtractionOptions
): Promise<string> {
  const buffer = await readFile(path);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetNames = options.sheet ? [options.sheet] : workbook.SheetNames;
  const maxRows = positiveInteger(options.maxRows, DEFAULT_MAX_ROWS);
  const sections: string[] = [];

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const rows = csv.split(/\r?\n/).filter((row) => row.length > 0);
    const truncatedRows = rows.length > maxRows;
    const renderedRows = rows.slice(0, maxRows);
    if (truncatedRows) renderedRows.push(`[${rows.length - maxRows} more rows omitted]`);
    sections.push(`[Sheet: ${sheetName}]\n${renderedRows.join("\n")}`);
  }

  return sections.join("\n\n");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function limitText(
  text: string,
  maxChars: number,
  warnings: string[]
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  warnings.push(`Output truncated to ${maxChars} characters.`);
  return {
    text: `${text.slice(0, maxChars)}\n\n[Output truncated]`,
    truncated: true,
  };
}

function labelForExtension(extension: string): string {
  if (extension === ".pdf") return "PDF";
  if (extension === ".docx") return "Word document";
  return "Spreadsheet";
}
