# Pi Session Context And Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the resolved agent profile through to the Pi session, add full conversation history on task continuation, and surface workspace boundary violations as task `waiting` status.

**Architecture:** Three sequential changes, each test-first. Task 1 adds an `onViolation` callback option to `createWorkspaceToolDefinitions`. Task 2 extends `runPiTaskTurn` with `conversationHistory`, `boundaryViolations` tracking, and renames `withAgentInstructions` → `buildPrompt`. Task 3 updates the sidecar task runner to forward `agent`, build history from prior turns, and branch on `boundaryViolations`.

**Tech Stack:** Bun workspaces, TypeScript strict, `@mariozechner/pi-coding-agent`, Bun test, SQLite task store.

---

## File Structure

- `packages/core/src/workspace-tools.ts` — add optional `onViolation` callback to `createWorkspaceToolDefinitions`; call it in each tool when `WorkspaceBoundaryError` is caught
- `packages/core/src/workspace-tools.test.ts` — add test for `onViolation` firing on boundary denial
- `packages/core/src/pi-session.ts` — add `conversationHistory?` to `RunPiTaskTurnOptions`; add `boundaryViolations: number` to `PiTaskTurnResult`; rename `withAgentInstructions` → `buildPrompt`; pass `onViolation` to workspace tools
- `packages/core/src/pi-session.test.ts` — add tests for prompt assembly order and `boundaryViolations: 0` in happy path
- `apps/sidecar/src/task-runner.ts` — add `agent?` + `conversationHistory?` to `piRunner` callback type; forward `execution.agent`; build history from prior completed turns; branch `waiting` vs `done` on `result.boundaryViolations`
- `apps/sidecar/src/task-runner.test.ts` — add tests for agent forwarding, history on continuation, no history on first turn, `waiting` on violations, `done` on no violations; update existing piRunner stubs to include `boundaryViolations: 0`

---

### Task 1: Workspace Tools — `onViolation` Callback

**Files:**
- Modify: `packages/core/src/workspace-tools.ts`
- Modify: `packages/core/src/workspace-tools.test.ts`

- [ ] **Step 1: Add failing test**

In `packages/core/src/workspace-tools.test.ts`, add inside the `describe("createWorkspaceToolDefinitions", ...)` block:

```ts
test("calls onViolation when a tool is denied outside the workspace", async () => {
  const root = await realpath(await mkdtemp("/tmp/tessera-wt-violation-"));
  const guard = await createWorkspaceGuard(root);
  const violations: string[] = [];
  const tools = createWorkspaceToolDefinitions(guard, {
    onViolation: (toolName) => violations.push(toolName),
  });

  await expect(
    tool(tools, "workspace_write").execute(
      "call-1",
      { path: "../outside.txt", content: "x\n" },
      undefined,
      undefined,
      undefined as never
    )
  ).rejects.toThrow("outside the workspace");

  expect(violations).toEqual(["workspace_write"]);
});
```

Run:

```bash
bun test packages/core/src/workspace-tools.test.ts
```

Expected: FAIL — `createWorkspaceToolDefinitions` does not accept a second argument.

- [ ] **Step 2: Add `onViolation` option to `createWorkspaceToolDefinitions`**

Replace the signature and update each tool in `packages/core/src/workspace-tools.ts`:

```ts
export function createWorkspaceToolDefinitions(
  guard: WorkspaceGuard,
  options?: { onViolation?: (toolName: string) => void }
): ToolDefinition[] {
```

Update `workspace_read` execute:

```ts
async execute(_toolCallId, params: Static<typeof pathSchema>) {
  let absolute: string;
  try {
    absolute = await guard.resolveInsideWorkspace(params.path);
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_read");
    throw error;
  }
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`Path is not a file: ${params.path}`);
  const text = await readFile(absolute, "utf8");
  return textResult(text, { path: relative(guard.root, absolute) });
},
```

Update `workspace_list` execute:

```ts
async execute(_toolCallId, params: Static<typeof pathSchema>) {
  let absolute: string;
  try {
    absolute = await guard.resolveInsideWorkspace(params.path);
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_list");
    throw error;
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  const names = entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort();
  return textResult(names.join("\n"), { path: relative(guard.root, absolute), entries: names });
},
```

Update `workspace_search` execute:

