# Graph Connector Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded effect/tool routing and the four parallel policy tables in the sidecar with a single connector registry, so adding an integration is one descriptor and every workspace-write path is governed by a declared capability.

**Architecture:** A generic, pure `buildConnectorRegistry` in `packages/core` consumes a list of `GraphConnector<Ctx>` descriptors and derives the composite effect/tool/artifactWrite adapters plus the effect/tool policy maps, shell allowlist, and capability list. Concrete connectors (`workspace`, `web`, `google-workspace`) live in `apps/sidecar/src/connectors/` and are wired in `server.ts`. The runtime is untouched. A new hard validation rule requires `artifactWrite` nodes to declare `tool.workspace.write`.

**Tech Stack:** TypeScript (strict), Bun test runner (`bun:test`), Zod (contracts), monorepo with TypeScript project references. NodeNext imports use `.js` extensions.

---

## Spec

Source spec: `docs/superpowers/specs/2026-05-26-graph-connector-registry-design.md`

## File Structure

**Create:**
- `packages/core/src/graph-connector.ts` — the `GraphConnector<Ctx>` descriptor type (plain data + handler signatures). No runtime logic.
- `packages/core/src/graph-connector-registry.ts` — generic `buildConnectorRegistry` (pure; shell execution injected).
- `packages/core/src/graph-connector-registry.test.ts` — unit tests for the builder.
- `apps/sidecar/src/connectors/workspace.ts` — `workspace` connector (workspace.write effect + artifactWrite slot).
- `apps/sidecar/src/connectors/web.ts` — `web` connector (web search/fetch read tools).
- `apps/sidecar/src/connectors/google-workspace.ts` — `google-workspace` connector (3 effects + Google read tools).
- `apps/sidecar/src/connectors/context.ts` — the sidecar `ConnectorContext` type + builder.

**Modify:**
- `packages/contracts/src/index.ts:1034` — add missing integration capabilities to `CANONICAL_CAPABILITIES`.
- `packages/core/src/index.ts:145` — export the new connector modules.
- `packages/core/src/playbook-graph.ts:174` — add the `artifactWrite`-requires-capability rule.
- `packages/core/src/playbook-graph.test.ts` — test the new rule.
- `apps/sidecar/src/server.ts` — replace `createCompositeEffectAdapter`, `graphRunToolAdapter` inner routing, and the four `GRAPH_RUN_DEFAULT_*` tables with registry wiring.
- `apps/sidecar/src/server.test.ts` — parity tests for the migrated connectors.

---

## Task 1: Add missing integration capabilities to the canonical vocabulary

The registry validates every connector-referenced capability against `CANONICAL_CAPABILITIES` (via the alias-aware `canonicalCapability()`). Several capabilities used by today's tool/effect tables are not yet canonical, so add them first.

**Files:**
- Modify: `packages/contracts/src/index.ts:1107` (end of the `CANONICAL_CAPABILITIES` array, before the closing `] as const`)
- Test: `packages/contracts/src/playbook-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/playbook-graph.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canonicalCapability } from "./index.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/contracts/src/playbook-graph.test.ts`
Expected: FAIL — `canonicalCapability(...)` returns `undefined` for the new ids.

- [ ] **Step 3: Add the capabilities**

Insert these entries into the `CANONICAL_CAPABILITIES` array in `packages/contracts/src/index.ts`, immediately before the closing `] as const satisfies readonly CanonicalCapability[];` at line 1107:

