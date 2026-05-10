import type {
  ContactsLookupResult,
  DriveReadResult,
  DriveSearchResult,
  GcalListResult,
  GcalReadResult,
  MailListResult,
  MailReadResult,
} from "@tessera/contracts";
import {
  ContactsLookupResultSchema,
  DriveReadResultSchema,
  DriveSearchResultSchema,
  GcalListResultSchema,
  GcalReadResultSchema,
  MailListResultSchema,
  MailReadResultSchema,
} from "@tessera/contracts";

export interface GoogleWorkspaceConnector {
  listCalendarEvents(request: { calendarId: string; limit: number }): Promise<GcalListResult>;
  readCalendarEvent(request: { calendarId: string; eventId: string }): Promise<GcalReadResult>;
  listMail(request: { limit: number; query?: string }): Promise<MailListResult>;
  searchMail(request: { query: string; limit: number }): Promise<MailListResult>;
  readMail(request: { messageId: string }): Promise<MailReadResult>;
  searchDrive(request: { query: string; limit: number }): Promise<DriveSearchResult>;
  readDriveFile(request: {
    fileId: string;
    format: "text" | "markdown" | "csv" | "json";
    sheet?: string;
    range?: string;
  }): Promise<DriveReadResult>;
  lookupContacts(request: { query: string; limit: number }): Promise<ContactsLookupResult>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GoogleWorkspaceConnectorError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2
  ) {
    super(message);
    this.name = "GoogleWorkspaceConnectorError";
  }
}

export function createGwsGoogleWorkspaceConnector(options: {
  runGwsCli: (args: string[]) => Promise<CommandResult>;
}): GoogleWorkspaceConnector {
  return {
    async listCalendarEvents(request) {
      const payload = await runGwsJson(options, [
        "calendar",
        "events",
        "list",
        "--params",
        JSON.stringify({
          calendarId: request.calendarId,
          maxResults: request.limit,
          orderBy: "startTime",
          singleEvents: true,
          timeMin: new Date().toISOString(),
        }),
      ]);

      return GcalListResultSchema.parse({
        calendarId: request.calendarId,
        events: extractEvents(payload).map((event) => normalizeGcalEvent(event)),
      });
    },

    async readCalendarEvent(request) {
      const payload = await runGwsJson(options, [
        "calendar",
        "events",
        "get",
        "--params",
        JSON.stringify({
          calendarId: request.calendarId,
          eventId: request.eventId,
        }),
      ]);

      return GcalReadResultSchema.parse({
        calendarId: request.calendarId,
        event: normalizeGcalEvent(extractEvent(payload), true),
      });
    },

    async listMail(request) {
      return listMailMessages(options, request);
    },

    async searchMail(request) {
      return listMailMessages(options, request);
    },

    async readMail(request) {
      const payload = await runGwsJson(options, [
        "gmail",
        "users",
        "messages",
        "get",
        "--params",
        JSON.stringify({
          userId: "me",
          id: request.messageId,
          format: "full",
        }),
      ]);
      const message = isRecord(payload) ? payload : {};

      return MailReadResultSchema.parse({
        message: {
          ...normalizeMailSummary(message),
          to: splitHeaderValues(headerValue(message, "To")),
          cc: splitHeaderValues(headerValue(message, "Cc")),
          text: decodeMailText(message),
        },
      });
    },

    async searchDrive(request) {
      const query = escapeDriveQuery(request.query);
      const payload = await runGwsJson(options, [
        "drive",
        "files",
        "list",
        "--params",
        JSON.stringify({
          pageSize: request.limit,
          q: `name contains '${query}' or fullText contains '${query}'`,
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        }),
      ]);

      return DriveSearchResultSchema.parse({
        files: extractArray(payload, ["files"]).map((file) => normalizeDriveFile(file)),
      });
    },

    async readDriveFile(request) {
      const metadataPayload = await runGwsJson(options, [
        "drive",
        "files",
        "get",
        "--params",
        JSON.stringify({
          fileId: request.fileId,
          fields: "id,name,mimeType,modifiedTime,webViewLink",
        }),
      ]);
      const metadata = normalizeDriveFile(isRecord(metadataPayload) ? metadataPayload : {});
      const content = await readDriveContent(
        options,
        request.fileId,
        stringField(metadata, "mimeType"),
        stringField(metadata, "name"),
        request.format,
        request.sheet,
        request.range
      );

      return DriveReadResultSchema.parse({
        file: {
          ...metadata,
          ...content,
        },
      });
    },

    async lookupContacts(request) {
      await runGwsJson(options, [
        "people",
        "people",
        "searchContacts",
        "--params",
        JSON.stringify({
          query: "",
          pageSize: 1,
          readMask: "names,emailAddresses,phoneNumbers,organizations",
        }),
      ]);

      const payload = await runGwsJson(options, [
        "people",
        "people",
        "searchContacts",
        "--params",
        JSON.stringify({
          query: request.query,
          pageSize: request.limit,
          readMask: "names,emailAddresses,phoneNumbers,organizations",
        }),
      ]);

      return ContactsLookupResultSchema.parse({
        contacts: extractArray(payload, ["results"])
          .map((result) => (isRecord(result.person) ? result.person : result))
          .map((person) => normalizeContact(person)),
      });
    },
  };
}

