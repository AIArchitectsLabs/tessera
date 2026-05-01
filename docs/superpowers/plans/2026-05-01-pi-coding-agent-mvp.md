# Pi Coding Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace Tessera's simulated task execution with a Pi Coding Agent-backed MVP that keeps tools scoped to the selected workspace.

**Architecture:** Add a narrow Pi session adapter in `packages/core`, workspace path guards around custom file tools, and sidecar task-runner integration that maps Pi events into existing task events. Tessera remains responsible for task persistence, credential delivery, and workspace policy.

**Tech Stack:** Bun workspaces, TypeScript, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, Zod, Bun test, SQLite task store.

---

### Task 1: Dependency And SDK Shape

**Files:**
- Modify: `packages/core/package.json`
- Modify: `bun.lock`

- [x] **Step 1: Add Pi Coding Agent dependency**

Run:

```bash
bun add @mariozechner/pi-coding-agent --filter @tessera/core
```

Expected: `packages/core/package.json` gains `@mariozechner/pi-coding-agent`, and `bun.lock` updates.

- [x] **Step 2: Inspect installed SDK exports**

Run:

```bash
find node_modules/@mariozechner/pi-coding-agent -maxdepth 3 -type f | sort | head -80
```

Then inspect the package entrypoint and declarations to confirm exact exports before writing adapter code.

### Task 2: Workspace Guard

**Files:**
- Create: `packages/core/src/workspace-guard.ts`
- Create: `packages/core/src/workspace-guard.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1: Write path containment tests**

Create tests for canonical workspace roots, missing roots, inside paths, `..` traversal, absolute outside paths, and symlink escape.

- [x] **Step 2: Implement workspace guard**

Implement `createWorkspaceGuard(workspaceRoot)` returning `resolveInsideWorkspace(inputPath)` and `isInsideWorkspace(inputPath)`.

- [x] **Step 3: Export guard**

Export from `packages/core/src/index.ts`.

- [x] **Step 4: Verify**

Run:

```bash
bun test packages/core/src/workspace-guard.test.ts
```

Expected: all guard tests pass.

### Task 3: Workspace File Tools

**Files:**
- Create: `packages/core/src/workspace-tools.ts`
- Create: `packages/core/src/workspace-tools.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1: Write tool tests**

Cover read/list/search inside workspace, write/edit inside workspace, outside-workspace denial, and bash disabled.

- [x] **Step 2: Implement custom tools**

Expose custom Pi-compatible tools that call filesystem APIs only after workspace guard validation. Do not register Pi default filesystem or bash tools raw.

- [x] **Step 3: Verify**

Run:

```bash
bun test packages/core/src/workspace-tools.test.ts
```

Expected: workspace-contained write/edit succeeds, outside access is denied, bash is unavailable.

### Task 4: Pi Session Adapter

**Files:**
- Create: `packages/core/src/pi-session.ts`
- Create: `packages/core/src/pi-session.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1: Write adapter tests with injectable session factory**

Use a fake Pi session factory to verify prompt execution, event mapping, final text capture, and model credential preflight errors without calling an external model.

- [x] **Step 2: Implement adapter**

Create `runPiTaskTurn` or equivalent that accepts workspace root, prompt, provider config, optional credential, and event callbacks. Use Pi SDK only through this file.

- [x] **Step 3: Verify**

Run:

```bash
bun test packages/core/src/pi-session.test.ts
```

Expected: adapter tests pass without network.

### Task 5: Sidecar Task Runner Integration

**Files:**
- Modify: `apps/sidecar/src/task-runner.ts`
- Modify: `apps/sidecar/src/task-runner.test.ts`

- [x] **Step 1: Update tests**

Change tests from simulated "Researching/Drafting" output to injected Pi runner behavior that produces agent text and artifacts.

- [x] **Step 2: Wire runner**

Use the core adapter from the sidecar task runner. Keep task persistence in the existing `TaskStore`.

- [x] **Step 3: Verify**

Run:

```bash
bun test apps/sidecar/src/task-runner.test.ts
```

Expected: task events still stream in order, but final agent content comes from the injected Pi runner.

### Task 6: Full Verification

**Files:**
- All changed implementation and tests

- [x] **Step 1: Run package tests**

```bash
bun run --filter @tessera/core test
bun run --filter @tessera/sidecar test
```

- [x] **Step 2: Run full check**

```bash
bun run check
```

- [x] **Step 3: Commit**

Commit with Lore trailers that capture the Pi SDK constraints, workspace boundary, tests run, and any unimplemented follow-up such as workflow agent steps.
