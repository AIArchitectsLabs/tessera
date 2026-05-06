import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_PROFILE } from "@tessera/core";
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
        skills: ["planning", "claude-code:pdf-workflow"],
        toolPolicyPreset: "workspace_editor",
        memoryDefaults: "Reuse weekly formats.",
      });

      expect(profile.templateId).toBe("business-operator");
      expect(profile.skills).toEqual(["planning", "claude-code:pdf-workflow"]);
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
      expect(profile?.skills).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("updates profile skills and recovers malformed legacy skills json", () => {
    const dbPath = tempDbPath("skills.sqlite");
    const store = createAgentProfileStore(dbPath);
    try {
      const profile = store.create({
        name: "Researcher",
        model: { mode: "default" },
        instructions: "",
        soul: "",
        userContext: "",
        skills: ["planning"],
        toolPolicyPreset: "read_only",
        memoryDefaults: "",
      });

      expect(store.update(profile.id, { skills: ["planning", "codex:review"] })?.skills).toEqual([
        "planning",
        "codex:review",
      ]);
    } finally {
      store.close();
    }

    const db = new Database(dbPath, { create: true, strict: true });
    db.prepare("UPDATE agent_profiles SET skills_json = ?").run("{bad json");
    db.close();

    const reopened = createAgentProfileStore(dbPath);
    try {
      expect(reopened.list()[0]?.skills).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  test("persists and resets protected default profile overrides", () => {
    const store = createAgentProfileStore(tempDbPath("default.sqlite"));
    try {
      const updated = store.updateDefault(DEFAULT_AGENT_PROFILE, {
        name: "Renamed",
        model: {
          mode: "override",
          provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
        },
        instructions: "Use the edited operating contract.",
        soul: "Crisp.",
        userContext: "Supports the founder.",
        skills: ["planning", "decision-briefs"],
        toolPolicyPreset: "read_only",
        memoryDefaults: "Reuse board memo format.",
      });

      expect(updated.id).toBe("default");
      expect(updated.name).toBe("Tessera");
      expect(updated.model).toEqual({ mode: "default" });
      expect(updated.instructions).toBe("Use the edited operating contract.");
      expect(updated.skills).toEqual(["planning", "decision-briefs"]);
      expect(store.get("default")?.toolPolicyPreset).toBe("read_only");
      expect(store.delete("default")).toBe(false);
      expect(store.resetDefault()).toBe(true);
      expect(store.get("default")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
