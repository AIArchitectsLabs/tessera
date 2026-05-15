# Playbook Graph Compiler Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first generic orchestrator foundation: a normalized `PlaybookGraph` contract, a minimal SDK `definePlaybook()` authoring surface, deterministic graph/source hashing, compile metadata, and a filesystem cache for compiled graph artifacts.

**Architecture:** Keep this slice contract-first and runtime-neutral. `packages/contracts` defines the normalized graph and compile metadata schemas; `packages/plugin-sdk` exposes the author-facing `definePlaybook()` helper; `packages/core` validates and hashes compiled graphs and stores them in a content-addressed filesystem cache. Existing `WorkflowDefinition` playbooks remain unchanged.

**Tech Stack:** TypeScript strict, Zod, Bun test runner, Bun filesystem APIs, existing Bun workspace scripts.

**Out of scope:** Playbook execution, durable run resume, node memoization, human review UI, script runner sandboxing, dynamic import of external `playbook.ts`, imported repo lifecycle, and SEO/GEO reference playbook implementation.

---

## File Structure

**New files:**

- `packages/contracts/src/playbook-graph.test.ts` — contract tests for `PlaybookGraph`, graph nodes, artifact refs, limits, and compile metadata.
- `packages/plugin-sdk/src/playbook.ts` — public `definePlaybook()` helper for authoring source packages.
- `packages/plugin-sdk/src/playbook.test.ts` — tests that SDK authors get schema validation and stable typed return values.
- `packages/core/src/playbook-graph.ts` — graph validation, stable stringify, `sha256:` hashing, source hashing, and graph transition/reference validation.
- `packages/core/src/playbook-graph.test.ts` — unit tests for graph validation and hashing.
- `packages/core/src/playbook-graph-compiler.ts` — compile a graph object plus source-file map into `{ graph, metadata }`.
- `packages/core/src/playbook-graph-compiler.test.ts` — unit tests for compile metadata and invalidation hashes.
- `packages/core/src/playbook-graph-cache.ts` — filesystem cache for compiled graph artifacts.
- `packages/core/src/playbook-graph-cache.test.ts` — cache save/read/latest tests.

**Modified files:**

- `packages/contracts/src/index.ts` — add `PlaybookGraph*` schemas and types near existing playbook schemas.
- `packages/plugin-sdk/src/index.ts` — export `definePlaybook` and graph types.
- `packages/core/src/index.ts` — export graph validation/compiler/cache helpers.

---

## Design Decisions Locked In This Plan

- `PlaybookGraph` is a new contract alongside existing `WorkflowDefinition`; it does not replace current built-in playbooks in this slice.
- Phase 1 graph scripts are TypeScript only. The schema accepts `run: "./scripts/name.ts"` and rejects non-`.ts` script paths.
- The SDK `definePlaybook()` validates and returns a normalized `PlaybookGraph`. It does not run the graph.
- DSL conveniences like `loop()` and `score()` are not implemented in this slice. Authors can still express equivalent normalized nodes directly.
- The compile step accepts an already-produced graph object plus a source-file map. Loading/executing external TypeScript modules from disk is a later install/import task.
- Graph validation checks node ids, start node, transition targets, artifact references, script path shape, and branch subgraphs.
- The compile cache is content-addressed by `graphHash` and stores a `latest.json` pointer per playbook id. A later durable-run plan will pin compiled graph snapshots to run records.

---

## Task 1: Add PlaybookGraph Contract Tests

**Files:**

- Create: `packages/contracts/src/playbook-graph.test.ts`
- Modify later: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write the failing contract tests**

Create `packages/contracts/src/playbook-graph.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  PlaybookGraphCompileMetadataSchema,
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test packages/contracts/src/playbook-graph.test.ts
```

Expected: fail because `PlaybookGraphSchema`, `PlaybookGraphCompileMetadataSchema`, and `PlaybookGraphSourceRefSchema` are not exported.

---

## Task 2: Implement PlaybookGraph Contracts

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/playbook-graph.test.ts`

- [ ] **Step 1: Add graph schemas to contracts**

In `packages/contracts/src/index.ts`, insert this block after `export type PlaybookManifest = z.infer<typeof PlaybookManifestSchema>;`:

```ts
const SafePlaybookIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Use only letters, numbers, dot, underscore, colon, and dash");

const Sha256DigestSchema = z.string().regex(/^sha256:.+$/, "Expected sha256-prefixed digest");

export const PlaybookGraphSourceRefSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), "Source refs must be package-relative")
  .refine((value) => !value.split(/[\\/]/).includes(".."), "Source refs must not escape package");
