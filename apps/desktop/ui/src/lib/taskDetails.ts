import type { TaskDetail, TaskTurn } from "@tessera/contracts";

function turnStatusRank(status: TaskTurn["status"]): number {
  if (status === "completed" || status === "failed") return 3;
  if (status === "running") return 2;
  if (status === "queued") return 1;
  return 0;
}

function preferTurn(current: TaskTurn, incoming: TaskTurn): TaskTurn {
  const currentRank = turnStatusRank(current.status);
  const incomingRank = turnStatusRank(incoming.status);
  if (incomingRank > currentRank) return incoming;
  if (incomingRank < currentRank) return current;

  if ((incoming.completedAt ?? "") > (current.completedAt ?? "")) return incoming;
  if (incoming.error && !current.error) return incoming;
  if (incoming.content.length > current.content.length) return incoming;
  return incoming.createdAt >= current.createdAt ? incoming : current;
}

export function mergeTaskDetail(current: TaskDetail, incoming: TaskDetail): TaskDetail {
  const turnsById = new Map<string, TaskTurn>();
  for (const turn of current.turns) turnsById.set(turn.id, turn);
  for (const turn of incoming.turns) {
    const existing = turnsById.get(turn.id);
    turnsById.set(turn.id, existing ? preferTurn(existing, turn) : turn);
  }

  const artifactsById = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifact of incoming.artifacts) {
    artifactsById.set(artifact.id, artifact);
  }

  const base = incoming.updatedAt >= current.updatedAt ? incoming : current;

  return {
    ...base,
    turns: [...turnsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    artifacts: [...artifactsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}
