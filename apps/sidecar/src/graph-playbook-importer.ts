import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GraphPlaybookImportResult,
  GraphPlaybookImportResultSchema,
  PlaybookGraphPackageManifestSchema,
} from "@tessera/contracts";
import { installGraphPlaybookPackage } from "@tessera/core";
import {
  type GraphPlaybookRegistryEntry,
  loadInstalledGraphPlaybookCatalog,
  loadInstalledGraphPlaybookRegistry,
} from "./graph-playbook-registry.js";
import { extractZipArchive } from "./zip-archive.js";

interface ImportResultContext {
  installedPlaybookId: string;
  installedPackageVersion: string;
  installedGraphHash: string;
  installedSourceHash: string;
  beforeFull: GraphPlaybookRegistryEntry[];
  beforeCatalog: GraphPlaybookRegistryEntry[];
  afterFull: GraphPlaybookRegistryEntry[];
  afterCatalog: GraphPlaybookRegistryEntry[];
  warnings?: string[];
  sourceDescription: string;
}

export interface ImportGraphPlaybookArchiveOptions {
  zipPath: string;
  installRoot: string;
  cacheRoot: string;
  stagingRoot?: string;
  builtInIds?: Iterable<string>;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

export interface ImportGraphPlaybookFolderOptions {
  sourceRoot: string;
  installRoot: string;
  cacheRoot: string;
  builtInIds?: Iterable<string>;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

function compareEntry(
  left: GraphPlaybookRegistryEntry,
  right: GraphPlaybookRegistryEntry
): boolean {
  return (
    left.id === right.id &&
    left.packageVersion === right.packageVersion &&
    left.graphHash === right.graphHash &&
    left.sourceHash === right.sourceHash
  );
}

async function hasManifest(root: string): Promise<boolean> {
  try {
    await readFile(join(root, "manifest.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function resolvePackageRoot(extractedRoot: string): Promise<string> {
  const candidates: string[] = [];
  if (await hasManifest(extractedRoot)) {
    candidates.push(extractedRoot);
  }

  for (const entry of await readdir(extractedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(extractedRoot, entry.name);
    if (await hasManifest(candidate)) {
      candidates.push(candidate);
    }
  }

  if (candidates.length !== 1) {
    throw new Error("Invalid graph playbook archive: expected exactly one package root");
  }
  return candidates[0] ?? extractedRoot;
}

async function readManifestId(packageRoot: string): Promise<string> {
  const raw = await readFile(join(packageRoot, "manifest.json"), "utf8");
  return PlaybookGraphPackageManifestSchema.parse(JSON.parse(raw) as unknown).id;
}

function importStatus(input: {
  installed: GraphPlaybookRegistryEntry;
  beforeFull: GraphPlaybookRegistryEntry[];
  beforeCatalog: GraphPlaybookRegistryEntry[];
  afterCatalog: GraphPlaybookRegistryEntry[];
}): GraphPlaybookImportResult["status"] {
  const previousSameInstall = input.beforeFull.find((entry) =>
    compareEntry(entry, input.installed)
  );
  if (previousSameInstall) return "unchanged";

  const previousForId = input.beforeFull.some((entry) => entry.id === input.installed.id);
  if (!previousForId) return "installed";

  const beforeLatest = input.beforeCatalog.find((entry) => entry.id === input.installed.id);
  const afterLatest = input.afterCatalog.find((entry) => entry.id === input.installed.id);
  if (afterLatest && compareEntry(afterLatest, input.installed)) {
    return beforeLatest && !compareEntry(beforeLatest, input.installed) ? "updated" : "installed";
  }
  return "archived";
}

function graphPlaybookImportResult(input: ImportResultContext): GraphPlaybookImportResult {
  const installedEntry = input.afterFull.find(
    (entry) =>
      entry.id === input.installedPlaybookId &&
      entry.packageVersion === input.installedPackageVersion &&
      entry.graphHash === input.installedGraphHash &&
      entry.sourceHash === input.installedSourceHash
  );
  if (!installedEntry) {
    throw new Error(
      `Graph playbook ${input.sourceDescription} import did not produce a valid installed entry`
    );
  }

  return GraphPlaybookImportResultSchema.parse({
    schemaVersion: 1,
    status: importStatus({
      installed: installedEntry,
      beforeFull: input.beforeFull,
      beforeCatalog: input.beforeCatalog,
      afterCatalog: input.afterCatalog,
    }),
    id: installedEntry.id,
    version: installedEntry.packageVersion,
    name: installedEntry.name,
    graphHash: installedEntry.graphHash,
    sourceHash: installedEntry.sourceHash,
    warnings: input.warnings ?? [],
  });
}

export async function importGraphPlaybookArchive(
  options: ImportGraphPlaybookArchiveOptions
): Promise<GraphPlaybookImportResult> {
  const stagingParent = options.stagingRoot ?? tmpdir();
  await mkdir(stagingParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(stagingParent, "tessera-playbook-import-"));

  try {
    const beforeFull = await loadInstalledGraphPlaybookRegistry({
      installRoot: options.installRoot,
      cacheRoot: options.cacheRoot,
    });
    const beforeCatalog = await loadInstalledGraphPlaybookCatalog({
      installRoot: options.installRoot,
      cacheRoot: options.cacheRoot,
    });

    await extractZipArchive({ zipPath: options.zipPath, destinationRoot: stagingRoot });
    const packageRoot = await resolvePackageRoot(stagingRoot);
    const manifestId = await readManifestId(packageRoot);
    if (new Set(options.builtInIds ?? []).has(manifestId)) {
      throw new Error(`Graph playbook package conflict for ${manifestId}: built-in id collision.`);
    }

    const installed = await installGraphPlaybookPackage({
      sourceRoot: packageRoot,
      installRoot: options.installRoot,
      cacheRoot: options.cacheRoot,
      compilerVersion: options.compilerVersion,
      scriptSdkVersion: options.scriptSdkVersion,
      ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
    });
    const afterFull = await loadInstalledGraphPlaybookRegistry({
      installRoot: options.installRoot,
      cacheRoot: options.cacheRoot,
    });
    const afterCatalog = await loadInstalledGraphPlaybookCatalog({
      installRoot: options.installRoot,
      cacheRoot: options.cacheRoot,
    });
    return graphPlaybookImportResult({
      installedPlaybookId: installed.compiled.metadata.playbookId,
      installedPackageVersion: installed.compiled.metadata.packageVersion,
      installedGraphHash: installed.compiled.metadata.graphHash,
      installedSourceHash: installed.compiled.metadata.sourceHash,
      beforeFull,
      beforeCatalog,
      afterFull,
      afterCatalog,
      warnings: installed.warnings ?? [],
      sourceDescription: "archive",
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function importGraphPlaybookFolder(
  options: ImportGraphPlaybookFolderOptions
): Promise<GraphPlaybookImportResult> {
  const beforeFull = await loadInstalledGraphPlaybookRegistry({
    installRoot: options.installRoot,
    cacheRoot: options.cacheRoot,
  });
  const beforeCatalog = await loadInstalledGraphPlaybookCatalog({
    installRoot: options.installRoot,
    cacheRoot: options.cacheRoot,
  });
  const manifestId = await readManifestId(options.sourceRoot);
  if (new Set(options.builtInIds ?? []).has(manifestId)) {
    throw new Error(`Graph playbook package conflict for ${manifestId}: built-in id collision.`);
  }

  const installed = await installGraphPlaybookPackage({
    sourceRoot: options.sourceRoot,
    installRoot: options.installRoot,
    cacheRoot: options.cacheRoot,
    compilerVersion: options.compilerVersion,
    scriptSdkVersion: options.scriptSdkVersion,
    ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
  });
  const afterFull = await loadInstalledGraphPlaybookRegistry({
    installRoot: options.installRoot,
    cacheRoot: options.cacheRoot,
  });
  const afterCatalog = await loadInstalledGraphPlaybookCatalog({
    installRoot: options.installRoot,
    cacheRoot: options.cacheRoot,
  });
  return graphPlaybookImportResult({
    installedPlaybookId: installed.compiled.metadata.playbookId,
    installedPackageVersion: installed.compiled.metadata.packageVersion,
    installedGraphHash: installed.compiled.metadata.graphHash,
    installedSourceHash: installed.compiled.metadata.sourceHash,
    beforeFull,
    beforeCatalog,
    afterFull,
    afterCatalog,
    warnings: installed.warnings ?? [],
    sourceDescription: "folder",
  });
}
