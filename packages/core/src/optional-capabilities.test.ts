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
        TESSERA_PDF_RENDER_URL: "https://downloads.tessera.local/pdftoppm",
        TESSERA_PDF_RENDER_SHA256: "abc123",
        TESSERA_PDF_RENDER_VERSION: "24.02.0",
        TESSERA_PDF_RENDER_SIZE_BYTES: "42000000",
        TESSERA_PDF_TRANSFORM_URL: "https://downloads.tessera.local/qpdf",
        TESSERA_PDF_TRANSFORM_SHA256: "def456",
        TESSERA_PDF_TRANSFORM_VERSION: "11.9.0",
        TESSERA_GWS_CLI_URL: "https://downloads.tessera.local/gws",
        TESSERA_GWS_CLI_SHA256: "789abc",
        TESSERA_GWS_CLI_VERSION: "0.22.5",
        TESSERA_GWS_CLI_SIZE_BYTES: "15371280",
      },
      { platform: "darwin", arch: "arm64" }
    );

    expect(definitions).toEqual([
      {
        id: "pdf-render",
        label: "PDF render engine",
        version: "24.02.0",
        binaries: [{ name: "pdftoppm", relativePath: "pdftoppm" }],
        assets: [
          {
            platform: "darwin",
            arch: "arm64",
            url: "https://downloads.tessera.local/pdftoppm",
            sha256: "abc123",
            executableName: "pdftoppm",
            sizeBytes: 42000000,
          },
        ],
      },
      {
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
          },
        ],
      },
      {
        id: "google-workspace-cli",
        label: "Google Workspace CLI",
        version: "0.22.5",
        binaries: [{ name: "gws", relativePath: "gws" }],
        assets: [
          {
            platform: "darwin",
            arch: "arm64",
            url: "https://downloads.tessera.local/gws",
            sha256: "789abc",
            executableName: "gws",
            sizeBytes: 15371280,
          },
        ],
      },
    ]);
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
          binaries: [{ name: "pdftoppm", relativePath: "pdftoppm" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/pdftoppm",
              sha256: sha256(Buffer.from("expected")),
              executableName: "pdftoppm",
            },
          ],
        },
      ],
      download: async () => Buffer.from("tampered"),
    });

    await expect(manager.install("pdf-render")).rejects.toThrow(/checksum/i);
    await expect(manager.resolveBinary("pdf-render", "pdftoppm")).resolves.toBeUndefined();
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
