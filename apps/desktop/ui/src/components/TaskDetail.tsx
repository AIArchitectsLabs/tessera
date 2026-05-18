import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { readDir } from "@tauri-apps/plugin-fs";
import type {
  AgentProfile,
  AgentProfileListResult,
  ClarifyResponse,
  SkillListResult,
  SkillSummary,
  TaskArtifact,
  TaskDetail as TaskDetailType,
  TaskSkillActivation,
  TaskSummary,
  TaskTurn,
  TodoItemStatus,
  TodoOperation,
} from "@tessera/contracts";
import {
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  ListTodo,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface TaskDetailProps {
  creatingTask: boolean;
  loading: boolean;
  onClarifyResolve: (response: ClarifyResponse) => Promise<void>;
  onCreateTask: (initialInstruction: string, agentId: string, agentLabel: string) => Promise<void>;
  onCreateTurn: (content: string) => Promise<void>;
  onSelectTask: (taskId: string) => void;
  onSkillRemove: (skillId: string) => Promise<void>;
  onTodoUpdate: (operation: TodoOperation) => Promise<void>;
  sendingTurn: boolean;
  task: TaskDetailType | null;
  tasks: TaskSummary[];
  userKey: string;
  workspaceRoot: string | null;
}

function taskStatusLabel(status: string) {
  switch (status) {
    case "active":
      return "In Progress";
    case "done":
      return "Done";
    case "waiting":
      return "Waiting for Input";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function turnLabel(turn: TaskTurn) {
  if (turn.role === "agent") return "Tessera";
  if (turn.role === "system") return "System";
  return "You";
}

export function TaskDetail({
  creatingTask,
  loading,
  onClarifyResolve,
  onCreateTask,
  onCreateTurn,
  onSelectTask,
  onSkillRemove,
  onTodoUpdate,
  sendingTurn,
  task,
  tasks,
  userKey,
  workspaceRoot,
}: TaskDetailProps) {
  const [content, setContent] = useState("");
  const [artifactOpenError, setArtifactOpenError] = useState<string | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const isBusy = sendingTurn || creatingTask;
  const canSend = Boolean(content.trim() && !isBusy && (task || workspaceRoot));
  const taskId = task?.id;
  const turnCount = task?.turns.length ?? 0;
  const artifactCount = task?.artifacts.length ?? 0;
  const latestNotification = task?.notifications[task.notifications.length - 1];
  const lastTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    void turnCount;
    void artifactCount;
    const viewport = scrollAreaRef.current?.querySelector("[data-radix-scroll-area-viewport]");
    if (!(viewport instanceof HTMLDivElement)) return;
    const isNewTask = lastTaskIdRef.current !== taskId;
    lastTaskIdRef.current = taskId;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const shouldStickToBottom = isNewTask || distanceFromBottom < 96;
    if (!shouldStickToBottom) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [artifactCount, taskId, turnCount]);

  async function handleSend(agentId?: string, agentLabel?: string) {
    if (!canSend) return;
    if (task) {
      await onCreateTurn(content.trim());
    } else {
      await onCreateTask(content.trim(), agentId || "default", agentLabel || "Tessera");
    }
    setContent("");
  }

  async function handleArtifactOpen(artifact: TaskArtifact) {
    if (!task?.workspaceRoot || !artifact.path) return;
    setArtifactOpenError(null);
    try {
      await invoke("workspace_file_open", {
        workspaceRoot: task.workspaceRoot,
        path: artifact.path,
      });
    } catch (error) {
      setArtifactOpenError(error instanceof Error ? error.message : String(error));
    }
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
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-8">
          <div className="max-w-xl text-center mb-8">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Sparkles size={28} className="text-[var(--sun)]" />
            </div>
            <h1
              className="text-2xl font-bold text-foreground tracking-tight"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              {workspaceRoot
                ? "What are we working on today?"
                : "Select a workspace to start a task"}
            </h1>
            {workspaceRoot && (
              <p className="mt-2 text-sm text-muted-foreground">
                Give Tessera a business objective and it will plan, execute, and deliver — so you
                can focus on what matters.
              </p>
            )}
          </div>

          <div className="w-full max-w-2xl mb-10">
            <TaskComposer
              disabled={!workspaceRoot}
              busy={creatingTask}
              placeholder={workspaceRoot ? "How can I help you today?" : "Select a workspace first"}
              value={content}
              onChange={setContent}
              onSend={handleSend}
              showAgentSelector={true}
              userKey={userKey}
              workspaceRoot={workspaceRoot}
              inline
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col bg-background relative overflow-hidden">
      <div className="h-14 border-b border-border flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="font-semibold text-sm leading-tight text-foreground truncate">
            {task.title}
          </h1>
          <ChevronDown size={14} className="text-muted-foreground shrink-0" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground flex items-center gap-1">
            {task.status === "active" && <Loader2 size={10} className="animate-spin" />}
            {taskStatusLabel(task.status)}
          </span>
          <AgentInfoPopover
            agentLabel={task.agentLabel ?? "Tessera"}
            agentContext={task.agentContext}
          />
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

      {latestNotification && (
        <div className="border-b border-border bg-secondary/35 px-6 py-3">
          <div className="text-sm font-semibold text-foreground">{latestNotification.title}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{latestNotification.body}</div>
        </div>
      )}

      {artifactOpenError ? (
        <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700">
          {artifactOpenError}
        </div>
      ) : null}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          <ScrollArea ref={scrollAreaRef} className="flex-1">
            <div className="mx-auto max-w-3xl space-y-8 p-6">
              <section className="space-y-4">
                {task.turns.map((turn) => {
                  const isUser = turn.role === "user";
                  const isAgent = turn.role === "agent";
                  const turnArtifacts = task.artifacts.filter((a) => a.turnId === turn.id);
                  return (
                    <div
                      key={turn.id}
                      className={cn("flex gap-4 w-full", isUser ? "justify-end" : "justify-start")}
                    >
                      <div
                        className={cn(
                          isUser
                            ? "max-w-[78%] rounded-2xl rounded-tr-sm bg-[#2a2826] px-5 py-4 text-white shadow-sm border border-[#2a2826]"
                            : "w-full max-w-full text-foreground py-2"
                        )}
                      >
                        {isAgent && (
                          <TurnTimeline
                            artifacts={turnArtifacts}
                            isRunning={turn.status === "running"}
                            onArtifactOpen={handleArtifactOpen}
                          />
                        )}
                        {(!isAgent || turn.role === "system") && (
                          <div
                            className={cn(
                              "mb-1 text-xs font-medium flex items-center gap-1.5",
                              isUser ? "text-white/70" : "text-muted-foreground"
                            )}
                          >
                            {turnLabel(turn)}
                          </div>
                        )}
                        {turn.content && (
                          <div
                            className={cn(
                              "whitespace-pre-wrap text-sm leading-6",
                              isAgent &&
                                (turnArtifacts.length > 0 || turn.status === "running") &&
                                "mt-3"
                            )}
                          >
                            {turn.content}
                          </div>
                        )}
                        {turn.error && (
                          <div className="mt-2 text-xs text-destructive">{turn.error}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            </div>
          </ScrollArea>

          <TaskComposer
            disabled={false}
            busy={sendingTurn}
            placeholder="Write a message..."
            value={content}
            onChange={setContent}
            onSend={handleSend}
            agentId={task.agentId}
            userKey={userKey}
            workspaceRoot={task.workspaceRoot}
            showAgentSelector={false}
          />
        </div>

        {/* Right-side detail pane */}
        <TaskSidePane
          task={task}
          onArtifactOpen={handleArtifactOpen}
          onSkillRemove={onSkillRemove}
          onTodoUpdate={onTodoUpdate}
        />
      </div>

      {task.clarify && <ClarifyDialog clarify={task.clarify} onSubmit={onClarifyResolve} />}
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
  agentId,
  workspaceRoot,
  showAgentSelector,
  inline,
  userKey,
}: {
  agentId?: string;
  busy: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSend: (agentId?: string, agentLabel?: string) => void;
  placeholder: string;
  value: string;
  userKey: string;
  workspaceRoot?: string | null;
  showAgentSelector?: boolean;
  inline?: boolean;
}) {
  const canSend = Boolean(value.trim() && !busy && !disabled);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("default");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [skillMenuIndex, setSkillMenuIndex] = useState(0);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    invoke<AgentProfileListResult>("agent_profile_list", { userKey })
      .then((res) => setAgents(res.profiles))
      .catch(console.error);
  }, [userKey]);

  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);
    setSkillsError(null);
    invoke<SkillListResult>("skill_list", {
      agentId: selectedAgentId,
      userKey,
      workspaceRoot: workspaceRoot ?? undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setSkills(res.skills);
      })
      .catch((error) => {
        if (cancelled) return;
        setSkills([]);
        setSkillsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, userKey, workspaceRoot]);

  useEffect(() => {
    if (agentId) setSelectedAgentId(agentId);
  }, [agentId]);

  useEffect(() => {
    if (!workspaceRoot) {
      setWorkspaceFiles([]);
      setFilesLoading(false);
      setFilesError(null);
      return;
    }

    let cancelled = false;
    setFilesLoading(true);
    setFilesError(null);

    loadWorkspaceFilePaths(workspaceRoot)
      .then((paths) => {
        if (cancelled) return;
        setWorkspaceFiles(paths);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setWorkspaceFiles([]);
        setFilesError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setFilesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

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
  const enabledSkills = skills;
  const slashQuery = slashSkillQuery(value, cursorPosition);
  const matchingSkills =
    slashQuery === undefined
      ? []
      : enabledSkills.filter((skill) => skillMatchesQuery(skill, slashQuery.query)).slice(0, 8);
  const skillMenuOpen = slashQuery !== undefined;
  const highlightedSkill = matchingSkills[Math.min(skillMenuIndex, matchingSkills.length - 1)];
  const fileQuery = skillMenuOpen ? undefined : mentionFileQuery(value, cursorPosition);
  const matchingFiles =
    fileQuery === undefined
      ? []
      : workspaceFiles.filter((path) => fileMatchesQuery(path, fileQuery.query)).slice(0, 8);
  const fileMenuOpen = fileQuery !== undefined;
  const highlightedFile = matchingFiles[Math.min(fileMenuIndex, matchingFiles.length - 1)];

  function applySkillCompletion(skill: SkillSummary) {
    const nextValue = slashQuery?.mode === "generic" ? `/skill ${skill.id} ` : `/${skill.id} `;
    onChange(nextValue);
    setCursorPosition(nextValue.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  }

  function applyFileCompletion(path: string) {
    if (!fileQuery) return;
    const nextCursorPosition = fileQuery.start + path.length + 2;
    const nextValue = `${value.slice(0, fileQuery.start)}@${path} ${value.slice(cursorPosition)}`;
    onChange(nextValue);
    setCursorPosition(nextCursorPosition);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    });
  }

  function handleSendFromComposer() {
    if (!canSend) return;
    onSend(selectedAgentId, selectedLabel);
  }

  return (
    <div className={inline ? "w-full" : "shrink-0 border-t border-border bg-background px-4 py-4"}>
      <div className="relative">
        {skillMenuOpen && (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
            <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Skills for {selectedLabel}
            </div>
            {skillsLoading ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                Loading enabled skills...
              </div>
            ) : skillsError ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                Could not load enabled skills.
              </div>
            ) : enabledSkills.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                No skills enabled for {selectedLabel}.
              </div>
            ) : matchingSkills.length > 0 ? (
              <div className="max-h-60 overflow-y-auto p-1">
                {matchingSkills.map((skill, index) => (
                  <button
                    key={skill.id}
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applySkillCompletion(skill);
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left",
                      index === skillMenuIndex
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                    )}
                  >
                    <span className="mt-0.5 rounded bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {slashQuery.mode === "generic" ? `/skill ${skill.id}` : `/${skill.id}`}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{skill.name}</span>
                      <span className="line-clamp-2 text-xs">{skill.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                No enabled skills match{" "}
                {slashQuery.mode === "generic"
                  ? `/skill ${slashQuery.query}`
                  : `/${slashQuery.query}`}
                .
              </div>
            )}
          </div>
        )}
        {fileMenuOpen && (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
            <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Workspace files
            </div>
            {filesLoading ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">Loading files...</div>
            ) : filesError ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                Could not load workspace files.
              </div>
            ) : workspaceFiles.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                No files found in this workspace.
              </div>
            ) : matchingFiles.length > 0 ? (
              <div className="max-h-60 overflow-y-auto p-1">
                {matchingFiles.map((path, index) => (
                  <button
                    key={path}
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyFileCompletion(path);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left",
                      index === fileMenuIndex
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                    )}
                  >
                    <FileText size={14} className="shrink-0 opacity-70" />
                    <span className="min-w-0 truncate font-mono text-sm">@{path}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                No workspace files match @{fileQuery.query}.
              </div>
            )}
          </div>
        )}
        <div className="flex flex-col rounded-2xl border border-border bg-background shadow-lg overflow-hidden transition-shadow focus-within:ring-2 focus-within:ring-primary/20">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setCursorPosition(event.target.selectionStart);
              setSkillMenuIndex(0);
              setFileMenuIndex(0);
            }}
            onSelect={(event) => setCursorPosition(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (skillMenuOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSkillMenuIndex((current) =>
                    matchingSkills.length === 0 ? 0 : (current + 1) % matchingSkills.length
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSkillMenuIndex((current) =>
                    matchingSkills.length === 0
                      ? 0
                      : (current - 1 + matchingSkills.length) % matchingSkills.length
                  );
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  event.preventDefault();
                  if (highlightedSkill) applySkillCompletion(highlightedSkill);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCursorPosition(-1);
                  return;
                }
              }
              if (fileMenuOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setFileMenuIndex((current) =>
                    matchingFiles.length === 0 ? 0 : (current + 1) % matchingFiles.length
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setFileMenuIndex((current) =>
                    matchingFiles.length === 0
                      ? 0
                      : (current - 1 + matchingFiles.length) % matchingFiles.length
                  );
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  event.preventDefault();
                  if (highlightedFile) applyFileCompletion(highlightedFile);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCursorPosition(-1);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSendFromComposer();
              }
            }}
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
                              {agent.id === "default" ? "Default" : "Selected"}
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
              onClick={handleSendFromComposer}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

type SlashSkillQuery = {
  mode: "direct" | "generic";
  query: string;
};

const MAX_WORKSPACE_FILE_MENTIONS = 500;

type FileMentionQuery = {
  query: string;
  start: number;
};

function slashSkillQuery(value: string, cursorPosition: number): SlashSkillQuery | undefined {
  if (cursorPosition < 0) return undefined;
  const beforeCursor = value.slice(0, cursorPosition);
  const genericMatch = beforeCursor.match(/^\/skill(?:\s+([A-Za-z0-9:_-]*))?$/);
  if (genericMatch) return { mode: "generic", query: genericMatch[1] ?? "" };
  const directMatch = beforeCursor.match(/^\/([A-Za-z0-9:_-]*)$/);
  return directMatch ? { mode: "direct", query: directMatch[1] ?? "" } : undefined;
}

function mentionFileQuery(value: string, cursorPosition: number): FileMentionQuery | undefined {
  if (cursorPosition < 0) return undefined;
  const beforeCursor = value.slice(0, cursorPosition);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return undefined;
  return {
    query: match[2] ?? "",
    start: beforeCursor.length - (match[2]?.length ?? 0) - 1,
  };
}

function skillMatchesQuery(skill: SkillSummary, query: string): boolean {
  const normalized = query.toLowerCase();
  return (
    skill.id.toLowerCase().includes(normalized) ||
    skill.name.toLowerCase().includes(normalized) ||
    skill.description.toLowerCase().includes(normalized)
  );
}

function fileMatchesQuery(path: string, query: string): boolean {
  return path.toLowerCase().includes(query.toLowerCase());
}

async function loadWorkspaceFilePaths(workspaceRoot: string): Promise<string[]> {
  const paths: string[] = [];

  async function visit(directoryPath: string, relativePrefix: string) {
    if (paths.length >= MAX_WORKSPACE_FILE_MENTIONS) return;
    const entries = await readDir(directoryPath);
    const visibleEntries = entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of visibleEntries) {
      if (paths.length >= MAX_WORKSPACE_FILE_MENTIONS) break;
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const absolutePath = `${directoryPath}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(absolutePath, relativePath);
      } else {
        paths.push(relativePath);
      }
    }
  }

  await visit(workspaceRoot, "");
  return paths;
}

function AgentInfoPopover({
  agentLabel,
  agentContext,
}: {
  agentLabel: string;
  agentContext?: TaskDetailType["agentContext"];
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

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
          {agentContext ? (
            <div className="space-y-3 mt-3">
              <p className="text-sm text-muted-foreground">{agentContext.compiledSummary}</p>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <div className="rounded-md bg-secondary/50 px-2 py-1">
                  Tool policy: {agentContext.toolPolicy.label}
                </div>
                <div className="rounded-md bg-secondary/50 px-2 py-1">
                  Model: {agentContext.modelSource === "profile_override" ? "Override" : "Global"}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-2">
              The default Tessera workspace agent with the standard workspace editor policy.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TaskSidePane({
  task,
  onArtifactOpen,
  onSkillRemove,
  onTodoUpdate,
}: {
  task: TaskDetailType;
  onArtifactOpen: (artifact: TaskArtifact) => void;
  onSkillRemove: (skillId: string) => Promise<void>;
  onTodoUpdate: (operation: TodoOperation) => Promise<void>;
}) {
  const [todoOpen, setTodoOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(true);
  const [showAllContext, setShowAllContext] = useState(false);
  const visibleArtifacts = showAllContext ? task.artifacts : task.artifacts.slice(0, 4);
  const hiddenArtifactCount = Math.max(0, task.artifacts.length - visibleArtifacts.length);

  return (
    <aside className="w-72 border-l border-border flex flex-col bg-background shrink-0 overflow-y-auto">
      <SidePaneSection title="Todo" open={todoOpen} onToggle={() => setTodoOpen(!todoOpen)}>
        <TodoPanel todo={task.todo} onTodoUpdate={onTodoUpdate} />
      </SidePaneSection>

      <SidePaneSection
        title="Agent Context"
        open={agentOpen}
        onToggle={() => setAgentOpen(!agentOpen)}
      >
        {task.agentContext ? (
          <div className="space-y-4 text-xs text-muted-foreground">
            <div>
              <div className="text-sm font-medium text-foreground">
                {task.agentContext.profileName}
              </div>
              <p className="mt-1">{task.agentContext.compiledSummary}</p>
            </div>
            <div className="rounded-xl border border-border bg-secondary/20 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
                Tool Policy
              </div>
              <div className="mt-1 text-sm text-foreground">
                {task.agentContext.toolPolicy.label}
              </div>
              <p className="mt-1">{task.agentContext.toolPolicy.summary}</p>
            </div>
            {task.agentContext.templateLabel && (
              <div className="text-xs">
                Template: <span className="text-foreground">{task.agentContext.templateLabel}</span>
              </div>
            )}
            <div className="space-y-3">
              {Object.entries(task.agentContext.sectionSummaries).map(([key, value]) => (
                <div key={key}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
                    {key === "userContext"
                      ? "User Context"
                      : key === "memoryDefaults"
                        ? "Memory Defaults"
                        : key}
                  </div>
                  <p className="mt-1">{value}</p>
                </div>
              ))}
            </div>
            <ActiveSkills skills={task.activeSkills} onRemove={onSkillRemove} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Agent context is attached when the task starts and stays fixed for the life of the run.
          </p>
        )}
      </SidePaneSection>

      {/* Context */}
      <SidePaneSection
        title="Context"
        open={contextOpen}
        onToggle={() => setContextOpen(!contextOpen)}
      >
        {task.artifacts.length > 0 ? (
          <div className="space-y-2">
            {visibleArtifacts.map((artifact) => (
              <ArtifactContextCard
                key={artifact.id}
                artifact={artifact}
                onArtifactOpen={onArtifactOpen}
              />
            ))}
            {hiddenArtifactCount > 0 && (
              <button
                type="button"
                className="text-left text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                onClick={() => setShowAllContext(true)}
              >
                +{hiddenArtifactCount} more context item{hiddenArtifactCount === 1 ? "" : "s"}.
              </button>
            )}
            <p className="text-xs text-muted-foreground">
              Track tools and referenced files used in this task.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Track tools and referenced files used in this task.
          </p>
        )}
      </SidePaneSection>
    </aside>
  );
}

function ArtifactContextCard({
  artifact,
  onArtifactOpen,
}: {
  artifact: TaskArtifact;
  onArtifactOpen: (artifact: TaskArtifact) => void;
}) {
  const canOpen = !!artifact.path;
  const Container = canOpen ? "button" : "div";

  return (
    <Container
      type={canOpen ? "button" : undefined}
      title={canOpen ? "Open artifact" : undefined}
      onClick={canOpen ? () => onArtifactOpen(artifact) : undefined}
      className={cn(
        "w-full rounded-xl border border-border bg-secondary/20 px-3 py-2 text-left",
        canOpen &&
          "cursor-pointer transition-colors hover:border-foreground/30 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
          <FileText size={16} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{artifact.title}</div>
          {artifact.contentPreview && (
            <p className="mt-0.5 break-words text-xs text-muted-foreground">
              {artifact.contentPreview}
            </p>
          )}
        </div>
      </div>
    </Container>
  );
}

function activeSkillSourceLabel(skill: TaskSkillActivation): string {
  if (skill.source === "external") {
    return skill.externalProvider === "claude-code" ? "Claude Code" : "Codex";
  }
  if (skill.source === "curated") return "Built-in";
  if (skill.source === "workspace") return "Workspace";
  return "User";
}

function ActiveSkills({
  skills,
  onRemove,
}: {
  skills: TaskSkillActivation[];
  onRemove: (skillId: string) => Promise<void>;
}) {
  if (skills.length === 0) return null;

  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
        Active Skills
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {skills.map((skill) => (
          <span
            key={skill.skillId}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <span className="truncate">{skill.name}</span>
            <span className="text-[10px] text-muted-foreground">
              {activeSkillSourceLabel(skill)}
            </span>
            <button
              type="button"
              className="ml-1 text-muted-foreground hover:text-foreground"
              onClick={() => void onRemove(skill.skillId)}
              aria-label={`Remove ${skill.name}`}
            >
              x
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function TodoPanel({
  todo,
  onTodoUpdate,
}: {
  todo: TaskDetailType["todo"];
  onTodoUpdate: (operation: TodoOperation) => Promise<void>;
}) {
  if (!todo || todo.items.length === 0) {
    return <p className="text-xs text-muted-foreground">No task checklist yet.</p>;
  }

  async function toggleStatus(itemId: string, status: TodoItemStatus) {
    await onTodoUpdate({
      type: "set_status",
      itemId,
      status: status === "completed" ? "pending" : "completed",
    });
  }

  return (
    <div className="space-y-2">
      {todo.items
        .slice()
        .sort((left, right) => left.order - right.order)
        .map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => toggleStatus(item.id, item.status)}
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-secondary/20 px-3 py-2 text-left transition-colors hover:bg-secondary/35"
          >
            <span
              className={cn(
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
                item.status === "completed"
                  ? "border-[var(--leaf)] bg-[var(--leaf-soft)] text-[var(--leaf)]"
                  : "border-border bg-background text-transparent"
              )}
            >
              <Check size={12} />
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  "block text-sm text-foreground",
                  item.status === "completed" && "line-through text-muted-foreground"
                )}
              >
                {item.label}
              </span>
              {item.note && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{item.note}</span>
              )}
            </span>
          </button>
        ))}
    </div>
  );
}

function ClarifyDialog({
  clarify,
  onSubmit,
}: {
  clarify: NonNullable<TaskDetailType["clarify"]>;
  onSubmit: (response: ClarifyResponse) => Promise<void>;
}) {
  const [selectedOptionId, setSelectedOptionId] = useState<string>(clarify.options[0]?.id ?? "");
  const [freeform, setFreeform] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(cancelled: boolean) {
    setSubmitting(true);
    try {
      await onSubmit({
        promptId: clarify.promptId,
        cancelled,
        ...(cancelled ? {} : selectedOptionId ? { selectedOptionId } : { freeform }),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-border bg-background p-6 shadow-2xl">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ListTodo size={16} className="text-primary" />
          Clarification needed
        </div>
        <p className="mt-3 text-sm leading-6 text-foreground">{clarify.message}</p>
        {clarify.detail && <p className="mt-2 text-sm text-muted-foreground">{clarify.detail}</p>}
        <div className="mt-4 space-y-2">
          {clarify.options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border px-3 py-3"
            >
              <input
                checked={selectedOptionId === option.id}
                className="mt-1"
                name={`clarify-${clarify.promptId}`}
                onChange={() => setSelectedOptionId(option.id)}
                type="radio"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
        {clarify.allowFreeform && (
          <textarea
            value={freeform}
            onChange={(event) => {
              setSelectedOptionId("");
              setFreeform(event.target.value);
            }}
            placeholder="Add a custom answer"
            rows={3}
            className="mt-4 w-full rounded-2xl border border-border bg-background px-3 py-2 text-sm outline-none"
          />
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => void submit(true)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit(false)}
            disabled={submitting || (!selectedOptionId && !freeform.trim())}
          >
            {submitting ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

function SidePaneSection({
  title,
  children,
  open,
  onToggle,
  collapsible = true,
}: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
  onToggle?: () => void;
  collapsible?: boolean;
}) {
  return (
    <div className="border-b border-border">
      <button
        type="button"
        className="flex items-center justify-between w-full px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/30 transition-colors"
        onClick={collapsible ? onToggle : undefined}
        style={collapsible ? undefined : { cursor: "default" }}
      >
        {title}
        {collapsible && (
          <ChevronDown
            size={14}
            className={cn("text-muted-foreground transition-transform", open && "rotate-180")}
          />
        )}
        {!collapsible && <ChevronDown size={14} className="text-muted-foreground -rotate-90" />}
      </button>
      {(!collapsible || open) && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function EmptyStateStatusDot({ status }: { status: TaskSummary["status"] }) {
  if (status === "active")
    return <div className="h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-blue-500/20" />;
  if (status === "done") return <CheckCircle2 size={14} className="text-[var(--leaf)]" />;
  if (status === "waiting") return <Clock size={14} className="text-amber-500" />;
  if (status === "failed") return <XCircle size={14} className="text-destructive" />;
  return <div className="h-2.5 w-2.5 rounded-full bg-border" />;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
}

function TurnTimeline({
  artifacts,
  isRunning,
  onArtifactOpen,
}: {
  artifacts: TaskArtifact[];
  isRunning: boolean;
  onArtifactOpen: (artifact: TaskArtifact) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (artifacts.length === 0 && !isRunning) return null;

  const visibleArtifacts = expanded ? artifacts : artifacts.slice(-3);
  const hiddenCount = artifacts.length - visibleArtifacts.length;

  return (
    <div className="space-y-2 font-mono text-sm">
      {hiddenCount > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-secondary/50 transition-colors"
        >
          <ChevronDown size={14} className="-rotate-90" />
          {hiddenCount} previous tool calls
        </button>
      )}
      {visibleArtifacts.map((artifact) => {
        const canOpen = !!artifact.path;
        const Container = canOpen ? "button" : "div";
        return (
          <Container
            key={artifact.id}
            type={canOpen ? "button" : undefined}
            title={canOpen ? "Open artifact" : undefined}
            onClick={canOpen ? () => onArtifactOpen(artifact) : undefined}
            className={cn(
              "flex w-full items-start gap-2 text-left text-muted-foreground",
              canOpen && "cursor-pointer"
            )}
          >
            <span className="shrink-0 mt-1.5">
              <Bot size={14} className="opacity-50" />
            </span>
            <span
              className={cn(
                "bg-secondary/30 border border-border/50 rounded-md px-3 py-1.5 flex-1 min-w-0 text-xs",
                canOpen &&
                  "transition-colors hover:border-foreground/30 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              <span className="block truncate font-semibold">{artifact.title}</span>
              {artifact.contentPreview && (
                <span className="block truncate opacity-75 mt-0.5">{artifact.contentPreview}</span>
              )}
            </span>
          </Container>
        );
      })}
      {isRunning && (
        <div className="flex items-center gap-2 text-muted-foreground mt-2 px-1">
          <ThinkingAnimation />
        </div>
      )}
    </div>
  );
}

function ThinkingAnimation() {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "" : `${d}.`));
    }, 400);
    return () => clearInterval(interval);
  }, []);
  return <span className="text-sm italic">Thinking{dots}</span>;
}
