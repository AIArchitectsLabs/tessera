import type { TaskEvent } from "@tessera/contracts";

export type TaskEventSubscriber = (event: TaskEvent) => void;

export interface TaskEventBus {
  subscribe(taskId: string, subscriber: TaskEventSubscriber): () => void;
  publish(taskId: string, event: TaskEvent): void;
}

export function createTaskEventBus(): TaskEventBus {
  const channels = new Map<string, Set<TaskEventSubscriber>>();
  return {
    subscribe(taskId, subscriber) {
      let set = channels.get(taskId);
      if (!set) {
        set = new Set();
        channels.set(taskId, set);
      }
      set.add(subscriber);
      return () => {
        const current = channels.get(taskId);
        if (!current) return;
        current.delete(subscriber);
        if (current.size === 0) channels.delete(taskId);
      };
    },
    publish(taskId, event) {
      const set = channels.get(taskId);
      if (!set) return;
      for (const subscriber of set) {
        try {
          subscriber(event);
        } catch (err) {
          console.error("task-event-bus subscriber threw", err);
        }
      }
    },
  };
}
