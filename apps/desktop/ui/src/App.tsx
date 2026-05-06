import { invoke } from "@tauri-apps/api/core";
import type {
  ClarifyResponse,
  InboxListResult,
  InboxMessage,
  InboxStatus,
  TaskCreateRequest,
  TaskCreateTurnRequest,
  TaskDetail,
  TaskEvent,
  TaskListResult,
  TaskSummary,
  TaskUpdateRequest,
  TodoOperation,
} from "@tessera/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { InboxView } from "@/components/InboxView";
import { type AppView, RailNav } from "@/components/RailNav";
import { SettingsView } from "@/components/SettingsView";
import { Sidebar } from "@/components/Sidebar";
import { TaskDetail as TaskDetailView } from "@/components/TaskDetail";
import type { TaskListView } from "@/components/TaskList";
import { applyTaskEvent } from "./lib/applyTaskEvent";
import { mergeTaskDetail } from "./lib/taskDetails";
import { mergeTaskSummary, summaryFromDetail } from "./lib/taskSummaries";
import { useTaskEvents } from "./lib/useTaskEvents";

const WORKSPACE_STORAGE_KEY = "tessera_workspace_root";

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY);
  });
  const [activeView, setActiveView] = useState<AppView>("tasks");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskListView, setTaskListView] = useState<TaskListView>("active");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [taskListError, setTaskListError] = useState<string | null>(null);
  const [taskDetailError, setTaskDetailError] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingTaskDetail, setLoadingTaskDetail] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [sendingTurn, setSendingTurn] = useState(false);
  const [inboxStatus, setInboxStatus] = useState<InboxStatus>("open");
  const [inboxMessages, setInboxMessages] = useState<InboxMessage[]>([]);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const taskDetailRequestId = useRef(0);
  const reconnectAttemptsRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref to selectedTaskId so stable callbacks can read the latest value
  // without becoming a dependency that causes effect re-runs.
  const selectedTaskIdRef = useRef<string | null>(null);
  selectedTaskIdRef.current = selectedTaskId;

  const handleWorkspaceSelect = (path: string) => {
    setWorkspaceRoot(path);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, path);
    setTaskListView("active");
    setSelectedTaskId(null);
    setSelectedTask(null);
    setSelectedInboxId(null);
  };

  const loadTasks = useCallback(async () => {
    if (!workspaceRoot) {
      setTasks([]);
      setTaskListError(null);
      return;
    }

    setLoadingTasks(true);
    setTaskListError(null);
    try {
      const res = await invoke<TaskListResult>("task_list", { workspaceRoot });
      setTasks(res.tasks);
      // Read the current value from the ref so this callback doesn't need
      // selectedTaskId as a dependency (which would cause spurious re-runs).
      const currentTaskId = selectedTaskIdRef.current;
      if (currentTaskId && !res.tasks.some((task) => task.id === currentTaskId)) {
        setSelectedTaskId(null);
        setSelectedTask(null);
      }
    } catch (error) {
      setTaskListError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTasks(false);
    }
  }, [workspaceRoot]);

  const loadInbox = useCallback(async () => {
    setLoadingInbox(true);
    setInboxError(null);
    try {
      const result = await invoke<InboxListResult>("inbox_list", {
        status: inboxStatus,
        workspaceRoot: workspaceRoot ?? undefined,
      });
      setInboxMessages(result.messages);
      setSelectedInboxId((current) => {
        if (current && result.messages.some((message) => message.id === current)) return current;
        return result.messages[0]?.id ?? null;
      });
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingInbox(false);
    }
  }, [inboxStatus, workspaceRoot]);

  const loadTaskDetail = useCallback(async (taskId: string, options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    const requestId = ++taskDetailRequestId.current;
    if (!background) {
      setLoadingTaskDetail(true);
      setTaskDetailError(null);
    }
    try {
      const task = await invoke<TaskDetail>("task_get", { taskId });
      if (taskDetailRequestId.current !== requestId) return;
      setSelectedTask((current) =>
        current && current.id === task.id ? mergeTaskDetail(current, task) : task
      );
    } catch (error) {
      if (taskDetailRequestId.current !== requestId) return;
      setTaskDetailError(error instanceof Error ? error.message : String(error));
      if (!background) {
        setSelectedTask(null);
      }
    } finally {
      if (!background && taskDetailRequestId.current === requestId) {
        setLoadingTaskDetail(false);
      }
    }
  }, []);

  const handleEvent = useCallback((event: TaskEvent) => {
    setSelectedTask((current) => (current ? applyTaskEvent(current, event) : current));
    if (event.type === "task.updated") {
      setTasks((current) => mergeTaskSummary(current, event.task));
    }
  }, []);

  const handleSnapshot = useCallback((task: TaskDetail) => {
    setSelectedTask((current) =>
      current && current.id === task.id ? mergeTaskDetail(current, task) : task
    );
    setTasks((current) => mergeTaskSummary(current, summaryFromDetail(task)));
  }, []);

  // Stable callback — reads selectedTaskId and loadTaskDetail from refs so the
  // useTaskEvents subscription is not torn down every time selectedTaskId changes.
  const loadTaskDetailRef = useRef(loadTaskDetail);
  loadTaskDetailRef.current = loadTaskDetail;

  const handleReconnect = useCallback(() => {
    const attempt = reconnectAttemptsRef.current;
    if (attempt >= 3) {
      reconnectAttemptsRef.current = 0;
      setTaskDetailError("Connection to task updates lost. Refresh to retry.");
      return;
    }
    reconnectAttemptsRef.current = attempt + 1;
    const delays = [250, 750, 2250];
    retryTimerRef.current = setTimeout(async () => {
      const taskId = selectedTaskIdRef.current;
      if (taskId) {
        await loadTaskDetailRef.current(taskId, { background: true });
      }
    }, delays[attempt] ?? 250);
  }, []);

  useTaskEvents({
    taskId: selectedTaskId,
    onEvent: handleEvent,
    onSnapshot: handleSnapshot,
    onReconnect: handleReconnect,
  });

  const handleNewTask = () => {
    taskDetailRequestId.current += 1;
    setSelectedTaskId(null);
    setSelectedTask(null);
    setTaskDetailError(null);
    setSendingTurn(false);
    setTaskListView("active");
  };

  const handleLogout = () => {
    // Login/logout will be implemented separately. This intentionally does nothing.
  };

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (activeView === "inbox") {
      void loadInbox();
    }
  }, [activeView, loadInbox]);

  useEffect(() => {
    if (selectedTaskId) {
      void loadTaskDetail(selectedTaskId);
    }
  }, [loadTaskDetail, selectedTaskId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: writing to a ref, selectedTaskId is the trigger
  useEffect(() => {
    reconnectAttemptsRef.current = 0;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [selectedTaskId]);

  async function handleCreateTask(initialInstruction: string, agentId: string, agentLabel: string) {
    if (!workspaceRoot) return;

    setCreatingTask(true);
    setTaskListError(null);
    try {
      const request: TaskCreateRequest = {
        workspaceRoot,
        initialInstruction,
        agentId,
        agentLabel,
      };
      const task = await invoke<TaskDetail>("task_create", { request });
      setSelectedTaskId(task.id);
      setSelectedTask(task);
      setTasks((current) => mergeTaskSummary(current, summaryFromDetail(task)));
    } catch (error) {
      setTaskListError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setCreatingTask(false);
    }
  }

  async function handleCreateTurn(content: string) {
    if (!selectedTaskId) return;

    setSendingTurn(true);
    setTaskDetailError(null);
    try {
      const request: TaskCreateTurnRequest = {
        content,
        agentId: selectedTask?.agentId ?? "default",
      };
      const task = await invoke<TaskDetail>("task_create_turn", {
        taskId: selectedTaskId,
        request,
      });
      setSelectedTask((current) => (current ? mergeTaskDetail(current, task) : task));
      setTasks((current) => mergeTaskSummary(current, summaryFromDetail(task)));
    } catch (error) {
      setTaskDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingTurn(false);
    }
  }

  async function handleTodoUpdate(operation: TodoOperation) {
    if (!selectedTaskId) return;

    const task = await invoke<TaskDetail>("task_todo_apply", {
      taskId: selectedTaskId,
      request: operation,
    });
    setSelectedTask((current) => (current ? mergeTaskDetail(current, task) : task));
    setTasks((current) => mergeTaskSummary(current, summaryFromDetail(task)));
  }

  async function handleClarifyResolve(response: ClarifyResponse) {
    if (!selectedTaskId) return;

    const task = await invoke<TaskDetail>("task_clarify_resolve", {
      taskId: selectedTaskId,
      request: response,
    });
    setSelectedTask((current) => (current ? mergeTaskDetail(current, task) : task));
    setTasks((current) => mergeTaskSummary(current, summaryFromDetail(task)));
  }

  async function handleSkillRemove(skillId: string) {
    if (!selectedTaskId) return;

    const task = await invoke<TaskDetail>("task_skill_remove", {
      taskId: selectedTaskId,
      skillId,
    });
    setSelectedTask((current) => (current ? mergeTaskDetail(current, task) : task));
    setTasks((current) => mergeTaskSummary(current, summaryFromDetail(task)));
  }

  async function handleArchiveToggle(task: TaskSummary, archived: boolean) {
    setTaskListError(null);
    try {
      const request: TaskUpdateRequest = { archived };
      const updatedTask = await invoke<TaskDetail>("task_update", {
        taskId: task.id,
        request,
      });
      setSelectedTask((current) =>
        current && current.id === updatedTask.id ? mergeTaskDetail(current, updatedTask) : current
      );
      setTasks((current) => mergeTaskSummary(current, summaryFromDetail(updatedTask)));
      setTaskListView(archived ? "archived" : "active");
    } catch (error) {
      setTaskListError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleInboxResolve(message: InboxMessage, actionId: string) {
    try {
      const updated = await invoke<InboxMessage>("inbox_resolve", {
        messageId: message.id,
        request: { actionId },
      });
      setInboxMessages((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      );
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleInboxSnooze(message: InboxMessage) {
    const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      const updated = await invoke<InboxMessage>("inbox_snooze", {
        messageId: message.id,
        request: { snoozedUntil },
      });
      setInboxMessages((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      );
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error));
    }
  }

  const selectedInboxMessage =
    inboxMessages.find((message) => message.id === selectedInboxId) ?? null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      <RailNav
        activeView={activeView}
        onLogout={handleLogout}
        onOpenSettings={() => setSettingsOpen(true)}
        onViewChange={setActiveView}
      />
      {settingsOpen ? (
        <SettingsView onClose={() => setSettingsOpen(false)} />
      ) : activeView === "inbox" ? (
        <InboxView
          error={inboxError}
          loading={loadingInbox}
          messages={inboxMessages}
          onRefresh={loadInbox}
          onResolve={handleInboxResolve}
          onSelectMessage={setSelectedInboxId}
          onSnooze={handleInboxSnooze}
          onStatusChange={setInboxStatus}
          selectedMessage={selectedInboxMessage}
          status={inboxStatus}
          workspaceRoot={workspaceRoot}
        />
      ) : (
        <>
          <Sidebar
            error={taskListError}
            loadingTasks={loadingTasks}
            onArchiveToggle={handleArchiveToggle}
            onNewTask={handleNewTask}
            onRetryTasks={loadTasks}
            onSelectTask={setSelectedTaskId}
            onTaskListViewChange={setTaskListView}
            onWorkspaceSelect={handleWorkspaceSelect}
            selectedTaskId={selectedTaskId}
            tasks={tasks}
            taskListView={taskListView}
            workspaceRoot={workspaceRoot}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            {taskDetailError && (
              <div className="border-b border-destructive/20 bg-destructive/5 px-6 py-2 text-sm text-destructive">
                {taskDetailError}
              </div>
            )}
            <TaskDetailView
              onClarifyResolve={handleClarifyResolve}
              creatingTask={creatingTask}
              loading={loadingTaskDetail && (!selectedTask || selectedTask.id !== selectedTaskId)}
              onCreateTask={handleCreateTask}
              onCreateTurn={handleCreateTurn}
              onSelectTask={setSelectedTaskId}
              onSkillRemove={handleSkillRemove}
              onTodoUpdate={handleTodoUpdate}
              sendingTurn={sendingTurn}
              task={selectedTask}
              tasks={tasks}
              workspaceRoot={workspaceRoot}
            />
          </div>
        </>
      )}
    </div>
  );
}
