import { type Static, Type } from "@mariozechner/pi-ai";
import { type ToolDefinition, defineTool } from "@mariozechner/pi-coding-agent";
import type { ClarifyOption, ClarifyResponse, TaskTodo, TodoOperation } from "@tessera/contracts";

export interface TaskToolRuntime {
  applyTodo?(operation: TodoOperation): Promise<TaskTodo | undefined>;
  requestClarify?(request: TaskClarifyInput): Promise<ClarifyResponse>;
  scaffoldPlaybookPackage?(
    request: PlaybookPackageScaffoldInput
  ): Promise<PlaybookPackageScaffoldResult>;
  validatePlaybookPackage?(
    request: PlaybookPackageValidateInput
  ): Promise<PlaybookPackageValidateResult>;
  diagnosePlaybookRun?(request: PlaybookRunDiagnosticsInput): Promise<PlaybookRunDiagnosticsResult>;
}

export interface TaskClarifyInput {
  promptId?: string;
  message: string;
  detail?: string;
  allowFreeform?: boolean;
  options?: ClarifyOption[];
}

export interface PlaybookPackageScaffoldInput {
  packagePath: string;
  id?: string;
  name?: string;
  description?: string;
  source?: string;
  outputPath?: string;
}

export interface PlaybookPackageScaffoldResult {
  packagePath: string;
  files: string[];
}

export interface PlaybookPackageValidateInput {
  packagePath: string;
  runPackageTests?: boolean;
  runTesseraValidation?: boolean;
}

export interface PlaybookPackageValidationStep {
  name: string;
  command: string;
  ok: boolean;
  skipped?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface PlaybookPackageValidateResult {
  packagePath: string;
  ok: boolean;
  steps: PlaybookPackageValidationStep[];
}

export interface PlaybookRunDiagnosticsInput {
  runId?: string;
  playbookId?: string;
  packagePath?: string;
  includeArtifactPreviews?: boolean;
  maxArtifacts?: number;
  maxRuns?: number;
}

export interface PlaybookRunDiagnosticsIssue {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  evidence?: string[];
  suggestedFix?: string;
}

export interface PlaybookRunDiagnosticsResult {
  ok: boolean;
  request: PlaybookRunDiagnosticsInput;
  selectedRun?: {
    runId: string;
    playbookId: string;
    packageVersion?: string;
    status: string;
    workspaceRoot?: string;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    currentQueueEntryId?: string;
    blockedReason?: string;
    repairReason?: string;
    error?: string;
  };
  recentRuns: Array<{
    runId: string;
    playbookId: string;
    status: string;
    workspaceRoot?: string;
    updatedAt: string;
  }>;
  queueSummary: {
    total: number;
    byStatus: Record<string, number>;
    entries: Array<{
      queueEntryId: string;
      nodeId: string;
      nodePath: string;
      nodeKind: string;
      status: string;
      producesArtifacts: string[];
      consumesArtifacts: string[];
      blockedReason?: string;
      error?: string;
    }>;
  };
  artifactSummary: {
    total: number;
    previews: Array<{
      artifactId: string;
      versionId: string;
      nodePath: string;
      producerQueueEntryId: string;
      createdAt: string;
      valueKind: string;
      textFields: Array<{ path: string; chars: number; preview?: string }>;
    }>;
  };
  effectSummary: {
    total: number;
    records: Array<{
      effectExecutionRecordId: string;
      queueEntryId: string;
      nodePath: string;
      capability: string;
      status: string;
      commitStatus?: string;
      outputReference?: string;
      output?: unknown;
      error?: string;
    }>;
  };
  workspaceOutputSummary: {
    total: number;
    records: Array<{
      nodePath: string;
      nodeKind: "effect" | "artifactWrite";
      path?: string;
      format?: string;
      bytes?: number;
      artifactId?: string;
      artifactChars?: number;
      status: string;
    }>;
  };
  reviewSummary: {
    total: number;
    records: Array<{
      reviewEventId: string;
      queueEntryId: string;
      nodePath: string;
      artifactId: string;
      decision: string;
      createdAt: string;
    }>;
  };
  operationSummary: {
    total: number;
    records: Array<{
      operationRecordId: string;
      kind: string;
      status: string;
      operatorIntent: string;
      redactedPayloadSummary?: string;
      failureReason?: string;
      createdAt: string;
    }>;
  };
  issues: PlaybookRunDiagnosticsIssue[];
  nextActions: string[];
}

const todoItemSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  status: Type.String(),
  note: Type.Optional(Type.String()),
  order: Type.Number(),
});

const todoOperationSchema = Type.Object({
  type: Type.String(),
  itemId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(todoItemSchema)),
  item: Type.Optional(todoItemSchema),
});

const clarifyOptionSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const clarifyInputSchema = Type.Object({
  promptId: Type.Optional(Type.String()),
  message: Type.String(),
  detail: Type.Optional(Type.String()),
  allowFreeform: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(clarifyOptionSchema)),
});

const playbookPackageScaffoldSchema = Type.Object({
  packagePath: Type.String(),
  id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  outputPath: Type.Optional(Type.String()),
});

const playbookPackageValidateSchema = Type.Object({
  packagePath: Type.String(),
  runPackageTests: Type.Optional(Type.Boolean()),
  runTesseraValidation: Type.Optional(Type.Boolean()),
});

const playbookRunDiagnosticsSchema = Type.Object({
  runId: Type.Optional(Type.String()),
  playbookId: Type.Optional(Type.String()),
  packagePath: Type.Optional(Type.String()),
  includeArtifactPreviews: Type.Optional(Type.Boolean()),
  maxArtifacts: Type.Optional(Type.Number()),
  maxRuns: Type.Optional(Type.Number()),
});

