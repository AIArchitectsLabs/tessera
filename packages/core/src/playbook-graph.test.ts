import { describe, expect, test } from "bun:test";
import {
  hashPlaybookGraph,
  hashPlaybookSourceFiles,
  stableJsonStringify,
  validatePlaybookGraph,
} from "./playbook-graph.js";

const graph = {
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "0.1.0",
  name: "SEO Blog Article",
  artifacts: {
    researchPlan: { schema: "./schemas/research-plan.schema.json" },
    scorecard: { schema: "./schemas/scorecard.schema.json" },
  },
  start: "plan",
  nodes: [
    {
      id: "plan",
      kind: "script",
      run: "./scripts/plan.ts",
      inputs: {},
      outputArtifact: "researchPlan",
      onSuccess: "score",
    },
    {
      id: "score",
      kind: "script",
      run: "./scripts/score.ts",
      inputs: { researchPlan: { artifact: "researchPlan" } },
      outputArtifact: "scorecard",
      onSuccess: "completed",
    },
  ],
};

function requireNode<T>(nodes: readonly T[], index: number): T {
  const node = nodes[index];
  if (node === undefined) {
    throw new Error(`Missing node at index ${index}`);
  }
  return node;
}

describe("stableJsonStringify", () => {
  test("sorts object keys recursively while preserving array order", () => {
    expect(stableJsonStringify({ b: 1, a: { d: 4, c: 3 }, e: [2, 1] })).toBe(
      '{"a":{"c":3,"d":4},"b":1,"e":[2,1]}'
    );
  });
});

describe("hashPlaybookGraph", () => {
  test("returns the same hash for semantically identical object key order", () => {
    const left = hashPlaybookGraph(graph);
    const right = hashPlaybookGraph({
      name: "SEO Blog Article",
      version: "0.1.0",
      id: "content.seo-blog",
      schemaVersion: 1,
      start: "plan",
      artifacts: {
        scorecard: { schema: "./schemas/scorecard.schema.json" },
        researchPlan: { schema: "./schemas/research-plan.schema.json" },
      },
      nodes: graph.nodes,
    });

    expect(left).toBe(right);
    expect(left.startsWith("sha256:")).toBe(true);
  });
});

describe("hashPlaybookSourceFiles", () => {
  test("hashes package-relative file names and content deterministically", () => {
    const a = hashPlaybookSourceFiles({
      "playbook.ts": "export default {};\n",
      "scripts/score.ts": "export default function score() {}\n",
    });
    const b = hashPlaybookSourceFiles({
      "scripts/score.ts": "export default function score() {}\n",
      "playbook.ts": "export default {};\n",
    });

    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });
});

describe("validatePlaybookGraph", () => {
  test("returns a parsed graph when references are valid", () => {
    expect(validatePlaybookGraph(graph).id).toBe("content.seo-blog");
  });

  test("rejects an unknown start node", () => {
    expect(() => validatePlaybookGraph({ ...graph, start: "missing" })).toThrow(/start node/);
  });

  test("rejects duplicate node ids", () => {
    const firstNode = requireNode(graph.nodes, 0);

    expect(() =>
      validatePlaybookGraph({
        ...graph,
        nodes: [firstNode, firstNode],
      })
    ).toThrow(/Duplicate node id/);
  });

  test("rejects transitions to unknown nodes", () => {
    const firstNode = requireNode(graph.nodes, 0);

    expect(() =>
      validatePlaybookGraph({
        ...graph,
        nodes: [{ ...firstNode, onSuccess: "ghost" }],
      })
    ).toThrow(/Unknown transition/);
  });

  test("rejects output artifacts not declared by the graph", () => {
    const firstNode = requireNode(graph.nodes, 0);

    expect(() =>
      validatePlaybookGraph({
        ...graph,
        nodes: [{ ...firstNode, onSuccess: "completed", outputArtifact: "ghost" }],
      })
    ).toThrow(/Unknown artifact/);
  });

  test("rejects agent outputs whose schema conflicts with the declared artifact schema", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        start: "review",
        nodes: [
          {
            id: "review",
            kind: "agent",
            prompt: "./prompts/review.md",
            inputs: {},
            tools: [],
            output: {
              artifact: "scorecard",
              schema: "./schemas/other-scorecard.schema.json",
            },
            onSuccess: "completed",
          },
        ],
      })
    ).toThrow(/Agent output schema mismatch/);
  });

  test("rejects consumed artifacts that are not declared by the graph", () => {
    const secondNode = requireNode(graph.nodes, 1);

    expect(() =>
      validatePlaybookGraph({
        ...graph,
        start: "score",
        nodes: [{ ...secondNode, inputs: { researchPlan: { artifact: "ghost" } } }],
      })
    ).toThrow(/Unknown artifact/);
  });

  test("validates branch subgraphs inside parallelMap nodes", () => {
    const branchNode = {
      id: "mapResearch",
      kind: "parallelMap",
      items: { artifact: "researchPlan", path: "$.items" },
      outputArtifact: "researchPlan",
      onSuccess: "score",
      branch: {
        start: "branchStep",
        nodes: [
          {
            id: "branchStep",
            kind: "script",
            run: "./scripts/branch.ts",
            inputs: { researchPlan: { artifact: "ghost" } },
            onSuccess: "completed",
          },
        ],
      },
    } as const;

    expect(() =>
      validatePlaybookGraph({
        ...graph,
        start: "mapResearch",
        nodes: [branchNode, requireNode(graph.nodes, 1)],
      })
    ).toThrow(/Unknown artifact/);
  });
});
