import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentProfile,
  AgentProfileListResult,
  TaskDetail as TaskDetailType,
  TaskTurn,
} from "@tessera/contracts";
import { ArrowUp, Bot, ChevronDown, FileText, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface TaskDetailProps {
  creatingTask: boolean;
  loading: boolean;
  onCreateTask: (initialInstruction: string, agentId: string, agentLabel: string) => Promise<void>;
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

  async function handleSend(agentId?: string, agentLabel?: string) {
    if (!canSend) return;
    if (task) {
      await onCreateTurn(content.trim());
    } else {
      await onCreateTask(content.trim(), agentId || "default", agentLabel || "Tessera");
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
                ? "Describe your objective. Tessera will execute the work, maintain the conversation history, and organize all generated artifacts within this task."
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
          showAgentSelector={true}
        />
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col bg-background relative">
      <div className="h-16 border-b border-border flex items-center justify-between px-6 shrink-0">
        <div>
          <h1 className="font-semibold text-sm leading-tight text-foreground">{task.title}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground capitalize">
              {task.status}
            </span>
            <AgentInfoPopover agentLabel={task.agentLabel ?? "Tessera"} agentId={task.agentId} />
          </div>
        </div>
      </div>

      {task.status === "waiting" && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-3 flex items-start gap-3 text-amber-600 dark:text-amber-400">
          <div className="shrink-0 mt-0.5">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-labelledby="task-waiting-icon-title"
            >
              <title id="task-waiting-icon-title">Authorization required</title>
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <div className="text-sm">
            <span className="font-semibold block mb-0.5">Waiting for authorization</span>
            Tessera has reached a workspace boundary. Provide guidance or approve the action in the
            chat to unblock the agent.
          </div>
        </div>
      )}

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
        showAgentSelector={false}
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
  showAgentSelector,
}: {
  busy: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSend: (agentId?: string, agentLabel?: string) => void;
  placeholder: string;
  value: string;
  showAgentSelector?: boolean;
}) {
  const canSend = Boolean(value.trim() && !busy && !disabled);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("default");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showAgentSelector) {
      invoke<AgentProfileListResult>("agent_profile_list")
        .then((res) => setAgents(res.profiles))
        .catch(console.error);
    }
  }, [showAgentSelector]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setPopoverOpen(false);
      }
    }
    if (popoverOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [popoverOpen]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const selectedLabel = selectedAgent?.name || "Tessera";

  return (
    <div className="absolute bottom-6 left-1/2 w-full max-w-2xl -translate-x-1/2 px-4">
      <div className="flex flex-col rounded-2xl border border-border bg-background shadow-lg overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 transition-shadow">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={2}
          disabled={disabled || busy}
          className="max-h-32 min-h-14 w-full resize-none bg-transparent p-4 text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="pl-2 flex items-center h-8 relative" ref={popoverRef}>
            {showAgentSelector && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs px-2 py-0 text-muted-foreground hover:text-foreground hover:bg-secondary"
                  onClick={() => setPopoverOpen(!popoverOpen)}
                >
                  <Bot size={14} className="mr-1.5" />
                  {selectedLabel}
                  <ChevronDown size={12} className="ml-1 opacity-50" />
                </Button>

                {popoverOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none z-50 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95">
                    <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Agents
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedAgentId("default");
                        setPopoverOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-2 py-1.5 text-sm rounded-sm flex items-center justify-between",
                        selectedAgentId === "default"
                          ? "bg-secondary text-foreground"
                          : "hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <span>Tessera</span>
                      {selectedAgentId === "default" && (
                        <span className="text-xs bg-background rounded px-1 border border-border">
                          Default
                        </span>
                      )}
                    </button>
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => {
                          setSelectedAgentId(agent.id);
                          setPopoverOpen(false);
                        }}
                        className={cn(
                          "w-full text-left px-2 py-1.5 text-sm rounded-sm flex items-center justify-between",
                          selectedAgentId === agent.id
                            ? "bg-secondary text-foreground"
                            : "hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <span className="truncate">{agent.name}</span>
                        {selectedAgentId === agent.id && (
                          <span className="text-xs bg-background rounded px-1 border border-border shrink-0">
                            Selected
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <Button
            type="button"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={!canSend}
            onClick={() => onSend(selectedAgentId, selectedLabel)}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AgentInfoPopover({ agentLabel, agentId }: { agentLabel: string; agentId: string }) {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (agentId !== "default") {
      invoke<AgentProfile>("agent_profile_get", { id: agentId })
        .then(setProfile)
        .catch(() => {}); // ignore errors, might have been deleted
    }
  }, [agentId]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        className="text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-foreground hover:bg-secondary/80 flex items-center gap-1 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <Bot size={12} />
        {agentLabel}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 w-80 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none z-50 animate-in fade-in-0 zoom-in-95">
          <div className="flex items-center gap-2 mb-2">
            <Bot size={16} className="text-primary" />
            <h4 className="font-semibold text-sm leading-none">{agentLabel}</h4>
          </div>
          {agentId === "default" ? (
            <p className="text-sm text-muted-foreground mt-2">
              The default Tessera workspace agent. Capable of reading, writing, and executing code
              in your workspace.
            </p>
          ) : profile ? (
            <div className="space-y-3 mt-3">
              {profile.description && (
                <p className="text-sm text-muted-foreground">{profile.description}</p>
              )}
              {profile.instructions && (
                <div>
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wider block mb-1">
                    Instructions
                  </span>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {profile.instructions}
                  </p>
                </div>
              )}
              {profile.skills.length > 0 && (
                <div>
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wider block mb-1">
                    Skills
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {profile.skills.map((skill) => (
                      <span
                        key={skill}
                        className="px-1.5 py-0.5 bg-secondary text-secondary-foreground text-[10px] rounded"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-2 italic">Agent profile not found.</p>
          )}
        </div>
      )}
    </div>
  );
}
