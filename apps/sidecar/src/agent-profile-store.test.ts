import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentProfileStore } from "./agent-profile-store.js";

const tempDirs: string[] = [];

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-agent-profiles-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent profile store", () => {
  test("creates structured profiles", () => {
    const store = createAgentProfileStore(tempDbPath("profiles.sqlite"));
    try {
      const profile = store.create({
        name: "Ops Partner",
        description: "Structured operator",
        model: { mode: "default" },
        templateId: "business-operator",
        instructions: "Drive concrete outcomes.",
        soul: "Brief.",
        userContext: "Supports an operator.",
        toolPolicyPreset: "workspace_editor",
        memoryDefaults: "Reuse weekly formats.",
      });

      expect(profile.templateId).toBe("business-operator");
      expect(profile.toolPolicyPreset).toBe("workspace_editor");
      expect(profile.memoryDefaults).toBe("Reuse weekly formats.");
    } finally {
      store.close();
    }
  });

  test("migrates legacy profiles with instructions, soul, and tools", () => {
    const dbPath = tempDbPath("legacy.sqlite");
    const db = new Database(dbPath, { create: true, strict: true });
    db.exec(`
      CREATE TABLE agent_profiles (
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
    db.prepare(`
      INSERT INTO agent_profiles (
        id, name, description, model_mode, model_provider_json, instructions, soul, skills_json, tools_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-1",
      "Legacy",
      null,
      "default",
      null,
      "Use terse updates.",
      "Calm.",
      "[]",
      JSON.stringify(["workspace_read", "workspace_search"]),
      "2026-05-03T00:00:00.000Z",
      "2026-05-03T00:00:00.000Z"
    );
    db.close();

    const store = createAgentProfileStore(dbPath);
    try {
      const profile = store.get("legacy-1");
      expect(profile?.instructions).toBe("Use terse updates.");
      expect(profile?.toolPolicyPreset).toBe("read_only");
      expect(profile?.userContext).toBe("");
      expect(profile?.memoryDefaults).toBe("");
    } finally {
      store.close();
    }
  });
});
