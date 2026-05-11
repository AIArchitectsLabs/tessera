import { describe, expect, test } from "bun:test";
import { PlaybookManifestSchema } from "./index.js";

describe("PlaybookManifestSchema", () => {
  const validWorkflow = {
    id: "demo",
    version: 1,
    name: "Demo",
    start: "ping",
    inputs: {},
    steps: [
      {
        id: "ping",
        kind: "tool",
        toolId: "workspace.ping",
        args: {},
        onSuccess: "completed",
      },
    ],
  };

  test("accepts a minimal valid manifest", () => {
    const result = PlaybookManifestSchema.parse({
      schemaVersion: 1,
      meta: {
        id: "demo",
        version: 1,
        name: "Demo",
      },
      workflow: validWorkflow,
    });
    expect(result.meta.id).toBe("demo");
    expect(result.workflow.id).toBe("demo");
  });

  test("accepts optional meta fields", () => {
    const result = PlaybookManifestSchema.parse({
      schemaVersion: 1,
      meta: {
        id: "demo",
        version: 1,
        name: "Demo",
        description: "A demo playbook",
        author: "Tessera",
        tags: ["demo", "test"],
        signature: "abc123",
      },
      workflow: validWorkflow,
    });
    expect(result.meta.author).toBe("Tessera");
    expect(result.meta.tags).toEqual(["demo", "test"]);
  });

  test("rejects missing schemaVersion", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        meta: { id: "demo", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects unsupported schemaVersion", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 999,
        meta: { id: "demo", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects empty meta.id", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 1,
        meta: { id: "", version: 1, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });

  test("rejects non-positive meta.version", () => {
    expect(() =>
      PlaybookManifestSchema.parse({
        schemaVersion: 1,
        meta: { id: "demo", version: 0, name: "Demo" },
        workflow: validWorkflow,
      })
    ).toThrow();
  });
});