```ts
async execute(_toolCallId, params: Static<typeof searchSchema>) {
  let base: string;
  try {
    base = await guard.resolveInsideWorkspace(params.path ?? ".");
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_search");
    throw error;
  }
  const matches: string[] = [];
  for (const file of await walkFiles(guard.root, base)) {
    const absolute = await guard.resolveInsideWorkspace(file);
    const text = await readFile(absolute, "utf8").catch(() => "");
    if (text.includes(params.query)) matches.push(file);
  }
  return textResult(matches.join("\n"), { query: params.query, matches });
},
```

Update `workspace_write` execute:

```ts
async execute(_toolCallId, params: Static<typeof writeSchema>) {
  const absolute = await guard
    .resolveInsideWorkspaceForCreate(params.path)
    .catch((error) => {
      if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_write");
      denied(params.path);
    });
  await writeFile(absolute, params.content, "utf8");
  return textResult(`Wrote ${relative(guard.root, absolute)}`, {
    path: relative(guard.root, absolute),
    bytes: Buffer.byteLength(params.content),
  });
},
```

Update `workspace_edit` execute:

```ts
async execute(_toolCallId, params: Static<typeof editSchema>) {
  let absolute: string;
  try {
    absolute = await guard.resolveInsideWorkspace(params.path);
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_edit");
    throw error;
  }
  const text = await readFile(absolute, "utf8");
  if (!text.includes(params.oldText)) {
    throw new Error(`Text to replace was not found in ${params.path}`);
  }
  const updated = text.replace(params.oldText, params.newText);
  await writeFile(absolute, updated, "utf8");
  return textResult(`Edited ${relative(guard.root, absolute)}`, {
    path: relative(guard.root, absolute),
  });
},
```

- [ ] **Step 3: Verify**

```bash
bun test packages/core/src/workspace-tools.test.ts
bun run --filter @tessera/core typecheck
```

Expected: all tests PASS, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workspace-tools.ts packages/core/src/workspace-tools.test.ts
git commit -m "Call onViolation callback on workspace boundary denial"
```

---

### Task 2: Pi Session — `buildPrompt`, `conversationHistory`, `boundaryViolations`

**Files:**
- Modify: `packages/core/src/pi-session.ts`
- Modify: `packages/core/src/pi-session.test.ts`

- [ ] **Step 1: Add failing tests**

`FakeSession` needs to capture the prompt text. Add a `capturedPrompts` field and update `prompt()` in the existing `FakeSession` class in `packages/core/src/pi-session.test.ts`:

```ts
class FakeSession implements PiSessionLike {
  capturedPrompts: string[] = [];
  private listeners: ((event: AgentSessionEvent) => void)[] = [];

  constructor(private readonly events: AgentSessionEvent[]) {}

  dispose(): void {}

  async prompt(text: string): Promise<void> {
    this.capturedPrompts.push(text);
    for (const event of this.events) {
      for (const listener of this.listeners) listener(event);
    }
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }
}
```

Add inside `describe("runPiTaskTurn", ...)`:

```ts
test("builds prompt with instructions, history, and task in order", async () => {
  const workspaceRoot = await makeWorkspace();
  let capturedSession: FakeSession | undefined;
  const factory: PiSessionFactory = async () => {
    capturedSession = new FakeSession([]);
    return capturedSession;
  };

  await runPiTaskTurn({
    credential: "sk-test",
    factory,
    prompt: "Draft",
    provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
    workspaceRoot,
    agent: {
      id: "writer",
      name: "Writer",
      model: { mode: "default" },
      instructions: "Write crisp updates.",
      soul: "Calm and direct.",
      skills: [],
      tools: ["workspace_read", "workspace_write"],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    },
    conversationHistory: [
      { role: "user", content: "Hello" },
      { role: "agent", content: "Hi there" },
    ],
  });

  const prompt = capturedSession?.capturedPrompts[0] ?? "";
  expect(prompt).toContain("Agent instructions:\nWrite crisp updates.");
  expect(prompt).toContain("Agent soul:\nCalm and direct.");
  expect(prompt).toContain("Prior conversation:\nUser: Hello\nAssistant: Hi there");
  expect(prompt).toContain("User task:\nDraft");
  const instrIdx = prompt.indexOf("Agent instructions:");
  const histIdx = prompt.indexOf("Prior conversation:");
  const taskIdx = prompt.indexOf("User task:");
  expect(instrIdx).toBeLessThan(histIdx);
  expect(histIdx).toBeLessThan(taskIdx);
});

