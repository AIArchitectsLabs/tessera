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
        credential: "sk-runtime",
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
