import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceConfigSchema } from "@tessera/contracts";
import {
  WorkspaceConfigConflictError,
  readWorkspaceConfig,
  saveWorkspaceConfig,
} from "./workspace-config.js";

const roots: string[] = [];

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tessera-style-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads missing workspace style config as empty local config", async () => {
  const workspaceRoot = await tempWorkspace();

  const result = await readWorkspaceConfig(workspaceRoot);

  expect(result.exists).toBe(false);
  expect(result.fingerprint).toBe("sha256:missing");
  expect(result.config).toEqual({ schemaVersion: 1 });
});

test("saves workspace style config with optimistic conflict detection", async () => {
  const workspaceRoot = await tempWorkspace();
  const initial = await readWorkspaceConfig(workspaceRoot);
  const config = WorkspaceConfigSchema.parse({
    schemaVersion: 1,
    styleGuide: {
      profile: {
        id: "tessera",
        name: "Tessera Voice",
        defaultCopyType: "business.brief.medium",
      },
      language: {
        bannedTerms: ["synergy"],
      },
      copyTypes: {
        "business.brief.medium": {
          label: "Business Brief",
          length: "medium",
          tone: ["direct"],
          formatRules: ["summary first"],
        },
      },
    },
  });

  const saved = await saveWorkspaceConfig({
    workspaceRoot,
    config,
    expectedFingerprint: initial.fingerprint,
  });

  expect(saved.exists).toBe(true);
  expect(saved.config.styleGuide?.profile.name).toBe("Tessera Voice");
  expect(saved.fingerprint).not.toBe(initial.fingerprint);
  const raw = await readFile(join(workspaceRoot, ".tessera/config.json"), "utf8");
  expect(JSON.parse(raw)).toMatchObject({
    schemaVersion: 1,
    styleGuide: { profile: { name: "Tessera Voice" } },
  });

  await expect(
    saveWorkspaceConfig({
      workspaceRoot,
      config,
      expectedFingerprint: initial.fingerprint,
    })
  ).rejects.toBeInstanceOf(WorkspaceConfigConflictError);
});

test("rejects secret-bearing workspace config fields before writing", async () => {
  const workspaceRoot = await tempWorkspace();

  await expect(
    saveWorkspaceConfig({
      workspaceRoot,
      config: {
        schemaVersion: 1,
        clientSecret: "do-not-write",
      } as ReturnType<typeof WorkspaceConfigSchema.parse>,
    })
  ).rejects.toThrow(/secret-bearing/);

  for (const config of [
    { schemaVersion: 1, client_secret: "do-not-write" },
    { schemaVersion: 1, "secret-key": "do-not-write" },
    { schemaVersion: 1, nested: { private_key: "do-not-write" } },
  ]) {
    await expect(
      saveWorkspaceConfig({
        workspaceRoot,
        config: config as ReturnType<typeof WorkspaceConfigSchema.parse>,
      })
    ).rejects.toThrow(/secret-bearing/);
  }

  await expect(readFile(join(workspaceRoot, ".tessera/config.json"), "utf8")).rejects.toThrow();
});
