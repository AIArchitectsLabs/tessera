import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

export interface WorkspaceGuard {
  readonly root: string;
  isInsideWorkspace(path: string): Promise<boolean>;
  resolveInsideWorkspace(path: string): Promise<string>;
  resolveInsideWorkspaceForCreate(path: string): Promise<string>;
}

function isSameOrChild(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function canonicalize(path: string): Promise<string> {
  return realpath(resolve(path));
}

export async function createWorkspaceGuard(workspaceRoot: string): Promise<WorkspaceGuard> {
  const root = await canonicalize(workspaceRoot);

  async function resolveTarget(inputPath: string): Promise<string> {
    const lexicalTarget = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
    return canonicalize(lexicalTarget);
  }

  return {
    root,
    async isInsideWorkspace(path: string): Promise<boolean> {
      try {
        return isSameOrChild(root, await resolveTarget(path));
      } catch {
        return false;
      }
    },
    async resolveInsideWorkspace(path: string): Promise<string> {
      const target = await resolveTarget(path);
      if (!isSameOrChild(root, target)) {
        throw new WorkspaceBoundaryError(`Path is outside the workspace: ${path}`);
      }
      return target;
    },
    async resolveInsideWorkspaceForCreate(path: string): Promise<string> {
      const lexicalTarget = isAbsolute(path) ? resolve(path) : resolve(root, path);
      const parent = await canonicalize(dirname(lexicalTarget));
      const target = resolve(parent, basename(lexicalTarget));
      if (!isSameOrChild(root, target)) {
        throw new WorkspaceBoundaryError(`Path is outside the workspace: ${path}`);
      }
      return target;
    },
  };
}