export type PlaybookGraphSourceRef = z.infer<typeof PlaybookGraphSourceRefSchema>;

export const PlaybookGraphArtifactSchema = z
  .object({
    schema: PlaybookGraphSourceRefSchema,
    materialize: z.string().min(1).optional(),
  })
  .strict();
export type PlaybookGraphArtifact = z.infer<typeof PlaybookGraphArtifactSchema>;

export const PlaybookGraphArtifactPathRefSchema = z
  .object({
    artifact: z.string().min(1),
    path: z.string().min(1).default("$"),
  })
  .strict();
export type PlaybookGraphArtifactPathRef = z.infer<typeof PlaybookGraphArtifactPathRefSchema>;

export const PlaybookGraphConditionSchema = z
  .object({
    artifact: z.string().min(1),
    path: z.string().min(1),
    equals: z.unknown(),
  })
  .strict();
export type PlaybookGraphCondition = z.infer<typeof PlaybookGraphConditionSchema>;

export const PlaybookGraphLimitsSchema = z
  .object({
    maxGeneratedItems: z.number().int().positive().optional(),
    maxConcurrentBranches: z.number().int().positive().optional(),
    maxTotalBranches: z.number().int().positive().optional(),
    maxTotalAgentSteps: z.number().int().positive().optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxExternalToolCalls: z.number().int().positive().optional(),
    maxFetches: z.number().int().positive().optional(),
  })
  .strict()
  .default({});
export type PlaybookGraphLimits = z.infer<typeof PlaybookGraphLimitsSchema>;

const PlaybookGraphNodeBaseSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    onSuccess: z.string().min(1).optional(),
    onFailure: z.string().min(1).optional(),
  })
  .strict();

const PlaybookGraphNodeOutputSchema = z
  .object({
    artifact: z.string().min(1).optional(),
    schema: PlaybookGraphSourceRefSchema.optional(),
  })
  .strict();

export type PlaybookGraphNode = z.infer<typeof PlaybookGraphNodeSchema>;

export const PlaybookGraphNodeSchema: z.ZodType<
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "agent";
      prompt: string;
      inputs: Record<string, unknown>;
      tools: string[];
      output?: z.infer<typeof PlaybookGraphNodeOutputSchema>;
    })
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "script";
      run: string;
      inputs: Record<string, unknown>;
      outputArtifact?: string;
    })
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "tool";
      capability: string;
      args: Record<string, unknown>;
      outputArtifact?: string;
    })
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "humanReview";
      artifact: string;
      actions: string[];
      onApprove?: string;
      onRequestChanges?: string;
    })
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "parallelMap";
      items: z.infer<typeof PlaybookGraphArtifactPathRefSchema>;
      branch: { start: string; nodes: PlaybookGraphNode[] };
      outputArtifact?: string;
    })
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "join";
      inputs: string[];
      outputArtifact?: string;
    })
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "condition";
      when: z.infer<typeof PlaybookGraphConditionSchema>;
      onTrue: string;
      onFalse: string;
    })
  | (z.infer<typeof PlaybookGraphNodeBaseSchema> & {
      kind: "artifactWrite";
      artifact: string;
      path: string;
    })
> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("agent"),
      prompt: PlaybookGraphSourceRefSchema,
      inputs: z.record(z.unknown()).default({}),
      tools: z.array(z.string().min(1)).default([]),
      output: PlaybookGraphNodeOutputSchema.optional(),
    }).strict(),
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("script"),
      run: PlaybookGraphSourceRefSchema.refine(
        (value) => value.endsWith(".ts"),
        "Phase 1 playbook scripts must be TypeScript files"
      ),
      inputs: z.record(z.unknown()).default({}),
      outputArtifact: z.string().min(1).optional(),
    }).strict(),
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("tool"),
      capability: z.string().min(1),
      args: z.record(z.unknown()).default({}),
      outputArtifact: z.string().min(1).optional(),
    }).strict(),
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("humanReview"),
      artifact: z.string().min(1),
      actions: z.array(z.string().min(1)).min(1),
      onApprove: z.string().min(1).optional(),
      onRequestChanges: z.string().min(1).optional(),
    }).strict(),
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("parallelMap"),
      items: PlaybookGraphArtifactPathRefSchema,
      branch: z
        .object({
          start: z.string().min(1),
          nodes: z.array(PlaybookGraphNodeSchema).min(1),
        })
        .strict(),
      outputArtifact: z.string().min(1).optional(),
    }).strict(),
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("join"),
      inputs: z.array(z.string().min(1)).default([]),
      outputArtifact: z.string().min(1).optional(),
    }).strict(),
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("condition"),
      when: PlaybookGraphConditionSchema,
      onTrue: z.string().min(1),
      onFalse: z.string().min(1),
    }).strict(),
    PlaybookGraphNodeBaseSchema.extend({
      kind: z.literal("artifactWrite"),
      artifact: z.string().min(1),
      path: z.string().min(1),
    }).strict(),
  ])
);

