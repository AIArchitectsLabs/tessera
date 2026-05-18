import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  type PlaybookGraphPackageManifest,
  PlaybookGraphPackageManifestSchema,
} from "@tessera/contracts";

export interface PlaybookGraphPackageFiles {
  root: string;
  manifestPath: string;
  manifest: PlaybookGraphPackageManifest;
  sourceFiles: Record<string, string>;
}

interface FileError extends Error {
  code?: string;
}

const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:|\\\\|\/\/)/;
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const IGNORED_DIRECTORY_NAMES = new Set([".git"]);
const DEPENDENCY_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
]);

function isFileError(error: unknown, code: string): error is FileError {
  return typeof error === "object" && error !== null && (error as FileError).code === code;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isHookDirectoryPath(relativePath: string): boolean {
  const segments = relativePath.split("/");

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== "hooks") {
      continue;
    }

    for (let ancestor = 0; ancestor < index; ancestor += 1) {
      if (segments[ancestor]?.startsWith(".")) {
        return true;
      }
    }
  }

  return false;
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split("/");
}

function hasSegment(relativePath: string, segment: string): boolean {
  return pathSegments(relativePath).includes(segment);
}

export function isPackageContainedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../") && !ABSOLUTE_PATH_RE.test(normalized);
}

export function assertPackageRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");

  if (!normalized) {
    throw new Error("Package-relative paths must not be empty");
  }
  if (ABSOLUTE_PATH_RE.test(normalized)) {
    throw new Error(`Package-relative paths must not be absolute: ${relativePath}`);
  }

  const segments = normalized.split("/");
  const cleaned: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Package-relative paths may not contain unsafe segments: ${relativePath}`);
    }
    cleaned.push(segment);
  }

  return cleaned.join("/");
}

function shouldCollectSourceFile(relativePath: string, manifestEntrypoint: string): boolean {
  if (relativePath === "manifest.json") {
    return true;
  }
  if (relativePath === manifestEntrypoint) {
    return true;
  }
  if (relativePath.startsWith("prompts/")) {
    return relativePath.endsWith(".md");
  }
  if (relativePath.startsWith("scripts/")) {
    return relativePath.endsWith(".ts");
  }
  if (relativePath.startsWith("schemas/")) {
    return relativePath.endsWith(".json");
  }
  if (relativePath.startsWith("layouts/")) {
    return relativePath.endsWith(".json");
  }
  return false;
}

async function readManifestPackageJson(absolutePath: string): Promise<void> {
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  const scripts =
    record && typeof record.scripts === "object" && record.scripts !== null
      ? record.scripts
      : undefined;

  if (
    typeof scripts === "object" &&
    scripts !== null &&
    Object.prototype.hasOwnProperty.call(scripts, "postinstall")
  ) {
    throw new Error(`package.json scripts.postinstall is not allowed: ${absolutePath}`);
  }

  if (record) {
    for (const field of DEPENDENCY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(record, field)) {
        throw new Error(`package.json ${field} is not allowed: ${absolutePath}`);
      }
    }
  }
}

async function collectPackageFiles(
  root: string,
  absolutePath: string,
  manifestEntrypoint: string,
  collectSourceFiles: boolean,
  sourceFiles: Record<string, string>
): Promise<void> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));

  for (const entry of entries) {
    const childAbsolutePath = join(absolutePath, entry.name);
    const childRelativePosix = toPosixPath(relative(root, childAbsolutePath));
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }
    let resolvedChild: string;
    try {
      resolvedChild = await realpath(childAbsolutePath);
    } catch (error) {
      if (entry.isSymbolicLink() && isFileError(error, "ELOOP")) {
        throw new Error(`Directory symlinks are not allowed: ${childAbsolutePath}`);
      }
      throw error;
    }
    const resolvedRelative = toPosixPath(relative(root, resolvedChild));

    if (!isPackageContainedRelativePath(childRelativePosix)) {
      throw new Error(`Package file escapes root: ${childAbsolutePath}`);
    }
    if (hasSegment(childRelativePosix, "node_modules")) {
      throw new Error(
        `node_modules is not allowed in graph playbook packages: ${childAbsolutePath}`
      );
    }
    if (LOCKFILE_NAMES.has(entry.name)) {
      throw new Error(`Lockfiles are not allowed in graph playbook packages: ${childAbsolutePath}`);
    }
    if (isHookDirectoryPath(childRelativePosix)) {
      throw new Error(`Executable hook directories are not allowed: ${childAbsolutePath}`);
    }

    if (!isPackageContainedRelativePath(resolvedRelative)) {
      throw new Error(`Symlink resolves outside the package root: ${childAbsolutePath}`);
    }

    if (entry.name === "package.json") {
      await readManifestPackageJson(resolvedChild);
      continue;
    }

    const isSymlinkDirectory = entry.isSymbolicLink() && (await stat(resolvedChild)).isDirectory();
    if (isSymlinkDirectory) {
      throw new Error(`Directory symlinks are not allowed: ${childAbsolutePath}`);
    }

    const isDirectoryLike = entry.isDirectory();

    if (isDirectoryLike) {
      await collectPackageFiles(
        root,
        childAbsolutePath,
        manifestEntrypoint,
        collectSourceFiles && entry.name !== "assets",
        sourceFiles
      );
      continue;
    }

    if (entry.name === "assets") {
      continue;
    }

    if (entry.isSymbolicLink()) {
      const targetStat = await stat(resolvedChild);
      if (targetStat.isDirectory()) {
        continue;
      }
    }

    if (collectSourceFiles && shouldCollectSourceFile(childRelativePosix, manifestEntrypoint)) {
      sourceFiles[childRelativePosix] = await readFile(resolvedChild, "utf8");
    }
  }
}

export async function readPlaybookGraphPackage(root: string): Promise<PlaybookGraphPackageFiles> {
  const rootPath = await realpath(root);
  const manifestPath = join(rootPath, "manifest.json");
  const resolvedManifestPath = await realpath(manifestPath);
  const manifestRelative = toPosixPath(relative(rootPath, resolvedManifestPath));
  if (!isPackageContainedRelativePath(manifestRelative)) {
    throw new Error(`manifest.json resolves outside the package root: ${manifestPath}`);
  }
  const manifestRaw = await readFile(resolvedManifestPath, "utf8");
  const manifest = PlaybookGraphPackageManifestSchema.parse(JSON.parse(manifestRaw) as unknown);
  const manifestEntrypoint = assertPackageRelativePath(manifest.entrypoint);
  const sourceFiles: Record<string, string> = {};

  sourceFiles["manifest.json"] = manifestRaw;

  if (manifestEntrypoint !== "manifest.json") {
    const entrypointPath = join(rootPath, manifestEntrypoint);
    const entrypointResolved = await realpath(entrypointPath);
    const entrypointRelative = toPosixPath(relative(rootPath, entrypointResolved));
    if (!isPackageContainedRelativePath(entrypointRelative)) {
      throw new Error(
        `Manifest entrypoint resolves outside the package root: ${manifest.entrypoint}`
      );
    }
    sourceFiles[manifestEntrypoint] = await readFile(entrypointResolved, "utf8");
  }

  await collectPackageFiles(rootPath, rootPath, manifestEntrypoint, true, sourceFiles);

  return {
    root: rootPath,
    manifestPath,
    manifest,
    sourceFiles: Object.fromEntries(
      Object.entries(sourceFiles).sort(([left], [right]) => compareStrings(left, right))
    ),
  };
}
