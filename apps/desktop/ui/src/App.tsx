import { invoke } from "@tauri-apps/api/core";
import type { SpawnResult, WorkflowRunListResult, WorkflowRunResult } from "@tessera/contracts";
import { useCallback, useEffect, useState } from "react";

import { FileExplorer } from "@/components/FileExplorer";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

// Icons for the Rail
import {
  ArrowUp,
  ArrowUpRight,
  Blocks,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  MessageSquare,
  Sparkles,
  Wrench,
} from "lucide-react";

const WORKSPACE_STORAGE_KEY = "tessera_workspace_root";

export default function App() {
  const [result, setResult] = useState<SpawnResult | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowRunResult | null>(null);
  const [pendingRuns, setPendingRuns] = useState<WorkflowRunResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workflowLoading, setWorkflowLoading] = useState(false);

  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY);
  });

  const handleWorkspaceSelect = (path: string) => {
    setWorkspaceRoot(path);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, path);
  };

  const loadPendingRuns = useCallback(async () => {
    const res = await invoke<WorkflowRunListResult>("workflow_list_pending");
    setPendingRuns(res.runs);
  }, []);

  useEffect(() => {
    loadPendingRuns().catch((e) => setError(String(e)));
  }, [loadPendingRuns]);

  async function ping() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await invoke<SpawnResult>("sidecar_ping");
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runWorkflow() {
    setWorkflowLoading(true);
    setError(null);
    setWorkflow(null);
    try {
      const res = await invoke<WorkflowRunResult>("workflow_run", {
        input: {
          message: "hello",
          target: "lead",
          value: "qualified",
        },
      });
      setWorkflow(res);
      await loadPendingRuns();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorkflowLoading(false);
    }
  }

  async function resumeWorkflow(decision: "approve" | "deny", selectedRun = workflow) {
    if (!selectedRun) return;

    setWorkflowLoading(true);
    setError(null);
    try {
      const res = await invoke<WorkflowRunResult>("workflow_resume", {
        runId: selectedRun.runId,
        decision,
      });
      setWorkflow(res);
      await loadPendingRuns();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorkflowLoading(false);
    }
  }

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans">
      {/* 1. Rail (Leftmost) */}
      <nav className="w-16 flex-shrink-0 bg-secondary flex flex-col items-center py-4 border-r border-border gap-6 relative">
        <div className="relative w-10 h-10 bg-background rounded-xl shadow-sm flex items-center justify-center cursor-pointer text-primary">
          <div className="absolute -left-[18px] top-1/2 -translate-y-1/2 w-1 h-5 bg-primary rounded-r-full" />
          <Blocks size={20} strokeWidth={2.5} />
        </div>
        <div className="flex flex-col gap-4">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <CheckCircle2 size={20} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <MessageSquare size={20} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <Sparkles size={20} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <Wrench size={20} />
          </Button>
        </div>
      </nav>

      {/* 2. Secondary Sidebar (Workspace / Explorer) */}
      <aside className="w-64 flex-shrink-0 bg-secondary flex flex-col border-r border-border">
        <WorkspacePicker
          currentWorkspace={workspaceRoot}
          onWorkspaceSelect={handleWorkspaceSelect}
        />

        <div className="px-4 mb-6 mt-2">
          <Button className="w-full bg-[#2a2826] hover:bg-[#1a1918] text-white rounded-full flex justify-between items-center px-4 h-10">
            <span className="flex items-center gap-2">
              <span className="text-lg leading-none pb-0.5">+</span> New task
            </span>
            <ChevronDown size={14} className="opacity-70" />
          </Button>
        </div>

        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-4 py-2">
          Files
        </div>

        <ScrollArea className="flex-1">
          <FileExplorer workspaceRoot={workspaceRoot || ""} />
        </ScrollArea>
      </aside>

      {/* 3. Main Area */}
      <main className="flex-1 flex flex-col bg-background relative">
        {/* Top Header */}
        <div className="h-16 border-b border-border flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#f1bcac] flex items-center justify-center text-[#7a4838] font-bold text-sm relative">
              M
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#9ab798] border-2 border-background rounded-full" />
            </div>
            <div className="flex flex-col">
              <h1 className="font-semibold text-sm leading-tight text-foreground">
                Drafting Announcement
              </h1>
              <span className="text-xs text-muted-foreground">Q3 Launch • with Maeve</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-[#eef4ee] text-[#4a7248] px-2.5 py-1 rounded-full text-xs font-medium border border-[#d3e5d3]">
              Working
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs rounded-full px-3 gap-1 shadow-sm font-medium"
            >
              Maeve <ChevronDown size={14} className="opacity-50" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 rounded-full p-0 flex items-center justify-center shadow-sm"
            >
              <div className="flex gap-0.5">
                <div className="w-1.5 h-3.5 border border-current rounded-[2px]" />
                <div className="w-1.5 h-3.5 border border-current rounded-[2px]" />
              </div>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs rounded-full px-3 gap-1 shadow-sm font-medium"
            >
              <ExternalLink size={14} /> Open document
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1 pb-24">
          <div className="p-6 max-w-3xl mx-auto space-y-8 mt-4">
            {/* Conversation Flow */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-[#f1bcac] flex items-center justify-center text-[#7a4838] font-bold text-sm shrink-0">
                M
              </div>
              <div className="flex-1 space-y-6 pt-1">
                {/* User Message Bubble */}
                <div className="bg-background border border-border rounded-2xl rounded-tl-sm p-4 shadow-sm inline-block max-w-md">
                  <div className="font-semibold text-sm text-foreground mb-1">
                    Reviewed Product_Specs_Final.pdf
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Extracted 4 key value propositions.
                  </div>
                </div>

                {/* System Text */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground italic pl-1">
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                  Generating first draft...
                </div>

                {/* Agent Action Label */}
                <div className="text-xs text-muted-foreground pl-1">Maeve produced</div>

                {/* Generated Artifact Card */}
                <div className="bg-background border border-border rounded-xl p-4 shadow-sm flex items-center justify-between group hover:border-primary/30 transition-colors cursor-pointer">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                      <FileText size={20} />
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-foreground">Announcement.md</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Doc • v1 • 61 words
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                    Open <ArrowUpRight size={14} />
                  </div>
                </div>

                {/* System Text Active */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#9ab798]" />
                  Maeve is working...
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* Bottom Input Area */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4">
          <div className="bg-background border border-border rounded-full shadow-lg flex items-center p-2 pl-6 h-14">
            <input
              type="text"
              placeholder="Steer Maeve..."
              className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted/80 transition-colors shrink-0"
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </main>

      {/* 4. Inspector (Rightmost) */}
      <aside className="w-72 flex-shrink-0 border-l border-border bg-background flex flex-col">
        <div className="p-6 pb-4">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-full bg-[#f1bcac] flex items-center justify-center text-[#7a4838] font-bold text-lg relative">
              M
              <span className="absolute bottom-0 right-0 w-3 h-3 bg-[#9ab798] border-2 border-background rounded-full" />
            </div>
            <div>
              <h2 className="font-semibold text-lg leading-tight">Maeve</h2>
              <p className="text-sm text-muted-foreground">Copywriting</p>
            </div>
          </div>

          <Button
            variant="outline"
            className="w-full h-8 text-xs font-normal rounded-full shadow-sm"
          >
            <Wrench size={12} className="mr-2" /> Edit agent
          </Button>
        </div>

        <div className="px-6 flex gap-4 text-xs font-medium border-b border-border pb-3">
          <span className="bg-background shadow-sm border border-border px-3 py-1 rounded-full text-foreground cursor-pointer">
            Overview
          </span>
          <span className="text-muted-foreground px-2 py-1 cursor-pointer hover:text-foreground transition-colors">
            Inst.
          </span>
          <span className="text-muted-foreground px-2 py-1 cursor-pointer hover:text-foreground transition-colors">
            Soul
          </span>
          <span className="text-muted-foreground px-2 py-1 cursor-pointer hover:text-foreground transition-colors">
            Skills
          </span>
        </div>

        <div className="p-6 flex-1 flex flex-col gap-8">
          <div>
            <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3">
              About
            </h3>
            <p className="text-sm text-foreground">Copywriting agent.</p>
          </div>

          <div>
            <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3">
              Recent Work
            </h3>
            <ul className="text-sm space-y-3">
              <li className="flex items-center gap-3 text-foreground font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-[#9ab798]" />
                Drafting Announcement
              </li>
              <li className="flex items-center gap-3 text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                Launch deck outline
              </li>
            </ul>
          </div>
        </div>
      </aside>
    </div>
  );
}
