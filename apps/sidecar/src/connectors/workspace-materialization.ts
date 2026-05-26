import { extname } from "node:path";
import type { PlaybookGraphMaterializationFormat } from "@tessera/contracts";
import type { createPdfDocument } from "@tessera/core";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textValueFromArtifact(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "markdown", "bodyMarkdown", "content", "body", "summary"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim().length > 0) return text;
  }

  const title = typeof record.title === "string" ? record.title.trim() : "";
  const thesis = typeof record.thesis === "string" ? record.thesis.trim() : "";
  const audiencePromise =
    typeof record.audiencePromise === "string" ? record.audiencePromise.trim() : "";
  const outline = Array.isArray(record.outline) ? record.outline : [];
  const sections = [
    title ? `# ${title}` : "",
    thesis ? `## Thesis\n\n${thesis}` : "",
    audiencePromise ? `## Audience Promise\n\n${audiencePromise}` : "",
    outline.length > 0
      ? [
          "## Outline",
          ...outline.flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return [];
            const outlineItem = item as Record<string, unknown>;
            const heading =
              typeof outlineItem.heading === "string" ? outlineItem.heading.trim() : "";
            const points = Array.isArray(outlineItem.points)
              ? outlineItem.points.filter((point): point is string => typeof point === "string")
              : [];
            return [
              heading ? `### ${heading}` : "",
              points.length > 0 ? points.map((point) => `- ${point}`).join("\n") : "",
            ].filter(Boolean);
          }),
        ].join("\n\n")
      : "",
  ].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export function csvCell(value: unknown): string {
  const raw =
    isPlainRecord(value) || Array.isArray(value) ? JSON.stringify(value) : String(value ?? "");
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

export function csvRowsFromValue(value: unknown): { headers?: string[]; rows: unknown[][] } {
  const rowsValue =
    isPlainRecord(value) && Array.isArray(value.rows) ? (value.rows as unknown[]) : value;
  if (Array.isArray(rowsValue) && rowsValue.every((row) => isPlainRecord(row))) {
    const headers: string[] = [];
    for (const row of rowsValue) {
      for (const key of Object.keys(row)) {
        if (!headers.includes(key)) headers.push(key);
      }
    }
    return {
      headers,
      rows: rowsValue.map((row) => headers.map((header) => row[header])),
    };
  }
  if (Array.isArray(rowsValue) && rowsValue.every((row) => Array.isArray(row))) {
    const headers =
      isPlainRecord(value) && Array.isArray(value.headers)
        ? value.headers.filter((header): header is string => typeof header === "string")
        : undefined;
    return { ...(headers && headers.length > 0 ? { headers } : {}), rows: rowsValue };
  }
  if (Array.isArray(rowsValue)) {
    return { headers: ["value"], rows: rowsValue.map((item) => [item]) };
  }
  return { headers: ["value"], rows: [[rowsValue]] };
}

export function formatCsvContent(value: unknown): string {
  const { headers, rows } = csvRowsFromValue(value);
  const lines = [
    ...(headers ? [headers.map(csvCell).join(",")] : []),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

export function materializationFormatFromPath(path: string): PlaybookGraphMaterializationFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".csv") return "csv";
  if (extension === ".pdf") return "pdf";
  return "markdown";
}

export function formatGraphMaterializationContent(
  value: unknown,
  format: PlaybookGraphMaterializationFormat
): string {
  if (format === "markdown") {
    const text = textValueFromArtifact(value);
    if (text !== undefined) return text.endsWith("\n") ? text : `${text}\n`;
    if (typeof value === "string") return value.endsWith("\n") ? value : `${value}\n`;
  }
  if (format === "json") {
    return `${JSON.stringify(value, null, 2) ?? String(value)}\n`;
  }
  if (format === "csv") {
    return formatCsvContent(value);
  }
  if (typeof value === "string") return value.endsWith("\n") ? value : `${value}\n`;
  const json = JSON.stringify(value, null, 2);
  return `${json ?? String(value)}\n`;
}

export function formatGraphArtifactWriteContent(value: unknown, path: string): string {
  return formatGraphMaterializationContent(value, materializationFormatFromPath(path));
}

export function graphArtifactPathValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\\/:\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function renderGraphArtifactWritePath(path: string, input: Record<string, unknown>): string {
  return path.replace(/\{\{\s*inputs\.([A-Za-z0-9_.:-]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split(".").reduce<unknown>((cursor, segment) => {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
      return (cursor as Record<string, unknown>)[segment];
    }, input);
    return graphArtifactPathValue(value) || "untitled";
  });
}

export function workspaceEffectTarget(input: Record<string, unknown>): {
  path: string;
  format: PlaybookGraphMaterializationFormat;
} {
  const target = isPlainRecord(input.target) ? input.target : undefined;
  const targetPath =
    target?.kind === "workspace" && typeof target.path === "string" ? target.path : undefined;
  const legacyPath = typeof input.path === "string" ? input.path : undefined;
  const path = targetPath ?? legacyPath;
  if (!path) throw new Error("workspace.write effect requires input.target.path or input.path");

  const targetFormat =
    target?.kind === "workspace" && typeof target.format === "string" ? target.format : undefined;
  const legacyFormat = typeof input.format === "string" ? input.format : undefined;
  const format = (targetFormat ?? legacyFormat ?? materializationFormatFromPath(path)) as
    | PlaybookGraphMaterializationFormat
    | undefined;
  if (!format || !["markdown", "json", "csv", "pdf"].includes(format)) {
    throw new Error("workspace.write effect requires a supported materialization format");
  }

  return { path, format };
}

export function pdfBlocksFromValue(
  value: unknown
): Parameters<typeof createPdfDocument>[0]["blocks"] {
  const text = textValueFromArtifact(value);
  if (text !== undefined) return [{ type: "text", text }];

  const rows = csvRowsFromValue(value);
  if (rows.rows.length > 0 && rows.rows.every((row) => row.length > 1)) {
    return [
      {
        type: "table",
        ...(rows.headers ? { headers: rows.headers } : {}),
        rows: rows.rows.map((row) => row.map((cell) => String(cell ?? ""))),
      },
    ];
  }

  return [{ type: "text", text: JSON.stringify(value, null, 2) ?? String(value) }];
}
