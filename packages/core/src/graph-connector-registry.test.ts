import { describe, expect, test } from "bun:test";
import { buildConnectorRegistry } from "./graph-connector-registry.js";
import type { GraphConnector } from "./graph-connector.js";

interface Ctx {
  marker: string;
}

function workspaceConnector(): GraphConnector<Ctx> {
  return {
    adapterId: "workspace",
    label: "Workspace",
    effects: [
      {
        effectId: "workspace.write",
        capability: "tool.workspace.write",
        sideEffect: "write",
        idempotent: true,
        previewRequired: true,
        approvalRequired: true,
        handler: (input, ctx) => ({ outputReference: `${ctx.marker}:${input.node.effectId}` }),
      },
    ],
    tools: [],
    artifactWrite: {
      capability: "tool.workspace.write",
      handler: (_input, ctx) => ({ wrote: ctx.marker }),
    },
  };
}

function webConnector(): GraphConnector<Ctx> {
  return {
    adapterId: "web",
    label: "Web",
    effects: [],
    tools: [
      {
        capability: "integration.web.search",
        sideEffect: "read",
        idempotent: true,
        shellAllowlist: [{ command: "web-search", subcommand: "search" }],
      },
    ],
  };
}

const ctx: Ctx = { marker: "ctx" };

describe("buildConnectorRegistry", () => {
  test("routes effects by adapterId:effectId", async () => {
    const registry = buildConnectorRegistry({
      connectors: [workspaceConnector()],
      ctx,
      shellToolAdapter: async () => ({}),
    });
    const result = await registry.effectAdapter({
      node: { adapterId: "workspace", effectId: "workspace.write" },
    } as never);
    expect(result).toEqual({ outputReference: "ctx:workspace.write" });
  });

  test("throws on unknown effect", async () => {
    const registry = buildConnectorRegistry({
      connectors: [workspaceConnector()],
      ctx,
      shellToolAdapter: async () => ({}),
    });
    await expect(
      registry.effectAdapter({ node: { adapterId: "slack", effectId: "post" } } as never)
    ).rejects.toThrow("Unsupported effect adapter: slack:post");
  });

  test("routes shell-only tools to the injected shell adapter", async () => {
    let called = false;
    const registry = buildConnectorRegistry({
      connectors: [webConnector()],
      ctx,
      shellToolAdapter: async () => {
        called = true;
        return { ok: true };
      },
    });
    const result = await registry.toolAdapter({
      node: { capability: "integration.web.search" },
    } as never);
    expect(called).toBe(true);
    expect(result).toEqual({ ok: true });
  });

  test("derives policies, allowlist, and capabilities", () => {
    const registry = buildConnectorRegistry({
      connectors: [workspaceConnector(), webConnector()],
      ctx,
      shellToolAdapter: async () => ({}),
    });
    expect(registry.effectPolicies["workspace:workspace.write"]).toEqual({
      effectId: "workspace.write",
      capability: "tool.workspace.write",
      adapterId: "workspace",
      idempotent: true,
      sideEffect: "write",
      previewRequired: true,
      approvalRequired: true,
    });
    expect(registry.toolPolicies["integration.web.search"]).toEqual({
      capability: "integration.web.search",
      idempotent: true,
      sideEffect: "read",
    });
    expect(registry.shellAllowlist["integration.web.search"]).toEqual([
      { command: "web-search", subcommand: "search" },
    ]);
    expect(registry.capabilities.sort()).toEqual(
      ["integration.web.search", "tool.workspace.write"].sort()
    );
  });

  test("artifactWriteAdapter routes to the declaring connector", async () => {
    const registry = buildConnectorRegistry({
      connectors: [workspaceConnector()],
      ctx,
      shellToolAdapter: async () => ({}),
    });
    expect(await registry.artifactWriteAdapter({} as never)).toEqual({ wrote: "ctx" });
  });

  test("rejects duplicate effect keys", () => {
    expect(() =>
      buildConnectorRegistry({
        connectors: [workspaceConnector(), workspaceConnector()],
        ctx,
        shellToolAdapter: async () => ({}),
      })
    ).toThrow("Duplicate connector effect: workspace:workspace.write");
  });

  test("rejects more than one artifactWrite connector", () => {
    expect(() =>
      buildConnectorRegistry({
        connectors: [
          workspaceConnector(),
          { ...workspaceConnector(), adapterId: "workspace2", effects: [] },
        ],
        ctx,
        shellToolAdapter: async () => ({}),
      })
    ).toThrow(/Multiple connectors declare artifactWrite/);
  });

  test("rejects non-canonical capabilities", () => {
    const bad = webConnector();
    const tool = bad.tools[0];
    if (!tool) throw new Error("expected test connector tool");
    tool.capability = "integration.not.real";
    expect(() =>
      buildConnectorRegistry({ connectors: [bad], ctx, shellToolAdapter: async () => ({}) })
    ).toThrow("references unknown capability: integration.not.real");
  });

  test("rejects approval-required effect without preview", () => {
    const bad = workspaceConnector();
    const effect = bad.effects[0];
    if (!effect) throw new Error("expected test connector effect");
    effect.previewRequired = false;
    expect(() =>
      buildConnectorRegistry({ connectors: [bad], ctx, shellToolAdapter: async () => ({}) })
    ).toThrow(/requires approval but not preview/);
  });

  test("rejects duplicate tool capability across connectors", () => {
    const dup = webConnector();
    dup.adapterId = "web2";
    expect(() =>
      buildConnectorRegistry({
        connectors: [webConnector(), dup],
        ctx,
        shellToolAdapter: async () => ({}),
      })
    ).toThrow("Duplicate connector tool capability: integration.web.search");
  });

  test("rejects a tool with neither handler nor shellAllowlist", () => {
    const bad = webConnector();
    const tool = bad.tools[0];
    if (!tool) throw new Error("expected test connector tool");
    // biome-ignore lint/performance/noDelete: need to truly remove the optional property under exactOptionalPropertyTypes
    delete tool.shellAllowlist;
    expect(() =>
      buildConnectorRegistry({ connectors: [bad], ctx, shellToolAdapter: async () => ({}) })
    ).toThrow("has no handler and no shellAllowlist");
  });
});
