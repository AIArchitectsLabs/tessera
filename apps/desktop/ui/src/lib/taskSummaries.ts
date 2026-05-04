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
    archivedAt: detail.archivedAt,
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

export function categorizeTaskSummaries(tasks: TaskSummary[]): {
  active: TaskSummary[];
  archived: TaskSummary[];
} {
  return tasks.reduce(
    (groups, task) => {
      if (task.archivedAt) {
        groups.archived.push(task);
      } else {
        groups.active.push(task);
      }
      return groups;
    },
    { active: [] as TaskSummary[], archived: [] as TaskSummary[] }
  );
}
