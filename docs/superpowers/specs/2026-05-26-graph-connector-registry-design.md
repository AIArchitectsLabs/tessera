# Graph Connector Registry — Design

**Date:** 2026-05-26
**Status:** Approved for planning
**Scope:** Make the playbook execution engine's integration surface extensible by collapsing the scattered effect/tool routing and policy tables into a single connector registry.

## Problem

The playbook execution engine has two distinct extensibility axes:

1. **Node kinds** — the `PlaybookGraphNode` discriminated union (`packages/contracts/src/index.ts:2206`) is a closed set of 9 kinds. Adding a kind is deliberate core surgery and is **out of scope** here.
2. **Capabilities / integrations** — what an existing node kind can *do*. This is the designed growth axis, and the target of this work.

The runtime (`packages/core/src/playbook-graph-runtime.ts`) is already integration-agnostic: it calls injected `effectAdapter` / `toolAdapter` / `artifactWriteAdapter` and knows nothing about specific services. **All integration-specific coupling lives in `apps/sidecar/src/server.ts`** as hand-maintained, drift-prone structures:

- `createCompositeEffectAdapter` (`server.ts:2549`) — a hardcoded `if (adapterId === ...)` router.
- Each adapter's internal `if (effectId === ...)` chain (e.g. `createGoogleWorkspaceEffectAdapter`, `server.ts:2439`).
- Four parallel tables that must be kept in sync by hand: `GRAPH_RUN_DEFAULT_TOOL_POLICIES` (`:3096`), `GRAPH_RUN_TOOL_SHELL_ALLOWLIST` (`:3170`), `GRAPH_RUN_DEFAULT_EFFECT_POLICIES` (`:3131`), plus the governed `CANONICAL_CAPABILITIES` vocabulary in `contracts` (`:1034`).

Adding an integration (e.g. Slack) today means editing ~4 tables + 2 router if-chains + a CLI command. Drift between the tables surfaces as runtime errors with no single source of truth.

Additionally, workspace-write paths bypass the allowlist surface entirely: the `workspace.write` effect and the `artifactWrite` node adapter both write to disk directly, and `artifactWrite` nodes require no capability declaration at all.

## Goals

- Adding an integration = author one connector descriptor + list it; no router edits, no table edits.
- One source of truth for effect/tool routing, all derived policy/allowlist/capability tables, **and every workspace-write path**.
- Keep `core` integration-agnostic; keep `contracts` the governed capability vocabulary.
- Shape the descriptor interface so it could later be exposed via `plugin-sdk` without redesign — without building any plugin machinery now.

## Non-Goals (deferred, each needs its own spec)

- Dynamic/runtime plugin loading, sandboxing, trust/permission model.
- Publicly exposing the descriptor through `plugin-sdk`.
- New node *kinds* (Axis A) — untouched.
- Folding `condition` / `join` / `parallelMap` inline handlers into the registry (pure control-flow, not integrations).

## Decisions