export const PlaybookGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SafePlaybookIdSchema,
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    inputs: z.record(WorkflowInputDefinitionSchema).default({}),
    artifacts: z.record(PlaybookGraphArtifactSchema).default({}),
    capabilities: z.array(z.string().min(1)).default([]),
    limits: PlaybookGraphLimitsSchema,
    start: z.string().min(1),
    nodes: z.array(PlaybookGraphNodeSchema).min(1),
  })
  .strict();
export type PlaybookGraph = z.infer<typeof PlaybookGraphSchema>;

export const PlaybookGraphCompileMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    playbookId: SafePlaybookIdSchema,
    packageVersion: z.string().min(1),
    compilerVersion: z.string().min(1),
    graphSchemaVersion: z.literal(1),
    scriptSdkVersion: z.string().min(1),
    sourceHash: Sha256DigestSchema,
    graphHash: Sha256DigestSchema,
    compiledAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphCompileMetadata = z.infer<
  typeof PlaybookGraphCompileMetadataSchema
>;

export const CompiledPlaybookGraphSchema = z
  .object({
    graph: PlaybookGraphSchema,
    metadata: PlaybookGraphCompileMetadataSchema,
  })
  .strict();
export type CompiledPlaybookGraph = z.infer<typeof CompiledPlaybookGraphSchema>;
```

- [ ] **Step 2: Run the contract test**

Run:

```bash
bun test packages/contracts/src/playbook-graph.test.ts
```

Expected: pass.

- [ ] **Step 3: Run contracts typecheck**

Run:

```bash
bun run --filter './packages/contracts' typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Commit the contract slice**

Run:

```bash
git add packages/contracts/src/index.ts packages/contracts/src/playbook-graph.test.ts
git commit -m "feat(contracts): add playbook graph schema" \
  -m "Define the normalized graph contract that future playbook orchestration runtime work will execute." \
  -m "Constraint: Existing WorkflowDefinition playbooks remain unchanged in this slice
Constraint: Phase 1 scripts are TypeScript-only
Confidence: high
Scope-risk: moderate
Directive: Keep domain-specific scoring semantics out of the graph contract
Tested: bun test packages/contracts/src/playbook-graph.test.ts; bun run --filter './packages/contracts' typecheck
Not-tested: Runtime execution, because this commit only adds contracts"
```

---

## Task 3: Add Minimal Playbook SDK Authoring Helper

**Files:**

- Create: `packages/plugin-sdk/src/playbook.ts`
- Create: `packages/plugin-sdk/src/playbook.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`

- [ ] **Step 1: Write the failing SDK tests**

Create `packages/plugin-sdk/src/playbook.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test packages/plugin-sdk/src/playbook.test.ts
```

Expected: fail because `./playbook.js` does not exist.

- [ ] **Step 3: Implement `definePlaybook`**

Create `packages/plugin-sdk/src/playbook.ts`:

```ts
import { type PlaybookGraph, PlaybookGraphSchema } from "@tessera/contracts";

export function definePlaybook(graph: unknown): PlaybookGraph {
  return PlaybookGraphSchema.parse(graph);
}
```

- [ ] **Step 4: Export the helper**

Append this to `packages/plugin-sdk/src/index.ts`:

```ts
export { definePlaybook } from "./playbook.js";
export type { PlaybookGraph } from "@tessera/contracts";
```

- [ ] **Step 5: Run SDK tests and typecheck**

Run:

```bash
bun test packages/plugin-sdk/src/playbook.test.ts
bun run --filter './packages/plugin-sdk' typecheck
```

Expected: both commands exit code 0.

- [ ] **Step 6: Commit the SDK helper**

Run:

