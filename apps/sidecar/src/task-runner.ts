import type { TaskDetail, TaskTurn } from "@tessera/contracts";
import type { TaskStore } from "./task-store.js";

export interface RunTaskTurnOptions {
  store: TaskStore;
  taskId: string;
  userTurnId: string;
}

function buildAgentContent(task: TaskDetail, userTurn: TaskTurn): string {
  const priorUserTurns = task.turns.filter(
    (turn) => turn.role === "user" && turn.id !== userTurn.id
  );
  const contextLine =
    priorUserTurns.length > 0
      ? `I considered ${priorUserTurns.length} prior instruction${priorUserTurns.length === 1 ? "" : "s"}.`
      : "I started from the initial instruction.";

  return [
    `Completed task turn for "${task.title}".`,
    contextLine,
    `Latest instruction: ${userTurn.content}`,
    "Created a text artifact with the current task output.",
  ].join("\n");
}

export function runTaskTurn({ store, taskId, userTurnId }: RunTaskTurnOptions): TaskDetail {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);

  const userTurn = task.turns.find((turn) => turn.id === userTurnId);
  if (!userTurn) throw new Error(`Unknown turn: ${userTurnId}`);
  if (userTurn.role !== "user") throw new Error("Task runner requires a user turn");

  try {
    store.updateTask(taskId, { status: "active", latestActivity: "Working on task" });
    store.updateTurn(userTurnId, { status: "completed" });

    const agentTurn = store.createAgentTurn(taskId, buildAgentContent(task, userTurn));
    store.createArtifact({
      taskId,
      turnId: agentTurn.id,
      kind: "text",
      title: "Task output",
      contentPreview: `Output for "${task.title}": ${userTurn.content}`,
    });

    const updated = store.updateTask(taskId, {
      status: "done",
      latestActivity: "Created task output",
    });
    if (!updated) throw new Error(`Could not update task: ${taskId}`);
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateTurn(userTurnId, { status: "failed", error: message });
    const failed = store.updateTask(taskId, { status: "failed", latestActivity: message });
    if (!failed) throw error;
    return failed;
  }
}
