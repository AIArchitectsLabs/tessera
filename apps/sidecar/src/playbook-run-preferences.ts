import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type PlaybookRunPreference, PlaybookRunPreferenceSchema } from "@tessera/contracts";

export interface PlaybookRunPreferenceStore {
  close(): void;
  get(workspaceRoot: string, playbookId: string): PlaybookRunPreference | undefined;
  save(preference: PlaybookRunPreference): void;
}

interface PlaybookRunPreferenceRow {
  payload: string;
}

export function createPlaybookRunPreferenceStore(dbPath: string): PlaybookRunPreferenceStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_run_preferences (
      workspace_root TEXT NOT NULL,
      playbook_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_root, playbook_id)
    )
  `);

  const savePreference = db.prepare(`
    INSERT INTO playbook_run_preferences (workspace_root, playbook_id, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_root, playbook_id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const getPreference = db.prepare<PlaybookRunPreferenceRow, [string, string]>(
    "SELECT payload FROM playbook_run_preferences WHERE workspace_root = ? AND playbook_id = ?"
  );

  function parsePreference(
    row: PlaybookRunPreferenceRow | null
  ): PlaybookRunPreference | undefined {
    if (!row) return undefined;
    return PlaybookRunPreferenceSchema.parse(JSON.parse(row.payload));
  }

  return {
    close() {
      db.close();
    },
    get(workspaceRoot, playbookId) {
      return parsePreference(getPreference.get(workspaceRoot, playbookId));
    },
    save(preference) {
      const parsed = PlaybookRunPreferenceSchema.parse(preference);
      savePreference.run(
        parsed.workspaceRoot,
        parsed.playbookId,
        JSON.stringify(parsed),
        parsed.updatedAt
      );
    },
  };
}
