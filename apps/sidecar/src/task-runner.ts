import type { TaskEvent } from "@tessera/contracts";
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
    // Stage 1: Complete the user turn
    store.updateTurn(userTurnId, { status: "completed", completedAt: new Date().toISOString() });
    const updatedUserTurn = store.getTurn(userTurnId);
    publish({
      type: "turn.status_changed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: updatedUserTurn,
    });

    // Stage 2: Update task to "Researching"
    store.updateTask(taskId, { latestActivity: "Researching" });
    const researchingSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: researchingSummary,
    });
    await sleep(delayMs);

    // Stage 3: Mark agent turn "running"
    store.updateTurn(agentTurnId, { status: "running", content: "Drafting response…" });
    const runningAgentTurn = store.getTurn(agentTurnId);
    publish({
      type: "turn.status_changed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: runningAgentTurn,
    });

    // Stage 4: Update task to "Drafting"
    store.updateTask(taskId, { latestActivity: "Drafting" });
    const draftingSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: draftingSummary,
    });
    await sleep(delayMs);

    // Stage 5: Create artifact
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

    // Stage 6: Complete the agent turn
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

    // Stage 7: Mark task done
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
    } catch {
      // ignore secondary failure
    }

    try {
      store.updateTask(taskId, { status: "failed", latestActivity: "Failed" });
    } catch {
      // ignore secondary failure
    }

    try {
      const failedAgentTurn = store.getTurn(agentTurnId);
      publish({
        type: "turn.completed",
        taskId,
        emittedAt: new Date().toISOString(),
        turn: failedAgentTurn,
      });
    } catch {
      // ignore secondary failure
    }

    try {
      const failedSummary = store.getTaskSummary(taskId);
      publish({
        type: "task.updated",
        taskId,
        emittedAt: new Date().toISOString(),
        task: failedSummary,
      });
    } catch {
      // ignore secondary failure
    }
  }
}
