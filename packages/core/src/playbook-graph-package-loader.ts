import { dirname, extname, join, normalize } from "node:path";
import type {
  CompiledPlaybookGraph,
  PlaybookGraphBranch,
  PlaybookGraphNode,
  PlaybookGraphPackageManifest,
} from "@tessera/contracts";
import ts from "typescript";
import type { CompilePlaybookGraphOptions } from "./playbook-graph-compiler.js";
import { compilePlaybookGraph } from "./playbook-graph-compiler.js";
import { readPlaybookGraphPackage } from "./playbook-graph-package.js";

export interface LoadGraphPlaybookPackageOptions {
  root: string;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

export interface LoadedGraphPlaybookPackage {
  root: string;
  manifest: PlaybookGraphPackageManifest;
  compiled: CompiledPlaybookGraph;
}

const ALLOWED_EXTERNAL_IMPORT_PREFIX = "@tessera/plugin-sdk";
const DANGEROUS_IMPORT_SPECIFIERS = [
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:worker_threads",
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "http",
  "https",
  "worker_threads",
] as const;
const COLLECTED_IMPORT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]);

function isPackageContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !relativePath.startsWith("/") &&
    !/^[A-Za-z]:/.test(relativePath)
  );
}

function isDangerousImportSpecifier(specifier: string): boolean {
  return DANGEROUS_IMPORT_SPECIFIERS.some(
    (dangerous) => specifier === dangerous || specifier.startsWith(`${dangerous}/`)
  );
}

function isAllowedExternalImportSpecifier(specifier: string): boolean {
  return (
    specifier === ALLOWED_EXTERNAL_IMPORT_PREFIX ||
    specifier.startsWith(`${ALLOWED_EXTERNAL_IMPORT_PREFIX}/`)
  );
}

