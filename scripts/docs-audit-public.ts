import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const repoRoot = process.cwd();
const docsRoot = join(repoRoot, "docs/public");
const allowlistPath = join(docsRoot, ".public-allowlist.json");
const dashboardPath = join(docsRoot, ".mintlify-dashboard.json");
const docsJsonPath = join(docsRoot, "docs.json");

const ignoredAuditFiles = new Set([".public-allowlist.json"]);
const textExtensions = new Set([".md", ".mdx", ".json", ".txt", ".yaml", ".yml"]);
const pageExtensions = new Set([".md", ".mdx"]);
const allowedKinds = new Set([
  "page",
  "snippet",
  "asset",
  "openapi",
  "asyncapi",
  "llms",
  "generated-reference",
  "redirect",
  "config",
]);

const forbiddenPatterns = [
  /\/Users\b/,
  /docs\/superpowers\b/,
  /\.omx\b/,
  /internal\s+spec/i,
  /internal\s+plan/i,
  /\bPRD\b/,
  /\bdraft\b/i,
  /unpublished\s+fixture/i,
  /unsanitized\s+local\s+evidence/i,
];

interface AllowlistEntry {
  path: string;
  kind: string;
  source: string;
  sanitized: boolean;
  sha256?: string;
  hidden?: boolean;
  hiddenReason?: string;
  searchMcpReview?: string;
}

interface Allowlist {
  schemaVersion: 1;
  files: AllowlistEntry[];
}

function fail(message: string): never {
  throw new Error(`[docs:audit-public] ${message}`);
}

function parseJson<T>(label: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  fail(`${label} resolves outside docs/public: ${candidate}`);
}

function assertSafeManifestPath(path: string): void {
  if (path.length === 0) fail("Allowlist path cannot be empty");
  if (isAbsolute(path)) fail(`Allowlist path must be relative: ${path}`);
  if (path.split("/").includes("..")) fail(`Allowlist path cannot contain '..': ${path}`);
  if (path.includes("\\")) fail(`Allowlist path must use POSIX separators: ${path}`);
}

async function collectFiles(dir: string, root: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = toPosixPath(relative(root, absolutePath));
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) fail(`Symlinks are not allowed in docs/public: ${relativePath}`);
    if (stat.isDirectory()) {
      await collectFiles(absolutePath, root, files);
      continue;
    }
    if (stat.isFile()) files.push(relativePath);
  }
}

function collectNavigationPages(value: unknown, pages: Set<string>): void {
  if (typeof value === "string") {
    pages.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNavigationPages(item, pages);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.root === "string") pages.add(record.root);
    if (Array.isArray(record.pages)) collectNavigationPages(record.pages, pages);
    for (const key of ["groups", "tabs", "anchors", "dropdowns", "versions", "languages"]) {
      if (Array.isArray(record[key])) collectNavigationPages(record[key], pages);
    }
  }
}

async function readTextFile(relativePath: string): Promise<string | undefined> {
  if (!textExtensions.has(extname(relativePath))) return undefined;
  return readFile(join(docsRoot, relativePath), "utf8");
}

function pageIsReferenced(relativePath: string, navPages: Set<string>): boolean {
  const withoutExtension = relativePath.replace(/\.(md|mdx)$/u, "");
  return navPages.has(withoutExtension) || navPages.has(relativePath);
}