export async function runGwsCli(args: string[]): Promise<CommandResult> {
  const binary = process.env.TESSERA_GWS_CLI_PATH?.trim() || "gws";
  const env = {
    ...process.env,
    ...(process.env.TESSERA_GWS_CONFIG_DIR?.trim()
      ? { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: process.env.TESSERA_GWS_CONFIG_DIR.trim() }
      : {}),
  };
  const proc = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runGwsJson(
  options: {
    runGwsCli: (args: string[]) => Promise<CommandResult>;
  },
  command: string[]
): Promise<unknown> {
  const result = await options.runGwsCli(command);
  if (result.exitCode !== 0) {
    throw new GoogleWorkspaceConnectorError(
      normalizeGwsError(result.stderr) ||
        `Google Workspace CLI exited with status ${result.exitCode}`,
      result.exitCode
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GoogleWorkspaceConnectorError("Google Workspace CLI returned invalid JSON output.");
  }
}

function normalizeGwsError(stderr: string): string {
  const message = stderr.trim();
  if (!message) return "";
  if (/auth|credential|login|token/i.test(message)) {
    return "Google Workspace is not connected. Connect Google Workspace in Settings > Integrations.";
  }
  return message;
}

function extractEvents(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of ["items", "events", "data"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function extractArray(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function extractEvent(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const event = payload.event;
  return isRecord(event) ? event : payload;
}

function normalizeGcalEvent(
  item: Record<string, unknown>,
  includeAttendees = false
): Record<string, unknown> {
  const startValue =
    readGcalDate(item.start) ||
    stringField(item, "startLocal") ||
    stringField(item, "start") ||
    stringField(item, "startTime");
  const endValue =
    readGcalDate(item.end) ||
    stringField(item, "endLocal") ||
    stringField(item, "end") ||
    stringField(item, "endTime");
  const normalized: Record<string, unknown> = {
    id: stringField(item, "id"),
    title: stringField(item, "summary") || stringField(item, "title") || "Untitled event",
    start: startValue,
    isAllDay: isGcalAllDay(item.start) || item.allDay === true || item.isAllDay === true,
  };

  copyStringField(item, normalized, "status");
  copyStringField(item, normalized, "description");
  copyStringField(item, normalized, "location");
  copyStringField(item, normalized, "htmlLink");
  if (endValue) normalized.end = endValue;

  const organizer = item.organizer;
  if (isRecord(organizer) && typeof organizer.email === "string") {
    normalized.organizerEmail = organizer.email;
  } else {
    copyStringField(item, normalized, "organizerEmail");
  }

  if (includeAttendees && Array.isArray(item.attendees)) {
    normalized.attendees = item.attendees
      .filter(isRecord)
      .map((attendee) => ({
        email: stringField(attendee, "email"),
        ...(stringField(attendee, "displayName")
          ? { displayName: stringField(attendee, "displayName") }
          : {}),
        ...(stringField(attendee, "responseStatus")
          ? { responseStatus: stringField(attendee, "responseStatus") }
          : {}),
      }))
      .filter((attendee) => attendee.email.length > 0);
  }

  return normalized;
}

async function listMailMessages(
  options: {
    runGwsCli: (args: string[]) => Promise<CommandResult>;
  },
  request: { limit: number; query?: string }
): Promise<MailListResult> {
  const payload = await runGwsJson(options, [
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
    JSON.stringify({
      userId: "me",
      maxResults: request.limit,
      ...(request.query ? { q: request.query } : {}),
    }),
  ]);
  const messages = await Promise.all(
    extractArray(payload, ["messages"])
      .slice(0, request.limit)
      .map(async (message) => {
        const id = stringField(message, "id");
        if (!id) return message;
        return hydrateMailSummary(options, id);
      })
  );

  return MailListResultSchema.parse({
    messages: messages.map((message) => normalizeMailSummary(message)),
  });
}

async function hydrateMailSummary(
  options: {
    runGwsCli: (args: string[]) => Promise<CommandResult>;
  },
  messageId: string
): Promise<Record<string, unknown>> {
  const payload = await runGwsJson(options, [
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date", "To", "Cc"],
    }),
  ]);

  return isRecord(payload) ? payload : { id: messageId };
}

function normalizeMailSummary(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: stringField(item, "id"),
    threadId: stringField(item, "threadId"),
    subject: stringField(item, "subject") || headerValue(item, "Subject") || "(no subject)",
    from: stringField(item, "from") || headerValue(item, "From"),
    date: stringField(item, "date") || headerValue(item, "Date"),
    snippet: stringField(item, "snippet"),
    labels: Array.isArray(item.labelIds)
      ? item.labelIds.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function headerValue(item: Record<string, unknown>, name: string): string {
  const payload = item.payload;
  if (!isRecord(payload) || !Array.isArray(payload.headers)) return "";
  const header = payload.headers.filter(isRecord).find((value) => value.name === name);
  return typeof header?.value === "string" ? header.value : "";
}

function splitHeaderValues(value: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes) {
      if (char === "<") angleDepth += 1;
      if (char === ">" && angleDepth > 0) angleDepth -= 1;
      if (char === "," && angleDepth === 0) {
        const trimmed = current.trim();
        if (trimmed) values.push(trimmed);
        current = "";
        continue;
      }
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) values.push(trimmed);
  return values;
}

function decodeMailText(item: Record<string, unknown>): string {
  const payload = item.payload;
  if (!isRecord(payload)) return stringField(item, "text");

  const body = payload.body;
  if (isRecord(body)) {
    const direct = decodeBase64Url(stringField(body, "data"));
    if (direct) return direct;
  }

  const nested = findTextPlainPart(payload.parts);
  if (nested) return nested;

  return "";
}

function findTextPlainPart(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  for (const part of parts.filter(isRecord)) {
    if (stringField(part, "mimeType") === "text/plain") {
      const body = part.body;
      if (isRecord(body)) {
        const text = decodeBase64Url(stringField(body, "data"));
        if (text) return text;
      }
    }
    const nested = findTextPlainPart(part.parts);
    if (nested) return nested;
  }
  return "";
}

function decodeBase64Url(value: string): string {
  if (!value) return "";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8").trim();
}

function normalizeDriveFile(item: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    id: stringField(item, "id"),
    name: stringField(item, "name") || "Untitled",
    mimeType: stringField(item, "mimeType"),
  };
  copyStringField(item, normalized, "modifiedTime");
  copyStringField(item, normalized, "webViewLink");
  return normalized;
}

function normalizeContact(item: Record<string, unknown>): Record<string, unknown> {
  return {
    resourceName: stringField(item, "resourceName"),
    displayName: firstString(item.names, "displayName") || "Unnamed contact",
    emailAddresses: stringArray(item.emailAddresses, "value"),
    phoneNumbers: stringArray(item.phoneNumbers, "value"),
    organizations: stringArray(item.organizations, "name"),
  };
}

function firstString(value: unknown, key: string): string {
  if (!Array.isArray(value)) return "";
  const record = value.filter(isRecord).find((item) => typeof item[key] === "string");
  return record && typeof record[key] === "string" ? record[key] : "";
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => item[key])
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function readDriveContent(
  options: {
    runGwsCli: (args: string[]) => Promise<CommandResult>;
  },
  fileId: string,
  mimeType: string,
  fileName: string,
  format: "text" | "markdown" | "csv" | "json",
  requestedSheet?: string,
  requestedRange?: string
): Promise<Record<string, unknown>> {
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    const payload = await runGwsJson(options, [
      "sheets",
      "spreadsheets",
      "get",
      "--params",
      JSON.stringify({
        spreadsheetId: fileId,
        fields: "sheets(sheetType,properties(title,gridProperties(rowCount,columnCount)))",
      }),
    ]);
    const { sheetTitle, rowCount, columnCount } = extractSpreadsheetRange(
      payload,
      fileId,
      fileName,
      requestedSheet
    );
    const range = `${quoteSheetTitle(sheetTitle)}!${
      requestedRange ?? `A1:${columnLabel(columnCount)}${rowCount}`
    }`;
    const valuesPayload = await runGwsJson(options, [
      "sheets",
      "spreadsheets",
      "values",
      "get",
      "--params",
      JSON.stringify({
        spreadsheetId: fileId,
        range,
      }),
    ]);
    const rows = normalizeSpreadsheetRows(
      isRecord(valuesPayload) && Array.isArray(valuesPayload.values) ? valuesPayload.values : []
    );
    if (format === "json") return { rows };
    const delimiter = format === "csv" ? "," : "\t";
    return { text: renderDelimitedRows(rows, delimiter) };
  }

  if (mimeType === "application/vnd.google-apps.document") {
    if (format === "csv" || format === "json") {
      throw new GoogleWorkspaceConnectorError(
        `Google Docs file "${fileName || fileId}" does not support ${format} output. Use text or markdown.`
      );
    }
    const payload = await runGwsJson(options, [
      "docs",
      "documents",
      "get",
      "--params",
      JSON.stringify({ documentId: fileId, includeTabsContent: true }),
    ]);
    return { text: extractDocText(payload) };
  }

  const output = await runGwsCliRaw(options, [
    "drive",
    "files",
    "get",
    "--params",
    JSON.stringify({ fileId, alt: "media" }),
  ]);
  return decodeGwsMediaOutput(output, fileName, format);
}

function decodeGwsMediaOutput(
  output: CommandResult,
  fileName: string,
  format: "text" | "markdown" | "csv" | "json"
): Record<string, unknown> {
  if (output.exitCode !== 0) {
    throw new GoogleWorkspaceConnectorError(
      normalizeGwsError(output.stderr) ||
        `Google Workspace CLI exited with status ${output.exitCode}`,
      output.exitCode
    );
  }

  const stdout = output.stdout.trim();
  if (!stdout) {
    if (format === "json") {
      throw new GoogleWorkspaceConnectorError(
        `Google Drive file "${fileName || "unknown"}" did not return JSON content.`
      );
    }
    return { text: "" };
  }

  if (format === "json") {
    try {
      const parsed = JSON.parse(stdout);
      return { text: JSON.stringify(parsed, null, 2) };
    } catch {
      throw new GoogleWorkspaceConnectorError(
        `Google Drive file "${fileName || "unknown"}" did not return valid JSON content.`
      );
    }
  }

  try {
    JSON.parse(stdout);
  } catch {
    // Keep raw media as text for text/markdown/csv when the file is not JSON.
  }
  return { text: stdout };
}

async function runGwsCliRaw(
  options: {
    runGwsCli: (args: string[]) => Promise<CommandResult>;
  },
  command: string[]
): Promise<CommandResult> {
  return options.runGwsCli(command);
}

function extractDocText(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const tabText = extractDocTabText(payload.tabs);
  if (tabText) return tabText;
  return extractDocBodyText(payload.body);
}

function extractDocTabText(tabs: unknown): string {
  if (!Array.isArray(tabs)) return "";
  const parts: string[] = [];
  for (const tab of tabs.filter(isRecord)) {
    const documentTab = tab.documentTab;
    if (isRecord(documentTab)) {
      parts.push(extractDocBodyText(documentTab.body));
    }
    const childText = extractDocTabText(tab.childTabs);
    if (childText) parts.push(childText);
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

function extractDocBodyText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.content)) return "";
  const parts: string[] = [];
  for (const block of body.content.filter(isRecord)) {
    const paragraph = block.paragraph;
    if (!isRecord(paragraph) || !Array.isArray(paragraph.elements)) continue;
    for (const element of paragraph.elements.filter(isRecord)) {
      const textRun = element.textRun;
      if (isRecord(textRun) && typeof textRun.content === "string") parts.push(textRun.content);
    }
  }
  return parts.join("").trim();
}

