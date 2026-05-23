import {
  ContactsLookupResultSchema,
  DocsCreateResultSchema,
  DocsWriteCommitResultSchema,
  DocsWritePreviewResultSchema,
  DriveReadResultSchema,
  DriveSearchResultSchema,
  GcalListResultSchema,
  GcalReadResultSchema,
  MailListResultSchema,
  MailReadResultSchema,
  SheetsWorkbookCreateResultSchema,
  SheetsWriteCommitResultSchema,
  SheetsWritePreviewResultSchema,
  type ShellToolCall,
  type ShellToolResult,
  ShellToolResultSchema,
  type SpawnResult,
  SpawnResultSchema,
  WebFetchResultSchema,
  WebSearchResultSchema,
} from "@tessera/contracts";
import { findCliCommand, formatShellPreview } from "./cli-catalog.js";

const DEFAULT_SHELL_TIMEOUT_MS = 20_000;
const WEB_FETCH_TIMEOUT_MS = 45_000;
const WEB_FETCH_MAX_ATTEMPTS = 2;
const RETRYABLE_WEB_FETCH_EXIT_CODES = new Set([124, 137, 143]);
const RETRYABLE_WEB_FETCH_ERROR = /\b(ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b|timed out|socket hang up/i;

export class ShellValidationError extends Error {}
export class ShellExecutionError extends Error {
  constructor(
    message: string,
    readonly result?: ShellToolResult
  ) {
    super(message);
    this.name = "ShellExecutionError";
  }
}

export function validateShellCall(call: ShellToolCall): ShellToolCall {
  const policy = findCliCommand(call);
  if (!policy) {
    throw new ShellValidationError(`Unsupported shell command: ${formatShellPreview(call)}`);
  }
  return call;
}

function parseShellPayload(call: ShellToolCall, stdout: string): unknown {
  const json = JSON.parse(stdout);
  if (call.command === "web-search") {
    return WebSearchResultSchema.parse(json);
  }
  if (call.command === "web-fetch") {
    return WebFetchResultSchema.parse(json);
  }
  if (call.command === "gcal" && call.subcommand === "list") {
    return GcalListResultSchema.parse(json);
  }
  if (call.command === "gcal" && call.subcommand === "read") {
    return GcalReadResultSchema.parse(json);
  }
  if (call.command === "mail" && (call.subcommand === "list" || call.subcommand === "search")) {
    return MailListResultSchema.parse(json);
  }
  if (call.command === "mail" && call.subcommand === "read") {
    return MailReadResultSchema.parse(json);
  }
  if (call.command === "drive" && call.subcommand === "search") {
    return DriveSearchResultSchema.parse(json);
  }
  if (call.command === "drive" && call.subcommand === "read") {
    return DriveReadResultSchema.parse(json);
  }
  if (call.command === "sheets" && call.subcommand === "workbook.create") {
    return SheetsWorkbookCreateResultSchema.parse(json);
  }
  if (call.command === "sheets") {
    return json?.dryRun === true
      ? SheetsWritePreviewResultSchema.parse(json)
      : SheetsWriteCommitResultSchema.parse(json);
  }
  if (call.command === "docs" && call.subcommand === "documents.create") {
    return json?.dryRun === true
      ? DocsWritePreviewResultSchema.parse(json)
      : DocsCreateResultSchema.parse(json);
  }
  if (call.command === "docs") {
    return json?.dryRun === true
      ? DocsWritePreviewResultSchema.parse(json)
      : DocsWriteCommitResultSchema.parse(json);
  }
  if (call.command === "contacts" && call.subcommand === "lookup") {
    return ContactsLookupResultSchema.parse(json);
  }
  return json;
}

function timeoutMsForCall(call: ShellToolCall): number {
  return call.command === "web-fetch" && call.subcommand === "fetch"
    ? WEB_FETCH_TIMEOUT_MS
    : DEFAULT_SHELL_TIMEOUT_MS;
}

function maxAttemptsForCall(call: ShellToolCall): number {
  return call.command === "web-fetch" && call.subcommand === "fetch" ? WEB_FETCH_MAX_ATTEMPTS : 1;
}

function isRetryableShellFailure(call: ShellToolCall, result: SpawnResult): boolean {
  if (call.command !== "web-fetch" || call.subcommand !== "fetch") return false;
  if (RETRYABLE_WEB_FETCH_EXIT_CODES.has(result.exitCode)) return true;
  if (result.signal !== null) return true;
  return RETRYABLE_WEB_FETCH_ERROR.test(result.stderr);
}

export function createSpawnShellExecutor(cli: {
  runWorkspaceCli(args: string[], timeoutMs?: number): Promise<SpawnResult>;
}): {
  executeShell(call: ShellToolCall): Promise<ShellToolResult>;
} {
  return {
    async executeShell(call) {
      const validated = validateShellCall(call);
      const attempts = maxAttemptsForCall(validated);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const spawnResult = SpawnResultSchema.parse(
          await cli.runWorkspaceCli(
            [validated.command, validated.subcommand, ...validated.args],
            timeoutMsForCall(validated)
          )
        );

        const baseResult = {
          command: validated.command,
          subcommand: validated.subcommand,
          stdout: spawnResult.stdout,
          stderr: spawnResult.stderr,
          exitCode: spawnResult.exitCode,
          durationMs: Math.round(spawnResult.durationMs),
        };

        if (spawnResult.exitCode !== 0) {
          if (attempt < attempts && isRetryableShellFailure(validated, spawnResult)) {
            continue;
          }
          throw new ShellExecutionError(
            spawnResult.stderr.trim() ||
              `${formatShellPreview(validated)} exited ${spawnResult.exitCode}`,
            ShellToolResultSchema.parse(baseResult)
          );
        }

        let parsed: unknown;
        try {
          parsed = parseShellPayload(validated, spawnResult.stdout);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : `Invalid JSON returned by ${formatShellPreview(validated)}`;
          throw new ShellExecutionError(
            `Invalid JSON returned by ${formatShellPreview(validated)}: ${message}`,
            ShellToolResultSchema.parse(baseResult)
          );
        }

        return ShellToolResultSchema.parse({
          ...baseResult,
          parsed,
        });
      }

      throw new ShellExecutionError(`No attempts executed for ${formatShellPreview(validated)}`);
    },
  };
}
