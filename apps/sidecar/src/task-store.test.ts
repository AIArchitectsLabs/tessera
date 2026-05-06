import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfileSchema, compileAgentRuntimeContext } from "@tessera/contracts";
import { createTaskStore } from "./task-store.js";

const tempDirs: string[] = [];

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-task-store-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task store", () => {
  test("persists the compiled agent context snapshot with the task", () => {
    const store = createTaskStore(tempDbPath("tasks.sqlite"));
    try {
      const profile = AgentProfileSchema.parse({
        id: "ops",
        name: "Ops Partner",
        model: { mode: "default" },
        instructions: "Drive concrete outcomes.",
        toolPolicyPreset: "workspace_editor",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      });
      const agentContext = compileAgentRuntimeContext(profile);

      const task = store.createTask({
        workspaceRoot: "/workspace/acme",
        initialInstruction: "Draft an operating plan",
        agentId: profile.id,
        agentLabel: profile.name,
        agentContext,
      });

      expect(task.agentContext).toEqual(agentContext);
      expect(store.getTask(task.id)?.agentContext?.profileName).toBe("Ops Partner");
    } finally {
      store.close();
    }
  });

  test("persists todo and clarify state with the task", () => {
    const store = createTaskStore(tempDbPath("tasks.sqlite"));
    try {
      const task = store.createTask({
        workspaceRoot: "/workspace/acme",
        initialInstruction: "Plan launch work",
      });

      store.updateTodo(task.id, {
        type: "create",
        items: [
          { id: "todo-1", label: "Draft brief", status: "pending", order: 0 },
          { id: "todo-2", label: "Review risks", status: "in_progress", order: 1 },
        ],
      });
      store.requestClarify(task.id, {
        promptId: "prompt-1",
        taskId: task.id,
        message: "Which region should launch first?",
        allowFreeform: true,
        options: [{ id: "us", label: "US" }],
        createdAt: "2026-05-03T00:00:00.000Z",
      });

      const snapshot = store.getTask(task.id);
      expect(snapshot?.todo?.items).toHaveLength(2);
      expect(snapshot?.clarify?.promptId).toBe("prompt-1");
    } finally {
      store.close();
    }
  });

  test("preserves completed todo items when the checklist is regenerated", () => {
    const store = createTaskStore(tempDbPath("tasks.sqlite"));
    try {
      const task = store.createTask({
        workspaceRoot: "/workspace/acme",
        initialInstruction: "Ship the launch plan",
      });

      store.updateTodo(task.id, {
        type: "create",
        items: [
          { id: "todo-1", label: "Draft brief", status: "pending", order: 0 },
          { id: "todo-2", label: "Review risks", status: "pending", order: 1 },
        ],
      });
      store.updateTodo(task.id, {
        type: "set_status",
        itemId: "todo-1",
        status: "completed",
      });
      store.updateTodo(task.id, {
        type: "replace",
        items: [
          { id: "todo-1b", label: "Draft brief", status: "pending", order: 0 },
          { id: "todo-2", label: "Review risks", status: "in_progress", order: 1 },
          { id: "todo-3", label: "Publish update", status: "pending", order: 2 },
        ],
      });

      expect(store.getTask(task.id)?.todo?.items).toEqual([
        { id: "todo-1b", label: "Draft brief", status: "completed", order: 0 },
        { id: "todo-2", label: "Review risks", status: "in_progress", order: 1 },
        { id: "todo-3", label: "Publish update", status: "pending", order: 2 },
      ]);
    } finally {
      store.close();
    }
  });

  test("archives tasks without removing them and supports restoring them", () => {
    const store = createTaskStore(tempDbPath("tasks.sqlite"));
    try {
      const task = store.createTask({
        workspaceRoot: "/workspace/acme",
        initialInstruction: "Prepare weekly report",
      });

      const archived = store.updateTask(task.id, { archived: true });
      expect(archived?.archivedAt).toBeString();
      expect(store.listTasks({ workspaceRoot: "/workspace/acme" })[0]?.archivedAt).toBeString();

      const restored = store.updateTask(task.id, { archived: false });
      expect(restored?.archivedAt).toBeUndefined();
      expect(store.getTask(task.id)?.archivedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("persists active task skills in task details", () => {
    const store = createTaskStore(tempDbPath("tasks.sqlite"));
    try {
      const task = store.createTask({
        workspaceRoot: "/workspace/acme",
        initialInstruction: "Prepare weekly report",
      });

      const active = store.addActiveSkill(task.id, {
        skillId: "planning",
        name: "planning",
        source: "curated",
        activatedByTurnId: "turn-1",
      });
      expect(active?.activeSkills).toMatchObject([
        {
          skillId: "planning",
          name: "planning",
          source: "curated",
          activatedByTurnId: "turn-1",
        },
      ]);

      expect(store.getTask(task.id)?.activeSkills).toHaveLength(1);
      expect(store.removeActiveSkill(task.id, "planning")?.activeSkills).toEqual([]);
    } finally {
      store.close();
    }
  });
});
