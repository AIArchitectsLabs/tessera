import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentProfileSchema,
  type AgentProviderConfig,
  type MemoryEvent,
  type ModelRuntimeCredential,
  type TaskEvent,
  compileAgentRuntimeContext,
} from "@tessera/contracts";
import type { OptionalCapabilityInstallProgress, OptionalCapabilityManager } from "@tessera/core";
import { installGraphPlaybookPackage, workspaceKeyForRoot } from "@tessera/core";
import { importGraphPlaybookFolder } from "./graph-playbook-importer.js";
import { createMemoryManager } from "./memory-manager.js";
import { createMemoryStore } from "./memory-store.js";
import type { PlaybookRunDiagnosticsStore } from "./playbook-run-diagnostics.js";
import { resolvePendingTaskClarify, runTaskTurn } from "./task-runner.js";
import { createTaskStore } from "./task-store.js";

const tempStores: ReturnType<typeof createTaskStore>[] = [];
const tempMemoryStores: ReturnType<typeof createMemoryStore>[] = [];
const tempDirs: string[] = [];

function makeStore(): ReturnType<typeof createTaskStore> {
  const store = createTaskStore(":memory:");
  tempStores.push(store);
  return store;
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tessera-task-runner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
  for (const store of tempMemoryStores.splice(0)) {
    store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitUntil(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function writePackageFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function emptyPlaybookRunDiagnosticsStore(): PlaybookRunDiagnosticsStore {
  return {
    async getRun() {
      return undefined;
    },
    async listRuns() {
      return [];
    },
    async getQueue() {
      return [];
    },
    async listArtifactVersions() {
      return [];
    },
    async listBranchItems() {
      return [];
    },
    async listReviewEvents() {
      return [];
    },
    async listEffectExecutionRecords() {
      return [];
    },
    async listOperationRecords() {
      return [];
    },
  };
}

async function writeGraphPackage(
  root: string,
  options: {
    id?: string;
    name?: string;
    scriptBody?: string;
    version?: string;
  } = {}
): Promise<void> {
  const id = options.id ?? "weekly-email-summary";
  const name = options.name ?? "Weekly Email Summary";
  const version = options.version ?? "0.1.0";
  const graph = {
    schemaVersion: 1 as const,
    id,
    version,
    name,
    start: "score",
    artifacts: {
      scorecard: { schema: "./schemas/scorecard.schema.json" },
    },
    nodes: [
      {
        id: "score",
        kind: "script" as const,
        run: "./scripts/score.ts",
        inputs: {},
        outputArtifact: "scorecard",
        onSuccess: "completed",
      },
    ],
  };

  await writePackageFile(
    root,
    "manifest.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id,
        version,
        name,
        entrypoint: "playbook.ts",
      },
      null,
      2
    )}\n`
  );
  await writePackageFile(
    root,
    "playbook.ts",
    `import { definePlaybook } from "@tessera/plugin-sdk";
export default definePlaybook(${JSON.stringify(graph, null, 2)});
`
  );
  await writePackageFile(
    root,
    "scripts/score.ts",
    options.scriptBody ?? "export default async function score() {}\n"
  );
  await writePackageFile(root, "schemas/scorecard.schema.json", '{"type":"object"}\n');
}

async function writePromptOnlyMailPackage(root: string): Promise<void> {
  await writePackageFile(
    root,
    "manifest.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "weekly-email-summary",
        version: "0.1.1",
        name: "Weekly Email Summary",
        entrypoint: "playbook.ts",
      },
      null,
      2
    )}\n`
  );
  await writePackageFile(
    root,
    "playbook.ts",
    `export default {
  schemaVersion: 1,
  id: "weekly-email-summary",
  version: "0.1.1",
  name: "Weekly Email Summary",
  description: "Weekly Email Summary Tessera playbook package.",
  metadata: {
    category: "operations",
    businessUseCase: "Weekly Email Summary Tessera playbook package.",
    requiredCapabilities: [],
    optionalCapabilities: ["mail"],
    outputs: [{ kind: "workspaceDocument", label: "Weekly Email Summary" }],
    phases: ["Draft", "Review", "Write"],
  },
  inputs: {
    workspaceRoot: {
      type: "string",
      required: true,
      label: "Workspace",
      group: "System",
      ui: { control: "text" },
    },
    outputPath: {
      type: "string",
      required: true,
      label: "Output path",
      default: "Weekly Email Summary.md",
      ui: { control: "text" },
    },
  },
  artifacts: {
    finalArtifact: { schema: "schemas/finalArtifact.schema.json" },
  },
  capabilities: ["mail", "tool.workspace.write"],
  limits: {},
  start: "draft",
  nodes: [
    {
      id: "draft",
      label: "Draft Weekly Email Summary",
      kind: "agent",
      prompt: "prompts/draft.md",
      inputs: {
        workspaceRoot: { input: "workspaceRoot" },
        outputPath: { input: "outputPath" },
      },
      tools: [],
      output: {
        artifact: "finalArtifact",
        schema: "schemas/finalArtifact.schema.json",
      },
      onSuccess: "review",
    },
    {
      id: "review",
      label: "Review Weekly Email Summary",
      kind: "humanReview",
      artifact: "finalArtifact",
      actions: ["approve", "request_changes", "deny"],
      onApprove: "write",
      onRequestChanges: "draft",
    },
    {
      id: "write",
      label: "Write Weekly Email Summary",
      kind: "effect",
      effectId: "workspace.write",
      capability: "tool.workspace.write",
      adapterId: "workspace",
      sideEffect: "write",
      approval: "required",
      idempotency: "required",
      idempotencyKey: "workspace.write:weekly-email-summary:{{inputs.outputPath}}",
      input: {
        sourceArtifact: "finalArtifact",
        value: { artifact: "finalArtifact" },
        target: {
          kind: "workspace",
          path: "{{inputs.outputPath}}",
          format: "markdown",
        },
      },
      preview: {
        schemaVersion: 1,
        title: "Write Weekly Email Summary",
        summary: "Write the approved output to the selected workspace.",
      },
      onSuccess: "completed",
    },
  ],
};
`
  );
  await writePackageFile(
    root,
    "prompts/draft.md",
    "Create Weekly Email Summary from emails received during the previous calendar week through Tessera's mail capability.\n\nReturn only JSON that matches schemas/finalArtifact.schema.json.\n"
  );
  await writePackageFile(
    root,
    "schemas/finalArtifact.schema.json",
    `${JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        required: ["title", "summaryMarkdown"],
        properties: {
          title: { type: "string" },
          summaryMarkdown: { type: "string" },
        },
      },
      null,
      2
    )}\n`
  );
}

