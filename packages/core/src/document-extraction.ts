import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import * as mammoth from "mammoth";
import { extractText } from "unpdf";
import * as XLSX from "xlsx";

const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_ROWS = 100;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const supportedExtensions = new Set([".pdf", ".docx", ".xlsx", ".xls", ".pptx"]);

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
    fileType: "pdf" | "docx" | "xlsx" | "xls" | "pptx";
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
  } else if (extension === ".pptx") {
    body = await extractPresentation(path);
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

async function extractPresentation(path: string): Promise<string> {
  const buffer = await readFile(path);
  const slideEntries = readZipEntries(buffer)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((left, right) => slideNumber(left.name) - slideNumber(right.name));

  return slideEntries
    .map((entry) => {
      const xml = entry.data.toString("utf8");
      const textRuns = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXmlText(match[1] ?? "").trim())
        .filter((text) => text.length > 0);
      return `[Slide ${slideNumber(entry.name)}]\n${textRuns.join("\n")}`;
    })
    .filter((section) => !section.endsWith("\n"))
    .join("\n\n");
}

function readZipEntries(buffer: Buffer): Array<{ name: string; data: Buffer }> {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: Array<{ name: string; data: Buffer }> = [];
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Unsupported zip archive: invalid central directory entry");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const data = readZipEntryData(buffer, {
      compressedSize,
      localHeaderOffset,
      method,
      uncompressedSize,
    });
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntryData(
  buffer: Buffer,
  entry: {
    compressedSize: number;
    localHeaderOffset: number;
    method: number;
    uncompressedSize: number;
  }
): Buffer {
  const cursor = entry.localHeaderOffset;
  if (buffer.readUInt32LE(cursor) !== 0x04034b50) {
    throw new Error("Unsupported zip archive: invalid local file header");
  }
  const nameLength = buffer.readUInt16LE(cursor + 26);
  const extraLength = buffer.readUInt16LE(cursor + 28);
  const dataStart = cursor + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  let data: Buffer;
  if (entry.method === 0) {
    data = compressed;
  } else if (entry.method === 8) {
    data = inflateRawSync(compressed);
  } else {
    throw new Error(`Unsupported zip compression method: ${entry.method}`);
  }
  if (entry.uncompressedSize !== data.length) {
    throw new Error("Unsupported zip archive: entry size mismatch");
  }
  return data;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Unsupported zip archive: end of central directory not found");
}

function slideNumber(path: string): number {
  const match = path.match(/slide(\d+)\.xml$/);
  const value = match?.[1];
  return value ? Number.parseInt(value, 10) : Number.MAX_SAFE_INTEGER;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
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
  if (extension === ".pptx") return "PowerPoint presentation";
  return "Spreadsheet";
}
