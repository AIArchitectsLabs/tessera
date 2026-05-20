import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type PlaybookRunPreference,
  PlaybookRunPreferenceSchema,
  type WorkflowRunAssignmentPlan,
} from "@tessera/contracts";
import { configureSidecarSqlite } from "./sqlite.js";

export interface PlaybookRunPreferenceStore {
  close(): void;
  get(input: PlaybookRunPreferenceStoreKey): PlaybookRunPreference | undefined;
  save(input: PlaybookRunPreferenceSaveInput): PlaybookRunPreference;
}

export interface PlaybookRunPreferenceStoreKey {
  ownerUserKey: string;
  workspaceRoot: string;
  playbookId: string;
}

export interface PlaybookRunPreferenceSaveInput extends PlaybookRunPreferenceStoreKey {
  assignmentPlan: WorkflowRunAssignmentPlan;
}

interface PlaybookRunPreferenceRow {
  owner_user_key: string;
  workspace_root: string;
  playbook_id: string;
  assignment_plan_json: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

function rowToPreference(row: PlaybookRunPreferenceRow): PlaybookRunPreference {
  return PlaybookRunPreferenceSchema.parse({
    workspaceRoot: row.workspace_root,
    playbookId: row.playbook_id,
    assignmentPlan: JSON.parse(row.assignment_plan_json),
    updatedAt: row.updated_at,
  });
}

export function createPlaybookRunPreferenceStore(dbPath: string): PlaybookRunPreferenceStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  configureSidecarSqlite(db, dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_run_preferences (
      owner_user_key TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      playbook_id TEXT NOT NULL,
      assignment_plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_user_key, workspace_root, playbook_id)
    );
  `);

  const getPreferenceRow = db.prepare<PlaybookRunPreferenceRow, [string, string, string]>(
    `
      SELECT owner_user_key, workspace_root, playbook_id, assignment_plan_json, updated_at
      FROM playbook_run_preferences
      WHERE owner_user_key = ? AND workspace_root = ? AND playbook_id = ?
    `
  );

  const savePreferenceRow = db.prepare(`
    INSERT INTO playbook_run_preferences (
      owner_user_key, workspace_root, playbook_id, assignment_plan_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_user_key, workspace_root, playbook_id) DO UPDATE SET
      assignment_plan_json = excluded.assignment_plan_json,
      updated_at = excluded.updated_at
  `);

  function readPreference(input: PlaybookRunPreferenceStoreKey): PlaybookRunPreference | undefined {
    const row = getPreferenceRow.get(input.ownerUserKey, input.workspaceRoot, input.playbookId);
    return row ? rowToPreference(row) : undefined;
  }

  return {
    close() {
      db.close();
    },

    get(input) {
      assertNonEmpty(input.ownerUserKey, "ownerUserKey");
      assertNonEmpty(input.workspaceRoot, "workspaceRoot");
      assertNonEmpty(input.playbookId, "playbookId");
      return readPreference(input);
    },

    save(input) {
      assertNonEmpty(input.ownerUserKey, "ownerUserKey");
      assertNonEmpty(input.workspaceRoot, "workspaceRoot");
      assertNonEmpty(input.playbookId, "playbookId");
      const updatedAt = nowIso();
      savePreferenceRow.run(
        input.ownerUserKey,
        input.workspaceRoot,
        input.playbookId,
        JSON.stringify(input.assignmentPlan),
        updatedAt,
        updatedAt
      );
      return (
        readPreference(input) ??
        PlaybookRunPreferenceSchema.parse({
          workspaceRoot: input.workspaceRoot,
          playbookId: input.playbookId,
          assignmentPlan: input.assignmentPlan,
          updatedAt,
        })
      );
    },
  };
}
