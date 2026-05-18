/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentProfileListResult,
  IntegrationSettingsRead,
  ModelSettingsRead,
  PlaybookDetail,
  PlaybookGraphRunDetail,
  PlaybookGraphRunListResult,
  PlaybookGraphRunReviewSurface,
  PlaybookListResult,
  PlaybookRunDetail,
} from "@tessera/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { JSDOM } from "jsdom";
import React from "react";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });

  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  globals.window = dom.window as never;
  globals.document = dom.window.document as never;
  globals.navigator = dom.window.navigator as never;
  globals.Node = dom.window.Node as never;
  globals.Element = dom.window.Element as never;
  globals.HTMLElement = dom.window.HTMLElement as never;
  globals.HTMLButtonElement = dom.window.HTMLButtonElement as never;
  globals.SVGElement = dom.window.SVGElement as never;
  globals.Text = dom.window.Text as never;
  globals.Event = dom.window.Event as never;
  globals.MouseEvent = dom.window.MouseEvent as never;
  globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window) as never;
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(cb, 0)) as never;
  globals.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
}

installDom();

const playbook = {
  id: "sales.meeting-brief",
  version: 1,
  packageVersion: "0.1.0",
  name: "Sales Meeting Brief",
  description: "Prepare for a customer or prospect meeting",
  graphHash: "sha256:graph",
  sourceHash: "sha256:source",
  category: "Sales",
  businessUseCase: "Prepare for a customer or prospect meeting",
  requiredCapabilities: [],
  optionalCapabilities: [],
  inputs: {},
  outputs: [{ kind: "meetingBrief", label: "Meeting brief" }],
  steps: [
    {
      id: "draftBrief",
      kind: "agent",
      phase: "Prepare",
      label: "Draft meeting brief",
      prompt: "Draft a concise meeting brief.",
      workspaceRootInput: "workspaceRoot",
    },
  ],
  stepCount: 1,
  phases: ["Prepare"],
} satisfies PlaybookDetail;

const dashboardPlaybook = {
  id: "ops.activity-snapshot",
  version: 1,
  packageVersion: "0.1.0",
  name: "Activity Snapshot",
  description: "Refreshable dashboard of recent workspace activity.",
  graphHash: "sha256:dashboard-graph",
  sourceHash: "sha256:dashboard-source",
  category: "Operations",
  businessUseCase: "Latest workspace update",
  requiredCapabilities: [],
  optionalCapabilities: [],
  inputs: {
    scope: {
      type: "string",
      required: true,
      label: "Scope",
      default: "this week",
      order: 1,
    },
  },
  outputs: [
    {
      kind: "dashboard",
      label: "Activity dashboard",
      layout: "layouts/dashboard.json",
      layoutData: {
        refreshLabel: "Refresh snapshot",
        sections: [
          {
            type: "metrics",
            title: "Activity",
            items: [{ label: "Open items", binding: "draftSnapshot.openItems" }],
          },
          { type: "text", title: "Summary", binding: "draftSnapshot.summary" },
        ],
      },
    },
  ],
  steps: [],
  stepCount: 1,
  phases: ["Summarize"],
} satisfies PlaybookDetail;

const importedPlaybook = {
  id: "content.seo-blog",
  version: 1,
  packageVersion: "0.1.3",
  name: "Imported SEO Blog Article",
  description: "Imported archive playbook",
  graphHash: "sha256:imported-graph",
  sourceHash: "sha256:imported-source",
  requiredCapabilities: [],
  optionalCapabilities: [],
  inputs: {},
  outputs: [],
  steps: [],
  stepCount: 1,
  phases: ["Draft"],
} satisfies PlaybookDetail;

const completedRun = {
  runId: "run-1",
  workflowId: "sales.meeting-brief",
  status: "completed",
  input: {
    company: "FOMORA",
    sources: ["web"],
  },
  outputs: {
    "draft-meeting-brief": {
      text: "Created the brief and saved it to: `Sales Meeting Brief - FOMORA.md`",
      boundaryViolations: 0,
    },
  },
  usage: {
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
  },
  updatedAt: "2026-05-09T07:17:00.000Z",
  events: [],
  steps: [],
} as unknown as PlaybookRunDetail;