function collectImportSpecifiers(sourceFile: ts.SourceFile): Array<{
  kind: "import" | "export" | "require" | "dynamic-import";
  specifier: string;
}> {
  const specifiers: Array<{
    kind: "import" | "export" | "require" | "dynamic-import";
    specifier: string;
  }> = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
        specifiers.push({ kind: "import", specifier: moduleSpecifier.text });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const moduleReference = node.moduleReference;
      if (
        ts.isExternalModuleReference(moduleReference) &&
        moduleReference.expression !== undefined &&
        ts.isStringLiteralLike(moduleReference.expression)
      ) {
        specifiers.push({ kind: "import", specifier: moduleReference.expression.text });
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

function candidateCollectedImportTargets(currentPath: string, specifier: string): string[] {
  const normalized = normalize(join(dirname(currentPath), specifier)).replaceAll("\\", "/");
  const candidates = [normalized];

  if (extname(normalized) === "") {
    for (const extension of COLLECTED_IMPORT_EXTENSIONS) {
      candidates.push(`${normalized}${extension}`);
    }

    for (const extension of COLLECTED_IMPORT_EXTENSIONS) {
      candidates.push(`${normalized}/index${extension}`);
    }
  }

  return candidates;
}

function resolveCollectedImportTarget(
  currentPath: string,
  specifier: string,
  sourceFiles: Record<string, string>
): string | undefined {
  for (const candidate of candidateCollectedImportTargets(currentPath, specifier)) {
    if (Object.prototype.hasOwnProperty.call(sourceFiles, candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function assertCollectedSourceImport(
  currentPath: string,
  specifier: string,
  sourceFiles: Record<string, string>
): string {
  const normalized = normalize(join(dirname(currentPath), specifier)).replaceAll("\\", "/");

  if (!isPackageContainedRelativePath(normalized)) {
    throw new Error(
      `Package-relative imports may not escape the package root: ${currentPath} -> ${specifier}`
    );
  }

  const resolved = resolveCollectedImportTarget(currentPath, specifier, sourceFiles);
  if (resolved === undefined) {
    throw new Error(
      `Package-relative imports must reference collected source files: ${currentPath} -> ${specifier}`
    );
  }

  return resolved;
}

function assertNoParseDiagnostics(sourceFile: ts.SourceFile): void {
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  if (parseDiagnostics.length === 0) {
    return;
  }

  const firstDiagnostic = parseDiagnostics[0];
  const message =
    firstDiagnostic === undefined
      ? "unknown parse error"
      : ts.flattenDiagnosticMessageText(firstDiagnostic.messageText, "\n");
  throw new Error(
    `Invalid TypeScript in graph playbook package source ${sourceFile.fileName}: ${message}`
  );
}

function validateSourceImports(
  sourceFiles: Record<string, string>,
  entrypoints: Iterable<string>
): void {
  const visited = new Set<string>();
  const pending = [...entrypoints];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (currentPath === undefined || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    const source = sourceFiles[currentPath];
    if (source === undefined) {
      throw new Error(`Missing collected source file: ${currentPath}`);
    }

    const sourceFile = ts.createSourceFile(
      currentPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    assertNoParseDiagnostics(sourceFile);

    for (const specifier of collectImportSpecifiers(sourceFile)) {
      if (specifier.kind === "dynamic-import") {
        throw new Error(
          `Dynamic import() is not allowed in graph playbook packages: ${currentPath}`
        );
      }

      if (specifier.kind === "require") {
        throw new Error(
          `CommonJS require() imports are not allowed in graph playbook packages: ${currentPath}`
        );
      }

      if (isDangerousImportSpecifier(specifier.specifier)) {
        throw new Error(
          `Dangerous imports are not allowed in graph playbook packages: ${currentPath} -> ${specifier.specifier}`
        );
      }

      if (isAllowedExternalImportSpecifier(specifier.specifier)) {
        continue;
      }

      if (specifier.specifier.startsWith(".")) {
        const resolved = assertCollectedSourceImport(currentPath, specifier.specifier, sourceFiles);
        if (!visited.has(resolved)) {
          pending.push(resolved);
        }
        continue;
      }

      throw new Error(
        `Only package-relative imports and ${ALLOWED_EXTERNAL_IMPORT_PREFIX} are allowed in graph playbook packages: ${currentPath} -> ${specifier.specifier}`
      );
    }
  }
}

function validatePackageSources(sourceFiles: Record<string, string>, entrypoint: string): void {
  validateSourceImports(
    sourceFiles,
    Object.keys(sourceFiles).filter(
      (sourcePath) => sourcePath === entrypoint || sourcePath.endsWith(".ts")
    )
  );
}

function normalizeSourceRef(ref: string): string {
  return normalize(ref)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
}

function assertCollectedSourceRef(
  sourceFiles: Record<string, string>,
  ref: string,
  context: string
): void {
  const normalized = normalizeSourceRef(ref);
  if (
    !isPackageContainedRelativePath(normalized) ||
    !Object.prototype.hasOwnProperty.call(sourceFiles, normalized)
  ) {
    throw new Error(
      `Graph playbook source ref is missing from package sources: ${context} -> ${ref}`
    );
  }
}

function validateGraphNodeSourceRefs(
  sourceFiles: Record<string, string>,
  nodes: PlaybookGraphNode[]
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "script":
        assertCollectedSourceRef(sourceFiles, node.run, `node ${node.id} run`);
        break;
      case "agent":
        assertCollectedSourceRef(sourceFiles, node.prompt, `node ${node.id} prompt`);
        if (node.output?.schema !== undefined) {
          assertCollectedSourceRef(
            sourceFiles,
            node.output.schema,
            `node ${node.id} output.schema`
          );
        }
        break;
      case "parallelMap":
        validateGraphBranchSourceRefs(sourceFiles, node.branch);
        break;
      default:
        break;
    }
  }
}

function validateGraphBranchSourceRefs(
  sourceFiles: Record<string, string>,
  branch: PlaybookGraphBranch
): void {
  validateGraphNodeSourceRefs(sourceFiles, branch.nodes);
}

function validateGraphSourceRefs(
  sourceFiles: Record<string, string>,
  graph: CompiledPlaybookGraph["graph"]
): void {
  for (const [artifactName, artifact] of Object.entries(graph.artifacts)) {
    assertCollectedSourceRef(sourceFiles, artifact.schema, `artifact ${artifactName} schema`);
  }

  validateGraphNodeSourceRefs(sourceFiles, graph.nodes);
}

function literalPropertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  throw new Error("Graph playbook literals may only use static property names");
}

function evaluateLiteralExpression(expression: ts.Expression): unknown {
  if (ts.isParenthesizedExpression(expression)) {
    return evaluateLiteralExpression(expression.expression);
  }
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return evaluateLiteralExpression(expression.expression);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const value: Record<string, unknown> = {};

    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error("Graph playbook literals may only use property assignments");
      }

      value[literalPropertyName(property.name)] = evaluateLiteralExpression(property.initializer);
    }

    return value;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        throw new Error("Graph playbook literals may not use spread elements");
      }
      return evaluateLiteralExpression(element);
    });
  }
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }

  throw new Error("Graph playbook default export must be a static object literal");
}

