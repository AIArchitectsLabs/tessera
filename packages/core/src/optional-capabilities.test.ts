import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createOptionalCapabilityManager,
  optionalCapabilityDefinitionsFromEnv,
} from "./optional-capabilities.js";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("optional capability manager", () => {
  test("builds PDF capability definitions from release metadata env", () => {
    const definitions = optionalCapabilityDefinitionsFromEnv(
      {
        TESSERA_PDF_RENDER_URL: "https://downloads.tessera.local/tessera-pdf-render",
        TESSERA_PDF_RENDER_SHA256: "abc123",
        TESSERA_PDF_RENDER_VERSION: "24.02.0",
        TESSERA_PDF_RENDER_SIZE_BYTES: "42000000",
        TESSERA_PDF_RENDER_ARCHIVE_KIND: "tar.gz",
        TESSERA_PDF_RENDER_ARCHIVE_ENTRY: "bin/tessera-pdf-render",
        TESSERA_PDF_TRANSFORM_URL: "https://downloads.tessera.local/qpdf",
        TESSERA_PDF_TRANSFORM_SHA256: "def456",
        TESSERA_PDF_TRANSFORM_VERSION: "11.9.0",
        TESSERA_PDF_TRANSFORM_ARCHIVE_KIND: "zip",
        TESSERA_PDF_TRANSFORM_ARCHIVE_ENTRY: "bin/qpdf",
      },
      { platform: "darwin", arch: "arm64" }
    );

    const ids = definitions.map((d) => d.id);
    expect(ids).toEqual(["pdf-render", "pdf-transform", "google-workspace-cli"]);

    const render = definitions.find((d) => d.id === "pdf-render");
    expect(render).toEqual({
      id: "pdf-render",
      label: "PDF render engine",
      version: "24.02.0",
      binaries: [{ name: "tessera-pdf-render", relativePath: "tessera-pdf-render" }],
      assets: [
        {
          platform: "darwin",
          arch: "arm64",
          url: "https://downloads.tessera.local/tessera-pdf-render",
          sha256: "abc123",
          executableName: "tessera-pdf-render",
          sizeBytes: 42000000,
          archive: { kind: "tar.gz", entry: "bin/tessera-pdf-render" },
        },
      ],
    });

    const transform = definitions.find((d) => d.id === "pdf-transform");
    expect(transform).toEqual({
      id: "pdf-transform",
      label: "PDF transform engine",
      version: "11.9.0",
      binaries: [{ name: "qpdf", relativePath: "qpdf" }],
      assets: [
        {
          platform: "darwin",
          arch: "arm64",
          url: "https://downloads.tessera.local/qpdf",
          sha256: "def456",
          executableName: "qpdf",
          archive: { kind: "zip", entry: "bin/qpdf" },
        },
      ],
    });
  });

  test("provides a builtin google-workspace-cli allowlist with all seven triples", () => {
    const definitions = optionalCapabilityDefinitionsFromEnv(
      {},
      { platform: "darwin", arch: "arm64" }
    );

    expect(definitions.map((d) => d.id)).toEqual(["google-workspace-cli"]);
    const gws = definitions[0];
    if (!gws) throw new Error("expected google-workspace-cli definition");
    expect(gws.version).toBe("0.22.5");
    expect(gws.binaries).toEqual([{ name: "gws", relativePath: "gws" }]);
    expect(gws.assets).toHaveLength(7);

    const base = "https://github.com/googleworkspace/cli/releases/download/v0.22.5";
    for (const asset of gws.assets) {
      expect(asset.url.startsWith(`${base}/google-workspace-cli-`)).toBe(true);
      expect(asset.url.endsWith(asset.platform === "win32" ? ".zip" : ".tar.gz")).toBe(true);
      expect(asset.archive).toBeDefined();
      const expectedEntry = asset.platform === "win32" ? "gws.exe" : "gws";
      expect(asset.archive).toEqual({
        kind: asset.platform === "win32" ? "zip" : "tar.gz",
        entry: expectedEntry,
      });
      expect(asset.executableName).toBe(expectedEntry);
    }

    const darwinArm64 = gws.assets.find((a) => a.platform === "darwin" && a.arch === "arm64");
    expect(darwinArm64?.url).toBe(`${base}/google-workspace-cli-aarch64-apple-darwin.tar.gz`);
    expect(darwinArm64?.sha256).toBe(
      "1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac"
    );

    const linuxX64Assets = gws.assets.filter((a) => a.platform === "linux" && a.arch === "x64");
    expect(linuxX64Assets).toHaveLength(2);
    expect(linuxX64Assets[0]?.url).toBe(
      `${base}/google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz`
    );
    expect(linuxX64Assets[0]?.sha256).toBe(
      "de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f"
    );
    expect(linuxX64Assets[1]?.url).toBe(
      `${base}/google-workspace-cli-x86_64-unknown-linux-musl.tar.gz`
    );

    const linuxArm64Assets = gws.assets.filter((a) => a.platform === "linux" && a.arch === "arm64");
    expect(linuxArm64Assets[0]?.url).toBe(
      `${base}/google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz`
    );
    expect(linuxArm64Assets[1]?.url).toBe(
      `${base}/google-workspace-cli-aarch64-unknown-linux-musl.tar.gz`
    );

    const windows = gws.assets.find((a) => a.platform === "win32");
    expect(windows?.url).toBe(`${base}/google-workspace-cli-x86_64-pc-windows-msvc.zip`);
    expect(windows?.sha256).toBe(
      "407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2"
    );
  });

  test("linux x64 defaults to glibc, not musl", () => {
    const defs = optionalCapabilityDefinitionsFromEnv({}, { platform: "linux", arch: "x64" });
    const gws = defs.find((d) => d.id === "google-workspace-cli");
    if (!gws) throw new Error("expected google-workspace-cli definition");
    const linuxX64Assets = gws.assets.filter((a) => a.platform === "linux" && a.arch === "x64");
    // findAsset's linear search picks the first match — gnu must win.
    const winner = linuxX64Assets[0];
    expect(winner?.url).toContain("x86_64-unknown-linux-gnu");
    expect(winner?.url).not.toContain("musl");
  });

  test("linux arm64 defaults to glibc, not musl", () => {
    const defs = optionalCapabilityDefinitionsFromEnv({}, { platform: "linux", arch: "arm64" });
    const gws = defs.find((d) => d.id === "google-workspace-cli");
    if (!gws) throw new Error("expected google-workspace-cli definition");
    const linuxArm64Assets = gws.assets.filter((a) => a.platform === "linux" && a.arch === "arm64");
    const winner = linuxArm64Assets[0];
    expect(winner?.url).toContain("aarch64-unknown-linux-gnu");
    expect(winner?.url).not.toContain("musl");
  });

  test("ignores TESSERA_GWS_CLI_VERSION alone without URL + SHA override", () => {
    const defs = optionalCapabilityDefinitionsFromEnv(
      { TESSERA_GWS_CLI_VERSION: "0.99.0-orphan" },
      { platform: process.platform, arch: process.arch }
    );
    const gws = defs.find((d) => d.id === "google-workspace-cli");
    // Without a matching URL + SHA, the version label stays pinned to the
    // builtin so URLs and hashes can't drift apart.
    expect(gws?.version).toBe("0.22.5");
    expect(gws?.assets.every((a) => a.url.includes("/v0.22.5/"))).toBe(true);
  });

  test("uses gws.exe relativePath when host platform is win32", () => {
    const definitions = optionalCapabilityDefinitionsFromEnv(
      {},
      { platform: "win32", arch: "x64" }
    );
    const gws = definitions[0];
    expect(gws?.binaries).toEqual([{ name: "gws", relativePath: "gws.exe" }]);
  });

  test("env override replaces only the host platform/arch asset within the builtin", () => {
    const env = {
      TESSERA_GWS_CLI_URL: "https://mirror.tessera.local/gws-host.tar.gz",
      TESSERA_GWS_CLI_SHA256: "deadbeef",
      TESSERA_GWS_CLI_VERSION: "0.22.5-staging",
      TESSERA_GWS_CLI_SIZE_BYTES: "12345",
    };
    const hostPlatform = process.platform;
    const hostArch = process.arch;

    const hostDefs = optionalCapabilityDefinitionsFromEnv(env, {
      platform: hostPlatform,
      arch: hostArch,
    });
    const hostGws = hostDefs.find((d) => d.id === "google-workspace-cli");
    expect(hostGws?.version).toBe("0.22.5-staging");
    expect(hostGws?.assets).toHaveLength(7);
    const overridden = hostGws?.assets.find(
      (a) => a.platform === hostPlatform && a.arch === hostArch
    );
    expect(overridden?.url).toBe("https://mirror.tessera.local/gws-host.tar.gz");
    expect(overridden?.sha256).toBe("deadbeef");
    expect(overridden?.sizeBytes).toBe(12345);

    const otherPlatform: NodeJS.Platform = hostPlatform === "linux" ? "darwin" : "linux";
    const otherArch: NodeJS.Architecture = hostArch === "arm64" ? "x64" : "arm64";
    const otherDefs = optionalCapabilityDefinitionsFromEnv(env, {
      platform: otherPlatform,
      arch: otherArch,
    });
    const otherGws = otherDefs.find((d) => d.id === "google-workspace-cli");
    const otherAsset = otherGws?.assets.find(
      (a) => a.platform === otherPlatform && a.arch === otherArch
    );
    expect(otherAsset?.url.startsWith("https://github.com/googleworkspace/cli/")).toBe(true);
    expect(otherAsset?.url).not.toBe("https://mirror.tessera.local/gws-host.tar.gz");
  });

  test("omits pdf-render and pdf-transform when their env vars are not set", () => {
    const definitions = optionalCapabilityDefinitionsFromEnv(
      {},
      { platform: "darwin", arch: "arm64" }
    );
    expect(definitions.find((d) => d.id === "pdf-render")).toBeUndefined();
    expect(definitions.find((d) => d.id === "pdf-transform")).toBeUndefined();
  });

  test("installs an allowlisted single-binary capability into the managed root", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const payload = Buffer.from("#!/bin/sh\necho qpdf\n");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "pdf-transform",
          label: "PDF transform engine",
          version: "1.0.0",
          binaries: [{ name: "qpdf", relativePath: "qpdf" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/qpdf",
              sha256: sha256(payload),
              executableName: "qpdf",
              sizeBytes: payload.byteLength,
            },
          ],
        },
      ],
      download: async (url) => {
        expect(url).toBe("https://downloads.tessera.local/qpdf");
        return payload;
      },
    });

    await expect(manager.resolveBinary("pdf-transform", "qpdf")).resolves.toBeUndefined();
    await expect(manager.status("pdf-transform")).resolves.toMatchObject({
      id: "pdf-transform",
      status: "available",
      installed: false,
      installAvailable: true,
    });

    const installed = await manager.install("pdf-transform");
    const binaryPath = await manager.resolveBinary("pdf-transform", "qpdf");

    expect(installed).toMatchObject({
      id: "pdf-transform",
      status: "installed",
      binaryPaths: { qpdf: binaryPath },
    });
    expect(binaryPath).toBe(join(rootDir, "pdf-transform", "1.0.0", "qpdf"));
    await expect(readFile(binaryPath ?? "")).resolves.toEqual(payload);
    await expect(manager.status("pdf-transform")).resolves.toMatchObject({
      status: "installed",
      installed: true,
      installAvailable: true,
    });
  });

  test("reports download and installation progress", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const payload = Buffer.from("#!/bin/sh\necho qpdf\n");
    const progress: Array<{
      phase: string;
      downloadedBytes?: number;
      totalBytes?: number;
    }> = [];
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "pdf-transform",
          label: "PDF transform engine",
          version: "1.0.0",
          binaries: [{ name: "qpdf", relativePath: "qpdf" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/qpdf",
              sha256: sha256(payload),
              executableName: "qpdf",
              sizeBytes: payload.byteLength,
            },
          ],
        },
      ],
      download: async (_url, options) => {
        options?.onProgress?.({
          id: "pdf-transform",
          label: "PDF transform engine",
          version: "1.0.0",
          phase: "downloading",
          downloadedBytes: 5,
          totalBytes: payload.byteLength,
        });
        return payload;
      },
    });

    await manager.install("pdf-transform", {
      onProgress(event) {
        progress.push({
          phase: event.phase,
          ...(event.downloadedBytes !== undefined
            ? { downloadedBytes: event.downloadedBytes }
            : {}),
          ...(event.totalBytes !== undefined ? { totalBytes: event.totalBytes } : {}),
        });
      },
    });

    expect(progress).toEqual([
      { phase: "downloading", downloadedBytes: 5, totalBytes: payload.byteLength },
      { phase: "verifying", downloadedBytes: payload.byteLength, totalBytes: payload.byteLength },
      { phase: "installing", downloadedBytes: payload.byteLength, totalBytes: payload.byteLength },
      { phase: "installed", downloadedBytes: payload.byteLength, totalBytes: payload.byteLength },
    ]);
  });

  test("rejects downloaded capabilities when the checksum does not match", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "pdf-render",
          label: "PDF render engine",
          version: "1.0.0",
          binaries: [{ name: "tessera-pdf-render", relativePath: "tessera-pdf-render" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/tessera-pdf-render",
              sha256: sha256(Buffer.from("expected")),
              executableName: "tessera-pdf-render",
            },
          ],
        },
      ],
      download: async () => Buffer.from("tampered"),
    });

    await expect(manager.install("pdf-render")).rejects.toThrow(/checksum/i);
    await expect(
      manager.resolveBinary("pdf-render", "tessera-pdf-render")
    ).resolves.toBeUndefined();
  });

  test("installs a tar.gz archive capability via the injected extractor", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const binaryPayload = Buffer.from("#!/bin/sh\necho gws\n");
    const archivePayload = Buffer.from("fake-tar-gz-bytes");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "1.0.0",
          binaries: [{ name: "gws", relativePath: "gws" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/gws.tar.gz",
              sha256: sha256(archivePayload),
              executableName: "gws",
              sizeBytes: archivePayload.byteLength,
              archive: { kind: "tar.gz", entry: "bin/gws" },
            },
          ],
        },
      ],
      download: async () => archivePayload,
      extract: async ({ archivePath, outputDir, kind }) => {
        expect(kind).toBe("tar.gz");
        await expect(readFile(archivePath)).resolves.toEqual(archivePayload);
        await mkdir(join(outputDir, "bin"), { recursive: true });
        await writeFile(join(outputDir, "bin", "gws"), binaryPayload);
      },
    });

    const installed = await manager.install("google-workspace-cli");
    const binaryPath = await manager.resolveBinary("google-workspace-cli", "gws");
    expect(installed.binaryPaths).toEqual({ gws: binaryPath as string });
    expect(binaryPath).toBe(join(rootDir, "google-workspace-cli", "1.0.0", "gws"));
    await expect(readFile(binaryPath ?? "")).resolves.toEqual(binaryPayload);
    if (process.platform !== "win32") {
      const metadata = await stat(binaryPath ?? "");
      expect(metadata.mode & 0o777).toBe(0o755);
    }
  });

  test("installs a zip archive capability via the injected extractor", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const binaryPayload = Buffer.from("#!/bin/sh\necho gws\n");
    const archivePayload = Buffer.from("fake-zip-bytes");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "1.0.0",
          binaries: [{ name: "gws", relativePath: "gws" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/gws.zip",
              sha256: sha256(archivePayload),
              executableName: "gws",
              sizeBytes: archivePayload.byteLength,
              archive: { kind: "zip", entry: "gws" },
            },
          ],
        },
      ],
      download: async () => archivePayload,
      extract: async ({ outputDir, kind }) => {
        expect(kind).toBe("zip");
        await writeFile(join(outputDir, "gws"), binaryPayload);
      },
    });

    const installed = await manager.install("google-workspace-cli");
    const binaryPath = await manager.resolveBinary("google-workspace-cli", "gws");
    expect(installed.binaryPaths).toEqual({ gws: binaryPath as string });
    await expect(readFile(binaryPath ?? "")).resolves.toEqual(binaryPayload);
    if (process.platform !== "win32") {
      const metadata = await stat(binaryPath ?? "");
      expect(metadata.mode & 0o777).toBe(0o755);
    }
  });

  test("rejects archive capabilities when the archive checksum does not match", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const archivePayload = Buffer.from("tampered-archive");
    let extractCalled = false;
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "1.0.0",
          binaries: [{ name: "gws", relativePath: "gws" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/gws.tar.gz",
              sha256: sha256(Buffer.from("expected-archive")),
              executableName: "gws",
              archive: { kind: "tar.gz", entry: "bin/gws" },
            },
          ],
        },
      ],
      download: async () => archivePayload,
      extract: async () => {
        extractCalled = true;
      },
    });

    await expect(manager.install("google-workspace-cli")).rejects.toThrow(/checksum/i);
    expect(extractCalled).toBe(false);
    await expect(manager.resolveBinary("google-workspace-cli", "gws")).resolves.toBeUndefined();
    const capabilityDir = join(rootDir, "google-workspace-cli", "1.0.0");
    const entries = await readdir(capabilityDir).catch(() => [] as string[]);
    expect(entries).not.toContain("gws");
  });

  test("emits ordered progress events for archive installs", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const binaryPayload = Buffer.from("#!/bin/sh\necho gws\n");
    const archivePayload = Buffer.from("archive-bytes-for-progress");
    const progress: Array<{
      phase: string;
      downloadedBytes?: number;
      totalBytes?: number;
    }> = [];
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "1.0.0",
          binaries: [{ name: "gws", relativePath: "gws" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/gws.tar.gz",
              sha256: sha256(archivePayload),
              executableName: "gws",
              sizeBytes: archivePayload.byteLength,
              archive: { kind: "tar.gz", entry: "bin/gws" },
            },
          ],
        },
      ],
      download: async (_url, opts) => {
        opts?.onProgress?.({
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "1.0.0",
          phase: "downloading",
          downloadedBytes: archivePayload.byteLength,
          totalBytes: archivePayload.byteLength,
        });
        return archivePayload;
      },
      extract: async ({ outputDir }) => {
        await mkdir(join(outputDir, "bin"), { recursive: true });
        await writeFile(join(outputDir, "bin", "gws"), binaryPayload);
      },
    });

    await manager.install("google-workspace-cli", {
      onProgress(event) {
        progress.push({
          phase: event.phase,
          ...(event.downloadedBytes !== undefined
            ? { downloadedBytes: event.downloadedBytes }
            : {}),
          ...(event.totalBytes !== undefined ? { totalBytes: event.totalBytes } : {}),
        });
      },
    });

    expect(progress.map((entry) => entry.phase)).toEqual([
      "downloading",
      "verifying",
      "installing",
      "installed",
    ]);
    for (const entry of progress) {
      expect(entry.totalBytes).toBe(archivePayload.byteLength);
    }
  });

  test("rejects malicious archive entries that escape the extract directory", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const archivePayload = Buffer.from("fake-archive-bytes");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "1.0.0",
          binaries: [{ name: "gws", relativePath: "gws" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/gws.tar.gz",
              sha256: sha256(archivePayload),
              executableName: "gws",
              archive: { kind: "tar.gz", entry: "../escape" },
            },
          ],
        },
      ],
      download: async () => archivePayload,
      extract: async () => {
        // no-op; escape detection happens after extraction
      },
    });

    await expect(manager.install("google-workspace-cli")).rejects.toThrow(/escape/i);
    await expect(manager.resolveBinary("google-workspace-cli", "gws")).resolves.toBeUndefined();
  });

  test("rejects capability binary paths that escape the managed root", async () => {
    const rootDir = await mkdtemp("/tmp/tessera-capabilities-");
    const payload = Buffer.from("#!/bin/sh\necho qpdf\n");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "pdf-transform",
          label: "PDF transform engine",
          version: "1.0.0",
          binaries: [{ name: "qpdf", relativePath: "../../qpdf" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/qpdf",
              sha256: sha256(payload),
              executableName: "../../qpdf",
            },
          ],
        },
      ],
      download: async () => payload,
    });

    await expect(manager.install("pdf-transform")).rejects.toThrow(/managed root/);
  });
});
