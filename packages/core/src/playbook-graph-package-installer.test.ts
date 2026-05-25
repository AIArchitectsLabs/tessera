import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlaybookGraphCache } from "./playbook-graph-cache.js";
import { installGraphPlaybookPackage } from "./playbook-graph-package-installer.js";

const tempRoots: string[] = [];
const compilerVersion = "tessera-core-test-compiler";
const scriptSdkVersion = "tessera-plugin-sdk-test";
const compiledAt = "2026-01-01T00:00:00.000Z";

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
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function writePackage(root: string, version: string, extraFile = false): Promise<void> {
  const graph = {
    schemaVersion: 1 as const,
    id: "content.seo-blog",
    version,
    name: "SEO Blog Article",
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

  await writePackageFile(
    root,
    "manifest.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        id: graph.id,
        version: graph.version,
        name: graph.name,
        entrypoint: "playbook.ts",
      },
      null,
      0
    )
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

  if (extraFile) {
    await writePackageFile(root, "notes/private.txt", "top secret\n");
  }
}

async function writeTsLiteralPackage(root: string, version: string): Promise<void> {
  await writePackageFile(
    root,
    "manifest.json",
    JSON.stringify({
      schemaVersion: 1,
      id: "content.seo-blog",
      version,
      name: "SEO Blog Article",
      entrypoint: "playbook.ts",
    })
  );
  await writePackageFile(
    root,
    "playbook.ts",
    `import { definePlaybook } from "@tessera/plugin-sdk";
export default definePlaybook({
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "${version}",
  name: "SEO Blog Article",
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
});
`
  );
  await writePackageFile(root, "scripts/score.ts", "export default async function score() {}\n");
  await writePackageFile(root, "schemas/scorecard.schema.json", '{"type":"object"}\n');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installGraphPlaybookPackage", () => {
  test("installs a package and writes the compiled graph cache", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.1.0", true);

    const result = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });

    const expectedInstalledRoot = join(
      installRoot,
      cacheSegment("content.seo-blog"),
      cacheSegment("0.1.0")
    );
    const expectedGraphPath = join(
      cacheRoot,
      cacheSegment("content.seo-blog"),
      `${cacheSegment(result.compiled.metadata.graphHash)}.json`
    );
    const cache = createPlaybookGraphCache(cacheRoot);
    const installMetadata = JSON.parse(
      await readFile(join(expectedInstalledRoot, "install.json"), "utf8")
    ) as Record<string, unknown>;
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(result.installedRoot).toBe(expectedInstalledRoot);
    expect(result.compiledGraphPath).toBe(expectedGraphPath);
    expect(result.compiled.metadata.playbookId).toBe("content.seo-blog");
    expect(result.compiled.metadata.packageVersion).toBe("0.1.0");
    expect(result.warnings).toBeUndefined();
    expect(installMetadata).toMatchObject({
      schemaVersion: 1,
      playbookId: "content.seo-blog",
      packageVersion: "0.1.0",
      graphHash: result.compiled.metadata.graphHash,
      sourceHash: result.compiled.metadata.sourceHash,
    });
    expect(typeof installMetadata.installedAt).toBe("string");
    expect(latestMetadata).toMatchObject({
      playbookId: "content.seo-blog",
      packageVersion: "0.1.0",
      graphHash: result.compiled.metadata.graphHash,
      sourceHash: result.compiled.metadata.sourceHash,
    });
    expect(await cache.getLatest("content.seo-blog")).toMatchObject({
      metadata: {
        graphHash: result.compiled.metadata.graphHash,
      },
    });
    await expect(
      readFile(join(expectedInstalledRoot, "notes/private.txt"), "utf8")
    ).rejects.toThrow();
  });

  test("idempotent reinstall with the same source hash succeeds", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.1.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const second = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });

    expect(second.installedRoot).toBe(first.installedRoot);
    expect(second.compiledGraphPath).toBe(first.compiledGraphPath);
    expect(second.compiled.metadata.sourceHash).toBe(first.compiled.metadata.sourceHash);
    expect(second.warnings).toBeUndefined();
  });

  test("fails idempotent reinstall when installed files are missing", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.1.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await rm(join(first.installedRoot, "scripts"), { force: true, recursive: true });

    await expect(
      installGraphPlaybookPackage({
        sourceRoot,
        installRoot,
        cacheRoot,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow();
  });

  test("rejects the same version when the source hash changes", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.1.0");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });

    await writePackageFile(
      sourceRoot,
      "scripts/score.ts",
      "export default async function score() { return 1; }\n"
    );

    await expect(
      installGraphPlaybookPackage({
        sourceRoot,
        installRoot,
        cacheRoot,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow(/source hash changed/i);
  });

  test("updates latest when installing a newer version", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.1.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await writePackage(sourceRoot, "0.2.0");

    const second = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(second.installedRoot).toBe(
      join(installRoot, cacheSegment("content.seo-blog"), cacheSegment("0.2.0"))
    );
    expect(second.compiled.metadata.packageVersion).toBe("0.2.0");
    expect(latestMetadata).toMatchObject({
      packageVersion: "0.2.0",
      graphHash: second.compiled.metadata.graphHash,
    });
    expect(
      await readFile(
        join(installRoot, cacheSegment("content.seo-blog"), cacheSegment("0.1.0"), "install.json"),
        "utf8"
      )
    ).toContain(first.compiled.metadata.sourceHash);
  });

  test("installs an older version side-by-side without moving latest", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.2.0");

    const newer = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await writePackage(sourceRoot, "0.1.0");

    const older = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });

    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;
    const cache = createPlaybookGraphCache(cacheRoot);

    expect(latestMetadata).toMatchObject({
      packageVersion: "0.2.0",
      graphHash: newer.compiled.metadata.graphHash,
    });
    expect(older.compiled.metadata.packageVersion).toBe("0.1.0");
    expect(
      await readFile(
        join(installRoot, cacheSegment("content.seo-blog"), cacheSegment("0.1.0"), "install.json"),
        "utf8"
      )
    ).toContain(older.compiled.metadata.sourceHash);
    expect(await cache.getLatest("content.seo-blog")).toMatchObject({
      metadata: {
        graphHash: newer.compiled.metadata.graphHash,
      },
    });
  });

  test("treats legacy integer package versions as semver-compatible", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "1");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await writePackage(sourceRoot, "1.0.3");

    const upgraded = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(latestMetadata).toMatchObject({
      packageVersion: "1.0.3",
      graphHash: upgraded.compiled.metadata.graphHash,
    });
  });

  test("preserves latest for installed TypeScript literal playbooks", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writeTsLiteralPackage(sourceRoot, "1.0.0");

    const newer = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await writePackage(sourceRoot, "0.9.0");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(latestMetadata).toMatchObject({
      packageVersion: "1.0.0",
      graphHash: newer.compiled.metadata.graphHash,
    });
  });

  test("keeps latest and returns a warning when versions are incomparable", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "1.0.0");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await writePackage(sourceRoot, "release-next");

    const result = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("Could not compare installed versions");
    expect(latestMetadata).toMatchObject({
      packageVersion: "1.0.0",
    });
  });

  test("ignores stale latest conflict when no matching install exists", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.1.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await rm(join(installRoot, cacheSegment("content.seo-blog"), cacheSegment("0.1.0")), {
      force: true,
      recursive: true,
    });
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/latest.json`,
      JSON.stringify({
        schemaVersion: 1,
        playbookId: "content.seo-blog",
        packageVersion: "0.1.0",
        graphHash: first.compiled.metadata.graphHash,
        sourceHash: "sha256:stale",
        installedAt: compiledAt,
      })
    );

    const second = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });

    expect(second.compiled.metadata.sourceHash).toBe(first.compiled.metadata.sourceHash);
    expect(second.warnings).toBeUndefined();
  });

  test("writes latest for a first install with an incomparable version", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "release-next");

    const result = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(result.warnings).toBeUndefined();
    expect(latestMetadata).toMatchObject({
      playbookId: "content.seo-blog",
      packageVersion: "release-next",
      graphHash: result.compiled.metadata.graphHash,
    });
  });

  test("ignores foreign latest and install metadata when rebuilding latest", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "1.0.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const playbookDir = join(installRoot, cacheSegment("content.seo-blog"));
    const foreignMetadata = {
      schemaVersion: 1,
      playbookId: "content.other",
      packageVersion: "9.9.9",
      graphHash: "sha256:foreign",
      sourceHash: "sha256:foreign",
      installedAt: compiledAt,
    };
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/latest.json`,
      JSON.stringify(foreignMetadata)
    );
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("9.9.9")}/install.json`,
      JSON.stringify(foreignMetadata)
    );
    await writePackage(sourceRoot, "release-next");

    const second = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(playbookDir, "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(second.warnings).toHaveLength(1);
    expect(second.warnings?.[0]).toContain("Could not compare all installed versions");
    expect(latestMetadata).toMatchObject({
      playbookId: "content.seo-blog",
      packageVersion: "1.0.0",
      graphHash: first.compiled.metadata.graphHash,
    });
  });

  test("ignores forged same-playbook install metadata with mismatched source files", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "1.0.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/install.json`,
      JSON.stringify({
        schemaVersion: 1,
        playbookId: "content.seo-blog",
        packageVersion: "999.0.0",
        graphHash: "sha256:forged",
        sourceHash: "sha256:forged",
        installedAt: compiledAt,
      })
    );
    await writePackage(sourceRoot, "0.2.0");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(latestMetadata).toMatchObject({
      packageVersion: "1.0.0",
      graphHash: first.compiled.metadata.graphHash,
    });
  });

  test("ignores forged same-playbook install metadata with mismatched graph hash", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "1.0.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const forgedMetadata = {
      schemaVersion: 1,
      playbookId: "content.seo-blog",
      packageVersion: "999.0.0",
      graphHash: "sha256:forged",
      sourceHash: first.compiled.metadata.sourceHash,
      installedAt: compiledAt,
    };
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/manifest.json`,
      await readFile(join(first.installedRoot, "manifest.json"), "utf8")
    );
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/playbook.ts`,
      await readFile(join(first.installedRoot, "playbook.ts"), "utf8")
    );
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/scripts/score.ts`,
      await readFile(join(first.installedRoot, "scripts/score.ts"), "utf8")
    );
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/schemas/scorecard.schema.json`,
      await readFile(join(first.installedRoot, "schemas/scorecard.schema.json"), "utf8")
    );
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/install.json`,
      JSON.stringify(forgedMetadata)
    );
    await writePackage(sourceRoot, "0.2.0");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(latestMetadata).toMatchObject({
      packageVersion: "1.0.0",
      graphHash: first.compiled.metadata.graphHash,
    });
  });

  test("ignores self-consistent invalid installed package metadata", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "1.0.0");

    const first = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const forgedRoot = join(installRoot, cacheSegment("content.seo-blog"), cacheSegment("999.0.0"));
    const forgedSourceFiles = {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "999.0.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      }),
      "playbook.ts": `import { definePlaybook } from "@tessera/plugin-sdk";
