import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGraphPlaybookPackage } from "./playbook-graph-package-loader.js";

const tempRoots: string[] = [];

const compilerVersion = "tessera-core-test-compiler";
const scriptSdkVersion = "tessera-plugin-sdk-test";
const compiledAt = "2026-01-01T00:00:00.000Z";

const baseManifest = {
  schemaVersion: 1 as const,
  id: "content.seo-blog",
  version: "0.1.0",
  name: "SEO Blog Article",
  entrypoint: "playbook.ts",
};

const baseGraph = {
  schemaVersion: 1 as const,
  id: baseManifest.id,
  version: baseManifest.version,
  name: baseManifest.name,
  start: "score",
  artifacts: {
    scorecard: { schema: "./schemas/scorecard.schema.json" },
  },
  nodes: [
    {
      id: "score",
      kind: "script" as const,
      run: "./scripts/score.ts",
      inputs: {},
      outputArtifact: "scorecard",
      onSuccess: "completed",
    },
  ],
};

async function makeRoot(): Promise<string> {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "tessera-playbook-graph-package-loader-"));
  tempRoots.push(root);
  return root;
}

async function writePackageFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function writeBaseGraphSourceRefs(root: string): Promise<void> {
  await writePackageFile(root, "scripts/score.ts", "export default async function score() {}\n");
  await writePackageFile(root, "schemas/scorecard.schema.json", '{"type":"object"}\n');
}

