import { describe, expect, test } from "bun:test";
import {
  MemoryReviewDecisionRequestSchema,
  MemoryReviewListResultSchema,
  MemoryRuntimeStatusSchema,
} from "./index";

describe("memory contracts", () => {
  test("parses active memory runtime status", () => {
    const parsed = MemoryRuntimeStatusSchema.parse({
      enabled: true,
      mode: "active",
      dbPath: "/tmp/tessera-memory.sqlite",
    });

    expect(parsed.mode).toBe("active");
  });

  test("parses fallback startup warning", () => {
    const parsed = MemoryRuntimeStatusSchema.parse({
      enabled: false,
      mode: "fallback",
      dbPath: "/unavailable/memory.sqlite",
      startupWarning: {
        type: "tessera.memory.startup_failed",
        message: "sqlite unavailable",
      },
    });

    expect(parsed.startupWarning?.message).toBe("sqlite unavailable");
  });

  test("parses memory review list results", () => {
    const memory = {
      id: "memory-1",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "workspace",
      type: "preference",
      title: "Weekly style",
      body: "Prefer concise bullets.",
      status: "active",
      confidence: 0.92,
      freshness: "fresh",
      sourceEventIds: ["event-1"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };

    const parsed = MemoryReviewListResultSchema.parse({
      active: [memory],
      candidates: [
        {
          ...memory,
          id: "memory-candidate-1",
          status: "candidate",
          rationale: {
            supportingEventIds: ["event-1"],
            conflictingMemoryIds: [],
            promotionReason: "Needs review.",
            riskFlags: ["low_confidence"],
          },
        },
      ],
    });

    expect(parsed.active[0]?.status).toBe("active");
    expect(parsed.candidates[0]?.rationale.riskFlags).toEqual(["low_confidence"]);
  });

  test("parses memory review decisions", () => {
    const parsed = MemoryReviewDecisionRequestSchema.parse({
      memoryId: "memory-candidate-1",
      decision: "accept",
      reason: "User accepted candidate.",
      decidedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(parsed.memoryId).toBe("memory-candidate-1");
  });
});
