import { describe, expect, test } from "bun:test";
import {
  PlaybookGraphArtifactVersionSchema,
  PlaybookGraphAttentionEvidenceSchema,
  PlaybookGraphBranchItemSchema,
  PlaybookGraphExecutionContextSchema,
  PlaybookGraphMaterializationTargetSchema,
  PlaybookGraphMemoKeyPartsSchema,
  PlaybookGraphNodeMemoSchema,
  PlaybookGraphOperationKindSchema,
  PlaybookGraphOperationRecordSchema,
  PlaybookGraphQueueEntrySchema,
  PlaybookGraphResumeActionSpecSchema,
  PlaybookGraphResumeDecisionSchema,
  PlaybookGraphRunCreateRequestSchema,
  PlaybookGraphRunRecordSchema,
  PlaybookGraphRunReviewSurfaceSchema,
  PlaybookGraphSnapshotSchema,
  PlaybookRunProductViewSchema,
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

const assignmentPlan = {
  resolverVersion: 1,
  createdAt: now,
  assignments: {
    draft: {
      stepId: "draft",
      agentId: "writer",
      agentLabel: "Writer",
      agentFingerprint: "ui-writer",
      skillCapabilities: [],
      toolCapabilities: ["tool.workspace.read"],
      integrationCapabilities: [],
    },
  },
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
      assignmentPlan,
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
    const attention = PlaybookGraphRunRecordSchema.parse({
      ...running,
      status: "needs_attention",
      blockedReason: "stale lease needs recovery",
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
    expect(attention.status).toBe("needs_attention");
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
      declaredConsumesArtifacts: ["brief"],
      consumesArtifacts: [
        {
          artifactId: "brief",
          versionId: "artifact-version-1",
          contentHash: "sha256:brief",
        },
      ],
      artifactBindingState: "resolved",
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
    expect(entry.declaredConsumesArtifacts).toEqual(["brief"]);
    expect(entry.artifactBindingState).toBe("resolved");
    expect(entry.consumesArtifacts[0]?.versionId).toBe("artifact-version-1");
  });

  test("accepts needs-attention entries with recovery evidence", () => {
    const entry = PlaybookGraphQueueEntrySchema.parse({
      schemaVersion: 1,
      queueEntryId: "queue-1",
      runId: "run-1",
      nodeId: "score",
      nodePath: "score",
      nodeKind: "script",
      status: "needs_attention",
      declaredConsumesArtifacts: ["brief"],
      consumesArtifacts: [],
      artifactBindingState: "unresolved",
      attentionEvidence: {
        code: "stale_lease",
        reason: "Lease expired while the app was offline.",
        observedAt: later,
        previousQueueStatus: "running",
        lastRuntimeId: "runtime-1",
        lastLeaseId: "lease-1",
        lastClaimedAt: now,
        leaseExpiredAt: later,
        recoveryDecision: "needs_attention",
      },
      createdAt: now,
      updatedAt: later,
    });

    expect(entry.status).toBe("needs_attention");
    expect(entry.attentionEvidence?.code).toBe("stale_lease");
    expect(entry.attentionEvidence?.recoveryDecision).toBe("needs_attention");
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
        assignmentPlan,
      })
    ).toEqual({
      runId: "run-1",
      queueEntryId: "queue-1",
      decision: "retry_interrupted",
      payload: {},
      executionContext: { provider: "openai:gpt-5.4" },
      assignmentPlan,
    });
  });

  test("accepts needs-attention retry decisions", () => {
    expect(
      PlaybookGraphResumeDecisionSchema.parse({
        runId: "run-1",
        queueEntryId: "queue-1",
        decision: "retry_needs_attention",
      })
    ).toEqual({
      runId: "run-1",
      queueEntryId: "queue-1",
      decision: "retry_needs_attention",
      payload: {},
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

describe("PlaybookGraphRunReviewSurfaceSchema", () => {
  const run = {
    schemaVersion: 1,
    runId: "run-1",
    playbookId: "content.seo-blog",
    status: "blocked",
    input: { topic: "durable UX" },
    snapshot,
    currentQueueEntryId: "queue-review",
    blockedReason: "human review required",
    startedAt: now,
    updatedAt: later,
  };
  const planQueue = {
    schemaVersion: 1,
    queueEntryId: "queue-plan",
    runId: "run-1",
    nodeId: "plan",
    nodePath: "plan",
    nodeKind: "script",
    status: "skipped",
    createdAt: now,
    updatedAt: now,
  };
  const reviewQueue = {
    schemaVersion: 1,
    queueEntryId: "queue-review",
    runId: "run-1",
    nodeId: "review",
    nodePath: "plan/review",
    nodeKind: "humanReview",
    status: "blocked",
    dependsOn: ["queue-plan"],
    createdAt: now,
    updatedAt: later,
    blockedReason: "human review required",
  };
  const skippedArtifact = {
    schemaVersion: 1,
    runId: "run-1",
    artifactId: "brief",
    versionId: "artifact-skipped",
    producerQueueEntryId: "queue-plan",
    nodePath: "plan",
    contentHash: "sha256:skipped",
    value: { title: "Stale" },
    createdAt: now,
  };
  const activeArtifact = {
    schemaVersion: 1,
    runId: "run-1",
    artifactId: "brief",
    versionId: "artifact-active",
    producerQueueEntryId: "queue-review",
    nodePath: "plan/review",
    contentHash: "sha256:active",
    value: { title: "Active" },
    createdAt: later,
  };

  test("accepts active artifacts, full history, timelines, branches, actions, and git preview", () => {
    const parsed = PlaybookGraphRunReviewSurfaceSchema.parse({
      schemaVersion: 1,
      detail: {
        run,
        queue: [planQueue, reviewQueue],
        branchItems: [],
        artifacts: [skippedArtifact, activeArtifact],
        reviews: [],
      },
      activeArtifacts: [
        {
          schemaVersion: 1,
          artifactId: "brief",
          versionId: "artifact-active",
          producerQueueEntryId: "queue-review",
          producerStatus: "blocked",
          nodePath: "plan/review",
          contentHash: "sha256:active",
          value: { title: "Active" },
          createdAt: later,
        },
      ],
      artifactTimeline: [
        {
          schemaVersion: 1,
          artifactId: "brief",
          versionId: "artifact-active",
          producerQueueEntryId: "queue-review",
          producerStatus: "blocked",
          nodePath: "plan/review",
          contentHash: "sha256:active",
          active: true,
          value: { title: "Active" },
          createdAt: later,
        },
        {
          schemaVersion: 1,
          artifactId: "brief",
          versionId: "artifact-skipped",
          producerQueueEntryId: "queue-plan",
          producerStatus: "skipped",
          nodePath: "plan",
          contentHash: "sha256:skipped",
          active: false,
          value: { title: "Stale" },
          createdAt: now,
        },
      ],
      timeline: [
        {
          schemaVersion: 1,
          timelineRowId: "run-1:queue-review:synthetic_requested",
          kind: "synthetic_requested",
          createdAt: later,
          synthetic: true,
          queueEntryId: "queue-review",
          nodePath: "plan/review",
          artifactId: "brief",
          decision: "requested",
          message: "human review required",
        },
      ],
      branches: [],
      actions: [
        {
          schemaVersion: 1,
          actionId: "queue-review:approve",
          decision: "approve",
          label: "Approve",
          queueEntryId: "queue-review",
          nodePath: "plan/review",
          nodeKind: "humanReview",
          allowedRunStatuses: ["blocked"],
          allowedQueueStatuses: ["blocked"],
          sideEffect: "resume",
        },
      ],
      gitMilestone: {
        schemaVersion: 1,
        available: false,
        unavailableReason: "Git Service unavailable",
        changedFiles: [],
        unsupportedFeatures: ["branch rollback"],
      },
    });

    expect(parsed.activeArtifacts.map((artifact) => artifact.versionId)).toEqual([
      "artifact-active",
    ]);
    expect(parsed.artifactTimeline.map((artifact) => artifact.versionId)).toEqual([
      "artifact-active",
      "artifact-skipped",
    ]);
    expect(parsed.timeline[0]?.synthetic).toBe(true);
    expect(parsed.actions[0]?.decision).toBe("approve");
  });

  test("keeps skipped producer versions out of active artifacts while preserving history", () => {
    const surface = PlaybookGraphRunReviewSurfaceSchema.parse({
      schemaVersion: 1,
      detail: {
        run,
        queue: [planQueue, reviewQueue],
        branchItems: [],
        artifacts: [skippedArtifact, activeArtifact],
        reviews: [],
      },
      activeArtifacts: [
        {
          schemaVersion: 1,
          artifactId: "brief",
          versionId: "artifact-active",
          producerQueueEntryId: "queue-review",
          producerStatus: "blocked",
          nodePath: "plan/review",
          contentHash: "sha256:active",
          value: { title: "Active" },
          createdAt: later,
        },
      ],
      artifactTimeline: [
        {
          schemaVersion: 1,
          artifactId: "brief",
          versionId: "artifact-skipped",
          producerQueueEntryId: "queue-plan",
          producerStatus: "skipped",
          nodePath: "plan",
          contentHash: "sha256:skipped",
          active: false,
          value: { title: "Stale" },
          createdAt: now,
        },
        {
          schemaVersion: 1,
          artifactId: "brief",
          versionId: "artifact-active",
          producerQueueEntryId: "queue-review",
          producerStatus: "blocked",
          nodePath: "plan/review",
          contentHash: "sha256:active",
          active: true,
          value: { title: "Active" },
          createdAt: later,
        },
      ],
    });

    expect(surface.activeArtifacts.some((artifact) => artifact.producerStatus === "skipped")).toBe(
      false
    );
    expect(surface.artifactTimeline.some((artifact) => artifact.producerStatus === "skipped")).toBe(
      true
    );
  });
});

describe("PlaybookGraphOperationRecordSchema", () => {
  test("accepts a complete operation record", () => {
    expect(
      PlaybookGraphOperationRecordSchema.parse({
        schemaVersion: 1,
        operationRecordId: "operation-record-1",
        operationAttemptId: "operation-attempt-1",
        runId: "run-1",
        actionSpecId: "queue-review:approve",
        kind: "resume",
        status: "succeeded",
        operatorIntent: "Approve review",
        queueEntryId: "queue-review",
        affectedArtifactIds: ["plan"],
        affectedReviewEventIds: ["review-1"],
        affectedQueueEntryIds: ["queue-review"],
        redactedPayloadSummary: "notes: 12 chars",
        createdAt: now,
        completedAt: now,
      })
    ).toMatchObject({
      operationRecordId: "operation-record-1",
      status: "succeeded",
      affectedArtifactIds: ["plan"],
    });
  });

  test("rejects malformed or secret-bearing payload summaries", () => {
    expect(() =>
      PlaybookGraphOperationRecordSchema.parse({
        schemaVersion: 1,
        operationRecordId: "operation-record-1",
        operationAttemptId: "operation-attempt-1",
        runId: "run-1",
        actionSpecId: "queue-review:approve",
        kind: "resume",
        status: "succeeded",
        operatorIntent: "Approve review",
        affectedArtifactIds: [],
        affectedReviewEventIds: [],
        affectedQueueEntryIds: [],
        redactedPayloadSummary: "apiKey: sk-secret",
        createdAt: now,
      })
    ).toThrow(/secret-bearing/);
    expect(() =>
      PlaybookGraphOperationRecordSchema.parse({
        schemaVersion: 1,
        operationRecordId: "operation-record-1",
        operationAttemptId: "operation-attempt-1",
        runId: "run-1",
        actionSpecId: "queue-review:approve",
        kind: "unknown",
        status: "succeeded",
        operatorIntent: "Approve review",
        affectedArtifactIds: [],
        affectedReviewEventIds: [],
        affectedQueueEntryIds: [],
        createdAt: now,
      })
    ).toThrow();
  });
});

describe("PlaybookGraphResumeActionSpecSchema", () => {
  test("accepts decision-specific structured action metadata", () => {
    const action = PlaybookGraphResumeActionSpecSchema.parse({
      schemaVersion: 1,
      actionId: "queue-1:edit_artifact",
      decision: "edit_artifact",
      label: "Edit artifact",
      queueEntryId: "queue-1",
      nodePath: "score",
      nodeKind: "humanReview",
      allowedRunStatuses: ["blocked"],
      allowedQueueStatuses: ["blocked"],
      requiredPayloadFields: [
        { path: "artifactId", label: "Artifact", kind: "string" },
        { path: "value", label: "Value", kind: "json" },
      ],
      sideEffect: "invalidate_downstream",
      invalidatesDownstream: true,
    });

    expect(action.requiredPayloadFields.map((field) => field.path)).toEqual([
      "artifactId",
      "value",
    ]);
    expect(action.invalidatesDownstream).toBe(true);
  });

  test("accepts needs-attention retry action metadata", () => {
    const action = PlaybookGraphResumeActionSpecSchema.parse({
      schemaVersion: 1,
      actionId: "queue-1:retry_needs_attention",
      decision: "retry_needs_attention",
      label: "Retry",
      queueEntryId: "queue-1",
      nodePath: "score",
      nodeKind: "script",
      allowedRunStatuses: ["needs_attention"],
      allowedQueueStatuses: ["needs_attention"],
      sideEffect: "resume",
    });

    expect(action.allowedRunStatuses).toEqual(["needs_attention"]);
    expect(action.allowedQueueStatuses).toEqual(["needs_attention"]);
  });

  test("rejects action specs without allowed run statuses", () => {
    expect(() =>
      PlaybookGraphResumeActionSpecSchema.parse({
        schemaVersion: 1,
        actionId: "queue-1:approve",
        decision: "approve",
        label: "Approve",
        allowedRunStatuses: [],
        sideEffect: "resume",
      })
    ).toThrow();
  });
});

describe("PlaybookGraphRunCreateRequestSchema", () => {
  test("requires exactly one graph source", () => {
    expect(
      PlaybookGraphRunCreateRequestSchema.parse({
        playbookId: "content.seo-blog",
        graphHash: "sha256:graph",
        sourceHash: "sha256:source",
        workspaceRoot: "/tmp/tessera-workspace",
        executionContext: { provider: "openai:gpt-5.4" },
        assignmentPlan,
      })
    ).toEqual({
      input: {},
      playbookId: "content.seo-blog",
      graphHash: "sha256:graph",
      sourceHash: "sha256:source",
      drainDeterministic: false,
      workspaceRoot: "/tmp/tessera-workspace",
      executionContext: { provider: "openai:gpt-5.4" },
      assignmentPlan,
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
        sourceHash: "sha256:source",
        executionContext: { apiKey: "nope" },
      })
    ).toThrow(/secret-bearing/);
  });
});

describe("PlaybookRunProductViewSchema", () => {
  test("accepts retry_available with a Retry step primary action", () => {
    const view = PlaybookRunProductViewSchema.parse({
      schemaVersion: 1,
      state: "retry_available",
      title: "Step interrupted",
      message: "A research step was interrupted. Tessera can retry it.",
      primaryAction: {
        actionId: "qe:retry_needs_attention",
        decision: "retry_needs_attention",
        label: "Retry step",
        queueEntryId: "qe",
      },
      technicalSummary: {
        internalStatus: "needs_attention",
        attentionCode: "stale_lease",
        queueEntryId: "qe",
        nodePath: "researchFanout/item:1/searchSources",
        nodeKind: "tool",
      },
    });

    expect(view.state).toBe("retry_available");
    expect(view.primaryAction?.label).toBe("Retry step");
  });

  test("accepts waiting_for_review with artifact-specific approval copy", () => {
    const view = PlaybookRunProductViewSchema.parse({
      schemaVersion: 1,
      state: "waiting_for_review",
      title: "Review needed",
      message: "Review the brief before Tessera continues.",
      primaryAction: {
        actionId: "qe:approve",
        decision: "approve",
        label: "Approve brief",
        queueEntryId: "qe",
      },
      secondaryActions: [
        {
          actionId: "qe:deny",
          decision: "deny",
          label: "Stop run",
          tone: "danger",
          queueEntryId: "qe",
        },
      ],
    });

    expect(view.state).toBe("waiting_for_review");
    expect(view.secondaryActions[0]?.label).toBe("Stop run");
  });

  test("rejects empty action labels and unknown product states", () => {
    expect(() =>
      PlaybookRunProductViewSchema.parse({
        schemaVersion: 1,
        state: "retry_available",
        title: "Step interrupted",
        message: "Retry available.",
        primaryAction: {
          actionId: "qe:retry",
          decision: "retry_needs_attention",
          label: "",
        },
      })
    ).toThrow();

    expect(() =>
      PlaybookRunProductViewSchema.parse({
        schemaVersion: 1,
        state: "stale_lease",
        title: "Internal status",
        message: "Nope.",
      })
    ).toThrow();
  });
});

describe("PlaybookGraphAttentionEvidenceSchema slice-0.5 codes", () => {
  test("accepts stale_heartbeat with thresholdMs and lastHeartbeatAt", () => {
    const evidence = PlaybookGraphAttentionEvidenceSchema.parse({
      code: "stale_heartbeat",
      reason: "Heartbeat older than 45s",
      observedAt: "2026-05-18T12:00:45.000Z",
      previousQueueStatus: "running",
      thresholdMs: 45_000,
      lastHeartbeatAt: "2026-05-18T11:59:55.000Z",
      recoveryDecision: "needs_attention",
    });
    expect(evidence.code).toBe("stale_heartbeat");
    expect(evidence.thresholdMs).toBe(45_000);
  });

  test("accepts hard_timeout with thresholdMs and lastClaimedAt", () => {
    const evidence = PlaybookGraphAttentionEvidenceSchema.parse({
      code: "hard_timeout",
      reason: "Step exceeded hard timeout of 1800000ms",
      observedAt: "2026-05-18T12:30:00.000Z",
      previousQueueStatus: "running",
      thresholdMs: 1_800_000,
      lastClaimedAt: "2026-05-18T12:00:00.000Z",
      recoveryDecision: "needs_attention",
    });
    expect(evidence.code).toBe("hard_timeout");
  });
});

describe("PlaybookGraphQueueEntrySchema lastHeartbeatAt", () => {
  test("accepts optional lastHeartbeatAt", () => {
    const entry = PlaybookGraphQueueEntrySchema.parse({
      schemaVersion: 1,
      queueEntryId: "qe",
      runId: "run",
      nodeId: "n",
      nodePath: "n",
      nodeKind: "agent",
      status: "running",
      createdAt: "2026-05-18T12:00:00.000Z",
      updatedAt: "2026-05-18T12:00:10.000Z",
      lastHeartbeatAt: "2026-05-18T12:00:10.000Z",
    });
    expect(entry.lastHeartbeatAt).toBe("2026-05-18T12:00:10.000Z");
  });

  test("lastHeartbeatAt rejects non-datetime values", () => {
    expect(() =>
      PlaybookGraphQueueEntrySchema.parse({
        schemaVersion: 1,
        queueEntryId: "qe",
        runId: "run",
        nodeId: "n",
        nodePath: "n",
        nodeKind: "agent",
        status: "running",
        createdAt: "2026-05-18T12:00:00.000Z",
        updatedAt: "2026-05-18T12:00:00.000Z",
        lastHeartbeatAt: "not-a-date",
      })
    ).toThrow();
  });
});

describe("PlaybookGraphOperationKindSchema slice-0.5", () => {
  test("accepts soft_timeout_observed and hard_timeout_observed kinds", () => {
    expect(PlaybookGraphOperationKindSchema.parse("soft_timeout_observed")).toBe(
      "soft_timeout_observed"
    );
    expect(PlaybookGraphOperationKindSchema.parse("hard_timeout_observed")).toBe(
      "hard_timeout_observed"
    );
  });
});
