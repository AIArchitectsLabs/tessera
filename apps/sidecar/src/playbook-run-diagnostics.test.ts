import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EffectExecutionRecord,
  PlaybookGraphArtifactVersion,
  PlaybookGraphBranchItem,
  PlaybookGraphOperationRecord,
  PlaybookGraphQueueEntry,
  PlaybookGraphReviewEvent,
  PlaybookGraphRunListFilter,
  PlaybookGraphRunRecord,
} from "@tessera/contracts";
import { compilePlaybookGraph, createPlaybookGraphSnapshot } from "@tessera/core";
import {
  type PlaybookRunDiagnosticsStore,
  diagnosePlaybookRun,
} from "./playbook-run-diagnostics.js";

const tempDirs: string[] = [];
const now = "2026-06-18T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

class FakeDiagnosticsStore implements PlaybookRunDiagnosticsStore {
  runs: PlaybookGraphRunRecord[] = [];
  queue: PlaybookGraphQueueEntry[] = [];
  artifacts: PlaybookGraphArtifactVersion[] = [];
  branchItems: PlaybookGraphBranchItem[] = [];
  reviews: PlaybookGraphReviewEvent[] = [];
  effects: EffectExecutionRecord[] = [];
  operations: PlaybookGraphOperationRecord[] = [];

  async getRun(runId: string): Promise<PlaybookGraphRunRecord | undefined> {
    return this.runs.find((run) => run.runId === runId);
  }

  async listRuns(filter?: PlaybookGraphRunListFilter): Promise<PlaybookGraphRunRecord[]> {
    return this.runs
      .filter(
        (run) =>
          (filter?.ownerUserKey === undefined || run.ownerUserKey === filter.ownerUserKey) &&
          (filter?.workspaceRoot === undefined ||
            run.materialization?.workspaceRoot === filter.workspaceRoot) &&
          (filter?.playbookId === undefined || run.playbookId === filter.playbookId) &&
          (filter?.status === undefined || run.status === filter.status)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, filter?.limit ?? 100);
  }

  async getQueue(runId: string): Promise<PlaybookGraphQueueEntry[]> {
    return this.queue.filter((entry) => entry.runId === runId);
  }

  async listArtifactVersions(runId: string): Promise<PlaybookGraphArtifactVersion[]> {
    return this.artifacts.filter((artifact) => artifact.runId === runId);
  }

  async listBranchItems(runId: string): Promise<PlaybookGraphBranchItem[]> {
    return this.branchItems.filter((item) => item.runId === runId);
  }

  async listReviewEvents(runId: string): Promise<PlaybookGraphReviewEvent[]> {
    return this.reviews.filter((event) => event.runId === runId);
  }

  async listEffectExecutionRecords(runId: string): Promise<EffectExecutionRecord[]> {
    return this.effects.filter((record) => record.runId === runId);
  }

  async listOperationRecords(runId: string): Promise<PlaybookGraphOperationRecord[]> {
    return this.operations.filter((record) => record.runId === runId);
  }
}

function sourceFiles(): Record<string, string> {
  return {
    "playbook.ts": "export default graph;\n",
    "prompts/draft.md": "Draft the final artifact.\n",
    "schemas/finalArtifact.schema.json": JSON.stringify({
      type: "object",
      required: ["title", "summaryMarkdown"],
      properties: {
        title: { type: "string" },
        summaryMarkdown: { type: "string" },
      },
    }),
  };
}

function compiledGraph(graphPatch: Record<string, unknown> = {}) {
  const files = sourceFiles();
  return {
    compiled: compilePlaybookGraph({
      graph: {
        schemaVersion: 1,
        id: "weekly-email-summary",
        version: "0.1.0",
        name: "Weekly Email Summary",
        artifacts: {
          finalArtifact: { schema: "schemas/finalArtifact.schema.json" },
        },
        capabilities: ["tool.workspace.write"],
        start: "draft",
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: {},
            tools: [],
            output: {
              artifact: "finalArtifact",
              schema: "schemas/finalArtifact.schema.json",
            },
            onSuccess: "completed",
          },
        ],
        ...graphPatch,
      },
      sourceFiles: files,
      compilerVersion: "diagnostics-test",
      scriptSdkVersion: "diagnostics-sdk",
      compiledAt: now,
    }),
    files,
  };
}

function runRecord(input: {
  runId: string;
  workspaceRoot?: string;
  graphPatch?: Record<string, unknown>;
}): PlaybookGraphRunRecord {
  const { compiled, files } = compiledGraph(input.graphPatch);
  return {
    schemaVersion: 1,
    runId: input.runId,
    ownerUserKey: "local-owner",
    playbookId: compiled.metadata.playbookId,
    status: "completed",
    input: {},
    ...(input.workspaceRoot
      ? {
          materialization: {
            schemaVersion: 1,
            kind: "workspace",
            workspaceRoot: input.workspaceRoot,
          },
        }
      : {}),
    snapshot: createPlaybookGraphSnapshot({ compiledGraph: compiled, sourceFiles: files }),
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  };
}

