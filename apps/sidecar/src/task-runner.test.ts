import { afterEach, describe, expect, test } from "bun:test";
import { AgentProfileSchema, type TaskEvent, compileAgentRuntimeContext } from "@tessera/contracts";
import { runTaskTurn } from "./task-runner.js";
import { createTaskStore } from "./task-store.js";

const tempStores: ReturnType<typeof createTaskStore>[] = [];

function makeStore(): ReturnType<typeof createTaskStore> {
  const store = createTaskStore(":memory:");
  tempStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
});

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
});
