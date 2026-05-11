import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaybookRunPreferenceSchema, WorkflowRunAssignmentPlanSchema } from "@tessera/contracts";
import { createPlaybookRunPreferenceStore } from "./playbook-run-preferences.js";

const tempDirs: string[] = [];

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-playbook-preferences-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("playbook run preference store", () => {
  test("saves and loads a workspace/playbook assignment preference", () => {
    const store = createPlaybookRunPreferenceStore(tempDbPath("preferences.sqlite"));
    try {
      const preference = PlaybookRunPreferenceSchema.parse({
        workspaceRoot: "/workspace/acme",
        playbookId: "sales.meeting-brief",
        assignmentPlan: WorkflowRunAssignmentPlanSchema.parse({
          resolverVersion: 1,
          createdAt: "2026-05-11T00:00:00.000Z",
          assignments: {
            draftBrief: {
              stepId: "draftBrief",
              agentId: "default",
              agentLabel: "Tessera",
              skillCapabilities: [],
              toolCapabilities: ["tool.workspace.read"],
              integrationCapabilities: [],
            },
          },
        }),
        updatedAt: "2026-05-11T00:00:00.000Z",
      });

      store.save(preference);

      expect(store.get("/workspace/acme", "sales.meeting-brief")).toEqual(preference);
    } finally {
      store.close();
    }
  });

  test("scopes preferences by workspace and playbook", () => {
    const store = createPlaybookRunPreferenceStore(tempDbPath("preferences.sqlite"));
    try {
      const workspaceA = PlaybookRunPreferenceSchema.parse({
        workspaceRoot: "/workspace/acme",
        playbookId: "sales.meeting-brief",
        assignmentPlan: {
          resolverVersion: 1,
          createdAt: "2026-05-11T00:00:00.000Z",
          assignments: {},
        },
        updatedAt: "2026-05-11T00:00:00.000Z",
      });
      const workspaceB = PlaybookRunPreferenceSchema.parse({
        workspaceRoot: "/workspace/other",
        playbookId: "sales.meeting-brief",
        assignmentPlan: {
          resolverVersion: 1,
          createdAt: "2026-05-11T00:00:00.000Z",
          assignments: {},
        },
        updatedAt: "2026-05-11T00:00:00.000Z",
      });

      store.save(workspaceA);
      store.save(workspaceB);

      expect(store.get("/workspace/acme", "sales.meeting-brief")).toEqual(workspaceA);
      expect(store.get("/workspace/acme", "weekly.status-digest")).toBeUndefined();
      expect(store.get("/workspace/other", "sales.meeting-brief")).toEqual(workspaceB);
    } finally {
      store.close();
    }
  });
});
