import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProfile, WorkflowRunAssignmentPlan } from "@tessera/contracts";
import {
  type GraphRunStore,
  type PlaybookGraphAgentAdapterInput,
  compilePlaybookGraph,
  createOptionalCapabilityManager,
  createPlaybookGraphCache,
} from "@tessera/core";
import type { GraphPlaybookRegistryEntry } from "./graph-playbook-registry.js";
import { createPlaybookGraphRunStore } from "./playbook-graph-run-store.js";
import { createPlaybookRunPreferenceStore } from "./playbook-run-preference-store.js";

type RecordedFetchCall = {
  url: string;
  init: Parameters<typeof fetch>[1] | undefined;
};

const originalServe = Bun.serve;
const originalMemoryDisabled = process.env.TESSERA_MEMORY_DISABLED;
const originalGraphRunWorker = process.env.TESSERA_GRAPH_RUN_WORKER;
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
let handleGraphPlaybookImport: typeof import("./server.js").handleGraphPlaybookImport | undefined;
let handleGraphRunCreate: typeof import("./server.js").handleGraphRunCreate | undefined;
let handleGraphRunDrain: typeof import("./server.js").handleGraphRunDrain | undefined;
let handleGraphRunGet: typeof import("./server.js").handleGraphRunGet | undefined;
let handleGraphRunList: typeof import("./server.js").handleGraphRunList | undefined;
let handleGraphRunResume: typeof import("./server.js").handleGraphRunResume | undefined;
let handleGraphRunReviewSurface:
  | typeof import("./server.js").handleGraphRunReviewSurface
  | undefined;
let handleGraphRunGitMilestonePreview:
  | typeof import("./server.js").handleGraphRunGitMilestonePreview
  | undefined;
let handleGraphRunGitMilestoneCommit:
  | typeof import("./server.js").handleGraphRunGitMilestoneCommit
  | undefined;
let handlePlaybookGet: typeof import("./server.js").handlePlaybookGet | undefined;
let handlePlaybookList: typeof import("./server.js").handlePlaybookList | undefined;
let handlePlaybookRunPreferenceRead:
  | typeof import("./server.js").handlePlaybookRunPreferenceRead
  | undefined;
let handlePlaybookRunPreferenceSave:
  | typeof import("./server.js").handlePlaybookRunPreferenceSave
  | undefined;
