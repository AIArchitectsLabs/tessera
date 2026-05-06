import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { TaskSummary } from "@tessera/contracts";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Clock,
  Loader2,
  RotateCw,
  XCircle,
} from "lucide-react";

export type TaskListView = "active" | "archived";

interface TaskListProps {
  error: string | null;
  loading: boolean;
  onArchiveToggle: (task: TaskSummary, archived: boolean) => void;
  onRetry: () => void;
  onSelectTask: (taskId: string) => void;
  onViewChange: (view: TaskListView) => void;
  selectedTaskId: string | null;
  tasks: TaskSummary[];
  view: TaskListView;
  workspaceRoot: string | null;
}

function formatStatus(status: TaskSummary["status"]) {
  if (status === "done") return "Done";
  if (status === "failed") return "Failed";
  if (status === "waiting") return "Waiting for Input";
  return "In Progress";
}

function StatusIcon({ status }: { status: TaskSummary["status"] }) {
  if (status === "active") return <Loader2 size={12} className="animate-spin text-primary" />;
  if (status === "done") return <CheckCircle2 size={12} className="text-success" />;
  if (status === "waiting") return <Clock size={12} className="text-warning" />;
  if (status === "failed") return <XCircle size={12} className="text-destructive" />;
  return <CheckCircle2 size={12} />;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TaskList({
  error,
  loading,
  onArchiveToggle,
  onRetry,
  onSelectTask,
  onViewChange,
  selectedTaskId,
  tasks,
  view,
  workspaceRoot,
}: TaskListProps) {
  const visibleTasks = tasks.filter((task) =>
    view === "archived" ? Boolean(task.archivedAt) : !task.archivedAt
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!workspaceRoot && (
        <div className="mx-4 mt-2 rounded-lg border border-dashed border-border bg-background/60 p-4 text-center text-sm text-muted-foreground">
          Select a workspace before creating tasks.
        </div>
      )}

      {workspaceRoot && error && (
        <div className="mx-4 mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <div className="mb-2">{error}</div>
          <Button type="button" variant="outline" size="sm" onClick={onRetry} className="h-8 gap-2">
            <RotateCw size={14} />
            Retry
          </Button>
        </div>
      )}

      {workspaceRoot && loading && (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Loading tasks...
        </div>
      )}

      {workspaceRoot && !loading && !error && tasks.length > 0 && (
        <div className="px-3 pb-2">
          <div className="inline-flex rounded-lg bg-background/70 p-1">
            <button
              type="button"
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                view === "active"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => onViewChange("active")}
            >
              History
            </button>
            <button
              type="button"
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                view === "archived"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => onViewChange("archived")}
            >
              Archived
            </button>
          </div>
        </div>
      )}

      {workspaceRoot && !loading && !error && visibleTasks.length === 0 && (
        <div className="mx-4 mt-2 rounded-lg border border-dashed border-border bg-background/60 p-4 text-center text-sm text-muted-foreground">
          {view === "archived"
            ? "No archived tasks yet."
            : "No task history yet. Start from the composer in the main pane."}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-2 py-2">
          {visibleTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              view={view}
              selected={selectedTaskId === task.id}
              onSelectTask={onSelectTask}
              onArchiveToggle={onArchiveToggle}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

interface TaskRowProps {
  task: TaskSummary;
  view: TaskListView;
  selected: boolean;
  onSelectTask: (taskId: string) => void;
  onArchiveToggle: (task: TaskSummary, archived: boolean) => void;
}

function TaskRow({ task, view, selected, onSelectTask, onArchiveToggle }: TaskRowProps) {
  return (
    <div
      className={cn(
        "rounded-lg transition-colors hover:bg-black/5",
        selected ? "bg-accent shadow-sm" : ""
      )}
    >
      <div className="flex flex-col px-3 py-2">
        <button type="button" onClick={() => onSelectTask(task.id)} className="text-left">
          <span className={cn("block truncate text-sm font-medium transition-colors", selected ? "text-accent-foreground" : "text-foreground")}>{task.title}</span>
          <div className={cn("mt-1 flex items-center gap-2 text-xs transition-colors", selected ? "text-accent-foreground/80" : "text-muted-foreground")}>
            <StatusIcon status={task.status} />
            <span>{formatStatus(task.status)}</span>
            {task.agentLabel && <span>• {task.agentLabel}</span>}
          </div>
          {task.latestActivity && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
              {task.latestActivity}
            </div>
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 self-start h-6 -ml-2 gap-1 px-2 text-[11px] text-muted-foreground"
          aria-label={view === "active" ? "Archive task" : "Restore task"}
          onClick={(e) => {
            e.stopPropagation();
            onArchiveToggle(task, view === "active");
          }}
        >
          {view === "active" ? (
            <>
              <Archive size={11} /> Archive
            </>
          ) : (
            <>
              <ArchiveRestore size={11} /> Restore
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
