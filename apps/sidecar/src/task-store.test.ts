import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore } from "./task-store.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-task-store-"));
  tempDirs.push(dir);
  return join(dir, "tasks.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task store", () => {
  test("rejects task creation without a workspace root", () => {
    const store = createTaskStore(tempDbPath());

    expect(() =>
      store.createTask({
        workspaceRoot: "",
        initialInstruction: "Draft a launch announcement",
      })
    ).toThrow("workspaceRoot is required");

    store.close();
  });

  test("creates a task with the first user turn", () => {
    const store = createTaskStore(tempDbPath());

    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
      agentLabel: "Maeve",
    });

    expect(task.title).toBe("Draft a launch announcement");
    expect(task.status).toBe("active");
    expect(task.turns).toHaveLength(1);
    expect(task.turns[0]).toMatchObject({
      taskId: task.id,
      role: "user",
      content: "Draft a launch announcement",
      status: "running",
    });

    store.close();
  });

  test("generates a compact task title from the first instruction", () => {
    const store = createTaskStore(tempDbPath());

    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction:
        "  Please draft a launch announcement for the new analytics workspace with customer proof points.",
    });

    expect(task.title).toBe("Please draft a launch announcement for the ne...");
    store.close();
  });

  test("lists tasks by workspace ordered by update time", () => {
    const store = createTaskStore(tempDbPath());
    const first = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "First task",
    });
    const other = store.createTask({
      workspaceRoot: "/workspace/other",
      initialInstruction: "Other task",
    });
    const second = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Second task",
    });

    store.updateTask(first.id, { latestActivity: "Updated first" });

    expect(store.listTasks({ workspaceRoot: "/workspace/acme" }).map((task) => task.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(store.listTasks({ workspaceRoot: "/workspace/other" }).map((task) => task.id)).toEqual([
      other.id,
    ]);

    store.close();
  });

  test("appends turns and creates turn-linked artifacts", () => {
    const store = createTaskStore(tempDbPath());
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
    });
    const followUp = store.createUserTurn(task.id, "Make it shorter");
    const agentTurn = store.createAgentTurn(task.id, "Created a shorter revision.");
    const artifact = store.createArtifact({
      taskId: task.id,
      turnId: agentTurn.id,
      kind: "text",
      title: "Revision",
      contentPreview: "Shorter revision",
    });

    const loaded = store.getTask(task.id);

    expect(followUp.role).toBe("user");
    expect(artifact.turnId).toBe(agentTurn.id);
    expect(loaded?.turns.map((turn) => turn.content)).toEqual([
      "Draft a launch announcement",
      "Make it shorter",
      "Created a shorter revision.",
    ]);
    expect(loaded?.artifacts).toHaveLength(1);

    store.close();
  });

  test("updates task status and failed turn state", () => {
    const store = createTaskStore(tempDbPath());
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
    });
    const turn = task.turns[0];
    if (!turn) throw new Error("expected first turn");

    store.updateTurn(turn.id, { status: "failed", error: "Runner failed" });
    const updated = store.updateTask(task.id, {
      status: "failed",
      latestActivity: "Runner failed",
    });

    expect(updated?.status).toBe("failed");
    expect(updated?.latestActivity).toBe("Runner failed");
    expect(updated?.turns[0]?.error).toBe("Runner failed");

    store.close();
  });
});
