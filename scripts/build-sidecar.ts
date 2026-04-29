#!/usr/bin/env bun
/**
 * Compile the sidecar and CLI binaries then copy them into the Tauri
 * external-binary directory with the correct platform-triple suffix.
 *
 * Usage: bun run scripts/build-sidecar.ts
 */

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(repoRoot, "apps/desktop/src-tauri/binaries");

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

const sidecarSrc = join(repoRoot, "apps/sidecar/dist/sidecar");
const sidecarDst = join(binDir, `tessera-sidecar-${triple}${ext}`);
copyFileSync(sidecarSrc, sidecarDst);
if (!isWindows) chmodSync(sidecarDst, 0o755);
console.log(`[build-sidecar] copied sidecar → ${sidecarDst}`);

const cliSrc = join(repoRoot, "apps/cli/dist/cli");
const cliDst = join(binDir, `tessera-cli-${triple}${ext}`);
copyFileSync(cliSrc, cliDst);
if (!isWindows) chmodSync(cliDst, 0o755);
console.log(`[build-sidecar] copied CLI    → ${cliDst}`);

console.log("[build-sidecar] done.");
