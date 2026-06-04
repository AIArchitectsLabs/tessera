import type {
  AgentProfile,
  AgentProviderConfig,
  AgentRuntimeContext,
  MemoryEvent,
  ModelRuntimeCredential,
  NotifyRequest,
  TaskEvent,
  TaskExecutionConfig,
  TaskSummary,
  TaskTodo,
  TaskTurn,
  TodoOperation,
} from "@tessera/contracts";
import { BrowserRecipeProposalSchema, BrowserToolResultSchema } from "@tessera/contracts";
import {
  type BrowserExecutor,
  type OptionalCapabilityInstallProgress,
  type OptionalCapabilityManager,
  type PiTaskTurnResult,
  type PythonSkillRunInput,
  type PythonSkillRunResult,
  type WorkspaceCliExecutor,
  createPythonSkillRuntime,
  createSpawnShellExecutor,
  runPiTaskTurn,
} from "@tessera/core";
import type { TesseraMemoryManager } from "./memory-manager.js";
import { createTesseraSkillRegistry } from "./skill-registry.js";
import type { TaskStore } from "./task-store.js";

export interface RunTaskTurnOptions {
  credential?: ModelRuntimeCredential | string;
  execution?: TaskExecutionConfig;
  piRunner?: (options: {
    agent?: AgentProfile;
    conversationHistory?: Array<{ role: "user" | "agent"; content: string }>;
    credential?: ModelRuntimeCredential | string;
    onActivity?: (activity: string) => void;
    onToolEnd?: (tool: { name: string; result: unknown }) => void;
    onToolStart?: (tool: { name: string; args: unknown }) => void;
    prompt: string;
    memoryContext?: string;
    provider: AgentProviderConfig;
    runtime?: AgentRuntimeContext;
    browser?: BrowserExecutor;
    capabilityManager?: OptionalCapabilityManager;
    shell?: {
      executeShell(call: {
        command: "web-search" | "web-fetch" | "gcal" | "mail" | "drive" | "contacts" | "hubspot";
        subcommand: string;
        args: string[];
      }): Promise<unknown>;
    };
    skillRuntime?: {
      activeSkills?: NonNullable<ReturnType<TaskStore["getTask"]>>["activeSkills"];
      allowedSkillIds?: string[];
      listSkills(): Promise<unknown[]>;
      loadSkill(skillId: string): Promise<unknown>;
      runPython?(input: PythonSkillRunInput): Promise<PythonSkillRunResult>;
    };
    taskRuntime?: {
      applyTodo(operation: TodoOperation): Promise<TaskTodo | undefined>;
    };
    workspaceRoot: string;
  }) => Promise<PiTaskTurnResult>;
  browser?: BrowserExecutor;
  capabilityManager?: OptionalCapabilityManager;
  cli?: WorkspaceCliExecutor;
  provider?: AgentProviderConfig;
  promptOverride?: string;
  pythonSkillRoot?: string;
  memory?: Pick<TesseraMemoryManager, "recordTaskTurn" | "recallForTask"> &
    Partial<Pick<TesseraMemoryManager, "proposeCandidates">>;
  store: TaskStore;
  taskId: string;
  userTurnId: string;
  agentTurnId: string;
  publish: (event: TaskEvent) => void;
  delayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MEMORY_HOOK_TIMEOUT_MS = 250;
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

function capabilityProgressBody(progress: OptionalCapabilityInstallProgress): string {
  if (progress.phase === "downloading") {
    const percent =
      progress.downloadedBytes !== undefined &&
      progress.totalBytes !== undefined &&
      progress.totalBytes > 0
        ? ` ${Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))}%`
        : "";
    return `Downloading ${progress.label}...${percent}`;
  }
  if (progress.phase === "verifying") return `Verifying ${progress.label}...`;
  if (progress.phase === "installing") return `Installing ${progress.label}...`;
  return `${progress.label} is ready.`;
}

function createTaskCapabilityManager(options: {
  capabilityManager: OptionalCapabilityManager;
  publish: (event: TaskEvent) => void;
  store: TaskStore;
  taskId: string;
}): OptionalCapabilityManager {
  const { capabilityManager, publish, store, taskId } = options;
  const lastProgressBody = new Map<string, string>();

  function publishProgress(progress: OptionalCapabilityInstallProgress) {
    const body = capabilityProgressBody(progress);
    if (lastProgressBody.get(progress.id) === body) return;
    lastProgressBody.set(progress.id, body);
    const notification: NotifyRequest = {
      title: "Capability setup",
      body,
      taskId,
    };
    store.addNotification(taskId, notification);
    publish({
      type: "task.notification",
      taskId,
      emittedAt: new Date().toISOString(),
      notification,
    });
    store.updateTask(taskId, { latestActivity: body });
    const task = store.getTaskSummary(taskId);
    if (task) {
      publish({
        type: "task.updated",
        taskId,
        emittedAt: new Date().toISOString(),
        task,
      });
    }
  }

  return {
    resolveBinary(capabilityId, binaryName) {
      return capabilityManager.resolveBinary(capabilityId, binaryName);
    },
    status(capabilityId) {
      return capabilityManager.status(capabilityId);
    },
    install(capabilityId, installOptions = {}) {
      return capabilityManager.install(capabilityId, {
        ...installOptions,
        onProgress(progress) {
          publishProgress(progress);
          installOptions.onProgress?.(progress);
        },
      });
    },
  };
}

function browserResultFromToolResult(result: unknown) {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  return BrowserToolResultSchema.safeParse((result as { details?: unknown }).details);
}

function recipeProposalFromBrowserMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || !("recipeProposal" in metadata)) {
    return undefined;
  }
  const proposal = (metadata as { recipeProposal?: unknown }).recipeProposal;
  if (!proposal) return undefined;
  return BrowserRecipeProposalSchema.safeParse(proposal);
}