function extractSpreadsheetRange(
  payload: unknown,
  fileId: string,
  fileName: string,
  requestedSheet?: string
): {
  sheetTitle: string;
  rowCount: number;
  columnCount: number;
} {
  if (!isRecord(payload) || !Array.isArray(payload.sheets)) {
    throw new GoogleWorkspaceConnectorError(
      "Google Sheets metadata is missing sheet definitions for range discovery."
    );
  }

  const firstSheet = selectSpreadsheetSheet(payload.sheets, fileId, fileName, requestedSheet);

  const properties = isRecord(firstSheet.properties) ? firstSheet.properties : null;
  const gridProperties = isRecord(properties?.gridProperties) ? properties.gridProperties : null;
  const sheetTitle = typeof properties?.title === "string" ? properties.title : "";
  const rowCount = typeof gridProperties?.rowCount === "number" ? gridProperties.rowCount : 0;
  const columnCount =
    typeof gridProperties?.columnCount === "number" ? gridProperties.columnCount : 0;

  if (!sheetTitle || rowCount <= 0 || columnCount <= 0) {
    throw new GoogleWorkspaceConnectorError(
      "Google Sheets metadata is missing a usable first sheet title or grid size."
    );
  }

  return { sheetTitle, rowCount, columnCount };
}

function selectSpreadsheetSheet(
  sheets: unknown[],
  fileId: string,
  fileName: string,
  requestedSheet?: string
): Record<string, unknown> {
  const records = sheets.filter(isRecord);
  if (requestedSheet) {
    const matching = records.find((sheet) => {
      const properties = isRecord(sheet.properties) ? sheet.properties : null;
      return properties?.title === requestedSheet;
    });
    if (!matching) {
      throw new GoogleWorkspaceConnectorError(
        `Google Sheets file "${fileName || fileId}" does not have a sheet named "${requestedSheet}". Available sheets: ${spreadsheetSheetNames(records).join(", ") || "none"}.`
      );
    }
    return matching;
  }

  if (records.length !== 1) {
    const reason = records.length === 0 ? "has no sheets" : "has multiple sheets";
    throw new GoogleWorkspaceConnectorError(
      `Google Sheets file "${fileName || fileId}" ${reason}. Choose a sheet with --sheet. Available sheets: ${spreadsheetSheetNames(records).join(", ") || "none"}.`
    );
  }

  const firstSheet = records[0];
  if (!isRecord(firstSheet)) {
    throw new GoogleWorkspaceConnectorError(
      "Google Sheets metadata is missing a usable first sheet record."
    );
  }

  return firstSheet;
}