```bash
git add packages/plugin-sdk/src/index.ts packages/plugin-sdk/src/playbook.ts packages/plugin-sdk/src/playbook.test.ts
git commit -m "feat(plugin-sdk): add playbook graph authoring helper" \
  -m "Expose a small definePlaybook helper so external playbook source can produce the normalized graph contract without adding runtime execution semantics." \
  -m "Constraint: This is validation-only; external TypeScript module loading is out of scope
Rejected: Implement high-level DSL helpers now | normalized graph support is the foundation needed first
Confidence: high
Scope-risk: narrow
Directive: Keep SDK helpers thin until graph execution semantics are implemented
Tested: bun test packages/plugin-sdk/src/playbook.test.ts; bun run --filter './packages/plugin-sdk' typecheck
Not-tested: Importing an external playbook repo from disk"
```

---

## Task 4: Add Graph Validation And Hashing Tests

**Files:**

- Create: `packages/core/src/playbook-graph.test.ts`
- Modify later: `packages/core/src/playbook-graph.ts`

- [ ] **Step 1: Write failing tests for validation and hashing**

Create `packages/core/src/playbook-graph.test.ts`:

```ts
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
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        nodes: [graph.nodes[0], graph.nodes[0]],
      })
    ).toThrow(/Duplicate node id/);
  });

  test("rejects transitions to unknown nodes", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        nodes: [{ ...graph.nodes[0], onSuccess: "ghost" }],
      })
    ).toThrow(/Unknown transition/);
  });

  test("rejects output artifacts not declared by the graph", () => {
    expect(() =>
      validatePlaybookGraph({
        ...graph,
        nodes: [{ ...graph.nodes[0], outputArtifact: "ghost" }],
      })
    ).toThrow(/Unknown artifact/);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
bun test packages/core/src/playbook-graph.test.ts
```

Expected: fail because `playbook-graph.ts` does not exist.

---

## Task 5: Implement Graph Validation And Hashing

**Files:**

- Create: `packages/core/src/playbook-graph.ts`
- Test: `packages/core/src/playbook-graph.test.ts`

- [ ] **Step 1: Add graph helper implementation**

Create `packages/core/src/playbook-graph.ts`:

```ts
import { createHash } from "node:crypto";
import { type PlaybookGraph, PlaybookGraphSchema, type PlaybookGraphNode } from "@tessera/contracts";

const TERMINAL_GRAPH_STEPS = new Set(["completed", "failed", "denied"]);

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.keys(nested)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (nested as Record<string, unknown>)[key];
        return acc;
      }, {});
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashPlaybookGraph(graph: unknown): string {
  const parsed = PlaybookGraphSchema.parse(graph);
  return sha256(stableJsonStringify(parsed));
}

export function hashPlaybookSourceFiles(files: Record<string, string>): string {
  return sha256(stableJsonStringify(files));
}

function transitionTargets(node: PlaybookGraphNode): string[] {
  const targets = [node.onSuccess, node.onFailure].filter((value): value is string =>
    Boolean(value)
  );

  if (node.kind === "condition") {
    targets.push(node.onTrue, node.onFalse);
  }
  if (node.kind === "humanReview") {
    if (node.onApprove) targets.push(node.onApprove);
    if (node.onRequestChanges) targets.push(node.onRequestChanges);
  }

  return targets;
}

function outputArtifacts(node: PlaybookGraphNode): string[] {
  if (node.kind === "agent") return node.output?.artifact ? [node.output.artifact] : [];
  if (
    node.kind === "script" ||
    node.kind === "tool" ||
    node.kind === "parallelMap" ||
    node.kind === "join"
  ) {
    return node.outputArtifact ? [node.outputArtifact] : [];
  }
  return [];
}

function consumedArtifacts(node: PlaybookGraphNode): string[] {
  const values: unknown[] = [];

  if (node.kind === "parallelMap") values.push(node.items);
  if (node.kind === "condition") values.push(node.when);
  if (node.kind === "humanReview" || node.kind === "artifactWrite") values.push({ artifact: node.artifact });
  if (node.kind === "script" || node.kind === "agent") values.push(node.inputs);

  const artifacts: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.artifact === "string") artifacts.push(record.artifact);
    for (const nested of Object.values(record)) visit(nested);
  };

  for (const value of values) visit(value);
  return artifacts;
}

function validateNodeList(input: {
  artifacts: Set<string>;
  nodes: PlaybookGraphNode[];
  path: string;
  start: string;
}) {
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (nodeIds.has(node.id)) {
      throw new Error(`Duplicate node id at ${input.path}: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  if (!nodeIds.has(input.start)) {
    throw new Error(`Unknown start node at ${input.path}: ${input.start}`);
  }

  for (const node of input.nodes) {
    for (const target of transitionTargets(node)) {
      if (!nodeIds.has(target) && !TERMINAL_GRAPH_STEPS.has(target)) {
        throw new Error(`Unknown transition from ${input.path}.${node.id}: ${target}`);
      }
    }

    for (const artifact of outputArtifacts(node)) {
      if (!input.artifacts.has(artifact)) {
        throw new Error(`Unknown artifact produced by ${input.path}.${node.id}: ${artifact}`);
      }
    }

    for (const artifact of consumedArtifacts(node)) {
      if (!input.artifacts.has(artifact)) {
        throw new Error(`Unknown artifact consumed by ${input.path}.${node.id}: ${artifact}`);
      }
    }

    if (node.kind === "parallelMap") {
      validateNodeList({
        artifacts: input.artifacts,
        nodes: node.branch.nodes,
        path: `${input.path}.${node.id}.branch`,
        start: node.branch.start,
      });
    }
  }
}

