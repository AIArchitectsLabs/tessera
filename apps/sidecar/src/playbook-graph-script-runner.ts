import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import type { PlaybookGraphScriptAdapterInput } from "@tessera/core";
import { hashPlaybookSourceFiles } from "@tessera/core";
import ts from "typescript";

export interface RunPlaybookGraphScriptOptions {
  input: PlaybookGraphScriptAdapterInput;
  timeoutMs?: number;
  bunExecutable?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const ALLOWED_EXTERNAL_IMPORT_PREFIX = "@tessera/plugin-sdk";
const DANGEROUS_IMPORT_SPECIFIERS = [
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:module",
  "node:process",
  "node:vm",
  "node:worker_threads",
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "http",
  "https",
  "module",
  "process",
  "vm",
  "worker_threads",
] as const;
const COLLECTED_IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const DANGEROUS_GLOBAL_IDENTIFIERS = new Set([
  "Bun",
  "process",
  "fetch",
  "WebSocket",
  "EventSource",
  "Worker",
  "globalThis",
  "global",
  "window",
  "self",
  "Function",
  "eval",
]);
const DANGEROUS_PROPERTY_NAMES = new Set(["constructor", "__proto__", "prototype"]);

interface VerifiedSourceBundle {
  sourceFiles: Record<string, string>;
  usesPluginSdk: boolean;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeSourcePath(path: string): string {
  const normalized = normalize(path)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`Unsafe graph script source path: ${path}`);
  }
  return normalized;
}

function isDangerousImportSpecifier(specifier: string): boolean {
  return DANGEROUS_IMPORT_SPECIFIERS.some(
    (dangerous) => specifier === dangerous || specifier.startsWith(`${dangerous}/`)
  );
}

function importSpecifiers(
  sourcePath: string,
  source: string
): Array<{
  kind: "import" | "require" | "dynamic-import";
  specifier: string;
}> {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const first = parseDiagnostics[0];
    throw new Error(
      `Invalid TypeScript in graph script source ${sourcePath}: ${
        first ? ts.flattenDiagnosticMessageText(first.messageText, "\n") : "unknown parse error"
      }`
    );
  }

  const specifiers: Array<{
    kind: "import" | "require" | "dynamic-import";
    specifier: string;
  }> = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
        specifiers.push({ kind: "import", specifier: moduleSpecifier.text });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      specifiers.push({
        kind: "dynamic-import",
        specifier: argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : "",
      });
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const argument = node.arguments[0];
      specifiers.push({
        kind: "require",
        specifier: argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : "",
      });
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function bindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNames(element.name, names);
  }
}

function declaredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name) names.add(node.name.text);
    } else if (ts.isVariableDeclaration(node)) {
      bindingNames(node.name, names);
    } else if (ts.isParameter(node)) {
      bindingNames(node.name, names);
    } else if (ts.isImportClause(node)) {
      if (node.name) names.add(node.name.text);
    } else if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

