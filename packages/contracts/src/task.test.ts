import { describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  BrowserRecipeProposalSchema,
  MemoryCandidateSchema,
  MemoryEventSchema,
  MemoryForgetRequestSchema,
  MemoryPromotionDecisionSchema,
  MemoryRecallRequestSchema,
  MemoryRecallResultSchema,
  TaskArtifactSchema,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskDetailSchema,
  TaskListResultSchema,
  TaskSummarySchema,
  TaskUpdateRequestSchema,
  compileAgentRuntimeContext,
} from "./index.js";

describe("task contracts", () => {
  test("accepts draft browser recipe proposal contracts", () => {
    const parsed = BrowserRecipeProposalSchema.parse({
      id: "recipe-1",
      status: "draft",
      domain: "example.com",
      goal: "Inspect Example",
      source: { taskId: "task-1", sessionId: "session-1" },
      permissions: ["browser.read"],
      steps: [
        {
          action: "open",
          url: "https://example.com",
          expectedState: "Example Domain page is visible",
        },
        {
          action: "see",
          expectedState: "Readable page text is extracted",
        },
      ],
      artifacts: [{ title: "Screenshot", path: "/tmp/example.png" }],
      createdAt: "2026-05-10T00:00:00.000Z",
    });

    expect(parsed.status).toBe("draft");
    expect(parsed.permissions).toEqual(["browser.read"]);
  });

  test("accepts workspace task summaries", () => {
    const parsed = TaskSummarySchema.parse({
      id: "task-1",
      workspaceRoot: "/workspace/acme",
      title: "Draft announcement",
      status: "done",
      agentId: "default",
      agentLabel: "Maeve",
      latestActivity: "Created draft artifact",
      createdAt: "2026-04-30T10:00:00.000Z",
      updatedAt: "2026-04-30T10:01:00.000Z",
    });

    expect(parsed.workspaceRoot).toBe("/workspace/acme");
    expect(parsed.status).toBe("done");
    expect(parsed.agentId).toBe("default");
  });

  test("rejects tasks without a workspace root", () => {
    const parsed = TaskCreateRequestSchema.safeParse({
      initialInstruction: "Do work",
    });

    expect(parsed.success).toBe(false);
  });

  test("accepts task detail with turns and artifacts", () => {
    const agentContext = compileAgentRuntimeContext(
      AgentProfileSchema.parse({
        id: "ops",
        name: "Ops",
        model: { mode: "default" },
        instructions: "Keep deliverables concrete.",
        createdAt: "2026-04-30T10:00:00.000Z",
        updatedAt: "2026-04-30T10:00:00.000Z",
      })
    );
    const detail = TaskDetailSchema.parse({
      id: "task-1",
      workspaceRoot: "/workspace/acme",
      title: "Draft announcement",
      status: "done",
      agentContext,
      createdAt: "2026-04-30T10:00:00.000Z",
      updatedAt: "2026-04-30T10:01:00.000Z",
      turns: [
        {
          id: "turn-1",
          taskId: "task-1",
          role: "user",
          content: "Draft a launch announcement",
          status: "completed",
          createdAt: "2026-04-30T10:00:00.000Z",
          completedAt: "2026-04-30T10:00:01.000Z",
        },
        {
          id: "turn-2",
          taskId: "task-1",
          role: "agent",
          content: "Created an initial draft.",
          status: "completed",
          createdAt: "2026-04-30T10:00:01.000Z",
          completedAt: "2026-04-30T10:00:02.000Z",
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          taskId: "task-1",
          turnId: "turn-2",
          kind: "text",
          title: "Task output",
          contentPreview: "Draft output",
          createdAt: "2026-04-30T10:00:02.000Z",
        },
      ],
    });

    expect(detail.turns).toHaveLength(2);
    expect(detail.artifacts[0]?.turnId).toBe("turn-2");
    expect(detail.agentContext?.toolPolicy.preset).toBe("workspace_editor");
  });

  test("accepts list, update, turn create, and artifact shapes", () => {
    expect(
      TaskListResultSchema.parse({
        tasks: [
          {
            id: "task-1",
            workspaceRoot: "/workspace/acme",
            title: "Draft announcement",
            status: "active",
            createdAt: "2026-04-30T10:00:00.000Z",
            updatedAt: "2026-04-30T10:00:00.000Z",
          },
        ],
      }).tasks
    ).toHaveLength(1);

    expect(TaskUpdateRequestSchema.parse({ status: "waiting", latestActivity: "Waiting" })).toEqual(
      {
        status: "waiting",
        latestActivity: "Waiting",
      }
    );

    expect(TaskCreateTurnRequestSchema.parse({ content: "Revise it" }).content).toBe("Revise it");

    expect(
      TaskArtifactSchema.parse({
        id: "artifact-1",
        taskId: "task-1",
        kind: "text",
        title: "Output",
        createdAt: "2026-04-30T10:00:00.000Z",
      }).kind
    ).toBe("text");
  });

  test("accepts memory event contracts", () => {
    const parsed = MemoryEventSchema.parse({
      id: "memory-event-1",
      eventKey: "task:task-1:turn:turn-1:completed",
      workspaceKey: "workspace:abc123",
      ownerId: "local-owner",
      scope: "task",
      subjectType: "turn",
      subjectId: "turn-1",
      eventType: "task.turn.completed",
      content: "User asked for a weekly sales digest.",
      contentHash: "sha256:abc123",
      metadata: { taskId: "task-1" },
      sensitivity: "public",
      capturePolicy: "summary",
      schemaVersion: 1,
      createdAt: "2026-05-13T00:00:00.000Z",
    });

    expect(parsed.scope).toBe("task");
    expect(parsed.capturePolicy).toBe("summary");
  });

  test("applies memory defaults on parse", () => {
    const event = MemoryEventSchema.parse({
      id: "memory-event-2",
      eventKey: "task:task-2:turn:turn-1:completed",
      scope: "task",
      subjectType: "turn",
      subjectId: "turn-1",
      eventType: "task.turn.completed",
      content: "Prefer concise bullets.",
      contentHash: "sha256:def456",
      sensitivity: "public",
      capturePolicy: "summary",
      schemaVersion: 1,
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    const request = MemoryRecallRequestSchema.parse({
      mode: "task",
      query: "weekly update",
    });
    const result = MemoryRecallResultSchema.parse({
      mode: "none",
      items: [],
      trace: {
        query: "weekly update",
        candidateCount: 0,
        selectedCount: 0,
        durationMs: 3,
      },
    });

    expect(event.metadata).toEqual({});
    expect(request.maxCharacters).toBe(1500);
    expect(result.timedOut).toBe(false);
    expect(result.trace.omittedReasons).toEqual([]);
  });

  test("accepts memory recall results with traces", () => {
    const parsed = MemoryRecallResultSchema.parse({
      mode: "task",
      timedOut: false,
      items: [
        {
          memoryId: "memory-1",
          scope: "workspace",
          type: "preference",
          title: "Weekly update style",
          body: "Prefer concise bullets with source links.",
          confidence: 0.9,
          freshness: "fresh",
          sourceRefs: [{ type: "task", id: "task-1" }],
          reason: "Matched workspace and weekly update request.",
        },
      ],
      trace: {
        query: "weekly update",
        workspaceKey: "workspace:abc123",
        candidateCount: 3,
        selectedCount: 1,
        omittedReasons: ["2 memories exceeded the prompt budget"],
        durationMs: 12,
      },
    });

    expect(parsed.items[0]?.reason).toContain("Matched");
    expect(parsed.trace.selectedCount).toBe(1);
  });

  test("rejects contradictory memory recall results", () => {
    expect(
      MemoryRecallResultSchema.safeParse({
        mode: "none",
        timedOut: true,
        items: [
          {
            memoryId: "memory-1",
            scope: "workspace",
            type: "preference",
            title: "Weekly update style",
            body: "Prefer concise bullets with source links.",
            confidence: 0.9,
            freshness: "fresh",
            sourceRefs: [{ type: "task", id: "task-1" }],
            reason: "Matched workspace and weekly update request.",
          },
        ],
        trace: {
          query: "weekly update",
          candidateCount: 1,
          selectedCount: 1,
          durationMs: 12,
        },
      }).success
    ).toBe(false);
  });

  test("rejects recall results when selected count exceeds candidates", () => {
    expect(
      MemoryRecallResultSchema.safeParse({
        mode: "task",
        timedOut: false,
        items: [
          {
            memoryId: "memory-1",
            scope: "workspace",
            type: "preference",
            title: "Weekly update style",
            body: "Prefer concise bullets with source links.",
            confidence: 0.9,
            freshness: "fresh",
            sourceRefs: [{ type: "task", id: "task-1" }],
            reason: "Matched workspace and weekly update request.",
          },
        ],
        trace: {
          query: "weekly update",
          candidateCount: 0,
          selectedCount: 1,
          durationMs: 12,
        },
      }).success
    ).toBe(false);
  });

  test("rejects invalid memory bounds and schema versions", () => {
    expect(
      MemoryCandidateSchema.safeParse({
        id: "memory-2",
        scope: "workspace",
        type: "preference",
        title: "Weekly update style",
        body: "Prefer concise bullets with source links.",
        status: "candidate",
        confidence: 1.1,
        freshness: "fresh",
        sourceEventIds: ["memory-event-1"],
        sourceDocumentIds: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
        rationale: {
          supportingEventIds: ["memory-event-1"],
          conflictingMemoryIds: [],
          promotionReason: "Matches the weekly update workflow.",
          riskFlags: [],
        },
      }).success
    ).toBe(false);

    expect(
      MemoryRecallResultSchema.safeParse({
        mode: "task",
        items: [],
        trace: {
          query: "weekly update",
          candidateCount: -1,
          selectedCount: 0,
          durationMs: 1,
        },
      }).success
    ).toBe(false);

    expect(
      MemoryRecallResultSchema.safeParse({
        mode: "task",
        items: [],
        trace: {
          query: "weekly update",
          candidateCount: 1,
          selectedCount: 0.5,
          durationMs: 1,
        },
      }).success
    ).toBe(false);

    expect(
      MemoryEventSchema.safeParse({
        id: "memory-event-3",
        eventKey: "task:task-3:turn:turn-1:completed",
        scope: "task",
        subjectType: "turn",
        subjectId: "turn-1",
        eventType: "task.turn.completed",
        content: "User asked for a weekly sales digest.",
        contentHash: "sha256:ghi789",
        sensitivity: "public",
        capturePolicy: "summary",
        schemaVersion: 2,
        createdAt: "2026-05-13T00:00:00.000Z",
      }).success
    ).toBe(false);
  });

  test("accepts memory recall request contracts", () => {
    const parsed = MemoryRecallRequestSchema.parse({
      mode: "workspace",
      query: "weekly update",
      workspaceKey: "workspace:abc123",
      ownerId: "local-owner",
      taskId: "task-1",
    });

    expect(parsed.maxCharacters).toBe(1500);
    expect(parsed.workspaceKey).toBe("workspace:abc123");
  });

  test("accepts memory candidate contracts", () => {
    const parsed = MemoryCandidateSchema.parse({
      id: "memory-2",
      workspaceKey: "workspace:abc123",
      scope: "workspace",
      type: "preference",
      title: "Weekly update style",
      body: "Prefer concise bullets with source links.",
      status: "candidate",
      confidence: 0.8,
      freshness: "fresh",
      sourceEventIds: ["memory-event-1"],
      sourceDocumentIds: ["doc-1"],
      supersedesMemoryId: "memory-1",
      lastUsedAt: "2026-05-13T00:01:00.000Z",
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:01:00.000Z",
      rationale: {
        supportingEventIds: ["memory-event-1"],
        conflictingMemoryIds: ["memory-0"],
        promotionReason: "Matches the weekly update workflow.",
        riskFlags: ["low_confidence"],
      },
    });

    expect(parsed.status).toBe("candidate");
    expect(parsed.rationale.promotionReason).toContain("Matches");
  });

  test("accepts memory promotion decision contracts", () => {
    const parsed = MemoryPromotionDecisionSchema.parse({
      candidateId: "memory-2",
      decision: "accept",
      reason: "Strong match for the requested update format.",
      decidedAt: "2026-05-13T00:02:00.000Z",
    });

    expect(parsed.decision).toBe("accept");
    expect(parsed.candidateId).toBe("memory-2");
  });

  test("accepts memory forget requests", () => {
    const parsed = MemoryForgetRequestSchema.parse({
      memoryId: "memory-1",
      reason: "User asked to forget this preference",
      requestedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(parsed.memoryId).toBe("memory-1");
  });
});