test("omits history block when conversationHistory is empty", async () => {
  const workspaceRoot = await makeWorkspace();
  let capturedSession: FakeSession | undefined;
  const factory: PiSessionFactory = async () => {
    capturedSession = new FakeSession([]);
    return capturedSession;
  };

  await runPiTaskTurn({
    credential: "sk-test",
    factory,
    prompt: "Draft",
    provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
    workspaceRoot,
  });

  expect(capturedSession?.capturedPrompts[0]).not.toContain("Prior conversation:");
});

test("returns boundaryViolations 0 when no violations occur", async () => {
  const workspaceRoot = await makeWorkspace();
  const factory: PiSessionFactory = async () => new FakeSession([]);

  const result = await runPiTaskTurn({
    credential: "sk-test",
    factory,
    prompt: "Draft",
    provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
    workspaceRoot,
  });

  expect(result.boundaryViolations).toBe(0);
});
```

Run:

```bash
bun test packages/core/src/pi-session.test.ts
```

Expected: FAIL — `conversationHistory` not accepted, `boundaryViolations` not on result, `capturedPrompts` not on `FakeSession`.

- [ ] **Step 2: Extend `PiTaskTurnResult`**

In `packages/core/src/pi-session.ts`, update the interface:

```ts
export interface PiTaskTurnResult {
  text: string;
  boundaryViolations: number;
}
```

- [ ] **Step 3: Add `conversationHistory` to `RunPiTaskTurnOptions`**

```ts
export interface RunPiTaskTurnOptions {
  agent?: AgentProfile;
  conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
  credential?: string;
  factory?: PiSessionFactory;
  onActivity?: (activity: string) => void;
  prompt: string;
  provider: AgentProviderConfig;
  workspaceRoot: string;
}
```

- [ ] **Step 4: Replace `withAgentInstructions` with `buildPrompt`**

Remove the existing `withAgentInstructions` function and add:

```ts
function buildPrompt(
  prompt: string,
  options: {
    agent?: AgentProfile;
    conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
  }
): string {
  const { agent, conversationHistory } = options;
  const sections: string[] = [];
  if (agent?.instructions) sections.push(`Agent instructions:\n${agent.instructions}`);
  if (agent?.soul) sections.push(`Agent soul:\n${agent.soul}`);
  if (conversationHistory && conversationHistory.length > 0) {
    const lines = conversationHistory
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
      .join("\n");
    sections.push(`Prior conversation:\n${lines}`);
  }
  sections.push(`User task:\n${prompt}`);
  return sections.join("\n\n");
}
```

- [ ] **Step 5: Update `runPiTaskTurn` to track violations and use `buildPrompt`**

Replace the body of `runPiTaskTurn`:

```ts
export async function runPiTaskTurn(options: RunPiTaskTurnOptions): Promise<PiTaskTurnResult> {
  const guard = await createWorkspaceGuard(options.workspaceRoot);
  let boundaryViolations = 0;
  const allTools = createWorkspaceToolDefinitions(guard, {
    onViolation: () => {
      boundaryViolations++;
    },
  });
  const allowedTools = new Set(options.agent?.tools ?? allTools.map((tool) => tool.name));
  const customTools = allTools.filter((tool) => allowedTools.has(tool.name));

  const { model, modelRegistry } = await createTesseraModelRegistry({
    ...(options.credential ? { credential: options.credential } : {}),
    provider: options.provider,
  });

  const session = await (options.factory ?? defaultFactory())({
    customTools,
    model,
    modelRegistry,
    workspaceRoot: guard.root,
  });
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    const delta = textDeltaFromEvent(event);
    if (delta) text += delta;
    if (event.type === "tool_execution_start") {
      options.onActivity?.(`Using ${event.toolName}`);
    }
  });

  try {
    await session.prompt(
      buildPrompt(options.prompt, {
        agent: options.agent,
        conversationHistory: options.conversationHistory,
      })
    );
  } finally {
    unsubscribe();
    session.dispose();
  }

  return { text, boundaryViolations };
}
```

- [ ] **Step 6: Verify**

```bash
bun test packages/core/src/pi-session.test.ts
bun run --filter @tessera/core typecheck
```

Expected: all tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pi-session.ts packages/core/src/pi-session.test.ts
git commit -m "Add conversation history and boundary violation tracking to Pi session"
```

---

### Task 3: Task Runner — Agent Forwarding, History, And Waiting Status

**Files:**
- Modify: `apps/sidecar/src/task-runner.ts`
- Modify: `apps/sidecar/src/task-runner.test.ts`

- [ ] **Step 1: Update existing test piRunner stubs**

