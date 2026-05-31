import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CompiledPlaybookGraph, PlaybookGraphPackageManifestSchema } from "@tessera/contracts";
import { z } from "zod";
import { createPlaybookGraphCache } from "./playbook-graph-cache.js";
import {
  extractGraphPlaybookPackageGraph,
  loadGraphPlaybookPackage,
  validateGraphPlaybookPackageCompilation,
} from "./playbook-graph-package-loader.js";
import { readPlaybookGraphPackage } from "./playbook-graph-package.js";
import { hashPlaybookGraph, hashPlaybookSourceFiles } from "./playbook-graph.js";

export interface InstallGraphPlaybookPackageOptions {
  sourceRoot: string;
  installRoot: string;
  cacheRoot: string;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

export interface InstalledGraphPlaybookPackage {
  installedRoot: string;
  compiledGraphPath: string;
  compiled: CompiledPlaybookGraph;
  warnings?: string[];
}

const PLAYBOOK_ID_RE = /^[A-Za-z0-9._:-]+$/;
const INSTALL_METADATA_FILENAME = "install.json";
const INSTALL_SCHEMA_VERSION = 1 as const;

const InstalledGraphPlaybookPackageMetadataSchema = z
  .object({
    schemaVersion: z.literal(INSTALL_SCHEMA_VERSION),
    playbookId: z.string().min(1).regex(PLAYBOOK_ID_RE),
    packageVersion: z.string().min(1),
    graphHash: z
      .string()
      .min(1)
      .regex(/^sha256:/),
    sourceHash: z
      .string()
      .min(1)
      .regex(/^sha256:/),
    installedAt: z.string().datetime(),
  })
  .strict();

type InstalledGraphPlaybookPackageMetadata = z.infer<
  typeof InstalledGraphPlaybookPackageMetadataSchema
>;

interface ComparableVersionPart {
  kind: "numeric" | "text";
  value: number | string;
}

interface ComparableVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: ComparableVersionPart[];
}

function cacheSegment(value: string): string {
  return `v-${Buffer.from(value, "utf8").toString("base64url")}`;
}

function installPlaybookDir(installRoot: string, playbookId: string): string {
  return join(installRoot, cacheSegment(playbookId));
}

function installedVersionDir(
  installRoot: string,
  playbookId: string,
  packageVersion: string
): string {
  return join(installPlaybookDir(installRoot, playbookId), cacheSegment(packageVersion));
}

function installMetadataPath(
  installRoot: string,
  playbookId: string,
  packageVersion: string
): string {
  return join(
    installedVersionDir(installRoot, playbookId, packageVersion),
    INSTALL_METADATA_FILENAME
  );
}

function latestPointerPath(installRoot: string, playbookId: string): string {
  return join(installPlaybookDir(installRoot, playbookId), "latest.json");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, serializeJson(value), "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function writeAcceptedPackageFiles(
  sourceFiles: Record<string, string>,
  targetRoot: string
): Promise<void> {
  for (const [relativePath, content] of Object.entries(sourceFiles).sort(([left], [right]) =>
    compareStrings(left, right)
  )) {
    const targetPath = join(targetRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }
}

async function readInstalledSourceFiles(
  installedRoot: string
): Promise<Record<string, string> | undefined> {
  const sourceFiles: Record<string, string> = {};
  const pending = [installedRoot];

  try {
    while (pending.length > 0) {
      const currentPath = pending.pop();
      if (currentPath === undefined) {
        continue;
      }

      const entries = await readdir(currentPath, { withFileTypes: true });
      entries.sort((left, right) => compareStrings(left.name, right.name));

      for (const entry of entries) {
        const absolutePath = join(currentPath, entry.name);
        const relativePath = absolutePath.slice(installedRoot.length + 1).replaceAll("\\", "/");

        if (entry.isDirectory()) {
          pending.push(absolutePath);
          continue;
        }
        if (!entry.isFile() || relativePath === INSTALL_METADATA_FILENAME) {
          continue;
        }

        sourceFiles[relativePath] = await readFile(absolutePath, "utf8");
      }
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }

  return sourceFiles;
}

function extractInstalledGraph(sourceFiles: Record<string, string>): unknown {
  try {
    const manifest = JSON.parse(sourceFiles["manifest.json"] ?? "{}") as { entrypoint?: unknown };
    const entrypoint =
      typeof manifest.entrypoint === "string" ? manifest.entrypoint : "playbook.ts";
    return extractGraphPlaybookPackageGraph(sourceFiles, entrypoint);
  } catch {
    return undefined;
  }
}

function parseComparableVersion(version: string): ComparableVersion | undefined {
  const match =
    /^(?:v)?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version
    );
  if (!match) {
    return undefined;
  }

  const prerelease = match[4];
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease:
      prerelease === undefined
        ? []
        : prerelease.split(".").map((part) => {
            if (/^(0|[1-9]\d*)$/.test(part)) {
              return { kind: "numeric", value: Number(part) } as const;
            }
            return { kind: "text", value: part } as const;
          }),
  };
}

