import { describe, expect, test } from "bun:test";
import type { TaskDetail, TaskSummary } from "@tessera/contracts";
import { mergeTaskSummary, summaryFromDetail } from "./taskSummaries.js";

const summary: TaskSummary = {
  id: "task-1",
  workspaceRoot: "/workspace",
  title: "Draft plan",
  status: "active",
  agentId: "default",
  agentLabel: "Tessera",
  latestActivity: "Starting",
  createdAt: "2026-05-03T00:00:00.000Z",
  updatedAt: "2026-05-03T00:00:00.000Z",
};

describe("taskSummaries", () => {
  test("replaces an existing summary in place", () => {
    const next = mergeTaskSummary([summary], {
      ...summary,
      status: "done",
      latestActivity: "Completed",
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("done");
    expect(next[0]?.latestActivity).toBe("Completed");
  });

  test("prepends a new summary when the task is not present", () => {
    const other: TaskSummary = { ...summary, id: "task-2", title: "Second task" };
    const next = mergeTaskSummary([summary], other);
    expect(next[0]?.id).toBe("task-2");
    expect(next[1]?.id).toBe("task-1");
  });

  test("derives a summary from task detail", () => {
    const detail: TaskDetail = {
      ...summary,
      description: "desc",
      notifications: [],
      auditRecords: [],
      turns: [],
      artifacts: [],
      agentContext: undefined,
    };
    expect(summaryFromDetail(detail)).toEqual(summary);
  });
});
