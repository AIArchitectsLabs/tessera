import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { TaskSummary } from "@tessera/contracts";
import { CheckCircle2, Loader2, Plus, RotateCw } from "lucide-react";
import { useState } from "react";

interface TaskListProps {
  creating: boolean;
  error: string | null;
  loading: boolean;
  onCreateTask: (input: { title: string; initialInstruction: string }) => Promise<void>;
  onRetry: () => void;
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string | null;
  tasks: TaskSummary[];
  workspaceRoot: string | null;
}

function formatStatus(status: TaskSummary["status"]) {
  if (status === "done") return "Done";
  if (status === "failed") return "Failed";
  if (status === "waiting") return "Waiting";
  return "Active";
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TaskList({
  creating,
  error,
  loading,
  onCreateTask,
  onRetry,
  onSelectTask,
  selectedTaskId,
  tasks,
  workspaceRoot,
}: TaskListProps) {
  const [title, setTitle] = useState("");
  const [initialInstruction, setInitialInstruction] = useState("");

  const disabled = !workspaceRoot;
  const canCreate = Boolean(title.trim() && initialInstruction.trim() && !creating && !disabled);

  async function handleCreateTask() {
    if (!canCreate) return;
    await onCreateTask({
      title: title.trim(),
      initialInstruction: initialInstruction.trim(),
    });
    setTitle("");
    setInitialInstruction("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 mb-4 mt-2 space-y-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={disabled || creating}
          placeholder="Task title"
          className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <textarea
          value={initialInstruction}
          onChange={(event) => setInitialInstruction(event.target.value)}
          disabled={disabled || creating}
          placeholder="Initial instruction"
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="button"
          className="w-full bg-[#2a2826] hover:bg-[#1a1918] text-white rounded-full h-10"
          disabled={!canCreate}
          onClick={handleCreateTask}
        >
          {creating ? (
            <Loader2 size={16} className="mr-2 animate-spin" />
          ) : (
            <Plus size={16} className="mr-2" />
          )}
          New task
        </Button>
      </div>

      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-4 py-2">
        Tasks
      </div>

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

      {workspaceRoot && !loading && !error && tasks.length === 0 && (
        <div className="mx-4 mt-2 rounded-lg border border-dashed border-border bg-background/60 p-4 text-center text-sm text-muted-foreground">
          No tasks in this workspace yet.
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-2 py-2">
          {tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              onClick={() => onSelectTask(task.id)}
              className={cn(
                "w-full rounded-lg px-3 py-2 text-left transition-colors",
                selectedTaskId === task.id ? "bg-background shadow-sm" : "hover:bg-black/5"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatUpdatedAt(task.updatedAt)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 size={12} />
                <span>{formatStatus(task.status)}</span>
                {task.agentLabel && <span>• {task.agentLabel}</span>}
              </div>
              {task.latestActivity && (
                <div className="mt-1 truncate text-xs text-muted-foreground/80">
                  {task.latestActivity}
                </div>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
