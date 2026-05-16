import { describe, expect, test } from "bun:test";
import {
  PlaybookGraphArtifactVersionSchema,
  PlaybookGraphBranchItemSchema,
  PlaybookGraphExecutionContextSchema,
  PlaybookGraphMaterializationTargetSchema,
  PlaybookGraphMemoKeyPartsSchema,
  PlaybookGraphNodeMemoSchema,
  PlaybookGraphQueueEntrySchema,
  PlaybookGraphResumeDecisionSchema,
  PlaybookGraphRunCreateRequestSchema,
  PlaybookGraphRunRecordSchema,
  PlaybookGraphSnapshotSchema,
} from "./index.js";

const now = "2026-05-15T00:00:00.000Z";
const later = "2026-05-15T00:00:01.000Z";

const snapshot = {
  schemaVersion: 1,
  snapshotJson: '{"graph":{"id":"content.seo-blog"},"metadata":{"graphHash":"sha256:graph"}}',
  snapshotHash: "sha256:snapshot",
  graphHash: "sha256:graph",
  sourceHash: "sha256:source",
  sourceFileHashes: {
    "playbook.ts": "sha256:playbook",
    "scripts/score.ts": "sha256:script",
  },
  sourceFiles: {
    "playbook.ts": "export default graph;\n",
    "scripts/score.ts": "export default function score() {}\n",
  },
  playbookId: "content.seo-blog",
  packageVersion: "0.1.0",
  compilerVersion: "tessera-sidecar-0.1.0",
  graphSchemaVersion: 1,
  scriptSdkVersion: "tessera-sidecar-0.1.0",
  compiledAt: now,
};

const memoKeyParts = {
  schemaVersion: 1,
  runId: "run-1",
  snapshotHash: "sha256:snapshot",
  graphHash: "sha256:graph",
  nodePath: "score",
  nodeSpecHash: "sha256:node",
  executionContextHash: "sha256:context",
  inputSnapshotHash: "sha256:input",
};

describe("PlaybookGraphSnapshotSchema", () => {
  test("accepts a pinned inline compiled graph snapshot header", () => {
    const parsed = PlaybookGraphSnapshotSchema.parse(snapshot);

    expect(parsed.playbookId).toBe("content.seo-blog");
    expect(parsed.sourceFileHashes["scripts/score.ts"]).toBe("sha256:script");
    expect(parsed.sourceFiles?.["scripts/score.ts"]).toContain("function score");
  });

  test("rejects snapshots without sha256-prefixed hashes", () => {
    expect(() =>
      PlaybookGraphSnapshotSchema.parse({ ...snapshot, snapshotHash: "snapshot" })
    ).toThrow(/sha256/);
  });
});

describe("PlaybookGraphRunRecordSchema", () => {
  test("accepts active, interrupted, and repair graph run records without widening workflow runs", () => {
    const running = PlaybookGraphRunRecordSchema.parse({
      schemaVersion: 1,
      runId: "run-1",
      playbookId: "content.seo-blog",
      status: "running",
      input: { topic: "durable execution" },
      materialization: {
        schemaVersion: 1,
        kind: "workspace",
        workspaceRoot: "/tmp/tessera-workspace",
      },
      executionContext: {
        schemaVersion: 1,
        executionContextHash: "sha256:context",
        fingerprints: {
          provider: "openai:gpt-5.4",
          account: "acct_123:fingerprint",
          budget: { maxUsd: 5 },
        },
      },
      snapshot,
      currentQueueEntryId: "queue-1",
      startedAt: now,
      updatedAt: later,
    });
    const interrupted = PlaybookGraphRunRecordSchema.parse({
      ...running,
      status: "interrupted",
      blockedReason: "stale runtime lease",
    });
    const repair = PlaybookGraphRunRecordSchema.parse({
      ...running,
      status: "needs_repair",
      repairReason: "snapshot hash mismatch",
    });

    expect(running.status).toBe("running");
    expect(running.materialization?.workspaceRoot).toBe("/tmp/tessera-workspace");
    expect(running.executionContext?.executionContextHash).toBe("sha256:context");
    expect(interrupted.status).toBe("interrupted");
    expect(repair.repairReason).toBe("snapshot hash mismatch");
  });
});

