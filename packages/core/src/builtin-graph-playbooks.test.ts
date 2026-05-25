import { describe, expect, test } from "bun:test";
import {
  BUILTIN_GRAPH_PLAYBOOK_ROOTS,
  loadBuiltInGraphPlaybookPackages,
} from "./builtin-graph-playbooks.js";
import { readPlaybookGraphPackage } from "./playbook-graph-package.js";

const BUILTIN_IDS = [
  "customer.renewal-risk-review",
  "operations.weekly-status-digest",
  "ops.activity-snapshot",
  "sales.meeting-brief",
];

describe("built-in graph playbooks", () => {
  test("compile all built-in graph packages with stable playbook ids", async () => {
    const loaded = await loadBuiltInGraphPlaybookPackages({
      compilerVersion: "test",
      scriptSdkVersion: "test",
      compiledAt: "2026-05-16T00:00:00.000Z",
    });

    expect(loaded.map((entry) => entry.compiled.graph.id)).toEqual(BUILTIN_IDS);
    for (const entry of loaded) {
      expect(entry.compiled.graph.version).toBe("1");
      expect(entry.compiled.metadata.graphHash).toMatch(/^sha256:/);
      expect(entry.compiled.metadata.sourceHash).toMatch(/^sha256:/);
      expect(entry.compiled.graph.metadata).toBeDefined();
    }
  });

  test("packages are valid collected source bundles", async () => {
    for (const id of BUILTIN_IDS) {
      const root = BUILTIN_GRAPH_PLAYBOOK_ROOTS[id];
      if (root === undefined) throw new Error(`Missing built-in graph root: ${id}`);
      const packageFiles = await readPlaybookGraphPackage(root);
      expect(packageFiles.manifest.id).toBe(id);
      expect(packageFiles.sourceFiles["playbook.ts"]).toContain("export default");
      expect(Object.keys(packageFiles.sourceFiles)).toContain("manifest.json");
    }
  });

  test("review-oriented built-ins materialize approved artifacts to the workspace", async () => {
    const loaded = await loadBuiltInGraphPlaybookPackages({
      compilerVersion: "test",
      scriptSdkVersion: "test",
      compiledAt: "2026-05-16T00:00:00.000Z",
    });

    for (const id of [
      "customer.renewal-risk-review",
      "operations.weekly-status-digest",
      "sales.meeting-brief",
    ]) {
      const entry = loaded.find((candidate) => candidate.compiled.graph.id === id);
      if (!entry) throw new Error(`Missing built-in graph: ${id}`);
      const agent = entry.compiled.graph.nodes.find((node) => node.kind === "agent");
      const review = entry.compiled.graph.nodes.find((node) => node.kind === "humanReview");
      const write = entry.compiled.graph.nodes.find((node) => node.kind === "effect");

      expect(agent?.onSuccess).toBe(review?.id);
      expect(review?.onApprove).toBe(write?.id);
      expect(review?.onRequestChanges).toBe(agent?.id);
      expect(write?.onSuccess).toBe("completed");
      expect(write?.effectId).toBe("workspace.write");
      expect(write?.capability).toBe("tool.workspace.write");
      expect(write?.input.path).toContain("{{inputs.");
    }
  });

  test("sales meeting brief exposes only the customer-facing brief artifact", async () => {
    const loaded = await loadBuiltInGraphPlaybookPackages({
      compilerVersion: "test",
      scriptSdkVersion: "test",
      compiledAt: "2026-05-16T00:00:00.000Z",
    });
    const entry = loaded.find((candidate) => candidate.compiled.graph.id === "sales.meeting-brief");
    if (!entry) throw new Error("Missing Sales Meeting Brief built-in graph");

    expect(entry.compiled.graph.metadata?.outputs).toEqual([
      {
        kind: "meetingBrief",
        label: "Meeting brief",
      },
    ]);
    expect(Object.keys(entry.compiled.graph.artifacts)).toEqual(["meetingBrief"]);
    expect(entry.sourceFiles["prompts/draft-brief.md"]).toContain(
      "Return only the final meeting brief as Markdown"
    );
    expect(entry.sourceFiles["prompts/draft-brief.md"]).toContain(
      "Do not include internal working notes"
    );
    expect(entry.sourceFiles["prompts/draft-brief.md"]).not.toContain(
      "and include account context"
    );
  });

  test("renewal risk review exposes only the customer-facing brief artifact", async () => {
    const loaded = await loadBuiltInGraphPlaybookPackages({
      compilerVersion: "test",
      scriptSdkVersion: "test",
      compiledAt: "2026-05-16T00:00:00.000Z",
    });
    const entry = loaded.find(
      (candidate) => candidate.compiled.graph.id === "customer.renewal-risk-review"
    );
    if (!entry) throw new Error("Missing Renewal Risk Review built-in graph");

    expect(entry.compiled.graph.metadata?.outputs).toEqual([
      {
        kind: "businessBrief",
        label: "Renewal risk brief",
      },
    ]);
    expect(Object.keys(entry.compiled.graph.artifacts)).toEqual(["businessBrief"]);
    expect(entry.sourceFiles["prompts/draft-risk-review.md"]).toContain(
      "Return only the final renewal risk brief as Markdown"
    );
    expect(entry.sourceFiles["prompts/draft-risk-review.md"]).toContain(
      "Do not include internal working notes"
    );
    expect(entry.sourceFiles["prompts/draft-risk-review.md"]).not.toContain("and source gaps");
  });

  test("weekly status digest exposes only the stakeholder-facing digest artifact", async () => {
    const loaded = await loadBuiltInGraphPlaybookPackages({
      compilerVersion: "test",
      scriptSdkVersion: "test",
      compiledAt: "2026-05-16T00:00:00.000Z",
    });
    const entry = loaded.find(
      (candidate) => candidate.compiled.graph.id === "operations.weekly-status-digest"
    );
    if (!entry) throw new Error("Missing Weekly Status Digest built-in graph");

    expect(entry.compiled.graph.metadata?.outputs).toEqual([
      {
        kind: "statusDigest",
        label: "Weekly status digest",
      },
    ]);
    expect(Object.keys(entry.compiled.graph.artifacts)).toEqual(["statusDigest"]);
    expect(entry.sourceFiles["prompts/draft-status-digest.md"]).toContain(
      "Return only the final weekly status digest as Markdown"
    );
    expect(entry.sourceFiles["prompts/draft-status-digest.md"]).toContain(
      "Do not include internal working notes"
    );
    expect(entry.sourceFiles["prompts/draft-status-digest.md"]).not.toContain("and source gaps");
  });

  test("activity snapshot preserves the legacy refreshable dashboard contract", async () => {
    const loaded = await loadBuiltInGraphPlaybookPackages({
      compilerVersion: "test",
      scriptSdkVersion: "test",
      compiledAt: "2026-05-16T00:00:00.000Z",
    });
    const entry = loaded.find(
      (candidate) => candidate.compiled.graph.id === "ops.activity-snapshot"
    );
    if (!entry) throw new Error("Missing Activity Snapshot built-in graph");

    expect(entry.compiled.graph.metadata?.outputs).toEqual([
      {
        kind: "dashboard",
        label: "Activity dashboard",
        layout: "layouts/dashboard.json",
      },
    ]);
    expect(entry.compiled.graph.metadata?.phases).toEqual(["Summarize"]);
    expect(entry.compiled.graph.nodes).toHaveLength(1);
    expect(entry.compiled.graph.nodes[0]).toMatchObject({
      id: "draftSnapshot",
      kind: "agent",
      onSuccess: "completed",
      output: { artifact: "dashboard", schema: "schemas/dashboard.schema.json" },
    });
    expect(entry.compiled.graph.nodes.some((node) => node.kind === "humanReview")).toBe(false);
    expect(entry.compiled.graph.nodes.some((node) => node.kind === "artifactWrite")).toBe(false);
    expect(JSON.parse(entry.sourceFiles["layouts/dashboard.json"] ?? "{}")).toEqual({
      refreshLabel: "Refresh snapshot",
      sections: [
        {
          type: "metrics",
          title: "Activity",
          items: [
            { label: "Open items", binding: "draftSnapshot.openItems" },
            { label: "At risk", binding: "draftSnapshot.atRisk" },
          ],
        },
        {
          type: "list",
          title: "Highlights",
          binding: "draftSnapshot.highlights",
          emptyLabel: "No highlights yet.",
        },
        { type: "text", title: "Summary", binding: "draftSnapshot.summary" },
      ],
    });
    expect(entry.sourceFiles["prompts/draft-snapshot.md"]).toContain(
      "do not leave highlights or summary blank"
    );
  });
});