function assertNoRuntimeEscapes(sourcePath: string, source: string): void {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const locals = declaredNames(sourceFile);

  function isDeclarationIdentifier(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
      (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
      (ts.isEnumDeclaration(parent) && parent.name === node) ||
      (ts.isImportClause(parent) && parent.name === node) ||
      (ts.isImportSpecifier(parent) && parent.name === node) ||
      (ts.isNamespaceImport(parent) && parent.name === node) ||
      (ts.isImportEqualsDeclaration(parent) && parent.name === node)
    );
  }

  function visit(node: ts.Node): void {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`import.meta is not allowed in graph scripts: ${sourcePath}`);
    }
    if (ts.isIdentifier(node)) {
      if (
        DANGEROUS_GLOBAL_IDENTIFIERS.has(node.text) &&
        !locals.has(node.text) &&
        !isDeclarationIdentifier(node)
      ) {
        throw new Error(
          `Runtime global ${node.text} is not allowed in graph scripts: ${sourcePath}`
        );
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      if (DANGEROUS_PROPERTY_NAMES.has(node.name.text)) {
        throw new Error(
          `Runtime escape property ${node.name.text} is not allowed in graph scripts: ${sourcePath}`
        );
      }
    } else if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (
        argument &&
        ts.isStringLiteralLike(argument) &&
        DANGEROUS_PROPERTY_NAMES.has(argument.text)
      ) {
        throw new Error(
          `Runtime escape property ${argument.text} is not allowed in graph scripts: ${sourcePath}`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function collectedImportCandidates(sourcePath: string, specifier: string): string[] {
  const base = normalize(join(dirname(sourcePath), specifier)).replaceAll("\\", "/");
  const candidates = [base];
  if (!/\.[A-Za-z0-9]+$/.test(base)) {
    for (const extension of COLLECTED_IMPORT_EXTENSIONS) {
      candidates.push(`${base}${extension}`);
    }
    for (const extension of COLLECTED_IMPORT_EXTENSIONS) {
      candidates.push(`${base}/index${extension}`);
    }
  }
  return candidates.map(normalizeSourcePath);
}

function resolveCollectedImport(
  sourcePath: string,
  specifier: string,
  sourceFiles: Record<string, string>
): string {
  for (const candidate of collectedImportCandidates(sourcePath, specifier)) {
    if (Object.prototype.hasOwnProperty.call(sourceFiles, candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Graph script import is missing from pinned source bundle: ${sourcePath} -> ${specifier}`
  );
}

function verifySourceBundle(input: PlaybookGraphScriptAdapterInput): VerifiedSourceBundle {
  const rawSourceFiles = input.run.snapshot.sourceFiles;
  if (rawSourceFiles === undefined) {
    throw new Error("Graph script execution requires pinned source files on the run snapshot");
  }

  const sourceFiles = Object.fromEntries(
    Object.entries(rawSourceFiles)
      .map(([path, content]) => [normalizeSourcePath(path), content] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  if (hashPlaybookSourceFiles(sourceFiles) !== input.run.snapshot.sourceHash) {
    throw new Error("Pinned graph source bundle hash mismatch");
  }

  for (const [path, expectedHash] of Object.entries(input.run.snapshot.sourceFileHashes)) {
    const normalized = normalizeSourcePath(path);
    const content = sourceFiles[normalized];
    if (content === undefined || sha256(content) !== expectedHash) {
      throw new Error(`Pinned graph source file hash mismatch: ${path}`);
    }
  }

  const scriptPath = normalizeSourcePath(input.node.run);
  if (!Object.prototype.hasOwnProperty.call(sourceFiles, scriptPath)) {
    throw new Error(`Graph script source is missing from pinned source bundle: ${input.node.run}`);
  }

  const pending = [scriptPath];
  const visited = new Set<string>();
  let usesPluginSdk = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const source = sourceFiles[current];
    if (source === undefined) {
      throw new Error(`Graph script source is missing from pinned source bundle: ${current}`);
    }

    for (const specifier of importSpecifiers(current, source)) {
      if (specifier.kind === "dynamic-import") {
        throw new Error(`Dynamic import() is not allowed in graph scripts: ${current}`);
      }
      if (specifier.kind === "require") {
        throw new Error(`CommonJS require() is not allowed in graph scripts: ${current}`);
      }
      if (isDangerousImportSpecifier(specifier.specifier)) {
        throw new Error(
          `Dangerous imports are not allowed in graph scripts: ${current} -> ${specifier.specifier}`
        );
      }
      if (
        specifier.specifier === ALLOWED_EXTERNAL_IMPORT_PREFIX ||
        specifier.specifier.startsWith(`${ALLOWED_EXTERNAL_IMPORT_PREFIX}/`)
      ) {
        usesPluginSdk = true;
        continue;
      }
      if (!specifier.specifier.startsWith(".")) {
        throw new Error(
          `Only package-relative imports and ${ALLOWED_EXTERNAL_IMPORT_PREFIX} are allowed in graph scripts: ${current} -> ${specifier.specifier}`
        );
      }
      const resolved = resolveCollectedImport(current, specifier.specifier, sourceFiles);
      if (!visited.has(resolved)) pending.push(resolved);
    }
    assertNoRuntimeEscapes(current, source);
  }

  return { sourceFiles, usesPluginSdk };
}

async function writeSourceBundle(root: string, sourceFiles: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(sourceFiles)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function installPluginSdkShim(tempRoot: string): Promise<void> {
  const packageRoot = join(tempRoot, "node_modules", "@tessera", "plugin-sdk");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ type: "module", exports: "./index.ts" }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(packageRoot, "index.ts"),
    "export function definePlaybook(graph) { return graph; }\n",
    "utf8"
  );
}

function sandboxPreloadSource(): string {
  return `
const deny = (name) => {
  try {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {}
};
for (const name of ["process", "fetch", "WebSocket", "EventSource", "Worker"]) deny(name);
try {
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
} catch {}
`;
}

function runnerSource(): string {
  return `
const raw = await new Response(Bun.stdin.stream()).text();
const payload = JSON.parse(raw);
const stderrLog = (...args) => {
  Bun.stderr.write(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ") + "\\n");
};
console.log = stderrLog;
console.info = stderrLog;
console.warn = stderrLog;
console.error = stderrLog;

try {
  const module = await import(payload.moduleUrl);
  const script = typeof module.default === "function" ? module.default : module.run;
  if (typeof script !== "function") {
    throw new Error("Graph script must export a default function");
  }
  const value = await script(payload.context);
  Bun.stdout.write(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
} catch (error) {
  Bun.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;
}

export async function runPlaybookGraphScript(
  options: RunPlaybookGraphScriptOptions
): Promise<unknown> {
  const { sourceFiles, usesPluginSdk } = verifySourceBundle(options.input);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tempRoot = await mkdtemp(join(tmpdir(), "tessera-graph-script-"));
  const runnerPath = join(tempRoot, `runner-${randomUUID()}.mjs`);
  const preloadPath = join(tempRoot, `sandbox-${randomUUID()}.mjs`);

  try {
    await writeSourceBundle(tempRoot, sourceFiles);
    if (usesPluginSdk) {
      await installPluginSdkShim(tempRoot);
    }
    await writeFile(runnerPath, runnerSource(), "utf8");
    await writeFile(preloadPath, sandboxPreloadSource(), "utf8");
    const scriptPath = join(tempRoot, normalizeSourcePath(options.input.node.run));
    const proc = Bun.spawn(
      [
        options.bunExecutable ?? "bun",
        "run",
        "--no-install",
        "--no-env-file",
        "--no-addons",
        "--preload",
        preloadPath,
        runnerPath,
      ],
      {
        cwd: tempRoot,
        env: { PATH: process.env.PATH ?? "" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdin.write(
      JSON.stringify({
        moduleUrl: pathToFileURL(scriptPath).href,
        context: {
          input: options.input.input,
          artifacts: options.input.artifacts,
          node: options.input.node,
          run: {
            runId: options.input.run.runId,
            playbookId: options.input.run.playbookId,
            input: options.input.run.input,
          },
          queueEntry: {
            queueEntryId: options.input.queueEntry.queueEntryId,
            nodePath: options.input.queueEntry.nodePath,
            attempt: options.input.queueEntry.attempt,
          },
        },
      })
    );
    proc.stdin.end();

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timeout);

    if (timedOut) {
      throw new Error(`Graph script timed out after ${timeoutMs}ms: ${options.input.node.run}`);
    }
    if (proc.exitCode !== 0) {
      throw new Error(`Graph script failed: ${stderr.trim() || "non-zero exit"}`);
    }

    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null || (parsed as { ok?: unknown }).ok !== true) {
      throw new Error("Graph script produced an invalid result envelope");
    }
    return (parsed as { value?: unknown }).value;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