describe("PlaybookGraphExecutionContextSchema", () => {
  test("accepts non-secret provider, account, and budget fingerprints", () => {
    expect(
      PlaybookGraphExecutionContextSchema.parse({
        schemaVersion: 1,
        executionContextHash: "sha256:context",
        fingerprints: {
          provider: "openai:gpt-5.4",
          account: "acct_123:fingerprint",
          budget: { maxUsd: 5 },
        },
      })
    ).toEqual({
      schemaVersion: 1,
      executionContextHash: "sha256:context",
      fingerprints: {
        provider: "openai:gpt-5.4",
        account: "acct_123:fingerprint",
        budget: { maxUsd: 5 },
      },
    });

    expect(() =>
      PlaybookGraphExecutionContextSchema.parse({
        schemaVersion: 1,
        executionContextHash: "sha256:context",
        fingerprints: { token: "nope" },
      })
    ).toThrow(/secret-bearing/);
  });
});

describe("PlaybookGraphMaterializationTargetSchema", () => {
  test("accepts workspace materialization targets without secret-bearing fields", () => {
    expect(
      PlaybookGraphMaterializationTargetSchema.parse({
        schemaVersion: 1,
        kind: "workspace",
        workspaceRoot: "/tmp/tessera-workspace",
      })
    ).toEqual({
      schemaVersion: 1,
      kind: "workspace",
      workspaceRoot: "/tmp/tessera-workspace",
    });

    expect(() =>
      PlaybookGraphMaterializationTargetSchema.parse({
        schemaVersion: 1,
        kind: "workspace",
        workspaceRoot: "/tmp/tessera-workspace",
        token: "nope",
      })
    ).toThrow(/Unrecognized key/);
  });
});

