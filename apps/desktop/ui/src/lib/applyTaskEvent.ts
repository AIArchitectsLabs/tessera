import type { TaskDetail, TaskEvent } from "@tessera/contracts";

export function applyTaskEvent(detail: TaskDetail, event: TaskEvent): TaskDetail {
  if (event.taskId !== detail.id) return detail;
  switch (event.type) {
    case "task.updated":
      return { ...detail, ...event.task };
    case "turn.created":
      if (detail.turns.some((t) => t.id === event.turn.id)) return detail;
      return { ...detail, turns: [...detail.turns, event.turn] };
    case "turn.status_changed":
    case "turn.completed":
      return {
        ...detail,
        turns: detail.turns.map((t) => (t.id === event.turn.id ? event.turn : t)),
      };
    case "artifact.created":
      if (detail.artifacts.some((a) => a.id === event.artifact.id)) return detail;
      return { ...detail, artifacts: [...detail.artifacts, event.artifact] };
  }
}