function spreadsheetSheetNames(sheets: Record<string, unknown>[]): string[] {
  return sheets
    .map((sheet) => {
      const properties = isRecord(sheet.properties) ? sheet.properties : null;
      return typeof properties?.title === "string" ? properties.title : "";
    })
    .filter((title) => title.length > 0);
}

function quoteSheetTitle(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

function columnLabel(columnCount: number): string {
  if (!Number.isInteger(columnCount) || columnCount <= 0) {
    throw new GoogleWorkspaceConnectorError("Google Sheets column count is invalid.");
  }

  let value = columnCount;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function normalizeSpreadsheetRows(rows: unknown[]): unknown[][] {
  return rows.filter(Array.isArray).map((row) =>
    row.filter((cell): cell is string | number | boolean | null => {
      return cell === null || ["string", "number", "boolean"].includes(typeof cell);
    })
  );
}

function renderDelimitedRows(rows: unknown[][], delimiter: "," | "\t"): string {
  return rows
    .map((row) => row.map((cell) => renderDelimitedCell(cell, delimiter)).join(delimiter))
    .join("\n");
}

function renderDelimitedCell(value: unknown, delimiter: "," | "\t"): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
  if (delimiter === "\t") {
    return text.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function readGcalDate(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.dateTime === "string") return value.dateTime;
  if (typeof value.date === "string") return value.date;
  return "";
}

function isGcalAllDay(value: unknown): boolean {
  return isRecord(value) && typeof value.date === "string";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function copyStringField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
) {
  const value = stringField(source, key);
  if (value) target[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