const graphRunDetail = {
  run: {
    schemaVersion: 1,
    runId: "graph-run-1",
    playbookId: playbook.id,
    status: "blocked",
    input: {},
    snapshot: {
      schemaVersion: 1,
      snapshotJson: JSON.stringify({
        graph: {
          artifacts: {
            contentBrief: {
              schema: "schemas/contentBrief.schema.json",
              materialize: "outputs/content-brief.md",
            },
            articleDraft: {
              schema: "schemas/articleDraft.schema.json",
              materialize: "outputs/article-draft.md",
            },
          },
          nodes: [
            {
              id: "writeBrief",
              kind: "artifactWrite",
              artifact: "meetingBrief",
              path: "Sales Meeting Brief - {{inputs.company}}.md",
            },
          ],
        },
      }),
      snapshotHash: "sha256:snapshot",
      graphHash: "sha256:graph",
      sourceHash: "sha256:source",
      sourceFileHashes: {},
      playbookId: playbook.id,
      packageVersion: "0.1.0",
      compilerVersion: "test",
      graphSchemaVersion: 1,
      scriptSdkVersion: "test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    },
    currentQueueEntryId: "queue-review",
    blockedReason: "human review required",
    materialization: {
      schemaVersion: 1,
      kind: "workspace",
      workspaceRoot: "/tmp/workspace",
    },
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:01:00.000Z",
  },
  queue: [
    {
      schemaVersion: 1,
      queueEntryId: "queue-review",
      runId: "graph-run-1",
      nodeId: "review",
      nodePath: "draft/review",
      nodeKind: "humanReview",
      status: "blocked",
      dependsOn: [],
      producesArtifacts: [],
      declaredConsumesArtifacts: ["briefScorecard"],
      consumesArtifacts: [
        {
          artifactId: "briefScorecard",
          versionId: "brief-scorecard-v1",
          contentHash: "sha256:brief-scorecard",
        },
      ],
      artifactBindingState: "resolved",
      recoveryPolicy: "block_for_review",
      attempt: 0,
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:01:00.000Z",
      blockedReason: "human review required",
    },
  ],
  branchItems: [],
  artifacts: [
    {
      schemaVersion: 1,
      runId: "graph-run-1",
      artifactId: "contentBrief",
      versionId: "content-brief-v1",
      producerQueueEntryId: "queue-draft",
      nodePath: "draft",
      contentHash: "sha256:content-brief",
      value: {
        text: "# Content Brief\n\n## Title\nActive brief\n\n## Thesis\nA practical brief for the article.",
      },
      createdAt: "2026-05-15T00:00:30.000Z",
    },
  ],
  reviews: [],
  operations: [],
} satisfies PlaybookGraphRunDetail;

const graphRunSurface = {
  schemaVersion: 1,
  detail: graphRunDetail,
  activeArtifacts: [
    {
      schemaVersion: 1,
      artifactId: "contentBrief",
      versionId: "content-brief-v1",
      producerQueueEntryId: "queue-draft",
      producerStatus: "succeeded",
      nodePath: "draft",
      contentHash: "sha256:content-brief",
      value: {
        text: "# Content Brief\n\n## Title\nActive brief\n\n## Thesis\nA practical brief for the article.",
      },
      createdAt: "2026-05-15T00:00:30.000Z",
    },
    {
      schemaVersion: 1,
      artifactId: "briefScorecard",
      versionId: "brief-scorecard-v1",
      producerQueueEntryId: "queue-score",
      producerStatus: "succeeded",
      nodePath: "draft/score",
      contentHash: "sha256:brief-scorecard",
      value: {
        overall: 60,
        pass: false,
        findings: ["Brief needs stronger thesis, sources, or outline coverage."],
      },
      createdAt: "2026-05-15T00:00:45.000Z",
    },
  ],
  artifactTimeline: [
    {
      schemaVersion: 1,
      artifactId: "brief",
      versionId: "brief-v1",
      producerQueueEntryId: "queue-draft",
      producerStatus: "skipped",
      nodePath: "draft",
      contentHash: "sha256:brief-old",
      active: false,
      value: { title: "Stale brief" },
      createdAt: "2026-05-15T00:00:00.000Z",
    },
    {
      schemaVersion: 1,
      artifactId: "contentBrief",
      versionId: "content-brief-v1",
      producerQueueEntryId: "queue-draft",
      producerStatus: "succeeded",
      nodePath: "draft",
      contentHash: "sha256:content-brief",
      active: true,
      value: {
        text: "# Content Brief\n\n## Title\nActive brief\n\n## Thesis\nA practical brief for the article.",
      },
      createdAt: "2026-05-15T00:00:30.000Z",
    },
    {
      schemaVersion: 1,
      artifactId: "briefScorecard",
      versionId: "brief-scorecard-v1",
      producerQueueEntryId: "queue-score",
      producerStatus: "succeeded",
      nodePath: "draft/score",
      contentHash: "sha256:brief-scorecard",
      active: true,
      value: {
        overall: 60,
        pass: false,
        findings: ["Brief needs stronger thesis, sources, or outline coverage."],
      },
      createdAt: "2026-05-15T00:00:45.000Z",
    },
  ],
  timeline: [
    {
      schemaVersion: 1,
      timelineRowId: "graph-run-1:queue-review:synthetic_requested",
      kind: "synthetic_requested",
      createdAt: "2026-05-15T00:01:00.000Z",
      synthetic: true,
      queueEntryId: "queue-review",
      nodePath: "draft/review",
      artifactId: "brief",
      decision: "requested",
      message: "human review required",
      payload: {},
    },
  ],
  branches: [],
  productView: {
    schemaVersion: 1,
    state: "waiting_for_review",
    title: "Review needed",
    message: "Review what Tessera prepared before the run continues.",
    primaryAction: {
      actionId: "queue-review:approve",
      label: "Approve brief",
      tone: "primary",
      decision: "approve",
      queueEntryId: "queue-review",
    },
    secondaryActions: [],
    technicalSummary: {
      internalStatus: "blocked:blocked",
      queueEntryId: "queue-review",
      nodePath: "draft/review",
      nodeKind: "humanReview",
    },
  },
  actions: [
    {
      schemaVersion: 1,
      actionId: "queue-review:approve",
      decision: "approve",
      label: "Approve",
      queueEntryId: "queue-review",
      nodePath: "draft/review",
      nodeKind: "humanReview",
      allowedRunStatuses: ["blocked"],
      allowedQueueStatuses: ["blocked"],
      requiredPayloadFields: [],
      sideEffect: "resume",
      destructive: false,
      invalidatesDownstream: false,
      requiresExecutionContext: false,
      requiresProvider: false,
      requiresCredential: false,
      requiresWorkspace: false,
    },
    {
      schemaVersion: 1,
      actionId: "queue-review:request_changes",
      decision: "request_changes",
      label: "Request changes",
      queueEntryId: "queue-review",
      nodePath: "draft/review",
      nodeKind: "humanReview",
      allowedRunStatuses: ["blocked"],
      allowedQueueStatuses: ["blocked"],
      requiredPayloadFields: [{ path: "notes", label: "Notes", kind: "string", required: false }],
      sideEffect: "invalidate_downstream",
      destructive: false,
      invalidatesDownstream: true,
      requiresExecutionContext: false,
      requiresProvider: false,
      requiresCredential: false,
      requiresWorkspace: false,
    },
    {
      schemaVersion: 1,
      actionId: "graph-run-1:edit_input",
      decision: "edit_input",
      label: "Edit input",
      allowedRunStatuses: ["blocked"],
      allowedQueueStatuses: [],
      requiredPayloadFields: [{ path: "input", label: "Input", kind: "object", required: true }],
      sideEffect: "invalidate_downstream",
      destructive: false,
      invalidatesDownstream: true,
      requiresExecutionContext: false,
      requiresProvider: false,
      requiresCredential: false,
      requiresWorkspace: false,
    },
  ],
} satisfies PlaybookGraphRunReviewSurface;

const graphReviewQueueEntry = graphRunDetail.queue[0];
if (!graphReviewQueueEntry) throw new Error("Expected graph review queue fixture");

const articleReviewGraphRunDetail = {
  ...graphRunDetail,
  run: {
    ...graphRunDetail.run,
    status: "blocked",
    currentQueueEntryId: "queue-final-review",
    blockedReason: "human review required",
    updatedAt: "2026-05-15T00:03:00.000Z",
  },
  queue: [
    {
      ...graphReviewQueueEntry,
      status: "succeeded",
      completedAt: "2026-05-15T00:02:00.000Z",
      updatedAt: "2026-05-15T00:02:00.000Z",
    },
    {
      schemaVersion: 1,
      queueEntryId: "queue-final-review",
      runId: "graph-run-1",
      nodeId: "finalReview",
      nodePath: "draftArticle/reviewArticle/scoreArticle/finalReview",
      nodeKind: "humanReview",
      status: "blocked",
      dependsOn: ["queue-review"],
      producesArtifacts: [],
      declaredConsumesArtifacts: ["articleScorecard"],
      consumesArtifacts: [
        {
          artifactId: "articleScorecard",
          versionId: "article-scorecard-v1",
          contentHash: "sha256:article-scorecard",
        },
      ],
      artifactBindingState: "resolved",
      recoveryPolicy: "block_for_review",
      attempt: 0,
      createdAt: "2026-05-15T00:03:00.000Z",
      updatedAt: "2026-05-15T00:03:00.000Z",
      blockedReason: "human review required",
    },
  ],
  artifacts: [
    ...graphRunDetail.artifacts,
    {
      schemaVersion: 1,
      runId: "graph-run-1",
      artifactId: "articleDraft",
      versionId: "article-draft-v1",
      producerQueueEntryId: "queue-draft-article",
      nodePath: "draftArticle",
      contentHash: "sha256:article-draft",
      value: {
        text: "# Article Draft\n\nA complete article draft based on the approved brief.",
      },
      createdAt: "2026-05-15T00:02:30.000Z",
    },
  ],
} satisfies PlaybookGraphRunDetail;

const articleReviewGraphRunSurface = {
  schemaVersion: 1,
  detail: articleReviewGraphRunDetail,
  activeArtifacts: [
    {
      schemaVersion: 1,
      artifactId: "articleDraft",
      versionId: "article-draft-v1",
      producerQueueEntryId: "queue-draft-article",
      producerStatus: "succeeded",
      nodePath: "draftArticle",
      contentHash: "sha256:article-draft",
      value: {
        text: "# Article Draft\n\nA complete article draft based on the approved brief.",
      },
      createdAt: "2026-05-15T00:02:30.000Z",
    },
    {
      schemaVersion: 1,
      artifactId: "articleScorecard",
      versionId: "article-scorecard-v1",
      producerQueueEntryId: "queue-score-article",
      producerStatus: "succeeded",
      nodePath: "scoreArticle",
      contentHash: "sha256:article-scorecard",
      value: {
        overall: 84,
        pass: true,
        findings: ["Article is ready for final source summary."],
      },
      createdAt: "2026-05-15T00:02:45.000Z",
    },
  ],
  artifactTimeline: [],
  timeline: [],
  branches: [],
  actions: [
    {
      schemaVersion: 1,
      actionId: "queue-final-review:approve",
      decision: "approve",
      label: "Approve",
      queueEntryId: "queue-final-review",
      nodePath: "draftArticle/reviewArticle/scoreArticle/finalReview",
      nodeKind: "humanReview",
      allowedRunStatuses: ["blocked"],
      allowedQueueStatuses: ["blocked"],
      requiredPayloadFields: [],
      sideEffect: "resume",
      destructive: false,
      invalidatesDownstream: false,
      requiresExecutionContext: false,
      requiresProvider: false,
      requiresCredential: false,
      requiresWorkspace: false,
    },
  ],
} satisfies PlaybookGraphRunReviewSurface;

const contextDriftGraphRunDetail = {
  run: {
    ...graphRunDetail.run,
    runId: "graph-run-context-drift",
    status: "blocked",
    currentQueueEntryId: "queue-draft-context",
    blockedReason:
      "Graph execution context changed; expected sha256:old, got sha256:new. Approval is required before continuing.",
    updatedAt: "2026-05-16T00:01:00.000Z",
  },
  queue: [
    {
      schemaVersion: 1,
      queueEntryId: "queue-draft-context",
      runId: "graph-run-context-drift",
      nodeId: "draftBrief",
      nodePath: "draftBrief",
      nodeKind: "agent",
      status: "queued",
      dependsOn: [],
      producesArtifacts: [],
      declaredConsumesArtifacts: [],
      consumesArtifacts: [],
      artifactBindingState: "resolved",
      recoveryPolicy: "rerun_if_no_success_memo",
      attempt: 0,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:01:00.000Z",
    },
  ],
  branchItems: [],
  artifacts: [],
  reviews: [],
  operations: [],
} satisfies PlaybookGraphRunDetail;

const contextDriftGraphRunSurface = {
  schemaVersion: 1,
  detail: contextDriftGraphRunDetail,
  activeArtifacts: [],
  artifactTimeline: [],
  timeline: [],
  branches: [],
  actions: [
    {
      schemaVersion: 1,
      actionId: "graph-run-context-drift:approve_context_change",
      decision: "approve_context_change",
      label: "Approve context change",
      allowedRunStatuses: ["blocked"],
      allowedQueueStatuses: [],
      requiredPayloadFields: [],
      sideEffect: "resume",
      destructive: false,
      invalidatesDownstream: false,
      requiresExecutionContext: true,
      requiresProvider: true,
      requiresCredential: false,
      requiresWorkspace: false,
    },
  ],
} satisfies PlaybookGraphRunReviewSurface;

const interruptedGraphRunDetail = {
  run: {
    ...graphRunDetail.run,
    runId: "graph-run-interrupted",
    status: "blocked",
    currentQueueEntryId: "queue-draft-interrupted",
    blockedReason: undefined,
    updatedAt: "2026-05-18T00:01:00.000Z",
  },
  queue: [
    {
      schemaVersion: 1,
      queueEntryId: "queue-draft-interrupted",
      runId: "graph-run-interrupted",
      nodeId: "draftBrief",
      nodePath: "draftBrief",
      nodeKind: "agent",
      status: "interrupted",
      dependsOn: [],
      producesArtifacts: ["meetingBrief"],
      declaredConsumesArtifacts: [],
      consumesArtifacts: [],
      artifactBindingState: "resolved",
      recoveryPolicy: "block_for_review",
      attempt: 1,
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:01:00.000Z",
    },
  ],
  branchItems: [],
  artifacts: [],
  reviews: [],
  operations: [],
} satisfies PlaybookGraphRunDetail;

const interruptedGraphRunSurface = {
  schemaVersion: 1,
  detail: interruptedGraphRunDetail,
  activeArtifacts: [],
  artifactTimeline: [],
  timeline: [],
  branches: [],
  productView: {
    schemaVersion: 1,
    state: "retry_available",
    title: "Step interrupted",
    message: "A playbook step was interrupted. Tessera can retry it.",
    primaryAction: {
      actionId: "queue-draft-interrupted:retry_interrupted",
      label: "Retry step",
      tone: "primary",
      decision: "retry_interrupted",
      queueEntryId: "queue-draft-interrupted",
    },
    secondaryActions: [],
    technicalSummary: {
      internalStatus: "blocked:interrupted",
      queueEntryId: "queue-draft-interrupted",
      nodePath: "draftBrief",
      nodeKind: "agent",
    },
  },
  actions: [
    {
      schemaVersion: 1,
      actionId: "queue-draft-interrupted:retry_interrupted",
      decision: "retry_interrupted",
      label: "Retry step",
      queueEntryId: "queue-draft-interrupted",
      nodePath: "draftBrief",
      nodeKind: "agent",
      allowedRunStatuses: ["interrupted", "running", "blocked"],
      allowedQueueStatuses: ["interrupted"],
      requiredPayloadFields: [],
      sideEffect: "resume",
      destructive: false,
      invalidatesDownstream: false,
      requiresExecutionContext: false,
      requiresProvider: false,
      requiresCredential: false,
      requiresWorkspace: false,
    },
  ],
} satisfies PlaybookGraphRunReviewSurface;

const completedGraphRunDetail = {
  run: {
    ...graphRunDetail.run,
    runId: "graph-run-completed",
    status: "completed",
    currentQueueEntryId: undefined,
    blockedReason: undefined,
    input: {
      company: "FOMORA",
      sources: ["web"],
    },
    updatedAt: "2026-05-09T07:17:00.000Z",
    completedAt: "2026-05-09T07:17:00.000Z",
  },
  queue: [
    {
      schemaVersion: 1,
      queueEntryId: "queue-write",
      runId: "graph-run-completed",
      nodeId: "writeBrief",
      nodePath: "writeBrief",
      nodeKind: "artifactWrite",
      status: "succeeded",
      dependsOn: [],
      producesArtifacts: [],
      declaredConsumesArtifacts: ["meetingBrief"],
      consumesArtifacts: [
        { artifactId: "meetingBrief", versionId: "brief-v1", contentHash: "sha256:meeting-brief" },
      ],
      artifactBindingState: "resolved",
      recoveryPolicy: "rerun_if_no_success_memo",
      attempt: 0,
      createdAt: "2026-05-09T07:16:00.000Z",
      updatedAt: "2026-05-09T07:17:00.000Z",
      completedAt: "2026-05-09T07:17:00.000Z",
    },
  ],
  branchItems: [],
  artifacts: [
    {
      schemaVersion: 1,
      runId: "graph-run-completed",
      artifactId: "meetingBrief",
      versionId: "brief-v1",
      producerQueueEntryId: "queue-draft",
      nodePath: "draftBrief",
      contentHash: "sha256:meeting-brief",
      value: {
        text: "## Meeting brief\n\nCreated the brief and saved it in the workspace.",
        boundaryViolations: 0,
        usage: {
          inputTokens: 1200,
          outputTokens: 340,
          totalTokens: 1540,
          cachedInputTokens: 200,
          reasoningTokens: 25,
        },
      },
      createdAt: "2026-05-09T07:17:00.000Z",
    },
  ],
  reviews: [],
  operations: [],
} satisfies PlaybookGraphRunDetail;

const dashboardRun = {
  runId: "run-dashboard",
  workflowId: "ops.activity-snapshot",
  status: "completed",
  input: {
    scope: "this week",
  },
  outputs: {
    draftSnapshot: {
      openItems: 7,
      atRisk: 2,
      highlights: ["Inbox cleared"],
      summary: "Workspace activity is steady.",
    },
  },
  updatedAt: "2026-05-10T07:17:00.000Z",
  events: [],
  steps: [],
} as unknown as PlaybookRunDetail;

const dashboardGraphRunDetail = {
  run: {
    schemaVersion: 1,
    runId: "graph-run-dashboard",
    playbookId: dashboardPlaybook.id,
    status: "completed",
    input: {
      scope: "this week",
    },
    snapshot: {
      schemaVersion: 1,
      snapshotJson: "{}",
      snapshotHash: "sha256:dashboard-snapshot",
      graphHash: "sha256:dashboard-graph",
      sourceHash: "sha256:dashboard-source",
      sourceFileHashes: {},
      playbookId: dashboardPlaybook.id,
      packageVersion: "0.1.0",
      compilerVersion: "test",
      graphSchemaVersion: 1,
      scriptSdkVersion: "test",
      compiledAt: "2026-05-15T00:00:00.000Z",
    },
    materialization: {
      schemaVersion: 1,
      kind: "workspace",
      workspaceRoot: "/tmp/workspace",
    },
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-10T07:17:00.000Z",
    completedAt: "2026-05-10T07:17:00.000Z",
  },
  queue: [],
  branchItems: [],
  artifacts: [
    {
      schemaVersion: 1,
      runId: "graph-run-dashboard",
      artifactId: "dashboard",
      versionId: "dashboard-v1",
      producerQueueEntryId: "queue-dashboard",
      nodePath: "draftSnapshot",
      contentHash: "sha256:dashboard-artifact",
      value: {
        openItems: 7,
        atRisk: 2,
        highlights: ["Inbox cleared"],
        summary: "Workspace activity is steady.",
      },
      createdAt: "2026-05-10T07:17:00.000Z",
    },
  ],
  reviews: [],
  operations: [],
} satisfies PlaybookGraphRunDetail;

const modelSettings: ModelSettingsRead = {
  selectedProvider: "openai",
  providers: {
    openai: { provider: "openai", model: "gpt-5.4", hasCredential: true },
    "openai-codex": { provider: "openai-codex", model: "gpt-5.4", hasCredential: false },
    anthropic: { provider: "anthropic", model: "claude-sonnet-4-6", hasCredential: false },
    openrouter: { provider: "openrouter", model: "openai/gpt-5.4", hasCredential: false },
    local: {
      provider: "local",
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434/v1",
      hasCredential: false,
    },
  },
};

const integrationSettings: IntegrationSettingsRead = {
  providers: {
    braveSearch: { provider: "brave-search", hasCredential: false },
    googleWorkspace: { provider: "google-workspace", hasCredential: false },
  },
  search: {
    mode: "auto",
    allowKeylessFallback: true,
    providers: {
      braveSearch: { provider: "brave-search", hasCredential: false },
      tavily: { provider: "tavily", hasCredential: false },
      duckduckgo: { provider: "duckduckgo", hasCredential: false },
    },
  },
};

let includeContextDriftRun = false;
let includeInterruptedRun = false;
let includeImportedPlaybook = false;
let playbookListOverride: Promise<PlaybookListResult> | null = null;
let graphRunSurfaceOverride: PlaybookGraphRunReviewSurface | null = null;

const invoke = mock(async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case "playbook_list":
      if (playbookListOverride) return playbookListOverride;
      return {
        playbooks: [
          playbook,
          dashboardPlaybook,
          ...(includeImportedPlaybook ? [importedPlaybook] : []),
        ],
      } satisfies PlaybookListResult;
    case "playbook_get":
      return args?.playbookId === dashboardPlaybook.id
        ? dashboardPlaybook
        : args?.playbookId === importedPlaybook.id
          ? importedPlaybook
          : playbook;
    case "playbook_import":
      includeImportedPlaybook = true;
      return {
        schemaVersion: 1,
        status: "installed",
        id: importedPlaybook.id,
        version: importedPlaybook.packageVersion,
        name: importedPlaybook.name,
        graphHash: importedPlaybook.graphHash,
        sourceHash: importedPlaybook.sourceHash,
        warnings: [],
      };
    case "graph_run_list":
      return {
        runs:
          args?.playbookId === dashboardPlaybook.id
            ? [dashboardGraphRunDetail.run]
            : args?.playbookId === playbook.id
              ? [
                  completedGraphRunDetail.run,
                  graphRunDetail.run,
                  ...(includeContextDriftRun ? [contextDriftGraphRunDetail.run] : []),
                  ...(includeInterruptedRun ? [interruptedGraphRunDetail.run] : []),
                ]
              : [dashboardGraphRunDetail.run, completedGraphRunDetail.run, graphRunDetail.run],
      } satisfies PlaybookGraphRunListResult;
    case "graph_run_review_surface":
      return args?.runId === contextDriftGraphRunDetail.run.runId
        ? contextDriftGraphRunSurface
        : args?.runId === interruptedGraphRunDetail.run.runId
          ? interruptedGraphRunSurface
          : args?.runId === dashboardGraphRunDetail.run.runId
            ? {
                schemaVersion: 1,
                detail: dashboardGraphRunDetail,
                activeArtifacts: [],
                artifactTimeline: [],
                timeline: [],
                branches: [],
                actions: [],
              }
            : args?.runId === completedGraphRunDetail.run.runId
              ? {
                  schemaVersion: 1,
                  detail: completedGraphRunDetail,
                  activeArtifacts: [],
                  artifactTimeline: [],
                  timeline: [],
                  branches: [],
                  actions: [],
                }
              : (graphRunSurfaceOverride ?? graphRunSurface);
    case "graph_run_git_milestone_preview":
      return {
        schemaVersion: 1,
        available: true,
        workspaceRoot: "/tmp/workspace",
        gitRoot: "/tmp/workspace",
        branch: "main",
        changedFiles: [{ path: "out/draft.json", status: "M", allowed: true }],
        proposedMessage: "Record graph run milestone",
        dirtyPolicy: "allow_selected_paths",
        unsupportedFeatures: ["push"],
      };
    case "graph_run_resume": {
      if (args?.runId === interruptedGraphRunDetail.run.runId) {
        const interruptedEntry = interruptedGraphRunDetail.queue[0];
        if (!interruptedEntry) throw new Error("Missing interrupted queue entry");
        return {
          ...interruptedGraphRunDetail,
          run: {
            ...interruptedGraphRunDetail.run,
            status: "running",
            updatedAt: "2026-05-18T00:02:00.000Z",
          },
          queue: [
            {
              ...interruptedEntry,
              status: "queued",
              updatedAt: "2026-05-18T00:02:00.000Z",
            },
          ],
        } satisfies PlaybookGraphRunDetail;
      }
      if (args?.runId === contextDriftGraphRunDetail.run.runId) {
        return {
          ...contextDriftGraphRunDetail,
          run: {
            ...contextDriftGraphRunDetail.run,
            status: "running",
            blockedReason: undefined,
            updatedAt: "2026-05-16T00:02:00.000Z",
          },
        } satisfies PlaybookGraphRunDetail;
      }
      const { blockedReason: _blockedReason, ...run } = graphRunDetail.run;
      if ((args?.request as { decision?: string } | undefined)?.decision === "approve") {
        graphRunSurfaceOverride = articleReviewGraphRunSurface;
        return articleReviewGraphRunDetail;
      }
      return {
        ...graphRunDetail,
        run: {
          ...run,
          status: "running",
          updatedAt: "2026-05-15T00:02:00.000Z",
        },
      } satisfies PlaybookGraphRunDetail;
    }
    case "graph_run_create":
      return (args?.request as { playbookId?: string } | undefined)?.playbookId ===
        dashboardPlaybook.id
        ? {
            ...dashboardGraphRunDetail,
            run: {
              ...dashboardGraphRunDetail.run,
              runId: "graph-run-dashboard-new",
              updatedAt: "2026-05-11T00:00:00.000Z",
            },
          }
        : {
            ...completedGraphRunDetail,
            run: {
              ...completedGraphRunDetail.run,
              runId: "graph-run-new",
              status: "completed",
              updatedAt: "2026-05-11T00:00:00.000Z",
            },
          };
    case "model_settings_get":
      return modelSettings;
    case "integration_settings_get":
      return integrationSettings;
    case "agent_profile_list":
      return {
        profiles: [
          {
            id: "default",
            name: "Tessera",
            model: { mode: "default" },
            instructions: "",
            soul: "",
            userContext: "",
            skills: [],
            toolPolicyPreset: "workspace_editor",
            memoryDefaults: "",
            createdAt: "2026-05-09T00:00:00.000Z",
            updatedAt: "2026-05-09T00:00:00.000Z",
          },
          {
            id: "analyst",
            name: "Analyst",
            model: { mode: "default" },
            instructions: "",
            soul: "",
            userContext: "",
            skills: [],
            toolPolicyPreset: "workspace_editor",
            memoryDefaults: "",
            createdAt: "2026-05-09T00:00:00.000Z",
            updatedAt: "2026-05-09T00:00:00.000Z",
          },
        ],
      } satisfies AgentProfileListResult;
    case "workspace_file_open":
      return null;
    default:
      throw new Error(`Unexpected invoke command: ${command}`);
  }
});

