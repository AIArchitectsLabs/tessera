import type {
  AgentProfile,
  AgentProviderConfig,
  AgentRuntimeContext,
  TaskEvent,
  TaskExecutionConfig,
  TaskSummary,
  TaskTodo,
  TaskTurn,
  TodoOperation,
} from "@tessera/contracts";
import {
  type PiTaskTurnResult,
  type WorkspaceCliExecutor,
  createSkillRegistry,
  createSpawnShellExecutor,
  runPiTaskTurn,
} from "@tessera/core";
import type { TaskStore } from "./task-store.js";

export interface RunTaskTurnOptions {
  credential?: string;
  execution?: TaskExecutionConfig;
  piRunner?: (options: {
    agent?: AgentProfile;
    conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
    credential?: string;
    onActivity?: (activity: string) => void;
    onToolStart?: (tool: { name: string; args: unknown }) => void;
    prompt: string;
    provider: AgentProviderConfig;
    runtime?: AgentRuntimeContext;
    shell?: {
      executeShell(call: {
        command: "web-search" | "web-fetch" | "gcal" | "mail" | "drive" | "contacts";
        subcommand: string;
        args: string[];
      }): Promise<unknown>;
    };
    skillRuntime?: {
      activeSkills?: NonNullable<ReturnType<TaskStore["getTask"]>>["activeSkills"];
      allowedSkillIds?: string[];
      listSkills(): Promise<unknown[]>;
      loadSkill(skillId: string): Promise<unknown>;
    };
    taskRuntime?: {
      applyTodo(operation: TodoOperation): Promise<TaskTodo | undefined>;
    };
    workspaceRoot: string;
  }) => Promise<PiTaskTurnResult>;
  cli?: WorkspaceCliExecutor;
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

function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;

  if (toolName === "shell") {
    const shellCall = args as { command?: string; subcommand?: string; args?: string[] };
    const command = [shellCall.command, shellCall.subcommand].filter(Boolean).join(" ");
    const values = Array.isArray(shellCall.args) ? shellCall.args : [];
    const preview = values.join(" ").trim();
    return [command, preview].filter(Boolean).join(" | ").trim() || undefined;
  }

