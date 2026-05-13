import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryManager } from "./memory-manager.js";
import { createMemoryStore } from "./memory-store.js";

const stores: ReturnType<typeof createMemoryStore>[] = [];

function makeStore(): ReturnType<typeof createMemoryStore> {
  const store = createMemoryStore(":memory:");
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("workflow memory projection", () => {
  test("records completed workflow run without storing raw output body", async () => {
    const store = makeStore();
    const manager = createMemoryManager({ store, ownerId: "local-owner" });

    await manager.recordWorkflowRun({
      workspaceRoot: "/workspace/acme",
      run: {
        runId: "run-1",
        workflowId: "ops.weekly-status-digest",
        status: "completed",
        input: { workspaceRoot: "/workspace/acme" },
        sourceGaps: [],
        outputs: {
          draft: {
            text: "This raw draft should not be copied into memory projection.",
          },
        },
        startedAt: "2026-05-13T00:00:00.000Z",
        completedAt: "2026-05-13T00:01:00.000Z",
      },
    });

    const event = store.getEventByKey("workflow:run-1:completed");
    expect(event?.content).toContain("ops.weekly-status-digest");
    expect(event?.content.toLowerCase()).toContain("output keys: draft");
    expect(event?.content).not.toContain("This raw draft should not be copied");
  });
});
