import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { TaskDetail as TaskDetailType, TaskTurn } from "@tessera/contracts";
import { ArrowUp, FileText, Loader2 } from "lucide-react";
import { useState } from "react";

interface TaskDetailProps {
  loading: boolean;
  onCreateTurn: (content: string) => Promise<void>;
  sendingTurn: boolean;
  task: TaskDetailType | null;
}

function turnLabel(turn: TaskTurn) {
  if (turn.role === "agent") return "Tessera";
  if (turn.role === "system") return "System";
  return "You";
}

export function TaskDetail({ loading, onCreateTurn, sendingTurn, task }: TaskDetailProps) {
  const [content, setContent] = useState("");
  const canSend = Boolean(task && content.trim() && !sendingTurn);

  async function handleSend() {
    if (!canSend) return;
    await onCreateTurn(content.trim());
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
      <main className="flex-1 flex items-center justify-center bg-background">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-foreground">Select or create a task</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Tasks keep workspace-scoped instructions, conversation turns, and produced artifacts
            together.
          </p>
        </div>
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

      <div className="absolute bottom-6 left-1/2 w-full max-w-2xl -translate-x-1/2 px-4">
        <div className="flex min-h-14 items-end rounded-2xl border border-border bg-background p-2 pl-4 shadow-lg">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Continue this task..."
            rows={2}
            className="max-h-32 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <Button
            type="button"
            size="icon"
            className="h-10 w-10 shrink-0 rounded-full"
            disabled={!canSend}
            onClick={handleSend}
          >
            {sendingTurn ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
          </Button>
        </div>
      </div>
    </main>
  );
}
