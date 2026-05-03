import type { TaskDetail, TaskSummary } from "@tessera/contracts";

export function summaryFromDetail(detail: TaskDetail): TaskSummary {
  return {
    id: detail.id,
    workspaceRoot: detail.workspaceRoot,
    title: detail.title,
    status: detail.status,
    agentId: detail.agentId,
    agentLabel: detail.agentLabel,
    latestActivity: detail.latestActivity,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

export function mergeTaskSummary(current: TaskSummary[], nextSummary: TaskSummary): TaskSummary[] {
  const existingIndex = current.findIndex((task) => task.id === nextSummary.id);
  if (existingIndex === -1) {
    return [nextSummary, ...current];
  }

  return current.map((task) => (task.id === nextSummary.id ? nextSummary : task));
}