describe("PlaybookGraphQueueEntrySchema", () => {
  test("accepts durable queue entries with leases, dependencies, and artifact refs", () => {
    const entry = PlaybookGraphQueueEntrySchema.parse({
      schemaVersion: 1,
      queueEntryId: "queue-1",
      runId: "run-1",
      nodeId: "score",
      nodePath: "score",
      nodeKind: "script",
      status: "running",
      dependsOn: ["queue-plan"],
      producesArtifacts: ["scorecard"],
      consumesArtifacts: [
        {
          artifactId: "brief",
          versionId: "artifact-version-1",
          contentHash: "sha256:brief",
        },
      ],
      recoveryPolicy: "rerun_if_no_success_memo",
      nodeMemoKey: "sha256:memo",
      attempt: 1,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      claimedAt: now,
      leaseExpiresAt: later,
      createdAt: now,
      updatedAt: later,
    });

    expect(entry.status).toBe("running");
    expect(entry.consumesArtifacts[0]?.versionId).toBe("artifact-version-1");
  });

  test("rejects malformed node paths", () => {
    expect(() =>
      PlaybookGraphQueueEntrySchema.parse({
        schemaVersion: 1,
        queueEntryId: "queue-1",
        runId: "run-1",
        nodeId: "score",
        nodePath: "../score",
        nodeKind: "script",
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
    ).toThrow(/node paths/);
  });
});

describe("PlaybookGraphArtifactVersionSchema", () => {
  test("accepts artifact versions produced by a queue entry", () => {
    const version = PlaybookGraphArtifactVersionSchema.parse({
      schemaVersion: 1,
      runId: "run-1",
      artifactId: "scorecard",
      versionId: "artifact-version-1",
      producerQueueEntryId: "queue-1",
      nodePath: "score",
      contentHash: "sha256:scorecard",
      value: { score: 92 },
      createdAt: now,
    });

    expect(version.value).toEqual({ score: 92 });
  });
});

describe("PlaybookGraphBranchItemSchema", () => {
  test("accepts durable branch items with stable values", () => {
    const item = PlaybookGraphBranchItemSchema.parse({
      schemaVersion: 1,
      runId: "run-1",
      parentQueueEntryId: "queue-map",
      branchItemId: "queue-map:item:0",
      nodePath: "map/item:0",
      index: 0,
      itemHash: "sha256:item",
      value: { id: "a" },
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });

    expect(item.value).toEqual({ id: "a" });
  });
});

describe("PlaybookGraphNodeMemoSchema", () => {
  test("accepts successful run-scoped memo entries with explicit key parts", () => {
    const memo = PlaybookGraphNodeMemoSchema.parse({
      schemaVersion: 1,
      runId: "run-1",
      nodeMemoKey: "sha256:memo",
      queueEntryId: "queue-1",
      nodePath: "score",
      status: "succeeded",
      memoKeyParts,
      artifactRefs: [
        {
          artifactId: "scorecard",
          versionId: "artifact-version-1",
          contentHash: "sha256:scorecard",
        },
      ],
      outputPreview: '{"score":92}',
      createdAt: now,
    });

    expect(memo.memoKeyParts.inputSnapshotHash).toBe("sha256:input");
  });

  test("rejects malformed memo keys", () => {
    expect(() =>
      PlaybookGraphNodeMemoSchema.parse({
        schemaVersion: 1,
        runId: "run-1",
        nodeMemoKey: "memo",
        queueEntryId: "queue-1",
        nodePath: "score",
        status: "succeeded",
        memoKeyParts,
        createdAt: now,
      })
    ).toThrow(/sha256/);
  });

  test("memo key parts contain required non-secret fingerprints only", () => {
    const parsed = PlaybookGraphMemoKeyPartsSchema.parse(memoKeyParts);

    expect(Object.keys(parsed).sort()).toEqual([
      "executionContextHash",
      "graphHash",
      "inputSnapshotHash",
      "nodePath",
      "nodeSpecHash",
      "runId",
      "schemaVersion",
      "snapshotHash",
    ]);
    expect(JSON.stringify(parsed).toLowerCase()).not.toContain("token");
  });
});

describe("PlaybookGraphResumeDecisionSchema", () => {
  test("accepts explicit resume decisions for blocked graph runs", () => {
    expect(
      PlaybookGraphResumeDecisionSchema.parse({
        runId: "run-1",
        queueEntryId: "queue-1",
        decision: "retry_interrupted",
        executionContext: { provider: "openai:gpt-5.4" },
      })
    ).toEqual({
      runId: "run-1",
      queueEntryId: "queue-1",
      decision: "retry_interrupted",
      payload: {},
      executionContext: { provider: "openai:gpt-5.4" },
    });
  });

  test("accepts context-change approval without allowing secret fingerprints", () => {
    expect(
      PlaybookGraphResumeDecisionSchema.parse({
        runId: "run-1",
        decision: "approve_context_change",
        executionContext: { provider: "openai:gpt-5.4", account: "acct_123:fingerprint" },
      })
    ).toEqual({
      runId: "run-1",
      decision: "approve_context_change",
      payload: {},
      executionContext: { provider: "openai:gpt-5.4", account: "acct_123:fingerprint" },
    });

    expect(() =>
      PlaybookGraphResumeDecisionSchema.parse({
        runId: "run-1",
        decision: "approve_context_change",
        executionContext: { accessToken: "nope" },
      })
    ).toThrow(/secret-bearing/);
  });

  test("accepts repair and edit continuation decisions", () => {
    expect(
      PlaybookGraphResumeDecisionSchema.parse({
        runId: "run-1",
        decision: "approve_repair",
      }).decision
    ).toBe("approve_repair");
    expect(
      PlaybookGraphResumeDecisionSchema.parse({
        runId: "run-1",
        decision: "edit_artifact",
        queueEntryId: "queue-1",
        payload: { artifactId: "brief", value: { title: "Edited" } },
        agentProvider: {
          provider: "openai",
          model: "gpt-5.4",
          apiKeyEnv: "OPENAI_API_KEY",
        },
        credential: { apiKey: "sk-test" },
      }).payload
    ).toEqual({ artifactId: "brief", value: { title: "Edited" } });
  });
});

describe("PlaybookGraphRunCreateRequestSchema", () => {
  test("requires exactly one graph source", () => {
    expect(
      PlaybookGraphRunCreateRequestSchema.parse({
        playbookId: "content.seo-blog",
        graphHash: "sha256:graph",
        workspaceRoot: "/tmp/tessera-workspace",
        executionContext: { provider: "openai:gpt-5.4" },
      })
    ).toEqual({
      input: {},
      playbookId: "content.seo-blog",
      graphHash: "sha256:graph",
      drainDeterministic: false,
      workspaceRoot: "/tmp/tessera-workspace",
      executionContext: { provider: "openai:gpt-5.4" },
      agentId: "default",
    });

    expect(() => PlaybookGraphRunCreateRequestSchema.parse({})).toThrow(/Provide either/);
    expect(() =>
      PlaybookGraphRunCreateRequestSchema.parse({
        playbookId: "content.seo-blog",
      })
    ).toThrow(/Cache reference/);
    expect(() =>
      PlaybookGraphRunCreateRequestSchema.parse({
        playbookId: "content.seo-blog",
        graphHash: "sha256:graph",
        executionContext: { apiKey: "nope" },
      })
    ).toThrow(/secret-bearing/);
  });
});