export function validatePlaybookGraph(graph: unknown): PlaybookGraph {
  const parsed = PlaybookGraphSchema.parse(graph);
  validateNodeList({
    artifacts: new Set(Object.keys(parsed.artifacts)),
    nodes: parsed.nodes,
    path: parsed.id,
    start: parsed.start,
  });
  return parsed;
}
```

- [ ] **Step 2: Run graph helper tests**

Run:

```bash
bun test packages/core/src/playbook-graph.test.ts
```

Expected: pass.

- [ ] **Step 3: Run core typecheck**

Run:

```bash
bun run --filter './packages/core' typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Commit graph helpers**

Run:

```bash
git add packages/core/src/playbook-graph.ts packages/core/src/playbook-graph.test.ts
git commit -m "feat(core): validate and hash playbook graphs" \
  -m "Add deterministic graph validation and hashing helpers so compiled graph artifacts can be compared and cached safely." \
  -m "Constraint: This validates structure only; execution semantics belong to later runtime work
Rejected: Use JSON.stringify directly for graph hashes | object key order would make hashes unstable
Confidence: high
Scope-risk: moderate
Directive: Keep hash inputs stable and explicit before adding durable run memo keys
Tested: bun test packages/core/src/playbook-graph.test.ts; bun run --filter './packages/core' typecheck
Not-tested: Loading external playbook source from disk"
```

---

## Task 6: Add Compiler Metadata Tests

**Files:**

- Create: `packages/core/src/playbook-graph-compiler.test.ts`
- Modify later: `packages/core/src/playbook-graph-compiler.ts`

- [ ] **Step 1: Write failing compiler tests**

Create `packages/core/src/playbook-graph-compiler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { compilePlaybookGraph } from "./playbook-graph-compiler.js";

const graph = {
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "0.1.0",
  name: "SEO Blog Article",
  artifacts: {
    scorecard: { schema: "./schemas/scorecard.schema.json" },
  },
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
};

describe("compilePlaybookGraph", () => {
  test("returns parsed graph plus compile metadata", () => {
    const compiled = compilePlaybookGraph({
      graph,
      sourceFiles: {
        "playbook.ts": "export default definePlaybook({});\n",
        "scripts/score.ts": "export function score() { return {}; }\n",
      },
      compilerVersion: "0.1.0",
      scriptSdkVersion: "0.1.0",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });

    expect(compiled.graph.id).toBe("content.seo-blog");
    expect(compiled.metadata.playbookId).toBe("content.seo-blog");
    expect(compiled.metadata.packageVersion).toBe("0.1.0");
    expect(compiled.metadata.sourceHash.startsWith("sha256:")).toBe(true);
    expect(compiled.metadata.graphHash.startsWith("sha256:")).toBe(true);
  });

  test("changes sourceHash when source content changes", () => {
    const a = compilePlaybookGraph({
      graph,
      sourceFiles: { "playbook.ts": "a\n" },
      compilerVersion: "0.1.0",
      scriptSdkVersion: "0.1.0",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const b = compilePlaybookGraph({
      graph,
      sourceFiles: { "playbook.ts": "b\n" },
      compilerVersion: "0.1.0",
      scriptSdkVersion: "0.1.0",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });

    expect(a.metadata.sourceHash).not.toBe(b.metadata.sourceHash);
    expect(a.metadata.graphHash).toBe(b.metadata.graphHash);
  });

  test("changes graphHash when graph content changes", () => {
    const a = compilePlaybookGraph({
      graph,
      sourceFiles: { "playbook.ts": "same\n" },
      compilerVersion: "0.1.0",
      scriptSdkVersion: "0.1.0",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const b = compilePlaybookGraph({
      graph: { ...graph, name: "SEO Blog Article v2" },
      sourceFiles: { "playbook.ts": "same\n" },
      compilerVersion: "0.1.0",
      scriptSdkVersion: "0.1.0",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });

    expect(a.metadata.sourceHash).toBe(b.metadata.sourceHash);
    expect(a.metadata.graphHash).not.toBe(b.metadata.graphHash);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test packages/core/src/playbook-graph-compiler.test.ts
```

