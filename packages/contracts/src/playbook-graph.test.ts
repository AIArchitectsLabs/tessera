import { describe, expect, test } from "bun:test";
import {
  PlaybookGraphArtifactPathRefSchema,
  PlaybookGraphCompileMetadataSchema,
  PlaybookGraphNodeIdSchema,
  PlaybookGraphSchema,
  PlaybookGraphSourceRefSchema,
} from "./index.js";

const validGraph = {
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "0.1.0",
  name: "SEO Blog Article",
  inputs: {
    focusKeywords: {
      type: "string[]",
      required: true,
      label: "Focus keywords",
      ui: { control: "multiselect" },
    },
  },
  artifacts: {
    researchPlan: { schema: "./schemas/research-plan.schema.json" },
    brief: { schema: "./schemas/content-brief.schema.json", materialize: "brief.md" },
    briefScorecard: { schema: "./schemas/brief-scorecard.schema.json" },
  },
  capabilities: ["web.search", "web.fetch"],
  limits: {
    maxGeneratedItems: 30,
    maxConcurrentBranches: 6,
    maxTotalBranches: 30,
    maxTotalAgentSteps: 60,
    maxRuntimeMs: 30 * 60 * 1000,
    maxTokens: 2_000_000,
    maxExternalToolCalls: 120,
    maxFetches: 80,
  },
  start: "buildResearchPlan",
  nodes: [
    {
      id: "buildResearchPlan",
      kind: "script",
      run: "./scripts/build-research-plan.ts",
      inputs: {},
      outputArtifact: "researchPlan",
      onSuccess: "research",
    },
    {
      id: "research",
      kind: "parallelMap",
      items: { artifact: "researchPlan", path: "$.workItems" },
      branch: {
        start: "researchOne",
        nodes: [
          {
            id: "researchOne",
            kind: "agent",
            prompt: "./prompts/research-serp.md",
            inputs: { item: { ref: "branch.item" } },
            tools: ["web.search", "web.fetch"],
            output: { schema: "./schemas/research-item.schema.json" },
            onSuccess: "completed",
          },
        ],
      },
      outputArtifact: "brief",
      onSuccess: "scoreBrief",
    },
    {
      id: "scoreBrief",
      kind: "script",
      run: "./scripts/score-brief.ts",
      inputs: { brief: { artifact: "brief" } },
      outputArtifact: "briefScorecard",
      onSuccess: "approveBrief",
    },
    {
      id: "approveBrief",
      kind: "humanReview",
      artifact: "brief",
      actions: ["approve", "requestChanges", "editArtifact"],
      onApprove: "completed",
      onRequestChanges: "scoreBrief",
    },
  ],
};

