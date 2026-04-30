import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { TaskDetail as TaskDetailType, TaskTurn } from "@tessera/contracts";
import { ArrowUp, FileText, Loader2 } from "lucide-react";
import { useState } from "react";

interface TaskDetailProps {
  creatingTask: boolean;
  loading: boolean;
  onCreateTask: (initialInstruction: string) => Promise<void>;
  onCreateTurn: (content: string) => Promise<void>;
  sendingTurn: boolean;
  task: TaskDetailType | null;
  workspaceRoot: string | null;
}

function turnLabel(turn: TaskTurn) {
  if (turn.role === "agent") return "Tessera";
  if (turn.role === "system") return "System";
  return "You";
}

export function TaskDetail({
  creatingTask,
  loading,
  onCreateTask,
  onCreateTurn,
  sendingTurn,
  task,
  workspaceRoot,
}: TaskDetailProps) {
  const [content, setContent] = useState("");
  const isBusy = sendingTurn || creatingTask;
  const canSend = Boolean(content.trim() && !isBusy && (task || workspaceRoot));

  async function handleSend() {
    if (!canSend) return;
    if (task) {
      await onCreateTurn(content.trim());
    } else {
      await onCreateTask(content.trim());
    }
    setContent("");
  }

  if (loading) {
    return (
      <main className="flex-1 flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 size={18} className="mr-2 animate-spin" />
        Loading task...
      </main>
    );
  }

  if (!task) {
    return (
      <main className="flex-1 flex flex-col bg-background relative">
        <div className="flex flex-1 items-center justify-center px-6 pb-28">
          <div className="max-w-xl text-center">
            <h1 className="text-xl font-semibold text-foreground">
              {workspaceRoot
                ? "What should Tessera work on?"
                : "Select a workspace to start a task"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {workspaceRoot
                ? "Describe the outcome you want. Tessera will create a task, keep the conversation, and attach artifacts here."
                : "Tasks are workspace-scoped so outputs and history stay tied to the right files."}
            </p>
          </div>
        </div>
        <TaskComposer
          disabled={!workspaceRoot}
          busy={creatingTask}
          placeholder={workspaceRoot ? "Ask Tessera to work on..." : "Select a workspace first"}
          value={content}
          onChange={setContent}
          onSend={handleSend}
        />
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col bg-background relative">
      <div className="h-16 border-b border-border flex items-center justify-between px-6 shrink-0">
        <div>
          <h1 className="font-semibold text-sm leading-tight text-foreground">{task.title}</h1>
          <span className="text-xs text-muted-foreground">
            {task.status} • {task.agentLabel ?? "Tessera"}
          </span>
        </div>
      </div>

      <ScrollArea className="flex-1 pb-28">
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          <section className="space-y-4">
            {task.turns.map((turn) => (
              <div
                key={turn.id}
                className={cn("flex gap-4", turn.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[78%] rounded-2xl border p-4 shadow-sm",
                    turn.role === "user"
                      ? "rounded-tr-sm bg-[#2a2826] text-white border-[#2a2826]"
                      : "rounded-tl-sm bg-background text-foreground border-border"
                  )}
                >
                  <div
                    className={cn(
                      "mb-1 text-xs font-medium",
                      turn.role === "user" ? "text-white/70" : "text-muted-foreground"
                    )}
                  >
                    {turnLabel(turn)} • {turn.status}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-6">{turn.content}</div>
                  {turn.error && <div className="mt-2 text-xs text-destructive">{turn.error}</div>}
                </div>
              </div>
            ))}
          </section>

          {task.artifacts.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                Artifacts
              </h2>
              {task.artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className="rounded-xl border border-border bg-background p-4 shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FileText size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {artifact.title}
                      </div>
                      <div className="text-xs text-muted-foreground">{artifact.kind}</div>
                    </div>
                  </div>
                  {artifact.contentPreview && (
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      {artifact.contentPreview}
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </ScrollArea>

      <TaskComposer
        disabled={false}
        busy={sendingTurn}
        placeholder="Continue this task..."
        value={content}
        onChange={setContent}
        onSend={handleSend}
      />
    </main>
  );
}

function TaskComposer({
  busy,
  disabled,
  onChange,
  onSend,
  placeholder,
  value,
}: {
  busy: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  value: string;
}) {
  const canSend = Boolean(value.trim() && !busy && !disabled);

  return (
    <div className="absolute bottom-6 left-1/2 w-full max-w-2xl -translate-x-1/2 px-4">
      <div className="flex min-h-14 items-end rounded-2xl border border-border bg-background p-2 pl-4 shadow-lg">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={2}
          disabled={disabled || busy}
          className="max-h-32 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="button"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-full"
          disabled={!canSend}
          onClick={onSend}
        >
          {busy ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </Button>
      </div>
    </div>
  );
}
