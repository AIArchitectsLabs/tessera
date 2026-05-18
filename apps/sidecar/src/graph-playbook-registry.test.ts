import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installGraphPlaybookPackage } from "@tessera/core";
import {
  loadInstalledGraphPlaybookCatalog,
  loadInstalledGraphPlaybookRegistry,
} from "./graph-playbook-registry.js";

const tempRoots: string[] = [];

function cacheSegment(value: string): string {
  return `v-${Buffer.from(value, "utf8").toString("base64url")}`;
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writePackageFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function writePackage(
  root: string,
  id: string,
  version: string,
  name: string
): Promise<void> {
  const graph = {
    schemaVersion: 1,
    id,
    version,
    name,
    start: "score",
    artifacts: {
      scorecard: { schema: "./schemas/scorecard.schema.json" },
    },
    nodes: [
      {
        id: "score",
        kind: "script",
        run: "./scripts/score.ts",
        inputs: {},
        outputArtifact: "scorecard",
        onSuccess: "completed",
      },
    ],
  };

  await writePackageFile(
    root,
    "manifest.json",
    JSON.stringify({
      schemaVersion: 1,
      id,
      version,
      name,
      entrypoint: "playbook.ts",
    })
  );
  await writePackageFile(
    root,
    "playbook.ts",
    `import { definePlaybook } from "@tessera/plugin-sdk";
export default definePlaybook(${JSON.stringify(graph, null, 2)});
`
  );
  await writePackageFile(root, "scripts/score.ts", "export default async function score() {}\n");
  await writePackageFile(root, "schemas/scorecard.schema.json", '{"type":"object"}\n');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadInstalledGraphPlaybookRegistry", () => {
  test("loads installed package entries sorted by id and version", async () => {
    const installRoot = await makeRoot("tessera-sidecar-graph-install-");
    const cacheRoot = await makeRoot("tessera-sidecar-graph-cache-");
    const firstSource = await makeRoot("tessera-sidecar-graph-source-");
    const secondSource = await makeRoot("tessera-sidecar-graph-source-");

    await writePackage(firstSource, "content.seo-blog", "0.2.0", "SEO Blog Article");
    await writePackage(secondSource, "content.brief", "0.1.0", "Content Brief");
    const first = await installGraphPlaybookPackage({
      sourceRoot: firstSource,
      installRoot,
      cacheRoot,
      compilerVersion: "sidecar-test",
      scriptSdkVersion: "sidecar-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const second = await installGraphPlaybookPackage({
      sourceRoot: secondSource,
      installRoot,
      cacheRoot,
      compilerVersion: "sidecar-test",
      scriptSdkVersion: "sidecar-test",
      compiledAt: "2026-05-15T00:00:01.000Z",
    });

    const entries = await loadInstalledGraphPlaybookRegistry({ installRoot, cacheRoot });

    expect(entries).toEqual([
      expect.objectContaining({
        id: "content.brief",
        packageVersion: "0.1.0",
        name: "Content Brief",
        graphHash: second.compiled.metadata.graphHash,
        sourceHash: second.compiled.metadata.sourceHash,
        installedRoot: second.installedRoot,
        compiled: second.compiled,
      }),
      expect.objectContaining({
        id: "content.seo-blog",
        packageVersion: "0.2.0",
        name: "SEO Blog Article",
        graphHash: first.compiled.metadata.graphHash,
        sourceHash: first.compiled.metadata.sourceHash,
        installedRoot: first.installedRoot,
        compiled: first.compiled,
      }),
    ]);
  });

  test("loads only latest catalog entries by id", async () => {
    const installRoot = await makeRoot("tessera-sidecar-graph-install-");
    const cacheRoot = await makeRoot("tessera-sidecar-graph-cache-");
    const firstSource = await makeRoot("tessera-sidecar-graph-source-");
    const secondSource = await makeRoot("tessera-sidecar-graph-source-");

    await writePackage(firstSource, "content.seo-blog", "0.1.0", "SEO Blog Article");
    await writePackage(secondSource, "content.seo-blog", "0.2.0", "SEO Blog Article v2");
    await installGraphPlaybookPackage({
      sourceRoot: firstSource,
      installRoot,
      cacheRoot,
      compilerVersion: "sidecar-test",
      scriptSdkVersion: "sidecar-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const latest = await installGraphPlaybookPackage({
      sourceRoot: secondSource,
      installRoot,
      cacheRoot,
      compilerVersion: "sidecar-test",
      scriptSdkVersion: "sidecar-test",
      compiledAt: "2026-05-15T00:00:01.000Z",
    });

    const registry = await loadInstalledGraphPlaybookRegistry({ installRoot, cacheRoot });
    const catalog = await loadInstalledGraphPlaybookCatalog({ installRoot, cacheRoot });

    expect(registry).toHaveLength(2);
    expect(catalog).toEqual([
      expect.objectContaining({
        id: "content.seo-blog",
        packageVersion: "0.2.0",
        name: "SEO Blog Article v2",
        graphHash: latest.compiled.metadata.graphHash,
        sourceHash: latest.compiled.metadata.sourceHash,
      }),
    ]);
  });

  test("skips entries whose compiled graph artifact is missing from cache", async () => {
    const installRoot = await makeRoot("tessera-sidecar-graph-install-");
    const cacheRoot = await makeRoot("tessera-sidecar-graph-cache-");
    const sourceRoot = await makeRoot("tessera-sidecar-graph-source-");

    await writePackage(sourceRoot, "content.seo-blog", "0.1.0", "SEO Blog Article");
    const installed = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion: "sidecar-test",
      scriptSdkVersion: "sidecar-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    await rm(
      join(
        cacheRoot,
        cacheSegment("content.seo-blog"),
        `${cacheSegment(installed.compiled.metadata.graphHash)}.json`
      ),
      { force: true }
    );
    await rm(
      join(
        cacheRoot,
        cacheSegment("content.seo-blog"),
        cacheSegment(installed.compiled.metadata.graphHash),
        `${cacheSegment(installed.compiled.metadata.sourceHash)}.json`
      ),
      { force: true }
    );

    await expect(loadInstalledGraphPlaybookRegistry({ installRoot, cacheRoot })).resolves.toEqual(
      []
    );
  });

  test("skips entries whose compiled graph artifact does not match install metadata", async () => {
    const installRoot = await makeRoot("tessera-sidecar-graph-install-");
    const cacheRoot = await makeRoot("tessera-sidecar-graph-cache-");
    const sourceRoot = await makeRoot("tessera-sidecar-graph-source-");

    await writePackage(sourceRoot, "content.seo-blog", "0.1.0", "SEO Blog Article");
    const installed = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion: "sidecar-test",
      scriptSdkVersion: "sidecar-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const artifactPath = join(
      cacheRoot,
      cacheSegment("content.seo-blog"),
      cacheSegment(installed.compiled.metadata.graphHash),
      `${cacheSegment(installed.compiled.metadata.sourceHash)}.json`
    );
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as typeof installed.compiled;
    await writeFile(
      artifactPath,
      JSON.stringify(
        {
          ...artifact,
          graph: {
            ...artifact.graph,
            name: "Tampered SEO Blog Article",
          },
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(loadInstalledGraphPlaybookRegistry({ installRoot, cacheRoot })).resolves.toEqual(
      []
    );
  });

  test("skips malformed install metadata", async () => {
    const installRoot = await makeRoot("tessera-sidecar-graph-install-");
    const cacheRoot = await makeRoot("tessera-sidecar-graph-cache-");
    const sourceRoot = await makeRoot("tessera-sidecar-graph-source-");

    await writePackage(sourceRoot, "content.seo-blog", "0.1.0", "SEO Blog Article");
    const installed = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion: "sidecar-test",
      scriptSdkVersion: "sidecar-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    await writeFile(join(installed.installedRoot, "install.json"), "{broken", "utf8");

    await expect(loadInstalledGraphPlaybookRegistry({ installRoot, cacheRoot })).resolves.toEqual(
      []
    );
  });
});
