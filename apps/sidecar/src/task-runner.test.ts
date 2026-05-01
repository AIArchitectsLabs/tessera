import { afterEach, describe, expect, test } from "bun:test";
import type { TaskEvent } from "@tessera/contracts";
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
        return { text: "# Task Output\n\nPi completed this task." };
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
      "artifact.created",
      "turn.completed",
      "task.updated",
    ]);

    const [
      userTurnChanged,
      researchingUpdate,
      agentRunning,
      runningUpdate,
      toolActivityUpdate,
      artifactCreated,
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

    expect(artifactCreated?.type).toBe("artifact.created");
    if (artifactCreated?.type === "artifact.created") {
      expect(artifactCreated.artifact.taskId).toBe(task.id);
      expect(artifactCreated.artifact.kind).toBe("text");
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
    expect(finalTaskDetail?.artifacts).toHaveLength(1);
    expect(finalTaskDetail?.artifacts[0]?.turnId).toBe(agentTurn.id);
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
      piRunner: async () => ({ text: "unused" }),
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
});
