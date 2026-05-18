import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createPlaybookGraphCache } from "./playbook-graph-cache.js";
import { compilePlaybookGraph } from "./playbook-graph-compiler.js";

const graph = {
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "0.1.0",
  name: "SEO Blog Article",
  artifacts: {
    scorecard: { schema: "./schemas/scorecard.schema.json" },
  },
  start: "score",
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

function compiled() {
  return compilePlaybookGraph({
    graph,
    sourceFiles: { "playbook.ts": "export default {};\n" },
    compilerVersion: "0.1.0",
    scriptSdkVersion: "0.1.0",
    compiledAt: "2026-05-15T00:00:00.000Z",
  });
}

function cacheSegment(value: string): string {
  return `v-${Buffer.from(value, "utf8").toString("base64url")}`;
}

describe("createPlaybookGraphCache", () => {
  test("saves and reads a compiled graph by graph hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const artifact = compiled();

    await cache.save(artifact);
    const loaded = await cache.get(artifact.metadata.playbookId, artifact.metadata.graphHash);

    expect(loaded?.metadata.graphHash).toBe(artifact.metadata.graphHash);
    expect(loaded?.graph.id).toBe("content.seo-blog");
  });

  test("updates latest pointer on save", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const getLatest = cache.getLatest;
    const first = compiled();
    const second = compilePlaybookGraph({
      graph: { ...graph, version: "0.1.1" },
      sourceFiles: { "playbook.ts": "export default {};\n" },
      compilerVersion: "0.1.0",
      scriptSdkVersion: "0.1.0",
      compiledAt: "2026-05-15T00:00:00.001Z",
    });

    await cache.save(first);
    await cache.save(second);

    const latest = await getLatest("content.seo-blog");

    expect(latest?.metadata.graphHash).toBe(second.metadata.graphHash);
  });

  test("preserves compiled graphs with the same graph hash and different source hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const first = compiled();
    const second = {
      ...first,
      metadata: {
        ...first.metadata,
        sourceHash: `sha256:${"b".repeat(64)}`,
        compiledAt: "2026-05-15T00:00:00.001Z",
      },
    };

    await cache.save(first);
    await cache.save(second);

    await expect(
      cache.getSource(
        first.metadata.playbookId,
        first.metadata.graphHash,
        first.metadata.sourceHash
      )
    ).resolves.toMatchObject({ metadata: { sourceHash: first.metadata.sourceHash } });
    await expect(
      cache.getSource(
        second.metadata.playbookId,
        second.metadata.graphHash,
        second.metadata.sourceHash
      )
    ).resolves.toMatchObject({ metadata: { sourceHash: second.metadata.sourceHash } });
  });

  test("writes artifact and latest JSON as pretty output with trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const artifact = compiled();

    const savedPath = await cache.save(artifact);
    const savedText = await readFile(savedPath, "utf8");
    const latestText = await readFile(
      join(root, cacheSegment(artifact.metadata.playbookId), "latest.json"),
      "utf8"
    );

    expect(savedText.startsWith('{\n  "graph":')).toBe(true);
    expect(savedText.endsWith("\n")).toBe(true);
    expect(latestText.endsWith("\n")).toBe(true);
    expect(JSON.parse(savedText).metadata.graphHash).toBe(artifact.metadata.graphHash);
  });

  test("returns undefined for missing cache entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);

    expect(await cache.get("content.seo-blog", "sha256:missing")).toBeUndefined();
    expect(await cache.getLatest("content.seo-blog")).toBeUndefined();
  });

  test("encodes playbook id and graph hash for cache path safety", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);

    const base = compiled();
    const playbookId = "content:encoded.playbook.";
    const graphHash = "sha256:slash/hash:with:colon.";
    const artifact = {
      ...base,
      graph: { ...base.graph, id: playbookId },
      metadata: {
        ...base.metadata,
        playbookId,
        graphHash,
      },
    };
    const latestPath = join(root, cacheSegment(playbookId), "latest.json");

    const savedPath = await cache.save(artifact);

    expect(cacheSegment(playbookId)).toMatch(/^v-[A-Za-z0-9_-]+$/);
    expect(cacheSegment(graphHash)).toMatch(/^v-[A-Za-z0-9_-]+$/);
    expect(savedPath).toBe(join(root, cacheSegment(playbookId), `${cacheSegment(graphHash)}.json`));
    expect(await cache.get(playbookId, graphHash)).toBeDefined();
    expect(await cache.getLatest(playbookId)).toBeDefined();

    const pointerText = await readFile(latestPath, "utf8");
    expect(pointerText).toContain(artifact.metadata.graphHash);
  });

  test.each([".", "..", "content.", "content.."])(
    "stores dot-only and trailing-dot playbook ids %s without escaping the cache root",
    async (playbookId) => {
      const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
      const cache = createPlaybookGraphCache(root);
      const base = compiled();
      const artifact = {
        ...base,
        graph: { ...base.graph, id: playbookId },
        metadata: {
          ...base.metadata,
          playbookId,
        },
      };

      const savedPath = await cache.save(artifact);
      const expectedPath = join(
        root,
        cacheSegment(playbookId),
        `${cacheSegment(artifact.metadata.graphHash)}.json`
      );
      const pointerPath = join(root, cacheSegment(playbookId), "latest.json");
      const savedRelative = relative(root, savedPath).split(sep);
      const pointerRelative = relative(root, pointerPath).split(sep);

      expect(savedPath).toBe(expectedPath);
      expect(savedRelative).not.toContain(".");
      expect(savedRelative).not.toContain("..");
      expect(pointerRelative).not.toContain(".");
      expect(pointerRelative).not.toContain("..");
      expect(await cache.get(playbookId, artifact.metadata.graphHash)).toBeDefined();
      expect(await cache.getLatest(playbookId)).toBeDefined();

      const pointerText = await readFile(pointerPath, "utf8");
      expect(pointerText).toContain(artifact.metadata.graphHash);
    }
  );

  test("treats malformed artifact files as cache misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const artifact = compiled();
    const artifactPath = join(
      root,
      cacheSegment(artifact.metadata.playbookId),
      `${cacheSegment(artifact.metadata.graphHash)}.json`
    );

    await cache.save(artifact);
    await writeFile(artifactPath, "{", "utf8");

    expect(
      await cache.get(artifact.metadata.playbookId, artifact.metadata.graphHash)
    ).toBeUndefined();

    await writeFile(artifactPath, "{}", "utf8");

    expect(
      await cache.get(artifact.metadata.playbookId, artifact.metadata.graphHash)
    ).toBeUndefined();
  });

  test("treats malformed latest files as cache misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const artifact = compiled();
    const latestPath = join(root, cacheSegment(artifact.metadata.playbookId), "latest.json");

    await cache.save(artifact);
    await writeFile(latestPath, "{", "utf8");

    expect(await cache.getLatest(artifact.metadata.playbookId)).toBeUndefined();

    await writeFile(latestPath, "{}", "utf8");

    expect(await cache.getLatest(artifact.metadata.playbookId)).toBeUndefined();
  });
});