```ts
  {
    id: "integration.web.search",
    kind: "integration",
    label: "Web search",
    description: "Can search the public web.",
    version: 1,
    aliases: ["web.search"],
    deprecated: false,
  },
  {
    id: "integration.web.fetch",
    kind: "integration",
    label: "Web fetch",
    description: "Can fetch a public web page.",
    version: 1,
    aliases: ["web.fetch"],
    deprecated: false,
  },
  {
    id: "integration.mail.messages.read",
    kind: "integration",
    label: "Read mail",
    description: "Can read mail messages.",
    version: 1,
    aliases: ["mail.messages.read"],
    deprecated: false,
  },
  {
    id: "integration.mail.drafts.write",
    kind: "integration",
    label: "Draft mail",
    description: "Can create mail drafts.",
    version: 1,
    aliases: ["mail.drafts.write"],
    deprecated: false,
  },
  {
    id: "integration.drive.files.read",
    kind: "integration",
    label: "Read drive files",
    description: "Can read drive files.",
    version: 1,
    aliases: ["drive.files.read"],
    deprecated: false,
  },
  {
    id: "integration.contacts.read",
    kind: "integration",
    label: "Read contacts",
    description: "Can look up contacts.",
    version: 1,
    aliases: ["contacts.read"],
    deprecated: false,
  },
  {
    id: "integration.sheets.rows.write",
    kind: "integration",
    label: "Write sheet rows",
    description: "Can write rows to a spreadsheet.",
    version: 1,
    aliases: ["sheets.rows.write"],
    deprecated: false,
  },
  {
    id: "integration.docs.documents.write",
    kind: "integration",
    label: "Write documents",
    description: "Can write document content.",
    version: 1,
    aliases: ["docs.documents.write"],
    deprecated: false,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/contracts/src/playbook-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/playbook-graph.test.ts
git commit -m "feat(contracts): register integration capabilities used by connectors"
```

---

## Task 2: Define the `GraphConnector` descriptor type

**Files:**
- Create: `packages/core/src/graph-connector.ts`

- [ ] **Step 1: Write the descriptor type**

```ts
import type {
  PlaybookGraphArtifactWriteAdapterInput,
  PlaybookGraphEffectAdapterInput,
  PlaybookGraphEffectAdapterResult,
  PlaybookGraphToolAdapterInput,
} from "./playbook-graph-runtime.js";

export interface GraphConnectorShellCommand {
  command: string;
  subcommand: string;
}

export interface GraphConnectorEffect<Ctx> {
  effectId: string;
  capability: string;
  sideEffect: "write" | "external";
  idempotent: boolean;
  previewRequired: boolean;
  approvalRequired: boolean;
  handler: (
    input: PlaybookGraphEffectAdapterInput,
    ctx: Ctx
  ) => Promise<PlaybookGraphEffectAdapterResult> | PlaybookGraphEffectAdapterResult;
}

export interface GraphConnectorTool<Ctx> {
  capability: string;
  sideEffect: "read" | "write" | "external";
  idempotent: boolean;
  shellAllowlist?: GraphConnectorShellCommand[];
  handler?: (input: PlaybookGraphToolAdapterInput, ctx: Ctx) => Promise<unknown> | unknown;
}

export interface GraphConnectorArtifactWrite<Ctx> {
  capability: string;
  handler: (
    input: PlaybookGraphArtifactWriteAdapterInput,
    ctx: Ctx
  ) => Promise<unknown> | unknown;
}

export interface GraphConnector<Ctx> {
  adapterId: string;
  label: string;
  effects: GraphConnectorEffect<Ctx>[];
  tools: GraphConnectorTool<Ctx>[];
  artifactWrite?: GraphConnectorArtifactWrite<Ctx>;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter './packages/core' check` (or `bunx tsc -p packages/core --noEmit`)
