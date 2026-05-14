import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  type AgentProviderConfig,
  type MemoryEvent,
  type ModelRuntimeCredential,
  type TaskEvent,
  compileAgentRuntimeContext,
} from "@tessera/contracts";
import type { OptionalCapabilityInstallProgress, OptionalCapabilityManager } from "@tessera/core";
import { workspaceKeyForRoot } from "@tessera/core";
import { createMemoryManager } from "./memory-manager.js";
import { createMemoryStore } from "./memory-store.js";
import { runTaskTurn } from "./task-runner.js";
import { createTaskStore } from "./task-store.js";

const tempStores: ReturnType<typeof createTaskStore>[] = [];
const tempMemoryStores: ReturnType<typeof createMemoryStore>[] = [];

function makeStore(): ReturnType<typeof createTaskStore> {
  const store = createTaskStore(":memory:");
  tempStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
  for (const store of tempMemoryStores.splice(0)) {
    store.close();
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
      piRunner: async ({ onToolStart }) => {
        onToolStart?.({
          name: "workspace_write",
          args: { path: "OpenClaw-vs-Hermes-use-cases-analysis.pdf" },
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