function compareComparableVersionParts(
  left: ComparableVersionPart,
  right: ComparableVersionPart
): number {
  if (left.kind === "numeric" && right.kind === "numeric") {
    return left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
  }
  if (left.kind === "numeric") return -1;
  if (right.kind === "numeric") return 1;
  const leftText = left.value as string;
  const rightText = right.value as string;
  return compareStrings(leftText, rightText);
}

function compareComparableVersions(left: string, right: string): number | undefined {
  const parsedLeft = parseComparableVersion(left);
  const parsedRight = parseComparableVersion(right);
  if (!parsedLeft || !parsedRight) {
    return undefined;
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] !== parsedRight[key]) {
      return parsedLeft[key] < parsedRight[key] ? -1 : 1;
    }
  }

  const leftPrerelease = parsedLeft.prerelease;
  const rightPrerelease = parsedRight.prerelease;
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0;
  }
  if (leftPrerelease.length === 0) {
    return 1;
  }
  if (rightPrerelease.length === 0) {
    return -1;
  }

  for (let index = 0; index < Math.min(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      break;
    }

    const comparison = compareComparableVersionParts(leftPart, rightPart);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (leftPrerelease.length !== rightPrerelease.length) {
    return leftPrerelease.length < rightPrerelease.length ? -1 : 1;
  }

  return 0;
}

function installMetadataFromCompiled(
  compiled: CompiledPlaybookGraph,
  installedAt: string
): InstalledGraphPlaybookPackageMetadata {
  return {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    playbookId: compiled.metadata.playbookId,
    packageVersion: compiled.metadata.packageVersion,
    graphHash: compiled.metadata.graphHash,
    sourceHash: compiled.metadata.sourceHash,
    installedAt,
  };
}

