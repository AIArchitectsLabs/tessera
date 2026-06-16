import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentProfile,
  AgentProviderConfig,
  AgentRuntimeContext,
  ClarifyRequest,
  ClarifyResponse,
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
  type PlaybookPackageScaffoldInput,
  type PlaybookPackageScaffoldResult,
  type PythonSkillRunInput,
  type PythonSkillRunResult,
  type TaskClarifyInput,
  type WorkspaceCliExecutor,
  createPythonSkillRuntime,
  createSpawnShellExecutor,
  createWorkspaceGuard,
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

function hasActivePlaybookAuthorSkill(
  task: NonNullable<ReturnType<TaskStore["getTask"]>>
): boolean {
  return task.activeSkills.some((skill) => {
    const id = skill.skillId.toLowerCase();
    const name = skill.name.toLowerCase();
    return (
      id === "tessera-playbook-author" ||
      id.endsWith(":tessera-playbook-author") ||
      name === "tessera-playbook-author"
    );
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

function compactPlaybookPromptForName(text: string): string {
  return text
    .replace(/\/(?:skill\s+)?tessera-playbook-author\b/gi, " ")
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

async function confirmPlaybookScaffoldRequest(input: {
  request: PlaybookPackageScaffoldInput;
  publish: (event: TaskEvent) => void;
  store: TaskStore;
  taskId: string;
}): Promise<PlaybookPackageScaffoldInput> {
  const response = await waitForClarifyResponse({
    clarify: normalizeClarifyRequest(input.taskId, {
      promptId: `playbook-package-name-${crypto.randomUUID()}`,
      message: "What should I call this playbook package?",
      detail: `Suggested: ${input.request.name ?? titleFromSlug(input.request.id ?? "Generated Playbook")} (${input.request.packagePath}). Continue with the suggestion or type a different name.`,
      allowFreeform: true,
      options: [
        {
          id: "use-suggested-name",
          label: `Use ${input.request.name ?? titleFromSlug(input.request.id ?? "Generated Playbook")}`,
          description: input.request.packagePath,
        },
      ],
    }),
    publish: input.publish,
    store: input.store,
    taskId: input.taskId,
  });
  if (response.cancelled) {
    throw new Error("Playbook package name was not confirmed.");
  }
  if (response.freeform?.trim()) {
    return playbookRequestWithName(input.request, response.freeform);
  }
  return input.request;
}

function scaffoldPlaybookFiles(
  input: Required<PlaybookPackageScaffoldInput>
): Record<string, string> {
  const manifest = {
    schemaVersion: 1,
    id: input.id,
    version: "0.1.0",
    name: input.name,
    entrypoint: "playbook.ts",
  };

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
    requiredCapabilities: [],
    optionalCapabilities: ["mail"],
    outputs: [{ kind: "workspaceDocument", label: ${JSON.stringify(input.name)} }],
    phases: ["Draft", "Review", "Write"],
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
  },
  artifacts: {
    finalArtifact: { schema: "schemas/finalArtifact.schema.json" },
  },
  capabilities: ["mail", "tool.workspace.write"],
  limits: {},
  start: "draft",
  nodes: [
    {
      id: "draft",
      label: "Draft ${input.name}",
      kind: "agent",
      prompt: "prompts/draft.md",
      inputs: {
        workspaceRoot: { input: "workspaceRoot" },
        outputPath: { input: "outputPath" },
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
    "prompts/draft.md": `Create ${input.name} from ${input.source}.

Return only JSON that matches schemas/finalArtifact.schema.json.
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
    "build.ts": `const command = process.argv[2] ?? "help";

if (command === "validate") {
  console.log("Run Tessera playbook validation from the Tessera repo when available.");
} else if (command === "package") {
  console.log("Create an import archive from tracked package files.");
} else {
  console.log("Usage: bun run build.ts <validate|package>");
}
`,
    "BUILD.md": `# Build

This package is authored for Tessera import. Development helpers are intentionally local-only.

- Validate JSON and package-local tests with Bun.
- Run Tessera playbook validation from the Tessera repo when available.
- Do not add dependency fields, lockfiles, bin entries, or standalone graph runners.
`,
    "PLAYBOOK.md": `# ${input.name}

${input.description}

## Source

${input.source}

## Output

The approved final artifact is written to \`${input.outputPath}\` in the selected workspace.
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
  let playbookScaffoldSummary: string | undefined;

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
        if (!toolResultFailed(tool.result)) {
          successfulToolActivity = true;
          if (isWorkspaceFileWriteTool(tool.name)) {
            successfulWorkspaceFileActivity = true;
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
      },
      workspaceRoot: task.workspaceRoot,
    });
    const latestTask = store.getTask(taskId) ?? task;
    if (
      result.boundaryViolations === 0 &&
      hasActivePlaybookAuthorSkill(latestTask) &&
      !successfulWorkspaceFileActivity
    ) {
      const request = await confirmPlaybookScaffoldRequest({
        request: inferPlaybookScaffoldRequest({ prompt, task: latestTask }),
        publish,
        store,
        taskId,
      });
      const scaffold = await scaffoldPlaybookPackage({
        request,
        workspaceRoot: task.workspaceRoot,
      });
      taskRuntimeActivity = true;
      successfulToolActivity = true;
      successfulWorkspaceFileActivity = true;
      playbookScaffoldSummary = formatPlaybookScaffoldSummary(scaffold);
      const artifact = store.createArtifact({
        taskId,
        turnId: agentTurnId,
        kind: "text",
        title: "Playbook package scaffold",
        contentPreview: scaffold.packagePath,
      });
      publish({
        type: "artifact.created",
        taskId,
        emittedAt: new Date().toISOString(),
        artifact,
      });
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
    const artifactContent = playbookScaffoldSummary
      ? modelText
        ? `${modelText}\n\n${playbookScaffoldSummary}`
        : playbookScaffoldSummary
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
