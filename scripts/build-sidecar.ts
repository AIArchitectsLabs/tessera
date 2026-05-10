#!/usr/bin/env bun
/**
 * Compile the sidecar and CLI binaries then copy them into the Tauri
 * external-binary directory with the correct platform-triple suffix.
 *
 * Usage: bun run scripts/build-sidecar.ts
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(repoRoot, "apps/desktop/src-tauri/binaries");
const googleWorkspaceOAuthClientFile = "google-workspace-oauth-client.json";

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

function verifyExecutable(path: string, args: string[], expected: string): void {
  const proc = Bun.spawnSync([path, ...args], { stdout: "pipe", stderr: "pipe" });
  const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  if (proc.exitCode !== 0 || !output.includes(expected)) {
    throw new Error(`Expected ${path} ${args.join(" ")} to include ${expected}, got:\n${output}`);
  }
}

function requireFile(path: string): string {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`Required file is missing or empty: ${path}`);
  }
  return path;
}

function ensureGwsBinary(path: string): void {
  if (existsSync(path) && statSync(path).size > 0) {
    return;
  }
  console.log("[build-sidecar] installing pinned Google Workspace CLI binary...");
  run("node", [join(repoRoot, "node_modules/@googleworkspace/cli/install.js")]);
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

// Detect the host triple from rustc
const rustcOut = capture("rustc", ["-vV"]);
const tripleMatch = rustcOut.match(/^host:\s+(.+)$/m);
if (!tripleMatch) throw new Error("Could not parse host triple from `rustc -vV`");
const triple = tripleMatch[1].trim();
const isWindows = triple.includes("windows");
const ext = isWindows ? ".exe" : "";

console.log(`[build-sidecar] target triple: ${triple}`);

// Compile sidecar
console.log("[build-sidecar] compiling sidecar...");
run("bun", ["run", "--filter", "@tessera/sidecar", "build"]);

// Compile CLI
console.log("[build-sidecar] compiling CLI...");
run("bun", ["run", "--filter", "@tessera/cli", "build"]);

mkdirSync(binDir, { recursive: true });

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

const gwsSrc = join(repoRoot, `node_modules/@googleworkspace/cli/bin/gws${ext}`);
ensureGwsBinary(gwsSrc);
requireFile(gwsSrc);
verifyExecutable(gwsSrc, ["--version"], "gws 0.22.5");
const gwsDst = join(binDir, `gws-${triple}${ext}`);
copyFileSync(gwsSrc, gwsDst);
if (!isWindows) chmodSync(gwsDst, 0o755);
verifyExecutable(gwsDst, ["--version"], "gws 0.22.5");
console.log(`[build-sidecar] copied gws    → ${gwsDst}`);
writeGoogleWorkspaceOAuthClient();

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
