import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CompiledPlaybookGraph } from "@tessera/contracts";
import { createPlaybookGraphCache, hashPlaybookGraph } from "@tessera/core";

export interface GraphPlaybookRegistryEntry {
  id: string;
  version: string;
  name: string;
  graphHash: string;
  installedRoot: string;
}

interface FileError extends Error {
  code?: string;
}

interface InstallMetadata {
  schemaVersion: 1;
  playbookId: string;
  packageVersion: string;
  graphHash: string;
  sourceHash: string;
  installedAt: string;
}

function cacheSegment(value: string): string {
  return `v-${Buffer.from(value, "utf8").toString("base64url")}`;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isFileError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as FileError).code === code
  );
}

async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isFileError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isFileError(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function parseInstallMetadata(value: unknown): InstallMetadata | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.playbookId !== "string" ||
    candidate.playbookId.length === 0 ||
    typeof candidate.packageVersion !== "string" ||
    candidate.packageVersion.length === 0 ||
    typeof candidate.graphHash !== "string" ||
    !candidate.graphHash.startsWith("sha256:") ||
    typeof candidate.sourceHash !== "string" ||
    !candidate.sourceHash.startsWith("sha256:") ||
    typeof candidate.installedAt !== "string"
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    playbookId: candidate.playbookId,
    packageVersion: candidate.packageVersion,
    graphHash: candidate.graphHash,
    sourceHash: candidate.sourceHash,
    installedAt: candidate.installedAt,
  };
}

function compiledGraphMatchesInstallMetadata(
  compiled: CompiledPlaybookGraph,
  metadata: InstallMetadata
): boolean {
  return (
    compiled.metadata.playbookId === metadata.playbookId &&
    compiled.metadata.packageVersion === metadata.packageVersion &&
    compiled.metadata.sourceHash === metadata.sourceHash &&
    compiled.metadata.graphHash === metadata.graphHash &&
    hashPlaybookGraph(compiled.graph) === metadata.graphHash
  );
}

export async function loadInstalledGraphPlaybookRegistry(options: {
  installRoot: string;
  cacheRoot: string;
}): Promise<GraphPlaybookRegistryEntry[]> {
  const cache = createPlaybookGraphCache(options.cacheRoot);
  const entries: GraphPlaybookRegistryEntry[] = [];
  const playbookDirs = await readDirectory(options.installRoot);

  for (const playbookDir of playbookDirs) {
    if (!playbookDir.isDirectory()) {
      continue;
    }

    const playbookRoot = join(options.installRoot, playbookDir.name);
    const versionDirs = await readDirectory(playbookRoot);

    for (const versionDir of versionDirs) {
      if (!versionDir.isDirectory()) {
        continue;
      }

      const installedRoot = join(playbookRoot, versionDir.name);
      const metadata = parseInstallMetadata(await readJson(join(installedRoot, "install.json")));
      if (
        metadata === undefined ||
        playbookDir.name !== cacheSegment(metadata.playbookId) ||
        versionDir.name !== cacheSegment(metadata.packageVersion)
      ) {
        continue;
      }

      const compiled = await cache.get(metadata.playbookId, metadata.graphHash);
      if (compiled === undefined || !compiledGraphMatchesInstallMetadata(compiled, metadata)) {
        continue;
      }

      entries.push({
        id: metadata.playbookId,
        version: metadata.packageVersion,
        name: compiled.graph.name,
        graphHash: metadata.graphHash,
        installedRoot,
      });
    }
  }

  return entries.sort((left, right) => {
    const idComparison = compareStrings(left.id, right.id);
    return idComparison === 0 ? compareStrings(left.version, right.version) : idComparison;
  });
}
