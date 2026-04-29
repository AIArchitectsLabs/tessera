import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type WorkflowRunResult, WorkflowRunResultSchema } from "@tessera/contracts";

export interface WorkflowCheckpointStore {
  close(): void;
  get(runId: string): WorkflowRunResult | undefined;
  list(): WorkflowRunResult[];
  save(run: WorkflowRunResult): void;
}

interface WorkflowRunRow {
  payload: string;
}

export function createWorkflowCheckpointStore(dbPath: string): WorkflowCheckpointStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const saveRun = db.prepare(`
    INSERT INTO workflow_runs (run_id, workflow_id, status, payload, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      workflow_id = excluded.workflow_id,
      status = excluded.status,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const getRun = db.prepare<WorkflowRunRow, [string]>(
    "SELECT payload FROM workflow_runs WHERE run_id = ?"
  );
  const listRuns = db.prepare<WorkflowRunRow, []>(
    "SELECT payload FROM workflow_runs ORDER BY updated_at DESC, run_id DESC"
  );

  function parseRun(row: WorkflowRunRow | null): WorkflowRunResult | undefined {
    if (!row) return undefined;
    return WorkflowRunResultSchema.parse(JSON.parse(row.payload));
  }

  return {
    close() {
      db.close();
    },
    get(runId) {
      return parseRun(getRun.get(runId));
    },
    list() {
      return listRuns.all().map((row) => WorkflowRunResultSchema.parse(JSON.parse(row.payload)));
    },
    save(run) {
      const parsed = WorkflowRunResultSchema.parse(run);
      saveRun.run(
        parsed.runId,
        parsed.workflowId,
        parsed.status,
        JSON.stringify(parsed),
        new Date().toISOString()
      );
    },
  };
}
