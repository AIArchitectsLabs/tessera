import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeBasePath,
  prepareGitHubPagesExport,
  rewriteMintlifyExportForBasePath,
} from "./docs-prepare-github-pages.ts";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tessera-docs-pages-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("docs-prepare-github-pages", () => {
  test("normalizes repository Pages base paths", () => {
    expect(normalizeBasePath("tessera/")).toBe("/tessera");
    expect(normalizeBasePath("/tessera")).toBe("/tessera");
    expect(() => normalizeBasePath("/")).toThrow("must not be the site root");
    expect(() => normalizeBasePath("/../tessera")).toThrow("cannot contain '..'");
  });

  test("prefixes root-relative Mintlify asset and navigation URLs", () => {
    const input = String.raw`<!DOCTYPE html><html data-current-path="/"><head><link rel="stylesheet" href="/_next/static/css/site.css"/><script src="/_next/static/chunks/app.js"></script><meta name="msapplication-config" content="/favicons/browserconfig.xml"/><script>var b="";d.p="/_next/";const nav="/playbook-authoring/overview";const slash="/";const remote="https://example.com/_next/nope.css";</script><style>.icon{background:url(/favicons/icon.svg)}</style></head><body><a href="/">Home</a><a href="/recipes/seo-geo">SEO</a></body></html>`;

    const output = rewriteMintlifyExportForBasePath(input, "/tessera");

    expect(output).toContain('href="/tessera/_next/static/css/site.css"');
    expect(output).toContain('src="/tessera/_next/static/chunks/app.js"');
    expect(output).toContain('content="/tessera/favicons/browserconfig.xml"');
    expect(output).toContain('var b="/tessera"');
    expect(output).toContain('d.p="/tessera/_next/"');
    expect(output).toContain('const nav="/tessera/playbook-authoring/overview"');
    expect(output).toContain("background:url(/tessera/favicons/icon.svg)");
    expect(output).toContain('href="/tessera/"');
    expect(output).toContain('href="/tessera/recipes/seo-geo"');
    expect(output).toContain('const slash="/"');
    expect(output).toContain("https://example.com/_next/nope.css");
  });

  test("rewrites export files idempotently", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "_next/static/css"), { recursive: true });
    await writeFile(
      join(root, "index.html"),
      '<link rel="stylesheet" href="/_next/static/css/site.css"><a href="/reference/cli-validation">CLI</a><script>var b="";d.p="/_next/";</script>',
      "utf8"
    );
    await writeFile(join(root, "_next/static/css/site.css"), ".x{background:url(/favicons/x.svg)}");
    await writeFile(join(root, "image.png"), "binary-ish");

    await prepareGitHubPagesExport(root, "/tessera");
    await prepareGitHubPagesExport(root, "/tessera");

    await expect(readFile(join(root, "index.html"), "utf8")).resolves.toBe(
      '<link rel="stylesheet" href="/tessera/_next/static/css/site.css"><a href="/tessera/reference/cli-validation">CLI</a><script>var b="/tessera";d.p="/tessera/_next/";</script>'
    );
    await expect(readFile(join(root, "_next/static/css/site.css"), "utf8")).resolves.toBe(
      ".x{background:url(/tessera/favicons/x.svg)}"
    );
    await expect(readFile(join(root, "image.png"), "utf8")).resolves.toBe("binary-ish");
  });
});
