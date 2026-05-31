import { describe, expect, test } from "bun:test";
import {
  EffectExecutionRecordSchema,
  PlaybookGraphArtifactPathRefSchema,
  PlaybookGraphCompileMetadataSchema,
  PlaybookGraphEffectInputSchema,
  PlaybookGraphEffectOutputSchema,
  PlaybookGraphEffectTargetSchema,
  PlaybookGraphMaterializationFormatSchema,
  PlaybookGraphNodeIdSchema,
  PlaybookGraphSchema,
  PlaybookGraphSourceRefSchema,
  canonicalCapability,
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

  test("accepts typed humanReview actions with payload fields and feedback artifacts", () => {
    const graph = PlaybookGraphSchema.parse({
      ...validGraph,
      artifacts: {
        ...validGraph.artifacts,
        briefFeedback: { schema: "./schemas/brief-feedback.schema.json" },
      },
      nodes: [
        ...validGraph.nodes.slice(0, -1),
        {
          id: "approveBrief",
          kind: "humanReview",
          artifact: "brief",
          actions: [
            {
              id: "approveBrief",
              decision: "approve",
              label: "Approve brief",
              target: "completed",
            },
            {
              id: "requestBriefRework",
              decision: "request_changes",
              label: "Send back for rework",
              target: "scoreBrief",
              tone: "secondary",
              outputArtifact: "briefFeedback",
              payloadFields: [{ path: "notes", label: "Feedback", kind: "string" }],
            },
          ],
        },
      ],
    });

    const review = graph.nodes.find((node) => node.id === "approveBrief");
    expect(review?.kind).toBe("humanReview");
    if (review?.kind !== "humanReview") throw new Error("Expected human review node");
    const reworkAction = review.actions.find(
      (action) => typeof action !== "string" && action.id === "requestBriefRework"
    );
    expect(reworkAction).toMatchObject({
      decision: "request_changes",
      outputArtifact: "briefFeedback",
      payloadFields: [{ path: "notes", label: "Feedback", kind: "string", required: true }],
    });
  });

  test("accepts planned tool, condition, effect, and artifactWrite nodes", () => {
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
    const effectGraph = PlaybookGraphSchema.parse({
      schemaVersion: 1,
      id: "demo.effect-graph",
      version: "0.1.0",
      name: "Effect Graph",
      capabilities: ["tool.workspace.write"],
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
          idempotencyKey: "workspace.write:demo",
          input: {
            sourceArtifact: "brief",
            value: { artifact: "brief" },
            target: {
              kind: "workspace",
              path: "brief.pdf",
              format: "pdf",
            },
          },
          preview: {
            schemaVersion: 1,
            title: "Write brief",
            summary: "Write the brief to the workspace.",
          },
        },
      ],
    });

    expect(toolGraph.nodes[0]?.kind).toBe("tool");
    expect(conditionGraph.nodes[0]?.kind).toBe("condition");
    expect(effectGraph.nodes[0]?.kind).toBe("effect");
    expect(artifactWriteGraph.nodes[0]?.kind).toBe("artifactWrite");
    if (effectGraph.nodes[0]?.kind !== "effect") throw new Error("Expected effect node");
    expect(effectGraph.nodes[0].input.target).toEqual({
      kind: "workspace",
      path: "brief.pdf",
      format: "pdf",
    });
  });

  test("accepts supported effect materialization targets and outputs including pdf", () => {
    expect(PlaybookGraphMaterializationFormatSchema.options).toEqual([
      "markdown",
      "json",
      "csv",
      "pdf",
    ]);

    for (const format of PlaybookGraphMaterializationFormatSchema.options) {
      expect(PlaybookGraphEffectInputSchema.parse({ format })).toEqual({ format });
      expect(
        PlaybookGraphEffectTargetSchema.parse({
          kind: "workspace",
          path: `out/report.${format === "markdown" ? "md" : format}`,
          format,
        })
      ).toMatchObject({ kind: "workspace", format });
      expect(
        PlaybookGraphEffectOutputSchema.parse({
          kind: "workspace",
          path: `out/report.${format === "markdown" ? "md" : format}`,
          format,
          bytes: 42,
        })
      ).toMatchObject({ kind: "workspace", format, bytes: 42 });
    }

    expect(
      PlaybookGraphEffectTargetSchema.parse({
        kind: "external",
        reference: "gdrive://docs/report",
        connectorId: "google-drive",
        label: "Report",
      })
    ).toMatchObject({ kind: "external", reference: "gdrive://docs/report" });
    expect(
      PlaybookGraphEffectOutputSchema.parse({
        kind: "external",
        reference: "gdrive://docs/report",
      })
    ).toMatchObject({ kind: "external", reference: "gdrive://docs/report" });
  });

  test("rejects unsupported effect materialization formats", () => {
    expect(() => PlaybookGraphEffectInputSchema.parse({ format: "xlsx" })).toThrow(
      /markdown, json, csv, or pdf/
    );
    expect(() =>
      PlaybookGraphEffectInputSchema.parse({
        target: { kind: "workspace", path: "../brief.md", format: "markdown" },
      })
    ).toThrow(/workspace target or external output reference/);

    expect(() =>
      PlaybookGraphSchema.parse({
        schemaVersion: 1,
        id: "demo.invalid-format-graph",
        version: "0.1.0",
        name: "Invalid Format Graph",
        capabilities: ["tool.workspace.write"],
        start: "write",
        nodes: [
          {
            id: "write",
            kind: "effect",
            effectId: "workspace.write",
            capability: "tool.workspace.write",
            adapterId: "workspace",
            sideEffect: "write",
            input: {
              target: {
                kind: "workspace",
                path: "brief.xlsx",
                format: "xlsx",
              },
            },
          },
        ],
      })
    ).toThrow(/workspace target or external output reference/);
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

describe("EffectExecutionRecordSchema", () => {
  test("accepts a durable commit intent before adapter execution", () => {
    const record = EffectExecutionRecordSchema.parse({
      schemaVersion: 1,
      effectExecutionRecordId: "queue-1:effect:commit-requested",
      runId: "run-1",
      queueEntryId: "queue-1",
      nodeId: "write",
      nodePath: "write",
      effectId: "workspace.write",
      capability: "tool.workspace.write",
      adapterId: "workspace",
      sideEffect: "write",
      status: "commit_requested",
      idempotencyKey: "workspace.write:demo:input:hash",
      preview: {
        schemaVersion: 1,
        title: "Write brief",
        summary: "Write the brief to the workspace.",
      },
      commitStatus: "not_attempted",
      output: {
        kind: "workspace",
        path: "out/brief.pdf",
        format: "pdf",
        bytes: 1024,
      },
      createdAt: "2026-05-25T00:00:00.000Z",
    });

    expect(record.completedAt).toBeUndefined();
    expect(record.output).toMatchObject({ kind: "workspace", format: "pdf" });
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

describe("canonical integration capabilities", () => {
  test.each([
    ["integration.web.search", "web.search"],
    ["integration.web.fetch", "web.fetch"],
    ["integration.mail.messages.read", "mail.messages.read"],
    ["integration.mail.drafts.write", "mail.drafts.write"],
    ["integration.drive.files.read", "drive.files.read"],
    ["integration.contacts.read", "contacts.read"],
    ["integration.sheets.rows.write", "sheets.rows.write"],
    ["integration.docs.documents.write", "docs.documents.write"],
  ])("registers %s (alias %s)", (id, alias) => {
    expect(canonicalCapability(id)?.id).toBe(id);
    expect(canonicalCapability(alias)?.id).toBe(id);
  });
});
