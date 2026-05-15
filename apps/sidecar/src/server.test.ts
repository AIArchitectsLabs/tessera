import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WorkflowCapabilityInventorySchema,
  WorkflowRunAssignmentPlanSchema,
} from "@tessera/contracts";
import { createOptionalCapabilityManager } from "@tessera/core";
import type { GraphPlaybookRegistryEntry } from "./graph-playbook-registry.js";

type RecordedFetchCall = {
  url: string;
  init: Parameters<typeof fetch>[1] | undefined;
};

const originalServe = Bun.serve;
const originalMemoryDisabled = process.env.TESSERA_MEMORY_DISABLED;
let isPlaybookRunPreferenceAssignmentPlanValidationError:
  | typeof import("./server.js").isPlaybookRunPreferenceAssignmentPlanValidationError
  | undefined;
let attachPlaybookMemoryShadow: typeof import("./server.js").attachPlaybookMemoryShadow | undefined;
let buildPlaybookRunPreference: typeof import("./server.js").buildPlaybookRunPreference | undefined;
let buildWorkflowExecutionOptions:
  | typeof import("./server.js").buildWorkflowExecutionOptions
  | undefined;
let createServerMemoryRuntime: typeof import("./server.js").createServerMemoryRuntime | undefined;
let handleMemoryForget: typeof import("./server.js").handleMemoryForget | undefined;
let handleMemoryReviewDecision: typeof import("./server.js").handleMemoryReviewDecision | undefined;
let handleMemoryReviewList: typeof import("./server.js").handleMemoryReviewList | undefined;
let handleMemoryStatus: typeof import("./server.js").handleMemoryStatus | undefined;
let handleCapabilityBinary: typeof import("./server.js").handleCapabilityBinary | undefined;
let handleCapabilityBinaryInstall:
  | typeof import("./server.js").handleCapabilityBinaryInstall
  | undefined;
let handleGraphPlaybookInstall: typeof import("./server.js").handleGraphPlaybookInstall | undefined;
let pollCodexDeviceToken: typeof import("./server.js").pollCodexDeviceToken | undefined;
let resolveGoogleWorkspaceCliEnv:
  | typeof import("./server.js").resolveGoogleWorkspaceCliEnv
  | undefined;
let requestCodexDeviceCode: typeof import("./server.js").requestCodexDeviceCode | undefined;
let refreshCodexOAuthCredential:
  | typeof import("./server.js").refreshCodexOAuthCredential
  | undefined;

