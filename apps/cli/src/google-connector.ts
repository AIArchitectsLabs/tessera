import type { GcalListResult, GcalReadResult } from "@tessera/contracts";
import { GcalListResultSchema, GcalReadResultSchema } from "@tessera/contracts";

export interface GoogleWorkspaceConnector {
  listCalendarEvents(request: { calendarId: string; limit: number }): Promise<GcalListResult>;
  readCalendarEvent(request: { calendarId: string; eventId: string }): Promise<GcalReadResult>;
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
