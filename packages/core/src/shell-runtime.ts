import type { ShellToolCall } from "@tessera/contracts";
import { findCliCommand, formatShellPreview } from "./cli-catalog.js";

export class ShellValidationError extends Error {}

export function validateShellCall(call: ShellToolCall): ShellToolCall {
  const policy = findCliCommand(call);
  if (!policy) {
    throw new ShellValidationError(`Unsupported shell command: ${formatShellPreview(call)}`);
  }
  return call;
}