function queueEntry(input: {
  queueEntryId: string;
  runId: string;
  nodeId: string;
  nodeKind: PlaybookGraphQueueEntry["nodeKind"];
  producesArtifacts?: string[];
  consumesArtifacts?: PlaybookGraphQueueEntry["consumesArtifacts"];
}): PlaybookGraphQueueEntry {
  return {
    schemaVersion: 1,
    queueEntryId: input.queueEntryId,
    runId: input.runId,
    nodeId: input.nodeId,
    nodePath: input.nodeId,
    nodeKind: input.nodeKind,
    status: "succeeded",
    dependsOn: [],
    producesArtifacts: input.producesArtifacts ?? [],
    declaredConsumesArtifacts: [],
    consumesArtifacts: input.consumesArtifacts ?? [],
    artifactBindingState: "resolved",
    recoveryPolicy: "rerun_if_no_success_memo",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
}

function artifactVersion(input: {
  runId: string;
  producerQueueEntryId: string;
  value: unknown;
}): PlaybookGraphArtifactVersion {
  return {
    schemaVersion: 1,
    runId: input.runId,
    artifactId: "finalArtifact",
    versionId: "finalArtifact:v1",
    producerQueueEntryId: input.producerQueueEntryId,
    nodePath: "draft",
    contentHash: digest,
    value: input.value,
    createdAt: now,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("diagnosePlaybookRun", () => {
  test("flags declared mail capability without an executable mail tool node", async () => {
    const store = new FakeDiagnosticsStore();
    const run = runRecord({
      runId: "run-mail-gap",
      graphPatch: {
        capabilities: ["integration.mail.messages.read", "tool.workspace.write"],
      },
    });
    store.runs.push(run);
    store.queue.push(
      queueEntry({
        queueEntryId: "draft-q",
        runId: run.runId,
        nodeId: "draft",
        nodeKind: "agent",
        producesArtifacts: ["finalArtifact"],
      })
    );
    store.artifacts.push(
      artifactVersion({
        runId: run.runId,
        producerQueueEntryId: "draft-q",
        value: {
          title: "Weekly Email Summary",
          summaryMarkdown: "No email messages were available from the requested source.",
        },
      })
    );

    const result = await diagnosePlaybookRun({
      request: { runId: run.runId, includeArtifactPreviews: true },
      store,
      ownerUserKey: "local-owner",
    });

    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain("playbook.missing_mail_tool_node");
    expect(result.nextActions.join("\n")).toContain("integration.mail.messages.read");
  });

  test("flags artifactWrite output that is tiny compared with the source artifact", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tessera-diagnostics-workspace-"));
    tempDirs.push(workspaceRoot);
    await mkdir(join(workspaceRoot, "out"), { recursive: true });
    await writeFile(join(workspaceRoot, "out", "summary.md"), "# Weekly Email Summary\n", "utf8");

    const store = new FakeDiagnosticsStore();
    const run = runRecord({
      runId: "run-blank-output",
      workspaceRoot,
      graphPatch: {
        capabilities: ["tool.workspace.write"],
        nodes: [
          {
            id: "draft",
            kind: "agent",
            prompt: "prompts/draft.md",
            inputs: {},
            tools: [],
            output: {
              artifact: "finalArtifact",
              schema: "schemas/finalArtifact.schema.json",
            },
            onSuccess: "write",
          },
          {
            id: "write",
            kind: "artifactWrite",
            artifact: "finalArtifact",
            path: "out/summary.md",
            onSuccess: "completed",
          },
        ],
      },
    });
    store.runs.push(run);
    const artifact = artifactVersion({
      runId: run.runId,
      producerQueueEntryId: "draft-q",
      value: {
        title: "Weekly Email Summary",
        summaryMarkdown: `# Weekly Email Summary\n\n${"The team made meaningful progress. ".repeat(40)}`,
      },
    });
    store.artifacts.push(artifact);
    store.queue.push(
      queueEntry({
        queueEntryId: "draft-q",
        runId: run.runId,
        nodeId: "draft",
        nodeKind: "agent",
        producesArtifacts: ["finalArtifact"],
      }),
      queueEntry({
        queueEntryId: "write-q",
        runId: run.runId,
        nodeId: "write",
        nodeKind: "artifactWrite",
        consumesArtifacts: [
          {
            artifactId: artifact.artifactId,
            versionId: artifact.versionId,
            contentHash: artifact.contentHash,
          },
        ],
      })
    );

    const result = await diagnosePlaybookRun({
      request: { runId: run.runId },
      store,
      ownerUserKey: "local-owner",
      workspaceRoot,
    });

    expect(result.workspaceOutputSummary.records).toContainEqual(
      expect.objectContaining({
        nodeKind: "artifactWrite",
        path: "out/summary.md",
        bytes: 23,
        artifactChars: expect.any(Number),
      })
    );
    expect(result.issues.map((issue) => issue.code)).toContain(
      "workspace_output.blank_or_truncated"
    );
  });
});
