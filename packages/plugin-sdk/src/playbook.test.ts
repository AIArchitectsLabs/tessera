import { describe, expect, test } from "bun:test";
import { definePlaybook } from "./playbook.js";

describe("definePlaybook", () => {
  test("returns a validated normalized graph", () => {
    const graph = definePlaybook({
      schemaVersion: 1,
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
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
    });

    expect(graph.id).toBe("content.seo-blog");
    expect(graph.inputs).toEqual({});
    expect(graph.capabilities).toEqual([]);
  });

  test("throws on invalid authoring input", () => {
    expect(() =>
      definePlaybook({
        schemaVersion: 1,
        id: "content.bad",
        version: "0.1.0",
        name: "Bad",
        start: "score",
        nodes: [
          {
            id: "score",
            kind: "script",
            run: "./scripts/score.py",
          },
        ],
      })
    ).toThrow(/TypeScript/);
  });
});
