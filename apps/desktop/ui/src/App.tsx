import { invoke } from "@tauri-apps/api/core";
import type { SpawnResult, WorkflowRunResult } from "@tessera/contracts";
import { useState } from "react";

export default function App() {
  const [result, setResult] = useState<SpawnResult | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workflowLoading, setWorkflowLoading] = useState(false);

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
    } catch (e) {
      setError(String(e));
    } finally {
      setWorkflowLoading(false);
    }
  }

  async function resumeWorkflow(decision: "approve" | "deny") {
    if (!workflow) return;

    setWorkflowLoading(true);
    setError(null);
    try {
      const res = await invoke<WorkflowRunResult>("workflow_resume", {
        runId: workflow.runId,
        decision,
      });
      setWorkflow(res);
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
    </main>
  );
}