Expected: fail because `playbook-graph-compiler.ts` does not exist.

---

## Task 7: Implement Compile Metadata

**Files:**

- Create: `packages/core/src/playbook-graph-compiler.ts`
- Test: `packages/core/src/playbook-graph-compiler.test.ts`

- [ ] **Step 1: Implement compiler helper**

Create `packages/core/src/playbook-graph-compiler.ts`:

```ts
import {
  type CompiledPlaybookGraph,
  CompiledPlaybookGraphSchema,
  type PlaybookGraph,
} from "@tessera/contracts";
import { hashPlaybookGraph, hashPlaybookSourceFiles, validatePlaybookGraph } from "./playbook-graph.js";

export interface CompilePlaybookGraphOptions {
  graph: unknown;
  sourceFiles: Record<string, string>;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

export function compilePlaybookGraph(options: CompilePlaybookGraphOptions): CompiledPlaybookGraph {
  const graph: PlaybookGraph = validatePlaybookGraph(options.graph);
  return CompiledPlaybookGraphSchema.parse({
    graph,
    metadata: {
      schemaVersion: 1,
      playbookId: graph.id,
      packageVersion: graph.version,
      compilerVersion: options.compilerVersion,
      graphSchemaVersion: 1,
      scriptSdkVersion: options.scriptSdkVersion,
      sourceHash: hashPlaybookSourceFiles(options.sourceFiles),
      graphHash: hashPlaybookGraph(graph),
      compiledAt: options.compiledAt ?? new Date().toISOString(),
    },
  });
}
```

- [ ] **Step 2: Run compiler tests**

Run:

```bash
bun test packages/core/src/playbook-graph-compiler.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit compiler helper**

Run:

```bash
git add packages/core/src/playbook-graph-compiler.ts packages/core/src/playbook-graph-compiler.test.ts
git commit -m "feat(core): compile playbook graph metadata" \
  -m "Create a compile helper that validates normalized graphs and records source, graph, compiler, and SDK fingerprints for cache invalidation." \
  -m "Constraint: The helper accepts an already-produced graph object; external TypeScript loading is a later import/install concern
Rejected: Derive graph hash from source hash | runtime resume needs the normalized graph identity independently
Confidence: high
Scope-risk: narrow
Directive: Preserve graphHash/sourceHash separation for future durable run snapshots
Tested: bun test packages/core/src/playbook-graph-compiler.test.ts
Not-tested: Filesystem cache persistence"
```

---

## Task 8: Add Filesystem Cache Tests

**Files:**

- Create: `packages/core/src/playbook-graph-cache.test.ts`
- Modify later: `packages/core/src/playbook-graph-cache.ts`

- [ ] **Step 1: Write failing cache tests**

Create `packages/core/src/playbook-graph-cache.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePlaybookGraph } from "./playbook-graph-compiler.js";
import { createPlaybookGraphCache } from "./playbook-graph-cache.js";

const graph = {
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "0.1.0",
  name: "SEO Blog Article",
  artifacts: {
    scorecard: { schema: "./schemas/scorecard.schema.json" },
  },
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
};

function compiled() {
  return compilePlaybookGraph({
    graph,
    sourceFiles: { "playbook.ts": "export default {};\n" },
    compilerVersion: "0.1.0",
    scriptSdkVersion: "0.1.0",
    compiledAt: "2026-05-15T00:00:00.000Z",
  });
}