async function readInstalledMetadata(
  path: string
): Promise<InstalledGraphPlaybookPackageMetadata | undefined> {
  const raw = await readJsonFile<unknown>(path);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = InstalledGraphPlaybookPackageMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function readInstalledPackageMetadatas(
  playbookDir: string,
  playbookId: string
): Promise<InstalledGraphPlaybookPackageMetadata[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(playbookDir, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const metadatas: InstalledGraphPlaybookPackageMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const metadata = await readInstalledMetadata(
      join(playbookDir, entry.name, INSTALL_METADATA_FILENAME)
    );
    if (
      metadata !== undefined &&
      metadata.playbookId === playbookId &&
      entry.name === cacheSegment(metadata.packageVersion)
    ) {
      const sourceFiles = await readInstalledSourceFiles(join(playbookDir, entry.name));
      if (
        sourceFiles === undefined ||
        hashPlaybookSourceFiles(sourceFiles) !== metadata.sourceHash
      ) {
        continue;
      }
      const graph = extractInstalledGraph(sourceFiles);
      if (graph === undefined || hashPlaybookGraph(graph) !== metadata.graphHash) {
        continue;
      }
      try {
        const manifest = PlaybookGraphPackageManifestSchema.parse(
          JSON.parse(sourceFiles["manifest.json"] ?? "{}") as unknown
        );
        const compiled: CompiledPlaybookGraph = {
          graph: graph as CompiledPlaybookGraph["graph"],
          metadata: {
            schemaVersion: 1 as const,
            playbookId: metadata.playbookId,
            packageVersion: metadata.packageVersion,
            compilerVersion: "installed-candidate",
            graphSchemaVersion: 1 as const,
            scriptSdkVersion: "installed-candidate",
            sourceHash: metadata.sourceHash,
            graphHash: metadata.graphHash,
            compiledAt: metadata.installedAt,
          },
        };
        validateGraphPlaybookPackageCompilation({
          sourceFiles,
          manifest,
          compiled,
        });
      } catch {
        continue;
      }
      metadatas.push(metadata);
    }
  }

  return metadatas;
}

function isSameInstalledMetadata(
  left: InstalledGraphPlaybookPackageMetadata,
  right: InstalledGraphPlaybookPackageMetadata
): boolean {
  return (
    left.playbookId === right.playbookId &&
    left.packageVersion === right.packageVersion &&
    left.graphHash === right.graphHash &&
    left.sourceHash === right.sourceHash
  );
}

function chooseLatestMetadata(
  currentLatest: InstalledGraphPlaybookPackageMetadata | undefined,
  candidates: InstalledGraphPlaybookPackageMetadata[]
): { latest: InstalledGraphPlaybookPackageMetadata | undefined; warning?: string } {
  const trustedCurrentLatest =
    currentLatest === undefined
      ? undefined
      : candidates.find((candidate) => isSameInstalledMetadata(candidate, currentLatest));

  if (candidates.length === 0) {
    return { latest: undefined };
  }

  if (
    candidates.some((candidate) => parseComparableVersion(candidate.packageVersion) === undefined)
  ) {
    if (trustedCurrentLatest !== undefined) {
      return {
        latest: trustedCurrentLatest,
        warning: `Could not compare installed versions; keeping ${trustedCurrentLatest.packageVersion} as latest.`,
      };
    }
    if (candidates.length === 1) {
      return { latest: candidates[0] };
    }
    const comparableCandidates = candidates.filter(
      (candidate) => parseComparableVersion(candidate.packageVersion) !== undefined
    );
    if (comparableCandidates.length > 0) {
      return {
        ...chooseLatestMetadata(undefined, comparableCandidates),
        warning:
          "Could not compare all installed versions; latest was rebuilt from comparable versions.",
      };
    }
    return {
      latest: undefined,
      warning: "Could not compare installed versions; latest pointer was not updated.",
    };
  }

  let latest = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (latest === undefined) {
      latest = candidate;
      continue;
    }

    const comparison = compareComparableVersions(latest.packageVersion, candidate.packageVersion);
    if (comparison === undefined) {
      if (trustedCurrentLatest !== undefined) {
        return {
          latest: trustedCurrentLatest,
          warning: `Could not compare installed versions; keeping ${trustedCurrentLatest.packageVersion} as latest.`,
        };
      }
      return {
        latest: undefined,
        warning: "Could not compare installed versions; latest pointer was not updated.",
      };
    }
    if (comparison < 0) {
      latest = candidate;
    }
  }

  return { latest };
}

async function saveCompiledGraphPreservingLatest(
  cache: ReturnType<typeof createPlaybookGraphCache>,
  compiled: CompiledPlaybookGraph,
  latest: InstalledGraphPlaybookPackageMetadata | undefined
): Promise<string> {
  const compiledGraphPath = await cache.save(compiled);
  if (
    latest !== undefined &&
    latest.graphHash !== compiled.metadata.graphHash &&
    latest.playbookId === compiled.metadata.playbookId
  ) {
    const latestCompiled = await cache.get(latest.playbookId, latest.graphHash);
    if (latestCompiled !== undefined) {
      await cache.save(latestCompiled);
    }
  }
  return compiledGraphPath;
}

