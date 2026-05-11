import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type WorkflowRunResult, WorkflowRunResultSchema } from "@tessera/contracts";

export interface WorkflowCheckpointStore {
  close(): void;
  get(runId: string): WorkflowRunResult | undefined;
  list(filter?: { status?: WorkflowRunResult["status"]; workflowId?: string }): WorkflowRunResult[];
  save(run: WorkflowRunResult): void;
}

interface WorkflowRunRow {
  payload: string;
  dashboard_layout_json: string | null;
}

export function createWorkflowCheckpointStore(dbPath: string): WorkflowCheckpointStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(workflow_runs)").all();
  const hasDashboardLayout = columns.some((column) => column.name === "dashboard_layout_json");
  if (!hasDashboardLayout) {
    try {
      db.run("ALTER TABLE workflow_runs ADD COLUMN dashboard_layout_json TEXT");
    } catch {
      // The table may not exist yet. CREATE TABLE below includes the column.
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      dashboard_layout_json TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  const saveRun = db.prepare(`
    INSERT INTO workflow_runs (run_id, workflow_id, status, payload, dashboard_layout_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      workflow_id = excluded.workflow_id,
      status = excluded.status,
      payload = excluded.payload,
      dashboard_layout_json = excluded.dashboard_layout_json,
      updated_at = excluded.updated_at
  `);
  const getRun = db.prepare<WorkflowRunRow, [string]>(
    "SELECT payload, dashboard_layout_json FROM workflow_runs WHERE run_id = ?"
  );
  const listRuns = db.prepare<WorkflowRunRow, []>(
    "SELECT payload, dashboard_layout_json FROM workflow_runs ORDER BY updated_at DESC, run_id DESC"
  );
  const listRunsByStatus = db.prepare<WorkflowRunRow, [WorkflowRunResult["status"]]>(
    "SELECT payload, dashboard_layout_json FROM workflow_runs WHERE status = ? ORDER BY updated_at DESC, run_id DESC"
  );
  const listRunsByWorkflow = db.prepare<WorkflowRunRow, [string]>(
    "SELECT payload, dashboard_layout_json FROM workflow_runs WHERE workflow_id = ? ORDER BY updated_at DESC, run_id DESC"
  );
  const listRunsByStatusAndWorkflow = db.prepare<
    WorkflowRunRow,
    [WorkflowRunResult["status"], string]
  >(
    "SELECT payload, dashboard_layout_json FROM workflow_runs WHERE status = ? AND workflow_id = ? ORDER BY updated_at DESC, run_id DESC"
  );

  function parseRun(row: WorkflowRunRow | null): WorkflowRunResult | undefined {
    if (!row) return undefined;
    const payload = JSON.parse(row.payload);
    if (row.dashboard_layout_json && !payload.dashboardLayout) {
      payload.dashboardLayout = JSON.parse(row.dashboard_layout_json);
    }
    return WorkflowRunResultSchema.parse(payload);
  }

  return {
    close() {
      db.close();
    },
    get(runId) {
      return parseRun(getRun.get(runId));
    },
    list(filter) {
      const rows =
        filter?.status && filter.workflowId
          ? listRunsByStatusAndWorkflow.all(filter.status, filter.workflowId)
          : filter?.status
            ? listRunsByStatus.all(filter.status)
            : filter?.workflowId
              ? listRunsByWorkflow.all(filter.workflowId)
              : listRuns.all();
      return rows.flatMap((row) => {
        const parsed = parseRun(row);
        return parsed ? [parsed] : [];
      });
    },
    save(run) {
      const parsed = WorkflowRunResultSchema.parse(run);
      const dashboardLayoutJson = parsed.dashboardLayout
        ? JSON.stringify(parsed.dashboardLayout)
        : null;
      saveRun.run(
        parsed.runId,
        parsed.workflowId,
        parsed.status,
        JSON.stringify(parsed),
        dashboardLayoutJson,
        new Date().toISOString()
      );
    },
  };
}