describe("createPlaybookGraphCache", () => {
  test("saves and reads a compiled graph by graph hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const artifact = compiled();

    await cache.save(artifact);
    const loaded = await cache.get(artifact.metadata.playbookId, artifact.metadata.graphHash);

    expect(loaded?.metadata.graphHash).toBe(artifact.metadata.graphHash);
    expect(loaded?.graph.id).toBe("content.seo-blog");
  });

  test("updates latest pointer on save", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const artifact = compiled();

    await cache.save(artifact);
    const latest = await cache.getLatest("content.seo-blog");

    expect(latest?.metadata.graphHash).toBe(artifact.metadata.graphHash);
  });

  test("writes JSON with a stable newline for reviewability", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);
    const artifact = compiled();

    const savedPath = await cache.save(artifact);
    const text = await readFile(savedPath, "utf8");

    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).metadata.graphHash).toBe(artifact.metadata.graphHash);
  });

  test("returns undefined for missing cache entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const cache = createPlaybookGraphCache(root);

    expect(await cache.get("content.seo-blog", "sha256:missing")).toBeUndefined();
    expect(await cache.getLatest("content.seo-blog")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test packages/core/src/playbook-graph-cache.test.ts
```

Expected: fail because `playbook-graph-cache.ts` does not exist.

---

## Task 9: Implement Filesystem Compile Cache

**Files:**

- Create: `packages/core/src/playbook-graph-cache.ts`
- Test: `packages/core/src/playbook-graph-cache.test.ts`

- [ ] **Step 1: Implement graph cache**

Create `packages/core/src/playbook-graph-cache.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CompiledPlaybookGraph,
  CompiledPlaybookGraphSchema,
  PlaybookGraphCompileMetadataSchema,
} from "@tessera/contracts";

function cacheSegment(value: string): string {
  return encodeURIComponent(value);
}

function artifactPath(root: string, playbookId: string, graphHash: string): string {
  return join(root, cacheSegment(playbookId), `${cacheSegment(graphHash)}.json`);
}

function latestPath(root: string, playbookId: string): string {
  return join(root, cacheSegment(playbookId), "latest.json");
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export interface PlaybookGraphCache {
  get(playbookId: string, graphHash: string): Promise<CompiledPlaybookGraph | undefined>;
  getLatest(playbookId: string): Promise<CompiledPlaybookGraph | undefined>;
  save(compiled: CompiledPlaybookGraph): Promise<string>;
}

export function createPlaybookGraphCache(root: string): PlaybookGraphCache {
  return {
    async get(playbookId, graphHash) {
      const raw = await readJsonFile(artifactPath(root, playbookId, graphHash));
      return raw ? CompiledPlaybookGraphSchema.parse(raw) : undefined;
    },
    async getLatest(playbookId) {
      const latest = await readJsonFile(latestPath(root, playbookId));
      if (!latest) return undefined;
      const metadata = PlaybookGraphCompileMetadataSchema.parse(latest);
      return this.get(playbookId, metadata.graphHash);
    },
    async save(compiled) {
      const parsed = CompiledPlaybookGraphSchema.parse(compiled);
      const playbookDir = join(root, cacheSegment(parsed.metadata.playbookId));
      await mkdir(playbookDir, { recursive: true });

      const path = artifactPath(root, parsed.metadata.playbookId, parsed.metadata.graphHash);
      await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await writeFile(
        latestPath(root, parsed.metadata.playbookId),
        `${JSON.stringify(parsed.metadata, null, 2)}\n`,
        "utf8"
      );
      return path;
    },
  };
}
```

- [ ] **Step 2: Run cache tests**

Run:

```bash
bun test packages/core/src/playbook-graph-cache.test.ts
```

Expected: pass.

- [ ] **Step 3: Run all playbook graph core tests**

Run:

```bash
bun test packages/core/src/playbook-graph.test.ts packages/core/src/playbook-graph-compiler.test.ts packages/core/src/playbook-graph-cache.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit cache implementation**

Run:

```bash
git add packages/core/src/playbook-graph-cache.ts packages/core/src/playbook-graph-cache.test.ts
git commit -m "feat(core): cache compiled playbook graphs" \
  -m "Persist compiled graph artifacts by content hash so install/startup can reuse validated graph packages without treating the install cache as durable run truth." \
  -m "Constraint: This cache is not the future run snapshot store
Rejected: Store only a latest pointer | durable resume needs addressable graph artifacts by hash
Confidence: high
Scope-risk: narrow
Directive: Future run records must pin graphHash or a copied graph snapshot, not depend only on latest.json
Tested: bun test packages/core/src/playbook-graph.test.ts packages/core/src/playbook-graph-compiler.test.ts packages/core/src/playbook-graph-cache.test.ts
Not-tested: Sidecar import/install integration"
```

---

## Task 10: Export Core Graph APIs

**Files:**

- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/playbook-graph.test.ts`, `packages/core/src/playbook-graph-compiler.test.ts`, `packages/core/src/playbook-graph-cache.test.ts`

- [ ] **Step 1: Export graph helpers from core**

Append this to `packages/core/src/index.ts`:

```ts
export {
  hashPlaybookGraph,
  hashPlaybookSourceFiles,
  stableJsonStringify,
  validatePlaybookGraph,
} from "./playbook-graph.js";
export { compilePlaybookGraph, type CompilePlaybookGraphOptions } from "./playbook-graph-compiler.js";
export { createPlaybookGraphCache, type PlaybookGraphCache } from "./playbook-graph-cache.js";
```

- [ ] **Step 2: Run package typechecks**

Run:

```bash
bun run --filter './packages/contracts' typecheck
bun run --filter './packages/plugin-sdk' typecheck
bun run --filter './packages/core' typecheck
```

Expected: all exit code 0.

- [ ] **Step 3: Commit exports**

Run:

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export playbook graph compile APIs" \
  -m "Expose graph validation, hashing, compilation, and cache helpers for future sidecar install and runtime work." \
  -m "Constraint: Public exports are still low-level foundation APIs
Confidence: high
Scope-risk: narrow
Directive: Keep runtime execution separate from compile/cache helpers
Tested: bun run --filter './packages/contracts' typecheck; bun run --filter './packages/plugin-sdk' typecheck; bun run --filter './packages/core' typecheck
Not-tested: Desktop or sidecar UI flows"
```

---

## Task 11: Final Verification

**Files:**

- All files changed in Tasks 1-10.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
bun test packages/contracts/src/playbook-graph.test.ts
bun test packages/plugin-sdk/src/playbook.test.ts
bun test packages/core/src/playbook-graph.test.ts packages/core/src/playbook-graph-compiler.test.ts packages/core/src/playbook-graph-cache.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run full repository check**

Run:

```bash
bun run check
```

Expected: Biome and every workspace typecheck exit code 0.

- [ ] **Step 3: Commit any final plan-following fixes**

If Step 1 or Step 2 required follow-up edits, commit them with:

```bash
git add packages/contracts/src/index.ts packages/plugin-sdk/src/index.ts packages/plugin-sdk/src/playbook.ts packages/core/src/index.ts packages/core/src/playbook-graph.ts packages/core/src/playbook-graph-compiler.ts packages/core/src/playbook-graph-cache.ts packages/contracts/src/playbook-graph.test.ts packages/plugin-sdk/src/playbook.test.ts packages/core/src/playbook-graph.test.ts packages/core/src/playbook-graph-compiler.test.ts packages/core/src/playbook-graph-cache.test.ts
git commit -m "fix(playbooks): align graph compiler foundation" \
  -m "Resolve issues found during final verification of the playbook graph compiler cache foundation." \
  -m "Confidence: high
Scope-risk: narrow
Tested: bun test packages/contracts/src/playbook-graph.test.ts; bun test packages/plugin-sdk/src/playbook.test.ts; bun test packages/core/src/playbook-graph.test.ts packages/core/src/playbook-graph-compiler.test.ts packages/core/src/playbook-graph-cache.test.ts; bun run check
Not-tested: Runtime execution, deferred to the durable orchestrator plan"
```

Skip this commit if no final fixes were needed.

---

## Self-Review

**Spec coverage:**

- Covers normalized graph contract.
- Covers TypeScript-only Phase 1 script shape.
- Covers minimal SDK authoring surface.
- Covers graph/source hashing and compile metadata.
- Covers filesystem cache as install/startup optimization.
- Excludes durable run snapshots, node memo keys, script sandbox enforcement, human review UI, dynamic import, and SEO/GEO reference implementation because those belong to later plans.

**Placeholder scan:**

- The plan uses concrete file paths, test commands, expected results, and code snippets.
- There are no unresolved placeholder markers.

**Type consistency:**

- Contract type names are `PlaybookGraph`, `PlaybookGraphNode`, `PlaybookGraphCompileMetadata`, and `CompiledPlaybookGraph`.
- Core helper names are `validatePlaybookGraph`, `hashPlaybookGraph`, `hashPlaybookSourceFiles`, `compilePlaybookGraph`, and `createPlaybookGraphCache`.
- SDK helper name is `definePlaybook`.

**Known implementation risks for the worker:**

- Recursive Zod schemas can be awkward with strict TypeScript. If the `PlaybookGraphNodeSchema` type annotation needs adjustment, preserve the public `PlaybookGraphNode` type and keep the tests unchanged.
- `error.code` narrowing in `readJsonFile()` may need a local helper if TypeScript complains. Keep behavior identical: return `undefined` only for `ENOENT`, rethrow all other errors.
- The current cache is not a durable run store. Do not let later runtime work depend on `latest.json` for in-flight run recovery.
