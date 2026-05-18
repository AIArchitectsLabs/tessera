import { describe, expect, test } from "bun:test";
import { GraphPlaybookImportResultSchema, PlaybookGraphPackageManifestSchema } from "./index.js";

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

describe("GraphPlaybookImportResultSchema", () => {
  test("accepts import statuses and defaults warnings", () => {
    const parsed = GraphPlaybookImportResultSchema.parse({
      schemaVersion: 1,
      status: "installed",
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
      graphHash: `sha256:${"a".repeat(64)}`,
      sourceHash: `sha256:${"b".repeat(64)}`,
    });

    expect(parsed.warnings).toEqual([]);
    for (const status of ["updated", "unchanged", "archived"] as const) {
      expect(GraphPlaybookImportResultSchema.parse({ ...parsed, status }).status).toBe(status);
    }
  });

  test("rejects invalid graph and source hashes", () => {
    const input = {
      schemaVersion: 1,
      status: "installed",
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
      graphHash: "sha256:not-hex",
      sourceHash: `sha256:${"b".repeat(64)}`,
    };

    expect(() => GraphPlaybookImportResultSchema.parse(input)).toThrow();
    expect(() =>
      GraphPlaybookImportResultSchema.parse({
        ...input,
        graphHash: `sha256:${"a".repeat(64)}`,
        sourceHash: "not-sha",
      })
    ).toThrow();
  });
});
