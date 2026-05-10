import { describe, expect, test } from "bun:test";
import { buildBrowserRecipeProposal } from "./browser-recipes.js";

describe("buildBrowserRecipeProposal", () => {
  test("builds a read-only draft recipe from successful browser actions", () => {
    const proposal = buildBrowserRecipeProposal({
      goal: "Inspect Example",
      sessionId: "session-1",
      taskId: "task-1",
      createdAt: "2026-05-10T00:00:00.000Z",
      actions: [
        { action: "open", url: "https://example.com" },
        { action: "see", url: "https://example.com", expectedState: "Example Domain" },
      ],
      artifacts: [{ title: "Screenshot", path: "/tmp/example.png" }],
    });

    expect(proposal.domain).toBe("example.com");
    expect(proposal.status).toBe("draft");
    expect(proposal.permissions).toEqual(["browser.read"]);
    expect(proposal.steps).toHaveLength(2);
  });

  test("marks click and type recipes as action recipes", () => {
    const proposal = buildBrowserRecipeProposal({
      goal: "Search Example",
      sessionId: "session-1",
      createdAt: "2026-05-10T00:00:00.000Z",
      actions: [
        { action: "open", url: "https://example.com" },
        { action: "click", selector: "button.search", expectedState: "Search opens" },
        { action: "type", selector: "input", text: "tessera" },
      ],
      artifacts: [],
    });

    expect(proposal.permissions).toEqual(["browser.read", "browser.action"]);
  });
});
