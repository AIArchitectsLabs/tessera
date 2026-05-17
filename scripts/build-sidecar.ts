#!/usr/bin/env bun
/**
 * Compile the sidecar and CLI binaries then copy them into the Tauri
 * external-binary directory with the correct platform-triple suffix.
 *
 * Usage: bun run scripts/build-sidecar.ts
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(repoRoot, "apps/desktop/src-tauri/binaries");
const googleWorkspaceOAuthClientFile = "google-workspace-oauth-client.json";
const playwrightBrowsersDir = join(binDir, "playwright-browsers");

function run(cmd: string, args: string[], cwd?: string): void {
  const proc = Bun.spawnSync([cmd, ...args], {
    cwd: cwd ?? repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed (exit ${proc.exitCode}): ${cmd} ${args.join(" ")}`);
  }
}

function capture(cmd: string, args: string[]): string {
  const proc = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${proc.exitCode}`);
  }
  return proc.stdout.toString();
}

function requireFile(path: string): string {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`Required file is missing or empty: ${path}`);
  }
  return path;
}

function requireDirectory(path: string): string {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Required directory is missing: ${path}`);
  }
  return path;
}

function writeGoogleWorkspaceOAuthClient(): void {
  const destination = join(binDir, googleWorkspaceOAuthClientFile);
  const explicitFile = process.env.TESSERA_GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE?.trim();
  if (explicitFile) {
    copyFileSync(requireFile(explicitFile), destination);
    console.log(`[build-sidecar] copied Google Workspace OAuth client → ${destination}`);
    return;
  }

  const clientId = process.env.TESSERA_GOOGLE_WORKSPACE_CLIENT_ID?.trim();
  const clientSecret = process.env.TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.log(
      "[build-sidecar] Google Workspace OAuth client not bundled; set TESSERA_GOOGLE_WORKSPACE_CLIENT_ID and TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET for packaged sign-in"
    );
    return;
  }

  const client = {
    installed: {
      client_id: clientId,
      project_id: "tessera",
      client_secret: clientSecret,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      redirect_uris: ["http://localhost"],
    },
  };
  writeFileSync(destination, `${JSON.stringify(client, null, 2)}\n`, { mode: 0o600 });
  console.log(`[build-sidecar] wrote Google Workspace OAuth client → ${destination}`);
}

function defaultPlaywrightBrowserCacheDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library/Caches/ms-playwright");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is required to locate the Playwright browser cache on Windows");
    }
    return join(localAppData, "ms-playwright");
  }
  return join(homedir(), ".cache/ms-playwright");
}

function resolvePlaywrightBrowserSourceDir(): string {
  const explicitSource = process.env.TESSERA_PLAYWRIGHT_BROWSERS_SOURCE?.trim();
  if (explicitSource) return explicitSource;

  const playwrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (playwrightBrowsersPath && playwrightBrowsersPath !== "0") {
    return playwrightBrowsersPath;
  }

  return defaultPlaywrightBrowserCacheDir();
}

function maybeCopyPlaywrightBrowsers(): void {
  if (process.env.TESSERA_BUNDLE_PLAYWRIGHT !== "1") {
    console.log(
      "[build-sidecar] Playwright browsers not bundled; set TESSERA_BUNDLE_PLAYWRIGHT=1 to package local Chromium"
    );
    return;
  }

  const sourceDir = resolvePlaywrightBrowserSourceDir();
  requireDirectory(sourceDir);
  rmSync(playwrightBrowsersDir, { recursive: true, force: true });
  cpSync(sourceDir, playwrightBrowsersDir, { recursive: true });
  console.log(`[build-sidecar] copied Playwright browsers → ${playwrightBrowsersDir}`);
}

export function copyCuratedSkills(options: { repoRoot?: string; binDir?: string } = {}): void {
  const sourceRoot = join(options.repoRoot ?? repoRoot, "packages/core/skills");
  const destinationRoot = join(options.binDir ?? binDir, "skills");
  requireDirectory(sourceRoot);
  rmSync(destinationRoot, { recursive: true, force: true });
  cpSync(sourceRoot, destinationRoot, { recursive: true });
  console.log(`[build-sidecar] copied curated skills → ${destinationRoot}`);
}

export function buildSidecar(): void {
  // Detect the host triple from rustc
  const rustcOut = capture("rustc", ["-vV"]);
  const tripleMatch = rustcOut.match(/^host:\s+(.+)$/m);
  if (!tripleMatch) throw new Error("Could not parse host triple from `rustc -vV`");
  const triple = tripleMatch[1].trim();
  const isWindows = triple.includes("windows");
  const ext = isWindows ? ".exe" : "";

  console.log(`[build-sidecar] target triple: ${triple}`);

  console.log("[build-sidecar] generating built-in graph playbook bundles...");
  run("bun", ["run", "scripts/generate-builtin-graph-playbook-bundles.ts"]);

  // Compile sidecar
  console.log("[build-sidecar] compiling sidecar...");
  run("bun", ["run", "--filter", "@tessera/sidecar", "build"]);

  // Compile CLI
  console.log("[build-sidecar] compiling CLI...");
  run("bun", ["run", "--filter", "@tessera/cli", "build"]);

  mkdirSync(binDir, { recursive: true });
  copyCuratedSkills();

  const sidecarSrc = join(repoRoot, `apps/sidecar/dist/sidecar${ext}`);
  const sidecarDst = join(binDir, `tessera-sidecar-${triple}${ext}`);
  copyFileSync(sidecarSrc, sidecarDst);
  if (!isWindows) chmodSync(sidecarDst, 0o755);
  console.log(`[build-sidecar] copied sidecar → ${sidecarDst}`);

  const cliSrc = join(repoRoot, `apps/cli/dist/cli${ext}`);
  const cliDst = join(binDir, `tessera-cli-${triple}${ext}`);
  copyFileSync(cliSrc, cliDst);
  if (!isWindows) chmodSync(cliDst, 0o755);
  console.log(`[build-sidecar] copied CLI    → ${cliDst}`);

  rmSync(join(binDir, `gws-${triple}${ext}`), { force: true });
  console.log("[build-sidecar] Google Workspace CLI is managed as an optional capability.");
  writeGoogleWorkspaceOAuthClient();
  maybeCopyPlaywrightBrowsers();

  // pi-coding-agent reads its own package.json at module init time.
  // When running as a compiled Bun binary it resolves that path via
  // dirname(process.execPath), which is binDir. Copy the file there so
  // startup doesn't crash with ENOENT.
  const piPkgSrc = join(
    repoRoot,
    "packages/core/node_modules/@mariozechner/pi-coding-agent/package.json"
  );
  const piPkgDst = join(binDir, "package.json");
  copyFileSync(piPkgSrc, piPkgDst);
  console.log(`[build-sidecar] copied pi-coding-agent/package.json → ${piPkgDst}`);

  console.log("[build-sidecar] done.");
}

if (import.meta.main) {
  buildSidecar();
}
