import type { Dirent } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type {
  AgentProfile,
  AgentProviderConfig,
  AgentRuntimeContext,
  ClarifyRequest,
  ClarifyResponse,
  GraphPlaybookImportResult,
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
import {
  BrowserRecipeProposalSchema,
  BrowserToolResultSchema,
  ClarifyRequestSchema,
} from "@tessera/contracts";
import {
  type BrowserExecutor,
  type OptionalCapabilityInstallProgress,
  type OptionalCapabilityManager,
  type PiTaskTurnResult,
  type PlaybookGraphPackageFiles,
  type PlaybookPackageScaffoldInput,
  type PlaybookPackageScaffoldResult,
  type PlaybookPackageValidateInput,
  type PlaybookPackageValidateResult,
  type PlaybookPackageValidationStep,
  type PlaybookRunDiagnosticsInput,
  type PlaybookRunDiagnosticsResult,
  type PythonSkillRunInput,
  type PythonSkillRunResult,
  type TaskClarifyInput,
  type WorkspaceCliExecutor,
  assertPackageRelativePath,
  createPythonSkillRuntime,
  createSpawnShellExecutor,
  createWorkspaceGuard,
  hashPlaybookSourceFiles,
  readPlaybookGraphPackage,
  runPiTaskTurn,
} from "@tessera/core";
import ts from "typescript";
import { loadInstalledGraphPlaybookRegistry } from "./graph-playbook-registry.js";
import type { TesseraMemoryManager } from "./memory-manager.js";
import {
  type PlaybookRunDiagnosticsStore,
  diagnosePlaybookRun,
} from "./playbook-run-diagnostics.js";
import { createTesseraSkillRegistry } from "./skill-registry.js";
import type { TaskStore } from "./task-store.js";

export interface PlaybookAutoImportRuntime {
  cacheRoot: string;
  importPackage(input: { sourceRoot: string }): Promise<GraphPlaybookImportResult>;
  installRoot: string;
}

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
      runPython?(input: PythonSkillRunInput): Promise<PythonSkillRunResult>;
    };
    taskRuntime?: {
      applyTodo(operation: TodoOperation): Promise<TaskTodo | undefined>;
      requestClarify(request: TaskClarifyInput): Promise<ClarifyResponse>;
      scaffoldPlaybookPackage(
        request: PlaybookPackageScaffoldInput
      ): Promise<PlaybookPackageScaffoldResult>;
      validatePlaybookPackage(
        request: PlaybookPackageValidateInput
      ): Promise<PlaybookPackageValidateResult>;
      diagnosePlaybookRun?(
        request: PlaybookRunDiagnosticsInput
      ): Promise<PlaybookRunDiagnosticsResult>;
    };
    workspaceRoot: string;
  }) => Promise<PiTaskTurnResult>;
  browser?: BrowserExecutor;
  capabilityManager?: OptionalCapabilityManager;
  cli?: WorkspaceCliExecutor;
  provider?: AgentProviderConfig;
  promptOverride?: string;
  pythonSkillRoot?: string;
  playbookImport?: PlaybookAutoImportRuntime;
  playbookRunDiagnostics?: {
    ownerUserKey?: string;
    store: PlaybookRunDiagnosticsStore;
  };
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

const pendingClarifyResponses = new Map<string, (response: ClarifyResponse) => void>();

function clarifyResponseKey(taskId: string, promptId: string): string {
  return `${taskId}:${promptId}`;
}

export function resolvePendingTaskClarify(taskId: string, response: ClarifyResponse): boolean {
  const key = clarifyResponseKey(taskId, response.promptId);
  const resolve = pendingClarifyResponses.get(key);
  if (!resolve) return false;
  pendingClarifyResponses.delete(key);
  resolve(response);
  return true;
}

function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;

  if (toolName === "playbook_run_diagnostics") {
    const input = args as {
      runId?: string;
      playbookId?: string;
      packagePath?: string;
    };
    return [input.runId, input.playbookId, input.packagePath].filter(Boolean).join(" | ");
  }

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

function normalizeClarifyRequest(taskId: string, request: TaskClarifyInput): ClarifyRequest {
  return ClarifyRequestSchema.parse({
    taskId,
    promptId: request.promptId?.trim() || `clarify-${crypto.randomUUID()}`,
    message: request.message,
    ...(request.detail ? { detail: request.detail } : {}),
    allowFreeform: request.allowFreeform ?? true,
    options: request.options ?? [],
    createdAt: new Date().toISOString(),
  });
}

async function waitForClarifyResponse(input: {
  clarify: ClarifyRequest;
  publish: (event: TaskEvent) => void;
  store: TaskStore;
  taskId: string;
}): Promise<ClarifyResponse> {
  const { clarify, publish, store, taskId } = input;
  const task = store.requestClarify(taskId, clarify);
  if (!task) {
    throw new Error(`Unknown task: ${taskId}`);
  }

  publish({
    type: "task.clarify_requested",
    taskId,
    emittedAt: new Date().toISOString(),
    clarify,
  });
  store.updateTask(taskId, {
    status: "waiting",
    latestActivity: "Clarification needed",
  });
  publish({
    type: "task.updated",
    taskId,
    emittedAt: new Date().toISOString(),
    task: store.getTaskSummary(taskId),
  });

  const key = clarifyResponseKey(taskId, clarify.promptId);
  const response = await new Promise<ClarifyResponse>((resolve) => {
    pendingClarifyResponses.set(key, resolve);
  }).finally(() => {
    pendingClarifyResponses.delete(key);
  });

  store.updateTask(taskId, {
    status: "active",
    latestActivity: "Running",
  });
  publish({
    type: "task.updated",
    taskId,
    emittedAt: new Date().toISOString(),
    task: store.getTaskSummary(taskId),
  });
  return response;
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

function toolResultFailed(result: unknown): boolean {
  return (
    result !== null &&
    result !== undefined &&
    typeof result === "object" &&
    "error" in result &&
    typeof (result as { error?: unknown }).error === "string"
  );
}

function isWorkspaceFileWriteTool(toolName: string): boolean {
  return (
    toolName === "workspace_write" ||
    toolName === "workspace_edit" ||
    toolName === "playbook_package_scaffold"
  );
}

function isPlaybookValidationTool(toolName: string): boolean {
  return toolName === "playbook_package_validate";
}

function isPlaybookSkillId(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "tessera-playbook-builder" ||
    normalized.endsWith(":tessera-playbook-builder") ||
    normalized === "tessera-playbook-debugger" ||
    normalized.endsWith(":tessera-playbook-debugger")
  );
}

function hasActivePlaybookSkill(task: NonNullable<ReturnType<TaskStore["getTask"]>>): boolean {
  return task.activeSkills.some((skill) => {
    return isPlaybookSkillId(skill.skillId) || isPlaybookSkillId(skill.name);
  });
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\/[a-z0-9-]+\s*/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizePackagePath(path: string): string {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
  return normalized || "playbooks/generated-playbook";
}

function normalizeMaybeWorkspacePath(path: string): string | undefined {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
  return normalized || undefined;
}

function inferPlaybookPackagePathFromWorkspacePath(path: string): string | undefined {
  const normalized = normalizeMaybeWorkspacePath(path);
  if (!normalized) return undefined;
  const parts = normalized.split("/").filter(Boolean);
  const playbooksIndex = parts.findIndex((part) => part === "playbooks" || part === "playbook");
  if (playbooksIndex < 0 || parts.length < playbooksIndex + 2) return undefined;
  const packageParts = parts.slice(0, playbooksIndex + 2);
  packageParts[playbooksIndex] = "playbooks";
  return packageParts.join("/");
}

function objectDetails(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("details" in value)) return undefined;
  return (value as { details?: unknown }).details;
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || !(property in value)) return undefined;
  const next = (value as Record<string, unknown>)[property];
  return typeof next === "string" && next.trim() ? next : undefined;
}

function playbookScaffoldResultFromToolResult(
  result: unknown
): PlaybookPackageScaffoldResult | undefined {
  const details = objectDetails(result);
  const packagePath = readStringProperty(details, "packagePath");
  const files =
    details && typeof details === "object" ? (details as { files?: unknown }).files : [];
  if (!packagePath || !Array.isArray(files)) return undefined;
  return {
    packagePath,
    files: files.filter((file): file is string => typeof file === "string"),
  };
}

function playbookValidationResultFromToolResult(
  result: unknown
): PlaybookPackageValidateResult | undefined {
  const details = objectDetails(result);
  const packagePath = readStringProperty(details, "packagePath");
  const ok = details && typeof details === "object" ? (details as { ok?: unknown }).ok : undefined;
  const steps =
    details && typeof details === "object" ? (details as { steps?: unknown }).steps : undefined;
  if (!packagePath || typeof ok !== "boolean" || !Array.isArray(steps)) return undefined;
  return {
    packagePath,
    ok,
    steps: steps.filter(
      (step): step is PlaybookPackageValidationStep =>
        !!step &&
        typeof step === "object" &&
        typeof (step as { name?: unknown }).name === "string" &&
        typeof (step as { command?: unknown }).command === "string" &&
        typeof (step as { ok?: unknown }).ok === "boolean"
    ),
  };
}

function playbookPackagePathFromToolActivity(input: {
  args: unknown;
  result: unknown;
  toolName: string;
}): string | undefined {
  if (input.toolName === "playbook_package_scaffold") {
    return (
      playbookScaffoldResultFromToolResult(input.result)?.packagePath ??
      readStringProperty(input.args, "packagePath")
    );
  }

  if (input.toolName === "playbook_package_validate") {
    return (
      playbookValidationResultFromToolResult(input.result)?.packagePath ??
      readStringProperty(input.args, "packagePath")
    );
  }

  if (input.toolName === "workspace_write" || input.toolName === "workspace_edit") {
    const path =
      readStringProperty(input.args, "path") ??
      readStringProperty(objectDetails(input.result), "path");
    return path ? inferPlaybookPackagePathFromWorkspacePath(path) : undefined;
  }

  return undefined;
}

function hasPlaybookCreationIntent(text: string): boolean {
  return (
    /\b(?:create|build|make|generate|draft|scaffold)\b[\s\S]{0,120}\b(?:tessera\s+)?playbook(?:\s+package)?\b/i.test(
      text
    ) || /\bnew\b[\s\S]{0,60}\b(?:tessera\s+)?playbook(?:\s+package)?\b/i.test(text)
  );
}

