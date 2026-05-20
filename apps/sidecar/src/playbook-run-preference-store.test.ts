import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlaybookRunPreferenceStore } from "./playbook-run-preference-store.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-playbook-preferences-"));
  tempDirs.push(dir);
  return join(dir, "preferences.sqlite");
}

function assignmentPlan(agentId: string, agentLabel: string) {
  return {
    resolverVersion: 1,
    createdAt: "2026-05-20T00:00:00.000Z",
    assignments: {
      draftBrief: {
        stepId: "draftBrief",
        agentId,
        agentLabel,
        skillCapabilities: [],
        toolCapabilities: ["tool.workspace.read"],
        integrationCapabilities: [],
      },
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createPlaybookRunPreferenceStore", () => {
  test("persists playbook run preferences across store instances", () => {
    const dbPath = tempDbPath();
    const first = createPlaybookRunPreferenceStore(dbPath);
    const savedPlan = assignmentPlan("analyst", "Analyst");
    try {
      const saved = first.save({
        ownerUserKey: "user.test",
        workspaceRoot: "/tmp/workspace",
        playbookId: "sales.meeting-brief",
        assignmentPlan: savedPlan,
      });
      expect(saved.assignmentPlan.assignments.draftBrief?.agentId).toBe("analyst");
    } finally {
      first.close();
    }

    const reopened = createPlaybookRunPreferenceStore(dbPath);
    try {
      const loaded = reopened.get({
        ownerUserKey: "user.test",
        workspaceRoot: "/tmp/workspace",
        playbookId: "sales.meeting-brief",
      });
      expect(loaded?.assignmentPlan).toEqual(savedPlan);
    } finally {
      reopened.close();
    }
  });

  test("scopes preferences by user, workspace, and playbook", () => {
    const store = createPlaybookRunPreferenceStore(tempDbPath());
    try {
      store.save({
        ownerUserKey: "user.alex",
        workspaceRoot: "/tmp/alex",
        playbookId: "sales.meeting-brief",
        assignmentPlan: assignmentPlan("analyst", "Analyst"),
      });

      expect(
        store.get({
          ownerUserKey: "user.blair",
          workspaceRoot: "/tmp/alex",
          playbookId: "sales.meeting-brief",
        })
      ).toBeUndefined();
      expect(
        store.get({
          ownerUserKey: "user.alex",
          workspaceRoot: "/tmp/blair",
          playbookId: "sales.meeting-brief",
        })
      ).toBeUndefined();
      expect(
        store.get({
          ownerUserKey: "user.alex",
          workspaceRoot: "/tmp/alex",
          playbookId: "operations.weekly-status-digest",
        })
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