let createGraphRunWorker: typeof import("./server.js").createGraphRunWorker | undefined;
let drainGraphRunWorkQueue: typeof import("./server.js").drainGraphRunWorkQueue | undefined;
let graphRunWorkspaceContext: typeof import("./server.js").graphRunWorkspaceContext | undefined;
let graphRunAgentProfileForNode:
  | typeof import("./server.js").graphRunAgentProfileForNode
  | undefined;
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
  process.env.TESSERA_GRAPH_RUN_WORKER = "0";

  try {
    const serverModule = await import("./server.js");
    createServerMemoryRuntime = serverModule.createServerMemoryRuntime;
    handleMemoryForget = serverModule.handleMemoryForget;
    handleMemoryReviewDecision = serverModule.handleMemoryReviewDecision;
    handleMemoryReviewList = serverModule.handleMemoryReviewList;
    handleMemoryStatus = serverModule.handleMemoryStatus;
    handleCapabilityBinary = serverModule.handleCapabilityBinary;
    handleCapabilityBinaryInstall = serverModule.handleCapabilityBinaryInstall;
    handleGraphPlaybookInstall = serverModule.handleGraphPlaybookInstall;
    handleGraphPlaybookImport = serverModule.handleGraphPlaybookImport;
    handleGraphRunCreate = serverModule.handleGraphRunCreate;
    handleGraphRunDrain = serverModule.handleGraphRunDrain;
    handleGraphRunGet = serverModule.handleGraphRunGet;
    handleGraphRunList = serverModule.handleGraphRunList;
    handleGraphRunResume = serverModule.handleGraphRunResume;
    handleGraphRunReviewSurface = serverModule.handleGraphRunReviewSurface;
    handleGraphRunGitMilestonePreview = serverModule.handleGraphRunGitMilestonePreview;
    handleGraphRunGitMilestoneCommit = serverModule.handleGraphRunGitMilestoneCommit;
    handlePlaybookGet = serverModule.handlePlaybookGet;
    handlePlaybookList = serverModule.handlePlaybookList;
    handlePlaybookRunPreferenceRead = serverModule.handlePlaybookRunPreferenceRead;
    handlePlaybookRunPreferenceSave = serverModule.handlePlaybookRunPreferenceSave;
    createGraphRunWorker = serverModule.createGraphRunWorker;
    drainGraphRunWorkQueue = serverModule.drainGraphRunWorkQueue;
    graphRunWorkspaceContext = serverModule.graphRunWorkspaceContext;
    graphRunAgentProfileForNode = serverModule.graphRunAgentProfileForNode;
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

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crcTable[index] = crc >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function testAgentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "default",
    name: "Tessera",
    model: { mode: "default" },
    instructions: "",
    soul: "",
    userContext: "",
    skills: [],
    toolPolicyPreset: "workspace_editor",
    memoryDefaults: "",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function testAssignmentPlan(options: {
  agentFingerprint?: string;
  agentId?: string;
  agentLabel?: string;
  createdAt?: string;
  credentialRef?: string;
  providerFingerprint?: string;
  stepId?: string;
  toolCapabilities?: string[];
}): WorkflowRunAssignmentPlan {
  const stepId = options.stepId ?? "score";
  const agentLabel = options.agentLabel ?? "Analyst";
  return {
    resolverVersion: 1,
    createdAt: options.createdAt ?? "2026-05-15T00:00:00.000Z",
    assignments: {
      [stepId]: {
        stepId,
        agentId: options.agentId ?? "analyst",
        agentLabel,
        agentFingerprint:
          options.agentFingerprint ?? `ui-${agentLabel.toLowerCase().replaceAll(" ", "-")}`,
        ...(options.providerFingerprint
          ? { providerFingerprint: options.providerFingerprint }
          : {}),
        ...(options.credentialRef ? { credentialRef: options.credentialRef } : {}),
        skillCapabilities: [],
        toolCapabilities: options.toolCapabilities ?? ["tool.workspace.read"],
        integrationCapabilities: [],
      },
    },
  };
}

async function writeZipArchive(
  root: string,
  entries: Record<string, string | Buffer>
): Promise<string> {
  const archiveName = `archive-${Date.now()}-${Math.random().toString(16).slice(2)}.playbook`;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [path, value] of Object.entries(entries)) {
    const content = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const name = Buffer.from(path, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, content);
    centrals.push(central);
    offset += local.length + content.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const zipPath = join(root, archiveName);
  await writeFile(zipPath, Buffer.concat([...locals, centralDirectory, eocd]));
  return zipPath;
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

function graphPackageArchiveEntries(options: {
  id?: string;
  version: string;
  name?: string;
  metadata?: Record<string, unknown>;
  scriptBody?: string;
  prefix?: string;
}): Record<string, string | Buffer> {
  const id = options.id ?? "content.seo-blog";
  const name = options.name ?? "SEO Blog Article";
  const prefix = options.prefix ? `${options.prefix.replace(/\/$/, "")}/` : "";
  const graph = {
    schemaVersion: 1,
    id,
    version: options.version,
    name,
    ...(options.metadata ? { metadata: options.metadata } : {}),
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
  return {
    [`${prefix}manifest.json`]: JSON.stringify({
      schemaVersion: 1,
      id,
      version: options.version,
      name,
      entrypoint: "playbook.ts",
    }),
    [`${prefix}playbook.ts`]: `import { definePlaybook } from "@tessera/plugin-sdk";
export default definePlaybook(${JSON.stringify(graph, null, 2)});
`,
    [`${prefix}scripts/score.ts`]:
      options.scriptBody ?? "export default async function score() { return { ok: true }; }\n",
    [`${prefix}schemas/scorecard.schema.json`]: '{"type":"object"}\n',
    [`${prefix}assets/icon.png`]: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };
}

function testCompiledGraphSourceFiles(scriptSource = "export default function score() {}\n") {
  return {
    "playbook.ts": "export default graph;\n",
    "scripts/score.ts": scriptSource,
  };
}

function testCompiledGraph(scriptSource?: string) {
  const sourceFiles = testCompiledGraphSourceFiles(scriptSource);
  return compilePlaybookGraph({
    graph: {
      schemaVersion: 1,
      id: "content.seo-blog",
      version: "0.1.0",
      name: "SEO Blog Article",
      artifacts: {
        scorecard: { schema: "schemas/scorecard.schema.json" },
      },
      start: "score",
      nodes: [
        {
          id: "score",
          kind: "script",
          run: "scripts/score.ts",
          inputs: {},
          outputArtifact: "scorecard",
          onSuccess: "completed",
        },
      ],
    },
    sourceFiles,
    compilerVersion: "server-test",
    scriptSdkVersion: "server-test",
    compiledAt: "2026-05-15T00:00:00.000Z",
  });
}

function testReviewCompiledGraph() {
  return compilePlaybookGraph({
    graph: {
      schemaVersion: 1,
      id: "content.review-surface",
      version: "0.1.0",
      name: "Review Surface Graph",
      artifacts: {
        brief: { schema: "schemas/brief.schema.json" },
      },
      start: "draft",
      nodes: [
        {
          id: "draft",
          kind: "script",
          run: "scripts/draft.ts",
          inputs: {},
          outputArtifact: "brief",
          onSuccess: "review",
        },
        {
          id: "review",
          kind: "humanReview",
          artifact: "brief",
          actions: ["approve", "request_changes"],
          onApprove: "completed",
          onRequestChanges: "draft",
        },
      ],
    },
    sourceFiles: {
      "playbook.ts": "export default graph;\n",
      "scripts/draft.ts": "export default function draft() {}\n",
    },
    compilerVersion: "server-test",
    scriptSdkVersion: "server-test",
    compiledAt: "2026-05-15T00:00:00.000Z",
  });
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
  if (originalGraphRunWorker === undefined) {
    process.env.TESSERA_GRAPH_RUN_WORKER = undefined;
  } else {
    process.env.TESSERA_GRAPH_RUN_WORKER = originalGraphRunWorker;
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
        expect.objectContaining({
          id: "content.seo-blog",
          packageVersion: "0.1.0",
          name: "SEO Blog Article",
          graphHash,
          sourceHash: payload.sourceHash,
          installedRoot: join(
            installRoot,
            `v-${Buffer.from("content.seo-blog", "utf8").toString("base64url")}`,
            `v-${Buffer.from("0.1.0", "utf8").toString("base64url")}`
          ),
        }),
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

describe("graph playbook import endpoint", () => {
  test("imports an archive and exposes the latest playbook in list/get", async () => {
    expect(handleGraphPlaybookImport).toBeDefined();
    const archiveRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-archive-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const state: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    const catalogState: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    try {
      const zipPath = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({
          version: "0.1.0",
          name: "Imported SEO Blog Article",
          prefix: "playbook",
        })
      );

      const response = await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import", {
          method: "POST",
          body: JSON.stringify({ zipPath }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          catalogState,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );

      expect(response?.status).toBe(200);
      const imported = (await response?.json()) as Record<string, unknown>;
      expect(imported).toMatchObject({
        schemaVersion: 1,
        status: "installed",
        id: "content.seo-blog",
        version: "0.1.0",
        name: "Imported SEO Blog Article",
        warnings: [],
      });
      expect(catalogState.entries).toHaveLength(1);

      const listResponse = await handlePlaybookList?.(new Request("http://localhost/playbooks"), {
        catalogState,
      });
      expect(listResponse?.status).toBe(200);
      const list = (await listResponse?.json()) as { playbooks: Array<Record<string, unknown>> };
      expect(list.playbooks.find((item) => item.id === "content.seo-blog")).toMatchObject({
        name: "Imported SEO Blog Article",
        packageVersion: "0.1.0",
        businessUseCase: "Imported SEO Blog Article",
      });

      const getResponse = await handlePlaybookGet?.(
        new Request("http://localhost/playbooks/content.seo-blog"),
        "content.seo-blog",
        { catalogState }
      );
      expect(getResponse?.status).toBe(200);
      const detail = (await getResponse?.json()) as Record<string, unknown>;
      expect(detail).toMatchObject({
        id: "content.seo-blog",
        packageVersion: "0.1.0",
        name: "Imported SEO Blog Article",
      });
    } finally {
      await Promise.all(
        [archiveRoot, installRoot, cacheRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });

  test("scopes imported graph playbooks by user key", async () => {
    expect(handleGraphPlaybookImport).toBeDefined();
    expect(handlePlaybookList).toBeDefined();
    expect(handlePlaybookGet).toBeDefined();
    expect(handleGraphRunCreate).toBeDefined();
    const archiveRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-archive-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const zipPath = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({
          version: "0.1.0",
          name: "Imported SEO Blog Article",
          prefix: "playbook",
        })
      );

      const importResponse = await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import?userKey=user-a", {
          method: "POST",
          body: JSON.stringify({ zipPath }),
        }),
        {
          installRoot,
          cacheRoot,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );
      expect(importResponse?.status).toBe(200);
      const imported = (await importResponse?.json()) as {
        id: string;
        graphHash: string;
        sourceHash: string;
      };

      const userAListResponse = await handlePlaybookList?.(
        new Request("http://localhost/playbooks?userKey=user-a"),
        { installRoot, cacheRoot }
      );
      expect(userAListResponse?.status).toBe(200);
      const userAList = (await userAListResponse?.json()) as {
        playbooks: Array<Record<string, unknown>>;
      };
      expect(userAList.playbooks.find((item) => item.id === "content.seo-blog")).toMatchObject({
        name: "Imported SEO Blog Article",
      });

      const userBListResponse = await handlePlaybookList?.(
        new Request("http://localhost/playbooks?userKey=user-b"),
        { installRoot, cacheRoot }
      );
      expect(userBListResponse?.status).toBe(200);
      const userBList = (await userBListResponse?.json()) as {
        playbooks: Array<Record<string, unknown>>;
      };
      expect(userBList.playbooks.find((item) => item.id === "content.seo-blog")).toBeUndefined();

      const userBGetResponse = await handlePlaybookGet?.(
        new Request("http://localhost/playbooks/content.seo-blog?userKey=user-b"),
        "content.seo-blog",
        { installRoot, cacheRoot }
      );
      expect(userBGetResponse?.status).toBe(404);

      const userAGetResponse = await handlePlaybookGet?.(
        new Request("http://localhost/playbooks/content.seo-blog?userKey=user-a"),
        "content.seo-blog",
        { installRoot, cacheRoot }
      );
      expect(userAGetResponse?.status).toBe(200);

      const userARunResponse = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs?userKey=user-a", {
          method: "POST",
          body: JSON.stringify({
            playbookId: imported.id,
            graphHash: imported.graphHash,
            sourceHash: imported.sourceHash,
            input: { topic: "scoped import" },
          }),
        }),
        { store, installRoot, cacheRoot }
      );
      expect(userARunResponse?.status).toBe(200);

      const userBRunResponse = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs?userKey=user-b", {
          method: "POST",
          body: JSON.stringify({
            playbookId: imported.id,
            graphHash: imported.graphHash,
            sourceHash: imported.sourceHash,
            input: { topic: "scoped import" },
          }),
        }),
        { store, installRoot, cacheRoot }
      );
      expect(userBRunResponse?.status).toBe(404);
    } finally {
      store.close();
      await Promise.all(
        [archiveRoot, installRoot, cacheRoot, dirname(dbPath)].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });

  test("lists imported graph playbooks with graph-native metadata", async () => {
    expect(handleGraphPlaybookImport).toBeDefined();
    const archiveRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-archive-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const state: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    const catalogState: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    try {
      const zipPath = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({
          id: "reference.seo-geo-blog-article",
          version: "0.1.0",
          name: "SEO/GEO Blog Article Reference Playbook",
          metadata: {
            requiredCapabilities: ["web.search", "web.fetch"],
            outputs: ["finalArticle", "articleScorecard", "sourceSummary", "finalOutputManifest"],
            phases: ["Intake", "Research", "Brief"],
          },
        })
      );

      const importResponse = await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import", {
          method: "POST",
          body: JSON.stringify({ zipPath }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          catalogState,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );
      expect(importResponse?.status).toBe(200);

      const listResponse = await handlePlaybookList?.(new Request("http://localhost/playbooks"), {
        catalogState,
      });
      expect(listResponse?.status).toBe(200);
      const list = (await listResponse?.json()) as { playbooks: Array<Record<string, unknown>> };
      expect(
        list.playbooks.find((item) => item.id === "reference.seo-geo-blog-article")
      ).toMatchObject({
        name: "SEO/GEO Blog Article Reference Playbook",
        requiredCapabilities: ["web"],
        phases: ["Intake", "Research", "Brief"],
      });
    } finally {
      await Promise.all(
        [archiveRoot, installRoot, cacheRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });

  test("returns 409 for built-in id collisions and same-version source conflicts", async () => {
    expect(handleGraphPlaybookImport).toBeDefined();
    const archiveRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-archive-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const state: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    const catalogState: { entries: GraphPlaybookRegistryEntry[] } = { entries: [] };
    try {
      const builtInCollision = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({ id: "sales.meeting-brief", version: "0.1.0" })
      );
      const first = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({ version: "0.1.0", scriptBody: "export default () => 1;\n" })
      );
      const changed = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({ version: "0.1.0", scriptBody: "export default () => 2;\n" })
      );

      const collisionResponse = await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import", {
          method: "POST",
          body: JSON.stringify({ zipPath: builtInCollision }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          catalogState,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );
      expect(collisionResponse?.status).toBe(409);

      await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import", {
          method: "POST",
          body: JSON.stringify({ zipPath: first }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          catalogState,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );
      const conflictResponse = await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import", {
          method: "POST",
          body: JSON.stringify({ zipPath: changed }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          catalogState,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );
      expect(conflictResponse?.status).toBe(409);
    } finally {
      await Promise.all(
        [archiveRoot, installRoot, cacheRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });
});

describe("playbook run preference endpoints", () => {
  test("saves and reads playbook agent setup by user and workspace", async () => {
    expect(handlePlaybookRunPreferenceRead).toBeDefined();
    expect(handlePlaybookRunPreferenceSave).toBeDefined();
    const dbPath = join(
      await mkdtemp(join(tmpdir(), "tessera-playbook-preferences-")),
      "prefs.sqlite"
    );
    const store = createPlaybookRunPreferenceStore(dbPath);
    try {
      const assignmentPlan = testAssignmentPlan({ agentId: "analyst", agentLabel: "Analyst" });
      const saveResponse = await handlePlaybookRunPreferenceSave?.(
        new Request(
          "http://localhost/playbooks/sales.meeting-brief/run-preference?userKey=user.test",
          {
            method: "POST",
            body: JSON.stringify({
              workspaceRoot: "/tmp/workspace",
              assignmentPlan,
            }),
          }
        ),
        "sales.meeting-brief",
        { store }
      );
      expect(saveResponse?.status).toBe(200);

      const readResponse = await handlePlaybookRunPreferenceRead?.(
        new Request(
          "http://localhost/playbooks/sales.meeting-brief/run-preference?userKey=user.test&workspaceRoot=/tmp/workspace"
        ),
        "sales.meeting-brief",
        { store }
      );
      expect(readResponse?.status).toBe(200);
      const result = (await readResponse?.json()) as {
        preference?: { assignmentPlan?: WorkflowRunAssignmentPlan };
      };
      expect(result.preference?.assignmentPlan?.assignments.score?.agentId).toBe("analyst");

      const otherWorkspaceResponse = await handlePlaybookRunPreferenceRead?.(
        new Request(
          "http://localhost/playbooks/sales.meeting-brief/run-preference?userKey=user.test&workspaceRoot=/tmp/other"
        ),
        "sales.meeting-brief",
        { store }
      );
      expect(otherWorkspaceResponse?.status).toBe(200);
      const otherWorkspace = (await otherWorkspaceResponse?.json()) as { preference?: unknown };
      expect(otherWorkspace.preference).toBeUndefined();
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("graph run endpoints", () => {
  test("resolves graph agent profiles from node assignments", () => {
    expect(graphRunAgentProfileForNode).toBeDefined();
    if (!graphRunAgentProfileForNode) {
      throw new Error("graphRunAgentProfileForNode was not loaded");
    }
    const fallback = testAgentProfile();
    const writer = testAgentProfile({
      id: "writer",
      name: "Writer",
      instructions: "Write the article draft.",
    });

    const resolved = graphRunAgentProfileForNode({
      fallbackAgent: fallback,
      nodeId: "draftArticle",
      run: {
        ownerUserKey: "user.test",
        assignmentPlan: testAssignmentPlan({
          stepId: "draftArticle",
          agentId: "writer",
          agentLabel: "Writer",
        }),
      },
      resolveProfile(agentId, userKey) {
        expect(agentId).toBe("writer");
        expect(userKey).toBe("user.test");
        return writer;
      },
    });

    expect(resolved.name).toBe("Writer");
    const reviewer = testAgentProfile({
      id: "reviewer",
      name: "Reviewer",
      instructions: "Rate the article draft.",
    });
    const overrideResolved = graphRunAgentProfileForNode({
      assignmentPlan: testAssignmentPlan({
        createdAt: "2026-05-15T00:01:00.000Z",
        stepId: "draftArticle",
        agentId: "reviewer",
        agentLabel: "Reviewer",
      }),
      fallbackAgent: fallback,
      nodeId: "draftArticle",
      run: {
        ownerUserKey: "user.test",
        assignmentPlan: testAssignmentPlan({
          stepId: "draftArticle",
          agentId: "writer",
          agentLabel: "Writer",
        }),
      },
      resolveProfile(agentId, userKey) {
        expect(agentId).toBe("reviewer");
        expect(userKey).toBe("user.test");
        return reviewer;
      },
    });
    expect(overrideResolved.name).toBe("Reviewer");
    expect(
      graphRunAgentProfileForNode({
        fallbackAgent: fallback,
        nodeId: "scoreArticle",
        run: { ownerUserKey: "user.test" },
      }).name
    ).toBe("Tessera");
  });

  test("builds bounded workspace context for graph agents", async () => {
    expect(graphRunWorkspaceContext).toBeDefined();
    if (!graphRunWorkspaceContext) throw new Error("graphRunWorkspaceContext was not loaded");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-yumi-workspace-"));
    try {
      await writeGraphPackageFile(
        workspaceRoot,
        "Yumi_Weekly_Status_Digest_2026-05-11.md",
        [
          "# Yumi Weekly Status Digest",
          "",
          "Customer Ops shipped renewal follow-ups and a partner launch plan.",
          "Open item: confirm rollout owners before Friday.",
        ].join("\n")
      );
      await writeGraphPackageFile(
        workspaceRoot,
        "notes/roadmap.txt",
        "Dashboard follow-up: summarize workspace activity even when provider tools are unavailable."
      );

      const context = await graphRunWorkspaceContext({
        input: { workspaceRoot },
      } as unknown as PlaybookGraphAgentAdapterInput);

      expect(context).toContain("Workspace root:");
      expect(context).toContain("Recent workspace files:");
      expect(context).toContain("Yumi_Weekly_Status_Digest_2026-05-11.md");
      expect(context).toContain("notes/roadmap.txt");
      expect(context).toContain("Workspace excerpts:");
      expect(context).toContain("Customer Ops shipped renewal follow-ups");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("creates and reads a graph run from an inline compiled graph", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunGet).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            input: { topic: "durable runtime" },
            assignmentPlan: testAssignmentPlan({}),
          }),
        }),
        { store }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: {
          runId: string;
          status: string;
          snapshot: { snapshotJson: string };
          assignmentPlan?: { assignments: Record<string, { agentId?: string }> };
        };
        queue: Array<{ nodeId: string; status: string }>;
      };
      expect(detail.run.status).toBe("queued");
      expect(detail.run.assignmentPlan?.assignments.score?.agentId).toBe("analyst");
      expect(detail.queue).toHaveLength(1);
      expect(detail.queue[0]).toMatchObject({ nodeId: "score", status: "queued" });

      const getResponse = await handleGraphRunGet?.(
        new Request(`http://localhost/graph-runs/${detail.run.runId}`),
        detail.run.runId,
        { store }
      );
      expect(getResponse?.status).toBe(200);
      const getPayload = (await getResponse?.json()) as typeof detail;
      expect(getPayload.run.snapshot.snapshotJson).toBe(detail.run.snapshot.snapshotJson);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("scopes graph run reads by owner and workspace", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunGet).toBeDefined();
    expect(handleGraphRunList).toBeDefined();
    expect(handleGraphRunReviewSurface).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const workspaceRoot = "/tmp/tessera-workspace-a";
    const scopedPath = `userKey=user-a&workspaceRoot=${encodeURIComponent(workspaceRoot)}`;
    try {
      const createResponse = await handleGraphRunCreate?.(
        new Request(`http://localhost/graph-runs?${scopedPath}`, {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            input: { topic: "durable runtime" },
            workspaceRoot,
          }),
        }),
        { store }
      );
      expect(createResponse?.status).toBe(200);
      const created = (await createResponse?.json()) as {
        run: { runId: string; ownerUserKey?: string };
      };
      expect(created.run.ownerUserKey).toBe("user-a");

      const sameScopeList = await handleGraphRunList?.(
        new Request(`http://localhost/graph-runs?${scopedPath}`),
        { store }
      );
      expect(((await sameScopeList?.json()) as { runs: unknown[] }).runs).toHaveLength(1);

      const otherUserList = await handleGraphRunList?.(
        new Request(
          `http://localhost/graph-runs?userKey=user-b&workspaceRoot=${encodeURIComponent(workspaceRoot)}`
        ),
        { store }
      );
      expect(((await otherUserList?.json()) as { runs: unknown[] }).runs).toHaveLength(0);

      const otherWorkspaceGet = await handleGraphRunGet?.(
        new Request(
          `http://localhost/graph-runs/${created.run.runId}?userKey=user-a&workspaceRoot=${encodeURIComponent("/tmp/tessera-workspace-b")}`
        ),
        created.run.runId,
        { store }
      );
      expect(otherWorkspaceGet?.status).toBe(404);

      const otherUserSurface = await handleGraphRunReviewSurface?.(
        new Request(
          `http://localhost/graph-runs/${created.run.runId}/review-surface?userKey=user-b&workspaceRoot=${encodeURIComponent(workspaceRoot)}`
        ),
        created.run.runId,
        { store }
      );
      expect(otherUserSurface?.status).toBe(404);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("pins graph agent auth fingerprints without persisting raw credentials", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            agentProvider: {
              provider: "openai",
              model: "gpt-test",
              apiKeyEnv: "OPENAI_API_KEY",
            },
            credential: { apiKey: "sk-raw-secret" },
            assignmentPlan: testAssignmentPlan({
              providerFingerprint: "provider:fingerprint",
              credentialRef: "credential-secret-ref",
            }),
          }),
        }),
        { store }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: {
          executionContext?: {
            fingerprints: Record<string, unknown>;
          };
        };
      };
      const fingerprints = detail.run.executionContext?.fingerprints;
      expect(fingerprints?.provider).toBe("openai");
      expect(fingerprints?.model).toBe("gpt-test");
      expect(JSON.stringify(fingerprints)).not.toContain("sk-raw-secret");
      expect(JSON.stringify(fingerprints)).not.toContain("credential-secret-ref");
      expect(JSON.stringify(fingerprints)).toContain("runtimeAuthDigest");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("projects a pure graph run review surface from pinned run state", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunReviewSurface).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const createResponse = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testReviewCompiledGraph(),
            drainDeterministic: true,
          }),
        }),
        {
          store,
          scriptAdapter() {
            return { title: "Stale brief" };
          },
        }
      );

      expect(createResponse?.status).toBe(200);
      const created = (await createResponse?.json()) as {
        run: { runId: string; status: string };
        queue: Array<{ queueEntryId: string; nodeId: string; nodePath: string; status: string }>;
      };
      expect(created.run.status).toBe("blocked");

      const draftEntry = (await store.getQueue(created.run.runId)).find(
        (entry) => entry.nodeId === "draft"
      );
      const reviewEntry = (await store.getQueue(created.run.runId)).find(
        (entry) => entry.nodeId === "review"
      );
      expect(draftEntry).toBeDefined();
      expect(reviewEntry).toBeDefined();
      if (!draftEntry || !reviewEntry) throw new Error("missing review test queue entries");

      await store.updateQueueEntry({
        ...draftEntry,
        status: "skipped",
        updatedAt: "2026-05-15T00:01:00.000Z",
        completedAt: "2026-05-15T00:01:00.000Z",
      });
      await store.addArtifactVersion({
        schemaVersion: 1,
        runId: created.run.runId,
        artifactId: "brief",
        versionId: `${reviewEntry.queueEntryId}:brief:edit`,
        producerQueueEntryId: reviewEntry.queueEntryId,
        nodePath: reviewEntry.nodePath,
        contentHash: "sha256:edited-brief",
        value: { title: "Active brief" },
        createdAt: "2026-05-15T00:02:00.000Z",
      });

      const beforeCounts = {
        queue: (await store.getQueue(created.run.runId)).length,
        artifacts: (await store.listArtifactVersions(created.run.runId)).length,
        reviews: (await store.listReviewEvents(created.run.runId)).length,
      };
      const response = await handleGraphRunReviewSurface?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/review-surface`),
        created.run.runId,
        { store }
      );

      expect(response?.status).toBe(200);
      const surface = (await response?.json()) as {
        activeArtifacts: Array<{ versionId: string; producerStatus?: string; value: unknown }>;
        artifactTimeline: Array<{ versionId: string; active: boolean; producerStatus?: string }>;
        timeline: Array<{ kind: string; artifactId?: string; synthetic: boolean }>;
        actions: Array<{
          decision: string;
          label: string;
          queueEntryId?: string;
          sideEffect: string;
        }>;
        productView?: {
          state: string;
          title: string;
          primaryAction?: { decision: string; label: string; queueEntryId?: string };
          technicalSummary?: { internalStatus: string; queueEntryId?: string };
        };
      };
      expect(surface.activeArtifacts).toHaveLength(1);
      expect(surface.activeArtifacts[0]).toMatchObject({
        versionId: `${reviewEntry.queueEntryId}:brief:edit`,
        producerStatus: "blocked",
        value: { title: "Active brief" },
      });
      expect(surface.artifactTimeline.some((row) => row.producerStatus === "skipped")).toBe(true);
      expect(surface.artifactTimeline.filter((row) => row.active)).toHaveLength(1);
      expect(surface.timeline).toContainEqual(
        expect.objectContaining({
          kind: "synthetic_requested",
          artifactId: "brief",
          synthetic: true,
        })
      );
      expect(surface.actions.map((action) => action.decision).sort()).toEqual([
        "approve",
        "deny",
        "edit_artifact",
        "edit_input",
        "edit_review",
        "request_changes",
      ]);
      expect(surface.actions.find((action) => action.decision === "approve")).toMatchObject({
        label: "Approve brief",
        queueEntryId: reviewEntry.queueEntryId,
      });
      expect(surface.actions.find((action) => action.decision === "request_changes")).toMatchObject(
        {
          queueEntryId: reviewEntry.queueEntryId,
          sideEffect: "invalidate_downstream",
        }
      );
      expect(surface.productView).toMatchObject({
        state: "waiting_for_review",
        title: "Review needed",
        primaryAction: {
          decision: "approve",
          label: "Approve brief",
          queueEntryId: reviewEntry.queueEntryId,
        },
        technicalSummary: {
          internalStatus: "blocked:blocked",
          queueEntryId: reviewEntry.queueEntryId,
        },
      });
      expect({
        queue: (await store.getQueue(created.run.runId)).length,
        artifacts: (await store.listArtifactVersions(created.run.runId)).length,
        reviews: (await store.listReviewEvents(created.run.runId)).length,
      }).toEqual(beforeCounts);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("exposes workspace git milestone preview and commits through the graph run boundary", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunReviewSurface).toBeDefined();
    expect(handleGraphRunGitMilestonePreview).toBeDefined();
    expect(handleGraphRunGitMilestoneCommit).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-graph-workspace-"));
    const store = createPlaybookGraphRunStore(dbPath);
    const gitMilestoneService = {
      preview: mock(async () => ({
        schemaVersion: 1 as const,
        available: true,
        workspaceRoot,
        gitRoot: workspaceRoot,
        branch: "main",
        changedFiles: [{ path: "out/draft.json", status: "M", allowed: true }],
        proposedMessage: "Record graph run milestone",
        dirtyPolicy: "allow_selected_paths" as const,
        unsupportedFeatures: ["push"],
      })),
      commit: mock(
        async (request: {
          runId: string;
          actionSpecId: string;
          affectedPaths: string[];
          message: string;
        }) => ({
          evidence: {
            schemaVersion: 1 as const,
            runId: request.runId,
            actionSpecId: request.actionSpecId,
            affectedPaths: request.affectedPaths,
            commitHash: "abc123",
            committedAt: "2026-05-16T00:00:00.000Z",
            trailers: { "Graph-Run": request.runId, "Action-Spec": request.actionSpecId },
          },
          preview: {
            schemaVersion: 1 as const,
            available: true,
            workspaceRoot,
            gitRoot: workspaceRoot,
            branch: "main",
            changedFiles: [],
            proposedMessage: request.message,
            dirtyPolicy: "allow_selected_paths" as const,
            unsupportedFeatures: ["push"],
          },
        })
      ),
    };
    try {
      const createResponse = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            workspaceRoot,
          }),
        }),
        { store }
      );
      expect(createResponse?.status).toBe(200);
      const created = (await createResponse?.json()) as { run: { runId: string } };

      const surfaceResponse = await handleGraphRunReviewSurface?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/review-surface`),
        created.run.runId,
        { store, gitMilestoneService }
      );
      expect(surfaceResponse?.status).toBe(200);
      const surface = (await surfaceResponse?.json()) as {
        gitMilestone?: { available: boolean; changedFiles: Array<{ path: string }> };
      };
      expect(surface.gitMilestone).toBeUndefined();
      expect(gitMilestoneService.preview).not.toHaveBeenCalled();

      const previewResponse = await handleGraphRunGitMilestonePreview?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/git-milestone/preview`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            actionSpecId: `${created.run.runId}:git_milestone`,
            workspaceRoot,
            affectedPaths: ["out/draft.json"],
          }),
        }),
        created.run.runId,
        { store, gitMilestoneService }
      );
      expect(previewResponse?.status).toBe(200);
      const preview = (await previewResponse?.json()) as {
        available: boolean;
        changedFiles: Array<{ path: string }>;
      };
      expect(preview.available).toBe(true);
      expect(preview.changedFiles[0]?.path).toBe("out/draft.json");
      expect(gitMilestoneService.preview).toHaveBeenCalledTimes(1);

      const commitResponse = await handleGraphRunGitMilestoneCommit?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/git-milestone`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            actionSpecId: `${created.run.runId}:git_milestone`,
            workspaceRoot,
            affectedPaths: ["out/draft.json"],
            message: "Record graph run milestone",
          }),
        }),
        created.run.runId,
        { store, gitMilestoneService }
      );
      expect(commitResponse?.status).toBe(200);
      const commit = (await commitResponse?.json()) as {
        evidence: { runId: string; commitHash: string };
      };
      expect(commit.evidence).toMatchObject({ runId: created.run.runId, commitHash: "abc123" });
      expect(
        (await store.listOperationRecords(created.run.runId)).map((record) => record.status)
      ).toEqual(["started", "succeeded"]);
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("records failed Git milestone operations when commit fails", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunGitMilestoneCommit).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-graph-workspace-"));
    const store = createPlaybookGraphRunStore(dbPath);
    const gitMilestoneService = {
      preview: mock(async () => ({
        schemaVersion: 1 as const,
        available: true,
        workspaceRoot,
        gitRoot: workspaceRoot,
        branch: "main",
        changedFiles: [{ path: "out/draft.json", status: "M", allowed: true }],
        proposedMessage: "Record graph run milestone",
        dirtyPolicy: "allow_selected_paths" as const,
        unsupportedFeatures: ["push"],
      })),
      commit: mock(async () => {
        throw new Error("commit rejected");
      }),
    };
    try {
      const createResponse = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            workspaceRoot,
          }),
        }),
        { store }
      );
      expect(createResponse?.status).toBe(200);
      const created = (await createResponse?.json()) as { run: { runId: string } };

      const commitResponse = await handleGraphRunGitMilestoneCommit?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/git-milestone`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            actionSpecId: `${created.run.runId}:git_milestone`,
            workspaceRoot,
            affectedPaths: ["out/draft.json"],
            message: "Record graph run milestone",
          }),
        }),
        created.run.runId,
        { store, gitMilestoneService }
      );

      expect(commitResponse?.status).toBe(409);
      const records = await store.listOperationRecords(created.run.runId);
      expect(records.map((record) => record.status)).toEqual(["started", "failed"]);
      expect(records[1]).toMatchObject({
        kind: "git_milestone",
        failureReason: "commit rejected",
      });
      expect(records[1]?.operationAttemptId).toBe(records[0]?.operationAttemptId);
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("rolls back local resume mutations when operation ledger transaction fails", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const createResponse = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testReviewCompiledGraph(),
            drainDeterministic: true,
          }),
        }),
        {
          store,
          scriptAdapter() {
            return { title: "Needs review" };
          },
        }
      );
      expect(createResponse?.status).toBe(200);
      const created = (await createResponse?.json()) as {
        run: { runId: string; status: string };
        queue: Array<{ queueEntryId: string; nodeId: string; status: string }>;
      };
      const reviewEntry = created.queue.find((entry) => entry.nodeId === "review");
      expect(created.run.status).toBe("blocked");
      expect(reviewEntry).toBeDefined();
      if (!reviewEntry) throw new Error("missing review queue entry");

      const failOperationLedger = async () => {
        throw new Error("operation ledger unavailable");
      };
      const failingStore: GraphRunStore = {
        ...store,
        addOperationRecord: failOperationLedger,
        applyGraphMutationWithOperationRecord: failOperationLedger,
      };
      const response = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve",
            queueEntryId: reviewEntry.queueEntryId,
          }),
        }),
        created.run.runId,
        { store: failingStore }
      );

      expect(response?.status).toBe(500);
      expect((await store.getRun(created.run.runId))?.status).toBe("blocked");
      expect(
        (await store.getQueue(created.run.runId)).find(
          (entry) => entry.queueEntryId === reviewEntry.queueEntryId
        )?.status
      ).toBe("blocked");
      expect(await store.listReviewEvents(created.run.runId)).toEqual([]);
      expect(await store.listOperationRecords(created.run.runId)).toEqual([]);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("creates graph runs from cache references and pins snapshots for later reads", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-graph-cache-"));
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const compiled = testCompiledGraph();
      await createPlaybookGraphCache(cacheRoot).save(compiled);

      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            playbookId: compiled.metadata.playbookId,
            graphHash: compiled.metadata.graphHash,
            sourceHash: compiled.metadata.sourceHash,
          }),
        }),
        { store, cacheRoot }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { runId: string; snapshot: { graphHash: string; snapshotJson: string } };
      };
      expect(detail.run.snapshot.graphHash).toBe(compiled.metadata.graphHash);

      await rm(cacheRoot, { recursive: true, force: true });
      expect((await store.getRun(detail.run.runId))?.snapshot.snapshotJson).toBe(
        detail.run.snapshot.snapshotJson
      );
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(cacheRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("creates built-in graph runs from bundled registry references", async () => {
    expect(handlePlaybookList).toBeDefined();
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-empty-graph-cache-"));
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const listResponse = await handlePlaybookList?.(
        new Request("http://localhost/playbooks", { method: "GET" })
      );
      expect(listResponse?.status).toBe(200);
      const list = (await listResponse?.json()) as {
        playbooks: Array<{ id: string; graphHash?: string; sourceHash?: string }>;
      };
      const salesMeetingBrief = list.playbooks.find(
        (playbook) => playbook.id === "sales.meeting-brief"
      );
      expect(salesMeetingBrief?.graphHash).toMatch(/^sha256:/);
      const graphHash = salesMeetingBrief?.graphHash;
      const sourceHash = salesMeetingBrief?.sourceHash;
      if (!graphHash) throw new Error("Expected built-in graphHash");
      if (!sourceHash) throw new Error("Expected built-in sourceHash");

      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            playbookId: "sales.meeting-brief",
            graphHash,
            sourceHash,
            agentId: "default",
            input: {
              company: "Acme Corp",
              stakeholder: "Dana Lee",
              meetingDate: "2026-05-17",
              objective: "Prepare renewal discussion.",
              sources: ["web"],
              approvalTarget: "meeting-prep",
              workspaceRoot: "/tmp/workspace",
            },
            workspaceRoot: "/tmp/workspace",
          }),
        }),
        { store, cacheRoot }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: {
          playbookId: string;
          snapshot: { graphHash: string; sourceFiles?: Record<string, string> };
        };
        queue: Array<{ nodeKind: string; status: string }>;
      };
      expect(detail.run.playbookId).toBe("sales.meeting-brief");
      expect(detail.run.snapshot.graphHash).toBe(graphHash);
      expect(detail.run.snapshot.sourceFiles?.["prompts/draft-brief.md"]).toContain(
        "sales meeting brief"
      );
      expect(detail.queue[0]).toMatchObject({ nodeKind: "agent", status: "queued" });
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(cacheRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("drains deterministic nodes when an adapter is explicitly provided", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            drainDeterministic: true,
          }),
        }),
        {
          store,
          scriptAdapter({ node }) {
            return { nodeId: node.id, ok: true };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        queue: Array<{ status: string }>;
        artifacts: unknown[];
      };
      expect(detail.run.status).toBe("completed");
      expect(detail.queue[0]?.status).toBe("succeeded");
      expect(detail.artifacts).toHaveLength(1);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("drains installed graph scripts from pinned source bundles without an injected adapter", async () => {
    expect(handleGraphPlaybookInstall).toBeDefined();
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const sourceRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-source-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const state = { entries: [] as GraphPlaybookRegistryEntry[] };
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      await writeGraphPackage(
        sourceRoot,
        "0.2.0",
        `export default ({ input }) => ({
  topic: input.topic,
  runtime: "pinned-source",
});
`
      );
      const installResponse = await handleGraphPlaybookInstall?.(
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
      expect(installResponse?.status).toBe(200);
      const installed = (await installResponse?.json()) as {
        id: string;
        graphHash: string;
        sourceHash: string;
      };

      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            playbookId: installed.id,
            graphHash: installed.graphHash,
            sourceHash: installed.sourceHash,
            input: { topic: "production scripts" },
            drainDeterministic: true,
          }),
        }),
        { store, installRoot, cacheRoot, graphPlaybookRegistryState: state }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string; snapshot: { sourceFiles?: Record<string, string> } };
        queue: Array<{ status: string }>;
        artifacts: Array<{ value: unknown }>;
      };
      expect(detail.run.status).toBe("completed");
      expect(detail.queue[0]?.status).toBe("succeeded");
      expect(detail.artifacts[0]?.value).toEqual({
        topic: "production scripts",
        runtime: "pinned-source",
      });
      expect(detail.run.snapshot.sourceFiles?.["scripts/score.ts"]).toContain("pinned-source");
    } finally {
      store.close();
      await Promise.all(
        [dirname(dbPath), sourceRoot, installRoot, cacheRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });

  test("uses latest catalog source when archived imports share a graph hash", async () => {
    expect(handleGraphPlaybookImport).toBeDefined();
    expect(handlePlaybookList).toBeDefined();
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const archiveRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-archive-"));
    const installRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-install-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "tessera-sidecar-graph-cache-"));
    const state = { entries: [] as GraphPlaybookRegistryEntry[] };
    const catalogState = { entries: [] as GraphPlaybookRegistryEntry[] };
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const latestArchive = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({
          version: "0.2.0",
          scriptBody: "export default () => ({ source: 'latest' });\n",
        })
      );
      const archivedArchive = await writeZipArchive(
        archiveRoot,
        graphPackageArchiveEntries({
          version: "0.1.0",
          scriptBody: "export default () => ({ source: 'archived' });\n",
        })
      );

      await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import", {
          method: "POST",
          body: JSON.stringify({ zipPath: latestArchive }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          catalogState,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );
      const archivedResponse = await handleGraphPlaybookImport?.(
        new Request("http://localhost/graph-playbooks/import", {
          method: "POST",
          body: JSON.stringify({ zipPath: archivedArchive }),
        }),
        {
          installRoot,
          cacheRoot,
          state,
          catalogState,
          compilerVersion: "server-test",
          scriptSdkVersion: "server-test",
        }
      );
      expect(archivedResponse?.status).toBe(200);
      await expect(archivedResponse?.json()).resolves.toMatchObject({ status: "archived" });

      const listResponse = await handlePlaybookList?.(new Request("http://localhost/playbooks"), {
        catalogState,
      });
      const list = (await listResponse?.json()) as {
        playbooks: Array<{ id: string; graphHash?: string; sourceHash?: string }>;
      };
      const visible = list.playbooks.find((playbook) => playbook.id === "content.seo-blog");
      expect(visible?.graphHash).toMatch(/^sha256:/);
      expect(visible?.sourceHash).toMatch(/^sha256:/);

      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            playbookId: visible?.id,
            graphHash: visible?.graphHash,
            sourceHash: visible?.sourceHash,
            drainDeterministic: true,
          }),
        }),
        { store, installRoot, cacheRoot, graphPlaybookRegistryState: catalogState }
      );
      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { snapshot: { sourceFiles?: Record<string, string> } };
        artifacts: Array<{ value: unknown }>;
      };
      expect(detail.artifacts[0]?.value).toEqual({ source: "latest" });
      expect(detail.run.snapshot.sourceFiles?.["scripts/score.ts"]).toContain("latest");
    } finally {
      store.close();
      await Promise.all(
        [dirname(dbPath), archiveRoot, installRoot, cacheRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
    }
  });

  test("background graph worker executes script nodes from persisted source after restart", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    let store = createPlaybookGraphRunStore(dbPath);
    const sourceFiles = testCompiledGraphSourceFiles(
      "export default ({ input }) => ({ topic: input.topic, resumed: true });\n"
    );
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(
              "export default ({ input }) => ({ topic: input.topic, resumed: true });\n"
            ),
            sourceFiles,
            input: { topic: "restart" },
          }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string; status: string } };
      expect(created.run.status).toBe("queued");
      store.close();

      store = createPlaybookGraphRunStore(dbPath);
      const result = await drainGraphRunWorkQueue({ store });

      expect(result).toMatchObject({ inspected: 1, drained: 1, errors: [] });
      expect((await store.getRun(created.run.runId))?.status).toBe("completed");
      expect((await store.listArtifactVersions(created.run.runId))[0]?.value).toEqual({
        topic: "restart",
        resumed: true,
      });
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("drains artifactWrite nodes when an adapter is explicitly provided", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.materialize",
        version: "0.1.0",
        name: "Materialize Graph",
        artifacts: { draft: { schema: "schemas/draft.schema.json" } },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "script",
            run: "scripts/draft.ts",
            inputs: {},
            outputArtifact: "draft",
            onSuccess: "writeDraft",
          },
          {
            id: "writeDraft",
            kind: "artifactWrite",
            artifact: "draft",
            path: "out/draft.json",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const writes: Array<{ path: string; value: unknown }> = [];
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
          }),
        }),
        {
          store,
          scriptAdapter() {
            return { title: "Draft" };
          },
          artifactWriteAdapter({ node, value }) {
            writes.push({ path: node.path, value });
            return { path: node.path };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
        artifacts: unknown[];
      };
      expect(detail.run.status).toBe("completed");
      expect(detail.queue.find((entry) => entry.nodeId === "writeDraft")?.status).toBe("succeeded");
      expect(detail.artifacts).toHaveLength(1);
      expect(writes).toEqual([{ path: "out/draft.json", value: { title: "Draft" } }]);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("drains agent and tool nodes through sidecar graph adapters", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.agent-tool",
        version: "0.1.0",
        name: "Agent Tool Graph",
        artifacts: {
          draft: { schema: "schemas/draft.schema.json" },
          ticket: { schema: "schemas/ticket.schema.json" },
        },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: {},
            tools: [],
            output: { artifact: "draft" },
            onSuccess: "ticket",
          },
          {
            id: "ticket",
            kind: "tool",
            capability: "integration.crm.write",
            args: {},
            outputArtifact: "ticket",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: {
        "playbook.ts": "export default graph;\n",
        "prompts/draft.md": "Draft the customer follow-up.",
      },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const calls: string[] = [];
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            input: { account: "Acme" },
          }),
        }),
        {
          store,
          agentAdapter({ input, prompt }) {
            calls.push("agent");
            return { status: "completed", text: prompt, account: input.account };
          },
          toolAdapter({ node, artifacts }) {
            calls.push("tool");
            return { capability: node.capability, draft: artifacts.draft };
          },
          toolPolicies: {
            "integration.crm.write": {
              capability: "integration.crm.write",
              idempotent: false,
              sideEffect: "external",
            },
          },
          toolCapabilities: ["integration.crm.write"],
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
        artifacts: Array<{ artifactId: string; value: unknown }>;
      };
      expect(detail.run.status).toBe("completed");
      expect(calls).toEqual(["agent", "tool"]);
      expect(detail.queue.map((entry) => [entry.nodeId, entry.status])).toEqual([
        ["draft", "succeeded"],
        ["ticket", "succeeded"],
      ]);
      expect(detail.artifacts.map((artifact) => artifact.artifactId)).toEqual(["draft", "ticket"]);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("preserves provider token usage in graph agent artifacts", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const originalFetch = globalThis.fetch;
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.agent-usage",
        version: "0.1.0",
        name: "Agent Usage Graph",
        artifacts: {
          draft: { schema: "schemas/draft.schema.json" },
        },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "Draft the customer follow-up.",
            output: { artifact: "draft" },
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    globalThis.fetch = (async () =>
      new Response(
        [
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              output: [
                {
                  content: [
                    {
                      type: "output_text",
                      text: "Draft complete.",
                    },
                  ],
                },
              ],
              usage: {
                input_tokens: 1200,
                output_tokens: 340,
                total_tokens: 1540,
              },
            },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          headers: {
            "content-type": "text/event-stream",
          },
        }
      )) as unknown as typeof fetch;

    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            input: { account: "Acme" },
          }),
        }),
        {
          store,
          agentProvider: { provider: "openai-codex", model: "gpt-5.4" },
          credential: {
            authType: "codex-oauth",
            accessToken: "access-token",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        artifacts: Array<{ artifactId: string; value: unknown }>;
      };
      expect(detail.run.status).toBe("completed");
      expect(detail.artifacts[0]?.artifactId).toBe("draft");
      expect(detail.artifacts[0]?.value).toMatchObject({
        status: "completed",
        text: "Draft complete.",
        usage: {
          inputTokens: 1200,
          outputTokens: 340,
          totalTokens: 1540,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("drains read-only graph tool nodes through the default shell registry", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.shell-tool",
        version: "0.1.0",
        name: "Shell Tool Graph",
        artifacts: {
          search: { schema: "schemas/search.schema.json" },
        },
        start: "search",
        nodes: [
          {
            id: "search",
            kind: "tool",
            capability: "web.search",
            args: { query: "tessera" },
            outputArtifact: "search",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const cliCalls: string[][] = [];
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled, drainDeterministic: true }),
        }),
        {
          store,
          async workspaceCli(args) {
            cliCalls.push(args);
            return {
              stdout: JSON.stringify({
                query: "tessera",
                provider: "brave-search",
                capability: "search",
                cached: false,
                latencyMs: 12,
                results: [
                  {
                    title: "Tessera",
                    url: "https://example.com",
                    snippet: "Agent workspace",
                    source: "example.com",
                    position: 1,
                  },
                ],
              }),
              stderr: "",
              exitCode: 0,
              signal: null,
              durationMs: 12,
            };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
        artifacts: Array<{ artifactId: string; value: unknown }>;
      };
      expect(cliCalls).toEqual([["web-search", "search", "tessera"]]);
      expect(detail.run.status).toBe("completed");
      expect(detail.queue[0]).toMatchObject({ nodeId: "search", status: "succeeded" });
      expect(detail.artifacts[0]?.artifactId).toBe("search");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("blocks write shell subcommands under read-only graph tool capabilities", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.shell-tool-denied",
        version: "0.1.0",
        name: "Shell Tool Denied Graph",
        artifacts: {
          calendar: { schema: "schemas/calendar.schema.json" },
        },
        start: "calendar",
        nodes: [
          {
            id: "calendar",
            kind: "tool",
            capability: "integration.calendar.events.read",
            args: { command: "gcal", subcommand: "delete", args: ["evt-1"] },
            outputArtifact: "calendar",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    let cliCalls = 0;
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled, drainDeterministic: true }),
        }),
        {
          store,
          async workspaceCli() {
            cliCalls += 1;
            return { stdout: "{}", stderr: "", exitCode: 0, signal: null, durationMs: 1 };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string; error?: string };
        queue: Array<{ nodeId: string; status: string; error?: string }>;
      };
      expect(cliCalls).toBe(0);
      expect(detail.run.status).toBe("failed");
      expect(detail.queue[0]).toMatchObject({ nodeId: "calendar", status: "failed" });
      expect(detail.queue[0]?.error).toContain("cannot execute gcal delete");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("drains parallelMap branch work and exposes branch items in graph details", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.parallel-map",
        version: "0.1.0",
        name: "Parallel Map Graph",
        artifacts: {
          items: { schema: "schemas/items.schema.json" },
          result: { schema: "schemas/result.schema.json" },
        },
        start: "items",
        nodes: [
          {
            id: "items",
            kind: "script",
            run: "scripts/items.ts",
            inputs: {},
            outputArtifact: "items",
            onSuccess: "map",
          },
          {
            id: "map",
            kind: "parallelMap",
            items: { artifact: "items", path: "$.rows" },
            branch: {
              start: "score",
              nodes: [
                {
                  id: "score",
                  kind: "script",
                  run: "scripts/score.ts",
                  inputs: {},
                  outputArtifact: "result",
                  onSuccess: "completed",
                },
              ],
            },
            onSuccess: "join",
          },
          {
            id: "join",
            kind: "join",
            inputs: ["result"],
            outputArtifact: "result",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled, drainDeterministic: true }),
        }),
        {
          store,
          scriptAdapter({ node, branchItem }) {
            if (node.id === "items") return { rows: [{ id: "a" }, { id: "b" }] };
            return { branch: branchItem?.value };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        branchItems: Array<{ status: string; value: unknown }>;
        queue: Array<{ nodeId: string; status: string }>;
      };
      expect(detail.run.status).toBe("completed");
      expect(detail.branchItems.map((item) => item.status)).toEqual(["completed", "completed"]);
      expect(detail.branchItems.map((item) => item.value)).toEqual([{ id: "a" }, { id: "b" }]);
      expect(detail.queue.find((entry) => entry.nodeId === "join")?.status).toBe("succeeded");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("approves humanReview nodes nested inside parallelMap branches", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.branch-review",
        version: "0.1.0",
        name: "Branch Review Graph",
        artifacts: {
          items: { schema: "schemas/items.schema.json" },
          draft: { schema: "schemas/draft.schema.json" },
        },
        start: "items",
        nodes: [
          {
            id: "items",
            kind: "script",
            run: "scripts/items.ts",
            inputs: {},
            outputArtifact: "items",
            onSuccess: "map",
          },
          {
            id: "map",
            kind: "parallelMap",
            items: { artifact: "items", path: "$" },
            branch: {
              start: "draft",
              nodes: [
                {
                  id: "draft",
                  kind: "script",
                  run: "scripts/draft.ts",
                  inputs: {},
                  outputArtifact: "draft",
                  onSuccess: "review",
                },
                {
                  id: "review",
                  kind: "humanReview",
                  artifact: "draft",
                  actions: ["approve"],
                  onApprove: "completed",
                },
              ],
            },
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
          }),
        }),
        {
          store,
          scriptAdapter({ node, branchItem }) {
            if (node.id === "items") return [{ id: "a" }];
            return { branch: branchItem?.value };
          },
        }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as {
        run: { runId: string; status: string };
        queue: Array<{ queueEntryId: string; nodeId: string; status: string }>;
      };
      expect(created.run.status).toBe("blocked");
      const reviewEntry = created.queue.find(
        (entry) => entry.nodeId === "review" && entry.status === "blocked"
      );
      expect(reviewEntry).toBeDefined();

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            queueEntryId: reviewEntry?.queueEntryId,
            decision: "approve",
            payload: { approvedBy: "test" },
          }),
        }),
        created.run.runId,
        { store, scriptAdapter() {} }
      );

      expect(resumeResponse?.status).toBe(200);
      const resumed = (await resumeResponse?.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
        branchItems: Array<{ status: string }>;
        reviews: Array<{ decision: string }>;
      };
      expect(resumed.run.status).toBe("completed");
      expect(resumed.queue.find((entry) => entry.nodeId === "review")?.status).toBe("succeeded");
      expect(resumed.branchItems.map((item) => item.status)).toEqual(["completed"]);
      expect(resumed.reviews.map((event) => event.decision)).toEqual(["approved"]);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("materializes artifactWrite nodes inside an explicit workspace root", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-graph-workspace-"));
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.workspace-materialize",
        version: "0.1.0",
        name: "Workspace Materialize Graph",
        artifacts: { draft: { schema: "schemas/draft.schema.json" } },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "script",
            run: "scripts/draft.ts",
            inputs: {},
            outputArtifact: "draft",
            onSuccess: "writeDraft",
          },
          {
            id: "writeDraft",
            kind: "artifactWrite",
            artifact: "draft",
            path: "out/draft.json",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            workspaceRoot,
          }),
        }),
        {
          store,
          scriptAdapter() {
            return { title: "Draft", sections: ["intro", "proof"] };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
      };
      expect(detail.run.status).toBe("completed");
      expect(detail.queue.find((entry) => entry.nodeId === "writeDraft")?.status).toBe("succeeded");
      await expect(readFile(join(workspaceRoot, "out/draft.json"), "utf8")).resolves.toBe(
        `${JSON.stringify({ title: "Draft", sections: ["intro", "proof"] }, null, 2)}\n`
      );
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("materializes declared artifact paths when artifacts are produced", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-graph-workspace-"));
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.declared-materialize",
        version: "0.1.0",
        name: "Declared Materialize Graph",
        artifacts: {
          brief: { schema: "schemas/brief.schema.json", materialize: "outputs/brief.md" },
        },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "script",
            run: "scripts/draft.ts",
            inputs: {},
            outputArtifact: "brief",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            workspaceRoot,
          }),
        }),
        {
          store,
          scriptAdapter() {
            return { markdown: "# Content brief\n\nA concise reviewable brief." };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as { run: { status: string } };
      expect(detail.run.status).toBe("completed");
      await expect(readFile(join(workspaceRoot, "outputs/brief.md"), "utf8")).resolves.toBe(
        "# Content brief\n\nA concise reviewable brief.\n"
      );
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("materializes templated markdown artifact paths from graph agent output", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-graph-workspace-"));
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.workspace-markdown-materialize",
        version: "0.1.0",
        name: "Workspace Markdown Materialize Graph",
        artifacts: { brief: { schema: "schemas/brief.schema.json" } },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "script",
            run: "scripts/draft.ts",
            inputs: {},
            outputArtifact: "brief",
            onSuccess: "writeBrief",
          },
          {
            id: "writeBrief",
            kind: "artifactWrite",
            artifact: "brief",
            path: "Sales Meeting Brief - {{inputs.company}}.md",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            input: { company: "FOMORA/West" },
            workspaceRoot,
          }),
        }),
        {
          store,
          scriptAdapter() {
            return { text: "# Meeting brief\n\nDiscuss expansion.", boundaryViolations: 0 };
          },
        }
      );

      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
      };
      expect(detail.run.status).toBe("completed");
      expect(detail.queue.find((entry) => entry.nodeId === "writeBrief")?.status).toBe("succeeded");
      await expect(
        readFile(join(workspaceRoot, "Sales Meeting Brief - FOMORA West.md"), "utf8")
      ).resolves.toBe("# Meeting brief\n\nDiscuss expansion.\n");
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("resumes artifactWrite materialization from persisted workspace context", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-graph-workspace-"));
    const overrideWorkspaceRoot = await mkdtemp(join(tmpdir(), "tessera-graph-workspace-"));
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.workspace-resume",
        version: "0.1.0",
        name: "Workspace Resume Graph",
        artifacts: { draft: { schema: "schemas/draft.schema.json" } },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "script",
            run: "scripts/draft.ts",
            inputs: {},
            outputArtifact: "draft",
            onSuccess: "review",
          },
          {
            id: "review",
            kind: "humanReview",
            artifact: "draft",
            actions: ["approve"],
            onApprove: "writeDraft",
          },
          {
            id: "writeDraft",
            kind: "artifactWrite",
            artifact: "draft",
            path: "out/resumed-draft.json",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    let store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            workspaceRoot,
          }),
        }),
        {
          store,
          scriptAdapter() {
            return { title: "Restart-safe draft" };
          },
        }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as {
        run: { runId: string; status: string; materialization?: { workspaceRoot: string } };
        queue: Array<{ queueEntryId: string; nodeId: string; status: string }>;
      };
      expect(created.run.status).toBe("blocked");
      expect(created.run.materialization?.workspaceRoot).toBe(workspaceRoot);
      const reviewEntryId = created.queue.find((entry) => entry.nodeId === "review")?.queueEntryId;
      expect(reviewEntryId).toBeDefined();
      store.close();

      store = createPlaybookGraphRunStore(dbPath);
      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            queueEntryId: reviewEntryId,
            decision: "approve",
            payload: { workspaceRoot: overrideWorkspaceRoot },
          }),
        }),
        created.run.runId,
        { store }
      );

      expect(resumeResponse?.status).toBe(200);
      const resumed = (await resumeResponse?.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
      };
      expect(resumed.run.status).toBe("completed");
      expect(resumed.queue.find((entry) => entry.nodeId === "writeDraft")?.status).toBe(
        "succeeded"
      );
      await expect(readFile(join(workspaceRoot, "out/resumed-draft.json"), "utf8")).resolves.toBe(
        `${JSON.stringify({ title: "Restart-safe draft" }, null, 2)}\n`
      );
      await expect(
        readFile(join(overrideWorkspaceRoot, "out/resumed-draft.json"), "utf8")
      ).rejects.toThrow();
    } finally {
      store.close();
      await Promise.all([
        rm(dirname(dbPath), { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(overrideWorkspaceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("lists graph runs and denies blocked graph runs without touching legacy workflow paths", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunList).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.review",
        version: "0.1.0",
        name: "Review Graph",
        artifacts: { draft: { schema: "schemas/draft.schema.json" } },
        start: "review",
        nodes: [
          {
            id: "review",
            kind: "humanReview",
            artifact: "draft",
            actions: ["approve", "deny"],
            onApprove: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
          }),
        }),
        { store, scriptAdapter() {} }
      );
      const detail = (await response?.json()) as {
        run: { runId: string; status: string };
        queue: Array<{ queueEntryId: string; status: string }>;
      };
      expect(detail.run.status).toBe("blocked");

      const listResponse = await handleGraphRunList?.(
        new Request("http://localhost/graph-runs?status=blocked"),
        { store }
      );
      expect(((await listResponse?.json()) as { runs: unknown[] }).runs).toHaveLength(1);

      const limitedListResponse = await handleGraphRunList?.(
        new Request("http://localhost/graph-runs?status=blocked&limit=1"),
        { store }
      );
      expect(((await limitedListResponse?.json()) as { runs: unknown[] }).runs).toHaveLength(1);

      const invalidLimitResponse = await handleGraphRunList?.(
        new Request("http://localhost/graph-runs?limit=0"),
        { store }
      );
      expect(invalidLimitResponse?.status).toBe(400);

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${detail.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: detail.run.runId,
            queueEntryId: detail.queue[0]?.queueEntryId,
            decision: "deny",
          }),
        }),
        detail.run.runId,
        { store }
      );
      expect(resumeResponse?.status).toBe(200);
      expect(((await resumeResponse?.json()) as { run: { status: string } }).run.status).toBe(
        "denied"
      );
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("request changes revisits review nodes without overwriting prior queue entries", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.review-loop",
        version: "0.1.0",
        name: "Review Loop Graph",
        artifacts: { draft: { schema: "schemas/draft.schema.json" } },
        start: "review",
        nodes: [
          {
            id: "review",
            kind: "humanReview",
            artifact: "draft",
            actions: ["approve", "request_changes"],
            onApprove: "completed",
            onRequestChanges: "revise",
          },
          {
            id: "revise",
            kind: "script",
            run: "scripts/revise.ts",
            inputs: { draft: { artifact: "draft" } },
            outputArtifact: "draft",
            onSuccess: "review",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled, drainDeterministic: true }),
        }),
        { store, scriptAdapter() {} }
      );
      const detail = (await response?.json()) as {
        run: { runId: string; status: string };
        queue: Array<{ queueEntryId: string; status: string }>;
      };
      const reviewEntryId = detail.queue[0]?.queueEntryId;
      expect(detail.run.status).toBe("blocked");

      const changeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${detail.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: detail.run.runId,
            queueEntryId: reviewEntryId,
            decision: "request_changes",
          }),
        }),
        detail.run.runId,
        {
          store,
          scriptAdapter() {
            return { revised: true };
          },
        }
      );

      expect(changeResponse?.status).toBe(200);
      const changed = (await changeResponse?.json()) as {
        run: { status: string };
        queue: Array<{ queueEntryId: string; nodeId: string; status: string }>;
      };
      expect(changed.run.status).toBe("blocked");
      expect(changed.queue.map((entry) => entry.queueEntryId)).toEqual([
        `${detail.run.runId}:review`,
        `${detail.run.runId}:review/revise`,
        `${detail.run.runId}:review/revise/review`,
      ]);
      expect(changed.queue.filter((entry) => entry.nodeId === "review")).toHaveLength(2);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("does not approve unsupported blocked graph nodes", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.unsupported",
        version: "0.1.0",
        name: "Unsupported Graph",
        start: "agent",
        nodes: [
          {
            id: "agent",
            kind: "agent",
            prompt: "prompts/write.md",
            inputs: {},
            tools: [],
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled, drainDeterministic: true }),
        }),
        { store, scriptAdapter() {} }
      );
      const detail = (await response?.json()) as {
        run: { runId: string; status: string };
        queue: Array<{ queueEntryId: string; status: string }>;
      };
      expect(detail.run.status).toBe("blocked");

      const approveResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${detail.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: detail.run.runId,
            queueEntryId: detail.queue[0]?.queueEntryId,
            decision: "approve",
          }),
        }),
        detail.run.runId,
        { store }
      );

      expect(approveResponse?.status).toBe(409);
      expect((await store.getRun(detail.run.runId))?.status).toBe("blocked");
      expect((await store.getQueue(detail.run.runId))[0]?.status).toBe("blocked");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker drains queued runs outside request handlers", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(createGraphRunWorker).toBeDefined();
    if (!createGraphRunWorker) throw new Error("createGraphRunWorker was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string; status: string };
      };
      expect(detail.run.status).toBe("queued");

      let calls = 0;
      const worker = createGraphRunWorker({
        store,
        scriptAdapter({ node }) {
          calls += 1;
          return { nodeId: node.id, ok: true };
        },
      });
      const result = await worker.tick();

      expect(result).toMatchObject({ inspected: 1, drained: 1, errors: [] });
      expect(calls).toBe(1);
      expect((await store.getRun(detail.run.runId))?.status).toBe("completed");
      expect((await store.getQueue(detail.run.runId))[0]?.status).toBe("succeeded");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("drain endpoint continues queued agent work with request runtime", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunDrain).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!handleGraphRunDrain) throw new Error("handleGraphRunDrain was not loaded");
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.agent-drain",
        version: "0.1.0",
        name: "Agent Drain",
        artifacts: {
          plan: { schema: "schemas/plan.schema.json" },
          draft: { schema: "schemas/draft.schema.json" },
        },
        start: "plan",
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "draft",
          },
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: { plan: { artifact: "plan" } },
            tools: [],
            output: { artifact: "draft", schema: "schemas/draft.schema.json" },
          },
        ],
      },
      sourceFiles: {
        "playbook.ts": "export default graph;\n",
        "scripts/plan.ts": "export default () => ({ title: 'Plan' });\n",
        "prompts/draft.md": "Draft the plan.",
      },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };

      await drainGraphRunWorkQueue({
        store,
        scriptAdapter() {
          return { title: "Plan" };
        },
      });
      const queuedDraft = (await store.getQueue(created.run.runId)).find(
        (entry) => entry.nodeId === "draft"
      );
      expect(queuedDraft?.status).toBe("queued");

      let agentCalls = 0;
      const drainResponse = await handleGraphRunDrain(
        new Request(`http://localhost/graph-runs/${created.run.runId}/drain`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        created.run.runId,
        {
          store,
          agentAdapter({ artifacts }) {
            agentCalls += 1;
            return { status: "completed", text: `Done: ${JSON.stringify(artifacts.plan)}` };
          },
        }
      );

      expect(drainResponse.status).toBe(200);
      const drained = (await drainResponse.json()) as {
        run: { status: string };
        queue: Array<{ nodeId: string; status: string }>;
      };
      expect(agentCalls).toBe(1);
      expect(drained.run.status).toBe("completed");
      expect(drained.queue.find((entry) => entry.nodeId === "draft")?.status).toBe("succeeded");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("drain endpoint persists assignment plans for node profile resolution", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunDrain).toBeDefined();
    expect(graphRunAgentProfileForNode).toBeDefined();
    if (!handleGraphRunDrain) throw new Error("handleGraphRunDrain was not loaded");
    if (!graphRunAgentProfileForNode) {
      throw new Error("graphRunAgentProfileForNode was not loaded");
    }
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };
      const assignmentPlan = testAssignmentPlan({});

      const drainResponse = await handleGraphRunDrain(
        new Request(`http://localhost/graph-runs/${created.run.runId}/drain`, {
          method: "POST",
          body: JSON.stringify({ assignmentPlan }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter() {
            return { ok: true };
          },
        }
      );

      expect(drainResponse.status).toBe(200);
      const run = await store.getRun(created.run.runId);
      expect(run?.assignmentPlan?.assignments.score?.agentId).toBe("analyst");
      const fallback = testAgentProfile();
      const analyst = graphRunAgentProfileForNode({
        fallbackAgent: fallback,
        nodeId: "score",
        run: run ?? { ownerUserKey: "user.test" },
        resolveProfile(agentId) {
          expect(agentId).toBe("analyst");
          return { ...fallback, id: "analyst", name: "Analyst" };
        },
      });
      expect(analyst.name).toBe("Analyst");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("blocks graph work on execution context drift and resumes after approval", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const originalContext = {
      provider: "openai:gpt-5.4",
      account: "acct-a:fingerprint",
      budget: { maxUsd: 5 },
    };
    const changedContext = {
      provider: "openai:gpt-5.4",
      account: "acct-b:fingerprint",
      budget: { maxUsd: 5 },
    };
    const assignmentPlan = testAssignmentPlan({});
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            executionContext: originalContext,
          }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as {
        run: { runId: string; status: string; executionContext?: { fingerprints: unknown } };
      };
      expect(created.run.status).toBe("queued");
      expect(created.run.executionContext?.fingerprints).toEqual(originalContext);

      let calls = 0;
      const workerResult = await drainGraphRunWorkQueue({
        store,
        executionContext: changedContext,
        scriptAdapter() {
          calls += 1;
          return { ok: true };
        },
      });

      expect(workerResult).toMatchObject({ inspected: 1, drained: 1, errors: [] });
      expect(calls).toBe(0);
      expect((await store.getRun(created.run.runId))?.status).toBe("blocked");
      expect((await store.getRun(created.run.runId))?.blockedReason).toContain(
        "execution context changed"
      );
      expect((await store.getQueue(created.run.runId))[0]?.status).toBe("queued");

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve_context_change",
            executionContext: changedContext,
            assignmentPlan,
          }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter() {
            calls += 1;
            return { ok: true };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const resumed = (await resumeResponse?.json()) as {
        run: { status: string; executionContext?: { fingerprints: Record<string, unknown> } };
        queue: Array<{ status: string }>;
      };
      expect(resumed.run.status).toBe("completed");
      expect(resumed.run.executionContext?.fingerprints.account).toBe("acct-b:fingerprint");
      expect(
        (await store.getRun(created.run.runId))?.assignmentPlan?.assignments.score?.agentId
      ).toBe("analyst");
      expect(resumed.queue[0]?.status).toBe("succeeded");
      expect(calls).toBe(1);

      const redundantResumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve_context_change",
            executionContext: changedContext,
          }),
        }),
        created.run.runId,
        { store }
      );
      expect(redundantResumeResponse?.status).toBe(409);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("approving context drift requeues stale agent work before draining", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.agent-drift",
        version: "0.1.0",
        name: "Agent Drift Graph",
        artifacts: {
          draft: { schema: "schemas/draft.schema.json" },
        },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: {},
            tools: [],
            output: { artifact: "draft" },
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: {
        "playbook.ts": "export default graph;\n",
        "prompts/draft.md": "Draft the brief.",
      },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const originalContext = {
      provider: "openai:gpt-5.4",
      account: "acct-a:fingerprint",
    };
    const changedContext = {
      provider: "openai:gpt-5.4",
      account: "acct-b:fingerprint",
    };
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            executionContext: originalContext,
          }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };
      const claimed = await store.claimNextQueuedEntry({
        runId: created.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      });
      if (!claimed) throw new Error("Missing claimed queue entry");
      const run = await store.getRun(created.run.runId);
      if (!run) throw new Error("Missing graph run");
      await store.updateRun({
        ...run,
        status: "running",
        currentQueueEntryId: claimed.queueEntryId,
        updatedAt: "2026-05-15T00:00:00.000Z",
      });

      const workerResult = await drainGraphRunWorkQueue({
        store,
        now: () => "2026-05-15T00:00:02.000Z",
        executionContext: changedContext,
        agentAdapter() {
          throw new Error("agent should not run before context approval");
        },
      });

      expect(workerResult).toMatchObject({ blocked: 1, drained: 1, errors: [] });
      expect((await store.getRun(created.run.runId))?.blockedReason).toContain(
        "execution context changed"
      );
      expect((await store.getQueue(created.run.runId))[0]?.status).toBe("running");

      let calls = 0;
      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve_context_change",
            executionContext: changedContext,
          }),
        }),
        created.run.runId,
        {
          store,
          now: () => "2026-05-15T00:00:03.000Z",
          agentAdapter() {
            calls += 1;
            return { status: "completed", text: "ready" };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const resumed = (await resumeResponse?.json()) as {
        run: { status: string };
        queue: Array<{ status: string }>;
      };
      expect(resumed.run.status).toBe("completed");
      expect(resumed.queue[0]?.status).toBe("succeeded");
      expect(calls).toBe(1);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("retrying interrupted work clears stale context blocks before draining", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.agent-retry-context",
        version: "0.1.0",
        name: "Agent Retry Context Graph",
        artifacts: {
          draft: { schema: "schemas/draft.schema.json" },
        },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: {},
            tools: [],
            output: { artifact: "draft" },
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: {
        "playbook.ts": "export default graph;\n",
        "prompts/draft.md": "Draft the brief.",
      },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const originalContext = {
      provider: "openai:gpt-5.4",
      account: "acct-a:fingerprint",
    };
    const changedContext = {
      provider: "openai:gpt-5.4",
      account: "acct-b:fingerprint",
    };
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            executionContext: originalContext,
          }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };
      const [entry] = await store.getQueue(created.run.runId);
      const run = await store.getRun(created.run.runId);
      if (!run || !entry) throw new Error("Missing graph run");
      await store.updateQueueEntry({
        ...entry,
        status: "interrupted",
        attempt: 1,
        updatedAt: "2026-05-15T00:00:02.000Z",
      });
      await store.updateRun({
        ...run,
        status: "blocked",
        currentQueueEntryId: entry.queueEntryId,
        blockedReason:
          "Graph execution context changed; expected sha256:old, got sha256:new. Approval is required before continuing.",
        updatedAt: "2026-05-15T00:00:02.000Z",
      });

      let calls = 0;
      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "retry_interrupted",
            queueEntryId: entry.queueEntryId,
            executionContext: changedContext,
          }),
        }),
        created.run.runId,
        {
          store,
          now: () => "2026-05-15T00:00:03.000Z",
          agentAdapter() {
            calls += 1;
            return { status: "completed", text: "ready" };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const resumed = (await resumeResponse?.json()) as {
        run: {
          status: string;
          blockedReason?: string;
          executionContext?: { fingerprints: Record<string, unknown> };
        };
        queue: Array<{ status: string }>;
      };
      expect(resumed.run.status).toBe("completed");
      expect(resumed.run.blockedReason).toBeUndefined();
      expect(resumed.run.executionContext?.fingerprints.account).toBe("acct-b:fingerprint");
      expect(resumed.queue[0]?.status).toBe("succeeded");
      expect(calls).toBe(1);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("request resume renews long-running agent leases while draining", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.agent-long-resume",
        version: "0.1.0",
        name: "Long Resume Agent Graph",
        artifacts: {
          draft: { schema: "schemas/draft.schema.json" },
        },
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: {},
            tools: [],
            output: { artifact: "draft" },
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: {
        "playbook.ts": "export default graph;\n",
        "prompts/draft.md": "Draft the article.",
      },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });

    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };
      const [entry] = await store.getQueue(created.run.runId);
      const run = await store.getRun(created.run.runId);
      if (!run || !entry) throw new Error("Missing graph run");
      await store.updateQueueEntry({
        ...entry,
        status: "interrupted",
        blockedReason: "stale runtime lease",
        updatedAt: new Date().toISOString(),
      });
      await store.updateRun({
        ...run,
        status: "interrupted",
        currentQueueEntryId: entry.queueEntryId,
        updatedAt: new Date().toISOString(),
      });

      let calls = 0;
      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "retry_interrupted",
            queueEntryId: entry.queueEntryId,
          }),
        }),
        created.run.runId,
        {
          store,
          leaseMs: 40,
          async agentAdapter() {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 90));
            return { status: "completed", text: "ready" };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const resumed = (await resumeResponse?.json()) as {
        run: { status: string };
        queue: Array<{ status: string }>;
      };
      expect(resumed.run.status).toBe("completed");
      expect(resumed.queue[0]?.status).toBe("succeeded");
      expect(calls).toBe(1);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("approves repair continuations without changing the pinned snapshot", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as {
        run: { runId: string; snapshot: { snapshotHash: string } };
      };
      const run = await store.getRun(created.run.runId);
      if (!run) throw new Error("Missing graph run");
      await store.updateRun({
        ...run,
        status: "needs_repair",
        repairReason: "operator verified snapshot repair",
        updatedAt: "2026-05-15T00:00:01.000Z",
      });

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve_repair",
          }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter() {
            return { repaired: true };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const resumed = (await resumeResponse?.json()) as {
        run: { status: string; snapshot: { snapshotHash: string } };
        queue: Array<{ status: string }>;
      };
      expect(resumed.run.status).toBe("completed");
      expect(resumed.run.snapshot.snapshotHash).toBe(created.run.snapshot.snapshotHash);
      expect(resumed.queue[0]?.status).toBe("succeeded");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("repair approval must replace corrupted pinned snapshots before resume", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = testCompiledGraph();
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as {
        run: { runId: string; snapshot: { snapshotHash: string } };
      };
      const run = await store.getRun(created.run.runId);
      if (!run) throw new Error("Missing graph run");
      await store.updateRun({
        ...run,
        snapshot: { ...run.snapshot, snapshotJson: '{"tampered":true}' },
        status: "needs_repair",
        repairReason: "Pinned graph snapshot hash mismatch",
        updatedAt: "2026-05-15T00:00:01.000Z",
      });

      const missingRepairResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve_repair",
          }),
        }),
        created.run.runId,
        { store }
      );
      expect(missingRepairResponse?.status).toBe(409);

      const repairedResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve_repair",
            payload: { compiledGraph: compiled },
          }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter() {
            return { repaired: true };
          },
        }
      );

      expect(repairedResponse?.status).toBe(200);
      const repaired = (await repairedResponse?.json()) as {
        run: { status: string; snapshot: { snapshotHash: string; snapshotJson: string } };
      };
      expect(repaired.run.status).toBe("completed");
      expect(repaired.run.snapshot.snapshotHash).toBe(created.run.snapshot.snapshotHash);
      expect(repaired.run.snapshot.snapshotJson).not.toBe('{"tampered":true}');
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("repair approval rejects replacement graphs that need queue migration", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = testCompiledGraph();
    const replacement = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.seo-blog",
        version: "0.1.0",
        name: "SEO Blog Article",
        artifacts: {
          scorecard: { schema: "schemas/scorecard.schema.json" },
        },
        start: "other",
        nodes: [
          {
            id: "other",
            kind: "script",
            run: "scripts/other.ts",
            inputs: {},
            outputArtifact: "scorecard",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: {
        "playbook.ts": "export default graph;\n",
        "scripts/other.ts": "export default function other() {}\n",
      },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };
      const run = await store.getRun(created.run.runId);
      if (!run) throw new Error("Missing graph run");
      await store.updateRun({
        ...run,
        status: "needs_repair",
        repairReason: "operator requested replacement",
        updatedAt: "2026-05-15T00:00:01.000Z",
      });

      const repairResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "approve_repair",
            payload: { compiledGraph: replacement },
          }),
        }),
        created.run.runId,
        { store }
      );

      expect(repairResponse?.status).toBe(409);
      const repairError = (await repairResponse?.json()) as { error: string };
      expect(repairError.error).toContain("graphHash");
      expect((await store.getRun(created.run.runId))?.status).toBe("needs_repair");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("artifact edits invalidate only downstream consumers", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.edit-artifact",
        version: "0.1.0",
        name: "Edit Artifact Graph",
        artifacts: {
          plan: { schema: "schemas/plan.schema.json" },
          score: { schema: "schemas/score.schema.json" },
        },
        start: "plan",
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "score",
          },
          {
            id: "score",
            kind: "script",
            run: "scripts/score.ts",
            inputs: { plan: { artifact: "plan" } },
            outputArtifact: "score",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    const calls: string[] = [];
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled, drainDeterministic: true }),
        }),
        {
          store,
          scriptAdapter({ node, artifacts }) {
            calls.push(node.id);
            if (node.id === "plan") return { title: "Original" };
            return { scoredFrom: artifacts.plan };
          },
        }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };
      expect(calls).toEqual(["plan", "score"]);
      calls.length = 0;

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "edit_artifact",
            payload: { artifactId: "plan", value: { title: "Edited" } },
          }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter({ node, artifacts }) {
            calls.push(node.id);
            if (node.id === "plan") return { title: "Unexpected rerun" };
            return { scoredFrom: artifacts.plan };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const edited = (await resumeResponse?.json()) as {
        run: { status: string };
        queue: Array<{
          nodeId: string;
          status: string;
          consumesArtifacts: Array<{ artifactId: string; versionId: string }>;
        }>;
        artifacts: Array<{ artifactId: string; value: unknown }>;
      };
      expect(edited.run.status).toBe("completed");
      expect(calls).toEqual(["score"]);
      expect(edited.queue.find((entry) => entry.nodeId === "plan")?.status).toBe("succeeded");
      const scoreEntry = edited.queue.find((entry) => entry.nodeId === "score");
      expect(scoreEntry?.status).toBe("succeeded");
      expect(scoreEntry?.consumesArtifacts[0]?.artifactId).toBe("plan");
      expect(edited.artifacts.filter((artifact) => artifact.artifactId === "plan")).toHaveLength(2);
      expect(edited.artifacts.at(-1)?.value).toEqual({ scoredFrom: { title: "Edited" } });
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("input edits refresh downstream artifact refs after upstream reruns", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.edit-input",
        version: "0.1.0",
        name: "Edit Input Graph",
        artifacts: {
          plan: { schema: "schemas/plan.schema.json" },
          score: { schema: "schemas/score.schema.json" },
        },
        start: "plan",
        nodes: [
          {
            id: "plan",
            kind: "script",
            run: "scripts/plan.ts",
            inputs: {},
            outputArtifact: "plan",
            onSuccess: "score",
          },
          {
            id: "score",
            kind: "script",
            run: "scripts/score.ts",
            inputs: { plan: { artifact: "plan" } },
            outputArtifact: "score",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            input: { title: "Original" },
          }),
        }),
        {
          store,
          scriptAdapter({ node, input, artifacts }) {
            if (node.id === "plan") return { title: input.title };
            return { scoredFrom: artifacts.plan };
          },
        }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "edit_input",
            payload: { input: { title: "Edited" } },
          }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter({ node, input, artifacts }) {
            if (node.id === "plan") return { title: input.title };
            return { scoredFrom: artifacts.plan };
          },
        }
      );

      const edited = (await resumeResponse?.json()) as {
        run: { status: string };
        queue: Array<{
          nodeId: string;
          consumesArtifacts: Array<{ artifactId: string; versionId: string }>;
        }>;
        artifacts: Array<{ artifactId: string; versionId: string; value: unknown }>;
      };
      if (resumeResponse?.status !== 200) {
        throw new Error(JSON.stringify(edited));
      }
      const planVersions = edited.artifacts.filter((artifact) => artifact.artifactId === "plan");
      const latestPlan = planVersions.at(-1);
      const scoreEntry = edited.queue.find((entry) => entry.nodeId === "score");
      expect(edited.run.status).toBe("completed");
      expect(planVersions).toHaveLength(2);
      expect(latestPlan?.value).toEqual({ title: "Edited" });
      expect(scoreEntry?.consumesArtifacts[0]?.versionId).toBe(latestPlan?.versionId);
      expect(edited.artifacts.at(-1)?.value).toEqual({ scoredFrom: { title: "Edited" } });
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("input edits skip stale parallelMap branch rows before refan-out", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.edit-map",
        version: "0.1.0",
        name: "Edit Map Graph",
        artifacts: {
          items: { schema: "schemas/items.schema.json" },
          result: { schema: "schemas/result.schema.json" },
        },
        start: "items",
        nodes: [
          {
            id: "items",
            kind: "script",
            run: "scripts/items.ts",
            inputs: {},
            outputArtifact: "items",
            onSuccess: "map",
          },
          {
            id: "map",
            kind: "parallelMap",
            items: { artifact: "items", path: "$.rows" },
            branch: {
              start: "score",
              nodes: [
                {
                  id: "score",
                  kind: "script",
                  run: "scripts/score.ts",
                  inputs: {},
                  outputArtifact: "result",
                  onSuccess: "completed",
                },
              ],
            },
            onSuccess: "join",
          },
          {
            id: "join",
            kind: "join",
            inputs: ["result"],
            outputArtifact: "result",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            input: { rows: [{ id: "a" }, { id: "b" }, { id: "c" }] },
          }),
        }),
        {
          store,
          scriptAdapter({ node, input, branchItem }) {
            if (node.id === "items") return { rows: input.rows };
            return { branch: branchItem?.value };
          },
        }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "edit_input",
            payload: { input: { rows: [{ id: "a2" }] } },
          }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter({ node, input, branchItem }) {
            if (node.id === "items") return { rows: input.rows };
            return { branch: branchItem?.value };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const edited = (await resumeResponse?.json()) as {
        run: { status: string };
        branchItems: Array<{ index: number; status: string; value?: unknown }>;
        queue: Array<{ nodePath: string; status: string }>;
      };
      expect(edited.run.status).toBe("completed");
      expect(
        edited.branchItems
          .sort((left, right) => left.index - right.index)
          .map((item) => [item.index, item.status, item.value])
      ).toEqual([
        [0, "completed", { id: "a2" }],
        [1, "skipped", { id: "b" }],
        [2, "skipped", { id: "c" }],
      ]);
      expect(
        edited.queue
          .filter(
            (entry) => entry.nodePath.includes("/item:1/") || entry.nodePath.includes("/item:2/")
          )
          .map((entry) => entry.status)
      ).toEqual(["skipped", "skipped"]);
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("input edits to empty parallelMap items do not expose stale branch artifacts", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunResume).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.edit-map-empty",
        version: "0.1.0",
        name: "Edit Empty Map Graph",
        artifacts: {
          items: { schema: "schemas/items.schema.json" },
          result: { schema: "schemas/result.schema.json" },
          final: { schema: "schemas/final.schema.json" },
        },
        start: "items",
        nodes: [
          {
            id: "items",
            kind: "script",
            run: "scripts/items.ts",
            inputs: {},
            outputArtifact: "items",
            onSuccess: "map",
          },
          {
            id: "map",
            kind: "parallelMap",
            items: { artifact: "items", path: "$.rows" },
            branch: {
              start: "score",
              nodes: [
                {
                  id: "score",
                  kind: "script",
                  run: "scripts/score.ts",
                  inputs: {},
                  outputArtifact: "result",
                  onSuccess: "completed",
                },
              ],
            },
            onSuccess: "after",
          },
          {
            id: "after",
            kind: "script",
            run: "scripts/after.ts",
            inputs: { result: { artifact: "result" } },
            outputArtifact: "final",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: compiled,
            drainDeterministic: true,
            input: { rows: [{ id: "a" }] },
          }),
        }),
        {
          store,
          scriptAdapter({ node, input, artifacts, branchItem }) {
            if (node.id === "items") return { rows: input.rows };
            if (node.id === "score") return { branch: branchItem?.value };
            return { seen: artifacts.result ?? null };
          },
        }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };

      const resumeResponse = await handleGraphRunResume?.(
        new Request(`http://localhost/graph-runs/${created.run.runId}/resume`, {
          method: "POST",
          body: JSON.stringify({
            runId: created.run.runId,
            decision: "edit_input",
            payload: { input: { rows: [] } },
          }),
        }),
        created.run.runId,
        {
          store,
          scriptAdapter({ node, input, artifacts, branchItem }) {
            if (node.id === "items") return { rows: input.rows };
            if (node.id === "score") return { branch: branchItem?.value };
            return { seen: artifacts.result ?? null };
          },
        }
      );

      expect(resumeResponse?.status).toBe(200);
      const edited = (await resumeResponse?.json()) as {
        run: { status: string };
        artifacts: Array<{ artifactId: string; value: unknown }>;
        branchItems: Array<{ status: string }>;
      };
      expect(edited.run.status).toBe("completed");
      expect(edited.branchItems.map((item) => item.status)).toEqual(["skipped"]);
      expect(
        edited.artifacts.filter((artifact) => artifact.artifactId === "final").at(-1)?.value
      ).toEqual({ seen: null });
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker blocks drift before recovering stale leases", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const originalContext = {
      provider: "openai:gpt-5.4",
      account: "acct-a:fingerprint",
    };
    const changedContext = {
      provider: "openai:gpt-5.4",
      account: "acct-b:fingerprint",
    };
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({
            compiledGraph: testCompiledGraph(),
            executionContext: originalContext,
          }),
        }),
        { store }
      );
      expect(response?.status).toBe(200);
      const created = (await response?.json()) as { run: { runId: string } };
      const claimed = await store.claimNextQueuedEntry({
        runId: created.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      });
      if (!claimed) throw new Error("Missing claimed queue entry");
      const run = await store.getRun(created.run.runId);
      if (!run) throw new Error("Missing graph run");
      await store.updateRun({
        ...run,
        status: "running",
        currentQueueEntryId: claimed.queueEntryId,
        updatedAt: "2026-05-15T00:00:00.000Z",
      });
      let calls = 0;

      const workerResult = await drainGraphRunWorkQueue({
        store,
        now: () => "2026-05-15T00:00:02.000Z",
        executionContext: changedContext,
        scriptAdapter() {
          calls += 1;
          return { ok: true };
        },
      });

      expect(workerResult).toMatchObject({
        inspected: 1,
        recovered: 0,
        requeued: 0,
        blocked: 1,
        drained: 1,
        errors: [],
      });
      expect(calls).toBe(0);
      expect((await store.getRun(created.run.runId))?.status).toBe("blocked");
      const queueEntry = (await store.getQueue(created.run.runId))[0];
      expect(queueEntry?.status).toBe("running");
      expect(queueEntry?.runtimeId).toBe("old-runtime");
      expect(queueEntry?.leaseId).toBe("old-lease");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker deduplicates overlapping ticks", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(createGraphRunWorker).toBeDefined();
    if (!createGraphRunWorker) throw new Error("createGraphRunWorker was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string };
      };
      let calls = 0;
      const worker = createGraphRunWorker({
        store,
        async scriptAdapter() {
          calls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return { ok: true };
        },
      });

      const [first, second] = await Promise.all([worker.tick(), worker.tick()]);

      expect(first).toEqual(second);
      expect(first).toMatchObject({ inspected: 1, drained: 1, errors: [] });
      expect(calls).toBe(1);
      expect((await store.getRun(detail.run.runId))?.status).toBe("completed");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker recovers stale rerunnable leases before draining", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string };
      };
      const claimed = await store.claimNextQueuedEntry({
        runId: detail.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      });
      expect(claimed?.status).toBe("running");
      const run = await store.getRun(detail.run.runId);
      if (!run || !claimed) throw new Error("Missing claimed graph run");
      await store.updateRun({
        ...run,
        status: "running",
        currentQueueEntryId: claimed.queueEntryId,
        updatedAt: "2026-05-15T00:00:00.000Z",
      });
      let tick = 2;
      let calls = 0;

      const result = await drainGraphRunWorkQueue({
        store,
        runtimeId: "worker-runtime",
        now: () => `2026-05-15T00:00:${String(tick++).padStart(2, "0")}.000Z`,
        scriptAdapter() {
          calls += 1;
          return { ok: true };
        },
      });

      expect(result).toMatchObject({
        inspected: 1,
        recovered: 1,
        requeued: 1,
        drained: 1,
        errors: [],
      });
      expect(calls).toBe(1);
      expect((await store.getRun(detail.run.runId))?.status).toBe("completed");
      expect((await store.getQueue(detail.run.runId))[0]?.status).toBe("succeeded");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker auto-recovers safe stale leases before surfacing user attention", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string };
      };
      const claimed = await store.claimNextQueuedEntry({
        runId: detail.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      });
      const run = await store.getRun(detail.run.runId);
      if (!run || !claimed) throw new Error("Missing claimed graph run");
      await store.updateQueueEntry({
        ...claimed,
        recoveryPolicy: "block_for_review",
      });
      await store.updateRun({
        ...run,
        status: "running",
        currentQueueEntryId: claimed.queueEntryId,
        updatedAt: "2026-05-15T00:00:00.000Z",
      });
      let calls = 0;

      const result = await drainGraphRunWorkQueue({
        store,
        runtimeId: "worker-runtime",
        now: () => "2026-05-15T00:00:02.000Z",
        scriptAdapter() {
          calls += 1;
          return { ok: true };
        },
      });

      const queueEntry = (await store.getQueue(detail.run.runId))[0];
      expect(result).toMatchObject({
        inspected: 1,
        recovered: 1,
        requeued: 1,
        blocked: 0,
        errors: [],
      });
      expect(calls).toBe(1);
      expect((await store.getRun(detail.run.runId))?.status).toBe("completed");
      expect(queueEntry?.status).toBe("succeeded");
      expect(queueEntry?.attentionEvidence?.recoveryDecision).toBe("auto_requeued");
      expect(await store.listOperationRecords(detail.run.runId)).toContainEqual(
        expect.objectContaining({
          actionSpecId: "system.recovery.auto_retry",
          kind: "retry_needs_attention",
          operatorIntent: "Automatically retry interrupted step",
        })
      );
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker surfaces retry after auto-recovery budget is exhausted", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string };
      };
      const claimed = await store.claimNextQueuedEntry({
        runId: detail.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      });
      const run = await store.getRun(detail.run.runId);
      if (!run || !claimed) throw new Error("Missing claimed graph run");
      await store.addOperationRecord({
        schemaVersion: 1,
        operationRecordId: `${claimed.queueEntryId}:auto-retry`,
        operationAttemptId: `${claimed.queueEntryId}:auto-retry`,
        runId: detail.run.runId,
        actionSpecId: "system.recovery.auto_retry",
        kind: "retry_needs_attention",
        status: "succeeded",
        operatorIntent: "Automatically retry interrupted step",
        queueEntryId: claimed.queueEntryId,
        affectedArtifactIds: [],
        affectedReviewEventIds: [],
        affectedQueueEntryIds: [claimed.queueEntryId],
        createdAt: "2026-05-15T00:00:00.500Z",
        completedAt: "2026-05-15T00:00:00.500Z",
      });
      await store.updateQueueEntry({
        ...claimed,
        recoveryPolicy: "block_for_review",
      });
      await store.updateRun({
        ...run,
        status: "running",
        currentQueueEntryId: claimed.queueEntryId,
        updatedAt: "2026-05-15T00:00:00.000Z",
      });

      const result = await drainGraphRunWorkQueue({
        store,
        runtimeId: "worker-runtime",
        now: () => "2026-05-15T00:00:02.000Z",
        scriptAdapter() {
          return { ok: true };
        },
      });

      const queueEntry = (await store.getQueue(detail.run.runId))[0];
      expect(result).toMatchObject({
        inspected: 1,
        recovered: 1,
        requeued: 0,
        blocked: 1,
        errors: [],
      });
      expect((await store.getRun(detail.run.runId))?.status).toBe("needs_attention");
      expect(queueEntry?.status).toBe("needs_attention");
      expect(queueEntry?.attentionEvidence?.recoveryDecision).toBe("needs_attention");
      const surfaceResponse = await handleGraphRunReviewSurface?.(
        new Request(`http://localhost/graph-runs/${detail.run.runId}/review-surface`),
        detail.run.runId,
        { store }
      );
      const surface = (await surfaceResponse?.json()) as {
        productView?: {
          state: string;
          title: string;
          message: string;
          primaryAction?: { decision: string; label: string; queueEntryId?: string };
          technicalSummary?: { attentionCode?: string; internalStatus: string };
        };
      };
      expect(surface.productView).toMatchObject({
        state: "retry_available",
        title: "Step interrupted",
        message: "A playbook step was interrupted. Tessera can retry it.",
        primaryAction: {
          decision: "retry_needs_attention",
          label: "Retry step",
          queueEntryId: queueEntry?.queueEntryId,
        },
        technicalSummary: {
          attentionCode: "stale_lease",
          internalStatus: "needs_attention:needs_attention",
        },
      });
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker does not auto-recover non-read tool policies", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    const compiled = compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "content.external-tool",
        version: "0.1.0",
        name: "External Tool Graph",
        artifacts: {
          ticket: { schema: "schemas/ticket.schema.json" },
        },
        start: "ticket",
        nodes: [
          {
            id: "ticket",
            kind: "tool",
            capability: "integration.crm.upsert",
            args: {},
            outputArtifact: "ticket",
            onSuccess: "completed",
          },
        ],
      },
      sourceFiles: { "playbook.ts": "export default graph;\n" },
      compilerVersion: "server-test",
      scriptSdkVersion: "server-test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: compiled }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string };
      };
      const claimed = await store.claimNextQueuedEntry({
        runId: detail.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      });
      const run = await store.getRun(detail.run.runId);
      if (!run || !claimed) throw new Error("Missing claimed graph run");
      await store.updateRun({
        ...run,
        status: "running",
        currentQueueEntryId: claimed.queueEntryId,
        updatedAt: "2026-05-15T00:00:00.000Z",
      });
      let calls = 0;

      const result = await drainGraphRunWorkQueue({
        store,
        runtimeId: "worker-runtime",
        now: () => "2026-05-15T00:00:02.000Z",
        toolAdapter() {
          calls += 1;
          return { ok: true };
        },
        toolPolicies: {
          "integration.crm.upsert": {
            capability: "integration.crm.upsert",
            idempotent: true,
            sideEffect: "external",
          },
        },
        toolCapabilities: ["integration.crm.upsert"],
      });

      const queueEntry = (await store.getQueue(detail.run.runId))[0];
      expect(result).toMatchObject({
        inspected: 1,
        recovered: 1,
        requeued: 0,
        blocked: 1,
        errors: [],
      });
      expect(calls).toBe(0);
      expect((await store.getRun(detail.run.runId))?.status).toBe("needs_attention");
      expect(queueEntry?.status).toBe("needs_attention");
      expect(queueEntry?.attentionEvidence?.recoveryDecision).toBe("needs_attention");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("projects retry product state for interrupted queue entries on blocked runs", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(handleGraphRunReviewSurface).toBeDefined();
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string };
      };
      const claimed = await store.claimNextQueuedEntry({
        runId: detail.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:00:01.000Z",
      });
      const run = await store.getRun(detail.run.runId);
      if (!run || !claimed) throw new Error("Missing claimed graph run");
      await store.updateQueueEntry({
        ...claimed,
        status: "interrupted",
        blockedReason: "worker interrupted",
        updatedAt: "2026-05-15T00:00:02.000Z",
      });
      await store.updateRun({
        ...run,
        status: "blocked",
        currentQueueEntryId: claimed.queueEntryId,
        blockedReason: "worker interrupted",
        updatedAt: "2026-05-15T00:00:02.000Z",
      });

      const surfaceResponse = await handleGraphRunReviewSurface?.(
        new Request(`http://localhost/graph-runs/${detail.run.runId}/review-surface`),
        detail.run.runId,
        { store }
      );
      const surface = (await surfaceResponse?.json()) as {
        productView?: {
          state: string;
          title: string;
          primaryAction?: { decision: string; label: string; queueEntryId?: string };
          technicalSummary?: { internalStatus: string };
        };
      };

      expect(surface.productView).toMatchObject({
        state: "retry_available",
        title: "Step interrupted",
        primaryAction: {
          decision: "retry_interrupted",
          label: "Retry step",
          queueEntryId: claimed.queueEntryId,
        },
        technicalSummary: {
          internalStatus: "blocked:interrupted",
        },
      });
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("background graph worker does not auto-recover hard timeouts", async () => {
    expect(handleGraphRunCreate).toBeDefined();
    expect(drainGraphRunWorkQueue).toBeDefined();
    if (!drainGraphRunWorkQueue) throw new Error("drainGraphRunWorkQueue was not loaded");
    const dbPath = join(await mkdtemp(join(tmpdir(), "tessera-graph-runs-")), "runs.sqlite");
    const store = createPlaybookGraphRunStore(dbPath);
    try {
      const response = await handleGraphRunCreate?.(
        new Request("http://localhost/graph-runs", {
          method: "POST",
          body: JSON.stringify({ compiledGraph: testCompiledGraph() }),
        }),
        { store }
      );
      const detail = (await response?.json()) as {
        run: { runId: string };
      };
      const claimed = await store.claimNextQueuedEntry({
        runId: detail.run.runId,
        runtimeId: "old-runtime",
        leaseId: "old-lease",
        now: "2026-05-15T00:00:00.000Z",
        leaseExpiresAt: "2026-05-15T00:10:00.000Z",
      });
      const run = await store.getRun(detail.run.runId);
      if (!run || !claimed) throw new Error("Missing claimed graph run");
      await store.updateQueueEntry({
        ...claimed,
        recoveryPolicy: "block_for_review",
        lastHeartbeatAt: "2026-05-15T00:02:59.000Z",
      });
      await store.updateRun({
        ...run,
        status: "running",
        currentQueueEntryId: claimed.queueEntryId,
        updatedAt: "2026-05-15T00:02:59.000Z",
      });

      const result = await drainGraphRunWorkQueue({
        store,
        runtimeId: "worker-runtime",
        now: () => "2026-05-15T00:03:00.000Z",
        scriptAdapter() {
          return { ok: true };
        },
      });

      const queueEntry = (await store.getQueue(detail.run.runId))[0];
      expect(result).toMatchObject({
        inspected: 1,
        recovered: 1,
        requeued: 0,
        blocked: 1,
        errors: [],
      });
      expect((await store.getRun(detail.run.runId))?.status).toBe("needs_attention");
      expect(queueEntry?.status).toBe("needs_attention");
      expect(queueEntry?.attentionEvidence?.code).toBe("hard_timeout");
    } finally {
      store.close();
      await rm(dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("built-in graph playbook projection", () => {
  test("lists built-in playbooks from graph packages with stable metadata", async () => {
    const response = await handlePlaybookList?.(new Request("http://localhost/playbooks"), {
      catalogState: { entries: [] },
    });
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { playbooks: Array<Record<string, unknown>> };

    expect(body.playbooks.map((playbook) => playbook.id)).toEqual([
      "customer.renewal-risk-review",
      "operations.weekly-status-digest",
      "ops.activity-snapshot",
      "sales.meeting-brief",
    ]);
    expect(
      body.playbooks.find((playbook) => playbook.id === "ops.activity-snapshot")
    ).toMatchObject({
      name: "Activity Snapshot",
      category: "operations",
      outputs: [
        { kind: "dashboard", label: "Activity dashboard", layout: "layouts/dashboard.json" },
      ],
    });
  });

  test("returns graph-derived input details for a built-in playbook", async () => {
    const response = await handlePlaybookGet?.(
      new Request("http://localhost/playbooks/sales.meeting-brief"),
      "sales.meeting-brief"
    );
    expect(response?.status).toBe(200);
    const detail = (await response?.json()) as Record<string, unknown>;

    expect(detail).toMatchObject({
      id: "sales.meeting-brief",
      name: "Sales Meeting Brief",
      category: "sales",
    });
    expect(Object.keys(detail.inputs as Record<string, unknown>)).toContain("company");
    expect(detail.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "draftBrief", kind: "agent" }),
        expect.objectContaining({ id: "approveBrief", kind: "tool" }),
        expect.objectContaining({ id: "writeBrief", kind: "tool" }),
      ])
    );
  });
});

describe("sidecar utility handlers", () => {
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
        return {
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
          sourceEventIds: [],
          sourceDocumentIds: [],
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        };
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
