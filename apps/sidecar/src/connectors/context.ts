import {
  createSpawnShellExecutor,
  createWorkspaceGuard,
  type WorkspaceGuard,
} from "@tessera/core";
import type { ShellToolCall, ShellToolResult, SpawnResult } from "@tessera/contracts";
import { googleWorkspaceWriteExecutionToken } from "../server.js";

/**
 * The shell executor type returned by createSpawnShellExecutor.
 * Carries an optional env override parameter used by write-capable effects
 * (e.g. injecting TESSERA_GWS_WRITE_EXECUTION_TOKEN).
 */
export interface SpawnShellExecutor {
  executeShell(call: ShellToolCall, env?: Record<string, string>): Promise<ShellToolResult>;
}

export interface ConnectorContext {
  /** Shell executor backed by the sidecar's workspace CLI. */
  shell: SpawnShellExecutor;
  /** Workspace guard for path containment checks and resolution. */
  workspaceGuard: WorkspaceGuard;
  /**
   * Mints a short-lived Google Workspace write-execution token.
   * Signature matches googleWorkspaceWriteExecutionToken in server.ts.
   */
  mintWriteToken: (approvalId: string, idempotencyKey: string) => string;
}

export interface ConnectorContextInput {
  workspaceRoot: string;
  runWorkspaceCli: (
    args: string[],
    timeoutMs?: number,
    env?: Record<string, string>
  ) => Promise<SpawnResult>;
}

export async function buildConnectorContext(
  input: ConnectorContextInput
): Promise<ConnectorContext> {
  const workspaceGuard = await createWorkspaceGuard(input.workspaceRoot);
  const shell = createSpawnShellExecutor({ runWorkspaceCli: input.runWorkspaceCli });
  return {
    shell,
    workspaceGuard,
    mintWriteToken: googleWorkspaceWriteExecutionToken,
  };
}
