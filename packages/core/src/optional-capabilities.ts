import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface OptionalCapabilityBinary {
  name: string;
  relativePath: string;
}

export type OptionalCapabilityArchiveKind = "tar.gz" | "zip";

export interface OptionalCapabilityArchive {
  kind: OptionalCapabilityArchiveKind;
  entry: string;
}

export interface OptionalCapabilityAsset {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  url: string;
  sha256: string;
  executableName: string;
  sizeBytes?: number;
  archive?: OptionalCapabilityArchive;
}

export interface OptionalCapabilityExtractInput {
  archivePath: string;
  outputDir: string;
  kind: OptionalCapabilityArchiveKind;
}

export type OptionalCapabilityExtract = (input: OptionalCapabilityExtractInput) => Promise<void>;

export interface OptionalCapabilityDefinition {
  id: string;
  label: string;
  version: string;
  binaries: OptionalCapabilityBinary[];
  assets: OptionalCapabilityAsset[];
}

export interface OptionalCapabilityStatus {
  id: string;
  label: string;
  version: string;
  status: "installed" | "available" | "unavailable";
  installed: boolean;
  installAvailable: boolean;
  sizeBytes?: number;
  binaryPaths: Record<string, string>;
  message?: string;
}

export interface OptionalCapabilityInstallResult {
  id: string;
  label: string;
  version: string;
  status: "installed";
  binaryPaths: Record<string, string>;
}

export type OptionalCapabilityInstallPhase =
  | "downloading"
  | "verifying"
  | "installing"
  | "installed";

export interface OptionalCapabilityInstallProgress {
  id: string;
  label: string;
  version: string;
  phase: OptionalCapabilityInstallPhase;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface OptionalCapabilityInstallOptions {
  onProgress?: (progress: OptionalCapabilityInstallProgress) => void;
}

export interface OptionalCapabilityManager {
  resolveBinary(capabilityId: string, binaryName: string): Promise<string | undefined>;
  status(capabilityId: string): Promise<OptionalCapabilityStatus>;
  install(
    capabilityId: string,
    options?: OptionalCapabilityInstallOptions
  ): Promise<OptionalCapabilityInstallResult>;
}

export interface OptionalCapabilityManagerOptions {
  rootDir: string;
  definitions: OptionalCapabilityDefinition[];
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  download?: (
    url: string,
    options?: OptionalCapabilityInstallOptions
  ) => Promise<Buffer | Uint8Array | ArrayBuffer>;
  extract?: OptionalCapabilityExtract;
}

export interface OptionalCapabilityEnv {
  [key: string]: string | undefined;
  TESSERA_PDF_RENDER_URL?: string;
  TESSERA_PDF_RENDER_SHA256?: string;
  TESSERA_PDF_RENDER_VERSION?: string;
  TESSERA_PDF_RENDER_SIZE_BYTES?: string;
  TESSERA_PDF_TRANSFORM_URL?: string;
  TESSERA_PDF_TRANSFORM_SHA256?: string;
  TESSERA_PDF_TRANSFORM_VERSION?: string;
  TESSERA_PDF_TRANSFORM_SIZE_BYTES?: string;
  TESSERA_GWS_CLI_URL?: string;
  TESSERA_GWS_CLI_SHA256?: string;
  TESSERA_GWS_CLI_VERSION?: string;
  TESSERA_GWS_CLI_SIZE_BYTES?: string;
}

interface GwsTripleEntry {
  triple: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  kind: OptionalCapabilityArchiveKind;
  sha256: string;
}

const GWS_CLI_VERSION = "0.22.5";

// Linux gnu variants intentionally precede musl so findAsset's linear search
// returns the glibc build for desktop Linux.
const GWS_CLI_TRIPLES: GwsTripleEntry[] = [
  {
    triple: "aarch64-apple-darwin",
    platform: "darwin",
    arch: "arm64",
    kind: "tar.gz",
    sha256: "1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac",
  },
  {
    triple: "x86_64-apple-darwin",
    platform: "darwin",
    arch: "x64",
    kind: "tar.gz",
    sha256: "51f9bd731404d4bba26c36e2e30dd68c56dccd1f834c01252cb0b14d6a6544b2",
  },
  {
    triple: "aarch64-unknown-linux-gnu",
    platform: "linux",
    arch: "arm64",
    kind: "tar.gz",
    sha256: "94490295d9580e1e88574e715a0a162991747d12d62f8c7b8dcc8268b6c1cea0",
  },
  {
    triple: "aarch64-unknown-linux-musl",
    platform: "linux",
    arch: "arm64",
    kind: "tar.gz",
    sha256: "e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a",
  },
  {
    triple: "x86_64-unknown-linux-gnu",
    platform: "linux",
    arch: "x64",
    kind: "tar.gz",
    sha256: "de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f",
  },
  {
    triple: "x86_64-unknown-linux-musl",
    platform: "linux",
    arch: "x64",
    kind: "tar.gz",
    sha256: "4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920",
  },
  {
    triple: "x86_64-pc-windows-msvc",
    platform: "win32",
    arch: "x64",
    kind: "zip",
    sha256: "407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2",
  },
];

function gwsExecutableForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? "gws.exe" : "gws";
}