describe("PlaybookGraphSchema", () => {
  test("accepts a normalized graph with script, parallelMap, agent, and humanReview nodes", () => {
    const graph = PlaybookGraphSchema.parse(validGraph);
    expect(graph.id).toBe("content.seo-blog");
    expect(graph.nodes).toHaveLength(4);
    expect(graph.artifacts.brief?.materialize).toBe("brief.md");
  });

  test("accepts planned tool, condition, and artifactWrite nodes", () => {
    const toolGraph = PlaybookGraphSchema.parse({
      schemaVersion: 1,
      id: "demo.tool-graph",
      version: "0.1.0",
      name: "Tool Graph",
      start: "toolStep",
      nodes: [
        {
          id: "toolStep",
          kind: "tool",
          capability: "web.search",
          args: { query: "playbooks" },
        },
      ],
    });

    const conditionGraph = PlaybookGraphSchema.parse({
      schemaVersion: 1,
      id: "demo.condition-graph",
      version: "0.1.0",
      name: "Condition Graph",
      start: "branch",
      nodes: [
        {
          id: "branch",
          kind: "condition",
          when: { artifact: "brief", path: "$.ready", equals: true },
          onTrue: "artifactWrite",
          onFalse: "artifactWrite",
        },
      ],
    });

    const artifactWriteGraph = PlaybookGraphSchema.parse({
      schemaVersion: 1,
      id: "demo.artifact-write-graph",
      version: "0.1.0",
      name: "Artifact Write Graph",
      start: "write",
      nodes: [
        {
          id: "write",
          kind: "artifactWrite",
          artifact: "brief",
          path: "./output/brief.md",
        },
      ],
    });

    expect(toolGraph.nodes[0]?.kind).toBe("tool");
    expect(conditionGraph.nodes[0]?.kind).toBe("condition");
    expect(artifactWriteGraph.nodes[0]?.kind).toBe("artifactWrite");
  });

  test("defaults optional graph collections", () => {
    const graph = PlaybookGraphSchema.parse({
      schemaVersion: 1,
      id: "demo.graph",
      version: "0.1.0",
      name: "Demo Graph",
      start: "noop",
      nodes: [{ id: "noop", kind: "join", inputs: [], onSuccess: "completed" }],
    });

    expect(graph.inputs).toEqual({});
    expect(graph.artifacts).toEqual({});
    expect(graph.capabilities).toEqual([]);
  });

  test("rejects node ids that cannot be used as durable queue path segments", () => {
    for (const id of ["unsafe id", "unsafe/id", ".", ".."]) {
      expect(() => PlaybookGraphNodeIdSchema.parse(id)).toThrow(/Graph node ids/);
      expect(() =>
        PlaybookGraphSchema.parse({
          ...validGraph,
          start: id,
          nodes: [{ id, kind: "join", inputs: [], onSuccess: "completed" }],
        })
      ).toThrow(/Graph node ids/);
    }
  });

  test("defaults artifact path refs to the graph root", () => {
    const ref = PlaybookGraphArtifactPathRefSchema.parse({ artifact: "researchPlan" });

    expect(ref.path).toBe("$");
  });

  test("rejects output paths that escape the package or are absolute", () => {
    const invalidPaths = [
      "../outside.md",
      "/tmp/out.md",
      "C:\\temp\\out.md",
      "\\\\server\\share\\out.md",
    ];

    for (const materialize of invalidPaths) {
      expect(() =>
        PlaybookGraphSchema.parse({
          ...validGraph,
          artifacts: {
            ...validGraph.artifacts,
            brief: { schema: "./schemas/content-brief.schema.json", materialize },
          },
        })
      ).toThrow(/Output paths/);
    }

    for (const path of invalidPaths) {
      expect(() =>
        PlaybookGraphSchema.parse({
          ...validGraph,
          nodes: [
            {
              id: "write",
              kind: "artifactWrite",
              artifact: "brief",
              path,
            },
          ],
        })
      ).toThrow(/Output paths/);
    }
  });

  test("rejects script paths that are not TypeScript in phase 1", () => {
    expect(() =>
      PlaybookGraphSchema.parse({
        ...validGraph,
        nodes: [
          {
            id: "score",
            kind: "script",
            run: "./scripts/score.py",
            outputArtifact: "briefScorecard",
          },
        ],
      })
    ).toThrow(/TypeScript/);
  });

  test("rejects source refs that escape the package", () => {
    expect(() => PlaybookGraphSourceRefSchema.parse("../outside.ts")).toThrow();
    expect(() => PlaybookGraphSourceRefSchema.parse("/tmp/outside.ts")).toThrow();
  });
});

describe("PlaybookGraphCompileMetadataSchema", () => {
  test("accepts compile metadata", () => {
    const metadata = PlaybookGraphCompileMetadataSchema.parse({
      schemaVersion: 1,
      playbookId: "content.seo-blog",
      packageVersion: "0.1.0",
      compilerVersion: "0.1.0",
      graphSchemaVersion: 1,
      scriptSdkVersion: "0.1.0",
      sourceHash: "sha256:source",
      graphHash: "sha256:graph",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });

    expect(metadata.graphHash).toBe("sha256:graph");
  });

  test("rejects metadata with an invalid playbook id when other fields are valid", () => {
    expect(() =>
      PlaybookGraphCompileMetadataSchema.parse({
        schemaVersion: 1,
        playbookId: "bad id",
        packageVersion: "0.1.0",
        compilerVersion: "0.1.0",
        graphSchemaVersion: 1,
        scriptSdkVersion: "0.1.0",
        sourceHash: "sha256:source",
        graphHash: "sha256:graph",
        compiledAt: "2026-05-15T00:00:00.000Z",
      })
    ).toThrow();
  });

  test("rejects metadata without a sha256-prefixed graph hash", () => {
    expect(() =>
      PlaybookGraphCompileMetadataSchema.parse({
        schemaVersion: 1,
        playbookId: "content.seo-blog",
        packageVersion: "0.1.0",
        compilerVersion: "0.1.0",
        graphSchemaVersion: 1,
        scriptSdkVersion: "0.1.0",
        sourceHash: "sha256:source",
        graphHash: "graph",
        compiledAt: "2026-05-15T00:00:00.000Z",
      })
    ).toThrow();
  });
});
