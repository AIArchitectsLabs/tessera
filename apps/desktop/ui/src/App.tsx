import { invoke } from "@tauri-apps/api/core";
import type { SpawnResult, WorkflowRunListResult, WorkflowRunResult } from "@tessera/contracts";
import { useCallback, useEffect, useState } from "react";

export default function App() {
  const [result, setResult] = useState<SpawnResult | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowRunResult | null>(null);
  const [pendingRuns, setPendingRuns] = useState<WorkflowRunResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workflowLoading, setWorkflowLoading] = useState(false);

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
    <main style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>Tessera</h1>
      <p>Agent Workspace — Phase 1 Sandbox</p>

      <button type="button" onClick={ping} disabled={loading}>
        {loading ? "Pinging..." : "Ping CLI"}
      </button>

      <button
        type="button"
        onClick={runWorkflow}
        disabled={workflowLoading}
        style={{ marginLeft: "0.75rem" }}
      >
        {workflowLoading ? "Running..." : "Run Workflow"}
      </button>

      {error && <pre style={{ color: "red", marginTop: "1rem" }}>Error: {error}</pre>}

      {result && (
        <pre style={{ marginTop: "1rem", background: "#111", color: "#0f0", padding: "1rem" }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}

      {workflow && (
        <section style={{ marginTop: "1rem" }}>
          <h2>Workflow</h2>
          <pre style={{ background: "#111", color: "#0f0", padding: "1rem" }}>
            {JSON.stringify(workflow, null, 2)}
          </pre>

          {workflow.status === "blocked" && workflow.approval && (
            <div>
              <button
                type="button"
                onClick={() => resumeWorkflow("approve")}
                disabled={workflowLoading}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => resumeWorkflow("deny")}
                disabled={workflowLoading}
                style={{ marginLeft: "0.75rem" }}
              >
                Deny
              </button>
            </div>
          )}
        </section>
      )}

      {pendingRuns.length > 0 && (
        <section style={{ marginTop: "1rem" }}>
          <h2>Pending Runs</h2>
          {pendingRuns.map((run) => (
            <div key={run.runId} style={{ marginTop: "0.75rem" }}>
              <pre style={{ background: "#111", color: "#0f0", padding: "1rem" }}>
                {JSON.stringify(run, null, 2)}
              </pre>
              <button
                type="button"
                onClick={() => {
                  setWorkflow(run);
                  void resumeWorkflow("approve", run);
                }}
                disabled={workflowLoading}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => {
                  setWorkflow(run);
                  void resumeWorkflow("deny", run);
                }}
                disabled={workflowLoading}
                style={{ marginLeft: "0.75rem" }}
              >
                Deny
              </button>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
