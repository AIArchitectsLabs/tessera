# Browser Runtime And Learning Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Tessera's first real browser executor: isolated, Playwright-backed, read-only browser inspection with screenshot artifacts and draft recipe proposal scaffolding.

**Architecture:** Keep browser contracts and recipe schemas neutral in `packages/contracts` and `packages/core`. Put the Playwright dependency and production executor in `apps/sidecar`, then inject that executor into task runs. Store screenshots and draft recipe data under sidecar-controlled app-data directories.

**Tech Stack:** Bun, TypeScript, Zod, Playwright, existing Pi task tools, existing sidecar task artifacts.

---

## File Structure

- `packages/contracts/src/index.ts`: add browser recipe proposal schemas and a browser error result shape that still fits `BrowserToolResult.metadata`.
- `packages/contracts/src/task.test.ts`: contract coverage for browser recipe proposals.
- `packages/core/src/browser-recipes.ts`: data-first recipe proposal builder with no Playwright dependency.
- `packages/core/src/browser-recipes.test.ts`: unit coverage for draft recipe creation and mutation permission inference.
- `packages/core/src/pi-session.ts`: accept and expose a browser executor in task mode.
- `packages/core/src/index.ts`: export recipe helpers.
- `apps/sidecar/src/browser-runtime.ts`: Playwright-backed `BrowserExecutor` implementation and session store.
- `apps/sidecar/src/browser-runtime.test.ts`: integration tests using a local `Bun.serve` page.
- `apps/sidecar/src/task-runner.ts`: pass browser executor into `runPiTaskTurn` and create screenshot/recipe artifacts from browser tool results.
- `apps/sidecar/src/task-runner.test.ts`: coverage for browser artifact creation.
- `apps/sidecar/src/server.ts`: construct the browser executor with app-data paths and dispose it on shutdown.
- `apps/sidecar/package.json`: add `playwright` dependency.

## Task 1: Add Browser Recipe Contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/task.test.ts`

- [ ] **Step 1: Write the failing contract test**

Add this test to `packages/contracts/src/task.test.ts`:

```ts
test("accepts draft browser recipe proposal contracts", () => {
  const parsed = BrowserRecipeProposalSchema.parse({
    id: "recipe-1",
    status: "draft",
    domain: "example.com",
    goal: "Inspect Example",
    source: { taskId: "task-1", sessionId: "session-1" },
    permissions: ["browser.read"],
    steps: [
      {
        action: "open",
        url: "https://example.com",
        expectedState: "Example Domain page is visible",
      },
      {
        action: "see",
        expectedState: "Readable page text is extracted",
      },
    ],
    artifacts: [{ title: "Screenshot", path: "/tmp/example.png" }],
    createdAt: "2026-05-10T00:00:00.000Z",
  });

  expect(parsed.status).toBe("draft");
  expect(parsed.permissions).toEqual(["browser.read"]);
});
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `bun test packages/contracts/src/task.test.ts`

Expected: FAIL with `BrowserRecipeProposalSchema` not exported.

- [ ] **Step 3: Add the recipe schemas**

Add these exports near the browser tool schemas in `packages/contracts/src/index.ts`:

```ts
export const BrowserRecipeStatusSchema = z.enum(["draft", "reviewed", "approved_for_action", "stale"]);
export type BrowserRecipeStatus = z.infer<typeof BrowserRecipeStatusSchema>;

export const BrowserRecipePermissionSchema = z.enum(["browser.read", "browser.action", "browser.eval"]);
export type BrowserRecipePermission = z.infer<typeof BrowserRecipePermissionSchema>;

export const BrowserRecipeStepSchema = z.object({
  action: BrowserActionSchema,
  url: z.string().url().optional(),
  selector: z.string().min(1).optional(),
  text: z.string().optional(),
  expectedState: z.string().min(1).optional(),
  fallbackLabel: z.string().min(1).optional(),
});
export type BrowserRecipeStep = z.infer<typeof BrowserRecipeStepSchema>;