function renderPlaybookSource(options: {
  graph: Record<string, unknown>;
  extraPrelude?: string;
  exportDefault?: boolean;
  exportedName?: string;
}): string {
  const prelude = options.extraPrelude ?? "";
  const defaultExport =
    options.exportDefault === false
      ? `export const ${options.exportedName ?? "playbook"} = definePlaybook(${JSON.stringify(options.graph, null, 2)});\n`
      : `export default definePlaybook(${JSON.stringify(options.graph, null, 2)});\n`;

  return `${prelude}import { definePlaybook } from "@tessera/plugin-sdk";\n${defaultExport}`;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("loadGraphPlaybookPackage", () => {
  test("loads a minimal package whose playbook.ts calls definePlaybook", async () => {
    const root = await makeRoot();
    const canonicalRoot = await realpath(root);

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      renderPlaybookSource({
        graph: baseGraph,
      })
    );

    const result = await loadGraphPlaybookPackage({
      root,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });

    expect(result.root).toBe(canonicalRoot);
    expect(result.manifest).toEqual(baseManifest);
    expect(result.compiled.graph).toEqual({
      schemaVersion: 1,
      id: baseGraph.id,
      version: baseGraph.version,
      name: baseGraph.name,
      inputs: {},
      artifacts: {
        scorecard: { schema: "./schemas/scorecard.schema.json" },
      },
      capabilities: [],
      limits: {},
      start: "score",
      nodes: baseGraph.nodes,
    });
    expect(result.compiled.metadata).toMatchObject({
      schemaVersion: 1,
      playbookId: baseManifest.id,
      packageVersion: baseManifest.version,
      compilerVersion,
      graphSchemaVersion: 1,
      scriptSdkVersion,
      compiledAt,
    });
    expect(result.compiled.metadata.sourceHash).toMatch(/^sha256:/);
    expect(result.compiled.metadata.graphHash).toMatch(/^sha256:/);
  });

  test("rejects missing default export", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      renderPlaybookSource({
        graph: baseGraph,
        exportDefault: false,
        exportedName: "playbook",
      })
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/default-export/i);
  });

  test("extracts the graph without executing entrypoint side effects", async () => {
    const root = await makeRoot();
    const canonicalRoot = await realpath(root);

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      `${renderPlaybookSource({
        graph: baseGraph,
      })}throw new Error("top-level package code must not execute");
`
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).resolves.toMatchObject({
      root: canonicalRoot,
      manifest: baseManifest,
    });
  });

  test("rejects non-literal graph expressions", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writePackageFile(
      root,
      "playbook.ts",
      `import { definePlaybook } from "@tessera/plugin-sdk";
const graph = ${JSON.stringify(baseGraph, null, 2)};
export default definePlaybook(graph);
`
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/static object literal/i);
  });

  test.each([
    ["id", { manifest: { id: "content.different" }, graph: { id: "content.different-graph" } }],
    ["version", { manifest: { version: "0.1.1" }, graph: { version: "0.1.0-next" } }],
    ["name", { manifest: { name: "Different Name" }, graph: { name: "Different Graph Name" } }],
  ])("rejects manifest and graph %s mismatch", async (_field, mismatch) => {
    const root = await makeRoot();

    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        ...baseManifest,
        ...mismatch.manifest,
      })
    );
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      renderPlaybookSource({
        graph: {
          ...baseGraph,
          ...mismatch.graph,
        },
      })
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Manifest and compiled graph must match/i);
  });

  test("rejects missing graph source refs", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writePackageFile(
      root,
      "playbook.ts",
      renderPlaybookSource({
        graph: baseGraph,
      })
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/source ref is missing/i);
  });

  test("rejects node:fs import", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writePackageFile(
      root,
      "playbook.ts",
      `import { readFile } from "node:fs/promises";\n${renderPlaybookSource({ graph: baseGraph })}`
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Dangerous imports/i);
  });

  test("rejects dynamic import", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writePackageFile(
      root,
      "playbook.ts",
      `await import("./scripts/helper.ts");\n${renderPlaybookSource({ graph: baseGraph })}`
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Dynamic import\(\)/i);
  });

  test("rejects non-literal require calls", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writePackageFile(
      root,
      "playbook.ts",
      `require(String("fs"));\n${renderPlaybookSource({ graph: baseGraph })}`
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/require\(\)/i);
  });

  test("rejects invalid entrypoint TypeScript syntax", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writePackageFile(root, "playbook.ts", 'export default definePlaybook({"id":\n');

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Invalid TypeScript/i);
  });

  test("rejects invalid imported TypeScript syntax", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      `import "./scripts/helper.ts";\n${renderPlaybookSource({ graph: baseGraph })}`
    );
    await writePackageFile(root, "scripts/helper.ts", "export const helper = ;\n");

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Invalid TypeScript/i);
  });

  test("rejects invalid referenced script syntax", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      renderPlaybookSource({
        graph: baseGraph,
      })
    );
    await writePackageFile(root, "scripts/score.ts", "export const score = ;\n");

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Invalid TypeScript/i);
  });

  test("rejects dangerous imports in referenced scripts", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      renderPlaybookSource({
        graph: baseGraph,
      })
    );
    await writePackageFile(root, "scripts/score.ts", 'import "node:fs";\n');

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Dangerous imports/i);
  });

  test("rejects dynamic imports in referenced scripts", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(root);
    await writePackageFile(
      root,
      "playbook.ts",
      renderPlaybookSource({
        graph: baseGraph,
      })
    );
    await writePackageFile(root, "scripts/score.ts", 'await import("./helper.ts");\n');

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/Dynamic import\(\)/i);
  });

  test("rejects outside-root import such as ../outside.ts", async () => {
    const root = await makeRoot();

    await writePackageFile(root, "manifest.json", JSON.stringify(baseManifest));
    await writePackageFile(
      root,
      "playbook.ts",
      `import "../outside.ts";\n${renderPlaybookSource({ graph: baseGraph })}`
    );

    await expect(
      loadGraphPlaybookPackage({
        root,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/escape the package root/i);
  });

  test("sourceHash changes when source changes", async () => {
    const firstRoot = await makeRoot();
    const secondRoot = await makeRoot();

    await writePackageFile(firstRoot, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(firstRoot);
    await writePackageFile(
      firstRoot,
      "playbook.ts",
      `import "./scripts/helper.ts";\n${renderPlaybookSource({ graph: baseGraph })}`
    );
    await writePackageFile(firstRoot, "scripts/helper.ts", 'export const helper = "one";\n');

    await writePackageFile(secondRoot, "manifest.json", JSON.stringify(baseManifest));
    await writeBaseGraphSourceRefs(secondRoot);
    await writePackageFile(
      secondRoot,
      "playbook.ts",
      `import "./scripts/helper.ts";\n${renderPlaybookSource({ graph: baseGraph })}`
    );
    await writePackageFile(secondRoot, "scripts/helper.ts", 'export const helper = "two";\n');

    const first = await loadGraphPlaybookPackage({
      root: firstRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const second = await loadGraphPlaybookPackage({
      root: secondRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });

    expect(first.compiled.metadata.sourceHash).not.toBe(second.compiled.metadata.sourceHash);
    expect(first.compiled.metadata.graphHash).toBe(second.compiled.metadata.graphHash);
  });
});
