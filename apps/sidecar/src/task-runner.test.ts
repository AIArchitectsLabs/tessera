import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskTurn } from "./task-runner.js";
import { createTaskStore } from "./task-store.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-task-runner-"));
  tempDirs.push(dir);
  return join(dir, "tasks.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task runner", () => {
  test("completes the first user turn and creates an artifact", () => {
    const store = createTaskStore(tempDbPath());
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
      agentLabel: "Maeve",
    });
    const firstTurn = task.turns[0];
    if (!firstTurn) throw new Error("expected first turn");

    const result = runTaskTurn({ store, taskId: task.id, userTurnId: firstTurn.id });

    expect(result.status).toBe("done");
    expect(result.latestActivity).toBe("Created task output");
    expect(result.turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(result.turns[0]?.status).toBe("completed");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.turnId).toBe(result.turns[1]?.id);

    store.close();
  });

  test("runs a follow-up user turn with prior context", () => {
    const store = createTaskStore(tempDbPath());
    const task = store.createTask({
      workspaceRoot: "/workspace/acme",
      initialInstruction: "Draft a launch announcement",
    });
    const firstTurn = task.turns[0];
    if (!firstTurn) throw new Error("expected first turn");
    runTaskTurn({ store, taskId: task.id, userTurnId: firstTurn.id });

    const followUp = store.createUserTurn(task.id, "Make it shorter");
    const result = runTaskTurn({ store, taskId: task.id, userTurnId: followUp.id });

    expect(result.turns).toHaveLength(4);
    expect(result.turns.at(-1)?.content).toContain("Make it shorter");
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.at(-1)?.contentPreview).toContain("Make it shorter");

    store.close();
  });
});
