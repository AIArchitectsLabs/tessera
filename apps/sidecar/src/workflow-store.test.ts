import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRunResult } from "@tessera/contracts";
import { createWorkflowCheckpointStore } from "./workflow-store.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-workflow-store-"));
  tempDirs.push(dir);
  return join(dir, "workflow-runs.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function blockedRun(): WorkflowRunResult {
  return {
    runId: "run-1",
    workflowId: "demo.write-approval",
    status: "blocked",
    currentStepId: "writeProbe",
    input: { message: "hello", target: "lead", value: "qualified" },
    outputs: {
      ping: {
        message: "pong",
      },
    },
    approval: {
      toolId: "workspace.writeProbe",
      args: { target: "lead", value: "qualified" },
      capability: "write",
      risk: {
        mutates: true,
        destructive: false,
        external: false,
        reversible: true,
        dryRunSupported: true,
      },
      preview: "write-probe target=lead value=qualified",
      reasonCode: "write_requires_approval",
    },
  };
}

describe("workflow checkpoint store", () => {
  test("persists a workflow run across store instances", () => {
    const dbPath = tempDbPath();
    const first = createWorkflowCheckpointStore(dbPath);
    const run = blockedRun();

    first.save(run);
    first.close();

    const second = createWorkflowCheckpointStore(dbPath);
    expect(second.get(run.runId)).toEqual(run);
    second.close();
  });

  test("updates an existing workflow run checkpoint", () => {
    const store = createWorkflowCheckpointStore(tempDbPath());
    const run = blockedRun();

    store.save(run);
    store.save({
      ...run,
      status: "completed",
      currentStepId: undefined,
      approval: undefined,
      outputs: {
        ...run.outputs,
        writeProbe: { target: "lead", value: "qualified", mutated: false },
      },
    });

    expect(store.get(run.runId)?.status).toBe("completed");
    expect(store.list()).toHaveLength(1);
    store.close();
  });
});