In `apps/sidecar/src/task-runner.test.ts`, add `boundaryViolations: 0` to all existing `piRunner` return values so they match the updated `PiTaskTurnResult`:

```ts
// happy path test — update return:
return { text: "# Task Output\n\nPi completed this task.", boundaryViolations: 0 };

// execution config test — update return:
return { text: "done", boundaryViolations: 0 };

// failure path test — update return:
return { text: "unused", boundaryViolations: 0 };
```

Run:

```bash
bun test apps/sidecar/src/task-runner.test.ts
bun run --filter @tessera/sidecar typecheck
```

Expected: all existing tests PASS, typecheck clean.

- [ ] **Step 2: Add new failing tests**

Add inside `describe("task runner", ...)` in `apps/sidecar/src/task-runner.test.ts`:

```ts
test("forwards execution agent to piRunner", async () => {
  const store = makeStore();
  const task = store.createTask({
    workspaceRoot: "/workspace/acme",
    initialInstruction: "Draft",
  });
  const userTurn = task.turns[0];
  if (!userTurn) throw new Error("expected first turn");
  const agentTurn = store.createQueuedAgentTurn(task.id);
  let capturedAgent: unknown;

  await runTaskTurn({
    store,
    taskId: task.id,
    userTurnId: userTurn.id,
    agentTurnId: agentTurn.id,
    execution: {
      agent: {
        id: "writer",
        name: "Writer",
        model: { mode: "default" },
        skills: [],
        tools: ["workspace_read"],
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      provider: { provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_API_KEY" },
      credential: { apiKey: "sk-test" },
    },
    piRunner: async (options) => {
      capturedAgent = options.agent;
      return { text: "done", boundaryViolations: 0 };
    },
    publish() {},
    delayMs: 0,
  });

  expect((capturedAgent as { id: string } | undefined)?.id).toBe("writer");
});

test("passes prior completed turns as conversation history on continuation", async () => {
  const store = makeStore();
  const task = store.createTask({
    workspaceRoot: "/workspace/acme",
    initialInstruction: "First message",
  });
  const firstUserTurn = task.turns[0];
  if (!firstUserTurn) throw new Error("expected first turn");
  store.updateTurn(firstUserTurn.id, { status: "completed", completedAt: new Date().toISOString() });
  store.createAgentTurn(task.id, "First response");

  const secondUserTurn = store.createUserTurn(task.id, "Follow up");
  const secondAgentTurn = store.createQueuedAgentTurn(task.id);
  let capturedHistory: unknown;

  await runTaskTurn({
    store,
    taskId: task.id,
    userTurnId: secondUserTurn.id,
    agentTurnId: secondAgentTurn.id,
    piRunner: async (options) => {
      capturedHistory = options.conversationHistory;
      return { text: "done", boundaryViolations: 0 };
    },
    publish() {},
    delayMs: 0,
  });

  expect(capturedHistory).toEqual([
    { role: "user", content: "First message" },
    { role: "agent", content: "First response" },
  ]);
});

test("passes no conversation history on the first task turn", async () => {
  const store = makeStore();
  const task = store.createTask({
    workspaceRoot: "/workspace/acme",
    initialInstruction: "First",
  });
  const userTurn = task.turns[0];
  if (!userTurn) throw new Error("expected first turn");
  const agentTurn = store.createQueuedAgentTurn(task.id);
  let capturedHistory: unknown = "sentinel";

  await runTaskTurn({
    store,
    taskId: task.id,
    userTurnId: userTurn.id,
    agentTurnId: agentTurn.id,
    piRunner: async (options) => {
      capturedHistory = options.conversationHistory;
      return { text: "done", boundaryViolations: 0 };
    },
    publish() {},
    delayMs: 0,
  });

  expect(capturedHistory).toBeUndefined();
});

test("sets task to waiting when boundary violations occur", async () => {
  const store = makeStore();
  const task = store.createTask({
    workspaceRoot: "/workspace/acme",
    initialInstruction: "Draft",
  });
  const userTurn = task.turns[0];
  if (!userTurn) throw new Error("expected first turn");
  const agentTurn = store.createQueuedAgentTurn(task.id);

  await runTaskTurn({
    store,
    taskId: task.id,
    userTurnId: userTurn.id,
    agentTurnId: agentTurn.id,
    piRunner: async () => ({ text: "tried outside workspace", boundaryViolations: 1 }),
    publish() {},
    delayMs: 0,
  });

  expect(store.getTask(task.id)?.status).toBe("waiting");
  expect(store.getTask(task.id)?.latestActivity).toBe(
    "Paused: agent reached workspace boundary"
  );
});

test("sets task to done when no boundary violations occur", async () => {
  const store = makeStore();
  const task = store.createTask({
    workspaceRoot: "/workspace/acme",
    initialInstruction: "Draft",
  });
  const userTurn = task.turns[0];
  if (!userTurn) throw new Error("expected first turn");
  const agentTurn = store.createQueuedAgentTurn(task.id);

  await runTaskTurn({
    store,
    taskId: task.id,
    userTurnId: userTurn.id,
    agentTurnId: agentTurn.id,
    piRunner: async () => ({ text: "completed", boundaryViolations: 0 }),
    publish() {},
    delayMs: 0,
  });

  expect(store.getTask(task.id)?.status).toBe("done");
});
```

