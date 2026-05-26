import type { SpawnResult } from "@tessera/contracts";
import {
  type SpawnShellExecutor,
  type WorkspaceGuard,
  createSpawnShellExecutor,
  createWorkspaceGuard,
} from "@tessera/core";

export interface ConnectorContext {
  /** Shell executor backed by the sidecar's workspace CLI. */
  shell: SpawnShellExecutor;
  /** Workspace guard for path containment checks and resolution. */
  workspaceGuard: WorkspaceGuard;
  mintWriteToken: (approvalId: string, idempotencyKey: string) => string;
}

export interface ConnectorContextInput {
  workspaceRoot?: string;
  runWorkspaceCli: (
    args: string[],
    timeoutMs?: number,
    env?: Record<string, string>
  ) => Promise<SpawnResult>;
  mintWriteToken: (approvalId: string, idempotencyKey: string) => string;
}

const missingWorkspaceGuard: WorkspaceGuard = {
  root: "",
  async isInsideWorkspace(): Promise<boolean> {
    return false;
  },
  async resolveInsideWorkspace(): Promise<string> {
    throw new Error("workspace.write effect requires a workspace root");
  },
  async resolveInsideWorkspaceForCreate(): Promise<string> {
    throw new Error("workspace.write effect requires a workspace root");
  },
};

export async function buildConnectorContext(
  input: ConnectorContextInput
): Promise<ConnectorContext> {
  const workspaceGuard = input.workspaceRoot
    ? await createWorkspaceGuard(input.workspaceRoot)
    : missingWorkspaceGuard;
  const shell = createSpawnShellExecutor({ runWorkspaceCli: input.runWorkspaceCli });
  return {
    shell,
    workspaceGuard,
    mintWriteToken: input.mintWriteToken,
  };
}
