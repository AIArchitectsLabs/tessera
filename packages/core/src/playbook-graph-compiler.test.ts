import { describe, expect, test } from "bun:test";
import {
  type CompilePlaybookGraphOptions,
  compilePlaybookGraph,
} from "./playbook-graph-compiler.js";
import { hashPlaybookGraph, hashPlaybookSourceFiles } from "./playbook-graph.js";

const baseGraph = {
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

const expectedParsedGraph = {
  ...baseGraph,
  schemaVersion: 1 as const,
  inputs: {},
  capabilities: [],
  limits: {},
};

const baseOptions = {
  sourceFiles: {
    "playbook.ts": "export default {};\n",
    "scripts/score.ts": "export default function score() {}\n",
  },
  compilerVersion: "tessera-core-1.0.0",
  scriptSdkVersion: "tessera-sdk-1.0.0",
  compiledAt: "2026-01-01T00:00:00.000Z",
};

function compileGraph(
  options: Partial<CompilePlaybookGraphOptions> = {}
): ReturnType<typeof compilePlaybookGraph> {
  return compilePlaybookGraph({
    graph: options.graph ?? baseGraph,
    ...baseOptions,
    ...options,
  });
}

describe("compilePlaybookGraph", () => {
  test("returns parsed graph and compile metadata", () => {
    const result = compileGraph({
      graph: {
        nodes: baseGraph.nodes,
        version: baseGraph.version,
        name: baseGraph.name,
        id: baseGraph.id,
        start: baseGraph.start,
        schemaVersion: baseGraph.schemaVersion,
        artifacts: {
          scorecard: baseGraph.artifacts.scorecard,
          researchPlan: baseGraph.artifacts.researchPlan,
        },
      },
    });

    expect(result.graph).toEqual(expectedParsedGraph as typeof result.graph);
    expect(result.metadata).toEqual({
      schemaVersion: 1,
      playbookId: baseGraph.id,
      packageVersion: baseGraph.version,
      compilerVersion: baseOptions.compilerVersion,
      graphSchemaVersion: 1,
      scriptSdkVersion: baseOptions.scriptSdkVersion,
      sourceHash: hashPlaybookSourceFiles(baseOptions.sourceFiles),
      graphHash: hashPlaybookGraph(baseGraph),
      compiledAt: baseOptions.compiledAt,
    });
  });

  test("changes source hashes when only source content changes", () => {
    const first = compileGraph();
    const second = compileGraph({
      sourceFiles: {
        ...baseOptions.sourceFiles,
        "scripts/score.ts": "export default function score() { return 42; }\n",
      },
    });

    expect(second.metadata.sourceHash).not.toBe(first.metadata.sourceHash);
    expect(second.metadata.graphHash).toBe(first.metadata.graphHash);
  });

  test("changes graph hashes when only graph content changes", () => {
    const first = compileGraph();
    const second = compileGraph({
      graph: {
        ...baseGraph,
        version: "0.1.1",
      },
    });

    expect(second.metadata.graphHash).not.toBe(first.metadata.graphHash);
    expect(second.metadata.sourceHash).toBe(first.metadata.sourceHash);
  });
});