beforeAll(async () => {
  (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = ((options) => ({
    port: 0,
    stop() {},
  })) as typeof Bun.serve;
  process.env.TESSERA_MEMORY_DISABLED = "1";

  try {
    const serverModule = await import("./server.js");
    attachPlaybookMemoryShadow = serverModule.attachPlaybookMemoryShadow;
    buildPlaybookRunPreference = serverModule.buildPlaybookRunPreference;
    buildWorkflowExecutionOptions = serverModule.buildWorkflowExecutionOptions;
    createServerMemoryRuntime = serverModule.createServerMemoryRuntime;
    handleMemoryForget = serverModule.handleMemoryForget;
    handleMemoryReviewDecision = serverModule.handleMemoryReviewDecision;
    handleMemoryReviewList = serverModule.handleMemoryReviewList;
    handleMemoryStatus = serverModule.handleMemoryStatus;
    handleCapabilityBinary = serverModule.handleCapabilityBinary;
    handleCapabilityBinaryInstall = serverModule.handleCapabilityBinaryInstall;
    handleGraphPlaybookInstall = serverModule.handleGraphPlaybookInstall;
    isPlaybookRunPreferenceAssignmentPlanValidationError =
      serverModule.isPlaybookRunPreferenceAssignmentPlanValidationError;
    pollCodexDeviceToken = serverModule.pollCodexDeviceToken;
    refreshCodexOAuthCredential = serverModule.refreshCodexOAuthCredential;
    resolveGoogleWorkspaceCliEnv = serverModule.resolveGoogleWorkspaceCliEnv;
    requestCodexDeviceCode = serverModule.requestCodexDeviceCode;
  } finally {
    (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = originalServe;
  }
});

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function writeGraphPackageFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function writeGraphPackage(root: string, version: string, scriptBody = ""): Promise<void> {
  const graph = {
    schemaVersion: 1,
    id: "content.seo-blog",
    version,
    name: "SEO Blog Article",
    start: "score",
    artifacts: {
      scorecard: { schema: "./schemas/scorecard.schema.json" },
    },
    nodes: [
      {
        id: "score",
        kind: "script",
        run: "./scripts/score.ts",
        inputs: {},
        outputArtifact: "scorecard",
        onSuccess: "completed",
      },
    ],
  };

  await writeGraphPackageFile(
    root,
    "manifest.json",
    JSON.stringify({
      schemaVersion: 1,
      id: graph.id,
      version: graph.version,
      name: graph.name,
      entrypoint: "playbook.ts",
    })
  );
  await writeGraphPackageFile(
    root,
    "playbook.ts",
    `import { definePlaybook } from "@tessera/plugin-sdk";
export default definePlaybook(${JSON.stringify(graph, null, 2)});
`
  );
  await writeGraphPackageFile(
    root,
    "scripts/score.ts",
    scriptBody || "export default async function score() {}\n"
  );
  await writeGraphPackageFile(root, "schemas/scorecard.schema.json", '{"type":"object"}\n');
}

async function expectGraphPackageInstallBadRequest(sourceRoot: string): Promise<string> {
  const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
  try {
    const response = await handleGraphPlaybookInstall?.(
      new Request("http://localhost/graph-playbooks/install", {
        method: "POST",
        body: JSON.stringify({ sourceRoot }),
      }),
      {
        installRoot,
        cacheRoot,
        compilerVersion: "server-test",
        scriptSdkVersion: "server-test",
      }
    );
    expect(response?.status).toBe(400);
    const payload = (await response?.json()) as Record<string, unknown>;
    return String(payload.error);
  } finally {
    await Promise.all(
      [installRoot, cacheRoot].map((root) => rm(root, { recursive: true, force: true }))
    );
  }
}

afterAll(() => {
  (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = originalServe;
  if (originalMemoryDisabled === undefined) {
    process.env.TESSERA_MEMORY_DISABLED = undefined;
  } else {
    process.env.TESSERA_MEMORY_DISABLED = originalMemoryDisabled;
  }
});

describe("graph playbook install endpoint", () => {
  test("installs a valid package and rebuilds the registry", async () => {
    expect(handleGraphPlaybookInstall).toBeDefined();
    const sourceRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const state: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    try {
      await writeGraphPackage(sourceRoot, "0.1.0");

      const response = await handleGraphPlaybookInstall?.(
        new Request("http://localhost/graph-playbooks/install", {
          method: "POST",
          body: JSON.stringify({ sourceRoot }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );

      expect(response?.status).toBe(200);
      const payload = (await response?.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({
        id: "content.seo-blog",
        version: "0.1.0",
      });
      expect(typeof payload.graphHash).toBe("string");
      expect(typeof payload.sourceHash).toBe("string");
      const graphHash = String(payload.graphHash);
      expect(state.entries).toEqual([
        {
          id: "content.seo-blog",
          version: "0.1.0",
          name: "SEO Blog Article",
          graphHash,
          installedRoot: join(
            installRoot,
            `v-${Buffer.from("content.seo-blog", "utf8").toString("base64url")}`,
            `v-${Buffer.from("0.1.0", "utf8").toString("base64url")}`
          ),
        },
      ]);
    } finally {
      await Promise.all(
        [sourceRoot, installRoot, cacheRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });

  test("returns 400 for invalid install requests", async () => {
    expect(handleGraphPlaybookInstall).toBeDefined();

    const response = await handleGraphPlaybookInstall?.(
      new Request("http://localhost/graph-playbooks/install", {
        method: "POST",
        body: JSON.stringify({ sourceRoot: "" }),
      })
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "sourceRoot is required" });
  });

  test("returns 400 for invalid package and compile failures", async () => {
    expect(handleGraphPlaybookInstall).toBeDefined();
    const missingManifestRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const invalidJsonRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const invalidManifestRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const dangerousImportRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const invalidTypeScriptRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const symlinkEscapeRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const symlinkTargetRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-target-"));
    const nonexistentRoot = join(tmpdir(), `tessera-sidecar-missing-${Date.now()}`);
    try {
      await writeGraphPackageFile(invalidJsonRoot, "manifest.json", "{broken");
      await writeGraphPackageFile(
        invalidManifestRoot,
        "manifest.json",
        JSON.stringify({ schemaVersion: 1, id: "", version: "0.1.0", name: "Broken" })
      );
      await writeGraphPackage(dangerousImportRoot, "0.1.0");
      await writeGraphPackageFile(
        dangerousImportRoot,
        "playbook.ts",
        `import { readFileSync } from "node:fs";
import { definePlaybook } from "@tessera/plugin-sdk";
readFileSync;
export default definePlaybook({
  schemaVersion: 1,
  id: "content.seo-blog",
  version: "0.1.0",
  name: "SEO Blog Article",
  start: "score",
  artifacts: { scorecard: { schema: "./schemas/scorecard.schema.json" } },
  nodes: [{ id: "score", kind: "script", run: "./scripts/score.ts", inputs: {}, outputArtifact: "scorecard", onSuccess: "completed" }],
});
`
      );
      await writeGraphPackage(invalidTypeScriptRoot, "0.1.0");
      await writeGraphPackageFile(invalidTypeScriptRoot, "playbook.ts", "export default {\n");
      await writeGraphPackage(symlinkEscapeRoot, "0.1.0");
      await writeGraphPackageFile(symlinkTargetRoot, "outside.ts", "export default 1;\n");
      await symlink(join(symlinkTargetRoot, "outside.ts"), join(symlinkEscapeRoot, "outside.ts"));

      await expectGraphPackageInstallBadRequest(missingManifestRoot);
      await expectGraphPackageInstallBadRequest(invalidJsonRoot);
      await expectGraphPackageInstallBadRequest(invalidManifestRoot);
      await expectGraphPackageInstallBadRequest(dangerousImportRoot);
      await expectGraphPackageInstallBadRequest(invalidTypeScriptRoot);
      await expectGraphPackageInstallBadRequest(symlinkEscapeRoot);
      await expectGraphPackageInstallBadRequest(nonexistentRoot);
    } finally {
      await Promise.all(
        [
          missingManifestRoot,
          invalidJsonRoot,
          invalidManifestRoot,
          dangerousImportRoot,
          invalidTypeScriptRoot,
          symlinkEscapeRoot,
          symlinkTargetRoot,
        ].map((root) => rm(root, { recursive: true, force: true }))
      );
    }
  });

  test("returns 409 for same-version source conflicts", async () => {
    expect(handleGraphPlaybookInstall).toBeDefined();
    const firstSourceRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const secondSourceRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const state: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    try {
      await writeGraphPackage(firstSourceRoot, "0.1.0");
      await writeGraphPackage(
        secondSourceRoot,
        "0.1.0",
        "export default async function score() { return 'changed'; }\n"
      );

      await handleGraphPlaybookInstall?.(
        new Request("http://localhost/graph-playbooks/install", {
          method: "POST",
          body: JSON.stringify({ sourceRoot: firstSourceRoot }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );

      const response = await handleGraphPlaybookInstall?.(
        new Request("http://localhost/graph-playbooks/install", {
          method: "POST",
          body: JSON.stringify({ sourceRoot: secondSourceRoot }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );

      expect(response?.status).toBe(409);
      const payload = (await response?.json()) as Record<string, unknown>;
      expect(String(payload.error)).toContain("Graph playbook package conflict");
    } finally {
      await Promise.all(
        [firstSourceRoot, secondSourceRoot, installRoot, cacheRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });
});

describe("playbook run preference save error mapping", () => {
  test("installs an optional capability binary through the explicit sidecar install handler", async () => {
    expect(handleCapabilityBinary).toBeDefined();
    expect(handleCapabilityBinaryInstall).toBeDefined();
    const payload = Buffer.from("#!/bin/sh\necho gws\n");
    const rootDir = await mkdtemp("/tmp/tessera-sidecar-capability-");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "0.22.5",
          binaries: [{ name: "gws", relativePath: "gws" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/gws",
              sha256: sha256(payload),
              executableName: "gws",
            },
          ],
        },
      ],
      download: async () => payload,
    });

    const statusResponse = await handleCapabilityBinary?.(
      new Request("http://localhost/capabilities/google-workspace-cli/binaries/gws?install=1", {
        method: "GET",
      }),
      "google-workspace-cli",
      "gws",
      manager
    );

    expect(statusResponse?.status).toBe(200);
    await expect(statusResponse?.json()).resolves.toMatchObject({
      capabilityId: "google-workspace-cli",
      binaryName: "gws",
      installed: false,
      installAvailable: true,
      version: "0.22.5",
    });

    const response = await handleCapabilityBinaryInstall?.(
      new Request("http://localhost/capabilities/google-workspace-cli/binaries/gws/install", {
        method: "POST",
      }),
      "google-workspace-cli",
      "gws",
      manager
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      capabilityId: "google-workspace-cli",
      binaryName: "gws",
      path: join(rootDir, "google-workspace-cli", "0.22.5", "gws"),
      installed: true,
      installAvailable: true,
      version: "0.22.5",
      progress: {
        phase: "installed",
        downloadedBytes: payload.byteLength,
        totalBytes: payload.byteLength,
      },
    });
  });

  test("resolves managed gws env only for Google Workspace CLI commands", async () => {
    expect(resolveGoogleWorkspaceCliEnv).toBeDefined();
    const payload = Buffer.from("#!/bin/sh\necho gws\n");
    const rootDir = await mkdtemp("/tmp/tessera-sidecar-gws-env-");
    const manager = createOptionalCapabilityManager({
      rootDir,
      platform: "darwin",
      arch: "arm64",
      definitions: [
        {
          id: "google-workspace-cli",
          label: "Google Workspace CLI",
          version: "0.22.5",
          binaries: [{ name: "gws", relativePath: "gws" }],
          assets: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://downloads.tessera.local/gws",
              sha256: sha256(payload),
              executableName: "gws",
            },
          ],
        },
      ],
      download: async () => payload,
    });

    await expect(
      resolveGoogleWorkspaceCliEnv?.(["web-search", "search", "tessera"], manager, {})
    ).resolves.toEqual({});
    await expect(resolveGoogleWorkspaceCliEnv?.(["gcal", "list"], manager, {})).resolves.toEqual(
      {}
    );
    await expect(manager.resolveBinary("google-workspace-cli", "gws")).resolves.toBeUndefined();

    await manager.install("google-workspace-cli");

    await expect(resolveGoogleWorkspaceCliEnv?.(["gcal", "list"], manager, {})).resolves.toEqual({
      TESSERA_GWS_CLI_PATH: join(rootDir, "google-workspace-cli", "0.22.5", "gws"),
    });
  });

  test("installs the archive-based gws builtin through the sidecar install endpoint", async () => {
    expect(handleCapabilityBinary).toBeDefined();
    expect(handleCapabilityBinaryInstall).toBeDefined();
    const archivePayload = Buffer.from("fake-tar-gz-archive-bytes");
    const extractedBinary = Buffer.from("#!/bin/sh\necho gws-from-archive\n");
    const rootDir = await mkdtemp(join(tmpdir(), "tessera-sidecar-gws-archive-"));
    try {
      const extractCalls: { kind: string; archivePath: string; outputDir: string }[] = [];
      const manager = createOptionalCapabilityManager({
        rootDir,
        platform: "darwin",
        arch: "arm64",
        definitions: [
          {
            id: "google-workspace-cli",
            label: "Google Workspace CLI",
            version: "0.22.5",
            binaries: [{ name: "gws", relativePath: "gws" }],
            assets: [
              {
                platform: "darwin",
                arch: "arm64",
                url: "https://downloads.tessera.local/gws.tar.gz",
                sha256: sha256(archivePayload),
                executableName: "gws",
                archive: { kind: "tar.gz", entry: "gws" },
              },
            ],
          },
        ],
        download: async () => archivePayload,
        extract: async ({ archivePath, outputDir, kind }) => {
          extractCalls.push({ kind, archivePath, outputDir });
          await writeFile(join(outputDir, "gws"), extractedBinary);
        },
      });

      const installResponse = await handleCapabilityBinaryInstall?.(
        new Request("http://localhost/capabilities/google-workspace-cli/binaries/gws/install", {
          method: "POST",
        }),
        "google-workspace-cli",
        "gws",
        manager
      );

      expect(installResponse?.status).toBe(200);
      await expect(installResponse?.json()).resolves.toMatchObject({
        capabilityId: "google-workspace-cli",
        binaryName: "gws",
        path: join(rootDir, "google-workspace-cli", "0.22.5", "gws"),
        installed: true,
        installAvailable: true,
        version: "0.22.5",
        progress: { phase: "installed" },
      });
      expect(extractCalls).toHaveLength(1);
      expect(extractCalls[0]?.kind).toBe("tar.gz");

      const statusResponse = await handleCapabilityBinary?.(
        new Request("http://localhost/capabilities/google-workspace-cli/binaries/gws", {
          method: "GET",
        }),
        "google-workspace-cli",
        "gws",
        manager
      );

      expect(statusResponse?.status).toBe(200);
      await expect(statusResponse?.json()).resolves.toMatchObject({
        capabilityId: "google-workspace-cli",
        binaryName: "gws",
        path: join(rootDir, "google-workspace-cli", "0.22.5", "gws"),
        installed: true,
        installAvailable: true,
        version: "0.22.5",
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("reports active memory runtime status", async () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const runtime = createServerMemoryRuntime?.({
      dbPath: "/tmp/tessera-memory.sqlite",
      disabled: false,
      ownerId: "local-owner",
      createStore() {
        return {
          close() {},
          recordEvent(event) {
            return event;
          },
          getEventById() {
            return undefined;
          },
          getEventByKey() {
            return undefined;
          },
          getMemoryById() {
            return undefined;
          },
          indexDocument() {},
          searchChunks() {
            return [];
          },
          upsertMemory(memory) {
            return memory;
          },
          listActiveMemories() {
            return [];
          },
          listCandidateMemories() {
            return [];
          },
          isSourceForgotten() {
            return false;
          },
          forgetMemory() {},
        };
      },
    });

    expect(runtime?.memoryStatus).toEqual({
      enabled: true,
      mode: "active",
      dbPath: "/tmp/tessera-memory.sqlite",
    });
  });

  test("reports disabled and startup fallback memory runtime status", () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const disabled = createServerMemoryRuntime?.({
      dbPath: "/unused/memory.sqlite",
      disabled: true,
      ownerId: "local-owner",
      createStore() {
        throw new Error("should not create store");
      },
    });
    const fallback = createServerMemoryRuntime?.({
      dbPath: "/unavailable/memory.sqlite",
      disabled: false,
      ownerId: "local-owner",
      createStore() {
        throw new Error("sqlite unavailable");
      },
    });

    expect(disabled?.memoryStatus).toEqual({
      enabled: false,
      mode: "disabled",
      dbPath: "/unused/memory.sqlite",
    });
    expect(fallback?.memoryStatus).toEqual({
      enabled: false,
      mode: "fallback",
      dbPath: "/unavailable/memory.sqlite",
      startupWarning: {
        type: "tessera.memory.startup_failed",
        message: "sqlite unavailable",
      },
    });
  });

  test("memory status handler is read only", async () => {
    expect(handleMemoryStatus).toBeDefined();
    const response = await handleMemoryStatus?.(
      new Request("http://localhost/memory/status", { method: "GET" }),
      {
        enabled: true,
        mode: "active",
        dbPath: "/tmp/tessera-memory.sqlite",
      }
    );
    const rejected = await handleMemoryStatus?.(
      new Request("http://localhost/memory/status", { method: "POST" }),
      {
        enabled: true,
        mode: "active",
        dbPath: "/tmp/tessera-memory.sqlite",
      }
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      enabled: true,
      mode: "active",
      dbPath: "/tmp/tessera-memory.sqlite",
    });
    expect(rejected?.status).toBe(405);
  });

  test("memory review handlers list and accept candidate memories", async () => {
    expect(handleMemoryReviewList).toBeDefined();
    expect(handleMemoryReviewDecision).toBeDefined();
    const activeMemory = {
      id: "memory-active",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "workspace" as const,
      type: "preference" as const,
      title: "Weekly style",
      body: "Prefer concise bullets.",
      status: "active" as const,
      confidence: 0.92,
      freshness: "fresh" as const,
      sourceEventIds: ["event-1"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };
    const candidateMemory = {
      ...activeMemory,
      id: "memory-candidate",
      status: "candidate" as const,
      confidence: 0.62,
      rationale: {
        supportingEventIds: ["event-2"],
        conflictingMemoryIds: [],
        promotionReason: "Needs review.",
        riskFlags: ["low_confidence" as const],
      },
    };
    let storedCandidate = candidateMemory;
    const store = {
      close() {},
      recordEvent(event: never) {
        return event;
      },
      getEventById() {
        return undefined;
      },
      getEventByKey() {
        return undefined;
      },
      getMemoryById(id: string) {
        if (id === "memory-candidate") return storedCandidate;
        if (id === "memory-active") return activeMemory;
        return undefined;
      },
      indexDocument() {},
      searchChunks() {
        return [];
      },
      upsertMemory(memory: typeof activeMemory | typeof candidateMemory) {
        if (memory.id === "memory-candidate") {
          storedCandidate = memory as typeof candidateMemory;
        }
        return memory;
      },
      listActiveMemories() {
        return [activeMemory];
      },
      listCandidateMemories() {
        return [storedCandidate];
      },
      isSourceForgotten() {
        return false;
      },
      forgetMemory() {},
    };

    const listResponse = await handleMemoryReviewList?.(
      new Request("http://localhost/memory/review", { method: "GET" }),
      store
    );
    const decisionResponse = await handleMemoryReviewDecision?.(
      new Request("http://localhost/memory/review/decision", {
        method: "POST",
        body: JSON.stringify({
          memoryId: "memory-candidate",
          decision: "accept",
          reason: "User accepted.",
          decidedAt: "2026-05-13T00:10:00.000Z",
        }),
      }),
      store
    );

    expect(listResponse?.status).toBe(200);
    expect(await listResponse?.json()).toEqual({
      active: [activeMemory],
      candidates: [candidateMemory],
    });
    expect(decisionResponse?.status).toBe(200);
    expect(await decisionResponse?.json()).toMatchObject({
      id: "memory-candidate",
      status: "active",
      updatedAt: "2026-05-13T00:10:00.000Z",
    });
  });

  test("memory forget handler accepts explicit delete requests", async () => {
    expect(handleMemoryForget).toBeDefined();
    const requests: unknown[] = [];
    const store = {
      close() {},
      recordEvent(event: never) {
        return event;
      },
      getEventById() {
        return undefined;
      },
      getEventByKey() {
        return undefined;
      },
      getMemoryById() {
        return undefined;
      },
      indexDocument() {},
      searchChunks() {
        return [];
      },
      upsertMemory(memory: never) {
        return memory;
      },
      listActiveMemories() {
        return [];
      },
      listCandidateMemories() {
        return [];
      },
      isSourceForgotten() {
        return false;
      },
      forgetMemory(request: unknown) {
        requests.push(request);
      },
    };

    const response = await handleMemoryForget?.(
      new Request("http://localhost/memory/forget", {
        method: "POST",
        body: JSON.stringify({
          memoryId: "memory-active",
          action: "delete",
          reason: "User asked Tessera to forget this.",
          requestedAt: "2026-05-13T00:15:00.000Z",
        }),
      }),
      store
    );

    expect(response?.status).toBe(200);
    expect(requests).toEqual([
      {
        memoryId: "memory-active",
        action: "delete",
        reason: "User asked Tessera to forget this.",
        requestedAt: "2026-05-13T00:15:00.000Z",
      },
    ]);
    expect(await response?.json()).toEqual({ ok: true });
  });

  test("falls back to noop memory manager when memory store startup fails", async () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const warnings: string[] = [];
    const runtime = createServerMemoryRuntime?.({
      dbPath: "/unavailable/memory.sqlite",
      disabled: false,
      ownerId: "local-owner",
      createStore() {
        throw new Error("sqlite unavailable");
      },
      warn(message) {
        warnings.push(message);
      },
    });

    expect(runtime?.memoryStore).toBeUndefined();
    expect(runtime?.memoryStatus.mode).toBe("fallback");
    const recalled = await runtime?.memoryManager.recallForTask({
      task: {
        id: "task-1",
        workspaceRoot: "/workspace/acme",
        title: "Task",
        status: "active",
        agentId: "default",
        turns: [],
        artifacts: [],
        notifications: [],
        auditRecords: [],
        activeSkills: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      query: "anything",
      mode: "task",
      maxCharacters: 800,
    });

    expect(recalled?.context).toBe("");
    expect(JSON.parse(warnings[0] ?? "{}")).toEqual({
      type: "tessera.memory.startup_failed",
      message: "sqlite unavailable",
    });
  });

  test("uses noop memory manager when memory is explicitly disabled", () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const runtime = createServerMemoryRuntime?.({
      dbPath: "/unused/memory.sqlite",
      disabled: true,
      ownerId: "local-owner",
      createStore() {
        throw new Error("should not create store");
      },
    });

    expect(runtime?.memoryStore).toBeUndefined();
    expect(runtime?.memoryStatus.mode).toBe("disabled");
  });

  test("server stamps stored preference metadata from a save request", () => {
    expect(buildPlaybookRunPreference).toBeDefined();
    const preference = buildPlaybookRunPreference?.(
      "sales.meeting-brief",
      {
        workspaceRoot: "/tmp/workspace",
        assignmentPlan: {
          resolverVersion: 1,
          createdAt: "2026-05-11T00:00:00.000Z",
          assignments: {
            draftBrief: {
              stepId: "draftBrief",
              agentId: "default",
              agentLabel: "Tessera",
              skillCapabilities: [],
              toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
              integrationCapabilities: [],
            },
          },
        },
      },
      new Date("2026-05-12T00:00:00.000Z")
    );

    expect(preference).toMatchObject({
      workspaceRoot: "/tmp/workspace",
      playbookId: "sales.meeting-brief",
      updatedAt: "2026-05-12T00:00:00.000Z",
    });
  });

  test("treats assignment plan validation failures as client recoverable", () => {
    expect(isPlaybookRunPreferenceAssignmentPlanValidationError).toBeDefined();
    expect(
      isPlaybookRunPreferenceAssignmentPlanValidationError?.(
        new Error("Assignment for step draft is stale or does not match the current inventory")
      )
    ).toBe(true);
    expect(
      isPlaybookRunPreferenceAssignmentPlanValidationError?.(
        new Error("Assignment plan includes unknown step: draft")
      )
    ).toBe(true);
    expect(isPlaybookRunPreferenceAssignmentPlanValidationError?.(new Error("boom"))).toBe(false);
  });

  test("builds workflow execution options with the resolved assignment plan and runtime credential", () => {
    expect(buildWorkflowExecutionOptions).toBeDefined();
    const capabilityInventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "default",
          label: "Tessera",
          fingerprint: "ui-b58c78b6",
          model: { provider: "openai-codex", model: "gpt-5.4" },
          modelCapabilities: [],
          dataPolicies: [],
          skillCapabilities: ["skill.planning"],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
        },
      ],
      integrations: [],
    });
    const assignmentPlan = WorkflowRunAssignmentPlanSchema.parse({
      resolverVersion: 1,
      createdAt: "2026-05-12T00:00:00.000Z",
      assignments: {
        draftBrief: {
          stepId: "draftBrief",
          provider: { provider: "openai-codex", model: "gpt-5.4" },
          skillCapabilities: [],
          toolCapabilities: [],
          integrationCapabilities: [],
        },
      },
    });
    const options = buildWorkflowExecutionOptions?.({
      assignmentPlan,
      capabilityInventory,
      credential: {
        authType: "codex-oauth",
        accessToken: "access-token",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    });

    expect(options?.assignmentPlan).toEqual(assignmentPlan);
    expect(options?.capabilityInventory).toEqual(capabilityInventory);
    expect(options?.agentCredential).toEqual({
      authType: "codex-oauth",
      accessToken: "access-token",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  test("attaches playbook memory shadow recall without changing run outputs", async () => {
    expect(attachPlaybookMemoryShadow).toBeDefined();
    const run = {
      runId: "run-shadow",
      workflowId: "ops.weekly-status-digest",
      status: "completed" as const,
      input: { workspaceRoot: "/workspace/acme" },
      outputs: { draft: "original output" },
      sourceGaps: [],
      events: [],
      completedAt: "2026-05-13T00:00:00.000Z",
    };

    const withShadow = await attachPlaybookMemoryShadow?.(run, {
      async recallForPlaybookRun() {
        return {
          mode: "workspace" as const,
          timedOut: false,
          items: [
            {
              memoryId: "memory-playbook-lesson",
              scope: "playbook" as const,
              type: "lesson" as const,
              title: "Prior lesson",
              body: "Check blocked items first.",
              confidence: 0.91,
              freshness: "fresh" as const,
              sourceRefs: [{ type: "event", id: "memory-event-1" }],
              reason: "Prior playbook memory for this workflow.",
            },
          ],
          trace: {
            query: "ops.weekly-status-digest",
            workspaceKey: "workspace:one",
            candidateCount: 1,
            selectedCount: 1,
            omittedReasons: [],
            durationMs: 1,
          },
        };
      },
    });

    expect(withShadow?.outputs).toEqual(run.outputs);
    const shadowEvent = withShadow?.events?.find(
      (event) => event.metadata && "memoryShadow" in event.metadata
    );
    expect(shadowEvent?.message).toBe("Playbook memory shadow recall evaluated");
    expect(shadowEvent?.metadata?.memoryShadow).toMatchObject({
      trace: {
        selectedCount: 1,
      },
      items: [{ memoryId: "memory-playbook-lesson" }],
    });
  });

  test("playbook memory shadow failure records an omitted reason instead of throwing", async () => {
    expect(attachPlaybookMemoryShadow).toBeDefined();
    const run = {
      runId: "run-shadow-failed",
      workflowId: "ops.weekly-status-digest",
      status: "completed" as const,
      input: { workspaceRoot: "/workspace/acme" },
      sourceGaps: [],
      events: [],
      completedAt: "2026-05-13T00:00:00.000Z",
    };

    const withShadow = await attachPlaybookMemoryShadow?.(run, {
      async recallForPlaybookRun() {
        throw new Error("memory unavailable");
      },
    });

    const shadowEvent = withShadow?.events?.find(
      (event) => event.metadata && "memoryShadow" in event.metadata
    );
    expect(shadowEvent?.metadata?.memoryShadow).toMatchObject({
      items: [],
      trace: {
        selectedCount: 0,
        omittedReasons: ["playbook memory shadow recall failed"],
      },
    });
  });
});

describe("Codex OAuth device flow", () => {
  test("requests device code and normalizes the upstream payload", async () => {
    expect(requestCodexDeviceCode).toBeDefined();
    const calls: RecordedFetchCall[] = [];
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        device_auth_id: "device-123",
        interval: 1,
        user_code: "ABCD-EFGH",
      });
    }) as typeof fetch;

    const result = await requestCodexDeviceCode?.(fakeFetch);

    expect(result).toEqual({
      deviceAuthId: "device-123",
      interval: 3,
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  test("reports pending while the user has not authorized the device code", async () => {
    expect(pollCodexDeviceToken).toBeDefined();
    const fakeFetch = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;

    await expect(
      pollCodexDeviceToken?.({ deviceAuthId: "device-123", userCode: "ABCD-EFGH" }, fakeFetch)
    ).resolves.toEqual({ status: "pending" });
  });

  test("exchanges authorized device code for a redacted credential bundle", async () => {
    expect(pollCodexDeviceToken).toBeDefined();
    const calls: RecordedFetchCall[] = [];
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return Response.json({
          authorization_code: "auth-code",
          code_verifier: "code-verifier",
        });
      }
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
    }) as typeof fetch;

    const result = await pollCodexDeviceToken?.(
      { deviceAuthId: "device-123", userCode: "ABCD-EFGH" },
      fakeFetch
    );

    expect(result?.status).toBe("authorized");
    if (result?.status !== "authorized") {
      throw new Error("Expected authorized Codex OAuth result");
    }
    expect(result).toMatchObject({
      credential: {
        authMode: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        tokens: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
        },
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      device_auth_id: "device-123",
      user_code: "ABCD-EFGH",
    });
    expect(calls[1]?.url).toBe("https://auth.openai.com/oauth/token");
    const form = calls[1]?.init?.body as URLSearchParams;
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("code_verifier")).toBe("code-verifier");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    expect(typeof result.credential.lastRefresh).toBe("string");
  });

  test("refreshes an existing token bundle with refresh_token grant", async () => {
    expect(refreshCodexOAuthCredential).toBeDefined();
    const calls: RecordedFetchCall[] = [];
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
      });
    }) as typeof fetch;

    const credential = await refreshCodexOAuthCredential?.(
      {
        authMode: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        tokens: {
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
        },
      },
      fakeFetch
    );

    expect(credential).toMatchObject({
      authMode: "chatgpt",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      tokens: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/token");
    const form = calls[0]?.init?.body as URLSearchParams;
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh-token");
    expect(typeof credential?.lastRefresh).toBe("string");
  });
});
