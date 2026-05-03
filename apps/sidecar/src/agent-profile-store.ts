import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentProfile,
  type AgentProfileCreateRequest,
  AgentProfileSchema,
  type AgentProfileUpdateRequest,
  type ToolPolicyPreset,
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
  template_id: string | null;
  instructions: string | null;
  soul: string | null;
  user_context: string | null;
  tool_policy_preset: string | null;
  memory_defaults: string | null;
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

function legacyToolsToPreset(toolsJson: string): ToolPolicyPreset {
  const tools = JSON.parse(toolsJson) as string[];
  const hasWrite = tools.includes("workspace_write") || tools.includes("workspace_edit");
  return hasWrite ? "workspace_editor" : "read_only";
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
    templateId: row.template_id ?? undefined,
    instructions: row.instructions ?? "",
    soul: row.soul ?? "",
    userContext: row.user_context ?? "",
    toolPolicyPreset:
      row.tool_policy_preset === "read_only" ||
      row.tool_policy_preset === "workspace_editor" ||
      row.tool_policy_preset === "elevated_with_approval"
        ? row.tool_policy_preset
        : legacyToolsToPreset(row.tools_json),
    memoryDefaults: row.memory_defaults ?? "",
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
      template_id TEXT,
      instructions TEXT,
      soul TEXT,
      user_context TEXT,
      tool_policy_preset TEXT,
      memory_defaults TEXT,
      skills_json TEXT NOT NULL DEFAULT '[]',
      tools_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const profileColumns = db.query<{ name: string }, []>("PRAGMA table_info(agent_profiles)").all();
  if (!profileColumns.some((column) => column.name === "template_id")) {
    db.exec("ALTER TABLE agent_profiles ADD COLUMN template_id TEXT");
  }
  if (!profileColumns.some((column) => column.name === "user_context")) {
    db.exec("ALTER TABLE agent_profiles ADD COLUMN user_context TEXT");
  }
  if (!profileColumns.some((column) => column.name === "tool_policy_preset")) {
    db.exec("ALTER TABLE agent_profiles ADD COLUMN tool_policy_preset TEXT");
  }
  if (!profileColumns.some((column) => column.name === "memory_defaults")) {
    db.exec("ALTER TABLE agent_profiles ADD COLUMN memory_defaults TEXT");
  }

  const insertProfile = db.prepare(`
    INSERT INTO agent_profiles (
      id, name, description, model_mode, model_provider_json, template_id, instructions, soul, user_context, tool_policy_preset, memory_defaults, skills_json, tools_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getProfileRow = db.prepare<AgentProfileRow, [string]>(
    "SELECT * FROM agent_profiles WHERE id = ?"
  );
  const listProfileRows = db.prepare<AgentProfileRow, []>(
    "SELECT * FROM agent_profiles ORDER BY name ASC"
  );
  const updateProfileRow = db.prepare(`
    UPDATE agent_profiles
    SET name = COALESCE(?, name),
        description = COALESCE(?, description),
        model_mode = COALESCE(?, model_mode),
        model_provider_json = COALESCE(?, model_provider_json),
        template_id = COALESCE(?, template_id),
        instructions = COALESCE(?, instructions),
        soul = COALESCE(?, soul),
        user_context = COALESCE(?, user_context),
        tool_policy_preset = COALESCE(?, tool_policy_preset),
        memory_defaults = COALESCE(?, memory_defaults),
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
        input.templateId ?? null,
        input.instructions,
        input.soul,
        input.userContext,
        input.toolPolicyPreset,
        input.memoryDefaults,
        "[]",
        "[]",
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
        modelProviderJson =
          patch.model.mode === "override" ? JSON.stringify(patch.model.provider) : null;
      }

      updateProfileRow.run(
        patch.name?.trim() ?? null,
        patch.description !== undefined ? patch.description : null,
        modelMode,
        modelProviderJson,
        patch.templateId !== undefined ? patch.templateId : null,
        patch.instructions !== undefined ? patch.instructions : null,
        patch.soul !== undefined ? patch.soul : null,
        patch.userContext !== undefined ? patch.userContext : null,
        patch.toolPolicyPreset !== undefined ? patch.toolPolicyPreset : null,
        patch.memoryDefaults !== undefined ? patch.memoryDefaults : null,
        null,
        null,
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
