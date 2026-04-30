import { FileExplorer } from "@/components/FileExplorer";
import type { SidebarMode } from "@/components/RailNav";
import { TaskList } from "@/components/TaskList";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TaskSummary } from "@tessera/contracts";

interface SidebarProps {
  creatingTask: boolean;
  error: string | null;
  loadingTasks: boolean;
  mode: SidebarMode;
  onCreateTask: (input: { title: string; initialInstruction: string }) => Promise<void>;
  onRetryTasks: () => void;
  onSelectTask: (taskId: string) => void;
  onWorkspaceSelect: (path: string) => void;
  selectedTaskId: string | null;
  tasks: TaskSummary[];
  workspaceRoot: string | null;
}

export function Sidebar({
  creatingTask,
  error,
  loadingTasks,
  mode,
  onCreateTask,
  onRetryTasks,
  onSelectTask,
  onWorkspaceSelect,
  selectedTaskId,
  tasks,
  workspaceRoot,
}: SidebarProps) {
  return (
    <aside className="w-64 flex-shrink-0 bg-secondary flex flex-col border-r border-border">
      <WorkspacePicker currentWorkspace={workspaceRoot} onWorkspaceSelect={onWorkspaceSelect} />

      {mode === "files" ? (
        <>
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-4 py-2">
            Files
          </div>
          <ScrollArea className="flex-1">
            <FileExplorer workspaceRoot={workspaceRoot || ""} />
          </ScrollArea>
        </>
      ) : (
        <TaskList
          creating={creatingTask}
          error={error}
          loading={loadingTasks}
          onCreateTask={onCreateTask}
          onRetry={onRetryTasks}
          onSelectTask={onSelectTask}
          selectedTaskId={selectedTaskId}
          tasks={tasks}
          workspaceRoot={workspaceRoot}
        />
      )}
    </aside>
  );
}
