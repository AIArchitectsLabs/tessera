import { type Static, Type } from "@mariozechner/pi-ai";
import { type ToolDefinition, defineTool } from "@mariozechner/pi-coding-agent";
import type { ClarifyOption, ClarifyResponse, TaskTodo, TodoOperation } from "@tessera/contracts";

export interface TaskToolRuntime {
  applyTodo?(operation: TodoOperation): Promise<TaskTodo | undefined>;
  requestClarify?(request: TaskClarifyInput): Promise<ClarifyResponse>;
  scaffoldPlaybookPackage?(
    request: PlaybookPackageScaffoldInput
  ): Promise<PlaybookPackageScaffoldResult>;
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
          "playbook_package_scaffold: create the initial Tessera playbook package files inside the workspace in one call. Use this for tessera-playbook-author package generation before reporting completion.",
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

  return tools;
}