function hasExistingPlaybookChangeIntent(text: string): boolean {
  return /\b(?:blank|broken|change|connector|debug|does(?:n't| not)|enhance|error|fail(?:ed|ing|s)?|fix|gmail|improve|invalid|issue|mail|missing|modify|not working|output|repair|source|source material|tool node|troubleshoot|update)\b/i.test(
    text
  );
}

function hasPlaybookDiagnosticsIntent(text: string): boolean {
  return /\b(?:blank|check|connector|diagnos(?:e|is|tic)|gmail|inspect|last run|logs?|no emails?|output|source material|troubleshoot|why)\b/i.test(
    text
  );
}

function hasPlaybookDiagnosticsSummary(text: string): boolean {
  return (
    /\bDiagnostics for\b[\s\S]{0,1800}\bIssues:/i.test(text) ||
    /\bPlaybook diagnostics\b[\s\S]{0,1800}\bIssues:/i.test(text)
  );
}

function hasPlaybookRepairNextActions(text: string): boolean {
  return /\bNext actions:[\s\S]{0,1800}\bplaybook_package_validate\b/i.test(text);
}

function collectBulletsAfterHeader(text: string, header: string): string[] {
  const lines = text.split(/\r?\n/);
  const bullets: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (new RegExp(`^${header}:\\s*$`, "i").test(trimmed)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/^[A-Z][A-Za-z ]+:$/.test(trimmed)) break;
    if (/^-\s+/.test(trimmed)) {
      bullets.push(trimmed.replace(/^-\s+/, ""));
    }
  }
  return bullets;
}

function latestPlaybookDiagnosticsRepairContext(
  task: NonNullable<ReturnType<TaskStore["getTask"]>>
): { issues: string[]; nextActions: string[] } | undefined {
  for (const turn of [...task.turns].reverse()) {
    const text = settledTurnText(turn);
    if (!text || !hasPlaybookDiagnosticsSummary(text) || !hasPlaybookRepairNextActions(text)) {
      continue;
    }
    const issues = collectBulletsAfterHeader(text, "Issues").slice(0, 6);
    const nextActions = collectBulletsAfterHeader(text, "Next actions").slice(0, 6);
    return { issues, nextActions };
  }
  return undefined;
}

function playbookDiagnosticsRepairBrief(
  task: NonNullable<ReturnType<TaskStore["getTask"]>>
): string | undefined {
  const context = latestPlaybookDiagnosticsRepairContext(task);
  if (!context) return undefined;
  const lines = ["Approved diagnostics to act on:"];
  if (context.issues.length > 0) {
    lines.push("Issues:", ...context.issues.map((issue) => `- ${issue}`));
  }
  if (context.nextActions.length > 0) {
    lines.push("Next actions:", ...context.nextActions.map((action) => `- ${action}`));
  }
  return lines.join("\n");
}

function shouldUsePlaybookScaffoldFallback(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (hasExistingPlaybookChangeIntent(text)) return false;
  return hasPlaybookCreationIntent(text);
}

function playbookPackagePathCandidatesFromText(text: string): string[] {
  const candidates = new Set<string>();
  const matches = text.matchAll(/\bplaybooks?\/[A-Za-z0-9][A-Za-z0-9._/-]*/g);
  for (const match of matches) {
    const raw = match[0]?.replace(/[.,;:!?)}\]"'`]+$/g, "");
    if (!raw) continue;
    const packagePath =
      inferPlaybookPackagePathFromWorkspacePath(raw) ??
      (raw.split("/").length >= 2
        ? normalizePackagePath(raw.split("/").slice(0, 2).join("/"))
        : undefined);
    if (packagePath) {
      candidates.add(packagePath);
    }
  }
  const namedPlaybookMatches = text.matchAll(
    /\bplaybook(?:\s+package)?\s+(?:called\s+|named\s+|id\s+|path\s+)?[`'"]?([A-Za-z0-9][A-Za-z0-9._-]*[._-][A-Za-z0-9._-]*)/gi
  );
  for (const match of namedPlaybookMatches) {
    const raw = match[1]?.replace(/[.,;:!?)}\]"'`]+$/g, "");
    if (!raw) continue;
    candidates.add(`playbooks/${slugify(raw, "generated-playbook")}`);
  }
  return Array.from(candidates);
}

function uniquePlaybookPackagePaths(paths: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(paths).map(normalizePackagePath)));
}

function normalizePlaybookSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compactPromptContextText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}...`;
}

const PLAYBOOK_UPDATE_CONTEXT_FILE_LIMIT = 18;
const PLAYBOOK_UPDATE_CONTEXT_TREE_LIMIT = 80;

function truncatePromptBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n... [truncated ${value.length - maxChars} chars]`;
}

function shouldSkipPlaybookContextDirectory(name: string): boolean {
  return [
    ".git",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    ".next",
  ].includes(name);
}

function playbookContextFilePriority(path: string): number | undefined {
  if (path === "manifest.json") return 0;
  if (path === "playbook.ts" || path === "playbook.js") return 1;
  if (path === "PLAYBOOK.md" || path === "README.md") return 2;
  if (/^schemas\/[^/]+\.(?:json|schema\.json)$/i.test(path)) return 3;
  if (/^prompts\/[^/]+\.(?:md|txt)$/i.test(path)) return 4;
  if (/^scripts\/[^/]+\.(?:ts|tsx|js|mjs|cjs)$/i.test(path)) return 5;
  if (/^tests?\/[^/]+\.(?:ts|tsx|js|mjs|cjs)$/i.test(path)) return 6;
  if (path === "package.json" || path === "tsconfig.json") return 7;
  return undefined;
}

