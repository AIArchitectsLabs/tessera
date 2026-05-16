import { describe, expect, test } from "bun:test";
import {
  BUILTIN_GRAPH_PLAYBOOK_ROOTS,
  loadBuiltInGraphPlaybookPackages,
} from "./builtin-graph-playbooks.js";
import { readPlaybookGraphPackage } from "./playbook-graph-package.js";

const BUILTIN_IDS = [
  "customer.renewal-risk-review",
  "demo.write-approval",
  "operations.weekly-status-digest",
  "ops.activity-snapshot",
  "ops.weekly-update",
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
});