mock.module("@tauri-apps/api/core", () => ({
  invoke,
}));

const openMock = mock<() => Promise<string | null>>(async () => "/tmp/reference.playbook.zip");

mock.module("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
}));

const { PlaybooksView } = await import("./PlaybooksView");

function renderPlaybooksView(workspaceRoot = "/tmp/workspace") {
  return render(
    React.createElement(PlaybooksView, {
      workspaceRoot,
      onWorkspaceSelect: mock(() => undefined),
    })
  );
}

beforeEach(() => {
  invoke.mockClear();
  openMock.mockClear();
  openMock.mockImplementation(async () => "/tmp/reference.playbook.zip");
  includeContextDriftRun = false;
  includeInterruptedRun = false;
  includeImportedPlaybook = false;
  playbookListOverride = null;
  graphRunSurfaceOverride = null;
  modelSettings.selectedProvider = "openai";
  modelSettings.providers["openai-codex"] = {
    provider: "openai-codex",
    model: "gpt-5.4",
    hasCredential: false,
  };
});

afterEach(() => {
  cleanup();
});

describe("PlaybooksView", () => {
  test("shows a stable loading state while playbooks load", async () => {
    let resolvePlaybooks: (result: PlaybookListResult) => void = () => undefined;
    playbookListOverride = new Promise((resolve) => {
      resolvePlaybooks = resolve;
    });
    const view = renderPlaybooksView();

    expect(view.getByLabelText("Loading playbooks")).toBeTruthy();
    expect(view.getByTestId("playbook-catalog").className).toContain("overflow-y-auto");

    resolvePlaybooks({ playbooks: [playbook, dashboardPlaybook] });

    await waitFor(() => {
      expect(view.getAllByText("Sales Meeting Brief").length).toBeGreaterThan(0);
    });
  });

  test("shows the current workspace in the playbooks sidebar", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByText("Workspace")).toBeTruthy();
      expect(view.getByText("workspace")).toBeTruthy();
      expect(view.getByText("tmp/workspace")).toBeTruthy();
    });
  });

  test("keeps initial Playbooks visit to catalog and run summaries", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getAllByText("Sales Meeting Brief").length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      const selectedRunListCalls = invoke.mock.calls.filter(
        ([command, args]) =>
          command === "graph_run_list" &&
          (args as { playbookId?: string } | undefined)?.playbookId === playbook.id
      );
      expect(selectedRunListCalls).toHaveLength(1);
      expect(
        selectedRunListCalls[0]?.[1] as { playbookId?: string; limit?: number } | undefined
      ).toMatchObject({
        playbookId: playbook.id,
        limit: 10,
      });
    });
    expect(invoke.mock.calls.some(([command]) => command === "graph_run_review_surface")).toBe(
      false
    );
  });

  test("does not crash when legacy model settings miss the selected provider", async () => {
    modelSettings.selectedProvider = "openai-codex";
    Reflect.deleteProperty(
      modelSettings.providers as unknown as Record<string, unknown>,
      "openai-codex"
    );

    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getAllByText("Sales Meeting Brief").length).toBeGreaterThan(0);
    });
  });

  test("keeps run history when the selected playbook is clicked again", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByText(/May 9/)).toBeTruthy();
    });

    const playbookButton = view.getAllByText("Sales Meeting Brief")[0]?.closest("button");
    if (!playbookButton) throw new Error("Expected playbook button");
    fireEvent.click(playbookButton);

    expect(view.queryByText(/May 9/)).toBeTruthy();
  });

  test("renders completed runs even when older payloads omit sourceGaps", async () => {
    const view = renderPlaybooksView();

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 9/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected run button");

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText("Sales Meeting Brief is ready.")).toBeTruthy();
    });
    expect(view.getByText("Meeting brief")).toBeTruthy();
    expect(view.getByText(/Research requested: Web/)).toBeTruthy();
  });

  test("starts built-in playbooks through graph run creation", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByText("Using saved setup: Tessera")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Change setup" }));
    let agentSelect: HTMLSelectElement | null = null;
    await waitFor(() => {
      agentSelect = view.getByLabelText("Agent for Brief writer") as HTMLSelectElement;
      expect(agentSelect).toBeTruthy();
    });
    if (!agentSelect) throw new Error("Expected agent select");
    fireEvent.change(agentSelect, { target: { value: "analyst" } });

    let runButton: HTMLButtonElement | null = null;
    await waitFor(() => {
      runButton = view.getByRole("button", { name: "Prepare brief" }) as HTMLButtonElement;
      expect(runButton.disabled).toBe(false);
    });
    if (!runButton) throw new Error("Expected run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      const createCall = invoke.mock.calls.find(([command]) => command === "graph_run_create");
      expect(createCall).toBeTruthy();
      expect(createCall?.[1]).toMatchObject({
        request: {
          playbookId: "sales.meeting-brief",
          graphHash: "sha256:graph",
          sourceHash: "sha256:source",
          agentId: "analyst",
          workspaceRoot: "/tmp/workspace",
          drainDeterministic: true,
        },
      });
    });
  });

  test("keeps agent setup available for migrated graph built-ins", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByText("Using saved setup: Tessera")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Change setup" }));

    await waitFor(() => {
      expect(view.getByText("Playbook setup")).toBeTruthy();
      expect(view.getByLabelText("Agent for Brief writer")).toBeTruthy();
    });
    expect(view.getByRole("button", { name: "Save selection" })).toBeTruthy();
    expect(view.queryByText("Graph runtime ready")).toBeNull();
  });

  test("shows completed graph run outputs", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByText(/May 9/)).toBeTruthy();
    });

    const runButton = view.getByText(/May 9/).closest("button");
    if (!runButton) throw new Error("Expected run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText(/Sales Meeting Brief - FOMORA\.md/)).toBeTruthy();
      expect(view.getByText("Input 1.2k tokens")).toBeTruthy();
      expect(view.getByText("Output 340 tokens")).toBeTruthy();
      expect(view.getByText("Total 1.5k tokens")).toBeTruthy();
      expect(view.getByText("Cached 200 tokens")).toBeTruthy();
      expect(view.getByText("Reasoning 25 tokens")).toBeTruthy();
    });

    const artifactCard = view.getByTitle("Open artifact");
    fireEvent.click(artifactCard);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("workspace_file_open", {
        workspaceRoot: "/tmp/workspace",
        path: "Sales Meeting Brief - FOMORA.md",
      });
    });
  });

  test("shows context-change blocked graph runs as review work", async () => {
    includeContextDriftRun = true;
    const view = renderPlaybooksView();

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 16/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected context drift run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText("Your review is needed")).toBeTruthy();
      expect(view.getByText(/older setup/)).toBeTruthy();
      expect(view.queryByRole("button", { name: "Start another" })).toBeNull();
    });

    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const resumeCall = invoke.mock.calls.find(
        ([command, args]) =>
          command === "graph_run_resume" &&
          (args as { runId?: string } | undefined)?.runId === "graph-run-context-drift"
      );
      expect(resumeCall).toBeTruthy();
      expect(resumeCall?.[1]).toMatchObject({
        runId: "graph-run-context-drift",
        request: {
          runId: "graph-run-context-drift",
          decision: "approve_context_change",
        },
      });
    });
  });

  test("offers a simple retry action for interrupted graph runs", async () => {
    includeInterruptedRun = true;
    const view = renderPlaybooksView();

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 18/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected interrupted run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText("Step interrupted")).toBeTruthy();
      expect(view.getByText("A playbook step was interrupted. Tessera can retry it.")).toBeTruthy();
      expect(view.getByText("What happens if you retry")).toBeTruthy();
      expect(view.queryByText("What Tessera prepared")).toBeNull();
    });

    fireEvent.click(view.getByRole("button", { name: "Retry step" }));

    await waitFor(() => {
      const resumeCall = invoke.mock.calls.find(
        ([command, args]) =>
          command === "graph_run_resume" &&
          (args as { runId?: string } | undefined)?.runId === "graph-run-interrupted"
      );
      expect(resumeCall).toBeTruthy();
      expect(resumeCall?.[1]).toMatchObject({
        runId: "graph-run-interrupted",
        request: {
          runId: "graph-run-interrupted",
          decision: "retry_interrupted",
          queueEntryId: "queue-draft-interrupted",
        },
      });
    });
  });

  test("shows a soft-timeout badge for long-running graph work with fresh heartbeat", async () => {
    const nowMs = Date.now();
    const claimedAt = new Date(nowMs - 6 * 60_000).toISOString();
    const lastHeartbeatAt = new Date(nowMs - 5_000).toISOString();
    graphRunSurfaceOverride = {
      ...graphRunSurface,
      detail: {
        ...graphRunDetail,
        run: {
          ...graphRunDetail.run,
          status: "running",
          currentQueueEntryId: "queue-draft-running",
          updatedAt: lastHeartbeatAt,
        },
        queue: [
          {
            ...graphReviewQueueEntry,
            queueEntryId: "queue-draft-running",
            nodeId: "draft",
            nodePath: "draft",
            nodeKind: "agent",
            status: "running",
            runtimeId: "runtime-1",
            leaseId: "lease-1",
            claimedAt,
            lastHeartbeatAt,
            updatedAt: lastHeartbeatAt,
          },
        ],
      },
      activeArtifacts: [],
      artifactTimeline: [],
      timeline: [],
      actions: [],
    };
    const view = renderPlaybooksView();

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 15/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected graph run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText("Running longer than expected")).toBeTruthy();
    });
  });

  test("shows product-state retry copy for needs-attention evidence", async () => {
    const cases = [
      {
        code: "stale_lease",
        text: /lost track of this step/i,
      },
      {
        code: "stale_heartbeat",
        text: /stopped reporting progress/i,
      },
      {
        code: "hard_timeout",
        text: /ran longer than its hard time limit/i,
      },
    ] as const;

    for (const item of cases) {
      graphRunSurfaceOverride = {
        ...graphRunSurface,
        detail: {
          ...graphRunDetail,
          run: {
            ...graphRunDetail.run,
            status: "needs_attention",
            currentQueueEntryId: "queue-needs-attention",
          },
          queue: [
            {
              ...graphReviewQueueEntry,
              queueEntryId: "queue-needs-attention",
              nodeId: "draft",
              nodePath: "draft",
              nodeKind: "agent",
              status: "needs_attention",
              blockedReason: "needs attention",
              attentionEvidence: {
                code: item.code,
                reason: "needs attention",
                observedAt: "2026-05-18T00:00:00.000Z",
                previousQueueStatus: "running",
                recoveryDecision: "needs_attention",
              },
              updatedAt: "2026-05-18T00:00:00.000Z",
            },
          ],
        },
        productView: {
          schemaVersion: 1,
          state: "retry_available",
          title: "Step interrupted",
          message: "A playbook step was interrupted. Tessera can retry it.",
          primaryAction: {
            actionId: "queue-needs-attention:retry_needs_attention",
            label: "Retry step",
            tone: "primary",
            decision: "retry_needs_attention",
            queueEntryId: "queue-needs-attention",
          },
          secondaryActions: [],
          technicalSummary: {
            internalStatus: "needs_attention:needs_attention",
            attentionCode: item.code,
            queueEntryId: "queue-needs-attention",
            nodePath: "draft",
            nodeKind: "agent",
          },
        },
        actions: [
          {
            schemaVersion: 1,
            actionId: "queue-other:retry_needs_attention",
            decision: "retry_needs_attention",
            label: "Retry other step",
            queueEntryId: "queue-other",
            nodePath: "other",
            nodeKind: "agent",
            allowedRunStatuses: ["needs_attention"],
            allowedQueueStatuses: ["needs_attention"],
            requiredPayloadFields: [],
            sideEffect: "resume",
            destructive: false,
            invalidatesDownstream: false,
            requiresExecutionContext: false,
            requiresProvider: false,
            requiresCredential: false,
            requiresWorkspace: false,
          },
          {
            schemaVersion: 1,
            actionId: "queue-needs-attention:retry_needs_attention",
            decision: "retry_needs_attention",
            label: "Retry step",
            queueEntryId: "queue-needs-attention",
            nodePath: "draft",
            nodeKind: "agent",
            allowedRunStatuses: ["needs_attention"],
            allowedQueueStatuses: ["needs_attention"],
            requiredPayloadFields: [],
            sideEffect: "resume",
            destructive: false,
            invalidatesDownstream: false,
            requiresExecutionContext: false,
            requiresProvider: false,
            requiresCredential: false,
            requiresWorkspace: false,
          },
        ],
      };
      const view = renderPlaybooksView();

      let runButton: HTMLElement | null = null;
      await waitFor(() => {
        runButton = view.getByText(/May 15/).closest("button");
        expect(runButton).toBeTruthy();
      });
      if (!runButton) throw new Error("Expected needs-attention run button");
      fireEvent.click(runButton);

      await waitFor(() => {
        expect(view.getByText("Step interrupted")).toBeTruthy();
        expect(
          view.getByText("A playbook step was interrupted. Tessera can retry it.")
        ).toBeTruthy();
        expect(view.getByText("What happened")).toBeTruthy();
        expect(view.getByText("What happens if you retry")).toBeTruthy();
        expect(view.getByRole("button", { name: "Retry step" })).toBeTruthy();
        expect(view.queryByText(item.text)).toBeNull();
        expect(view.queryByText("What Tessera prepared")).toBeNull();
        expect(view.queryByText("What happens if you approve")).toBeNull();
      });
      fireEvent.click(view.getByRole("button", { name: "Retry step" }));
      await waitFor(() => {
        const resumeCall = invoke.mock.calls.find(
          ([command, args]) =>
            command === "graph_run_resume" &&
            (args as { runId?: string } | undefined)?.runId === "graph-run-1"
        );
        expect(resumeCall).toBeTruthy();
        expect(resumeCall?.[1]).toMatchObject({
          request: {
            decision: "retry_needs_attention",
            queueEntryId: "queue-needs-attention",
          },
        });
      });
      cleanup();
    }
  });

  test("shows prepared artifact evidence before approving human review runs", async () => {
    const view = renderPlaybooksView();

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 15/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected human review run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText("Content Brief")).toBeTruthy();
      expect(view.getByText("60/100")).toBeTruthy();
      expect(
        view.getByText("Brief needs stronger thesis, sources, or outline coverage.")
      ).toBeTruthy();
      expect(view.getByText(/A practical brief for the article/)).toBeTruthy();
      expect(view.getByRole("button", { name: "Open content brief" })).toBeTruthy();
      expect(view.getByRole("button", { name: "Approve brief" })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Open content brief" }));
    await waitFor(() => {
      expect(
        invoke.mock.calls.some(
          ([command, args]) =>
            command === "workspace_file_open" &&
            (args as Record<string, unknown>)?.path === "outputs/content-brief.md"
        )
      ).toBe(true);
    });

    fireEvent.click(view.getByRole("button", { name: "View details" }));

    await waitFor(() => {
      expect(view.getAllByText("Needs review").length).toBeGreaterThan(0);
      expect(view.getByText("What Tessera is asking you to approve")).toBeTruthy();
      expect(view.getAllByText("Content Brief").length).toBeGreaterThan(0);
    });
  });

  test("refreshes review evidence after approving from the main review card", async () => {
    const view = renderPlaybooksView();

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 15/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected human review run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Approve brief" })).toBeTruthy();
      expect(view.getByText("Content Brief")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Approve brief" }));

    await waitFor(() => {
      expect(view.getByText("Article Draft")).toBeTruthy();
      expect(view.getByText("84/100")).toBeTruthy();
      expect(view.getByText("Article is ready for final source summary.")).toBeTruthy();
      expect(view.getByRole("button", { name: "Open article draft" })).toBeTruthy();
    });
    expect(
      view.queryByText("Brief needs stronger thesis, sources, or outline coverage.")
    ).toBeNull();
  });

  test("renders graph review surface actions and submits action payloads", async () => {
    const view = renderPlaybooksView();

    let playbookButton: HTMLElement | null | undefined = null;
    await waitFor(() => {
      playbookButton = view.getAllByText("Sales Meeting Brief")[0]?.closest("button");
      expect(playbookButton).toBeTruthy();
    });
    if (!playbookButton) throw new Error("Expected playbook button");
    fireEvent.click(playbookButton);

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 9/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByRole("button", { name: "View details" })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: "View details" }));

    await waitFor(() => {
      expect(view.getByText("Run summary")).toBeTruthy();
      expect(view.getByText("Advanced run log")).toBeTruthy();
      expect(view.queryByText("Graph runtime")).toBeNull();
      expect(view.getAllByText("Blocked").length).toBeGreaterThan(0);
    });
    const blockedLabels = view.getAllByText("Blocked");
    const graphRunButton = blockedLabels[blockedLabels.length - 1]?.closest("button");
    if (graphRunButton) fireEvent.click(graphRunButton);

    await waitFor(() => {
      expect(invoke.mock.calls.some(([command]) => command === "graph_run_review_surface")).toBe(
        true
      );
    });

    await waitFor(() => {
      expect(view.getAllByText(/Active brief/).length).toBeGreaterThan(0);
      expect(view.getByText("Artifact timeline: 3 versions · 2 active")).toBeTruthy();
      expect(view.getAllByText("human review required").length).toBeGreaterThan(0);
    });

    expect(view.queryByRole("button", { name: "Edit input" })).toBeNull();
    expect(view.queryByPlaceholderText(/JSON payload/i)).toBeNull();
    const payloadTextarea = view.getByPlaceholderText("Notes") as HTMLTextAreaElement;
    fireEvent.change(payloadTextarea, {
      target: { value: "Revise tone" },
    });
    await waitFor(() => {
      expect(payloadTextarea.value).toBe("Revise tone");
    });
    fireEvent.click(view.getByRole("button", { name: "Request changes" }));

    await waitFor(() => {
      const resumeCall = invoke.mock.calls.find(([command]) => command === "graph_run_resume");
      expect(resumeCall).toBeTruthy();
      expect(resumeCall?.[1]).toMatchObject({
        runId: "graph-run-1",
        request: {
          runId: "graph-run-1",
          decision: "request_changes",
          queueEntryId: "queue-review",
          payload: { notes: "Revise tone" },
        },
      });
    });
  });

  test("previews Git milestones through the explicit Tauri command", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getAllByText("Sales Meeting Brief")[0]).toBeTruthy();
    });
    fireEvent.click(view.getAllByText("Sales Meeting Brief")[0]?.closest("button") as HTMLElement);

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 9/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByRole("button", { name: "View details" })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: "View details" }));

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Preview Git milestone" })).toBeTruthy();
    });
    expect(
      invoke.mock.calls.some(([command]) => command === "graph_run_git_milestone_preview")
    ).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Preview Git milestone" }));

    await waitFor(() => {
      const previewCall = invoke.mock.calls.find(
        ([command]) => command === "graph_run_git_milestone_preview"
      );
      expect(previewCall).toBeTruthy();
      expect(previewCall?.[1]).toMatchObject({
        runId: "graph-run-completed",
        request: {
          runId: "graph-run-completed",
          actionSpecId: "graph-run-completed:git_milestone",
          workspaceRoot: "/tmp/workspace",
        },
      });
      expect(view.getByText(/Ready · 1 changed file/)).toBeTruthy();
    });
  });

  test("renders pinned dashboard runs with dashboard layout and refresh button", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByText("Dashboards")).toBeTruthy();
      expect(view.getAllByText("Dashboard").length).toBeGreaterThan(0);
    });

    const dashboardButton = view.getAllByText("Activity Snapshot")[0]?.closest("button");
    if (!dashboardButton) throw new Error("Expected dashboard playbook button");
    fireEvent.click(dashboardButton);

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 10/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected dashboard run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getAllByText("Latest workspace update").length).toBeGreaterThan(0);
      expect(view.getByText("Activity Snapshot is ready.")).toBeTruthy();
      expect(
        view.getByText("Here's what changed, what's at risk, and what needs follow-up.")
      ).toBeTruthy();
      expect(view.getByText("7")).toBeTruthy();
      expect(view.getByRole("button", { name: /Refresh snapshot/i })).toBeTruthy();
    });
  });

  test("imports a playbook archive and selects the imported playbook", async () => {
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByTitle("Import playbook")).toBeTruthy();
    });
    fireEvent.click(view.getByTitle("Import playbook"));

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith({
        multiple: false,
        filters: [{ name: "Playbook archive", extensions: ["playbook", "zip"] }],
      });
      expect(
        invoke.mock.calls.some(
          ([command, args]) =>
            command === "playbook_import" &&
            (args as Record<string, unknown>).zipPath === "/tmp/reference.playbook.zip"
        )
      ).toBe(true);
      expect(view.getByText("Imported SEO Blog Article 0.1.3 installed.")).toBeTruthy();
      expect(view.getAllByText("Package 0.1.3").length).toBeGreaterThan(0);
      expect(view.getByText("Ready to run")).toBeTruthy();
      expect(view.getAllByText("Imported archive playbook").length).toBeGreaterThan(0);
    });
  });

  test("canceling playbook import leaves state unchanged", async () => {
    openMock.mockImplementation(async () => null);
    const view = renderPlaybooksView();

    await waitFor(() => {
      expect(view.getByTitle("Import playbook")).toBeTruthy();
    });
    fireEvent.click(view.getByTitle("Import playbook"));

    await waitFor(() => {
      expect(openMock).toHaveBeenCalled();
    });
    expect(invoke.mock.calls.some(([command]) => command === "playbook_import")).toBe(false);
  });
});
