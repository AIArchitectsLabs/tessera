import { describe, expect, test } from "bun:test";
import { PlaybookGraphPackageManifestSchema } from "./index.js";

describe("PlaybookGraphPackageManifestSchema", () => {
  test("accepts a minimal manifest", () => {
    const manifest = PlaybookGraphPackageManifestSchema.parse({
      schemaVersion: 1,
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
    });

    expect(manifest.id).toBe("content.seo-blog");
    expect(manifest.entrypoint).toBe("playbook.ts");
  });

  test("defaults entrypoint to playbook.ts", () => {
    const manifest = PlaybookGraphPackageManifestSchema.parse({
      schemaVersion: 1,
      id: "demo.package",
      version: "1.0.0",
      name: "Demo Package",
    });

    expect(manifest.entrypoint).toBe("playbook.ts");
  });

  test("rejects absolute or escaping entrypoint paths", () => {
    const invalidEntrypoints = [
      "/tmp/playbook.ts",
      "../playbook.ts",
      "./../playbook.ts",
      "playbooks/../playbook.ts",
      "C:\\tmp\\playbook.ts",
      "\\\\server\\share\\playbook.ts",
    ];

    for (const entrypoint of invalidEntrypoints) {
      expect(() =>
        PlaybookGraphPackageManifestSchema.parse({
          schemaVersion: 1,
          id: "demo.package",
          version: "1.0.0",
          name: "Demo Package",
          entrypoint,
        })
      ).toThrow();
    }
  });

  test("rejects unsupported schema version", () => {
    expect(() =>
      PlaybookGraphPackageManifestSchema.parse({
        schemaVersion: 2,
        id: "demo.package",
        version: "1.0.0",
        name: "Demo Package",
      })
    ).toThrow();
  });

  test("rejects invalid package id", () => {
    expect(() =>
      PlaybookGraphPackageManifestSchema.parse({
        schemaVersion: 1,
        id: "demo package",
        version: "1.0.0",
        name: "Demo Package",
      })
    ).toThrow();
  });

  test("rejects unknown extra keys", () => {
    expect(() =>
      PlaybookGraphPackageManifestSchema.parse({
        schemaVersion: 1,
        id: "demo.package",
        version: "1.0.0",
        name: "Demo Package",
        extra: true,
      })
    ).toThrow();
  });
});