export async function installGraphPlaybookPackage(
  options: InstallGraphPlaybookPackageOptions
): Promise<InstalledGraphPlaybookPackage> {
  const loaded = await loadGraphPlaybookPackage({
    root: options.sourceRoot,
    compilerVersion: options.compilerVersion,
    scriptSdkVersion: options.scriptSdkVersion,
    ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
  });
  const packageFiles = await readPlaybookGraphPackage(options.sourceRoot);
  if (hashPlaybookSourceFiles(packageFiles.sourceFiles) !== loaded.compiled.metadata.sourceHash) {
    throw new Error("Graph playbook package source changed while installing");
  }

  const cache = createPlaybookGraphCache(options.cacheRoot);
  const installedRoot = installedVersionDir(
    options.installRoot,
    loaded.compiled.metadata.playbookId,
    loaded.compiled.metadata.packageVersion
  );
  const latestPath = latestPointerPath(options.installRoot, loaded.compiled.metadata.playbookId);
  const installPath = installMetadataPath(
    options.installRoot,
    loaded.compiled.metadata.playbookId,
    loaded.compiled.metadata.packageVersion
  );
  const rawCurrentLatest = await readInstalledMetadata(latestPath);
  const candidates = await readInstalledPackageMetadatas(
    installPlaybookDir(options.installRoot, loaded.compiled.metadata.playbookId),
    loaded.compiled.metadata.playbookId
  );
  const currentInstall = candidates.find(
    (candidate) =>
      candidate.packageVersion === loaded.compiled.metadata.packageVersion &&
      candidate.sourceHash === loaded.compiled.metadata.sourceHash
  );
  const conflictingInstall = candidates.find(
    (candidate) =>
      candidate.packageVersion === loaded.compiled.metadata.packageVersion &&
      candidate.sourceHash !== loaded.compiled.metadata.sourceHash
  );

  if (
    currentInstall !== undefined &&
    currentInstall.sourceHash === loaded.compiled.metadata.sourceHash
  ) {
    const currentLatest =
      rawCurrentLatest?.playbookId === loaded.compiled.metadata.playbookId
        ? candidates.find((candidate) => isSameInstalledMetadata(candidate, rawCurrentLatest))
        : undefined;
    const latestDecision = chooseLatestMetadata(currentLatest, candidates);
    const warnings = latestDecision.warning ? [latestDecision.warning] : undefined;

    const compiledGraphPath = await saveCompiledGraphPreservingLatest(
      cache,
      loaded.compiled,
      latestDecision.latest
    );

    if (latestDecision.latest !== undefined) {
      await mkdir(dirname(latestPath), { recursive: true });
      await writeJsonFile(latestPath, latestDecision.latest);
    } else if (rawCurrentLatest !== undefined) {
      await rm(latestPath, { force: true });
    }

    return {
      installedRoot,
      compiledGraphPath,
      compiled: loaded.compiled,
      ...(warnings === undefined ? {} : { warnings }),
    };
  }

  if (conflictingInstall !== undefined) {
    throw new Error(
      `Graph playbook package conflict for ${loaded.compiled.metadata.playbookId}@${loaded.compiled.metadata.packageVersion}: source hash changed from ${conflictingInstall.sourceHash} to ${loaded.compiled.metadata.sourceHash}.`
    );
  }

  if (
    currentInstall !== undefined &&
    currentInstall.sourceHash !== loaded.compiled.metadata.sourceHash
  ) {
    throw new Error(
      `Graph playbook package conflict for ${loaded.compiled.metadata.playbookId}@${loaded.compiled.metadata.packageVersion}: source hash changed from ${currentInstall.sourceHash} to ${loaded.compiled.metadata.sourceHash}.`
    );
  }

  const installedAt = new Date().toISOString();
  const installMetadata = installMetadataFromCompiled(loaded.compiled, installedAt);
  const playbookDir = installPlaybookDir(options.installRoot, loaded.compiled.metadata.playbookId);
  await mkdir(playbookDir, { recursive: true });
  const tempInstallRoot = await mkdtemp(join(playbookDir, ".install-"));
  let renamed = false;

  try {
    await writeAcceptedPackageFiles(packageFiles.sourceFiles, tempInstallRoot);
    await writeJsonFile(join(tempInstallRoot, INSTALL_METADATA_FILENAME), installMetadata);

    await rename(tempInstallRoot, installedRoot);
    renamed = true;

    const candidates = await readInstalledPackageMetadatas(
      playbookDir,
      loaded.compiled.metadata.playbookId
    );
    const currentLatest =
      rawCurrentLatest?.playbookId === loaded.compiled.metadata.playbookId
        ? candidates.find((candidate) => isSameInstalledMetadata(candidate, rawCurrentLatest))
        : undefined;
    const latestDecision = chooseLatestMetadata(currentLatest, candidates);
    const warnings = latestDecision.warning ? [latestDecision.warning] : undefined;
    const compiledGraphPath = await saveCompiledGraphPreservingLatest(
      cache,
      loaded.compiled,
      latestDecision.latest
    );

    if (latestDecision.latest !== undefined) {
      await writeJsonFile(latestPath, latestDecision.latest);
    } else if (rawCurrentLatest !== undefined) {
      await rm(latestPath, { force: true });
    }

    return {
      installedRoot,
      compiledGraphPath,
      compiled: loaded.compiled,
      ...(warnings === undefined ? {} : { warnings }),
    };
  } catch (error) {
    if (!renamed) {
      await rm(tempInstallRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
