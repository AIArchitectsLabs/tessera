import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const docsRoot = join(process.cwd(), "docs/public");

function fail(message: string): never {
  throw new Error(`[docs:check-style] ${message}`);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

async function collectPages(dir: string, pages: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectPages(absolutePath, pages);
      continue;
    }
    if (entry.isFile() && [".md", ".mdx"].includes(extname(entry.name))) {
      pages.push(toPosixPath(relative(docsRoot, absolutePath)));
    }
  }
}

function hasFrontmatterField(text: string, field: string): boolean {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/u.exec(text);
  if (!frontmatterMatch) return false;
  return new RegExp(`^${field}:\\s*".+"\\s*$`, "mu").test(frontmatterMatch[1] ?? "");
}

const pages: string[] = [];
await collectPages(docsRoot, pages);
for (const page of pages) {
  const text = await readFile(join(docsRoot, page), "utf8");
  if (!hasFrontmatterField(text, "title")) fail(`${page} is missing frontmatter title`);
  if (!hasFrontmatterField(text, "description")) fail(`${page} is missing frontmatter description`);
  if (/package-sdk/u.test(text)) fail(`${page} uses package-sdk instead of plugin-sdk`);
}

console.log(`[docs:check-style] ${pages.length} public docs pages checked`);
