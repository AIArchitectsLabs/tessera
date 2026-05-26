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

  test("validates typed human review action targets and output artifacts", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        artifacts: {
          ...graph.artifacts,
          feedback: { schema: "./schemas/feedback.schema.json" },
        },
        start: "review",
        nodes: [
          {
            id: "review",
            kind: "humanReview",
            artifact: "scorecard",
            actions: [
              {
                id: "requestRework",
                decision: "request_changes",
                target: "revise",
                outputArtifact: "feedback",
                payloadFields: [{ path: "notes", label: "Feedback", kind: "string" }],
              },
            ],
          },
          {
            id: "revise",
            kind: "script",
            run: "./scripts/score.ts",
            inputs: { feedback: { artifact: "feedback" } },
            outputArtifact: "scorecard",
            onSuccess: "completed",
          },
        ],
      })
    ).not.toThrow();

    expect(() =>
      validatePlaybookGraph({
        ...graph,
        start: "review",
        nodes: [
          {
            id: "review",
            kind: "humanReview",
            artifact: "scorecard",
            actions: [
              {
                id: "requestRework",
                decision: "request_changes",
                target: "missing",
                outputArtifact: "missingFeedback",
              },
            ],
          },
        ],
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

  test("rejects tool nodes that use undeclared capabilities", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        capabilities: ["web.search"],
        start: "search",
        nodes: [
          {
            id: "search",
            kind: "tool",
            capability: "web.fetch",
            args: {},
            outputArtifact: "researchPlan",
            onSuccess: "completed",
          },
        ],
      })
    ).toThrow(/Undeclared capability/);
  });

  test("rejects effect nodes that use undeclared capabilities", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        capabilities: ["web.search"],
        start: "write",
        nodes: [
          {
            id: "write",
            kind: "effect",
            effectId: "workspace.write",
            capability: "tool.workspace.write",
            adapterId: "workspace",
            sideEffect: "write",
            approval: "required",
            idempotency: "required",
            idempotencyKey: "workspace.write:test",
            input: {
              value: { artifact: "scorecard" },
              target: {
                kind: "workspace",
                path: "scorecard.md",
                format: "markdown",
              },
            },
            preview: {
              schemaVersion: 1,
              title: "Write scorecard",
              summary: "Write the scorecard to the workspace.",
            },
            onSuccess: "completed",
          },
        ],
      })
    ).toThrow(/Undeclared capability/);
  });

  test("rejects effect targets that do not match the side-effect class", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        capabilities: ["tool.workspace.write"],
        start: "write",
        nodes: [
          {
            id: "write",
            kind: "effect",
            effectId: "workspace.write",
            capability: "tool.workspace.write",
            adapterId: "workspace",
            sideEffect: "external",
            approval: "required",
            idempotency: "required",
            idempotencyKey: "workspace.write:test",
            input: {
              value: { artifact: "scorecard" },
              target: {
                kind: "workspace",
                path: "scorecard.md",
                format: "markdown",
              },
            },
            preview: {
              schemaVersion: 1,
              title: "Write scorecard",
              summary: "Write the scorecard to the workspace.",
            },
            onSuccess: "completed",
          },
        ],
      })
    ).toThrow(/requires a write effect/);

    expect(() =>
      validatePlaybookGraph({
        ...graph,
        capabilities: ["integration.drive.write"],
        start: "publish",
        nodes: [
          {
            id: "publish",
            kind: "effect",
            effectId: "drive.publish",
            capability: "integration.drive.write",
            adapterId: "drive",
            sideEffect: "write",
            approval: "required",
            idempotency: "required",
            idempotencyKey: "drive.publish:test",
            input: {
              value: { artifact: "scorecard" },
              target: {
                kind: "external",
                reference: "gdrive://scorecard",
              },
            },
            preview: {
              schemaVersion: 1,
              title: "Publish scorecard",
              summary: "Publish the scorecard externally.",
            },
            onSuccess: "completed",
          },
        ],
      })
    ).toThrow(/requires an external effect/);
  });

  test("rejects agent tool use that is missing from graph capabilities", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        capabilities: ["web.search"],
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "./prompts/draft.md",
            inputs: {},
            tools: ["gmail.search"],
            output: {
              artifact: "scorecard",
              schema: "./schemas/scorecard.schema.json",
            },
            onSuccess: "completed",
          },
        ],
      })
    ).toThrow(/Undeclared agent tool/);
  });

  test("accepts declared tool and agent capability use", () => {
    const parsed = validatePlaybookGraph({
      ...graph,
      capabilities: ["web.search", "gmail.search"],
      start: "search",
      nodes: [
        {
          id: "search",
          kind: "tool",
          capability: "web.search",
          args: {},
          outputArtifact: "researchPlan",
          onSuccess: "draft",
        },
        {
          id: "draft",
          kind: "agent",
          prompt: "./prompts/draft.md",
          inputs: {
            researchPlan: { artifact: "researchPlan" },
          },
          tools: ["gmail.search"],
          output: {
            artifact: "scorecard",
            schema: "./schemas/scorecard.schema.json",
          },
          onSuccess: "completed",
        },
      ],
    });

    expect(parsed.capabilities).toEqual(["web.search", "gmail.search"]);
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

describe("artifactWrite capability rule", () => {
  const artifactWriteGraph = (capabilities: string[]) => ({
    schemaVersion: 1,
    id: "ops.write-check",
    version: "1",
    name: "Write check",
    artifacts: { doc: { schema: "./schemas/doc.schema.json" } },
    capabilities,
    limits: {},
    start: "persist",
    nodes: [
      {
        id: "persist",
        kind: "artifactWrite",
        artifact: "doc",
        path: "out/doc.md",
        onSuccess: "completed",
      },
    ],
  });

  test("rejects artifactWrite without tool.workspace.write", () => {
    expect(() => validatePlaybookGraph(artifactWriteGraph([]))).toThrow(
      /requires the tool\.workspace\.write capability/
    );
  });

  test("accepts artifactWrite when tool.workspace.write is declared", () => {
    expect(() =>
      validatePlaybookGraph(artifactWriteGraph(["tool.workspace.write"]))
    ).not.toThrow();
  });
});
