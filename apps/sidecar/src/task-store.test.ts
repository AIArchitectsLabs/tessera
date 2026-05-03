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
});