function builtinGwsDefinition(
  version: string,
  hostPlatform: NodeJS.Platform
): OptionalCapabilityDefinition {
  const relativePath = gwsExecutableForPlatform(hostPlatform);
  const assets: OptionalCapabilityAsset[] = GWS_CLI_TRIPLES.map((entry) => {
    const executableName = gwsExecutableForPlatform(entry.platform);
    const extension = entry.kind === "tar.gz" ? "tar.gz" : "zip";
    return {
      platform: entry.platform,
      arch: entry.arch,
      url: `https://github.com/googleworkspace/cli/releases/download/v${GWS_CLI_VERSION}/google-workspace-cli-${entry.triple}.${extension}`,
      sha256: entry.sha256,
      executableName,
      archive: { kind: entry.kind, entry: executableName },
    };
  });
  return {
    id: "google-workspace-cli",
    label: "Google Workspace CLI",
    version,
    binaries: [{ name: "gws", relativePath }],
    assets,
  };
}

export function builtinCapabilityDefinitions(
  options: { platform?: NodeJS.Platform } = {}
): OptionalCapabilityDefinition[] {
  const platform = options.platform ?? process.platform;
  return [builtinGwsDefinition(GWS_CLI_VERSION, platform)];
}

export function optionalCapabilityDefinitionsFromEnv(
  env: OptionalCapabilityEnv,
  options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
  } = {}
): OptionalCapabilityDefinition[] {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const definitions: OptionalCapabilityDefinition[] = [];
  const renderAsset = assetFromEnv({
    platform,
    arch,
    url: env.TESSERA_PDF_RENDER_URL,
    sha256: env.TESSERA_PDF_RENDER_SHA256,
    executableName: "pdftoppm",
    sizeBytes: env.TESSERA_PDF_RENDER_SIZE_BYTES,
  });
  if (renderAsset) {
    definitions.push({
      id: "pdf-render",
      label: "PDF render engine",
      version: env.TESSERA_PDF_RENDER_VERSION?.trim() || "managed",
      binaries: [{ name: "pdftoppm", relativePath: "pdftoppm" }],
      assets: [renderAsset],
    });
  }

  const transformAsset = assetFromEnv({
    platform,
    arch,
    url: env.TESSERA_PDF_TRANSFORM_URL,
    sha256: env.TESSERA_PDF_TRANSFORM_SHA256,
    executableName: "qpdf",
    sizeBytes: env.TESSERA_PDF_TRANSFORM_SIZE_BYTES,
  });
  if (transformAsset) {
    definitions.push({
      id: "pdf-transform",
      label: "PDF transform engine",
      version: env.TESSERA_PDF_TRANSFORM_VERSION?.trim() || "managed",
      binaries: [{ name: "qpdf", relativePath: "qpdf" }],
      assets: [transformAsset],
    });
  }

  const gwsVersion = env.TESSERA_GWS_CLI_VERSION?.trim() || GWS_CLI_VERSION;
  const gws = builtinGwsDefinition(gwsVersion, platform);
  const envIsForHost = platform === process.platform && arch === process.arch;
  const gwsOverride = envIsForHost
    ? assetFromEnv({
        platform,
        arch,
        url: env.TESSERA_GWS_CLI_URL,
        sha256: env.TESSERA_GWS_CLI_SHA256,
        executableName: gwsExecutableForPlatform(platform),
        sizeBytes: env.TESSERA_GWS_CLI_SIZE_BYTES,
      })
    : undefined;
  if (gwsOverride) {
    gws.assets = gws.assets.map((asset) =>
      asset.platform === platform && asset.arch === arch ? gwsOverride : asset
    );
  }
  definitions.push(gws);

  return definitions;
}

