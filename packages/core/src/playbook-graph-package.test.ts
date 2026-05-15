import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertPackageRelativePath,
  isPackageContainedRelativePath,
  readPlaybookGraphPackage,
} from "./playbook-graph-package.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tessera-playbook-graph-package-"));
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("assertPackageRelativePath", () => {
  test("returns POSIX-style relative paths", () => {
    expect(assertPackageRelativePath("prompts\\brief.md")).toBe("prompts/brief.md");
  });

  test.each([
    "",
    ".",
    "..",
    "/playbook.ts",
    "\\\\server\\share\\playbook.ts",
    "//server/share/playbook.ts",
    "C:playbook.ts",
    "C:/playbook.ts",
    "C:\\playbook.ts",
    "playbook/./ts",
    "playbook/../ts",
    "playbook//ts",
  ])("rejects unsafe path form %s", (relativePath) => {
    expect(() => assertPackageRelativePath(relativePath)).toThrow();
  });
});

describe("isPackageContainedRelativePath", () => {
  test.each(["file.txt", "scripts/playbook.ts", ".git/hooks"])(
    "accepts contained relative path %s",
    (relativePath) => {
      expect(isPackageContainedRelativePath(relativePath)).toBe(true);
    }
  );

  test.each([
    "..",
    "../escape.txt",
    "D:\\escape\\file.txt",
    "D:/escape/file.txt",
    "/escape/file.txt",
  ])("rejects escaped or absolute relative result %s", (relativePath) => {
    expect(isPackageContainedRelativePath(relativePath)).toBe(false);
  });
});

describe("readPlaybookGraphPackage", () => {
  test("reads manifest and source files", async () => {
    const root = await makeRoot();
    const canonicalRoot = await realpath(root);
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "content.seo-blog",
          version: "0.1.0",
          name: "SEO Blog Article",
          entrypoint: "playbook.ts",
        },
        null,
        0
      )
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await writePackageFile(root, "prompts/brief.md", "# Brief\n");
    await writePackageFile(root, "scripts/plan.ts", "export const plan = 1;\n");
    await writePackageFile(root, "schemas/research.json", '{"type":"object"}\n');
    await writePackageFile(root, "assets/ignored.bin", "ignore me");
    await writePackageFile(
      root,
      "package.json",
      JSON.stringify({ name: "demo", version: "0.1.0" })
    );

    const packageFiles = await readPlaybookGraphPackage(root);

    expect(packageFiles.root).toBe(canonicalRoot);
    expect(packageFiles.manifestPath).toBe(join(canonicalRoot, "manifest.json"));
    expect(packageFiles.manifest).toEqual({
      schemaVersion: 1,
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
      entrypoint: "playbook.ts",
    });
    expect(Object.keys(packageFiles.sourceFiles)).toEqual([
      "manifest.json",
      "playbook.ts",
      "prompts/brief.md",
      "schemas/research.json",
      "scripts/plan.ts",
    ]);
    expect(packageFiles.sourceFiles).toMatchObject({
      "manifest.json":
        '{"schemaVersion":1,"id":"content.seo-blog","version":"0.1.0","name":"SEO Blog Article","entrypoint":"playbook.ts"}',
      "playbook.ts": "export default {};\n",
      "prompts/brief.md": "# Brief\n",
      "schemas/research.json": '{"type":"object"}\n',
      "scripts/plan.ts": "export const plan = 1;\n",
    });
    expect(Object.keys(packageFiles.sourceFiles).some((path) => path.startsWith("assets/"))).toBe(
      false
    );
    expect("package.json" in packageFiles.sourceFiles).toBe(false);
  });

  test("rejects missing manifest", async () => {
    const root = await makeRoot();
    await writePackageFile(root, "playbook.ts", "export default {};\n");

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(/manifest\.json/i);
  });

  test("rejects dependency directories and lockfiles", async () => {
    const root = await makeRoot();
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      })
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await writePackageFile(root, "node_modules/dep/index.js", "module.exports = {};\n");

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(/node_modules/i);
  });

  test.each(["package-lock.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"])(
    "rejects lockfile %s",
    async (lockfileName) => {
      const root = await makeRoot();
      await writePackageFile(
        root,
        "manifest.json",
        JSON.stringify({
          schemaVersion: 1,
          id: "content.seo-blog",
          version: "0.1.0",
          name: "SEO Blog Article",
          entrypoint: "playbook.ts",
        })
      );
      await writePackageFile(root, "playbook.ts", "export default {};\n");
      await writePackageFile(root, lockfileName, "{}\n");

      await expect(readPlaybookGraphPackage(root)).rejects.toThrow(/Lockfiles/i);
    }
  );

  test("rejects package.json postinstall", async () => {
    const root = await makeRoot();
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      })
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await writePackageFile(
      root,
      "package.json",
      JSON.stringify({
        name: "demo",
        version: "0.1.0",
        scripts: {
          postinstall: "node build.js",
        },
      })
    );

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(/postinstall/i);
  });

  test.each([
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ])("rejects package.json dependency field %s", async (dependencyField) => {
    const root = await makeRoot();
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      })
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await writePackageFile(
      root,
      "package.json",
      JSON.stringify({
        name: "demo",
        version: "0.1.0",
        [dependencyField]: {
          leftpad: "1.0.0",
        },
      })
    );

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(new RegExp(dependencyField));
  });

  test("rejects escaping symlink", async () => {
    const root = await makeRoot();
    const outside = join(root, "..", "escape-target.txt");
    await writeFile(outside, "outside\n", "utf8");
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      })
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await mkdir(join(root, "scripts"), { recursive: true });
    await symlink(outside, join(root, "scripts", "escape.ts"));

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(/outside/i);
    await rm(outside, { force: true });
  });

  test("rejects escaping manifest symlink before parsing the target", async () => {
    const root = await makeRoot();
    const outside = join(root, "..", "outside-manifest.json");
    await writeFile(outside, "{", "utf8");
    await symlink(outside, join(root, "manifest.json"));

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(
      /manifest\.json resolves outside/i
    );
    await rm(outside, { force: true });
  });

  test("rejects internal directory symlinks", async () => {
    const root = await makeRoot();
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      })
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await symlink(root, join(root, "scripts"));

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(/Directory symlinks/i);
  });

  test("rejects self-referential directory symlink loops deterministically", async () => {
    const root = await makeRoot();
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      })
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await symlink("scripts", join(root, "scripts"));

    await expect(readPlaybookGraphPackage(root)).rejects.toThrow(/Directory symlinks/i);
  });

  test("ignores assets for source files", async () => {
    const root = await makeRoot();
    await writePackageFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        entrypoint: "playbook.ts",
      })
    );
    await writePackageFile(root, "playbook.ts", "export default {};\n");
    await writePackageFile(root, "assets/images/logo.txt", "logo\n");
    await writePackageFile(root, "assets/data/ignore.json", '{"ignored":true}\n');

    const packageFiles = await readPlaybookGraphPackage(root);

    expect(Object.keys(packageFiles.sourceFiles)).toEqual(["manifest.json", "playbook.ts"]);
    expect(Object.keys(packageFiles.sourceFiles).some((path) => path.startsWith("assets/"))).toBe(
      false
    );
  });
});