async function main(): Promise<void> {
  const rootReal = await realpath(docsRoot);
  const allowlist = parseJson<Allowlist>(
    ".public-allowlist.json",
    await readFile(allowlistPath, "utf8")
  );
  if (allowlist.schemaVersion !== 1) fail("Allowlist schemaVersion must be 1");
  if (!Array.isArray(allowlist.files)) fail("Allowlist files must be an array");

  const docsJson = parseJson<Record<string, unknown>>(
    "docs.json",
    await readFile(docsJsonPath, "utf8")
  );
  const robots = (docsJson.seo as { metatags?: { robots?: unknown } } | undefined)?.metatags
    ?.robots;
  if (robots !== "noindex") fail('docs.json must keep seo.metatags.robots set to "noindex"');

  const navPages = new Set<string>();
  collectNavigationPages(docsJson.navigation, navPages);
  if (navPages.size === 0) fail("docs.json navigation must declare at least one page");

  const dashboard = parseJson<Record<string, unknown>>(
    ".mintlify-dashboard.json",
    await readFile(dashboardPath, "utf8")
  );
  if (dashboard.monorepoPath !== "/docs/public")
    fail("Dashboard artifact must declare monorepoPath /docs/public");
  const docsMcp = dashboard.docsMcp as { enabled?: unknown } | undefined;
  const mintlifyMcp = dashboard.mintlifyMcp as { enabled?: unknown } | undefined;
  const searchAndAi = dashboard.searchAndAiIndexing as
    | { enabled?: unknown; noindex?: unknown }
    | undefined;
  if (docsMcp?.enabled !== false) fail("Dashboard artifact must keep Docs MCP disabled");
  if (mintlifyMcp?.enabled !== false) fail("Dashboard artifact must keep Mintlify MCP disabled");
  if (searchAndAi?.enabled !== false || searchAndAi.noindex !== true) {
    fail("Dashboard artifact must keep search/AI indexing disabled with noindex enabled");
  }
  const approval = dashboard.approval as { approver?: unknown; date?: unknown } | undefined;
  if (typeof approval?.approver !== "string" || approval.approver.length === 0) {
    fail("Dashboard artifact must declare an approver");
  }
  if (typeof approval.date !== "string" || approval.date.length === 0) {
    fail("Dashboard artifact must declare an approval date");
  }

  const entriesByPath = new Map<string, AllowlistEntry>();
  for (const entry of allowlist.files) {
    assertSafeManifestPath(entry.path);
    if (!allowedKinds.has(entry.kind))
      fail(`Unknown allowlist kind for ${entry.path}: ${entry.kind}`);
    if (entry.sanitized !== true) fail(`Allowlist entry must be sanitized: ${entry.path}`);
    if (typeof entry.source !== "string" || entry.source.length === 0) {
      fail(`Allowlist entry must declare source: ${entry.path}`);
    }
    if (entry.hidden === true) {
      if (!entry.hiddenReason || !entry.searchMcpReview) {
        fail(`Hidden entries must include hiddenReason and searchMcpReview: ${entry.path}`);
      }
    }
    if (entriesByPath.has(entry.path)) fail(`Duplicate allowlist path: ${entry.path}`);
    const absolutePath = join(docsRoot, entry.path);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) fail(`Allowlisted symlink is forbidden in V1: ${entry.path}`);
    const resolved = await realpath(absolutePath);
    assertContained(rootReal, resolved, entry.path);
    entriesByPath.set(entry.path, entry);
  }

  const files: string[] = [];
  await collectFiles(docsRoot, docsRoot, files);
  for (const file of files) {
    if (ignoredAuditFiles.has(file)) continue;
    const entry = entriesByPath.get(file);
    if (!entry) fail(`Publishable file is missing from allowlist: ${file}`);
    if (pageExtensions.has(extname(file))) {
      if (entry.hidden !== true && !pageIsReferenced(file, navPages)) {
        fail(`Page is not referenced by docs.json navigation: ${file}`);
      }
    }
    const text = await readTextFile(file);
    if (text === undefined || entry.kind === "config") continue;
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(text)) fail(`Forbidden public-docs sentinel ${pattern} found in ${file}`);
    }
  }

  for (const navPage of navPages) {
    const candidates = [`${navPage}.mdx`, `${navPage}.md`, navPage];
    if (!candidates.some((candidate) => entriesByPath.has(candidate))) {
      fail(`docs.json navigation references a page missing from the allowlist: ${navPage}`);
    }
  }

  console.log(`[docs:audit-public] ${files.length} docs/public files audited`);
}

await main();
