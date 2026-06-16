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
    let reconnectAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let unlistenEvent: UnlistenFn | undefined;
    let unlistenClosed: UnlistenFn | undefined;

    const clearRetryTimer = () => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const subscribe = async () => {
      try {
        await invoke("task_subscribe", { taskId });
        const snapshot = await invoke<TaskDetail>("task_get", { taskId });
        if (cancelled) return;
        reconnectAttempt = 0;
        onSnapshot?.(snapshot);
      } catch {
        if (!cancelled) scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      clearRetryTimer();
      const delays = [250, 750, 1500, 3000, 5000];
      const delay = delays[Math.min(reconnectAttempt, delays.length - 1)] ?? 5000;
      reconnectAttempt += 1;
      retryTimer = setTimeout(() => {
        if (!cancelled) void subscribe();
      }, delay);
    };

    void (async () => {
      unlistenEvent = await listen<string>(`task:event:${taskId}`, (msg) => {
        const parsed = TaskEventSchema.safeParse(JSON.parse(msg.payload));
        if (parsed.success) onEvent(parsed.data);
      });
      unlistenClosed = await listen(`task:event:${taskId}:closed`, () => {
        if (!cancelled) {
          onReconnect?.();
          scheduleReconnect();
        }
      });
      if (cancelled) {
        unlistenEvent?.();
        unlistenClosed?.();
        return;
      }
      await subscribe();
    })();

    return () => {
      cancelled = true;
      clearRetryTimer();
      unlistenEvent?.();
      unlistenClosed?.();
      void invoke("task_unsubscribe", { taskId }).catch(() => {});
    };
  }, [taskId, onEvent, onReconnect, onSnapshot]);
}
