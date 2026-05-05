import { TaskList, type TaskListView } from "@/components/TaskList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { Button } from "@/components/ui/button";
import type { TaskSummary } from "@tessera/contracts";
import { Plus } from "lucide-react";

interface SidebarProps {
  error: string | null;
  loadingTasks: boolean;
  onArchiveToggle: (task: TaskSummary, archived: boolean) => void;
  onNewTask: () => void;
  onRetryTasks: () => void;
  onSelectTask: (taskId: string) => void;
  onTaskListViewChange: (view: TaskListView) => void;
  onWorkspaceSelect: (path: string) => void;
  selectedTaskId: string | null;
  tasks: TaskSummary[];
  taskListView: TaskListView;
  workspaceRoot: string | null;
}

export function Sidebar({
  error,
  loadingTasks,
  onArchiveToggle,
  onNewTask,
  onRetryTasks,
  onSelectTask,
  onTaskListViewChange,
  onWorkspaceSelect,
  selectedTaskId,
  tasks,
  taskListView,
  workspaceRoot,
}: SidebarProps) {
  return (
    <aside className="w-64 flex-shrink-0 bg-secondary flex flex-col border-r border-border">
      <WorkspacePicker currentWorkspace={workspaceRoot} onWorkspaceSelect={onWorkspaceSelect} />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
            Tasks
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-full px-2 text-[11px]"
            onClick={onNewTask}
            disabled={!workspaceRoot}
          >
            <Plus size={12} />
            New task
          </Button>
        </div>
        <TaskList
          error={error}
          loading={loadingTasks}
          onArchiveToggle={onArchiveToggle}
          onRetry={onRetryTasks}
          onSelectTask={onSelectTask}
          onViewChange={onTaskListViewChange}
          selectedTaskId={selectedTaskId}
          tasks={tasks}
          view={taskListView}
          workspaceRoot={workspaceRoot}
        />
      </div>
    </aside>
  );
}