export function createOptionalCapabilityManager(
  options: OptionalCapabilityManagerOptions
): OptionalCapabilityManager {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const definitions = new Map(options.definitions.map((definition) => [definition.id, definition]));
  const download = options.download ?? defaultDownload;
  const extract = options.extract ?? defaultExtract;

  async function resolveBinary(
    capabilityId: string,
    binaryName: string
  ): Promise<string | undefined> {
    const definition = requireDefinition(definitions, capabilityId);
    const binary = definition.binaries.find((item) => item.name === binaryName);
    if (!binary) return undefined;
    const path = binaryPath(options.rootDir, definition, binary);
    const metadata = await stat(path).catch(() => null);
    return metadata?.isFile() ? path : undefined;
  }

  async function status(capabilityId: string): Promise<OptionalCapabilityStatus> {
    const definition = requireDefinition(definitions, capabilityId);
    const asset = findAsset(definition, platform, arch);
    const binaryPaths = await installedBinaryPaths(options.rootDir, definition);
    const installed = Object.keys(binaryPaths).length === definition.binaries.length;

    if (installed) {
      return {
        id: definition.id,
        label: definition.label,
        version: definition.version,
        status: "installed",
        installed: true,
        installAvailable: asset !== undefined,
        ...(asset?.sizeBytes !== undefined ? { sizeBytes: asset.sizeBytes } : {}),
        binaryPaths,
      };
    }

    return {
      id: definition.id,
      label: definition.label,
      version: definition.version,
      status: asset ? "available" : "unavailable",
      installed: false,
      installAvailable: asset !== undefined,
      ...(asset?.sizeBytes !== undefined ? { sizeBytes: asset.sizeBytes } : {}),
      binaryPaths: {},
      ...(asset
        ? {}
        : { message: `No ${definition.label} asset is available for ${platform}/${arch}.` }),
    };
  }

  async function install(
    capabilityId: string,
    installOptions: OptionalCapabilityInstallOptions = {}
  ): Promise<OptionalCapabilityInstallResult> {
    const definition = requireDefinition(definitions, capabilityId);
    const current = await status(capabilityId);
    if (current.installed) {
      return {
        id: definition.id,
        label: definition.label,
        version: definition.version,
        status: "installed",
        binaryPaths: current.binaryPaths,
      };
    }

    const asset = findAsset(definition, platform, arch);
    if (!asset) {
      throw new Error(`No ${definition.label} asset is available for ${platform}/${arch}.`);
    }
    let downloadProgressReported = false;
    const emitProgress = (
      phase: OptionalCapabilityInstallPhase,
      progress: Partial<OptionalCapabilityInstallProgress> = {}
    ) => {
      installOptions.onProgress?.({
        id: definition.id,
        label: definition.label,
        version: definition.version,
        phase,
        ...progress,
      });
    };
    const downloaded = await download(asset.url, {
      onProgress(progress) {
        downloadProgressReported = true;
        const totalBytes = progress.totalBytes ?? asset.sizeBytes;
        emitProgress("downloading", {
          ...(progress.downloadedBytes !== undefined
            ? { downloadedBytes: progress.downloadedBytes }
            : {}),
          ...(totalBytes !== undefined ? { totalBytes } : {}),
        });
      },
    });
    const payload =
      downloaded instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(downloaded))
        : Buffer.from(downloaded);
    const completedBytes = payload.byteLength;
    const totalBytes = asset.sizeBytes ?? completedBytes;
    if (!downloadProgressReported) {
      emitProgress("downloading", {
        downloadedBytes: completedBytes,
        totalBytes,
      });
    }
    emitProgress("verifying", {
      downloadedBytes: completedBytes,
      totalBytes,
    });
    const actualHash = sha256(payload);
    if (actualHash !== asset.sha256) {
      throw new Error(
        `Downloaded capability checksum mismatch for ${definition.id}: expected ${asset.sha256}, got ${actualHash}.`
      );
    }

    const binary = definition.binaries.find((item) => item.relativePath === asset.executableName);
    if (!binary) {
      throw new Error(
        `Capability asset ${asset.executableName} does not match a declared binary for ${definition.id}.`
      );
    }
    emitProgress("installing", {
      downloadedBytes: completedBytes,
      totalBytes,
    });
    const outputPath = binaryPath(options.rootDir, definition, binary);
    await mkdir(dirname(outputPath), { recursive: true });
    if (asset.archive) {
      const archive = asset.archive;
      const workDir = await mkdtemp(join(tmpdir(), `tessera-capability-${definition.id}-`));
      const archivePath = join(workDir, archive.kind === "tar.gz" ? "asset.tar.gz" : "asset.zip");
      const extractDir = join(workDir, "extracted");
      try {
        await writeFile(archivePath, payload);
        await mkdir(extractDir, { recursive: true });
        await extract({ archivePath, outputDir: extractDir, kind: archive.kind });
        const entryPath = resolve(extractDir, archive.entry);
        const entryRelative = relative(extractDir, entryPath);
        if (entryRelative.startsWith("..") || isAbsolute(entryRelative)) {
          throw new Error(
            `Capability archive entry escapes the extract directory: ${definition.id}`
          );
        }
        await copyFile(entryPath, outputPath);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    } else {
      await writeFile(outputPath, payload);
    }
    if (process.platform !== "win32") {
      await chmod(outputPath, 0o755);
    }
    await writeFile(
      join(capabilityDirectory(options.rootDir, definition), "capability.json"),
      `${JSON.stringify(
        {
          id: definition.id,
          label: definition.label,
          version: definition.version,
          installedAt: new Date().toISOString(),
          asset: {
            platform,
            arch,
            url: asset.url,
            sha256: asset.sha256,
          },
        },
        null,
        2
      )}\n`
    );

    const binaryPaths = await installedBinaryPaths(options.rootDir, definition);
    emitProgress("installed", {
      downloadedBytes: completedBytes,
      totalBytes,
    });
    return {
      id: definition.id,
      label: definition.label,
      version: definition.version,
      status: "installed",
      binaryPaths,
    };
  }

  return { resolveBinary, status, install };
}

