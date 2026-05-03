import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { type TaskDetail, type TaskEvent, TaskEventSchema } from "@tessera/contracts";
import { useEffect } from "react";

export interface UseTaskEventsOptions {
  taskId: string | null;
  onEvent: (event: TaskEvent) => void;
  onSnapshot?: (task: TaskDetail) => void;
  onReconnect?: () => void;
}

export function useTaskEvents({
  taskId,
  onEvent,
  onSnapshot,
  onReconnect,
}: UseTaskEventsOptions): void {
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    let unlistenEvent: UnlistenFn | undefined;
    let unlistenClosed: UnlistenFn | undefined;

    void (async () => {
      unlistenEvent = await listen<string>(`task:event:${taskId}`, (msg) => {
        const parsed = TaskEventSchema.safeParse(JSON.parse(msg.payload));
        if (parsed.success) onEvent(parsed.data);
      });
      unlistenClosed = await listen(`task:event:${taskId}:closed`, () => {
        if (!cancelled) {
          onReconnect?.();
          void invoke("task_subscribe", { taskId }).catch(() => {});
        }
      });
      if (cancelled) {
        unlistenEvent?.();
        unlistenClosed?.();
        return;
      }
      await invoke("task_subscribe", { taskId });
      const snapshot = await invoke<TaskDetail>("task_get", { taskId });
      if (!cancelled) {
        onSnapshot?.(snapshot);
      }
    })();

    return () => {
      cancelled = true;
      unlistenEvent?.();
      unlistenClosed?.();
      void invoke("task_unsubscribe", { taskId }).catch(() => {});
    };
  }, [taskId, onEvent, onReconnect, onSnapshot]);
}
