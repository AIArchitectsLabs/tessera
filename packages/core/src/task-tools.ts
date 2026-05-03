import { type Static, Type } from "@mariozechner/pi-ai";
import { type ToolDefinition, defineTool } from "@mariozechner/pi-coding-agent";
import type { TaskTodo, TodoOperation } from "@tessera/contracts";

export interface TaskToolRuntime {
  applyTodo(operation: TodoOperation): Promise<TaskTodo | undefined>;
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

  const todoTool = defineTool({
    name: "todo",
    label: "Todo",
    description: "Create and update the task checklist shown in the task UI.",
    promptSnippet: "todo: create and maintain the current task checklist in the task UI.",
    parameters: todoOperationSchema,
    async execute(_toolCallId, params: Static<typeof todoOperationSchema>) {
      const operation = params as TodoOperation;
      const todo = await runtime.applyTodo(operation);
      return {
        content: [{ type: "text", text: summarizeTodo(operation) }],
        details: todo,
      };
    },
  });

  return [todoTool];
}