  const input = args as Record<string, unknown>;
  const firstUseful = [
    input.path,
    input.query,
    input.url,
    input.selector,
    input.itemId,
    input.message,
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  if (typeof firstUseful === "string") return firstUseful.trim();

  return undefined;
}

function toolArtifactTitle(toolName: string, args: unknown): string {
  if (toolName === "shell" && args && typeof args === "object") {
    const shellCall = args as { command?: string; subcommand?: string };
    const label = [shellCall.command, shellCall.subcommand].filter(Boolean).join(" ");
    if (label) return label;
  }

  return toolName.replace(/_/g, " ");
}

function completedTodoItems(todo: TaskTodo): TaskTodo["items"] | undefined {
  if (!todo.items.some((item) => item.status !== "completed")) return undefined;
  return todo.items.map((item) => ({ ...item, status: "completed" as const }));
}

export async function runTaskTurn(opts: RunTaskTurnOptions): Promise<void> {
  const { store, taskId, userTurnId, agentTurnId, publish } = opts;
  const delayMs = opts.delayMs ?? 120;
  const provider = opts.execution?.provider ?? opts.provider ?? DEFAULT_PROVIDER;
  const credential = opts.execution?.credential?.apiKey ?? opts.credential;
  const piRunner = opts.piRunner ?? runPiTaskTurn;
  const shell = opts.cli ? createSpawnShellExecutor(opts.cli) : undefined;

  try {
    const task = store.getTask(taskId);
    const userTurn = store.getTurn(userTurnId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);

    // Only include settled turns; skip in-flight or queued turns from prior waiting cycles.
    const conversationHistory = task.turns
      .filter(
        (turn) =>
          turn.status === "completed" &&
          turn.id !== userTurnId &&
          turn.id !== agentTurnId &&
          (turn.role === "user" || turn.role === "agent")
      )
      .map((turn) => ({ role: turn.role as "user" | "agent", content: turn.content }));

    const updatedUserTurn = store.updateTurn(userTurnId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    if (!updatedUserTurn) throw new Error(`Turn not found: ${userTurnId}`);
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

    const runningAgentTurn = store.updateTurn(agentTurnId, {
      status: "running",
      content: "Working on your request...",
    });
    if (!runningAgentTurn) throw new Error(`Turn not found: ${agentTurnId}`);
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

    const agent = opts.execution?.agent;
    const activeSkills = store.getTask(taskId)?.activeSkills ?? [];
    const allowedSkillIds = Array.from(
      new Set([...(agent?.skills ?? []), ...activeSkills.map((skill) => skill.skillId)])
    );
    const registry = createSkillRegistry({ workspaceRoot: task.workspaceRoot });

    const result = await piRunner({
      ...(opts.execution?.agent !== undefined ? { agent: opts.execution.agent } : {}),
      ...(conversationHistory.length > 0 ? { conversationHistory } : {}),
      ...(credential ? { credential } : {}),
      ...(opts.execution?.runtime !== undefined ? { runtime: opts.execution.runtime } : {}),
      onActivity(activity) {
        store.updateTask(taskId, { latestActivity: activity });
        publish({
          type: "task.updated",
          taskId,
          emittedAt: new Date().toISOString(),
          task: store.getTaskSummary(taskId),
        });
      },
      onToolStart(tool) {
        const contentPreview = summarizeToolArgs(tool.name, tool.args);
        const artifact = store.createArtifact({
          taskId,
          turnId: agentTurnId,
          kind: "text",
          title: toolArtifactTitle(tool.name, tool.args),
          ...(contentPreview ? { contentPreview } : {}),
        });
        publish({
          type: "artifact.created",
          taskId,
          emittedAt: new Date().toISOString(),
          artifact,
        });
      },
      prompt: userTurn.content,
      provider,
      ...(shell ? { shell } : {}),
      skillRuntime: {
        activeSkills,
        allowedSkillIds,
        listSkills() {
          return registry.listSkills({ allowedSkillIds });
        },
        loadSkill(skillId) {
          return registry.loadSkill(skillId, { allowedSkillIds });
        },
      },
      taskRuntime: {
        async applyTodo(operation) {
          const task = store.updateTodo(taskId, operation);
          publish({
            type: "task.todo_updated",
            taskId,
            emittedAt: new Date().toISOString(),
            todo: task?.todo,
          });
          return task?.todo;
        },
      },
      workspaceRoot: task.workspaceRoot,
    });
    const artifactContent = result.text.trim() || "No response was produced.";

    const completedAgentTurn = store.updateTurn(agentTurnId, {
      status: "completed",
      content: artifactContent,
      completedAt: new Date().toISOString(),
    });
    if (!completedAgentTurn) throw new Error(`Turn not found: ${agentTurnId}`);
    publish({
      type: "turn.completed",
      taskId,
      emittedAt: new Date().toISOString(),
      turn: completedAgentTurn,
    });

    if (result.boundaryViolations > 0) {
      store.updateTask(taskId, {
        status: "waiting",
        latestActivity: "Paused: agent reached workspace boundary",
      });
    } else {
      const todoItems = store.getTask(taskId)?.todo;
      const completedItems = todoItems ? completedTodoItems(todoItems) : undefined;
      if (completedItems) {
        const task = store.updateTodo(taskId, { type: "replace", items: completedItems });
        publish({
          type: "task.todo_updated",
          taskId,
          emittedAt: new Date().toISOString(),
          todo: task?.todo,
        });
      }
      store.updateTask(taskId, { status: "done", latestActivity: "Completed" });
    }
    const finalSummary = store.getTaskSummary(taskId);
    publish({
      type: "task.updated",
      taskId,
      emittedAt: new Date().toISOString(),
      task: finalSummary,
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
        agentId: "default",
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
