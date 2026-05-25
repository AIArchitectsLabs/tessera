import { describe, expect, test } from "bun:test";
import type { CompiledPlaybookGraph, WorkflowCapabilityInventory } from "@tessera/contracts";
import { resolvePlaybookGraphPreflight } from "./playbook-graph-preflight";

const compiledGraph: CompiledPlaybookGraph = {
  graph: {
    schemaVersion: 1,
    id: "test.preflight",
    version: "1",
    name: "Preflight Test",
    metadata: {
      requiredCapabilities: ["tool.workspace.write"],
    },
    artifacts: {
      brief: { schema: "schemas/brief.schema.json" },
    },
    inputs: {},
    capabilities: ["web", "tool.workspace.write"],
    limits: {},
    start: "draftBrief",
    nodes: [
      {
        id: "draftBrief",
        label: "Draft brief",
        kind: "agent",
        prompt: "prompts/draft.md",
        inputs: {},
        tools: [],
        output: { artifact: "brief", schema: "schemas/brief.schema.json" },
        onSuccess: "writeBrief",
      },
      {
        id: "writeBrief",
        label: "Write brief",
        kind: "effect",
        effectId: "workspace.write",
        capability: "tool.workspace.write",
        adapterId: "workspace",
        sideEffect: "write",
        approval: "required",
        idempotency: "required",
        idempotencyKey: "workspace.write:test",
        input: {
          sourceArtifact: "brief",
          value: { artifact: "brief" },
          path: "brief.md",
        },
        preview: {
          schemaVersion: 1,
          title: "Write brief",
          summary: "Write the brief.",
        },
      },
    ],
  },
  metadata: {
    schemaVersion: 1,
    playbookId: "test.preflight",
    packageVersion: "1",
    compilerVersion: "test",
    graphSchemaVersion: 1,
    scriptSdkVersion: "test",
    sourceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    graphHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    compiledAt: "2026-05-25T00:00:00.000Z",
  },
};

const inventory: WorkflowCapabilityInventory = {
  fingerprint: "inventory-1",
  agents: [
    {
      id: "default",
      label: "Tessera",
      fingerprint: "agent-1",
      modelCapabilities: ["model.reasoning"],
      dataPolicies: ["cloud-ok"],
      skillCapabilities: [],
      toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
    },
    {
      id: "analyst",
      label: "Analyst",
      fingerprint: "agent-2",
      modelCapabilities: ["model.reasoning"],
      dataPolicies: ["cloud-ok"],
      skillCapabilities: [],
      toolCapabilities: ["tool.workspace.read"],
    },
  ],
  models: [
    {
      provider: "openai",
      model: "gpt-5.4",
      hasCredential: true,
      capabilities: ["model.reasoning"],
      dataPolicy: "cloud-ok",
    },
  ],
  skills: [],
  tools: [
    { id: "tool.workspace.read", label: "Read workspace" },
    { id: "tool.workspace.write", label: "Write workspace" },
  ],
  integrations: [
    {
      id: "integration.duckduckgo",
      label: "DuckDuckGo",
      fingerprint: "search-1",
      configured: true,
      capabilities: ["integration.search.read"],
      dataPolicies: ["workspace-local-ok"],
    },
  ],
};

describe("resolvePlaybookGraphPreflight", () => {
  test("returns an assignment preview from the capability inventory", () => {
    const preview = resolvePlaybookGraphPreflight({
      compiledGraph,
      capabilityInventory: inventory,
      now: new Date("2026-05-25T00:00:00.000Z"),
    });

    expect(preview.confirmationRequired).toBe(false);
    expect(preview.blockers).toEqual([]);
    expect(preview.sourceGaps).toEqual([]);
    expect(preview.assignmentPlan?.resolverVersion).toBe(2);
    expect(preview.assignmentPlan?.assignments.draftBrief?.agentId).toBe("default");
    expect(preview.nodePreviews[0]).toMatchObject({
      stepId: "draftBrief",
      stepLabel: "Draft brief",
      recommendedAgentId: "default",
      recommendedAgentLabel: "Tessera",
    });
  });

  test("reuses a still-available previous assignment recommendation", () => {
    const preview = resolvePlaybookGraphPreflight({
      compiledGraph,
      capabilityInventory: inventory,
      previousPlan: {
        resolverVersion: 1,
        createdAt: "2026-05-24T00:00:00.000Z",
        assignments: {
          draftBrief: {
            stepId: "draftBrief",
            agentId: "analyst",
            agentLabel: "Analyst",
            agentFingerprint: "agent-2",
            skillCapabilities: [],
            toolCapabilities: ["tool.workspace.read"],
            integrationCapabilities: [],
          },
        },
      },
    });

    expect(preview.assignmentPlan?.assignments.draftBrief?.agentId).toBe("analyst");
    expect(preview.nodePreviews[0]?.recommendedAgentId).toBe("analyst");
  });

  test("blocks required capabilities and reports optional source gaps", () => {
    const preview = resolvePlaybookGraphPreflight({
      compiledGraph,
      capabilityInventory: {
        ...inventory,
        tools: [{ id: "tool.workspace.read", label: "Read workspace" }],
        agents: [],
        integrations: [],
      },
    });

    expect(preview.confirmationRequired).toBe(true);
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "tool.workspace.write",
          optional: false,
        }),
        expect.objectContaining({
          capability: "model.reasoning",
          optional: false,
        }),
      ])
    );
    expect(preview.sourceGaps).toEqual([
      expect.objectContaining({
        capability: "web",
        optional: true,
      }),
    ]);
  });

  test("blocks required capabilities when inventory is unavailable", () => {
    const preview = resolvePlaybookGraphPreflight({ compiledGraph });

    expect(preview.confirmationRequired).toBe(true);
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "tool.workspace.write",
          optional: false,
        }),
      ])
    );
    expect(preview.sourceGaps).toEqual([
      expect.objectContaining({
        capability: "web",
        optional: true,
      }),
    ]);
  });
});