async function defaultDownload(
  url: string,
  options: OptionalCapabilityInstallOptions = {}
): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Capability download failed (${response.status}): ${url}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes =
    contentLength && Number.isFinite(Number.parseInt(contentLength, 10))
      ? Number.parseInt(contentLength, 10)
      : undefined;
  if (!response.body) {
    const payload = Buffer.from(await response.arrayBuffer());
    options.onProgress?.({
      id: "",
      label: "",
      version: "",
      phase: "downloading",
      downloadedBytes: payload.byteLength,
      totalBytes: totalBytes ?? payload.byteLength,
    });
    return payload;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    downloadedBytes += value.byteLength;
    options.onProgress?.({
      id: "",
      label: "",
      version: "",
      phase: "downloading",
      downloadedBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
    });
  }
  return Buffer.concat(chunks);
}

async function defaultExtract(input: OptionalCapabilityExtractInput): Promise<void> {
  if (input.kind === "tar.gz") {
    await runCommand("tar", ["-xzf", input.archivePath, "-C", input.outputDir]);
    return;
  }
  if (process.platform === "win32") {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      "--",
      input.archivePath,
      input.outputDir,
    ]);
    return;
  }
  await runCommand("unzip", ["-q", "-o", input.archivePath, "-d", input.outputDir]);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function requireDefinition(
  definitions: Map<string, OptionalCapabilityDefinition>,
  id: string
): OptionalCapabilityDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error(`Unknown optional capability: ${id}`);
  return definition;
}

function findAsset(
  definition: OptionalCapabilityDefinition,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): OptionalCapabilityAsset | undefined {
  return definition.assets.find((asset) => asset.platform === platform && asset.arch === arch);
}

function assetFromEnv(options: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  url: string | undefined;
  sha256: string | undefined;
  executableName: string;
  sizeBytes: string | undefined;
}): OptionalCapabilityAsset | undefined {
  const url = options.url?.trim();
  const sha256 = options.sha256?.trim();
  if (!url || !sha256) return undefined;
  const parsedSize =
    options.sizeBytes !== undefined && options.sizeBytes.trim().length > 0
      ? Number.parseInt(options.sizeBytes, 10)
      : undefined;
  return {
    platform: options.platform,
    arch: options.arch,
    url,
    sha256,
    executableName: options.executableName,
    ...(parsedSize !== undefined && Number.isFinite(parsedSize) && parsedSize > 0
      ? { sizeBytes: parsedSize }
      : {}),
  };
}

function binaryPath(
  rootDir: string,
  definition: OptionalCapabilityDefinition,
  binary: OptionalCapabilityBinary
): string {
  const directory = capabilityDirectory(rootDir, definition);
  const path = resolve(directory, binary.relativePath);
  const pathRelativeToDirectory = relative(directory, path);
  if (pathRelativeToDirectory.startsWith("..") || isAbsolute(pathRelativeToDirectory)) {
    throw new Error(`Capability binary path escapes the managed root: ${definition.id}`);
  }
  return path;
}

function capabilityDirectory(rootDir: string, definition: OptionalCapabilityDefinition): string {
  const root = resolve(rootDir);
  const directory = resolve(root, definition.id, definition.version);
  const directoryRelativeToRoot = relative(root, directory);
  if (directoryRelativeToRoot.startsWith("..") || isAbsolute(directoryRelativeToRoot)) {
    throw new Error(`Capability path escapes the managed root: ${definition.id}`);
  }
  return directory;
}

async function installedBinaryPaths(
  rootDir: string,
  definition: OptionalCapabilityDefinition
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    definition.binaries.map(async (binary) => {
      const path = binaryPath(rootDir, definition, binary);
      const metadata = await stat(path).catch(() => null);
      return metadata?.isFile() ? ([binary.name, path] as const) : undefined;
    })
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => !!entry));
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