export default definePlaybook({
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "999.0.0",
  name: "SEO Blog Article",
  start: "score",
  artifacts: {
    scorecard: { schema: "./schemas/missing.schema.json" },
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
});
`,
      "scripts/score.ts": "export default async function score() {}\n",
    };
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/manifest.json`,
      forgedSourceFiles["manifest.json"]
    );
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/playbook.ts`,
      forgedSourceFiles["playbook.ts"]
    );
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("999.0.0")}/scripts/score.ts`,
      forgedSourceFiles["scripts/score.ts"]
    );
    const { hashPlaybookGraph, hashPlaybookSourceFiles } = await import("./playbook-graph.js");
    await writePackageFile(
      forgedRoot,
      "install.json",
      JSON.stringify({
        schemaVersion: 1,
        playbookId: "content.seo-blog",
        packageVersion: "999.0.0",
        graphHash: hashPlaybookGraph({
          schemaVersion: 1,
          id: "content.seo-blog",
          version: "999.0.0",
          name: "SEO Blog Article",
          start: "score",
          artifacts: {
            scorecard: { schema: "./schemas/missing.schema.json" },
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
        }),
        sourceHash: hashPlaybookSourceFiles(forgedSourceFiles),
        installedAt: compiledAt,
      })
    );
    await writePackage(sourceRoot, "0.2.0");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(latestMetadata).toMatchObject({
      packageVersion: "1.0.0",
      graphHash: first.compiled.metadata.graphHash,
    });
  });

  test("repairs a missing latest pointer from installed semver metadata", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.2.0");

    const newer = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await rm(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), { force: true });
    await writePackage(sourceRoot, "0.1.0");

    await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(latestMetadata).toMatchObject({
      packageVersion: "0.2.0",
      graphHash: newer.compiled.metadata.graphHash,
    });
  });

  test("keeps the existing latest pointer when install replacement fails", async () => {
    const sourceRoot = await makeRoot("tessera-playbook-source-");
    const installRoot = await makeRoot("tessera-playbook-install-");
    const cacheRoot = await makeRoot("tessera-playbook-cache-");
    await writePackage(sourceRoot, "0.1.0");

    const original = await installGraphPlaybookPackage({
      sourceRoot,
      installRoot,
      cacheRoot,
      compilerVersion,
      scriptSdkVersion,
      compiledAt,
    });
    await writePackage(sourceRoot, "0.1.1");
    await writePackageFile(
      installRoot,
      `${cacheSegment("content.seo-blog")}/${cacheSegment("0.1.1")}`,
      "blocking file\n"
    );

    await expect(
      installGraphPlaybookPackage({
        sourceRoot,
        installRoot,
        cacheRoot,
        compilerVersion,
        scriptSdkVersion,
        compiledAt,
      })
    ).rejects.toThrow();

    const latestMetadata = JSON.parse(
      await readFile(join(installRoot, cacheSegment("content.seo-blog"), "latest.json"), "utf8")
    ) as Record<string, unknown>;

    expect(latestMetadata).toMatchObject({
      packageVersion: "0.1.0",
    });
    expect(await readFile(join(original.installedRoot, "manifest.json"), "utf8")).toContain(
      '"version":"0.1.0"'
    );
    expect(await readFile(join(original.installedRoot, "playbook.ts"), "utf8")).toContain(
      '"version": "0.1.0"'
    );
    expect(await readFile(join(original.installedRoot, "scripts/score.ts"), "utf8")).toContain(
      "score"
    );
    expect(
      await readFile(join(original.installedRoot, "schemas/scorecard.schema.json"), "utf8")
    ).toContain("object");
  });
});
