import type { TaskEvent, TaskSummary, TaskTurn } from "@tessera/contracts";
import type { AgentProviderConfig } from "@tessera/contracts";
import { type PiTaskTurnResult, runPiTaskTurn } from "@tessera/core";
import type { TaskStore } from "./task-store.js";

export interface RunTaskTurnOptions {
  credential?: string;
  piRunner?: (options: {
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEFAULT_PROVIDER: AgentProviderConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKeyEnv: "OPENAI_API_KEY",
};

export async function runTaskTurn(opts: RunTaskTurnOptions): Promise<void> {
  const { store, taskId, userTurnId, agentTurnId, publish } = opts;
  const delayMs = opts.delayMs ?? 120;
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const credential =
    opts.credential ??
    (provider.provider === "local" || !("apiKeyEnv" in provider)
      ? undefined
      : process.env[provider.apiKeyEnv]);
  const piRunner = opts.piRunner ?? runPiTaskTurn;

  try {
    const task = store.getTask(taskId);
    const userTurn = store.getTurn(userTurnId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);

    store.updateTurn(userTurnId, { status: "completed", completedAt: new Date().toISOString() });
    const updatedUserTurn = store.getTurn(userTurnId);
    publish({
      type: "turn.status_changed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: updatedUserTurn,
    });

    store.updateTask(taskId, { latestActivity: "Starting" });
    const startingSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: startingSummary,
    });
    await sleep(delayMs);

    store.updateTurn(agentTurnId, { status: "running", content: "Running Pi session..." });
    const runningAgentTurn = store.getTurn(agentTurnId);
    publish({
      type: "turn.status_changed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: runningAgentTurn,
    });

    store.updateTask(taskId, { latestActivity: "Running" });
    const runningSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: runningSummary,
    });
    await sleep(delayMs);

    const result = await piRunner({
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
    const artifactContent = result.text.trim() || "No response was produced.";
    const createdArtifact = store.createArtifact({
      taskId,
      turnId: agentTurnId,
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
