import {
  createSpawnShellExecutor,
  createWorkspaceGuard,
  type SpawnShellExecutor,
  type WorkspaceGuard,
} from "@tessera/core";
import type { SpawnResult } from "@tessera/contracts";

export interface ConnectorContext {
  /** Shell executor backed by the sidecar's workspace CLI. */
  shell: SpawnShellExecutor;
  /** Workspace guard for path containment checks and resolution. */
  workspaceGuard: WorkspaceGuard;
  mintWriteToken: (approvalId: string, idempotencyKey: string) => string;
}

export interface ConnectorContextInput {
  workspaceRoot: string;
  runWorkspaceCli: (
    args: string[],
    timeoutMs?: number,
    env?: Record<string, string>
  ) => Promise<SpawnResult>;
  mintWriteToken: (approvalId: string, idempotencyKey: string) => string;
}

export async function buildConnectorContext(
  input: ConnectorContextInput
): Promise<ConnectorContext> {
  const workspaceGuard = await createWorkspaceGuard(input.workspaceRoot);
  const shell = createSpawnShellExecutor({ runWorkspaceCli: input.runWorkspaceCli });
  return {
    shell,
    workspaceGuard,
    mintWriteToken: input.mintWriteToken,
  };
}
