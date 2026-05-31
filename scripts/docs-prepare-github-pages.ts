#!/usr/bin/env bun

import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const rewriteExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".txt",
  ".webmanifest",
  ".xml",
]);

function fail(message: string): never {
  throw new Error(`[docs:prepare-github-pages] ${message}`);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

export function normalizeBasePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) fail("Base path is required");
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized =
    withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, "") : withLeadingSlash;
  if (normalized === "/") fail("Base path must not be the site root");
  if (normalized.includes("//")) fail(`Base path cannot contain repeated slashes: ${input}`);
  if (normalized.split("/").includes("..")) {
    fail(`Base path cannot contain '..': ${input}`);
  }
  return normalized;
}

function prefixRootPath(path: string, basePath: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (path === basePath || path.startsWith(`${basePath}/`)) return path;
  return `${basePath}${path}`;
}

export function rewriteMintlifyExportForBasePath(text: string, basePath: string): string {
  let rewritten = text.replace(/var b=""/gu, `var b="${basePath}"`);

  rewritten = rewritten.replace(
    /\b(href|src|content|action|poster|data-href)=(["'])(\/(?!\/)[^"']*)\2/gu,
    (_match, attr: string, quote: string, path: string) =>
      `${attr}=${quote}${prefixRootPath(path, basePath)}${quote}`
  );

  rewritten = rewritten.replace(
    /url\((["']?)(\/(?!\/)[^)"'\s]+)\1\)/gu,
    (_match, quote: string, path: string) =>
      `url(${quote}${prefixRootPath(path, basePath)}${quote})`
  );

  return rewritten.replace(
    /(["'`])(\/(?!\/)(?:_next|favicons|sitemap\.xml|robots\.txt|playbook-authoring|recipes|runtime-boundary|reference)(?:\/[^"'`\s)]*)?)\1/gu,
    (_match, quote: string, path: string) => `${quote}${prefixRootPath(path, basePath)}${quote}`
  );
}

async function collectRewriteFiles(dir: string, root: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRewriteFiles(absolutePath, root, files);
      continue;
    }
    if (entry.isFile() && rewriteExtensions.has(extname(entry.name))) {
      files.push(absolutePath);
    }
  }
}

export async function prepareGitHubPagesExport(
  siteRoot: string,
  basePathInput: string
): Promise<number> {
  if (!siteRoot) fail("Site root is required");
  const basePath = normalizeBasePath(basePathInput);
  const files: string[] = [];
  await collectRewriteFiles(siteRoot, siteRoot, files);

  let changed = 0;
  for (const file of files) {
    const original = await readFile(file, "utf8");
    const rewritten = rewriteMintlifyExportForBasePath(original, basePath);
    if (rewritten === original) continue;
    await writeFile(file, rewritten, "utf8");
    changed += 1;
  }

  console.log(
    `[docs:prepare-github-pages] prefixed ${changed}/${files.length} files for ${basePath} in ${toPosixPath(
      relative(process.cwd(), siteRoot)
    )}`
  );
  return changed;
}

if (import.meta.main) {
  const [siteRoot, basePath] = Bun.argv.slice(2);
  await prepareGitHubPagesExport(siteRoot ?? "", basePath ?? "");
}
