import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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

async function canonicalizeExistingAncestor(path: string): Promise<{
  canonical: string;
  lexical: string;
}> {
  let lexical = resolve(path);
  while (true) {
    try {
      return { canonical: await canonicalize(lexical), lexical };
    } catch (error) {
      const code = typeof error === "object" && error ? (error as { code?: unknown }).code : "";
      if (code !== "ENOENT") throw error;
      const parent = dirname(lexical);
      if (parent === lexical) throw error;
      lexical = parent;
    }
  }
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
      try {
        const existingTarget = await canonicalize(lexicalTarget);
        if (!isSameOrChild(root, existingTarget)) {
          throw new WorkspaceBoundaryError(`Path is outside the workspace: ${path}`);
        }
        return existingTarget;
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) throw error;
        const code = typeof error === "object" && error ? (error as { code?: unknown }).code : "";
        if (code !== "ENOENT") throw error;
      }

      const ancestor = await canonicalizeExistingAncestor(dirname(lexicalTarget));
      const target = resolve(ancestor.canonical, relative(ancestor.lexical, lexicalTarget));
      if (!isSameOrChild(root, target)) {
        throw new WorkspaceBoundaryError(`Path is outside the workspace: ${path}`);
      }
      return target;
    },
  };
}