function summarizeTodo(operation: TodoOperation): string {
  switch (operation.type) {
    case "create":
      return `Created a checklist with ${operation.items.length} item${operation.items.length === 1 ? "" : "s"}.`;
    case "replace":
      return `Replaced the checklist with ${operation.items.length} item${operation.items.length === 1 ? "" : "s"}.`;
    case "set_status":
      return `Updated checklist item ${operation.itemId} to ${operation.status}.`;
    case "append":
      return `Added checklist item: ${operation.item.label}.`;
    case "remove":
      return `Removed checklist item ${operation.itemId}.`;
  }
}

export function createTaskToolDefinitions(runtime?: TaskToolRuntime): ToolDefinition[] {
  if (!runtime) return [];

  const tools: ToolDefinition[] = [];

  if (runtime.applyTodo) {
    tools.push(
      defineTool({
        name: "todo",
        label: "Todo",
        description: "Create and update the task checklist shown in the task UI.",
        promptSnippet: "todo: create and maintain the current task checklist in the task UI.",
        parameters: todoOperationSchema,
        async execute(_toolCallId, params: Static<typeof todoOperationSchema>) {
          const operation = params as TodoOperation;
          const todo = await runtime.applyTodo?.(operation);
          return {
            content: [{ type: "text", text: summarizeTodo(operation) }],
            details: todo,
          };
        },
      })
    );
  }

  if (runtime.requestClarify) {
    tools.push(
      defineTool({
        name: "clarify",
        label: "Clarify",
        description: "Ask the user one blocking clarification question in the task UI.",
        promptSnippet:
          "clarify: ask one blocking clarification question in the task UI, with optional choices.",
        parameters: clarifyInputSchema,
        async execute(_toolCallId, params: Static<typeof clarifyInputSchema>) {
          const response = await runtime.requestClarify?.(params as TaskClarifyInput);
          return {
            content: [
              {
                type: "text",
                text: response?.cancelled
                  ? "Clarification was cancelled."
                  : (response?.selectedOptionId ??
                    response?.freeform ??
                    "Clarification response received."),
              },
            ],
            details: response,
          };
        },
      })
    );
  }

  if (runtime.scaffoldPlaybookPackage) {
    tools.push(
      defineTool({
        name: "playbook_package_scaffold",
        label: "Scaffold Playbook Package",
        description:
          "Create a Tessera-importable playbook package folder with starter files inside the selected workspace.",
        promptSnippet:
          "playbook_package_scaffold: create the initial Tessera playbook package files inside the workspace in one call. Use this for tessera-playbook-builder package generation before reporting completion.",
        parameters: playbookPackageScaffoldSchema,
        async execute(_toolCallId, params: Static<typeof playbookPackageScaffoldSchema>) {
          const result = await runtime.scaffoldPlaybookPackage?.(
            params as PlaybookPackageScaffoldInput
          );
          return {
            content: [
              {
                type: "text",
                text: `Created playbook package at ${result?.packagePath ?? params.packagePath}.`,
              },
            ],
            details: result,
          };
        },
      })
    );
  }

  if (runtime.validatePlaybookPackage) {
    tools.push(
      defineTool({
        name: "playbook_package_validate",
        label: "Validate Playbook Package",
        description:
          "Run package-local build/tests and Tessera playbook validation for a workspace playbook package.",
        promptSnippet:
          "playbook_package_validate: run package-local build/tests and Tessera playbook validation after creating, fixing, or updating a playbook package. Validation proves package shape and test health; it does not prove the requested semantic update was implemented, so do not use validation-only as completion for feature/update asks.",
        parameters: playbookPackageValidateSchema,
        async execute(_toolCallId, params: Static<typeof playbookPackageValidateSchema>) {
          const result = await runtime.validatePlaybookPackage?.(
            params as PlaybookPackageValidateInput
          );
          const text = result?.ok
            ? `Validated playbook package at ${result.packagePath}.`
            : `Playbook package validation failed for ${result?.packagePath ?? params.packagePath}.`;
          return {
            ...(result?.ok ? {} : { error: "Playbook package validation failed." }),
            content: [{ type: "text", text }],
            details: result,
          };
        },
      })
    );
  }

  if (runtime.diagnosePlaybookRun) {
    tools.push(
      defineTool({
        name: "playbook_run_diagnostics",
        label: "Playbook Run Diagnostics",
        description:
          "Inspect Tessera playbook run records, queue steps, artifacts, effect writes, and operation logs for debugging failed or blank playbook outputs.",
        promptSnippet:
          "playbook_run_diagnostics: inspect recent Tessera playbook run database records before repairing a failed, blank, stalled, or incorrect playbook run. Use runId when known, otherwise pass playbookId or packagePath. Reserve this for run troubleshooting; pure feature enhancements should inspect and edit package files instead.",
        parameters: playbookRunDiagnosticsSchema,
        async execute(_toolCallId, params: Static<typeof playbookRunDiagnosticsSchema>) {
          const result = await runtime.diagnosePlaybookRun?.(params as PlaybookRunDiagnosticsInput);
          const target = result?.selectedRun
            ? `${result.selectedRun.playbookId} run ${result.selectedRun.runId}`
            : (params.runId ?? params.playbookId ?? params.packagePath ?? "recent playbook runs");
          const issueCopy =
            result && result.issues.length > 0
              ? ` Found ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}.`
              : "";
          return {
            content: [
              {
                type: "text",
                text: result?.ok
                  ? `Inspected ${target}.${issueCopy}`.trim()
                  : `No matching playbook run found for ${target}.`,
              },
            ],
            details: result,
          };
        },
      })
    );
  }

  return tools;
}
