import { invoke } from "@tauri-apps/api/core";
import type {
  TaskCreateRequest,
  TaskCreateTurnRequest,
  TaskDetail,
  TaskEvent,
  TaskListResult,
  TaskSummary,
} from "@tessera/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { RailNav, type SidebarMode } from "@/components/RailNav";
import { SettingsView } from "@/components/SettingsView";
import { Sidebar } from "@/components/Sidebar";
import { TaskDetail as TaskDetailView } from "@/components/TaskDetail";
import { applyTaskEvent } from "./lib/applyTaskEvent";
import { useTaskEvents } from "./lib/useTaskEvents";

const WORKSPACE_STORAGE_KEY = "tessera_workspace_root";

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY);
  });
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("files");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [taskListError, setTaskListError] = useState<string | null>(null);
  const [taskDetailError, setTaskDetailError] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingTaskDetail, setLoadingTaskDetail] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [sendingTurn, setSendingTurn] = useState(false);
  const taskDetailRequestId = useRef(0);
  const reconnectAttemptsRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleWorkspaceSelect = (path: string) => {
    setWorkspaceRoot(path);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, path);
    setSelectedTaskId(null);
    setSelectedTask(null);
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
      if (selectedTaskId && !res.tasks.some((task) => task.id === selectedTaskId)) {
        setSelectedTaskId(null);
        setSelectedTask(null);
      }
    } catch (error) {
      setTaskListError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTasks(false);
    }
  }, [selectedTaskId, workspaceRoot]);

  const loadTaskDetail = useCallback(async (taskId: string) => {
    const requestId = ++taskDetailRequestId.current;
    setLoadingTaskDetail(true);
    setTaskDetailError(null);
    try {
      const task = await invoke<TaskDetail>("task_get", { taskId });
      if (taskDetailRequestId.current !== requestId) return;
      setSelectedTask(task);
    } catch (error) {
      if (taskDetailRequestId.current !== requestId) return;
      setTaskDetailError(error instanceof Error ? error.message : String(error));
      setSelectedTask(null);
    } finally {
      if (taskDetailRequestId.current === requestId) {
        setLoadingTaskDetail(false);
      }
    }
  }, []);

  const handleEvent = useCallback((event: TaskEvent) => {
    setSelectedTask((current) => (current ? applyTaskEvent(current, event) : current));
  }, []);

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
      if (selectedTaskId) {
        await loadTaskDetail(selectedTaskId);
      }
    }, delays[attempt] ?? 250);
  }, [selectedTaskId, loadTaskDetail]);

  useTaskEvents({
    taskId: selectedTaskId,
    onEvent: handleEvent,
    onReconnect: handleReconnect,
  });

  const handleNewTask = () => {
    taskDetailRequestId.current += 1;
    setSelectedTaskId(null);
    setSelectedTask(null);
    setTaskDetailError(null);
    setSendingTurn(false);
  };

  const handleLogout = () => {
    // Login/logout will be implemented separately. This intentionally does nothing.
  };

  useEffect(() => {
    if (sidebarMode === "tasks") {
      void loadTasks();
    }
  }, [loadTasks, sidebarMode]);

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

  async function handleCreateTask(initialInstruction: string) {
    if (!workspaceRoot) return;

    setCreatingTask(true);
    setTaskListError(null);
    try {
      const request: TaskCreateRequest = {
        workspaceRoot,
        initialInstruction,
        agentId: "default",
        agentLabel: "Tessera",
      };
      const task = await invoke<TaskDetail>("task_create", { request });
      setSelectedTaskId(task.id);
      setSelectedTask(task);
      await loadTasks();
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
      const request: TaskCreateTurnRequest = { content, agentId: "default" };
      const task = await invoke<TaskDetail>("task_create_turn", {
        taskId: selectedTaskId,
        request,
      });
      setSelectedTask(task);
      await loadTasks();
    } catch (error) {
      setTaskDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingTurn(false);
    }
  }

  const mainPane =
    sidebarMode === "tasks" ? (
      <div className="flex min-w-0 flex-1 flex-col">
        {taskDetailError && (
          <div className="border-b border-destructive/20 bg-destructive/5 px-6 py-2 text-sm text-destructive">
            {taskDetailError}
          </div>
        )}
        <TaskDetailView
          creatingTask={creatingTask}
          loading={loadingTaskDetail}
          onCreateTask={handleCreateTask}
          onCreateTurn={handleCreateTurn}
          sendingTurn={sendingTurn}
          task={selectedTask}
          workspaceRoot={workspaceRoot}
        />
      </div>
    ) : (
      <main className="flex-1 flex items-center justify-center bg-background">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-foreground">Workspace files</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select a workspace to browse files, or open Tasks from the rail to work with task
            history.
          </p>
        </div>
      </main>
    );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      <RailNav
        mode={sidebarMode}
        onLogout={handleLogout}
        onModeChange={setSidebarMode}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen ? (
        <SettingsView onClose={() => setSettingsOpen(false)} />
      ) : (
        <>
          <Sidebar
            error={taskListError}
            loadingTasks={loadingTasks}
            mode={sidebarMode}
            onNewTask={handleNewTask}
            onRetryTasks={loadTasks}
            onSelectTask={setSelectedTaskId}
            onWorkspaceSelect={handleWorkspaceSelect}
            selectedTaskId={selectedTaskId}
            tasks={tasks}
            workspaceRoot={workspaceRoot}
          />
          {mainPane}
        </>
      )}
    </div>
  );
}