function completedTodoItems(todo: TaskTodo): TaskTodo["items"] | undefined {
  if (!todo.items.some((item) => item.status !== "completed")) return undefined;
  return todo.items.map((item) => ({ ...item, status: "completed" as const }));
}

function withTimeout<T>(run: () => Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    let work: Promise<T>;
    try {
      work = run();
    } catch {
      clearTimeout(timer);
      resolve(fallback);
      return;
    }
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

async function bestEffortRecordTurn(
  memory: RunTaskTurnOptions["memory"],
  task: NonNullable<ReturnType<TaskStore["getTask"]>>,
  turn: TaskTurn
): Promise<MemoryEvent | undefined> {
  if (!memory) return undefined;
  return withTimeout(
    async () => {
      const event = await memory.recordTaskTurn({ task, turn });
      return event && typeof event === "object" && "id" in event ? event : undefined;
    },
    undefined,
    MEMORY_HOOK_TIMEOUT_MS
  );
}

function scheduleMemoryProposal(input: {
  memory: RunTaskTurnOptions["memory"];
  events: Array<MemoryEvent | undefined>;
  provider: AgentProviderConfig;
  credential?: ModelRuntimeCredential | string;
}): void {
  const eventIds = input.events
    .map((event) => event?.id)
    .filter((eventId): eventId is string => typeof eventId === "string" && eventId.length > 0);
  const proposeCandidates = input.memory?.proposeCandidates;
  if (!proposeCandidates || eventIds.length === 0) return;

  void withTimeout(
    () =>
      proposeCandidates({
        eventIds,
        provider: input.provider,
        ...(input.credential ? { credential: input.credential } : {}),
      }),
    [],
    MEMORY_HOOK_TIMEOUT_MS
  );
}

async function bestEffortRecall(
  memory: RunTaskTurnOptions["memory"],
  task: NonNullable<ReturnType<TaskStore["getTask"]>>,
  query: string
): Promise<string | undefined> {
  if (!memory) return undefined;
  const recalled = await withTimeout(
    () =>
      memory.recallForTask({
        task,
        query,
        mode: "task",
        maxCharacters: 1500,
      }),
    undefined,
    MEMORY_HOOK_TIMEOUT_MS
  );
  return recalled?.context || undefined;
}

function fallbackAgentResponse(options: {
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
  agentTurnId: string;
  boundaryViolations: number;
}): string {
  const lines = [
    options.boundaryViolations > 0
      ? "I reached a workspace boundary before producing a final message."
      : "Completed the task.",
  ];
  const artifacts = options.task.artifacts.filter(
    (artifact) => artifact.turnId === options.agentTurnId
  );
  if (artifacts.length > 0) {
    lines.push(
      "",
      "Tool activity:",
      ...artifacts.map((artifact) => {
        const detail = artifact.path ?? artifact.contentPreview;
        return detail ? `- ${artifact.title}: ${detail}` : `- ${artifact.title}`;
      })
    );
  }
  const completedItems = options.task.todo?.items.filter((item) => item.status === "completed");
  if (completedItems && completedItems.length > 0) {
    lines.push("", "Completed checklist:", ...completedItems.map((item) => `- ${item.label}`));
  }
  return lines.join("\n");
}

export async function runTaskTurn(opts: RunTaskTurnOptions): Promise<void> {
  const { store, taskId, userTurnId, agentTurnId, publish } = opts;
  const delayMs = opts.delayMs ?? 120;
  const provider = opts.execution?.provider ?? opts.provider ?? DEFAULT_PROVIDER;
  const credential = opts.execution?.credential ?? opts.credential;
  const piRunner = opts.piRunner ?? runPiTaskTurn;
  const hubspotAccessToken = opts.execution?.integrationCredentials?.hubspotAccessToken;
  const baseCli = opts.cli;
  const shellCli =
    baseCli && hubspotAccessToken
      ? {
          async runWorkspaceCli(args: string[], timeoutMs?: number) {
            return baseCli.runWorkspaceCli(
              args,
              timeoutMs,
              args[0] === "hubspot"
                ? { TESSERA_HUBSPOT_ACCESS_TOKEN: hubspotAccessToken }
                : undefined
            );
          },
        }
      : baseCli;
  const shell = shellCli ? createSpawnShellExecutor(shellCli) : undefined;

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
    const registry = createTesseraSkillRegistry({ workspaceRoot: task.workspaceRoot });
    const prompt = opts.promptOverride ?? userTurn.content;
    const memoryContext = await bestEffortRecall(opts.memory, task, prompt);
    const userMemoryEvent = await bestEffortRecordTurn(opts.memory, task, updatedUserTurn);
    const capabilityManager = opts.capabilityManager
      ? createTaskCapabilityManager({
          capabilityManager: opts.capabilityManager,
          publish: opts.publish,
          store,
          taskId,
        })
      : undefined;
    const pythonSkillRuntime = opts.pythonSkillRoot
      ? createPythonSkillRuntime({
          rootDir: opts.pythonSkillRoot,
          workspaceRoot: task.workspaceRoot,
          ...(capabilityManager ? { capabilityManager } : {}),
          loadSkill(skillId) {
            return registry.loadSkill(skillId, { allowedSkillIds });
          },
        })
      : undefined;

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
      onToolEnd(tool) {
        if (tool.name !== "browser") return;
        const parsed = browserResultFromToolResult(tool.result);
        if (!parsed?.success) return;
        const browserResult = parsed.data;
        if (browserResult.screenshotPath) {
          const artifact = store.createArtifact({
            taskId,
            turnId: agentTurnId,
            kind: "file",
            title: "Browser screenshot",
            path: browserResult.screenshotPath,
          });
          publish({
            type: "artifact.created",
            taskId,
            emittedAt: new Date().toISOString(),
            artifact,
          });
        }
        const recipe = recipeProposalFromBrowserMetadata(browserResult.metadata);
        if (recipe?.success) {
          const artifact = store.createArtifact({
            taskId,
            turnId: agentTurnId,
            kind: "text",
            title: `Browser recipe proposal: ${recipe.data.domain}`,
            contentPreview: JSON.stringify(recipe.data, null, 2),
          });
          publish({
            type: "artifact.created",
            taskId,
            emittedAt: new Date().toISOString(),
            artifact,
          });
        }
      },
      ...(memoryContext ? { memoryContext } : {}),
      prompt,
      provider,
      ...(opts.browser ? { browser: opts.browser } : {}),
      ...(capabilityManager ? { capabilityManager } : {}),
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
        ...(pythonSkillRuntime ? { runPython: pythonSkillRuntime.runPython } : {}),
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
    const artifactContent =
      result.text.trim() ||
      fallbackAgentResponse({
        task: store.getTask(taskId) ?? task,
        agentTurnId,
        boundaryViolations: result.boundaryViolations,
      });

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
    const agentMemoryEvent = await bestEffortRecordTurn(opts.memory, task, completedAgentTurn);
    scheduleMemoryProposal({
      memory: opts.memory,
      events: [userMemoryEvent, agentMemoryEvent],
      provider,
      ...(credential ? { credential } : {}),
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
