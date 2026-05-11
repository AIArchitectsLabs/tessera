import { describe, expect, test } from "bun:test";
import { resolveBinding } from "./dashboard-layout.js";

describe("resolveBinding", () => {
  const outputs = {
    draftSnapshot: {
      openDeals: 14,
      atRisk: 3,
      riskItems: [{ name: "Acme" }, { name: "Globex" }],
      summary: "Three deals advanced.",
    },
  };

  test("resolves a top-level key", () => {
    expect(resolveBinding({ draftSnapshot: { x: 1 } }, "draftSnapshot")).toEqual({ x: 1 });
  });

  test("resolves a nested key via dot path", () => {
    expect(resolveBinding(outputs, "draftSnapshot.openDeals")).toBe(14);
  });

  test("returns undefined for an unknown path", () => {
    expect(resolveBinding(outputs, "draftSnapshot.ghost")).toBeUndefined();
  });

  test("returns undefined when traversing through a non-object", () => {
    expect(resolveBinding(outputs, "draftSnapshot.openDeals.x")).toBeUndefined();
  });

  test("returns the original value if path is empty", () => {
    expect(resolveBinding(outputs, "")).toBeUndefined();
  });
});