Run:

```bash
bun test apps/sidecar/src/task-runner.test.ts
```

Expected: FAIL — `piRunner` type does not accept `agent` or `conversationHistory`; no history is built; no `waiting` branch exists.

- [ ] **Step 3: Update `RunTaskTurnOptions` in `task-runner.ts`**

Add `AgentProfile` to the import and update the `piRunner` callback type:

```ts
import type {
  AgentProfile,
  AgentProviderConfig,
  TaskEvent,
  TaskExecutionConfig,
  TaskSummary,
  TaskTurn,
} from "@tessera/contracts";
```

```ts
export interface RunTaskTurnOptions {
  credential?: string;
  execution?: TaskExecutionConfig;
  piRunner?: (options: {
    agent?: AgentProfile;
    conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
    credential?: string;
    onActivity?: (activity: string) => void;
    prompt: string;
    provider: AgentProviderConfig;
    workspaceRoot: string;
  }) => Promise<PiTaskTurnResult>;
  provider?: AgentProviderConfig;
  store: TaskStore;
  taskId: string;
  userTurnId: string;
  agentTurnId: string;
  publish: (event: TaskEvent) => void;
  delayMs?: number;
}
```

- [ ] **Step 4: Build conversation history and forward agent in `runTaskTurn`**

Inside `runTaskTurn`, after the `if (!task)` guard, add the history builder:

```ts
const conversationHistory = task.turns
  .filter(
    (turn) =>
      turn.status === "completed" &&
      turn.id !== userTurnId &&
      turn.id !== agentTurnId &&
      (turn.role === "user" || turn.role === "agent")
  )
  .map((turn) => ({ role: turn.role as "user" | "agent", content: turn.content }));
```

Then update the `piRunner` call to forward `agent` and `conversationHistory`:

```ts
const result = await piRunner({
  agent: opts.execution?.agent,
  conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
  ...(credential ? { credential } : {}),
  onActivity(activity) {
    store.updateTask(taskId, { latestActivity: activity });
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: store.getTaskSummary(taskId),
    });
  },
  prompt: userTurn.content,
  provider,
  workspaceRoot: task.workspaceRoot,
});
```

- [ ] **Step 5: Branch `waiting` vs `done` on `boundaryViolations`**

Replace the final `store.updateTask(taskId, { status: "done", ... })` and its publish block with:

```ts
if (result.boundaryViolations > 0) {
  store.updateTask(taskId, {
    status: "waiting",
    latestActivity: "Paused: agent reached workspace boundary",
  });
} else {
  store.updateTask(taskId, { status: "done", latestActivity: "Completed" });
}
const finalSummary = store.getTaskSummary(taskId);
publish({
  type: "task.updated",
  taskId,
  emittedAt: new Date().toISOString(),
  task: finalSummary,
});
```

- [ ] **Step 6: Verify**

```bash
bun test apps/sidecar/src/task-runner.test.ts
bun run --filter @tessera/sidecar typecheck
```

Expected: all tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/task-runner.ts apps/sidecar/src/task-runner.test.ts
git commit -m "Forward agent profile, build conversation history, and surface boundary violations"
```

---

### Task 4: Full Verification

**Files:**
- All changed files

- [ ] **Step 1: Run full check**

```bash
bun run check
```

Expected: PASS — biome + all typechecks clean.

- [ ] **Step 2: Run all tests**

```bash
bun run --filter '*' test
```

Expected: PASS. The sidecar task-event-bus test intentionally logs `boom` — that is expected.

- [ ] **Step 3: Confirm clean working tree**

```bash
git status --short
```

Expected: empty output (clean).