export const BrowserRecipeProposalSchema = z.object({
  id: z.string().min(1),
  status: BrowserRecipeStatusSchema,
  domain: z.string().min(1),
  goal: z.string().min(1),
  source: z.object({
    taskId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  permissions: z.array(BrowserRecipePermissionSchema),
  steps: z.array(BrowserRecipeStepSchema).min(1),
  artifacts: z.array(
    z.object({
      title: z.string().min(1),
      path: z.string().min(1),
    })
  ).default([]),
  createdAt: z.string().datetime(),
  lastVerifiedAt: z.string().datetime().optional(),
});
export type BrowserRecipeProposal = z.infer<typeof BrowserRecipeProposalSchema>;
```

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `bun test packages/contracts/src/task.test.ts`

Expected: PASS.

## Task 2: Add Data-First Recipe Proposal Builder

**Files:**
- Create: `packages/core/src/browser-recipes.ts`
- Create: `packages/core/src/browser-recipes.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing recipe tests**

Create `packages/core/src/browser-recipes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildBrowserRecipeProposal } from "./browser-recipes.js";

describe("buildBrowserRecipeProposal", () => {
  test("builds a read-only draft recipe from successful browser actions", () => {
    const proposal = buildBrowserRecipeProposal({
      goal: "Inspect Example",
      sessionId: "session-1",
      taskId: "task-1",
      createdAt: "2026-05-10T00:00:00.000Z",
      actions: [
        { action: "open", url: "https://example.com" },
        { action: "see", url: "https://example.com", expectedState: "Example Domain" },
      ],
      artifacts: [{ title: "Screenshot", path: "/tmp/example.png" }],
    });

    expect(proposal.domain).toBe("example.com");
    expect(proposal.status).toBe("draft");
    expect(proposal.permissions).toEqual(["browser.read"]);
    expect(proposal.steps).toHaveLength(2);
  });

  test("marks click and type recipes as action recipes", () => {
    const proposal = buildBrowserRecipeProposal({
      goal: "Search Example",
      sessionId: "session-1",
      createdAt: "2026-05-10T00:00:00.000Z",
      actions: [
        { action: "open", url: "https://example.com" },
        { action: "click", selector: "button.search", expectedState: "Search opens" },
        { action: "type", selector: "input", text: "tessera" },
      ],
      artifacts: [],
    });

    expect(proposal.permissions).toEqual(["browser.read", "browser.action"]);
  });
});
```

- [ ] **Step 2: Run the recipe tests to verify they fail**

Run: `bun test packages/core/src/browser-recipes.test.ts`

Expected: FAIL because `browser-recipes.ts` does not exist.

- [ ] **Step 3: Implement the recipe builder**

Create `packages/core/src/browser-recipes.ts`:

```ts
import type {
  BrowserAction,
  BrowserRecipePermission,
  BrowserRecipeProposal,
  BrowserRecipeStep,
} from "@tessera/contracts";
import { BrowserRecipeProposalSchema } from "@tessera/contracts";

export interface BrowserRecipeActionInput {
  action: BrowserAction;
  url?: string;
  selector?: string;
  text?: string;
  expectedState?: string;
  fallbackLabel?: string;
}

export interface BuildBrowserRecipeProposalInput {
  goal: string;
  sessionId?: string;
  taskId?: string;
  createdAt?: string;
  actions: BrowserRecipeActionInput[];
  artifacts: Array<{ title: string; path: string }>;
}

const ACTION_PERMISSIONS = new Set<BrowserAction>(["click", "type", "select"]);

function domainFromActions(actions: BrowserRecipeActionInput[]): string {
  const firstUrl = actions.find((action) => action.url)?.url;
  if (!firstUrl) return "unknown";
  return new URL(firstUrl).hostname;
}

function permissionsFor(actions: BrowserRecipeActionInput[]): BrowserRecipePermission[] {
  const permissions: BrowserRecipePermission[] = ["browser.read"];
  if (actions.some((action) => ACTION_PERMISSIONS.has(action.action))) {
    permissions.push("browser.action");
  }
  if (actions.some((action) => action.action === "eval")) {
    permissions.push("browser.eval");
  }
  return permissions;
}

function stepFromAction(action: BrowserRecipeActionInput): BrowserRecipeStep {
  const step: BrowserRecipeStep = { action: action.action };
  if (action.url) step.url = action.url;
  if (action.selector) step.selector = action.selector;
  if (action.text !== undefined) step.text = action.text;
  if (action.expectedState) step.expectedState = action.expectedState;
  if (action.fallbackLabel) step.fallbackLabel = action.fallbackLabel;
  return step;
}

export function buildBrowserRecipeProposal(
  input: BuildBrowserRecipeProposalInput
): BrowserRecipeProposal {
  const domain = domainFromActions(input.actions);
  const sessionSuffix = input.sessionId ?? "session";
  return BrowserRecipeProposalSchema.parse({
    id: `recipe-${domain}-${sessionSuffix}`.replace(/[^a-zA-Z0-9._-]/g, "-"),
    status: "draft",
    domain,
    goal: input.goal.trim(),
    source: {
      taskId: input.taskId,
      sessionId: input.sessionId,
    },
    permissions: permissionsFor(input.actions),
    steps: input.actions.map(stepFromAction),
    artifacts: input.artifacts,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Export recipe helpers**

Add to `packages/core/src/index.ts`:

```ts
export {
  buildBrowserRecipeProposal,
  type BrowserRecipeActionInput,
  type BuildBrowserRecipeProposalInput,
} from "./browser-recipes.js";
```

- [ ] **Step 5: Run the recipe tests to verify they pass**

Run: `bun test packages/core/src/browser-recipes.test.ts`

Expected: PASS.

## Task 3: Expose Browser Tool In Pi Task Mode

**Files:**
- Modify: `packages/core/src/pi-session.ts`
- Modify: `packages/core/src/pi-session.test.ts`
- Modify: `apps/sidecar/src/task-runner.ts`

- [ ] **Step 1: Write the failing Pi session test**

Add a test in `packages/core/src/pi-session.test.ts` that passes a fake browser executor and asserts the `browser` tool appears in the custom tool names passed to the fake session factory.

- [ ] **Step 2: Run the Pi session test to verify it fails**

Run: `bun test packages/core/src/pi-session.test.ts`

Expected: FAIL because `RunPiTaskTurnOptions` does not accept `browser`.

- [ ] **Step 3: Implement browser tool definition in Pi task mode**

In `packages/core/src/pi-session.ts`, import `BrowserActionInput`, `BrowserToolResult`, and `BrowserActionInputSchema`, add `browser?: BrowserExecutor` to `RunPiTaskTurnOptions`, and add a `createBrowserToolDefinition(browser?: BrowserExecutor)` function that parses args with `BrowserActionInputSchema` and returns `BrowserToolResult` content.

- [ ] **Step 4: Include browser tools in custom tools**

Add `const browserTools = createBrowserToolDefinition(options.browser);` and include it in `toolDefinitions` before filtering allowed tools.

- [ ] **Step 5: Thread browser executor through task runner options**

In `apps/sidecar/src/task-runner.ts`, add `browser?: BrowserExecutor` to `RunTaskTurnOptions`, add `browser?: BrowserExecutor` to the `piRunner` option shape, and pass `...(opts.browser ? { browser: opts.browser } : {})` into `piRunner`.

- [ ] **Step 6: Run tests**

Run: `bun test packages/core/src/pi-session.test.ts apps/sidecar/src/task-runner.test.ts`

Expected: PASS.

## Task 4: Implement Sidecar Playwright Browser Runtime

**Files:**
- Create: `apps/sidecar/src/browser-runtime.ts`
- Create: `apps/sidecar/src/browser-runtime.test.ts`
- Modify: `apps/sidecar/package.json`

- [ ] **Step 1: Add Playwright dependency**

Run: `bun add --filter @tessera/sidecar playwright`

Expected: `apps/sidecar/package.json` gains `playwright`.

- [ ] **Step 2: Write failing runtime tests**

Create `apps/sidecar/src/browser-runtime.test.ts` with local server tests for `open`, `see`, `snap`, `reload`, `back`, `close`, invalid URL, and unsupported `click`.

- [ ] **Step 3: Run runtime tests to verify they fail**

Run: `bun test apps/sidecar/src/browser-runtime.test.ts`

Expected: FAIL because `browser-runtime.ts` does not exist.

- [ ] **Step 4: Implement runtime**

Create `apps/sidecar/src/browser-runtime.ts` with:

- `createPlaywrightBrowserExecutor(options)`
- lazy Chromium launch with persistent context
- in-memory page/session maps
- controlled screenshot path creation
- visible text extraction with length cap
- unsupported action errors for `click`, `type`, `select`, and `eval`
- `dispose()`

- [ ] **Step 5: Run runtime tests**

Run: `bun test apps/sidecar/src/browser-runtime.test.ts`

Expected: PASS when Playwright can launch Chromium. If Chromium is not installed, tests should skip with a clear message.

## Task 5: Wire Browser Runtime Into Sidecar Tasks

**Files:**
- Modify: `apps/sidecar/src/server.ts`
- Modify: `apps/sidecar/src/task-runner.ts`
- Modify: `apps/sidecar/src/task-runner.test.ts`

- [ ] **Step 1: Create the executor in the sidecar**

In `apps/sidecar/src/server.ts`, create a browser executor using app-data paths:

- profile: `~/.tessera/browser-profile`
- artifacts: `~/.tessera/browser-artifacts`
- recipes: `~/.tessera/browser-recipes`

- [ ] **Step 2: Dispose browser executor on exit**

Call `browserExecutor.dispose()` from the existing exit handler.

- [ ] **Step 3: Pass the executor into `runTaskTurn`**

Every `runTaskTurn` call in `server.ts` should include `browser: browserExecutor`.

- [ ] **Step 4: Emit screenshot and recipe artifacts**

In `task-runner.ts`, when a browser tool result includes `screenshotPath`, create a `file` artifact. When a browser tool result includes `metadata.recipeProposal`, create a `text` artifact with the serialized recipe proposal.

- [ ] **Step 5: Run task runner tests**

Run: `bun test apps/sidecar/src/task-runner.test.ts`

Expected: PASS.

## Task 6: Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test packages/contracts/src/task.test.ts packages/core/src/browser-recipes.test.ts packages/core/src/pi-session.test.ts apps/sidecar/src/browser-runtime.test.ts apps/sidecar/src/task-runner.test.ts
```

Expected: PASS or browser runtime tests skipped only when Chromium is unavailable.

- [ ] **Step 2: Run sidecar typecheck**

Run: `bun run --filter ./apps/sidecar typecheck`

Expected: PASS.

- [ ] **Step 3: Run core and contracts typecheck**

Run: `bun run --filter ./packages/core typecheck && bun run --filter ./packages/contracts typecheck`

Expected: PASS.