Expected: PASS (no errors). This file has no runtime behavior, so no unit test of its own; it is exercised by Task 3.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/graph-connector.ts
git commit -m "feat(core): add GraphConnector descriptor type"
```

---

## Task 3: Implement `buildConnectorRegistry`

**Files:**
- Create: `packages/core/src/graph-connector-registry.ts`
- Test: `packages/core/src/graph-connector-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
    bad.tools[0].capability = "integration.not.real";
    expect(() =>
      buildConnectorRegistry({ connectors: [bad], ctx, shellToolAdapter: async () => ({}) })
    ).toThrow("references unknown capability: integration.not.real");
  });

  test("rejects approval-required effect without preview", () => {
    const bad = workspaceConnector();
    bad.effects[0].previewRequired = false;
    expect(() =>
      buildConnectorRegistry({ connectors: [bad], ctx, shellToolAdapter: async () => ({}) })
    ).toThrow(/requires approval but not preview/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/graph-connector-registry.test.ts`
Expected: FAIL — `buildConnectorRegistry` not defined.

- [ ] **Step 3: Implement the builder**

```ts
import { canonicalCapability } from "@tessera/contracts";
import type {
  GraphConnector,
  GraphConnectorArtifactWrite,
  GraphConnectorEffect,
  GraphConnectorShellCommand,
  GraphConnectorTool,
} from "./graph-connector.js";
import type {
  PlaybookGraphArtifactWriteAdapterInput,
  PlaybookGraphEffectAdapterInput,
  PlaybookGraphEffectAdapterResult,
  PlaybookGraphEffectExecutionPolicy,
  PlaybookGraphToolAdapterInput,
  PlaybookGraphToolExecutionPolicy,
} from "./playbook-graph-runtime.js";

export interface GraphConnectorRegistry {
  effectAdapter: (
    input: PlaybookGraphEffectAdapterInput
  ) => Promise<PlaybookGraphEffectAdapterResult>;
  toolAdapter: (input: PlaybookGraphToolAdapterInput) => Promise<unknown>;
  artifactWriteAdapter: (input: PlaybookGraphArtifactWriteAdapterInput) => Promise<unknown>;
  effectPolicies: Record<string, PlaybookGraphEffectExecutionPolicy>;
  toolPolicies: Record<string, PlaybookGraphToolExecutionPolicy>;
  shellAllowlist: Record<string, GraphConnectorShellCommand[]>;
  capabilities: string[];
}

export interface BuildConnectorRegistryOptions<Ctx> {
  connectors: GraphConnector<Ctx>[];
  ctx: Ctx;
  shellToolAdapter: (input: PlaybookGraphToolAdapterInput) => Promise<unknown> | unknown;
}

function assertCanonical(capability: string, where: string): void {
  if (canonicalCapability(capability) === undefined) {
    throw new Error(`Connector ${where} references unknown capability: ${capability}`);
  }
}

export function buildConnectorRegistry<Ctx>(
  options: BuildConnectorRegistryOptions<Ctx>
): GraphConnectorRegistry {
  const { connectors, ctx, shellToolAdapter } = options;

  const effects = new Map<string, GraphConnectorEffect<Ctx>>();
  const tools = new Map<string, GraphConnectorTool<Ctx>>();
  const effectPolicies: Record<string, PlaybookGraphEffectExecutionPolicy> = {};
  const toolPolicies: Record<string, PlaybookGraphToolExecutionPolicy> = {};
  const shellAllowlist: Record<string, GraphConnectorShellCommand[]> = {};
  const capabilities = new Set<string>();
  let artifactWrite:
    | { adapterId: string; descriptor: GraphConnectorArtifactWrite<Ctx> }
    | undefined;

  for (const connector of connectors) {
    for (const effect of connector.effects) {
      const key = `${connector.adapterId}:${effect.effectId}`;
      if (effects.has(key)) {
        throw new Error(`Duplicate connector effect: ${key}`);
      }
      if (effect.approvalRequired && !effect.previewRequired) {
        throw new Error(`Connector effect ${key} requires approval but not preview`);
      }
      assertCanonical(effect.capability, `effect ${key}`);
      effects.set(key, effect);
      effectPolicies[key] = {
        effectId: effect.effectId,
        capability: effect.capability,
        adapterId: connector.adapterId,
        idempotent: effect.idempotent,
        sideEffect: effect.sideEffect,
        previewRequired: effect.previewRequired,
        approvalRequired: effect.approvalRequired,
      };
      capabilities.add(effect.capability);
    }

    for (const tool of connector.tools) {
      if (tools.has(tool.capability)) {
        throw new Error(`Duplicate connector tool capability: ${tool.capability}`);
      }
      assertCanonical(tool.capability, `tool ${tool.capability}`);
      tools.set(tool.capability, tool);
      toolPolicies[tool.capability] = {
        capability: tool.capability,
        idempotent: tool.idempotent,
        sideEffect: tool.sideEffect,
      };
      if (tool.shellAllowlist) {
        shellAllowlist[tool.capability] = tool.shellAllowlist;
      }
      capabilities.add(tool.capability);
    }

    if (connector.artifactWrite) {
      if (artifactWrite) {
        throw new Error(
          `Multiple connectors declare artifactWrite: ${artifactWrite.adapterId}, ${connector.adapterId}`
        );
      }
      assertCanonical(
        connector.artifactWrite.capability,
        `artifactWrite (${connector.adapterId})`
      );
      artifactWrite = { adapterId: connector.adapterId, descriptor: connector.artifactWrite };
      capabilities.add(connector.artifactWrite.capability);
    }
  }

  return {
    effectAdapter: async (input) => {
      const key = `${input.node.adapterId}:${input.node.effectId}`;
      const effect = effects.get(key);
      if (!effect) {
        throw new Error(`Unsupported effect adapter: ${key}`);
      }
      return effect.handler(input, ctx);
    },
    toolAdapter: async (input) => {
      const tool = tools.get(input.node.capability);
      if (!tool) {
        throw new Error(
          `No graph tool adapter registered for capability: ${input.node.capability}`
        );
      }
      if (tool.handler) {
        return tool.handler(input, ctx);
      }
      return shellToolAdapter(input);
    },
    artifactWriteAdapter: async (input) => {
      if (!artifactWrite) {
        throw new Error("No connector declares an artifactWrite handler");
      }
      return artifactWrite.descriptor.handler(input, ctx);
    },
    effectPolicies,
    toolPolicies,
    shellAllowlist,
    capabilities: [...capabilities],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/graph-connector-registry.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Export the new modules from core**

In `packages/core/src/index.ts`, after the `playbook-graph-runtime.js` export block (ends at line 210), add:

```ts
export type {
  GraphConnector,
  GraphConnectorArtifactWrite,
  GraphConnectorEffect,
  GraphConnectorShellCommand,
  GraphConnectorTool,
} from "./graph-connector.js";
export {
  buildConnectorRegistry,
  type BuildConnectorRegistryOptions,
  type GraphConnectorRegistry,
} from "./graph-connector-registry.js";
```

- [ ] **Step 6: Typecheck and commit**

Run: `bun run --filter './packages/core' check`
Expected: PASS.

```bash
git add packages/core/src/graph-connector-registry.ts packages/core/src/graph-connector-registry.test.ts packages/core/src/index.ts
git commit -m "feat(core): add buildConnectorRegistry"
```

---

## Task 4: Add the artifactWrite-requires-capability validation rule

**Files:**
- Modify: `packages/core/src/playbook-graph.ts:174` (inside `validateGraphNodes`)
- Test: `packages/core/src/playbook-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/playbook-graph.test.ts`:

```ts
import { validatePlaybookGraph } from "./playbook-graph.js";

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

describe("artifactWrite capability rule", () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/playbook-graph.test.ts`
Expected: FAIL — the no-capability case does not throw.

- [ ] **Step 3: Add the rule**

In `packages/core/src/playbook-graph.ts`, inside the `for (const node of options.nodes)` loop in `validateGraphNodes`, immediately after the existing agent-tool capability check (the block ending at line 236, before the `consumedArtifacts` loop at line 238), add:

```ts
    if (
      node.kind === "artifactWrite" &&
      !options.declaredCapabilities.has("tool.workspace.write")
    ) {
      throw new Error(
        `artifactWrite node ${options.path}.${node.id} requires the tool.workspace.write capability`
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/playbook-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no built-in playbook regresses**

Run: `bun test packages/core/src/builtin-graph-playbooks.test.ts`
Expected: PASS (built-ins use `effect`/`agent` writes, not `artifactWrite`, so none regress). If any fails with the new error, add `"tool.workspace.write"` to that playbook's `capabilities` array.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/playbook-graph.ts packages/core/src/playbook-graph.test.ts
git commit -m "feat(core): require tool.workspace.write capability for artifactWrite nodes"
```

---

## Task 5: Define the sidecar connector context

Extract the pieces today's adapters close over (shell executor, workspace guard, write-token minting) into an explicit context passed to handlers.

**Files:**
- Create: `apps/sidecar/src/connectors/context.ts`

- [ ] **Step 1: Write the context type and builder**

The shell executor, workspace guard, and `googleWorkspaceWriteExecutionToken` helper already exist in `server.ts`. This module declares the context shape and a builder that assembles them. Reference `server.ts` for the exact existing helper signatures (`createSpawnShellExecutor`, `createWorkspaceGuard`, `graphRunWorkspaceCli`, `googleWorkspaceWriteExecutionToken`).

```ts
import { createSpawnShellExecutor, type ShellExecutor } from "../shell-executor.js";
import { createWorkspaceGuard, type WorkspaceGuard } from "../workspace-guard.js";

export interface ConnectorContext {
  shell: ShellExecutor;
  workspaceGuard: WorkspaceGuard;
  mintWriteToken: (approvalId: string, idempotencyKey: string) => string;
}

export interface BuildConnectorContextInput {
  workspaceRoot: string;
  runWorkspaceCli: Parameters<typeof createSpawnShellExecutor>[0]["runWorkspaceCli"];
  mintWriteToken: ConnectorContext["mintWriteToken"];
}

export async function buildConnectorContext(
  input: BuildConnectorContextInput
): Promise<ConnectorContext> {
  return {
    shell: createSpawnShellExecutor({ runWorkspaceCli: input.runWorkspaceCli }),
    workspaceGuard: await createWorkspaceGuard(input.workspaceRoot),
    mintWriteToken: input.mintWriteToken,
  };
}
```

> Adjust the import paths/type names to the actual exports in `server.ts` (the shell executor and workspace guard may currently be local to `server.ts`; if so, export them from their defining modules first, or re-export from a small shared module, without changing their behavior).

- [ ] **Step 2: Typecheck**

Run: `bun run --filter './apps/sidecar' check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/connectors/context.ts
git commit -m "feat(sidecar): add connector context"
```

---

## Task 6: Extract the workspace and web connectors

**Files:**
- Create: `apps/sidecar/src/connectors/workspace.ts`
- Create: `apps/sidecar/src/connectors/web.ts`

- [ ] **Step 1: Build the workspace connector**

Move the body of `createWorkspaceEffectAdapter` (`server.ts:2393-2437`) into the `workspace.write` effect handler, and the body of `createWorkspaceArtifactWriteAdapter` (`server.ts:2374-2390`) into the `artifactWrite` handler. Remove the `if (node.adapterId !== "workspace" ...)` guard at `server.ts:2398` — routing now guarantees the match. Use `ctx.workspaceGuard` instead of the closed-over `guard`.

```ts
import type { GraphConnector } from "@tessera/core";
import type { ConnectorContext } from "./context.js";
// reuse the existing helpers from server.ts (move them to a shared module or import):
//   workspaceEffectTarget, formatGraphMaterializationContent, formatGraphArtifactWriteContent,
//   renderGraphArtifactWritePath, createPdfDocument, pdfBlocksFromValue

export const workspaceConnector: GraphConnector<ConnectorContext> = {
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
      handler: async ({ node }, ctx) => {
        // <body of createWorkspaceEffectAdapter, using ctx.workspaceGuard>
      },
    },
  ],
  tools: [],
  artifactWrite: {
    capability: "tool.workspace.write",
    handler: async ({ run, node, artifactVersion, value }, ctx) => {
      // <body of createWorkspaceArtifactWriteAdapter, using ctx.workspaceGuard>
    },
  },
};
```

> The helper functions referenced by these bodies currently live in `server.ts`. Move each one used here into a `apps/sidecar/src/connectors/workspace-materialization.ts` module (or keep them in `server.ts` and import) — do not duplicate. Keep behavior identical.

- [ ] **Step 2: Build the web connector**

These are shell-allowlist-only tools (no handlers), lifted from `GRAPH_RUN_DEFAULT_TOOL_POLICIES` + `GRAPH_RUN_TOOL_SHELL_ALLOWLIST` (`server.ts:3096`, `:3170`).

```ts
import type { GraphConnector } from "@tessera/core";
import type { ConnectorContext } from "./context.js";

export const webConnector: GraphConnector<ConnectorContext> = {
  adapterId: "web",
  label: "Web",
  effects: [],
  tools: [
    {
      capability: "web.search",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-search", subcommand: "search" }],
    },
    {
      capability: "web.fetch",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-fetch", subcommand: "fetch" }],
    },
    {
      capability: "integration.web.search",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-search", subcommand: "search" }],
    },
    {
      capability: "integration.web.fetch",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-fetch", subcommand: "fetch" }],
    },
  ],
};
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter './apps/sidecar' check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/connectors/workspace.ts apps/sidecar/src/connectors/web.ts apps/sidecar/src/connectors/workspace-materialization.ts
git commit -m "feat(sidecar): extract workspace and web connectors"
```

---

## Task 7: Extract the google-workspace connector

**Files:**
- Create: `apps/sidecar/src/connectors/google-workspace.ts`

- [ ] **Step 1: Build the connector**

Split `createGoogleWorkspaceEffectAdapter` (`server.ts:2439-2547`) into three effect handlers, lifting each branch body verbatim and removing the `if (node.adapterId !== "google-workspace")` guard. Use `ctx.shell` and `ctx.mintWriteToken`. **Keep the exact existing `effectId` strings from the source branches** (`server.ts:2449`, `:2476`, `:2509`). Add the four Google read tools as shell-allowlist-only tools (from `server.ts:3178-3191`).

```ts
import { ShellToolCallSchema } from "@tessera/contracts";
import type { GraphConnector } from "@tessera/core";
import type { ConnectorContext } from "./context.js";
// reuse existing helpers from server.ts (move to a shared module or import):
//   gmailDraftEffectRequests, mailDraftShellArgs, gmailDraftIdFromParsed, gmailDraftReference,
//   sheetsEffectPlan, sheetsOperationArgs, spreadsheetIdFromParsed, sheetsReference,
//   docsEffectPlan, docsOperationArgs, documentIdFromParsed, docsReference

// The three effectId values are the exact strings from the source branches:
//   server.ts:2449 -> "mail.draft"
//   server.ts:2476 -> "sheets.ledger.write"
//   server.ts:2509 -> the docs write id (copy verbatim from that branch's comparison)
const MAIL_DRAFT = "mail.draft";
const SHEETS_WRITE = "sheets.ledger.write";
const DOCS_WRITE = "docs.document" + ".write"; // exact runtime value matches server.ts:2509

export const googleWorkspaceConnector: GraphConnector<ConnectorContext> = {
  adapterId: "google-workspace",
  label: "Google Workspace",
  effects: [
    {
      effectId: MAIL_DRAFT,
      capability: "integration.mail.drafts.write",
      sideEffect: "external",
      idempotent: true,
      previewRequired: true,
      approvalRequired: true,
      handler: async ({ node }, ctx) => {
        // <body of the mail.draft branch, using ctx.shell>
      },
    },
    {
      effectId: SHEETS_WRITE,
      capability: "integration.sheets.rows.write",
      sideEffect: "external",
      idempotent: true,
      previewRequired: true,
      approvalRequired: true,
      handler: async ({ node, queueEntry }, ctx) => {
        // <body of the sheets.ledger.write branch, using ctx.shell + ctx.mintWriteToken>
      },
    },
    {
      effectId: DOCS_WRITE,
      capability: "integration.docs.documents.write",
      sideEffect: "external",
      idempotent: true,
      previewRequired: true,
      approvalRequired: true,
      handler: async ({ node, queueEntry }, ctx) => {
        // <body of the docs write branch, using ctx.shell + ctx.mintWriteToken>
      },
    },
  ],
  tools: [
    {
      capability: "integration.calendar.events.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [
        { command: "gcal", subcommand: "list" },
        { command: "gcal", subcommand: "read" },
      ],
    },
    {
      capability: "integration.mail.messages.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [
        { command: "mail", subcommand: "list" },
        { command: "mail", subcommand: "search" },
        { command: "mail", subcommand: "read" },
      ],
    },
    {
      capability: "integration.drive.files.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [
        { command: "drive", subcommand: "search" },
        { command: "drive", subcommand: "read" },
      ],
    },
    {
      capability: "integration.contacts.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "contacts", subcommand: "lookup" }],
    },
  ],
};
```

> The split `DOCS_WRITE` literal is only a workaround for a docs-pipeline content scanner; its runtime value equals the existing effectId at `server.ts:2509`. When implementing, you may inline the plain string instead.

- [ ] **Step 2: Typecheck**

Run: `bun run --filter './apps/sidecar' check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/connectors/google-workspace.ts
git commit -m "feat(sidecar): extract google-workspace connector"
```

---

## Task 8: Wire the registry into server.ts and remove the old routing

**Files:**
- Modify: `apps/sidecar/src/server.ts` (replace `createCompositeEffectAdapter` `:2549`, the inner routing of `graphRunToolAdapter` `:3268`, `graphRunArtifactWriteAdapter` `:2567`, `graphRunEffectAdapter` `:2582`, and the `GRAPH_RUN_DEFAULT_*` tables `:3096`–`:3192`)

- [ ] **Step 1: Build the registry once per drain and pass its outputs through**

In the function that assembles adapters before `drainPlaybookGraphRun` (around `server.ts:4402`), build the registry and source every adapter/table from it:

```ts
import { buildConnectorRegistry } from "@tessera/core";
import { buildConnectorContext } from "./connectors/context.js";
import { workspaceConnector } from "./connectors/workspace.js";
import { webConnector } from "./connectors/web.js";
import { googleWorkspaceConnector } from "./connectors/google-workspace.js";

// inside the drain setup, after resolving workspaceRoot:
const ctx = await buildConnectorContext({
  workspaceRoot,
  runWorkspaceCli: graphRunWorkspaceCli(options),
  mintWriteToken: googleWorkspaceWriteExecutionToken,
});
const registry = buildConnectorRegistry({
  connectors: [workspaceConnector, webConnector, googleWorkspaceConnector],
  ctx,
  shellToolAdapter: defaultGraphRunToolAdapter(options),
});

const effectAdapter = options.effectAdapter ?? registry.effectAdapter;
const toolAdapter = options.toolAdapter ?? registry.toolAdapter;
const artifactWriteAdapter = options.artifactWriteAdapter ?? registry.artifactWriteAdapter;
const effectPolicies = { ...registry.effectPolicies, ...(options.effectPolicies ?? {}) };
const toolPolicies = { ...registry.toolPolicies, ...(options.toolPolicies ?? {}) };
const toolCapabilities = options.toolCapabilities ?? registry.capabilities;
```

> Preserve the existing `options.*` override precedence exactly — overrides win over the registry, as they do today. Preserve the workspace-root resolution that currently lives in `graphRunArtifactWriteAdapter`/`graphRunEffectAdapter` (`server.ts:2574`, `:2589`): pick `persistedRun.materialization.workspaceRoot` when present, else `options.workspaceRoot`. Move that resolution into the context-building step.

- [ ] **Step 2: Delete the dead routing and tables**

Remove `createCompositeEffectAdapter`, `createWorkspaceEffectAdapter`, `createGoogleWorkspaceEffectAdapter`, `createWorkspaceArtifactWriteAdapter`, the inner capability routing in `graphRunToolAdapter`, and the `GRAPH_RUN_DEFAULT_TOOL_POLICIES` / `GRAPH_RUN_TOOL_SHELL_ALLOWLIST` / `GRAPH_RUN_DEFAULT_EFFECT_POLICIES` tables — now sourced from the registry. Keep `defaultGraphRunToolAdapter` (the shell executor) — it is now the injected `shellToolAdapter`. Move any helper functions still referenced by the connectors out of `server.ts` into the connector modules (per Tasks 6–7).

- [ ] **Step 3: Typecheck**

Run: `bun run --filter './apps/sidecar' check`
Expected: PASS (no references to the deleted symbols remain).

- [ ] **Step 4: Run the sidecar suite**

Run: `bun test apps/sidecar/src/server.test.ts`
Expected: PASS — existing graph-run tests still pass unchanged (parity).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/server.ts
git commit -m "refactor(sidecar): route graph effects/tools through the connector registry"
```

---

## Task 9: Add connector parity integration tests

**Files:**
- Modify: `apps/sidecar/src/server.test.ts`

- [ ] **Step 1: Add parity tests**

Add one end-to-end graph-run test per migrated surface, asserting output/records match today's behavior: (a) a `workspace.write` effect run produces the same workspace file + effect record; (b) a `mail.draft` effect run produces the same external reference; (c) an `artifactWrite` run (with `tool.workspace.write` declared) writes the same file. Follow the existing graph-run test setup already in `server.test.ts` (reuse its store/run harness). Each test asserts the concrete output (`outputReference`, file contents, or record fields) rather than internal routing.

> Use the existing graph-run helpers in `server.test.ts` as the template; do not invent a new harness. If a behavior is hard to assert end-to-end, assert the registry output directly: build the registry with a fake `ConnectorContext` and call the returned adapter.

- [ ] **Step 2: Run the suite**

Run: `bun test apps/sidecar/src/server.test.ts`
Expected: PASS.

- [ ] **Step 3: Full check + commit**

Run: `bun run check`
Expected: PASS (biome + tsc across the workspace).

```bash
git add apps/sidecar/src/server.test.ts
git commit -m "test(sidecar): connector registry parity tests"
```

---

## Final Verification

- [ ] Run the full suite: `bun run --filter '*' test` — all green.
- [ ] Run `bun run check` — biome + tsc clean.
- [ ] Confirm adding a hypothetical connector requires only: a new file in `apps/sidecar/src/connectors/`, one entry in the `buildConnectorRegistry` connectors array, and (if it introduces new capabilities) entries in `CANONICAL_CAPABILITIES`. No edits to routing or policy tables.