async function listPlaybookPackageFiles(input: {
  absolutePackagePath: string;
  relativeDir?: string;
  depth?: number;
}): Promise<string[]> {
  const relativeDir = input.relativeDir ?? "";
  const depth = input.depth ?? 0;
  if (depth > 4) return [];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(join(input.absolutePackagePath, relativeDir), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (shouldSkipPlaybookContextDirectory(entry.name)) continue;
      files.push(
        ...(await listPlaybookPackageFiles({
          absolutePackagePath: input.absolutePackagePath,
          depth: depth + 1,
          relativeDir: relativePath,
        }))
      );
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function playbookBuilderUpdateContextPack(input: {
  packagePaths?: string[];
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
  workspaceRoot: string;
}): Promise<string | undefined> {
  if (!shouldUsePlaybookUpdateFlow(input)) return undefined;
  const packagePaths = playbookPackagePathCandidatesForTask(input);
  if (packagePaths.length !== 1) return undefined;
  const packagePath = normalizePackagePath(packagePaths[0] ?? "");
  if (!/^playbooks\/[^/]+$/.test(packagePath)) return undefined;

  const absolutePackagePath = join(input.workspaceRoot, packagePath);
  const files = await listPlaybookPackageFiles({ absolutePackagePath });
  if (files.length === 0) return undefined;

  const prioritizedFiles = files
    .map((path) => ({ path, priority: playbookContextFilePriority(path) }))
    .filter((file): file is { path: string; priority: number } => file.priority !== undefined)
    .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path))
    .slice(0, PLAYBOOK_UPDATE_CONTEXT_FILE_LIMIT);

  const fileSections: string[] = [];
  for (const file of prioritizedFiles) {
    try {
      const content = await readFile(join(absolutePackagePath, file.path), "utf8");
      fileSections.push(
        [
          `--- ${packagePath}/${file.path} ---`,
          truncatePromptBlock(content, file.priority <= 2 ? 6000 : 3000),
        ].join("\n")
      );
    } catch {
      // Best-effort prompt context only; the model can still inspect with workspace tools.
    }
  }

  const tree = files
    .slice(0, PLAYBOOK_UPDATE_CONTEXT_TREE_LIMIT)
    .map((path) => `- ${path}`)
    .join("\n");
  const omittedTree =
    files.length > PLAYBOOK_UPDATE_CONTEXT_TREE_LIMIT
      ? `\n- ... ${files.length - PLAYBOOK_UPDATE_CONTEXT_TREE_LIMIT} more file(s) omitted`
      : "";

  return [
    "Tessera playbook implementation context (read-only snapshot for the next PI turn).",
    `Target package: ${packagePath}`,
    `User request: ${compactPromptContextText(input.prompt, 1200)}`,
    "Use this snapshot to choose concrete package edits. If it is stale or insufficient, inspect the workspace with workspace_read/workspace_list/workspace_search before editing.",
    [
      "UI/output contract:",
      '- "Display in UI" can mean a run-result output card, human review UI, dashboard UI, or a clarification question.',
      "- Default to a run-result output card for final output visibility when the user does not mention dashboards, charts, layouts, or refreshable dashboard behavior.",
      "- A run-result UI card must be backed by metadata.outputs and an actually produced output or artifact id; metadata.outputs.kind must match the produced value.",
      '- Minimal edit: find the final artifact produced by a node, such as `output: { artifact: "finalArtifact" }` or `outputArtifact: "scorecard"`, then add or append `metadata.outputs: [{ kind: "<thatArtifactId>", label: "<human label>" }]` in `playbook.ts`.',
      "- If `metadata.outputs` already contains a workspace/document/file output, preserve it and append the run-result output; do not replace existing markdown materialization unless asked.",
      "- Keep any existing markdown/file artifact behavior unless the user explicitly asks to replace it.",
      "- If the requested UI surface is still ambiguous, call clarify instead of editing.",
    ].join("\n"),
    `Package file tree:\n${tree}${omittedTree}`,
    ...fileSections,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function settledTurnText(turn: TaskTurn): string | undefined {
  const text =
    turn.status === "failed"
      ? turn.error?.trim() || turn.content?.trim()
      : turn.content?.trim() || turn.error?.trim();
  return text || undefined;
}

function playbookTaskContextText(task: NonNullable<ReturnType<TaskStore["getTask"]>>): string {
  const turnText = task.turns
    .map(settledTurnText)
    .filter((value): value is string => Boolean(value))
    .slice(-8)
    .join("\n");
  const artifactText = task.artifacts
    .flatMap((artifact) => [artifact.path, artifact.contentPreview])
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return [turnText, artifactText].filter(Boolean).join("\n");
}

function hasPlaybookFollowupIntent(text: string): boolean {
  return /\b(?:apply (?:it|that|the fixes?|the change)|carry on|continue|do (?:it|that|the fixes?|the next actions?)|go ahead|make (?:it|that|the change)|please do|proceed|same issue|that issue|this issue|yes)\b/i.test(
    text
  );
}

function playbookPackagePathCandidatesFromTask(
  task: NonNullable<ReturnType<TaskStore["getTask"]>>
): string[] {
  const candidates = new Set<string>();
  for (const turn of task.turns) {
    for (const packagePath of playbookPackagePathCandidatesFromText(turn.content)) {
      candidates.add(packagePath);
    }
  }
  for (const artifact of task.artifacts) {
    for (const value of [artifact.path, artifact.contentPreview]) {
      if (!value) continue;
      for (const packagePath of playbookPackagePathCandidatesFromText(value)) {
        candidates.add(packagePath);
      }
    }
  }
  return Array.from(candidates);
}

interface WorkspacePlaybookPackageCandidate {
  id?: string;
  name?: string;
  packagePath: string;
  slug: string;
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || !(property in value)) return undefined;
  const next = (value as Record<string, unknown>)[property];
  return typeof next === "string" && next.trim() ? next.trim() : undefined;
}

async function workspacePlaybookPackageCandidates(
  workspaceRoot: string
): Promise<WorkspacePlaybookPackageCandidate[]> {
  const playbooksRoot = join(workspaceRoot, "playbooks");
  let slugs: string[];
  try {
    slugs = (await readdir(playbooksRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => String(entry.name));
  } catch {
    return [];
  }

  const candidates: WorkspacePlaybookPackageCandidate[] = [];
  for (const slug of slugs) {
    const packagePath = `playbooks/${slug}`;
    let id: string | undefined;
    let name: string | undefined;
    try {
      const manifest = JSON.parse(
        await readFile(join(playbooksRoot, slug, "manifest.json"), "utf8")
      );
      id = stringProperty(manifest, "id");
      name = stringProperty(manifest, "name");
    } catch {
      id = undefined;
      name = undefined;
    }
    candidates.push({
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      packagePath,
      slug,
    });
  }
  return candidates;
}

function textMentionsWorkspacePlaybookCandidate(
  text: string,
  candidate: WorkspacePlaybookPackageCandidate
): boolean {
  const normalizedText = normalizePlaybookSearchText(text);
  if (!normalizedText) return false;
  const candidateTexts = uniquePlaybookPackagePaths([
    candidate.packagePath,
    candidate.slug,
    ...(candidate.id ? [candidate.id] : []),
    ...(candidate.name ? [candidate.name] : []),
  ])
    .map(normalizePlaybookSearchText)
    .filter((value) => value.length >= 3);
  return candidateTexts.some(
    (candidateText) => normalizedText === candidateText || normalizedText.includes(candidateText)
  );
}

async function playbookPackagePathCandidatesFromWorkspace(input: {
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
  prompt: string;
}): Promise<string[]> {
  const text = [input.prompt, playbookTaskContextText(input.task)].filter(Boolean).join("\n");
  const candidates = await workspacePlaybookPackageCandidates(input.task.workspaceRoot);
  return uniquePlaybookPackagePaths(
    candidates
      .filter((candidate) => textMentionsWorkspacePlaybookCandidate(text, candidate))
      .map((candidate) => candidate.packagePath)
  );
}

function playbookPackagePathCandidatesForTask(input: {
  packagePaths?: string[];
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): string[] {
  return uniquePlaybookPackagePaths([
    ...playbookPackagePathCandidatesFromTask(input.task),
    ...(input.packagePaths ?? []),
  ]);
}

function shouldUsePlaybookUpdateFlow(input: {
  packagePaths?: string[];
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): boolean {
  const context = playbookTaskContextText(input.task);
  const hasCurrentUpdateIntent = hasExistingPlaybookChangeIntent(input.prompt);
  const hasContextualUpdateIntent =
    hasPlaybookFollowupIntent(input.prompt) && hasExistingPlaybookChangeIntent(context);
  if (!hasCurrentUpdateIntent && !hasContextualUpdateIntent) return false;
  if (hasActivePlaybookSkill(input.task)) return true;
  return (
    playbookPackagePathCandidatesFromText(input.prompt).length > 0 ||
    playbookPackagePathCandidatesFromTask(input.task).length > 0 ||
    (input.packagePaths?.length ?? 0) > 0
  );
}

function hasApprovedPlaybookRepairNextActions(input: {
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): boolean {
  if (!hasPlaybookFollowupIntent(input.prompt)) return false;
  const context = playbookTaskContextText(input.task);
  return hasPlaybookRepairNextActions(context);
}

function shouldValidatePlaybookPackageWrites(input: {
  packagePaths?: string[];
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): boolean {
  return hasActivePlaybookSkill(input.task) || shouldUsePlaybookUpdateFlow(input);
}

function playbookBuilderRepairPromptContext(input: {
  packagePaths?: string[];
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): string | undefined {
  if (!shouldUsePlaybookUpdateFlow(input)) {
    return undefined;
  }

  const packagePaths = playbookPackagePathCandidatesForTask(input);
  const targetLine =
    packagePaths.length > 0
      ? `Existing package candidate${packagePaths.length === 1 ? "" : "s"}: ${packagePaths.join(", ")}.`
      : "No existing package path was detected in the task history or workspace playbooks folder; ask which playbooks/<name> folder to inspect.";
  const approvedDiagnosticsNextActions = hasApprovedPlaybookRepairNextActions(input);
  const diagnosticsBrief = playbookDiagnosticsRepairBrief(input.task);

  return [
    "Tessera runtime note: treat this as an existing playbook update, enhancement, or repair request, not a new playbook creation request.",
    targetLine,
    approvedDiagnosticsNextActions
      ? "The user is approving previously listed repair or diagnostic next actions. Work on those actions now: inspect and edit package files, then validate. Do not repeat the diagnostics summary or call playbook_run_diagnostics as the only action."
      : "For failed, blank, source-unavailable, connector, Gmail/mail, last-run, or troubleshooting requests, call playbook_run_diagnostics first with the package path or run id, then use the run evidence to decide whether package files need edits.",
    ...(diagnosticsBrief ? [diagnosticsBrief] : []),
    "Inspect the existing package files with workspace tools. If the requested target or update remains ambiguous after inspection, use clarify in the task UI before editing.",
    "If the request asks to display a final result in the UI, classify the surface first: run-result output card, human review UI, dashboard UI, or clarification. Default to a run-result output card when the user asks for final output visibility and does not mention dashboards, charts, layouts, or refreshable dashboard behavior.",
    "For run-result UI, edit the package so metadata.outputs declares a final output whose kind matches an actually produced run output or artifact id, backed by a schema, and materialize/path it when the card should open a file.",
    "For clear updates, PI must edit the package with workspace_edit or workspace_write and then run playbook_package_validate for the package path. Validation proves package shape; it does not prove the requested semantic update happened.",
    "Do not call playbook_package_scaffold unless the user explicitly asks to regenerate the package from scratch.",
  ].join("\n");
}

function playbookBuilderRepairRetryPrompt(input: {
  packagePaths?: string[];
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
  updateContext?: string;
}): string {
  const packagePaths = playbookPackagePathCandidatesForTask(input);
  const targetLine =
    packagePaths.length === 1
      ? `Target package: ${packagePaths[0]}.`
      : packagePaths.length > 1
        ? `Candidate packages: ${packagePaths.join(", ")}. If the target is ambiguous, use clarify before editing.`
        : "No existing package path was detected. Use clarify to ask which playbooks/<name> folder to update.";
  const approvedDiagnosticsNextActions = hasApprovedPlaybookRepairNextActions(input);
  const diagnosticsBrief = playbookDiagnosticsRepairBrief(input.task);

  return [
    "Tessera runtime retry: the previous model turn produced no user-visible response and no tool calls.",
    "This is an existing playbook update/repair turn, so validation-only is not enough.",
    targetLine,
    approvedDiagnosticsNextActions
      ? "The user already approved repair or diagnostic next actions. Use that evidence as the repair brief; do not run diagnostics again as the only action."
      : "If this is a troubleshooting/source/connector/run-output request, call playbook_run_diagnostics first and summarize the run evidence before editing.",
    ...(diagnosticsBrief ? [diagnosticsBrief] : []),
    "Use native tools now: inspect with workspace_read/workspace_list/workspace_search if needed, update the package with workspace_edit or workspace_write, then call playbook_package_validate.",
    "If the request remains ambiguous after inspection, use clarify with one focused task-UI question before editing. Do not guess across run-result UI, human review UI, and dashboard UI.",
    "If the request asks to display a final result in the UI, prefer a run-result output card unless the user explicitly asks for a dashboard, chart, layout, or refreshable dashboard.",
    "For run-result UI, ensure metadata.outputs.kind matches an actually produced run output or artifact id, the artifact has a schema, and materialization/path exists when the UI card should open a file.",
    "If the request asks for debug messages or troubleshooting visibility, add diagnostic guidance or package-local debug output to the relevant prompt, script, or playbook files.",
    "Do not finish this turn unless you either changed package files, or used clarify because the target/update is truly ambiguous.",
    ...(input.updateContext ? ["", input.updateContext] : []),
  ].join("\n");
}

function playbookDiagnosticsOnlyRetryPrompt(input: {
  packagePaths?: string[];
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
  updateContext?: string;
}): string {
  const packagePaths = playbookPackagePathCandidatesForTask(input);
  const targetLine =
    packagePaths.length === 1
      ? `Target package: ${packagePaths[0]}.`
      : packagePaths.length > 1
        ? `Candidate packages: ${packagePaths.join(", ")}. If the target is ambiguous, use clarify before editing.`
        : "No existing package path was detected. Use clarify to ask which playbooks/<name> folder to update.";
  const diagnosticsBrief = playbookDiagnosticsRepairBrief(input.task);

  return [
    "Tessera runtime retry: the previous model response only repeated playbook diagnostics or troubleshooting.",
    "The user approved the prior Next actions, so continue with the repair work now.",
    targetLine,
    ...(diagnosticsBrief ? [diagnosticsBrief] : []),
    "Do not call playbook_run_diagnostics again unless you first changed package files or the run id is missing.",
    "Use native tools now: inspect with workspace_read/workspace_list/workspace_search if needed, update the package with workspace_edit or workspace_write, then call playbook_package_validate.",
    "If the diagnostics are insufficient to choose a safe edit, explain the blocker and the exact missing evidence instead of repeating the same troubleshooting summary.",
    ...(input.updateContext ? ["", input.updateContext] : []),
  ].join("\n");
}

function playbookBuilderImplementationRetryPrompt(input: {
  packagePaths?: string[];
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
  updateContext?: string;
}): string {
  const packagePaths = playbookPackagePathCandidatesForTask(input);
  const targetLine =
    packagePaths.length === 1
      ? `Target package: ${packagePaths[0]}.`
      : packagePaths.length > 1
        ? `Candidate packages: ${packagePaths.join(", ")}. If the target is ambiguous, use clarify before editing.`
        : "No existing package path was detected. Use clarify to ask which playbooks/<name> folder to update.";
  const approvedDiagnosticsNextActions = hasApprovedPlaybookRepairNextActions(input);
  const diagnosticsBrief = playbookDiagnosticsRepairBrief(input.task);

  return [
    "Tessera runtime implementation retry: the previous model turn did not mutate the existing playbook package.",
    "Validation-only, diagnostics-only, or prose-only work is not a completed feature/update.",
    targetLine,
    approvedDiagnosticsNextActions
      ? "The user approved the prior repair or diagnostic next actions. Implement those package edits now."
      : "For a clear feature/update request, implement the requested workflow change now.",
    ...(diagnosticsBrief ? [diagnosticsBrief] : []),
    "Use PI tools in this turn: inspect only as needed, then edit package files with workspace_edit or workspace_write.",
    "If the requested target, workflow behavior, or UI surface is truly ambiguous, call clarify with one focused task-UI question instead of validating the unchanged package.",
    'For "display in UI", default to preserving the existing markdown/file output and additionally declaring/materializing a run-result UI output unless dashboard, chart, layout, or refreshable behavior is explicitly requested.',
    "Concrete run-result UI edit recipe: in playbook.ts, find the final produced artifact id from `output.artifact` or `outputArtifact`; add or append a `metadata.outputs` entry whose `kind` is exactly that artifact id and whose `label` describes the user-facing result; keep existing workspaceDocument/file outputs; add or fix the artifact schema only if missing.",
    "The runner intentionally withholds playbook_package_validate during this implementation retry and will validate automatically after a successful package write.",
    "The runner will fail this turn if no workspace_edit or workspace_write succeeds.",
    "Finish only after a package file changed or a clarify question was raised.",
    ...(input.updateContext ? ["", input.updateContext] : []),
  ].join("\n");
}

function playbookBuilderScaffoldRetryPrompt(input: {
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): string {
  const inferred = inferPlaybookScaffoldRequest(input);
  return [
    "Tessera runtime note: you were asked to create a new playbook but no package files were written yet.",
    `Call playbook_package_scaffold now to start the package. Suggested package path: ${inferred.packagePath} (name: ${inferred.name}).`,
    "If the suggested name does not match the user's intent, use the clarify tool to ask for the correct name before scaffolding.",
    "After scaffolding, use workspace_write or workspace_edit to add bespoke content for this specific workflow, then call playbook_package_validate.",
  ].join("\n");
}

function playbookImplementationRetryRuntime(
  runtime: AgentRuntimeContext | undefined
): AgentRuntimeContext | undefined {
  if (!runtime) return undefined;
  const blockedTools = new Set([
    "playbook_package_scaffold",
    "playbook_package_validate",
    "playbook_run_diagnostics",
  ]);
  return {
    ...runtime,
    toolPolicy: {
      ...runtime.toolPolicy,
      allowedTools: runtime.toolPolicy.allowedTools.filter((tool) => !blockedTools.has(tool)),
    },
  };
}

function hasPlaybookRepairBlockerExplanation(text: string): boolean {
  return /\b(?:ambiguous|blocked|blocker|cannot safely|can't safely|could not safely|insufficient evidence|missing evidence|need(?:ed|s)? (?:a |an |the )?(?:package path|run id|credential|permission|connector access|access)|requires clarification|which package)\b/i.test(
    text
  );
}

function hasPlaybookNoChangeExplanation(text: string): boolean {
  return /\b(?:already fixed|already valid|no (?:package )?(?:edit|change|repair) (?:is )?(?:needed|required)|package is valid)\b/i.test(
    text
  );
}

function shouldRequireApprovedPlaybookRepairAction(input: {
  boundaryViolations: number;
  playbookRunDiagnosticsToolActivity: boolean;
  playbookValidationToolActivity: boolean;
  prompt: string;
  resultText: string;
  successfulToolActivity: boolean;
  successfulWorkspaceFileActivity: boolean;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): boolean {
  if (input.boundaryViolations > 0) return false;
  if (!hasApprovedPlaybookRepairNextActions({ prompt: input.prompt, task: input.task })) {
    return false;
  }
  if (input.successfulWorkspaceFileActivity) return false;
  if (input.successfulToolActivity && hasPlaybookRepairBlockerExplanation(input.resultText)) {
    return false;
  }
  if (input.playbookValidationToolActivity && hasPlaybookNoChangeExplanation(input.resultText)) {
    return false;
  }
  return true;
}

function shouldRequirePlaybookUpdateAction(input: {
  boundaryViolations: number;
  clarifyToolActivity: boolean;
  packagePaths?: string[];
  playbookRunDiagnosticsToolActivity: boolean;
  prompt: string;
  resultText: string;
  successfulWorkspaceFileActivity: boolean;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): boolean {
  if (input.boundaryViolations > 0) return false;
  if (
    !shouldUsePlaybookUpdateFlow({
      ...(input.packagePaths !== undefined ? { packagePaths: input.packagePaths } : {}),
      prompt: input.prompt,
      task: input.task,
    })
  ) {
    return false;
  }
  if (input.successfulWorkspaceFileActivity || input.clarifyToolActivity) return false;
  if (hasPlaybookRepairBlockerExplanation(input.resultText)) return false;
  if (
    input.playbookRunDiagnosticsToolActivity &&
    hasPlaybookDiagnosticsIntent(input.prompt) &&
    !hasApprovedPlaybookRepairNextActions({ prompt: input.prompt, task: input.task })
  ) {
    return false;
  }
  return true;
}

function shouldRetryPlaybookApprovedRepairFollowup(input: {
  boundaryViolations: number;
  playbookRunDiagnosticsToolActivity: boolean;
  playbookValidationToolActivity: boolean;
  prompt: string;
  resultText: string;
  successfulToolActivity: boolean;
  successfulWorkspaceFileActivity: boolean;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): boolean {
  if (
    !shouldRequireApprovedPlaybookRepairAction({
      boundaryViolations: input.boundaryViolations,
      playbookRunDiagnosticsToolActivity: input.playbookRunDiagnosticsToolActivity,
      playbookValidationToolActivity: input.playbookValidationToolActivity,
      prompt: input.prompt,
      resultText: input.resultText,
      successfulToolActivity: input.successfulToolActivity,
      successfulWorkspaceFileActivity: input.successfulWorkspaceFileActivity,
      task: input.task,
    })
  ) {
    return false;
  }
  return (
    input.playbookRunDiagnosticsToolActivity ||
    hasPlaybookDiagnosticsSummary(input.resultText) ||
    !input.successfulToolActivity ||
    !input.playbookValidationToolActivity
  );
}

function shouldRetryPlaybookUpdateImplementation(input: {
  boundaryViolations: number;
  clarifyToolActivity: boolean;
  packagePaths?: string[];
  playbookRunDiagnosticsToolActivity: boolean;
  playbookUpdateImplementationRetryUsed: boolean;
  prompt: string;
  resultText: string;
  successfulWorkspaceFileActivity: boolean;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): boolean {
  if (input.playbookUpdateImplementationRetryUsed) return false;
  if (
    !shouldRequirePlaybookUpdateAction({
      boundaryViolations: input.boundaryViolations,
      clarifyToolActivity: input.clarifyToolActivity,
      ...(input.packagePaths !== undefined ? { packagePaths: input.packagePaths } : {}),
      playbookRunDiagnosticsToolActivity: input.playbookRunDiagnosticsToolActivity,
      prompt: input.prompt,
      resultText: input.resultText,
      successfulWorkspaceFileActivity: input.successfulWorkspaceFileActivity,
      task: input.task,
    })
  ) {
    return false;
  }

  const playbookIntentText = [input.prompt, playbookTaskContextText(input.task)]
    .filter(Boolean)
    .join("\n");
  if (
    hasPlaybookDiagnosticsIntent(playbookIntentText) &&
    !hasApprovedPlaybookRepairNextActions({ prompt: input.prompt, task: input.task }) &&
    !input.playbookRunDiagnosticsToolActivity
  ) {
    return false;
  }
  return true;
}

function formatPlaybookUpdateNoChangeError(input: {
  implementationRetryUsed?: boolean;
  validationSummary?: string;
}): string {
  return [
    "The model did not update the existing playbook package after retry.",
    "No package files changed.",
    ...(input.implementationRetryUsed
      ? [
          "Implementation retry was attempted, but PI still did not call workspace_edit or workspace_write successfully.",
        ]
      : []),
    "Clear feature/update requests must be implemented by PI with workspace_edit or workspace_write, followed by playbook_package_validate.",
    "If the target package, requested workflow change, or UI surface is ambiguous, use clarify in the task UI before editing.",
    ...(input.validationSummary ? ["", input.validationSummary] : []),
  ].join("\n");
}

function taskFollowupPromptContext(input: {
  agentTurnId: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
  userTurnId: string;
}): string | undefined {
  const lines = input.task.turns
    .filter(
      (turn) =>
        turn.id !== input.userTurnId &&
        turn.id !== input.agentTurnId &&
        (turn.status === "completed" || turn.status === "failed") &&
        (turn.role === "user" || turn.role === "agent")
    )
    .map((turn) => {
      const text = settledTurnText(turn);
      if (!text) return undefined;
      const status = turn.status === "failed" ? " failed" : "";
      return `- Previous ${turn.role}${status}: ${compactPromptContextText(text, 1200)}`;
    })
    .filter((value): value is string => Boolean(value))
    .slice(-8);

  if (lines.length === 0) return undefined;
  return [
    "Task follow-up context:",
    "Carry this context forward when resolving references like 'the issue', 'that output', 'fix it', or 'do it'. Do not ask the user to restate details already present here.",
    ...lines,
  ].join("\n");
}

function compactPlaybookPromptForName(text: string): string {
  return text
    .replace(/\/(?:skill\s+)?tessera-playbook-(?:builder|debugger)\b/gi, " ")
    .replace(/\bi\s+want\s+to\s+/gi, " ")
    .replace(
      /\b(?:please\s+)?(?:create|build|make|generate|draft)\s+(?:a\s+|an\s+)?(?:tessera\s+)?playbook(?:\s+package)?(?:\s+(?:that|to|for))?\b/gi,
      " "
    )
    .replace(/\bwill\s+/gi, " ")
    .replace(
      /\b(?:the\s+)?summary\s+should\s+be\s+saved(?:\s+(?:in|to|at))?(?:\s+the)?\s+workspace\b/gi,
      " "
    )
    .replace(/\bshould\s+be\s+saved(?:\s+(?:in|to|at))?(?:\s+the)?\s+workspace\b/gi, " ")
    .replace(/\bplaybook\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferPlaybookScaffoldRequest(input: {
  prompt: string;
  task: NonNullable<ReturnType<TaskStore["getTask"]>>;
}): PlaybookPackageScaffoldInput {
  const text = input.prompt.trim() || input.task.title;
  const lower = text.toLowerCase();
  const mentionsEmail = /\b(?:e-?mails?|gmail|inbox)\b/.test(lower);
  const mentionsSummary = /\b(?:summar(?:y|ize|ise|izes|ises|ized|ised|izing|ising)|digest)\b/.test(
    lower
  );
  const mentionsWeek =
    /\bweekly\b/.test(lower) || /\b(?:last|previous|past)\s+(?:calendar\s+)?week\b/.test(lower);
  const semanticSlug =
    mentionsEmail && mentionsSummary && mentionsWeek
      ? "weekly-email-summary"
      : mentionsEmail && mentionsSummary
        ? "email-summary"
        : undefined;
  const slug = semanticSlug ?? slugify(compactPlaybookPromptForName(text), "generated-playbook");
  const name = semanticSlug ? titleFromSlug(semanticSlug) : titleFromSlug(slug);
  return {
    packagePath: `playbooks/${slug}`,
    id: slug,
    name,
    description: `${name} Tessera playbook package.`,
    source:
      lower.includes("email") || lower.includes("gmail")
        ? "emails received during the previous calendar week through Tessera's mail capability"
        : "workspace and connector evidence selected at run time",
    outputPath: `${name}.md`,
  };
}

function playbookRequestWithName(
  base: PlaybookPackageScaffoldInput,
  value: string
): PlaybookPackageScaffoldInput {
  const trimmed = value.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  if (!trimmed) return base;
  const packagePath = trimmed.startsWith("playbooks/")
    ? normalizePackagePath(trimmed)
    : `playbooks/${slugify(trimmed, base.id ?? "generated-playbook")}`;
  const slug = slugify(
    packagePath.split("/").at(-1) ?? packagePath,
    base.id ?? "generated-playbook"
  );
  const name = titleFromSlug(slug);
  return {
    ...base,
    packagePath,
    id: slug,
    name,
    description: `${name} Tessera playbook package.`,
    outputPath: `${name}.md`,
  };
}

function playbookScaffoldUsesMailSource(input: PlaybookPackageScaffoldInput): boolean {
  const text = [input.id, input.name, input.description, input.source, input.packagePath]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /\b(?:e-?mails?|gmail|inbox|mail)\b/.test(text);
}

function scaffoldPlaybookFiles(
  input: Required<PlaybookPackageScaffoldInput>
): Record<string, string> {
  const usesMailSource = playbookScaffoldUsesMailSource(input);
  const manifest = {
    schemaVersion: 1,
    id: input.id,
    version: "0.1.0",
    name: input.name,
    entrypoint: "playbook.ts",
  };
  const graphCapabilities = usesMailSource
    ? `["integration.mail.messages.read", "tool.workspace.write"]`
    : `["tool.workspace.write"]`;
  const requiredCapabilities = usesMailSource ? `["integration.mail.messages.read"]` : "[]";
  const sourceArtifacts = usesMailSource
    ? `    mailSearch: { schema: "schemas/mailSearch.schema.json" },
`
    : "";
  const mailQueryInput = usesMailSource
    ? `    mailQuery: {
      type: "string",
      required: true,
      label: "Mail search query",
      description: "Gmail-compatible query used by Tessera's mail connector.",
      default: "newer_than:14d older_than:7d",
      group: "Source",
      ui: { control: "text" },
    },
`
    : "";
  const readEmailsNode = usesMailSource
    ? `    {
      id: "readEmails",
      label: "Read source emails",
      kind: "tool",
      capability: "integration.mail.messages.read",
      args: {
        command: "mail",
        subcommand: "search",
        args: [{ input: "mailQuery" }, "--limit", "25"],
      },
      outputArtifact: "mailSearch",
      onSuccess: "draft",
    },
`
    : "";
  const draftSourceInputs = usesMailSource
    ? `        mailQuery: { input: "mailQuery" },
        mailSearch: { artifact: "mailSearch" },
`
    : "";
  const sourceInstructions = usesMailSource
    ? "Use the provided mailSearch artifact as the source of truth. Prefer mailSearch.parsed.messages; accept legacy mailSearch.messages if present. If no messages are available, explain that clearly in summaryMarkdown, assumptions, and followUps. Do not invent email senders, subjects, dates, decisions, or action items."
    : "Use only source material available in the graph inputs. Do not invent missing evidence.";

  return {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "playbook.ts": `export default {
  schemaVersion: 1,
  id: ${JSON.stringify(input.id)},
  version: "0.1.0",
  name: ${JSON.stringify(input.name)},
  description: ${JSON.stringify(input.description)},
  metadata: {
    category: "operations",
    businessUseCase: ${JSON.stringify(input.description)},
    requiredCapabilities: ${requiredCapabilities},
    optionalCapabilities: [],
    outputs: [{ kind: "workspaceDocument", label: ${JSON.stringify(input.name)} }],
    phases: ${usesMailSource ? `["Collect", "Draft", "Review", "Write"]` : `["Draft", "Review", "Write"]`},
  },
  inputs: {
    workspaceRoot: {
      type: "string",
      required: true,
      label: "Workspace",
      group: "System",
      ui: { control: "text" },
    },
    outputPath: {
      type: "string",
      required: true,
      label: "Output path",
      default: ${JSON.stringify(input.outputPath)},
      ui: { control: "text" },
    },
${mailQueryInput}\
  },
  artifacts: {
${sourceArtifacts}\
    finalArtifact: { schema: "schemas/finalArtifact.schema.json" },
  },
  capabilities: ${graphCapabilities},
  limits: {},
  start: ${JSON.stringify(usesMailSource ? "readEmails" : "draft")},
  nodes: [
${readEmailsNode}\
    {
      id: "draft",
      label: "Draft ${input.name}",
      kind: "agent",
      prompt: "prompts/draft.md",
      inputs: {
        workspaceRoot: { input: "workspaceRoot" },
        outputPath: { input: "outputPath" },
${draftSourceInputs}\
      },
      tools: [],
      output: {
        artifact: "finalArtifact",
        schema: "schemas/finalArtifact.schema.json",
      },
      onSuccess: "review",
    },
    {
      id: "review",
      label: "Review ${input.name}",
      kind: "humanReview",
      artifact: "finalArtifact",
      actions: ["approve", "request_changes", "deny"],
      onApprove: "write",
      onRequestChanges: "draft",
    },
    {
      id: "write",
      label: "Write ${input.name}",
      kind: "effect",
      effectId: "workspace.write",
      capability: "tool.workspace.write",
      adapterId: "workspace",
      sideEffect: "write",
      approval: "required",
      idempotency: "required",
      idempotencyKey: "workspace.write:${input.id}:{{inputs.outputPath}}",
      input: {
        sourceArtifact: "finalArtifact",
        value: { artifact: "finalArtifact" },
        target: {
          kind: "workspace",
          path: "{{inputs.outputPath}}",
          format: "markdown",
        },
      },
      preview: {
        schemaVersion: 1,
        title: "Write ${input.name}",
        summary: "Write the approved output to the selected workspace.",
      },
      onSuccess: "completed",
    },
  ],
};
`,
    "schemas/finalArtifact.schema.json": `${JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["title", "summaryMarkdown"],
        properties: {
          title: { type: "string" },
          summaryMarkdown: { type: "string" },
          assumptions: { type: "array", items: { type: "string" } },
          followUps: { type: "array", items: { type: "string" } },
        },
      },
      null,
      2
    )}\n`,
    ...(usesMailSource
      ? {
          "schemas/mailSearch.schema.json": mailSearchSchema(),
        }
      : {}),
    "prompts/draft.md": `Create ${input.name} from ${input.source}.

Return only JSON that matches schemas/finalArtifact.schema.json.
${sourceInstructions}
Use clear assumptions when source material is unavailable.
Do not include tool logs, markdown fences, or implementation notes.
`,
    "scripts/normalize.ts": `export function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
`,
    "fixtures/sample.json": `${JSON.stringify(
      {
        title: input.name,
        summaryMarkdown: `# ${input.name}\n\nNo sample source data provided yet.`,
        assumptions: ["Fixture data is intentionally credential-free."],
        followUps: [],
      },
      null,
      2
    )}\n`,
    "tests/package.test.ts": `import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("package", () => {
  test("manifest and playbook versions match", () => {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    const playbook = readFileSync("playbook.ts", "utf8");
    expect(playbook).toContain(\`id: "\${manifest.id}"\`);
    expect(playbook).toContain(\`version: "\${manifest.version}"\`);
  });

  test("schema is valid JSON", () => {
    expect(() =>
      JSON.parse(readFileSync("schemas/finalArtifact.schema.json", "utf8"))
    ).not.toThrow();
  });
});
`,
    "build.ts": `import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2] ?? "help";
const packageRoot = dirname(fileURLToPath(import.meta.url));

function run(label: string, args: string[], cwd = packageRoot): void {
  console.log(\`\\n> \${label}\\n$ \${args.join(" ")}\`);
  const result = Bun.spawnSync(args, {
    cwd,
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function validate(): void {
  if (existsSync(resolve(packageRoot, "tests"))) {
    run("Package tests", ["bun", "test", "tests"]);
  } else {
    console.log("No tests directory found; skipping package-local tests.");
  }

  const tesseraRoot = process.env.TESSERA_REPO_ROOT ?? process.env.TESSERA_ROOT;
  if (!tesseraRoot) {
    console.log(
      "Tessera repo not configured for build.ts; run Tessera validation separately or set TESSERA_REPO_ROOT."
    );
    return;
  }

  const cliRoot = resolve(tesseraRoot, "apps/cli");
  run("Tessera validation", ["bun", "run", "src/index.ts", "playbook", "validate", packageRoot], cliRoot);
  run("Tessera JSON validation", ["bun", "run", "src/index.ts", "playbook", "validate", packageRoot, "--json"], cliRoot);
}

if (command === "validate") {
  validate();
} else if (command === "package") {
  console.log("Create an import archive from tracked package files.");
} else {
  console.log("Usage: bun run build.ts <validate|package>");
}
`,
    "BUILD.md": `# Build

This package is authored for Tessera import. Development helpers are intentionally local-only.

- Run \`bun run build.ts validate\` to execute package-local tests.
- Set \`TESSERA_REPO_ROOT\` or \`TESSERA_ROOT\` before running \`bun run build.ts validate\` to also invoke repo-local Tessera validation.
- Run \`tessera playbook validate .\` and \`tessera playbook validate . --json\` when the installed CLI is available.
- Do not add dependency fields, lockfiles, bin entries, or standalone graph runners.
`,
    "PLAYBOOK.md": `# ${input.name}

${input.description}

## Source

${input.source}

## Output

The approved final artifact is written to \`${input.outputPath}\` in the selected workspace.

## Production Readiness

- Runtime: Tessera only. Do not add standalone graph runners, dependency fields, lockfiles, or local execution wrappers.
- Required capabilities: ${usesMailSource ? "`integration.mail.messages.read`, `tool.workspace.write`" : "`tool.workspace.write`"}.
- Live sources and durable writes are graph nodes with declared artifacts, schemas, previews, approval, and idempotency.
- Package-local tests cover schemas and deterministic helpers; live connector checks happen through Tessera.

## Updating This Playbook

Preserve \`manifest.json\` id \`${input.id}\` and the package path unless intentionally creating a new playbook.

When changing the workflow:

1. Update \`playbook.ts\` graph nodes, capabilities, artifacts, review branches, and effect targets together.
2. Add or remove source connectors with executable \`tool\` nodes, schema-backed raw-source artifacts, and empty/error source-gap handling.
3. Change prompts in \`prompts/\` and schemas in \`schemas/\` in lockstep; every agent output should keep an explicit schema.
4. Keep deterministic parsing, normalization, scoring, and formatting in \`scripts/\` with fixture coverage in \`fixtures/\` and \`tests/\`.
5. Bump the package version for behavior or schema changes.
6. Run \`playbook_package_validate\` in Tessera task mode, or \`bun run build.ts validate\` plus \`tessera playbook validate .\` when working outside task mode.
7. Re-import the package into Tessera after validation so users run the updated graph.
`,
  };
}

async function scaffoldPlaybookPackage(input: {
  request: PlaybookPackageScaffoldInput;
  workspaceRoot: string;
}): Promise<PlaybookPackageScaffoldResult> {
  const packagePath = normalizePackagePath(input.request.packagePath);
  const slug = slugify(packagePath.split("/").at(-1) ?? packagePath, "generated-playbook");
  const normalized: Required<PlaybookPackageScaffoldInput> = {
    packagePath,
    id: input.request.id?.trim() || slug,
    name: input.request.name?.trim() || titleFromSlug(slug),
    description:
      input.request.description?.trim() ||
      `${input.request.name?.trim() || titleFromSlug(slug)} Tessera playbook package.`,
    source: input.request.source?.trim() || "workspace and connector evidence selected at run time",
    outputPath:
      input.request.outputPath?.trim() || `${input.request.name?.trim() || titleFromSlug(slug)}.md`,
  };
  const guard = await createWorkspaceGuard(input.workspaceRoot);
  const files = scaffoldPlaybookFiles(normalized);
  const written: string[] = [];

  for (const [file, content] of Object.entries(files)) {
    const workspacePath = `${packagePath}/${file}`;
    const absolute = await guard.resolveInsideWorkspaceForCreate(workspacePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    written.push(workspacePath);
  }

  return { packagePath, files: written };
}

function formatPlaybookScaffoldSummary(result: PlaybookPackageScaffoldResult): string {
  return [
    `Created a Tessera playbook package at ${result.packagePath}.`,
    "",
    "Files written:",
    ...result.files.map((file) => `- ${file}`),
  ].join("\n");
}

const VALIDATION_OUTPUT_LIMIT = 6000;

function capValidationOutput(value: string): string {
  return value.length > VALIDATION_OUTPUT_LIMIT
    ? `${value.slice(0, VALIDATION_OUTPUT_LIMIT)}\n[output truncated]`
    : value;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

async function runValidationProcess(input: {
  cwd: string;
  command: string[];
  name: string;
}): Promise<PlaybookPackageValidationStep> {
  const proc = Bun.spawn(input.command, {
    cwd: input.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    name: input.name,
    command: input.command.join(" "),
    ok: exitCode === 0,
    exitCode,
    stdout: capValidationOutput(stdout),
    stderr: capValidationOutput(stderr),
  };
}

async function validatePlaybookPackage(input: {
  cli?: WorkspaceCliExecutor;
  request: PlaybookPackageValidateInput;
  workspaceRoot: string;
}): Promise<PlaybookPackageValidateResult> {
  const guard = await createWorkspaceGuard(input.workspaceRoot);
  const absolutePackagePath = await guard.resolveInsideWorkspace(input.request.packagePath);
  const packagePath = relative(guard.root, absolutePackagePath) || ".";
  const runPackageTests = input.request.runPackageTests ?? true;
  const runTesseraValidation = input.request.runTesseraValidation ?? true;
  const steps: PlaybookPackageValidationStep[] = [];

  if (runPackageTests) {
    if (await exists(join(absolutePackagePath, "build.ts"))) {
      steps.push(
        await runValidationProcess({
          cwd: absolutePackagePath,
          command: ["bun", "run", "build.ts", "validate"],
          name: "Package build validation",
        })
      );
    } else if (await exists(join(absolutePackagePath, "tests"))) {
      steps.push(
        await runValidationProcess({
          cwd: absolutePackagePath,
          command: ["bun", "test", "tests"],
          name: "Package tests",
        })
      );
    } else {
      steps.push({
        name: "Package tests",
        command: "bun test tests",
        ok: true,
        skipped: true,
        stdout: "Skipped: package has no tests directory or build.ts validate command.",
        stderr: "",
      });
    }
  }

  if (runTesseraValidation) {
    if (input.cli) {
      const textResult = await input.cli.runWorkspaceCli(
        ["playbook", "validate", absolutePackagePath],
        120_000
      );
      steps.push({
        name: "Tessera validation",
        command: `tessera playbook validate ${packagePath}`,
        ok: textResult.exitCode === 0,
        exitCode: textResult.exitCode,
        stdout: capValidationOutput(textResult.stdout),
        stderr: capValidationOutput(textResult.stderr),
      });

      const jsonResult = await input.cli.runWorkspaceCli(
        ["playbook", "validate", absolutePackagePath, "--json"],
        120_000
      );
      steps.push({
        name: "Tessera JSON validation",
        command: `tessera playbook validate ${packagePath} --json`,
        ok: jsonResult.exitCode === 0,
        exitCode: jsonResult.exitCode,
        stdout: capValidationOutput(jsonResult.stdout),
        stderr: capValidationOutput(jsonResult.stderr),
      });
    } else {
      steps.push({
        name: "Tessera validation",
        command: `tessera playbook validate ${packagePath}`,
        ok: true,
        skipped: true,
        stdout: "Skipped: Tessera CLI is not available in this task runner.",
        stderr: "",
      });
    }
  }

  return {
    packagePath,
    ok: steps.every((step) => step.ok),
    steps,
  };
}

function formatPlaybookValidationSummary(result: PlaybookPackageValidateResult): string {
  return [
    `Validation ${result.ok ? "passed" : "failed"} for ${result.packagePath}.`,
    "",
    "Validation steps:",
    ...result.steps.map((step) => {
      const suffix = step.skipped ? "skipped" : `exit ${step.exitCode ?? (step.ok ? 0 : 1)}`;
      return `- ${step.name}: ${step.ok ? "ok" : "failed"} (${suffix})`;
    }),
  ].join("\n");
}

function mailSearchSchema(): string {
  const messageSchema = {
    type: "object",
    additionalProperties: true,
    required: ["id", "subject"],
    properties: {
      id: { type: "string" },
      threadId: { type: "string" },
      subject: { type: "string" },
      from: { type: "string" },
      date: { type: "string" },
      snippet: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
    },
  };
  const messagesSchema = {
    type: "array",
    items: messageSchema,
  };
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: true,
      anyOf: [{ required: ["parsed"] }, { required: ["messages"] }],
      properties: {
        parsed: {
          type: "object",
          additionalProperties: true,
          required: ["messages"],
          properties: {
            messages: messagesSchema,
          },
        },
        messages: messagesSchema,
        command: { type: "string" },
        subcommand: { type: "string" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "number" },
        durationMs: { type: "number" },
      },
    },
    null,
    2
  )}\n`;
}

function formatPlaybookDiagnosticsSummary(result: PlaybookRunDiagnosticsResult): string {
  const requestedTarget =
    result.request.runId ?? result.request.packagePath ?? result.request.playbookId;
  if (!result.ok) {
    const recent =
      result.recentRuns.length > 0
        ? [
            "",
            "Recent runs:",
            ...result.recentRuns
              .slice(0, 5)
              .map((run) => `- ${run.playbookId} ${run.runId}: ${run.status}`),
          ]
        : [];
    return [
      "Playbook diagnostics did not find a matching run.",
      ...(requestedTarget ? [`Requested target: ${requestedTarget}`] : []),
      ...result.issues.map((issue) => `- ${issue.message}`),
      ...recent,
      "",
      "Next actions:",
      ...result.nextActions.map((action) => `- ${action}`),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const issueLines =
    result.issues.length > 0
      ? result.issues.map((issue) => {
          const evidence =
            issue.evidence && issue.evidence.length > 0
              ? ` Evidence: ${issue.evidence.join("; ")}.`
              : "";
          const fix = issue.suggestedFix ? ` Suggested fix: ${issue.suggestedFix}` : "";
          return `- [${issue.severity}] ${issue.code}: ${issue.message}${evidence}${fix}`;
        })
      : ["- No obvious run-store issue was detected."];
  const outputs = result.workspaceOutputSummary.records
    .slice(0, 5)
    .map((output) =>
      [
        `- ${output.nodePath}`,
        output.path ? `path=${output.path}` : undefined,
        typeof output.bytes === "number" ? `bytes=${output.bytes}` : undefined,
        typeof output.artifactChars === "number"
          ? `artifactChars=${output.artifactChars}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" | ")
    );

  return [
    result.selectedRun
      ? `Diagnostics for ${result.selectedRun.playbookId} run ${result.selectedRun.runId}: ${result.selectedRun.status}.`
      : "Diagnostics completed.",
    ...(requestedTarget ? [`Requested target: ${requestedTarget}`] : []),
    "",
    "Issues:",
    ...issueLines,
    ...(outputs.length > 0 ? ["", "Workspace outputs:", ...outputs] : []),
    "",
    "Next actions:",
    ...result.nextActions.map((action) => `- ${action}`),
  ].join("\n");
}

function formatPlaybookRepairTargetNeededSummary(packagePaths: string[]): string {
  if (packagePaths.length > 1) {
    return [
      "I found multiple existing playbook package candidates in this task history.",
      `Candidates: ${packagePaths.join(", ")}`,
      "Reply with the package path to repair so Tessera can inspect the existing package instead of creating a new one.",
    ].join("\n");
  }
  return [
    "I could not identify which existing playbook package to repair from this task history.",
    "Reply with the package path, for example playbooks/weekly-email-summary, and Tessera will inspect that package instead of creating a new one.",
  ].join("\n");
}

interface PlaybookVersionLiteral {
  end: number;
  start: number;
  version: string;
}

interface PreparedPlaybookImport {
  absolutePackagePath: string;
  packagePath: string;
  versionBumpedFrom?: string;
}

const STRICT_THREE_PART_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_AUTO_VERSION_BUMPS = 50;

function parsedThreePartVersion(version: string): [number, number, number] {
  const match = STRICT_THREE_PART_VERSION_RE.exec(version);
  if (!match) {
    throw new Error(
      `Playbook package version must use major.minor.patch format before auto-import: ${version}`
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function bumpPatchVersion(version: string): string {
  const [major, minor, patch] = parsedThreePartVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function exportedPlaybookObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    let expression = unwrapExpression(statement.expression);
    if (ts.isCallExpression(expression) && expression.arguments.length > 0) {
      const firstArgument = expression.arguments[0];
      if (firstArgument) {
        expression = unwrapExpression(firstArgument);
      }
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression;
    }
  }
  return undefined;
}

function findPlaybookVersionLiteral(source: string, entrypoint: string): PlaybookVersionLiteral {
  const sourceFile = ts.createSourceFile(entrypoint, source, ts.ScriptTarget.Latest, true);
  const exported = exportedPlaybookObject(sourceFile);
  if (!exported) {
    throw new Error("Playbook entrypoint must default-export a playbook object for auto-import.");
  }

  const matches = exported.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyNameText(property.name) === "version"
  );
  if (matches.length !== 1) {
    throw new Error("Playbook entrypoint must contain exactly one top-level version property.");
  }

  const versionProperty = matches[0];
  if (!versionProperty) {
    throw new Error("Playbook entrypoint must contain a top-level version property.");
  }
  const initializer = unwrapExpression(versionProperty.initializer);
  if (!ts.isStringLiteral(initializer) && !ts.isNoSubstitutionTemplateLiteral(initializer)) {
    throw new Error("Playbook entrypoint version must be a string literal for auto-import.");
  }

  return {
    end: initializer.getEnd(),
    start: initializer.getStart(sourceFile),
    version: initializer.text,
  };
}

async function writePlaybookPackageVersion(
  packageFiles: PlaybookGraphPackageFiles,
  nextVersion: string
): Promise<void> {
  const entrypoint = assertPackageRelativePath(packageFiles.manifest.entrypoint);
  const entrypointPath = join(packageFiles.root, entrypoint);
  const entrypointSource = await readFile(entrypointPath, "utf8");
  const literal = findPlaybookVersionLiteral(entrypointSource, entrypoint);

  if (packageFiles.manifest.version !== literal.version) {
    throw new Error(
      `Manifest version ${packageFiles.manifest.version} does not match playbook entrypoint version ${literal.version}.`
    );
  }

  const nextManifest = {
    ...packageFiles.manifest,
    version: nextVersion,
  };
  await writeFile(packageFiles.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  await writeFile(
    entrypointPath,
    `${entrypointSource.slice(0, literal.start)}${JSON.stringify(nextVersion)}${entrypointSource.slice(literal.end)}`,
    "utf8"
  );
}

async function readAutoImportPackageState(input: {
  absolutePackagePath: string;
  runtime: PlaybookAutoImportRuntime;
}): Promise<{
  packageFiles: PlaybookGraphPackageFiles;
  sameVersionSourceConflict: boolean;
}> {
  const packageFiles = await readPlaybookGraphPackage(input.absolutePackagePath);
  parsedThreePartVersion(packageFiles.manifest.version);

  const entrypoint = assertPackageRelativePath(packageFiles.manifest.entrypoint);
  const entrypointSource = await readFile(join(packageFiles.root, entrypoint), "utf8");
  const literal = findPlaybookVersionLiteral(entrypointSource, entrypoint);
  if (packageFiles.manifest.version !== literal.version) {
    throw new Error(
      `Manifest version ${packageFiles.manifest.version} does not match playbook entrypoint version ${literal.version}.`
    );
  }

  const sourceHash = hashPlaybookSourceFiles(packageFiles.sourceFiles);
  const installed = await loadInstalledGraphPlaybookRegistry({
    installRoot: input.runtime.installRoot,
    cacheRoot: input.runtime.cacheRoot,
  });
  const sameVersion = installed.filter(
    (entry) =>
      entry.id === packageFiles.manifest.id &&
      entry.packageVersion === packageFiles.manifest.version
  );
  const sameVersionSourceConflict =
    sameVersion.length > 0 && !sameVersion.some((entry) => entry.sourceHash === sourceHash);

  return {
    packageFiles,
    sameVersionSourceConflict,
  };
}

async function preparePlaybookPackageForAutoImport(input: {
  packagePath: string;
  runtime: PlaybookAutoImportRuntime;
  workspaceRoot: string;
}): Promise<PreparedPlaybookImport> {
  const guard = await createWorkspaceGuard(input.workspaceRoot);
  const absolutePackagePath = await guard.resolveInsideWorkspace(input.packagePath);
  const packagePath = relative(guard.root, absolutePackagePath) || ".";
  let versionBumpedFrom: string | undefined;

  for (let attempt = 0; attempt < MAX_AUTO_VERSION_BUMPS; attempt += 1) {
    const { packageFiles, sameVersionSourceConflict } = await readAutoImportPackageState({
      absolutePackagePath,
      runtime: input.runtime,
    });
    if (!sameVersionSourceConflict) {
      return {
        absolutePackagePath,
        packagePath,
        ...(versionBumpedFrom ? { versionBumpedFrom } : {}),
      };
    }

    const nextVersion = bumpPatchVersion(packageFiles.manifest.version);
    versionBumpedFrom ??= packageFiles.manifest.version;
    await writePlaybookPackageVersion(packageFiles, nextVersion);
  }

  throw new Error(
    `Could not find an available patch version for ${packagePath} after ${MAX_AUTO_VERSION_BUMPS} attempts.`
  );
}

function formatPlaybookImportSummary(input: {
  packagePath: string;
  result: GraphPlaybookImportResult;
  versionBumpedFrom?: string;
}): string {
  const bumpCopy = input.versionBumpedFrom
    ? ` Version bumped from ${input.versionBumpedFrom} to ${input.result.version}.`
    : "";
  const warnings =
    input.result.warnings.length > 0 ? ` Warnings: ${input.result.warnings.join(" ")}` : "";
  return `Imported ${input.result.name} ${input.result.version} from ${input.packagePath}: ${input.result.status}.${bumpCopy}${warnings}`.trim();
}

export async function runTaskTurn(opts: RunTaskTurnOptions): Promise<void> {
  const { store, taskId, userTurnId, agentTurnId, publish } = opts;
  const delayMs = opts.delayMs ?? 120;
  const provider = opts.execution?.provider ?? opts.provider ?? DEFAULT_PROVIDER;
  const credential = opts.execution?.credential ?? opts.credential;
  const piRunner = opts.piRunner ?? runPiTaskTurn;
  const shell = opts.cli ? createSpawnShellExecutor(opts.cli) : undefined;
  let taskRuntimeActivity = false;
  let successfulToolActivity = false;
  let successfulWorkspaceFileActivity = false;
  let clarifyToolActivity = false;
  let playbookRunDiagnosticsToolActivity = false;
  let playbookValidationToolActivity = false;
  const playbookPackagePathsNeedingValidation = new Set<string>();
  const playbookValidatedPackagePaths = new Set<string>();
  const playbookScaffoldSummaries: string[] = [];
  const playbookValidationSummaries: string[] = [];
  const playbookRepairSummaries: string[] = [];
  const playbookImportSummaries: string[] = [];
  const latestToolArgsByName = new Map<string, unknown>();

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

    store.updateTask(taskId, { status: "active", latestActivity: "Starting" });
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

    store.updateTask(taskId, { status: "active", latestActivity: "Running" });
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
    const workspacePlaybookPackagePaths = await playbookPackagePathCandidatesFromWorkspace({
      prompt,
      task,
    });
    const followupPromptContext = taskFollowupPromptContext({
      agentTurnId,
      task,
      userTurnId,
    });
    const repairPromptContext = playbookBuilderRepairPromptContext({
      packagePaths: workspacePlaybookPackagePaths,
      prompt,
      task,
    });
    const playbookUpdateContext = await playbookBuilderUpdateContextPack({
      packagePaths: workspacePlaybookPackagePaths,
      prompt,
      task,
      workspaceRoot: task.workspaceRoot,
    });
    const modelPrompt = [prompt, followupPromptContext, repairPromptContext]
      .filter(Boolean)
      .join("\n\n");
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

    const playbookRunDiagnostics = opts.playbookRunDiagnostics;
    const runModelTurn = (
      runPrompt: string,
      runOptions: { runtime?: AgentRuntimeContext } = {}
    ) => {
      const runtime = runOptions.runtime ?? opts.execution?.runtime;
      return piRunner({
        ...(opts.execution?.agent !== undefined ? { agent: opts.execution.agent } : {}),
        ...(conversationHistory.length > 0 ? { conversationHistory } : {}),
        ...(credential ? { credential } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
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
          latestToolArgsByName.set(tool.name, tool.args);
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
          const toolArgs = latestToolArgsByName.get(tool.name);
          latestToolArgsByName.delete(tool.name);
          if (tool.name === "clarify") {
            clarifyToolActivity = true;
          }
          if (tool.name === "playbook_run_diagnostics") {
            playbookRunDiagnosticsToolActivity = true;
          }
          if (isPlaybookValidationTool(tool.name)) {
            playbookValidationToolActivity = true;
          }
          if (!toolResultFailed(tool.result)) {
            successfulToolActivity = true;
            if (isWorkspaceFileWriteTool(tool.name)) {
              successfulWorkspaceFileActivity = true;
            }
            const packagePath = playbookPackagePathFromToolActivity({
              args: toolArgs,
              result: tool.result,
              toolName: tool.name,
            });
            if (packagePath && isWorkspaceFileWriteTool(tool.name)) {
              const normalizedPackagePath = normalizePackagePath(packagePath);
              playbookPackagePathsNeedingValidation.add(normalizedPackagePath);
              playbookValidatedPackagePaths.delete(normalizedPackagePath);
            }
            const scaffold = playbookScaffoldResultFromToolResult(tool.result);
            if (scaffold) {
              playbookScaffoldSummaries.push(formatPlaybookScaffoldSummary(scaffold));
            }
            const validation = playbookValidationResultFromToolResult(tool.result);
            if (validation && isPlaybookValidationTool(tool.name)) {
              playbookValidationSummaries.push(formatPlaybookValidationSummary(validation));
              if (validation.ok) {
                playbookValidatedPackagePaths.add(normalizePackagePath(validation.packagePath));
              }
            }
          }
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
        prompt: runPrompt,
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
            taskRuntimeActivity = true;
            const task = store.updateTodo(taskId, operation);
            publish({
              type: "task.todo_updated",
              taskId,
              emittedAt: new Date().toISOString(),
              todo: task?.todo,
            });
            return task?.todo;
          },
          async requestClarify(request) {
            return waitForClarifyResponse({
              clarify: normalizeClarifyRequest(taskId, request),
              publish,
              store,
              taskId,
            });
          },
          async scaffoldPlaybookPackage(request) {
            taskRuntimeActivity = true;
            return scaffoldPlaybookPackage({
              request,
              workspaceRoot: task.workspaceRoot,
            });
          },
          async validatePlaybookPackage(request) {
            taskRuntimeActivity = true;
            return validatePlaybookPackage({
              ...(opts.cli ? { cli: opts.cli } : {}),
              request,
              workspaceRoot: task.workspaceRoot,
            });
          },
          ...(playbookRunDiagnostics
            ? {
                async diagnosePlaybookRun(request) {
                  taskRuntimeActivity = true;
                  playbookRunDiagnosticsToolActivity = true;
                  return diagnosePlaybookRun({
                    request,
                    store: playbookRunDiagnostics.store,
                    ...(playbookRunDiagnostics.ownerUserKey
                      ? { ownerUserKey: playbookRunDiagnostics.ownerUserKey }
                      : {}),
                    workspaceRoot: task.workspaceRoot,
                  });
                },
              }
            : {}),
        },
        workspaceRoot: task.workspaceRoot,
      });
    };
    let result = await runModelTurn(modelPrompt);
    let latestTask = store.getTask(taskId) ?? task;
    let playbookRepairRetryUsed = false;
    let playbookUpdateImplementationRetryUsed = false;
    let playbookScaffoldRetryUsed = false;
    if (
      !result.text.trim() &&
      result.boundaryViolations === 0 &&
      shouldUsePlaybookUpdateFlow({
        packagePaths: workspacePlaybookPackagePaths,
        prompt,
        task: latestTask,
      }) &&
      !taskRuntimeActivity &&
      !successfulToolActivity
    ) {
      result = await runModelTurn(
        `${modelPrompt}\n\n${playbookBuilderRepairRetryPrompt({
          packagePaths: workspacePlaybookPackagePaths,
          prompt,
          task: latestTask,
          ...(playbookUpdateContext ? { updateContext: playbookUpdateContext } : {}),
        })}`
      );
      playbookRepairRetryUsed = true;
      latestTask = store.getTask(taskId) ?? latestTask;
    }
    if (
      !playbookRepairRetryUsed &&
      shouldRetryPlaybookApprovedRepairFollowup({
        boundaryViolations: result.boundaryViolations,
        playbookRunDiagnosticsToolActivity,
        playbookValidationToolActivity,
        prompt,
        resultText: result.text,
        successfulToolActivity,
        successfulWorkspaceFileActivity,
        task: latestTask,
      })
    ) {
      result = await runModelTurn(
        `${modelPrompt}\n\n${playbookDiagnosticsOnlyRetryPrompt({
          packagePaths: workspacePlaybookPackagePaths,
          task: latestTask,
          ...(playbookUpdateContext ? { updateContext: playbookUpdateContext } : {}),
        })}`
      );
      playbookRepairRetryUsed = true;
      latestTask = store.getTask(taskId) ?? latestTask;
    }
    if (
      shouldRetryPlaybookUpdateImplementation({
        boundaryViolations: result.boundaryViolations,
        clarifyToolActivity,
        packagePaths: workspacePlaybookPackagePaths,
        playbookRunDiagnosticsToolActivity,
        playbookUpdateImplementationRetryUsed,
        prompt,
        resultText: result.text,
        successfulWorkspaceFileActivity,
        task: latestTask,
      })
    ) {
      const retryRuntime = playbookImplementationRetryRuntime(opts.execution?.runtime);
      result = await runModelTurn(
        `${modelPrompt}\n\n${playbookBuilderImplementationRetryPrompt({
          packagePaths: workspacePlaybookPackagePaths,
          prompt,
          task: latestTask,
          ...(playbookUpdateContext ? { updateContext: playbookUpdateContext } : {}),
        })}`,
        retryRuntime ? { runtime: retryRuntime } : {}
      );
      playbookUpdateImplementationRetryUsed = true;
      latestTask = store.getTask(taskId) ?? latestTask;
    }
    if (
      result.boundaryViolations === 0 &&
      hasActivePlaybookSkill(latestTask) &&
      shouldUsePlaybookScaffoldFallback(prompt) &&
      !successfulWorkspaceFileActivity &&
      !playbookValidationToolActivity &&
      !playbookScaffoldRetryUsed
    ) {
      playbookScaffoldRetryUsed = true;
      result = await runModelTurn(
        `${modelPrompt}\n\n${playbookBuilderScaffoldRetryPrompt({ prompt, task: latestTask })}`
      );
      latestTask = store.getTask(taskId) ?? latestTask;
    }
    if (
      result.boundaryViolations === 0 &&
      shouldValidatePlaybookPackageWrites({
        packagePaths: workspacePlaybookPackagePaths,
        prompt,
        task: latestTask,
      }) &&
      successfulWorkspaceFileActivity
    ) {
      if (playbookPackagePathsNeedingValidation.size === 0) {
        throw new Error(
          "The playbook builder wrote workspace files, but no playbook package path could be identified. Write playbook files under playbooks/<package-name>/ and run playbook_package_validate before completing the task."
        );
      }
      for (const packagePath of playbookPackagePathsNeedingValidation) {
        if (playbookValidatedPackagePaths.has(packagePath)) continue;
        const validation = await validatePlaybookPackage({
          ...(opts.cli ? { cli: opts.cli } : {}),
          request: { packagePath },
          workspaceRoot: task.workspaceRoot,
        });
        playbookValidationSummaries.push(formatPlaybookValidationSummary(validation));
        if (!validation.ok) {
          throw new Error(formatPlaybookValidationSummary(validation));
        }
        playbookValidatedPackagePaths.add(packagePath);
      }
      if (opts.playbookImport) {
        for (const packagePath of playbookPackagePathsNeedingValidation) {
          const prepared = await preparePlaybookPackageForAutoImport({
            packagePath,
            runtime: opts.playbookImport,
            workspaceRoot: task.workspaceRoot,
          });
          if (prepared.versionBumpedFrom) {
            const validation = await validatePlaybookPackage({
              ...(opts.cli ? { cli: opts.cli } : {}),
              request: { packagePath: prepared.packagePath },
              workspaceRoot: task.workspaceRoot,
            });
            playbookValidationSummaries.push(formatPlaybookValidationSummary(validation));
            if (!validation.ok) {
              throw new Error(formatPlaybookValidationSummary(validation));
            }
          }
          const imported = await opts.playbookImport.importPackage({
            sourceRoot: prepared.absolutePackagePath,
          });
          playbookImportSummaries.push(
            formatPlaybookImportSummary({
              packagePath: prepared.packagePath,
              result: imported,
              ...(prepared.versionBumpedFrom
                ? { versionBumpedFrom: prepared.versionBumpedFrom }
                : {}),
            })
          );
          publish({
            type: "task.playbook_imported",
            taskId,
            emittedAt: new Date().toISOString(),
            playbookId: imported.id,
            import: imported,
            packagePath: prepared.packagePath,
            ...(prepared.versionBumpedFrom
              ? { versionBumpedFrom: prepared.versionBumpedFrom }
              : {}),
          });
        }
      }
    }
    if (
      result.boundaryViolations === 0 &&
      shouldUsePlaybookUpdateFlow({
        packagePaths: workspacePlaybookPackagePaths,
        prompt,
        task: latestTask,
      }) &&
      ((!result.text.trim() && !taskRuntimeActivity && !successfulToolActivity) ||
        shouldRequireApprovedPlaybookRepairAction({
          boundaryViolations: result.boundaryViolations,
          playbookRunDiagnosticsToolActivity,
          playbookValidationToolActivity,
          prompt,
          resultText: result.text,
          successfulToolActivity,
          successfulWorkspaceFileActivity,
          task: latestTask,
        }))
    ) {
      taskRuntimeActivity = true;
      const packagePaths = playbookPackagePathCandidatesForTask({
        packagePaths: workspacePlaybookPackagePaths,
        task: latestTask,
      });
      if (packagePaths.length === 1) {
        const packagePath = packagePaths[0];
        if (packagePath) {
          const playbookIntentText = [prompt, playbookTaskContextText(latestTask)]
            .filter(Boolean)
            .join("\n");
          const shouldRepairApprovedNextActions = hasApprovedPlaybookRepairNextActions({
            prompt,
            task: latestTask,
          });
          const shouldRunDiagnostics =
            !shouldRepairApprovedNextActions && hasPlaybookDiagnosticsIntent(playbookIntentText);
          let handledPlaybookUpdateFallback = false;
          if (shouldRunDiagnostics && playbookRunDiagnostics) {
            const diagnostics = await diagnosePlaybookRun({
              request: { includeArtifactPreviews: true, packagePath },
              store: playbookRunDiagnostics.store,
              ...(playbookRunDiagnostics.ownerUserKey
                ? { ownerUserKey: playbookRunDiagnostics.ownerUserKey }
                : {}),
              workspaceRoot: task.workspaceRoot,
            });
            successfulToolActivity = true;
            playbookRunDiagnosticsToolActivity = true;
            playbookRepairSummaries.push(formatPlaybookDiagnosticsSummary(diagnostics));
            handledPlaybookUpdateFallback = true;
          }
          if (!handledPlaybookUpdateFallback) {
            const validation = await validatePlaybookPackage({
              ...(opts.cli ? { cli: opts.cli } : {}),
              request: { packagePath },
              workspaceRoot: task.workspaceRoot,
            });
            playbookValidationToolActivity = true;
            playbookValidationSummaries.push(formatPlaybookValidationSummary(validation));
            if (!validation.ok) {
              throw new Error(formatPlaybookValidationSummary(validation));
            }
            successfulToolActivity = true;
            playbookValidatedPackagePaths.add(normalizePackagePath(validation.packagePath));
            playbookValidationSummaries.push(
              formatPlaybookUpdateNoChangeError({
                implementationRetryUsed: playbookUpdateImplementationRetryUsed,
                validationSummary: formatPlaybookValidationSummary(validation),
              })
            );
          }
        }
      } else {
        throw new Error(formatPlaybookRepairTargetNeededSummary(packagePaths));
      }
    }
    if (
      shouldRequirePlaybookUpdateAction({
        boundaryViolations: result.boundaryViolations,
        clarifyToolActivity,
        packagePaths: workspacePlaybookPackagePaths,
        playbookRunDiagnosticsToolActivity,
        prompt,
        resultText: result.text,
        successfulWorkspaceFileActivity,
        task: latestTask,
      })
    ) {
      const packagePaths = playbookPackagePathCandidatesForTask({
        packagePaths: workspacePlaybookPackagePaths,
        task: latestTask,
      });
      if (packagePaths.length !== 1) {
        throw new Error(formatPlaybookRepairTargetNeededSummary(packagePaths));
      }
      const packagePath = packagePaths[0];
      if (!packagePath) {
        throw new Error(formatPlaybookRepairTargetNeededSummary(packagePaths));
      }
      const validation = await validatePlaybookPackage({
        ...(opts.cli ? { cli: opts.cli } : {}),
        request: { packagePath },
        workspaceRoot: task.workspaceRoot,
      });
      playbookValidationToolActivity = true;
      playbookValidationSummaries.push(formatPlaybookValidationSummary(validation));
      if (!validation.ok) {
        throw new Error(formatPlaybookValidationSummary(validation));
      }
      successfulToolActivity = true;
      playbookValidatedPackagePaths.add(normalizePackagePath(validation.packagePath));
      playbookValidationSummaries.push(
        formatPlaybookUpdateNoChangeError({
          implementationRetryUsed: playbookUpdateImplementationRetryUsed,
          validationSummary: formatPlaybookValidationSummary(validation),
        })
      );
    }
    if (
      !result.text.trim() &&
      result.boundaryViolations === 0 &&
      !taskRuntimeActivity &&
      !successfulToolActivity
    ) {
      throw new Error(
        "Tessera did not receive a response from the model, and no tool work was recorded. Please retry the message."
      );
    }
    const modelText = result.text.trim();
    const playbookSummaries = [
      ...playbookScaffoldSummaries,
      ...playbookRepairSummaries,
      ...playbookValidationSummaries,
      ...playbookImportSummaries,
    ];
    const artifactContent =
      playbookSummaries.length > 0
        ? [modelText, ...playbookSummaries].filter(Boolean).join("\n\n")
        : modelText ||
          fallbackAgentResponse({
            task: latestTask,
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
