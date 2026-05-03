import {
  BraveSearchResultSchema,
  type ShellToolCall,
  type ShellToolResult,
  ShellToolResultSchema,
  type SpawnResult,
  SpawnResultSchema,
  WebFetchResultSchema,
} from "@tessera/contracts";
import { findCliCommand, formatShellPreview } from "./cli-catalog.js";

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
    return BraveSearchResultSchema.parse(json);
  }
  if (call.command === "web-fetch") {
    return WebFetchResultSchema.parse(json);
  }
  return json;
}

export function createSpawnShellExecutor(cli: {
  runWorkspaceCli(args: string[], timeoutMs?: number): Promise<SpawnResult>;
}): {
  executeShell(call: ShellToolCall): Promise<ShellToolResult>;
} {
  return {
    async executeShell(call) {
      const validated = validateShellCall(call);
      const spawnResult = SpawnResultSchema.parse(
        await cli.runWorkspaceCli(
          [validated.command, validated.subcommand, ...validated.args],
          20_000
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
    },
  };
}