- **Registration model:** in-tree now, plugin-ready later. Build the registry with a clean generic interface; no dynamic loading or sandboxing yet.
- **Invocation path:** mixed, decided per operation by the connector. The CLI-shell pattern (today's default, with shell allowlist + credential-token security) remains the default; the descriptor does not assume *how* a connector reaches its service.
- **Write capability:** a single shared `tool.workspace.write` capability governs both the approval-gated `workspace.write` effect and the automatic `artifactWrite` path. A playbook declaring the capability authorizes both. (Considered and rejected: a distinct `artifactWrite` capability to mirror the approval asymmetry — rejected in favor of a single, intuitive "writes to the workspace" permission.)
- **Enforcement:** the `artifactWrite`-requires-`tool.workspace.write` rule is a hard failure in `validateGraphNodes`, consistent with the existing undeclared-capability checks (`playbook-graph.ts:210,216`). Not a soft preflight warning — a warning would leave the write side channel technically open.

## Architecture

The runtime does not change. The work replaces the hardcoded routing/tables in `server.ts` with a registry.

Module layout, respecting package boundaries:

- **`packages/core/src/graph-connector.ts`** (new) — the `GraphConnector<Ctx>` descriptor *type* (plain data + handler signatures). No runtime logic. This is the interface that later becomes plugin-sdk-exposable.
- **`packages/core/src/graph-connector-registry.ts`** (new) — the generic, pure `buildConnectorRegistry`. Takes `GraphConnector<Ctx>[]` + a `Ctx`; produces the composite adapters, derived policy/allowlist/capability tables. Knows nothing about specific services, shells, or credentials. Fully unit-testable in isolation.
- **`apps/sidecar/src/connectors/`** (new dir) — concrete connectors `workspace.ts` and `google-workspace.ts`, extracted from today's adapters. The sidecar-specific handler context (shell executor, workspace guard, credential-token minting) is defined and assembled here.
- **`apps/sidecar/src/server.ts`** — shrinks to: build the context, list the connectors, call `buildConnectorRegistry`, hand the results to `drainPlaybookGraphRun`. The two if-chain routers and four parallel tables are removed.
- **`packages/contracts/src/index.ts`** — `CANONICAL_CAPABILITIES` stays as the governed vocabulary; connectors reference it. Capabilities used by migrated connectors that are not yet canonical are added here.

Boundary check: `core` stays integration-agnostic (builder generic over `Ctx`); `sidecar` owns concrete connectors + context; `contracts` owns capability vocabulary.

## Components

### The `GraphConnector` descriptor

Generic over a sidecar-supplied context `Ctx`. Field shapes map 1:1 onto the existing `PlaybookGraphEffectExecutionPolicy` / `PlaybookGraphToolExecutionPolicy` so they feed the runtime unchanged.

```ts
type GraphConnectorEffect<Ctx> = {
  effectId: string;                 // e.g. "mail.draft"
  capability: string;               // e.g. "integration.mail.drafts.write"
  sideEffect: "write" | "external";
  idempotent: boolean;
  previewRequired: boolean;
  approvalRequired: boolean;
  handler: (input: PlaybookGraphEffectAdapterInput, ctx: Ctx)
    => Promise<PlaybookGraphEffectAdapterResult> | PlaybookGraphEffectAdapterResult;
};

type GraphConnectorTool<Ctx> = {
  capability: string;               // routing key for tools (today's model)
  sideEffect: "read" | "write" | "external";
  idempotent: boolean;
  shellAllowlist?: Array<{ command: string; subcommand: string }>;  // CLI-shell path
  handler?: (input: PlaybookGraphToolAdapterInput, ctx: Ctx) => Promise<unknown> | unknown;
};

type GraphConnector<Ctx> = {
  adapterId: string;                // e.g. "google-workspace"
  label: string;
  effects: GraphConnectorEffect<Ctx>[];
  tools: GraphConnectorTool<Ctx>[];
  artifactWrite?: {
    capability: string;             // "tool.workspace.write"
    handler: (input: PlaybookGraphArtifactWriteAdapterInput, ctx: Ctx) => Promise<unknown> | unknown;
  };
};
```

Mixed invocation paths, with no registry changes:

- **Effect handler is required**; its body chooses the path — shell out via `ctx`, `fetch` an API directly, or call an MCP client. The registry only routes `adapterId:effectId → handler`.
- **Tool handler is optional.** Provide `capability + shellAllowlist` only → the builder wires the tool to the default shell adapter (preserves today's read-tool behavior). Provide a `handler` → direct-API/MCP path. A connector may mix shell-backed and API-backed tools.

Routing keys match today's reality: effects keyed `${adapterId}:${effectId}` (the existing `effectPolicyKey`), tools keyed by `capability`.

Capabilities stay governed in `contracts`: connectors *reference* capability IDs; the builder validates each referenced capability exists in `CANONICAL_CAPABILITIES`. Adding a genuinely new integration capability remains a deliberate edit to that governed list.

### The registry builder

```ts
function buildConnectorRegistry<Ctx>(
  connectors: GraphConnector<Ctx>[],
  ctx: Ctx,
): {
  effectAdapter: (input: PlaybookGraphEffectAdapterInput) => Promise<PlaybookGraphEffectAdapterResult>;
  toolAdapter:   (input: PlaybookGraphToolAdapterInput) => Promise<unknown>;
  artifactWriteAdapter: (input: PlaybookGraphArtifactWriteAdapterInput) => Promise<unknown>;
  effectPolicies: Record<string, PlaybookGraphEffectExecutionPolicy>;
  toolPolicies:   Record<string, PlaybookGraphToolExecutionPolicy>;
  shellAllowlist: Record<string, Array<{ command: string; subcommand: string }>>;
  capabilities:   string[];
}
```

Behavior, all by iteration over the descriptors (no if-chains):

1. Build lookup maps once at construction: `effectHandlers: Map<"adapterId:effectId", handler>`, `toolHandlers: Map<capability, handler | shellAllowlist>`, and the single `artifactWrite` handler.
2. `effectAdapter` = look up `${node.adapterId}:${node.effectId}` → call handler with `(input, ctx)`. Miss → throw the same `Unsupported effect adapter: …` error as today (observability unchanged).
3. `toolAdapter` = look up `node.capability` → if descriptor has a `handler`, call it; else fall through to the default shell adapter built from the merged `shellAllowlist`. Miss → today's `No graph tool adapter registered for capability` error.
4. `artifactWriteAdapter` = the single declared `artifactWrite` handler.
5. Derive the four hand-maintained tables (`effectPolicies`, `toolPolicies`, `shellAllowlist`, `capabilities`) from the same descriptors, so drift is structurally impossible.

Build-time validation (fail fast at sidecar boot; also covered by a `core` unit test):

- duplicate `adapterId:effectId` or duplicate tool `capability` → throw
- more than one connector declaring `artifactWrite` → throw
- every referenced capability ∈ `CANONICAL_CAPABILITIES` → throw with the offending id
- a descriptor whose `previewRequired` / `approvalRequired` / `sideEffect` contradicts node-schema invariants (e.g. preview required when approval required) → throw

This replaces `createCompositeEffectAdapter` (`server.ts:2549`), `graphRunToolAdapter`'s inner routing (`:3273`), and the four `GRAPH_RUN_DEFAULT_*` tables.

The `options.effectAdapter` / `options.toolAdapter` / `options.artifactWriteAdapter` / `options.effectPolicies` overrides on `GraphRunHandlerOptions` are unchanged and still short-circuit before the registry, so tests and the runtime contract are untouched.

## Workspace-write governance

Both disk-write paths are owned by the workspace connector under one `tool.workspace.write` capability (already canonical, `contracts:1081`), so `server.ts` has no direct-fs write adapter that isn't sourced from a connector. The registry's enumerated capability set *is* the write allowlist; reads and writes live in the same governed surface.

- `workspace.write` effect — handler = today's `createWorkspaceEffectAdapter` body (`server.ts:2393`).
- `artifactWrite` slot — handler = today's `createWorkspaceArtifactWriteAdapter` body (`server.ts:2374`).

**Validation rule (platform-level governance):** `validateGraphNodes` (`packages/core/src/playbook-graph.ts`) gains a rule that an `artifactWrite` node requires the workspace-write capability to be declared in the graph's `capabilities[]`. This closes the loophole where `artifactWrite` currently bypasses capability declaration entirely.

**Blast radius:** a repo-wide check confirmed **no built-in playbook uses `artifactWrite` today** — built-ins materialize via `effect` / `agent` nodes. The rule breaks zero current built-ins; the "migrate built-ins" task is a no-op verification now, and the rule guards future authors. If any built-in is later found to use `artifactWrite` without the declaration, it is migrated to declare the capability.

## Migration

Mechanical extraction; handler bodies are lifted near-verbatim, only the routing wrappers disappear.

- **`apps/sidecar/src/connectors/workspace.ts`** — `adapterId: "workspace"`. Owns the `workspace.write` effect and the `artifactWrite` slot.
- **`apps/sidecar/src/connectors/google-workspace.ts`** — `adapterId: "google-workspace"`. Three effects (`mail.draft`, `sheets.ledger.write`, and the Docs document-write effect) become three handler functions; the read tools (`integration.mail.messages.read`, `integration.calendar.events.read`, etc.) move here as `shellAllowlist`-only tools (no handler), keeping them on the default shell adapter.
- **Sidecar context (`Ctx`)** — `{ shell: ShellExecutor; workspaceGuard; mintWriteToken }`, assembled in `server.ts` from the existing `createSpawnShellExecutor({ runWorkspaceCli })`, `createWorkspaceGuard`, and `googleWorkspaceWriteExecutionToken`. Same pieces, passed in rather than closed over. Workspace-root resolution (`server.ts:2588`, `materialization.workspaceRoot` vs `options.workspaceRoot`) stays in the context builder.

`server.ts` wiring becomes roughly:

```ts
const ctx = buildSidecarConnectorContext(options, store, runId);
const registry = buildConnectorRegistry([workspaceConnector, googleWorkspaceConnector], ctx);
// hand registry.effectAdapter / toolAdapter / artifactWriteAdapter /
// effectPolicies / toolPolicies / capabilities to drainPlaybookGraphRun
```

Connectors are migrated one at a time, green between each.

After this, adding "Slack" = add `connectors/slack.ts` + list it in the array + add its capabilities to `CANONICAL_CAPABILITIES`. No router edits, no table edits.

## Testing (TDD)

- **`graph-connector-registry.test.ts`** (core, pure — the bulk of coverage): routing by `adapterId:effectId` and tool `capability`; optional-tool-handler fallthrough (shell vs. direct handler); `artifactWrite` derivation; the derived policy/allowlist/capability maps; and every build-time validation (duplicate effect key, duplicate tool capability, unknown/non-canonical capability, >1 artifactWrite connector). No sidecar deps.
- **`playbook-graph.test.ts`** (core): `artifactWrite` node without `tool.workspace.write` in `capabilities[]` throws; with it, passes.
- **`server.test.ts`** (sidecar): one integration test per migrated connector proving end-to-end parity — `workspace.write`, the three Google effects, and an `artifactWrite` run produce identical outputs/records to today. Regression guard for the extraction.

## Plugin-ready seam

The `GraphConnector<Ctx>` type and `buildConnectorRegistry` are generic over `Ctx` and free of sidecar imports, living in `core`. That is the entire "plugin-ready" investment now — a later effort can publish the type via `plugin-sdk` and feed plugin-supplied connectors into the same builder, with no redesign.
