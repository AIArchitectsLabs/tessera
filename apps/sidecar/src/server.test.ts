import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const originalServe = Bun.serve;
let isPlaybookRunPreferenceAssignmentPlanValidationError:
  | typeof import("./server.js").isPlaybookRunPreferenceAssignmentPlanValidationError
  | undefined;

beforeAll(async () => {
  (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = ((options) => ({
    port: 0,
    stop() {},
  })) as typeof Bun.serve;

  try {
    const serverModule = await import("./server.js");
    isPlaybookRunPreferenceAssignmentPlanValidationError =
      serverModule.isPlaybookRunPreferenceAssignmentPlanValidationError;
  } finally {
    (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = originalServe;
  }
});

afterAll(() => {
  (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = originalServe;
});

describe("playbook run preference save error mapping", () => {
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
});