function graphExpressionFromDefaultExport(expression: ts.Expression): ts.Expression {
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "definePlaybook" &&
    expression.arguments.length === 1
  ) {
    return expression.arguments[0] as ts.Expression;
  }

  return expression;
}

function extractDefaultGraph(sourceFiles: Record<string, string>, entrypoint: string): unknown {
  const source = sourceFiles[entrypoint];
  if (source === undefined) {
    throw new Error(`Missing collected source file: ${entrypoint}`);
  }

  const sourceFile = ts.createSourceFile(entrypoint, source, ts.ScriptTarget.Latest, true);
  assertNoParseDiagnostics(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) {
      continue;
    }

    return evaluateLiteralExpression(graphExpressionFromDefaultExport(statement.expression));
  }

  throw new Error(`Graph playbook entrypoint must default-export an object: ${entrypoint}`);
}

function assertManifestMatchesCompiledGraph(
  manifest: PlaybookGraphPackageManifest,
  compiled: CompiledPlaybookGraph
): void {
  const mismatches: string[] = [];

  if (manifest.id !== compiled.graph.id) {
    mismatches.push(`id (${manifest.id} !== ${compiled.graph.id})`);
  }
  if (manifest.version !== compiled.graph.version) {
    mismatches.push(`version (${manifest.version} !== ${compiled.graph.version})`);
  }
  if (manifest.name !== compiled.graph.name) {
    mismatches.push(`name (${manifest.name} !== ${compiled.graph.name})`);
  }

  if (mismatches.length > 0) {
    throw new Error(`Manifest and compiled graph must match on ${mismatches.join(", ")}`);
  }
}

export async function loadGraphPlaybookPackage(
  options: LoadGraphPlaybookPackageOptions
): Promise<LoadedGraphPlaybookPackage> {
  const packageFiles = await readPlaybookGraphPackage(options.root);
  validatePackageSources(packageFiles.sourceFiles, packageFiles.manifest.entrypoint);

  const graph = extractDefaultGraph(packageFiles.sourceFiles, packageFiles.manifest.entrypoint);

  if (typeof graph !== "object" || graph === null || Array.isArray(graph)) {
    throw new Error(
      `Graph playbook entrypoint must default-export an object: ${packageFiles.manifest.entrypoint}`
    );
  }

  const compileOptions: CompilePlaybookGraphOptions = {
    graph,
    sourceFiles: packageFiles.sourceFiles,
    compilerVersion: options.compilerVersion,
    scriptSdkVersion: options.scriptSdkVersion,
    ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
  };

  const compiled = compilePlaybookGraph(compileOptions);

  validateGraphSourceRefs(packageFiles.sourceFiles, compiled.graph);
  assertManifestMatchesCompiledGraph(packageFiles.manifest, compiled);

  return {
    root: packageFiles.root,
    manifest: packageFiles.manifest,
    compiled,
  };
}
