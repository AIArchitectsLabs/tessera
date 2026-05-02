import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentProfile,
  AgentProfileSchema,
  type AgentProfileCreateRequest,
  type AgentProfileUpdateRequest,
} from "@tessera/contracts";

export interface AgentProfileStore {
  close(): void;
  create(input: AgentProfileCreateRequest): AgentProfile;
  get(id: string): AgentProfile | undefined;
  list(): AgentProfile[];
  update(id: string, patch: AgentProfileUpdateRequest): AgentProfile | undefined;
  delete(id: string): boolean;
}

interface AgentProfileRow {
  id: string;
  name: string;
  description: string | null;
  model_mode: string;
  model_provider_json: string | null;
  instructions: string | null;
  soul: string | null;
  skills_json: string;
  tools_json: string;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

function rowToProfile(row: AgentProfileRow): AgentProfile {
  let model: AgentProfile["model"];
  if (row.model_mode === "override" && row.model_provider_json) {
    model = {
      mode: "override",
      provider: JSON.parse(row.model_provider_json),
    };
  } else {
    model = { mode: "default" };
  }

  return AgentProfileSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    model,
    instructions: row.instructions ?? undefined,
    soul: row.soul ?? undefined,
    skills: JSON.parse(row.skills_json),
    tools: JSON.parse(row.tools_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createAgentProfileStore(dbPath: string): AgentProfileStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      model_mode TEXT NOT NULL,
      model_provider_json TEXT,
      instructions TEXT,
      soul TEXT,
      skills_json TEXT NOT NULL DEFAULT '[]',
      tools_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const insertProfile = db.prepare(`
    INSERT INTO agent_profiles (
      id, name, description, model_mode, model_provider_json, instructions, soul, skills_json, tools_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getProfileRow = db.prepare<AgentProfileRow, [string]>("SELECT * FROM agent_profiles WHERE id = ?");
  const listProfileRows = db.prepare<AgentProfileRow, []>("SELECT * FROM agent_profiles ORDER BY name ASC");
  const updateProfileRow = db.prepare(`
    UPDATE agent_profiles
    SET name = COALESCE(?, name),
        description = COALESCE(?, description),
        model_mode = COALESCE(?, model_mode),
        model_provider_json = COALESCE(?, model_provider_json),
        instructions = COALESCE(?, instructions),
        soul = COALESCE(?, soul),
        skills_json = COALESCE(?, skills_json),
        tools_json = COALESCE(?, tools_json),
        updated_at = ?
    WHERE id = ?
  `);
  const deleteProfileRow = db.prepare("DELETE FROM agent_profiles WHERE id = ?");

  function get(id: string): AgentProfile | undefined {
    const row = getProfileRow.get(id);
    return row ? rowToProfile(row) : undefined;
  }

  return {
    close() {
      db.close();
    },
    create(input) {
      assertNonEmpty(input.name, "name");
      const id = createId("agent");
      const createdAt = nowIso();
      const modelMode = input.model.mode;
      const modelProviderJson =
        input.model.mode === "override" ? JSON.stringify(input.model.provider) : null;

      insertProfile.run(
        id,
        input.name.trim(),
        input.description ?? null,
        modelMode,
        modelProviderJson,
        input.instructions ?? null,
        input.soul ?? null,
        JSON.stringify(input.skills),
        JSON.stringify(input.tools),
        createdAt,
        createdAt
      );
      
      const profile = get(id);
      if (!profile) throw new Error(`Could not load created agent profile: ${id}`);
      return profile;
    },
    get,
    list() {
      return listProfileRows.all().map(rowToProfile);
    },
    update(id, patch) {
      const existing = getProfileRow.get(id);
      if (!existing) return undefined;

      let modelMode: string | null = null;
      let modelProviderJson: string | null = null;
      if (patch.model) {
        modelMode = patch.model.mode;
        modelProviderJson = patch.model.mode === "override" ? JSON.stringify(patch.model.provider) : null;
      }

      updateProfileRow.run(
        patch.name?.trim() ?? null,
        patch.description !== undefined ? patch.description : null,
        modelMode,
        modelProviderJson,
        patch.instructions !== undefined ? patch.instructions : null,
        patch.soul !== undefined ? patch.soul : null,
        patch.skills ? JSON.stringify(patch.skills) : null,
        patch.tools ? JSON.stringify(patch.tools) : null,
        nowIso(),
        id
      );
      return get(id);
    },
    delete(id) {
      const info = deleteProfileRow.run(id);
      return info.changes > 0;
    },
  };
}