async function writeBrokenMailToolPackage(root: string): Promise<void> {
  await writePackageFile(
    root,
    "manifest.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "weekly-email-summary",
        version: "0.1.2",
        name: "Weekly Email Summary",
        entrypoint: "playbook.ts",
      },
      null,
      2
    )}\n`
  );
  await writePackageFile(
    root,
    "playbook.ts",
    `export default {
  schemaVersion: 1,
  id: "weekly-email-summary",
  version: "0.1.2",
  name: "Weekly Email Summary",
  inputs: {
    mailQuery: {
      type: "string",
      required: true,
      label: "Mail search query",
      default: "newer_than:14d older_than:7d",
      ui: { control: "text" },
    },
  },
  artifacts: {
    mailSearch: { schema: "schemas/mailSearch.schema.json" },
    finalArtifact: { schema: "schemas/finalArtifact.schema.json" },
  },
  capabilities: ["integration.mail.messages.read", "tool.workspace.write"],
  start: "readEmails",
  nodes: [
    {
      id: "readEmails",
      label: "Read source emails",
      kind: "tool",
      capability: "integration.mail.messages.read",
      args: {
        query: { input: "mailQuery" },
      },
      outputArtifact: "mailSearch",
      onSuccess: "draft",
    },
    {
      id: "draft",
      label: "Draft Weekly Email Summary",
      kind: "agent",
      prompt: "prompts/draft.md",
      inputs: {
        mailQuery: { input: "mailQuery" },
      },
      tools: [],
      output: {
        artifact: "finalArtifact",
        schema: "schemas/finalArtifact.schema.json",
      },
      onSuccess: "completed",
    },
  ],
};
`
  );
  await writePackageFile(
    root,
    "prompts/draft.md",
    "Create Weekly Email Summary from emails received during the previous calendar week.\n"
  );
  await writePackageFile(
    root,
    "schemas/finalArtifact.schema.json",
    `${JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        required: ["title", "summaryMarkdown"],
        properties: {
          title: { type: "string" },
          summaryMarkdown: { type: "string" },
        },
      },
      null,
      2
    )}\n`
  );
  await writePackageFile(
    root,
    "schemas/mailSearch.schema.json",
    `${JSON.stringify(
      {
        type: "object",
        additionalProperties: true,
        required: ["messages"],
        properties: {
          messages: { type: "array" },
        },
      },
      null,
      2
    )}\n`
  );
}

describe("task runner", () => {
  test("happy path: emits events in order and reaches done state", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
      agentLabel: "Maeve",
    });
    const firstTurn = task.turns[0];
    if (!firstTurn) throw new Error("expected first turn");

    const userTurn = store.createUserTurn(task.id, "Run the task");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    const events: TaskEvent[] = [];
    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onActivity }) => {
        onActivity?.("Using workspace_read");
        return { text: "# Task Output\n\nPi completed this task.", boundaryViolations: 0 };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    expect(events.map((e) => e.type)).toEqual([
      "turn.status_changed",
      "task.updated",
      "turn.status_changed",
      "task.updated",
      "task.updated",
      "turn.completed",
      "task.updated",
    ]);

    const [
      userTurnChanged,
      researchingUpdate,
      agentRunning,
      runningUpdate,
      toolActivityUpdate,
      agentCompleted,
      doneUpdate,
    ] = events;

    expect(userTurnChanged?.type).toBe("turn.status_changed");
    if (userTurnChanged?.type === "turn.status_changed") {
      expect(userTurnChanged.turn.id).toBe(userTurn.id);
      expect(userTurnChanged.turn.status).toBe("completed");
    }

    expect(researchingUpdate?.type).toBe("task.updated");
    if (researchingUpdate?.type === "task.updated") {
      expect(researchingUpdate.task.latestActivity).toBe("Starting");
    }

    expect(agentRunning?.type).toBe("turn.status_changed");
    if (agentRunning?.type === "turn.status_changed") {
      expect(agentRunning.turn.id).toBe(agentTurn.id);
      expect(agentRunning.turn.status).toBe("running");
    }

    expect(runningUpdate?.type).toBe("task.updated");
    if (runningUpdate?.type === "task.updated") {
      expect(runningUpdate.task.latestActivity).toBe("Running");
    }

    expect(toolActivityUpdate?.type).toBe("task.updated");
    if (toolActivityUpdate?.type === "task.updated") {
      expect(toolActivityUpdate.task.latestActivity).toBe("Using workspace_read");
    }

    expect(agentCompleted?.type).toBe("turn.completed");
    if (agentCompleted?.type === "turn.completed") {
      expect(agentCompleted.turn.id).toBe(agentTurn.id);
      expect(agentCompleted.turn.status).toBe("completed");
      expect(agentCompleted.turn.content).toBe("# Task Output\n\nPi completed this task.");
    }

    expect(doneUpdate?.type).toBe("task.updated");
    if (doneUpdate?.type === "task.updated") {
      expect(doneUpdate.task.status).toBe("done");
    }

    const finalTask = store.getTask(task.id);
    expect(finalTask?.status).toBe("done");

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");

    const finalTaskDetail = store.getTask(task.id);
    expect(finalTaskDetail?.artifacts).toHaveLength(0);
  });

  test("passes resolved execution provider, credential, and agent to Pi runner", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
    });
    const userTurn = store.createUserTurn(task.id, "Run the task");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const seen: unknown[] = [];

    const defaultAgent = AgentProfileSchema.parse({
      id: "default",
      name: "Tessera",
      model: { mode: "default" },
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      execution: {
        agent: defaultAgent,
        runtime: compileAgentRuntimeContext(defaultAgent),
        provider: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        credential: { apiKey: "sk-runtime" },
      },
      piRunner: async (options) => {
        seen.push(options);
        return { text: "done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(seen).toEqual([
      expect.objectContaining({
        credential: { apiKey: "sk-runtime" },
        provider: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        prompt: "Run the task",
        workspaceRoot: "/workspace/acme",
      }),
    ]);
  });

  test("uses prompt override while preserving displayed user turn content", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "/skill planning Draft a launch plan",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected first turn");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let seenPrompt = "";

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      promptOverride: "Draft a launch plan",
      piRunner: async ({ prompt }) => {
        seenPrompt = prompt;
        return { text: "Done", boundaryViolations: 0 };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(seenPrompt).toBe("Draft a launch plan");
    expect(store.getTurn(userTurn.id).content).toBe("/skill planning Draft a launch plan");
  });

  test("failure path: no exception thrown, publishes failed events", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
    });

    const userTurn = store.createUserTurn(task.id, "Run the task");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    let agentRunningCallCount = 0;
    const originalUpdateTurn = store.updateTurn.bind(store);
    store.updateTurn = (turnId, patch) => {
      if (turnId === agentTurn.id && patch.status === "running") {
        agentRunningCallCount++;
        throw new Error("Simulated failure during running update");
      }
      return originalUpdateTurn(turnId, patch);
    };

    const events: TaskEvent[] = [];
    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async () => ({ text: "unused", boundaryViolations: 0 }),
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    expect(agentRunningCallCount).toBe(1);

    const turnCompletedEvents = events.filter((e) => e.type === "turn.completed");
    expect(turnCompletedEvents).toHaveLength(1);
    const turnCompleted = turnCompletedEvents[0];
    if (turnCompleted?.type === "turn.completed") {
      expect(turnCompleted.turn.id).toBe(agentTurn.id);
      expect(turnCompleted.turn.status).toBe("failed");
    }

    const taskUpdatedEvents = events.filter((e) => e.type === "task.updated");
    const failedTaskUpdate = taskUpdatedEvents.at(-1);
    if (failedTaskUpdate?.type === "task.updated") {
      expect(failedTaskUpdate.task.status).toBe("failed");
    }
  });

  test("task runtime todo updates persist and publish live events", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Prepare launch checklist",
    });
    const userTurn = store.createUserTurn(task.id, "Make a checklist");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    const events: TaskEvent[] = [];
    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ taskRuntime }) => {
        await taskRuntime?.applyTodo({
          type: "create",
          items: [
            { id: "todo-1", label: "Draft brief", status: "pending", order: 0 },
            { id: "todo-2", label: "Review risks", status: "pending", order: 1 },
          ],
        });
        return { text: "Checklist created.", boundaryViolations: 0 };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const todoEvent = events.find((event) => event.type === "task.todo_updated");
    expect(todoEvent?.type).toBe("task.todo_updated");
    if (todoEvent?.type === "task.todo_updated") {
      expect(todoEvent.todo?.items.map((item) => item.label)).toEqual([
        "Draft brief",
        "Review risks",
      ]);
    }

    expect(store.getTask(task.id)?.todo?.items).toHaveLength(2);
  });

  test("task runtime clarification requests pause and resume the turn", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Create an email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Make the playbook");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    let capturedResponse: unknown;
    const events: TaskEvent[] = [];
    const runPromise = runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ taskRuntime }) => {
        capturedResponse = await taskRuntime?.requestClarify({
          promptId: "source-path",
          message: "Where should the playbook read emails from?",
          options: [
            {
              id: "gmail",
              label: "Gmail connector",
              description: "Read from the authenticated Tessera email connector.",
            },
          ],
        });
        return { text: "Playbook generated.", boundaryViolations: 0 };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    await waitUntil(() => events.some((event) => event.type === "task.clarify_requested"));

    expect(store.getTask(task.id)?.status).toBe("waiting");
    expect(store.getTask(task.id)?.clarify?.message).toBe(
      "Where should the playbook read emails from?"
    );
    expect(events.some((event) => event.type === "task.clarify_requested")).toBe(true);

    const response = {
      promptId: "source-path",
      selectedOptionId: "gmail",
      cancelled: false,
    };
    store.clearClarify(task.id, response);
    expect(resolvePendingTaskClarify(task.id, response)).toBe(true);
    await runPromise;

    expect(capturedResponse).toEqual(response);
    expect(store.getTask(task.id)?.clarify).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("marks unfinished todo items completed when the task finishes successfully", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Prepare launch checklist",
    });
    const userTurn = store.createUserTurn(task.id, "Make a checklist");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    const events: TaskEvent[] = [];
    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ taskRuntime }) => {
        await taskRuntime?.applyTodo({
          type: "create",
          items: [
            { id: "todo-1", label: "Draft brief", status: "pending", order: 0 },
            { id: "todo-2", label: "Review risks", status: "in_progress", order: 1 },
          ],
        });
        return { text: "Checklist complete.", boundaryViolations: 0 };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    expect(store.getTask(task.id)?.todo?.items.map((item) => item.status)).toEqual([
      "completed",
      "completed",
    ]);

    const todoEvents = events.filter((event) => event.type === "task.todo_updated");
    expect(todoEvents).toHaveLength(2);
    const completedTodoEvent = todoEvents.at(-1);
    if (completedTodoEvent?.type === "task.todo_updated") {
      expect(completedTodoEvent.todo?.items.map((item) => item.status)).toEqual([
        "completed",
        "completed",
      ]);
    }
  });

  test("records tool usage as task artifacts", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Summarize this article",
    });
    const userTurn = store.createUserTurn(task.id, "Summarize the URL");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    const events: TaskEvent[] = [];
    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolStart }) => {
        onToolStart?.({
          name: "shell",
          args: {
            command: "web-fetch",
            subcommand: "fetch",
            args: ["https://example.com/post"],
          },
        });
        return { text: "Summary complete.", boundaryViolations: 0 };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const artifactEvent = events.find((event) => event.type === "artifact.created");
    expect(artifactEvent?.type).toBe("artifact.created");
    if (artifactEvent?.type === "artifact.created") {
      expect(artifactEvent.artifact.title).toBe("web-fetch fetch");
      expect(artifactEvent.artifact.contentPreview).toBe(
        "web-fetch fetch | https://example.com/post"
      );
    }

    const finalTask = store.getTask(task.id);
    expect(finalTask?.artifacts).toHaveLength(1);
    expect(finalTask?.artifacts[0]?.title).toBe("web-fetch fetch");
  });

  test("publishes capability install progress from tool-triggered PDF setup", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Render the PDF",
    });
    const userTurn = store.createUserTurn(task.id, "Render the PDF");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const progressEvents: OptionalCapabilityInstallProgress[] = [
      {
        id: "pdf-render",
        label: "PDF render engine",
        version: "1.0.0",
        phase: "downloading",
        downloadedBytes: 50,
        totalBytes: 100,
      },
      {
        id: "pdf-render",
        label: "PDF render engine",
        version: "1.0.0",
        phase: "verifying",
        downloadedBytes: 100,
        totalBytes: 100,
      },
      {
        id: "pdf-render",
        label: "PDF render engine",
        version: "1.0.0",
        phase: "installed",
        downloadedBytes: 100,
        totalBytes: 100,
      },
    ];
    const capabilityManager: OptionalCapabilityManager = {
      resolveBinary: async () => undefined,
      status: async () => ({
        id: "pdf-render",
        label: "PDF render engine",
        version: "1.0.0",
        status: "available",
        installed: false,
        installAvailable: true,
        binaryPaths: {},
      }),
      install: async (_capabilityId, options) => {
        for (const progress of progressEvents) {
          options?.onProgress?.(progress);
        }
        return {
          id: "pdf-render",
          label: "PDF render engine",
          version: "1.0.0",
          status: "installed",
          binaryPaths: { "tessera-pdf-render": "/managed/tessera-pdf-render" },
        };
      },
    };

    const events: TaskEvent[] = [];
    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      capabilityManager,
      piRunner: async ({ capabilityManager }) => {
        await capabilityManager?.install("pdf-render");
        return { text: "Rendered.", boundaryViolations: 0 };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const notifications = events.filter((event) => event.type === "task.notification");
    expect(notifications).toHaveLength(3);
    expect(notifications.map((event) => event.notification.title)).toEqual([
      "Capability setup",
      "Capability setup",
      "Capability setup",
    ]);
    expect(notifications.map((event) => event.notification.body)).toEqual([
      "Downloading PDF render engine... 50%",
      "Verifying PDF render engine...",
      "PDF render engine is ready.",
    ]);
    expect(store.getTask(task.id)?.latestActivity).toBe("Completed");
  });

  test("provides a Python skill runner when a skill cache root is configured", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Use a Python skill helper",
    });
    const userTurn = store.createUserTurn(task.id, "Use a Python skill helper");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let hasPythonRunner = false;

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      pythonSkillRoot: "/tmp/tessera-python-skills-test",
      piRunner: async ({ skillRuntime }) => {
        hasPythonRunner = typeof skillRuntime?.runPython === "function";
        return { text: "Ready.", boundaryViolations: 0 };
      },
      publish: () => {},
      delayMs: 0,
    });

    expect(hasPythonRunner).toBe(true);
  });

  test("records browser screenshot and recipe proposal artifacts", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Inspect a web page",
    });
    const userTurn = store.createUserTurn(task.id, "Open the page");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    const events: TaskEvent[] = [];
    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd }) => {
        expect(typeof onToolEnd).toBe("function");
        onToolEnd?.({
          name: "browser",
          result: {
            details: {
              action: "snap",
              summary: "Captured screenshot",
              sessionId: "session-1",
              pageId: "page-1",
              url: "https://example.com",
              screenshotPath: "/tmp/tessera-browser.png",
              metadata: {
                recipeProposal: {
                  id: "recipe-1",
                  status: "draft",
                  domain: "example.com",
                  goal: "Review https://example.com",
                  source: { sessionId: "session-1" },
                  permissions: ["browser.read"],
                  steps: [{ action: "open", url: "https://example.com" }],
                  artifacts: [{ title: "Browser screenshot", path: "/tmp/tessera-browser.png" }],
                  createdAt: "2026-05-10T00:00:00.000Z",
                },
              },
            },
          },
        });
        return { text: "Inspection complete.", boundaryViolations: 0 };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const artifactEvents = events.filter((event) => event.type === "artifact.created");
    expect(artifactEvents).toHaveLength(2);
    const finalTask = store.getTask(task.id);
    expect(finalTask?.artifacts.map((artifact) => artifact.title)).toEqual([
      "Browser screenshot",
      "Browser recipe proposal: example.com",
    ]);
    expect(finalTask?.artifacts[0]?.kind).toBe("file");
    expect(finalTask?.artifacts[0]?.path).toBe("/tmp/tessera-browser.png");
    expect(finalTask?.artifacts[1]?.contentPreview).toContain('"domain": "example.com"');
  });

  test("summarizes tool activity when the model returns empty text", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Save the analysis as a PDF",
    });
    const userTurn = store.createUserTurn(task.id, "/pdf-workflows save the analysis as pdf");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "OpenClaw-vs-Hermes-use-cases-analysis.pdf" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote OpenClaw-vs-Hermes-use-cases-analysis.pdf",
              },
            ],
          },
        });
        return { text: "", boundaryViolations: 0 };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.content).toContain("Completed the task.");
    expect(finalAgentTurn.content).toContain("workspace write");
    expect(finalAgentTurn.content).toContain("OpenClaw-vs-Hermes-use-cases-analysis.pdf");
    expect(finalAgentTurn.content).not.toContain("No response was produced");
  });

  test("does not count failed tool attempts as completed work", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Create a playbook package",
    });
    const userTurn = store.createUserTurn(task.id, "Create a weekly email summary playbook");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/manifest.json" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: { error: "permission denied" },
        });
        return { text: "", boundaryViolations: 0 };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("failed");
    expect(finalAgentTurn.error).toContain("did not receive a response");
    expect(finalAgentTurn.content).not.toContain("Completed the task.");
    expect(store.getTask(task.id)?.status).toBe("failed");
  });

  test("fails loudly when the model returns empty text without observable work", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Create a playbook package",
    });
    const userTurn = store.createUserTurn(task.id, "Where did you create the playbook?");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async () => ({ text: "", boundaryViolations: 0 }),
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("failed");
    expect(finalAgentTurn.error).toContain("did not receive a response");
    expect(finalAgentTurn.content).not.toContain("Completed the task.");
    expect(store.getTask(task.id)?.status).toBe("failed");

    const finalTaskUpdate = events.filter((event) => event.type === "task.updated").at(-1);
    if (finalTaskUpdate?.type === "task.updated") {
      expect(finalTaskUpdate.task.status).toBe("failed");
    }
  });

  test("playbook builder tasks send scaffold retry prompt when model writes no files", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const request =
      "I want to create a playbook that will ready emails and create a summary of the emails I have received last week. The summary should be saved the workspace.";
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: `/tessera-playbook-builder ${request}`,
    });
    const userTurn = store.createUserTurn(task.id, request);
    store.addActiveSkill(task.id, {
      skillId: "codex:tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          text: "I'll scaffold the playbook package now.",
          boundaryViolations: 0,
        };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Tessera runtime note: you were asked to create a new playbook");
    expect(prompts[1]).toContain("Call playbook_package_scaffold now");
    expect(prompts[1]).toContain("playbooks/weekly-email-summary");
    expect(prompts[1]).toContain("Weekly Email Summary");
    expect(events.some((event) => event.type === "task.clarify_requested")).toBe(false);

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook builder fallback scaffold retry prompt includes inferred package path", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create an email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Create an email summary playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          text: "I'll scaffold the package.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Call playbook_package_scaffold now");
    expect(prompts[1]).toContain("playbooks/email-summary");
    expect(prompts[1]).toContain("Email Summary");

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook builder fallback scaffold retry is only sent once", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create an email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Create an email summary playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "", boundaryViolations: 0 };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Call playbook_package_scaffold now");

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("failed");
    expect(finalAgentTurn.error).toContain("did not receive a response");
  });

  test("playbook builder scaffold retry prompt is not sent when model calls playbook_package_scaffold", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create a weekly email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Create the playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/manifest.json" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [{ type: "text", text: "Wrote playbooks/weekly-email-summary/manifest.json" }],
          },
        });
        return {
          text: "Scaffolded playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(1);
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).not.toContain("Call playbook_package_scaffold now");
  });

  test("playbook builder tasks complete after a successful workspace package write", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    await mkdir(join(workspaceRoot, "playbooks/weekly-email-summary"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "playbooks/weekly-email-summary/build.ts"),
      'console.log("package validation ok");\n',
      "utf8"
    );
    await writeFile(
      join(workspaceRoot, "playbooks/weekly-email-summary/manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "weekly-email-summary",
        version: "0.1.0",
        name: "Weekly Email Summary",
        entrypoint: "playbook.ts",
      }),
      "utf8"
    );
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create a weekly email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Create the playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/manifest.json" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/manifest.json",
              },
            ],
          },
        });
        return {
          text: "Created the playbook package at playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("playbooks/weekly-email-summary");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook builder tasks auto-import validated workspace packages", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const installRoot = await makeWorkspace();
    const cacheRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create a weekly email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Create the playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const importedRoots: string[] = [];
    const events: TaskEvent[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/manifest.json" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/manifest.json",
              },
            ],
          },
        });
        return {
          text: "Created the playbook package at playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      playbookImport: {
        installRoot,
        cacheRoot,
        async importPackage({ sourceRoot }) {
          importedRoots.push(sourceRoot);
          return {
            schemaVersion: 1,
            status: "installed",
            id: "weekly-email-summary",
            version: "0.1.0",
            name: "Weekly Email Summary",
            graphHash: `sha256:${"a".repeat(64)}`,
            sourceHash: `sha256:${"b".repeat(64)}`,
            warnings: [],
          };
        },
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain(
      "Imported Weekly Email Summary 0.1.0 from playbooks/weekly-email-summary: installed."
    );
    expect(importedRoots).toEqual([await realpath(packageRoot)]);
    expect(events.some((event) => event.type === "task.playbook_imported")).toBe(true);
  });

  test("playbook builder auto-import bumps patch version on same-version source conflict", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const installRoot = await makeWorkspace();
    const cacheRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot, {
      scriptBody: "export default async function score() { return { generation: 1 }; }\n",
    });
    await installGraphPlaybookPackage({
      sourceRoot: packageRoot,
      installRoot,
      cacheRoot,
      compilerVersion: "test-compiler",
      scriptSdkVersion: "test-sdk",
    });
    await writeGraphPackage(packageRoot, {
      scriptBody: "export default async function score() { return { generation: 2 }; }\n",
    });
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Update the weekly email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Update the playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/scripts/score.ts" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/scripts/score.ts",
              },
            ],
          },
        });
        return {
          text: "Updated the playbook package at playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      playbookImport: {
        installRoot,
        cacheRoot,
        importPackage({ sourceRoot }) {
          return importGraphPlaybookFolder({
            sourceRoot,
            installRoot,
            cacheRoot,
            builtInIds: [],
            compilerVersion: "test-compiler",
            scriptSdkVersion: "test-sdk",
          });
        },
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    const imported = events.find((event) => event.type === "task.playbook_imported");
    const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")) as {
      version?: string;
    };
    const playbook = await readFile(join(packageRoot, "playbook.ts"), "utf8");
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Version bumped from 0.1.0 to 0.1.1");
    expect(manifest.version).toBe("0.1.1");
    expect(playbook).toContain('"version": "0.1.1"');
    expect(imported?.type).toBe("task.playbook_imported");
    if (imported?.type !== "task.playbook_imported") {
      throw new Error("Expected task.playbook_imported event");
    }
    expect(imported.import.version).toBe("0.1.1");
    expect(imported.versionBumpedFrom).toBe("0.1.0");
  });

  test("playbook builder auto-import keeps version on same-source repeat import", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const installRoot = await makeWorkspace();
    const cacheRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    await installGraphPlaybookPackage({
      sourceRoot: packageRoot,
      installRoot,
      cacheRoot,
      compilerVersion: "test-compiler",
      scriptSdkVersion: "test-sdk",
    });
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Update the weekly email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Update the playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/manifest.json" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/manifest.json",
              },
            ],
          },
        });
        return {
          text: "Checked the playbook package at playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      playbookImport: {
        installRoot,
        cacheRoot,
        importPackage({ sourceRoot }) {
          return importGraphPlaybookFolder({
            sourceRoot,
            installRoot,
            cacheRoot,
            builtInIds: [],
            compilerVersion: "test-compiler",
            scriptSdkVersion: "test-sdk",
          });
        },
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    const imported = events.find((event) => event.type === "task.playbook_imported");
    const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")) as {
      version?: string;
    };
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain(
      "Imported Weekly Email Summary 0.1.0 from playbooks/weekly-email-summary: unchanged."
    );
    expect(finalAgentTurn.content).not.toContain("Version bumped");
    expect(manifest.version).toBe("0.1.0");
    expect(imported?.type).toBe("task.playbook_imported");
    if (imported?.type !== "task.playbook_imported") {
      throw new Error("Expected task.playbook_imported event");
    }
    expect(imported.import.status).toBe("unchanged");
    expect(imported.import.version).toBe("0.1.0");
    expect(imported.versionBumpedFrom).toBeUndefined();
  });

  test("playbook builder tasks fail when package validation fails after writes", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    await mkdir(join(workspaceRoot, "playbooks/broken-playbook"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "playbooks/broken-playbook/build.ts"),
      'console.error("package validation failed");\nprocess.exit(1);\n',
      "utf8"
    );
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create a broken playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Create the playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/broken-playbook/manifest.json" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/broken-playbook/manifest.json",
              },
            ],
          },
        });
        return {
          text: "Created the playbook package at playbooks/broken-playbook.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("failed");
    expect(finalAgentTurn.error).toContain("Validation failed for playbooks/broken-playbook");
    expect(store.getTask(task.id)?.status).toBe("failed");
  });

  test("playbook builder validation-only turns do not trigger fallback scaffold", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Validate playbooks/existing-playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Validate the playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart }) => {
        onToolStart?.({
          name: "playbook_package_validate",
          args: { packagePath: "playbooks/existing-playbook" },
        });
        onToolEnd?.({
          name: "playbook_package_validate",
          result: {
            content: [{ type: "text", text: "Validated playbooks/existing-playbook" }],
            details: {
              packagePath: "playbooks/existing-playbook",
              ok: true,
              steps: [
                {
                  name: "Package tests",
                  command: "bun test tests",
                  ok: true,
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                },
              ],
            },
          },
        });
        return {
          text: "Validated playbooks/existing-playbook.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Validation passed for playbooks/existing-playbook");
    expect(store.getTask(task.id)?.status).toBe("done");
    expect(store.getTask(task.id)?.clarify).toBeUndefined();
  });

  test("tessera-playbook-debugger skill sends scaffold retry prompt when model writes no files", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-debugger Create an email summary playbook",
    });
    const userTurn = store.createUserTurn(task.id, "Create an email summary playbook");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-debugger",
      name: "tessera-playbook-debugger",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          text: "I'll scaffold the package.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Call playbook_package_scaffold now");

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook builder repair follow-ups do not trigger fallback scaffold naming", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create a weekly email summary playbook",
    });
    const initialTurn = task.turns[0];
    if (!initialTurn) throw new Error("expected initial turn");
    store.updateTurn(initialTurn.id, {
      status: "completed",
      completedAt: "2026-06-17T00:00:00.000Z",
    });
    store.createAgentTurn(
      task.id,
      "Created a Tessera playbook package at playbooks/weekly-email-summary."
    );
    const userTurn = store.createUserTurn(
      task.id,
      "The playbook does not seem to be working properly. I have getting a blank markdown file."
    );
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];
    let capturedPrompt = "";

    const run = runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        capturedPrompt = prompt;
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/prompts/draft.md" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/prompts/draft.md",
              },
            ],
          },
        });
        return {
          text: "Updated playbooks/weekly-email-summary/prompts/draft.md to repair the blank output path.",
          boundaryViolations: 0,
        };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });
    const outcome = await Promise.race([
      run.then(() => "completed" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);

    expect(outcome).toBe("completed");
    expect(events.some((event) => event.type === "task.clarify_requested")).toBe(false);
    expect(store.getTask(task.id)?.clarify).toBeUndefined();
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Updated playbooks/weekly-email-summary");
    expect(capturedPrompt).toContain("existing playbook update");
    expect(capturedPrompt).toContain("playbooks/weekly-email-summary");
    expect(capturedPrompt).toContain("Do not call playbook_package_scaffold");
  });

  test("playbook builder repair follow-ups retry empty model turns before fallback", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create a weekly email summary playbook",
    });
    const initialTurn = task.turns[0];
    if (!initialTurn) throw new Error("expected initial turn");
    store.updateTurn(initialTurn.id, {
      status: "completed",
      completedAt: "2026-06-17T00:00:00.000Z",
    });
    store.createAgentTurn(
      task.id,
      "Created a Tessera playbook package at playbooks/weekly-email-summary."
    );
    const userTurn = store.createUserTurn(
      task.id,
      "Can you add debug message so that we can track what the playbook is doing to troubleshoot the issue."
    );
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { text: "", boundaryViolations: 0 };
        }
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/prompts/draft.md" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/prompts/draft.md",
              },
            ],
          },
        });
        return {
          text: "Added debug guidance to playbooks/weekly-email-summary/prompts/draft.md.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("existing playbook update");
    expect(prompts[1]).toContain("previous model turn produced no user-visible response");
    expect(prompts[1]).toContain("workspace_edit or workspace_write");
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Added debug guidance");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(finalAgentTurn.content).not.toContain("The model did not produce an edit");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("explicit playbook path update tasks retry empty model turns without active builder skill", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "for the playbook playbooks/weekly-email-summary can you add debug so that we can track what is happening when we execute the workflow.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { text: "", boundaryViolations: 0 };
        }
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/prompts/draft.md" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/prompts/draft.md",
              },
            ],
          },
        });
        return {
          text: "Added debug guidance to playbooks/weekly-email-summary/prompts/draft.md.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("existing playbook update");
    expect(prompts[0]).toContain("playbooks/weekly-email-summary");
    expect(prompts[1]).toContain("validation-only is not enough");
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Added debug guidance");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(finalAgentTurn.error).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook builder resolves bare existing workspace playbook ids before asking", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "/tessera-playbook-builder can you help me enhance the playbook weekly-email-summary. I want the email summarization to be displayed in the UI also.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];
    let capturedPrompt = "";

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        capturedPrompt = prompt;
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/playbook.ts" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/playbook.ts",
              },
            ],
          },
        });
        return {
          text: "Updated playbooks/weekly-email-summary so the email summary is a declared run-result UI output.",
          boundaryViolations: 0,
        };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("playbooks/weekly-email-summary");
    expect(events.some((event) => event.type === "task.clarify_requested")).toBe(false);
    expect(capturedPrompt).toContain("Existing package candidate: playbooks/weekly-email-summary");
    expect(capturedPrompt).toContain("run-result output card");
    expect(capturedPrompt).toContain("metadata.outputs");
    expect(capturedPrompt).toContain("actually produced run output or artifact id");
    expect(capturedPrompt).not.toContain("No existing package path was detected");
    expect(store.getTask(task.id)?.clarify).toBeUndefined();
  });

  test("playbook builder UI output update retries with QnA and output-kind guidance", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "/tessera-playbook-builder enhance weekly-email-summary so the email summary is displayed in the UI also.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { text: "", boundaryViolations: 0 };
        }
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/playbook.ts" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/playbook.ts",
              },
            ],
          },
        });
        return {
          text: "Declared emailSummary as the run-result UI output for playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("use clarify with one focused task-UI question");
    expect(prompts[1]).toContain("run-result output card");
    expect(prompts[1]).toContain("Minimal edit");
    expect(prompts[1]).toContain(
      "metadata.outputs.kind matches an actually produced run output or artifact id"
    );
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Declared emailSummary");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
  });

  test("playbook builder UI output update retries validation-only turns as implementation", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "/tessera-playbook-builder can you update weekly-email-summary so the summary is displayed in the UI.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];
    const allowedToolsByPrompt: string[][] = [];
    const defaultAgent = AgentProfileSchema.parse({
      id: "default",
      name: "Tessera",
      model: { mode: "default" },
      toolPolicyPreset: "workspace_editor",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      execution: {
        agent: defaultAgent,
        runtime: compileAgentRuntimeContext(defaultAgent),
        provider: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        credential: { apiKey: "sk-test" },
      },
      piRunner: async ({ onToolEnd, onToolStart, prompt, runtime }) => {
        prompts.push(prompt);
        allowedToolsByPrompt.push(runtime?.toolPolicy.allowedTools ?? []);
        if (prompts.length === 1) {
          onToolStart?.({
            name: "playbook_package_validate",
            args: { packagePath: "playbooks/weekly-email-summary" },
          });
          onToolEnd?.({
            name: "playbook_package_validate",
            result: {
              content: [{ type: "text", text: "Validated playbooks/weekly-email-summary" }],
              details: {
                packagePath: "playbooks/weekly-email-summary",
                ok: true,
                steps: [
                  {
                    name: "Package tests",
                    command: "bun test tests",
                    ok: true,
                    exitCode: 0,
                    stdout: "",
                    stderr: "",
                  },
                ],
              },
            },
          });
          return {
            text: "Validation passed for playbooks/weekly-email-summary.",
            boundaryViolations: 0,
          };
        }
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/playbook.ts" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/playbook.ts",
              },
            ],
          },
        });
        return {
          text: "Updated playbooks/weekly-email-summary so the summary is also a run-result UI output.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(allowedToolsByPrompt[0]).toContain("playbook_package_validate");
    expect(allowedToolsByPrompt[1]).toContain("workspace_write");
    expect(allowedToolsByPrompt[1]).toContain("workspace_edit");
    expect(allowedToolsByPrompt[1]).not.toContain("playbook_package_validate");
    expect(allowedToolsByPrompt[1]).not.toContain("playbook_package_scaffold");
    expect(allowedToolsByPrompt[1]).not.toContain("playbook_run_diagnostics");
    expect(prompts[1]).toContain("Tessera runtime implementation retry");
    expect(prompts[1]).toContain("read-only snapshot");
    expect(prompts[1]).toContain("--- playbooks/weekly-email-summary/playbook.ts ---");
    expect(prompts[1]).toContain('"Display in UI" can mean');
    expect(prompts[1]).toContain("Concrete run-result UI edit recipe");
    expect(prompts[1]).toContain("The runner will fail this turn if no workspace_edit");
    expect(prompts[1]).toContain(
      'Computed run-result UI edit: the final artifact id is "scorecard"'
    );
    expect(prompts[1]).toContain("Prefer workspace_write (write the complete updated file)");
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("run-result UI output");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(finalAgentTurn.error).toBeUndefined();
  });

  test("playbook builder UI output update rejects validation-only completion", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "/tessera-playbook-builder can you update weekly-email-summary so the summary is displayed in the UI.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        onToolStart?.({
          name: "playbook_package_validate",
          args: { packagePath: "playbooks/weekly-email-summary" },
        });
        onToolEnd?.({
          name: "playbook_package_validate",
          result: {
            content: [{ type: "text", text: "Validated playbooks/weekly-email-summary" }],
            details: {
              packagePath: "playbooks/weekly-email-summary",
              ok: true,
              steps: [
                {
                  name: "Package tests",
                  command: "bun test tests",
                  ok: true,
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                },
              ],
            },
          },
        });
        return {
          text: "Validation passed for playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Tessera runtime implementation retry");
    expect(prompts[1]).toContain("read-only snapshot");
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("did not update the existing playbook package");
    expect(finalAgentTurn.content).toContain("No package files changed");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook builder UI output update applies runner fallback when PI never writes files", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writePromptOnlyMailPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "/tessera-playbook-builder can you update weekly-email-summary so the summary is displayed in the UI.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        onToolStart?.({
          name: "playbook_package_validate",
          args: { packagePath: "playbooks/weekly-email-summary" },
        });
        onToolEnd?.({
          name: "playbook_package_validate",
          result: {
            content: [{ type: "text", text: "Validated playbooks/weekly-email-summary" }],
            details: {
              packagePath: "playbooks/weekly-email-summary",
              ok: true,
              steps: [
                {
                  name: "Package tests",
                  command: "bun test tests",
                  ok: true,
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                },
              ],
            },
          },
        });
        return {
          text: "Validation passed for playbooks/weekly-email-summary.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Tessera runtime implementation retry");
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Runner fallback");
    expect(finalAgentTurn.content).toContain("finalArtifact");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(finalAgentTurn.error).toBeUndefined();
    const updatedPlaybook = await readFile(
      join(workspaceRoot, "playbooks/weekly-email-summary/playbook.ts"),
      "utf8"
    );
    expect(updatedPlaybook).toContain('"finalArtifact"');
    expect(updatedPlaybook).toContain("workspaceDocument");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("workspace playbook name update tasks retry empty model turns without explicit paths", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "for the weekly email summary playbook can you add debug so that we can track what is happening when we execute the workflow.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { text: "", boundaryViolations: 0 };
        }
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/prompts/draft.md" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/prompts/draft.md",
              },
            ],
          },
        });
        return {
          text: "Added debug guidance to playbooks/weekly-email-summary/prompts/draft.md.",
          boundaryViolations: 0,
        };
      },
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Existing package candidate: playbooks/weekly-email-summary");
    expect(prompts[1]).toContain("Target package: playbooks/weekly-email-summary.");
    expect(events.some((event) => event.type === "task.clarify_requested")).toBe(false);
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Added debug guidance");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(finalAgentTurn.error).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("explicit singular playbook troubleshooting runs diagnostics when model stays empty", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: [
        "in the playbook/weekly-email-summary my last run got this in the output",
        "# Weekly Email Summary",
        "No email summary could be generated because Tessera mail source material was not available in this runtime.",
        "Can you troubleshoot if it is issue with gmail connector or there are genuine no emails last week.",
      ].join("\n\n"),
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let callCount = 0;

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async () => {
        callCount += 1;
        return { text: "", boundaryViolations: 0 };
      },
      playbookRunDiagnostics: {
        store: emptyPlaybookRunDiagnosticsStore(),
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(callCount).toBe(2);
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.error).toBeUndefined();
    expect(finalAgentTurn.content).toContain("Playbook diagnostics did not find a matching run.");
    expect(finalAgentTurn.content).toContain("Requested target: playbooks/weekly-email-summary");
    expect(finalAgentTurn.content).toContain("No playbook run matched");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook diagnostics follow-up retries when the model only repeats troubleshooting", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "in the playbooks/weekly-email-summary my last run failed with a mailSearch schema error.",
    });
    const initialTurn = task.turns[0];
    if (!initialTurn) throw new Error("expected initial turn");
    store.updateTurn(initialTurn.id, {
      status: "completed",
      completedAt: "2026-06-18T00:00:00.000Z",
    });
    const diagnosticsSummary = [
      "Diagnostics for weekly-email-summary run ba86636e-472a-45ca-82fc-8cca09e7978b: failed.",
      "Requested target: playbooks/weekly-email-summary",
      "",
      "Issues:",
      "- [error] run.failed: Run status is failed. Evidence: Graph node readEmails produced mailSearch that does not match schemas/mailSearch.schema.json: $.messages is required. Suggested fix: Inspect failed or blocked queue entries and repair the smallest package node, prompt, schema, or connector mismatch.",
      "- [error] queue.failed: tool node readEmails is failed. Evidence: Graph node readEmails produced mailSearch that does not match schemas/mailSearch.schema.json: $.messages is required. Suggested fix: Check the tool capability, adapter availability, and the node's args.",
      "",
      "Next actions:",
      "- Inspect failed or blocked queue entries and repair the smallest package node, prompt, schema, or connector mismatch.",
      "- Check the tool capability, adapter availability, and the node's args.",
      "- After editing the playbook package, run playbook_package_validate for the package path.",
    ].join("\n");
    store.createAgentTurn(task.id, diagnosticsSummary);
    const userTurn = store.createUserTurn(task.id, "Yes go ahead with the next actions");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { text: diagnosticsSummary, boundaryViolations: 0 };
        }
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/prompts/draft.md" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/prompts/draft.md",
              },
            ],
          },
        });
        return {
          text: "Repaired playbooks/weekly-email-summary by updating the readEmails handling.",
          boundaryViolations: 0,
        };
      },
      playbookRunDiagnostics: {
        store: emptyPlaybookRunDiagnosticsStore(),
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Do not call playbook_run_diagnostics again");
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("Repaired playbooks/weekly-email-summary");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(finalAgentTurn.error).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("approved playbook diagnostic follow-ups require agentic tool work for generic issues", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "in the playbooks/weekly-email-summary my last run produced a blank markdown file.",
    });
    const initialTurn = task.turns[0];
    if (!initialTurn) throw new Error("expected initial turn");
    store.updateTurn(initialTurn.id, {
      status: "completed",
      completedAt: "2026-06-18T00:00:00.000Z",
    });
    store.createAgentTurn(
      task.id,
      [
        "Diagnostics for weekly-email-summary run run-blank-output: completed.",
        "Requested target: playbooks/weekly-email-summary",
        "",
        "Issues:",
        "- [error] workspace_output.blank_or_truncated: Workspace output Weekly Email Summary.md is tiny compared with the source artifact. Evidence: outputBytes=24; artifactChars=1800; artifactId=finalArtifact. Suggested fix: Inspect workspace materialization or artifactWrite formatting and ensure the write node uses the markdown/content field, not only the title.",
        "",
        "Next actions:",
        "- Inspect workspace materialization or artifactWrite formatting and ensure the write node uses the markdown/content field, not only the title.",
        "- After editing the playbook package, run playbook_package_validate for the package path.",
      ].join("\n")
    );
    const userTurn = store.createUserTurn(task.id, "go ahead and fix it");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const prompts: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async ({ onToolEnd, onToolStart, prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return {
            text: "I will troubleshoot the blank output and report back with the next steps.",
            boundaryViolations: 0,
          };
        }
        onToolStart?.({
          name: "workspace_write",
          args: { path: "playbooks/weekly-email-summary/prompts/draft.md" },
        });
        onToolEnd?.({
          name: "workspace_write",
          result: {
            content: [
              {
                type: "text",
                text: "Wrote playbooks/weekly-email-summary/prompts/draft.md",
              },
            ],
          },
        });
        return {
          text: "Updated the package so the writer uses the markdown content field for workspace output.",
          boundaryViolations: 0,
        };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("workspace_output.blank_or_truncated");
    expect(prompts[0]).toContain("outputBytes=24");
    expect(prompts[1]).toContain("previous model response only repeated");
    expect(prompts[1]).toContain("workspace_output.blank_or_truncated");
    expect(prompts[1]).toContain("workspace_edit or workspace_write");
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.error).toBeUndefined();
    expect(finalAgentTurn.content).toContain(
      "Updated the package so the writer uses the markdown content field"
    );
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("approved playbook diagnostic follow-ups fail honestly when PI does not edit", async () => {
    for (const followup of ["continue", "Yes go ahead with fixes as per the next actions"]) {
      const store = makeStore();
      const workspaceRoot = await makeWorkspace();
      const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
      await writePromptOnlyMailPackage(packageRoot);
      const task = store.createTask({
        workspaceRoot,
        initialInstruction:
          "in the playbooks/weekly-email-summary my last run failed with a mailSearch schema error.",
      });
      const initialTurn = task.turns[0];
      if (!initialTurn) throw new Error("expected initial turn");
      store.updateTurn(initialTurn.id, {
        status: "completed",
        completedAt: "2026-06-18T00:00:00.000Z",
      });
      store.createAgentTurn(
        task.id,
        [
          "Diagnostics for weekly-email-summary run ba86636e-472a-45ca-82fc-8cca09e7978b: failed.",
          "Requested target: playbooks/weekly-email-summary",
          "",
          "Issues:",
          "- [error] run.failed: Run status is failed. Evidence: Graph node readEmails produced mailSearch that does not match schemas/mailSearch.schema.json: $.messages is required. Suggested fix: Inspect failed or blocked queue entries and repair the smallest package node, prompt, schema, or connector mismatch.",
          "",
          "Next actions:",
          "- Inspect failed or blocked queue entries and repair the smallest package node, prompt, schema, or connector mismatch.",
          "- Check the tool capability, adapter availability, and the node's args.",
          "- After editing the playbook package, run playbook_package_validate for the package path.",
        ].join("\n")
      );
      const userTurn = store.createUserTurn(task.id, followup);
      const agentTurn = store.createQueuedAgentTurn(task.id);
      let callCount = 0;

      await runTaskTurn({
        store,
        taskId: task.id,
        userTurnId: userTurn.id,
        agentTurnId: agentTurn.id,
        piRunner: async () => {
          callCount += 1;
          return { text: "", boundaryViolations: 0 };
        },
        playbookRunDiagnostics: {
          store: emptyPlaybookRunDiagnosticsStore(),
        },
        publish: () => undefined,
        delayMs: 0,
      });

      expect(callCount).toBe(3);
      const finalAgentTurn = store.getTurn(agentTurn.id);
      expect(finalAgentTurn.status).toBe("completed");
      expect(finalAgentTurn.content).toContain("did not update the existing playbook package");
      expect(finalAgentTurn.content).toContain("No package files changed");
      expect(finalAgentTurn.content).toContain(
        "Validation passed for playbooks/weekly-email-summary"
      );
      expect(finalAgentTurn.content).not.toContain(
        "Added an executable integration.mail.messages.read source node"
      );
      expect(store.getTask(task.id)?.status).toBe("done");
    }
  });

  test("approved playbook diagnostic follow-ups do not apply deterministic mail schema repairs", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeBrokenMailToolPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "in the playbooks/weekly-email-summary my last run failed with $.messages is required.",
    });
    const initialTurn = task.turns[0];
    if (!initialTurn) throw new Error("expected initial turn");
    store.updateTurn(initialTurn.id, {
      status: "completed",
      completedAt: "2026-06-18T00:00:00.000Z",
    });
    store.createAgentTurn(
      task.id,
      [
        "Diagnostics for weekly-email-summary run ba86636e-472a-45ca-82fc-8cca09e7978b: failed.",
        "Requested target: playbooks/weekly-email-summary",
        "",
        "Issues:",
        "- [error] queue.failed: tool node readEmails is failed. Evidence: Graph node readEmails produced mailSearch that does not match schemas/mailSearch.schema.json: $.messages is required. Suggested fix: Check the tool capability, adapter availability, and the node's args.",
        "",
        "Next actions:",
        "- Check the tool capability, adapter availability, and the node's args.",
        "- After editing the playbook package, run playbook_package_validate for the package path.",
      ].join("\n")
    );
    const userTurn = store.createUserTurn(task.id, "continue");
    const agentTurn = store.createQueuedAgentTurn(task.id);

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async () => ({ text: "", boundaryViolations: 0 }),
      playbookRunDiagnostics: {
        store: emptyPlaybookRunDiagnosticsStore(),
      },
      publish: () => undefined,
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("did not update the existing playbook package");
    expect(finalAgentTurn.content).toContain("No package files changed");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    const prompt = await readFile(join(packageRoot, "prompts/draft.md"), "utf8");
    expect(prompt).not.toContain("tessera-mail-source-repair");
  });

  test("explicit playbook fix fails honestly when PI stays empty", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writePromptOnlyMailPackage(packageRoot);
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "in the playbooks/weekly-email-summary my last run said the graph declares a mail capability but has no executable mail tool node.",
    });
    const initialTurn = task.turns[0];
    if (!initialTurn) throw new Error("expected initial turn");
    store.updateTurn(initialTurn.id, {
      status: "completed",
      completedAt: "2026-06-18T00:00:00.000Z",
    });
    store.createAgentTurn(
      task.id,
      [
        "Next actions:",
        "- Add a tool node using integration.mail.messages.read that produces a raw mail artifact, and make the draft node consume that artifact.",
        "- After editing the playbook package, run playbook_package_validate for the package path.",
      ].join("\n")
    );
    const userTurn = store.createUserTurn(task.id, "Please do it.");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let callCount = 0;

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async () => {
        callCount += 1;
        return { text: "", boundaryViolations: 0 };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(callCount).toBe(3);
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("did not update the existing playbook package");
    expect(finalAgentTurn.content).toContain("No package files changed");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    const prompt = await readFile(join(packageRoot, "prompts/draft.md"), "utf8");
    expect(prompt).not.toContain("tessera-mail-source-repair");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("explicit debug playbook updates fail honestly when PI stays empty", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    await writePackageFile(
      packageRoot,
      "prompts/draft.md",
      "Return only JSON that matches schemas/finalArtifact.schema.json.\n"
    );
    const task = store.createTask({
      workspaceRoot,
      initialInstruction:
        "for the playbook playbooks/weekly-email-summary can you add debug so that we can track what is happening when we execute the workflow.",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected initial turn");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let callCount = 0;

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async () => {
        callCount += 1;
        return { text: "", boundaryViolations: 0 };
      },
      publish: () => undefined,
      delayMs: 0,
    });

    expect(callCount).toBe(3);
    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("did not update the existing playbook package");
    expect(finalAgentTurn.content).toContain("No package files changed");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    const draft = await readFile(join(packageRoot, "prompts/draft.md"), "utf8");
    expect(draft).not.toContain("tessera-debug-instrumentation");
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("playbook builder repair follow-ups fail honestly when model stays empty", async () => {
    const store = makeStore();
    const workspaceRoot = await makeWorkspace();
    const packageRoot = join(workspaceRoot, "playbooks/weekly-email-summary");
    await writeGraphPackage(packageRoot);
    await writePackageFile(
      packageRoot,
      "prompts/draft.md",
      "Return only JSON that matches schemas/finalArtifact.schema.json.\n"
    );
    const task = store.createTask({
      workspaceRoot,
      initialInstruction: "/tessera-playbook-builder Create a weekly email summary playbook",
    });
    const initialTurn = task.turns[0];
    if (!initialTurn) throw new Error("expected initial turn");
    store.updateTurn(initialTurn.id, {
      status: "completed",
      completedAt: "2026-06-17T00:00:00.000Z",
    });
    store.createAgentTurn(
      task.id,
      "Created a Tessera playbook package at playbooks/weekly-email-summary."
    );
    const userTurn = store.createUserTurn(
      task.id,
      "The playbook does not seem to be working properly. I have getting a blank markdown file."
    );
    store.addActiveSkill(task.id, {
      skillId: "tessera-playbook-builder",
      name: "tessera-playbook-builder",
      source: "workspace",
      activatedByTurnId: userTurn.id,
    });
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      piRunner: async () => ({ text: "", boundaryViolations: 0 }),
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const finalAgentTurn = store.getTurn(agentTurn.id);
    expect(finalAgentTurn.status).toBe("completed");
    expect(finalAgentTurn.content).toContain("did not update the existing playbook package");
    expect(finalAgentTurn.content).toContain("No package files changed");
    expect(finalAgentTurn.content).toContain(
      "Validation passed for playbooks/weekly-email-summary"
    );
    expect(events.some((event) => event.type === "task.clarify_requested")).toBe(false);
    expect(store.getTask(task.id)?.status).toBe("done");
  });

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

    const writerAgent = AgentProfileSchema.parse({
      id: "writer",
      name: "Writer",
      model: { mode: "default" },
      toolPolicyPreset: "read_only",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      execution: {
        agent: writerAgent,
        runtime: compileAgentRuntimeContext(writerAgent),
        provider: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
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
    store.updateTurn(firstUserTurn.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
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

  test("adds compact prior task context to follow-up prompts", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction:
        "Troubleshoot playbooks/weekly-email-summary because the output says no source material.",
    });
    const firstUserTurn = task.turns[0];
    if (!firstUserTurn) throw new Error("expected first turn");
    store.updateTurn(firstUserTurn.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    store.createAgentTurn(
      task.id,
      "Diagnostics found playbook.missing_mail_tool_node. Next action: add integration.mail.messages.read."
    );
    const failedAgentTurn = store.createQueuedAgentTurn(task.id);
    store.updateTurn(failedAgentTurn.id, {
      status: "failed",
      error: "The model did not produce an edit after retry.",
      completedAt: new Date().toISOString(),
    });

    const followupUserTurn = store.createUserTurn(task.id, "Please do it.");
    const followupAgentTurn = store.createQueuedAgentTurn(task.id);
    let capturedPrompt = "";

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: followupUserTurn.id,
      agentTurnId: followupAgentTurn.id,
      piRunner: async (options) => {
        capturedPrompt = options.prompt;
        return { text: "done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(capturedPrompt).toContain("Please do it.");
    expect(capturedPrompt).toContain("Task follow-up context:");
    expect(capturedPrompt).toContain("playbook.missing_mail_tool_node");
    expect(capturedPrompt).toContain("integration.mail.messages.read");
    expect(capturedPrompt).toContain("Previous agent failed");
    expect(capturedPrompt).toContain("did not produce an edit");
  });

  test("marks a completed task active while a follow-up turn runs", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "First message",
    });
    const firstUserTurn = task.turns[0];
    if (!firstUserTurn) throw new Error("expected first turn");
    store.updateTurn(firstUserTurn.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    store.createAgentTurn(task.id, "First response");
    store.updateTask(task.id, { status: "done", latestActivity: "Completed" });

    const secondUserTurn = store.createUserTurn(task.id, "Follow up");
    const secondAgentTurn = store.createQueuedAgentTurn(task.id);
    const events: TaskEvent[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: secondUserTurn.id,
      agentTurnId: secondAgentTurn.id,
      piRunner: async () => ({ text: "follow-up answer", boundaryViolations: 0 }),
      publish: (event) => events.push(event),
      delayMs: 0,
    });

    const taskUpdates = events.filter((event) => event.type === "task.updated");
    const startingUpdate = taskUpdates[0];
    if (startingUpdate?.type === "task.updated") {
      expect(startingUpdate.task.status).toBe("active");
      expect(startingUpdate.task.latestActivity).toBe("Starting");
    }
    const runningUpdate = taskUpdates[1];
    if (runningUpdate?.type === "task.updated") {
      expect(runningUpdate.task.status).toBe("active");
      expect(runningUpdate.task.latestActivity).toBe("Running");
    }
    expect(store.getTask(task.id)?.status).toBe("done");
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
    expect(store.getTask(task.id)?.latestActivity).toBe("Paused: agent reached workspace boundary");
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

  test("passes recalled memory context to Pi runner", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft update",
    });
    const userTurn = store.createUserTurn(task.id, "Draft the weekly update");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let seenMemoryContext = "";
    const recordedTurns: string[] = [];
    let recordedBeforeRecall: string[] = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      memory: {
        async recordTaskTurn({ turn }) {
          recordedTurns.push(turn.id);
          return undefined;
        },
        async recallForTask() {
          recordedBeforeRecall = [...recordedTurns];
          return {
            context: "<tessera-memory-context>\nPrefer concise bullets.\n</tessera-memory-context>",
            result: {
              mode: "task",
              timedOut: false,
              items: [],
              trace: {
                query: "Draft the weekly update",
                workspaceKey: "workspace:test",
                candidateCount: 1,
                selectedCount: 0,
                omittedReasons: [],
                durationMs: 1,
              },
            },
          };
        },
      },
      piRunner: async ({ memoryContext }) => {
        seenMemoryContext = memoryContext ?? "";
        return { text: "Done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(seenMemoryContext).toContain("Prefer concise bullets.");
    expect(recordedBeforeRecall).toEqual([]);
    expect(recordedTurns).toContain(userTurn.id);
    expect(recordedTurns).toContain(agentTurn.id);
  });

  test("automatically proposes memories for recorded completed task turns", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft update",
    });
    const userTurn = store.createUserTurn(
      task.id,
      "For future weekly updates, prefer concise bullets."
    );
    const agentTurn = store.createQueuedAgentTurn(task.id);
    const provider: AgentProviderConfig = {
      provider: "openai",
      model: "gpt-5.4",
      apiKeyEnv: "OPENAI_API_KEY",
    };
    const credential: ModelRuntimeCredential = { apiKey: "sk-test" };
    const proposals: Array<{
      eventIds: string[];
      provider?: AgentProviderConfig;
      credential?: ModelRuntimeCredential | string;
    }> = [];

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      provider,
      credential,
      memory: {
        async recordTaskTurn({ turn }) {
          return {
            id: `memory-event-${turn.id}`,
            eventKey: `task:${turn.taskId}:turn:${turn.id}:${turn.status}`,
            workspaceKey: "workspace:test",
            scope: "task",
            subjectType: "turn",
            subjectId: turn.id,
            eventType: `task.turn.${turn.status}`,
            content: turn.content,
            contentHash: "sha256:test",
            metadata: {},
            sensitivity: "public",
            capturePolicy: "summary",
            schemaVersion: 1,
            createdAt: turn.completedAt ?? "2026-05-13T00:00:00.000Z",
          } satisfies MemoryEvent;
        },
        async recallForTask() {
          return {
            context: "",
            result: {
              mode: "task",
              timedOut: false,
              items: [],
              trace: {
                query: "Draft the weekly update",
                workspaceKey: "workspace:test",
                candidateCount: 0,
                selectedCount: 0,
                omittedReasons: [],
                durationMs: 1,
              },
            },
          };
        },
        async proposeCandidates(input) {
          proposals.push(input);
          return [];
        },
      },
      piRunner: async () => ({ text: "Done", boundaryViolations: 0 }),
      publish() {},
      delayMs: 0,
    });

    expect(proposals).toEqual([
      {
        eventIds: [`memory-event-${userTurn.id}`, `memory-event-${agentTurn.id}`],
        provider,
        credential,
      },
    ]);
  });

  test("recalls active memories created by a previous task turn", async () => {
    const store = makeStore();
    const memoryStore = createMemoryStore(":memory:");
    tempMemoryStores.push(memoryStore);
    const memory = createMemoryManager({ store: memoryStore, ownerId: "local-owner" });
    const firstTask = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Record team preference",
    });
    const firstUserTurn = store.createUserTurn(
      firstTask.id,
      "Remember that weekly customer updates should use concise bullets."
    );
    const firstAgentTurn = store.createQueuedAgentTurn(firstTask.id);

    await runTaskTurn({
      store,
      taskId: firstTask.id,
      userTurnId: firstUserTurn.id,
      agentTurnId: firstAgentTurn.id,
      memory,
      piRunner: async () => ({ text: "Recorded", boundaryViolations: 0 }),
      publish() {},
      delayMs: 0,
    });

    await waitUntil(() =>
      memoryStore
        .listActiveMemories({ workspaceKey: workspaceKeyForRoot("/workspace/acme") })
        .some((item) => item.body === "weekly customer updates should use concise bullets.")
    );

    const secondTask = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft update",
    });
    const secondUserTurn = store.createUserTurn(secondTask.id, "Draft the weekly update");
    const secondAgentTurn = store.createQueuedAgentTurn(secondTask.id);
    let seenMemoryContext = "";

    await runTaskTurn({
      store,
      taskId: secondTask.id,
      userTurnId: secondUserTurn.id,
      agentTurnId: secondAgentTurn.id,
      memory,
      piRunner: async ({ memoryContext }) => {
        seenMemoryContext = memoryContext ?? "";
        return { text: "Done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(seenMemoryContext).toContain("weekly customer updates should use concise bullets.");
  });

  test("continues task execution when memory recall fails", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft update",
    });
    const userTurn = store.createUserTurn(task.id, "Draft the weekly update");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let runnerCalled = false;

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      memory: {
        async recordTaskTurn() {
          return undefined;
        },
        async recallForTask() {
          throw new Error("memory unavailable");
        },
      },
      piRunner: async () => {
        runnerCalled = true;
        return { text: "Done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(runnerCalled).toBe(true);
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("continues task execution when memory hooks throw synchronously", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft update",
    });
    const userTurn = store.createUserTurn(task.id, "Draft the weekly update");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let runnerCalled = false;

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      memory: {
        recordTaskTurn() {
          throw new Error("sync record failure");
        },
        recallForTask() {
          throw new Error("sync recall failure");
        },
      },
      piRunner: async () => {
        runnerCalled = true;
        return { text: "Done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(runnerCalled).toBe(true);
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("continues task execution when memory hooks hang", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft update",
    });
    const userTurn = store.createUserTurn(task.id, "Draft the weekly update");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let runnerCalled = false;
    const startedAt = Date.now();

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      memory: {
        recordTaskTurn() {
          return new Promise<MemoryEvent | undefined>(() => {});
        },
        recallForTask() {
          return new Promise(() => {});
        },
      },
      piRunner: async () => {
        runnerCalled = true;
        return { text: "Done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(runnerCalled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1200);
    expect(store.getTask(task.id)?.status).toBe("done");
  });

  test("uses prompt override for memory recall", async () => {
    const store = makeStore();
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "/skill planning Draft update",
    });
    const userTurn = task.turns[0];
    if (!userTurn) throw new Error("expected first turn");
    const agentTurn = store.createQueuedAgentTurn(task.id);
    let recallQuery = "";
    let seenPrompt = "";

    await runTaskTurn({
      store,
      taskId: task.id,
      userTurnId: userTurn.id,
      agentTurnId: agentTurn.id,
      promptOverride: "Draft update",
      memory: {
        async recordTaskTurn() {
          return undefined;
        },
        async recallForTask({ query }) {
          recallQuery = query;
          return {
            context: "",
            result: {
              mode: "task",
              timedOut: false,
              items: [],
              trace: {
                query,
                candidateCount: 0,
                selectedCount: 0,
                omittedReasons: [],
                durationMs: 1,
              },
            },
          };
        },
      },
      piRunner: async ({ prompt }) => {
        seenPrompt = prompt;
        return { text: "Done", boundaryViolations: 0 };
      },
      publish() {},
      delayMs: 0,
    });

    expect(recallQuery).toBe("Draft update");
    expect(seenPrompt).toBe("Draft update");
    expect(store.getTurn(userTurn.id).content).toBe("/skill planning Draft update");
  });
});
