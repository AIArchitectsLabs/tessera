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

  test("resolves fields from a JSON object in an agent text output", () => {
    const agentOutputs = {
      draftSnapshot: {
        text: `{
  "openItems": 15,
  "atRisk": 5,
  "highlights": ["Reels outperformed carousels."],
  "summary": "Reels are the clearest signal."
}

Caveat: counts were inferred from the digest.`,
        boundaryViolations: 0,
      },
    };

    expect(resolveBinding(agentOutputs, "draftSnapshot.openItems")).toBe(15);
    expect(resolveBinding(agentOutputs, "draftSnapshot.highlights")).toEqual([
      "Reels outperformed carousels.",
    ]);
    expect(resolveBinding(agentOutputs, "draftSnapshot.summary")).toBe(
      "Reels are the clearest signal."
    );
    expect(resolveBinding(agentOutputs, "draftSnapshot.text")).toContain("Caveat");
  });

  test("returns the original value if path is empty", () => {
    expect(resolveBinding(outputs, "")).toBeUndefined();
  });
});
