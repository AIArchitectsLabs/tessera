import type { TaskEvent, TaskSummary, TaskTurn } from "@tessera/contracts";
import type { TaskStore } from "./task-store.js";

export interface RunTaskTurnOptions {
  store: TaskStore;
  taskId: string;
  userTurnId: string;
  agentTurnId: string;
  publish: (event: TaskEvent) => void;
  delayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runTaskTurn(opts: RunTaskTurnOptions): Promise<void> {
  const { store, taskId, userTurnId, agentTurnId, publish } = opts;
  const delayMs = opts.delayMs ?? 120;

  try {
    store.updateTurn(userTurnId, { status: "completed", completedAt: new Date().toISOString() });
    const updatedUserTurn = store.getTurn(userTurnId);
    publish({
      type: "turn.status_changed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: updatedUserTurn,
    });

    store.updateTask(taskId, { latestActivity: "Researching" });
    const researchingSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: researchingSummary,
    });
    await sleep(delayMs);

    store.updateTurn(agentTurnId, { status: "running", content: "Drafting response…" });
    const runningAgentTurn = store.getTurn(agentTurnId);
    publish({
      type: "turn.status_changed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: runningAgentTurn,
    });

    store.updateTask(taskId, { latestActivity: "Drafting" });
    const draftingSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: draftingSummary,
    });
    await sleep(delayMs);

    const artifactContent = "# Task Output\n\nHere is the completed work for this task.";
    const createdArtifact = store.createArtifact({
      taskId,
      kind: "text",
      title: "Task Output",
      contentPreview: artifactContent.slice(0, 200),
    });
    publish({
      type: "artifact.created",
      taskId,
      emittedAt: new Date().toISOString(),
      artifact: createdArtifact,
    });

    store.updateTurn(agentTurnId, {
      status: "completed",
      content: artifactContent,
      completedAt: new Date().toISOString(),
    });
    const completedAgentTurn = store.getTurn(agentTurnId);
    publish({
      type: "turn.completed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: completedAgentTurn,
    });

    store.updateTask(taskId, { status: "done", latestActivity: "Completed" });
    const doneSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: doneSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    try {
      store.updateTurn(agentTurnId, {
        status: "failed",
        error: message,
        completedAt: new Date().toISOString(),
      });
    } catch {}

    try {
      store.updateTask(taskId, { status: "failed", latestActivity: "Failed" });
    } catch {}

    const failedTurn: TaskTurn = {
      id: agentTurnId,
      taskId,
      role: "agent",
      content: "",
      status: "failed",
      error: message,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    publish({
      type: "turn.completed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: failedTurn,
    });

    let failedSummary: TaskSummary;
    try {
      failedSummary = store.getTaskSummary(taskId);
    } catch {
      failedSummary = {
        id: taskId,
        workspaceRoot: "",
        title: "",
        status: "failed",
        latestActivity: "Failed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: failedSummary,
    });
  }
}
