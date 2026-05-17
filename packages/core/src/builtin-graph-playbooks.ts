import { join } from "node:path";
import { BUILTIN_GRAPH_PLAYBOOK_SOURCE_BUNDLES } from "./builtin-graph-playbook-bundles.generated.js";
import type { LoadedGraphPlaybookPackage } from "./playbook-graph-package-loader.js";
import {
  loadCollectedGraphPlaybookPackage,
  loadGraphPlaybookPackage,
} from "./playbook-graph-package-loader.js";

const BUILTIN_GRAPH_PLAYBOOKS_DIR = join(import.meta.dir, "builtin-graph-playbooks");

export const BUILTIN_GRAPH_PLAYBOOK_ROOTS: Record<string, string> = {
  "customer.renewal-risk-review": join(BUILTIN_GRAPH_PLAYBOOKS_DIR, "customer.renewal-risk-review"),
  "demo.write-approval": join(BUILTIN_GRAPH_PLAYBOOKS_DIR, "demo.write-approval"),
  "ops.activity-snapshot": join(BUILTIN_GRAPH_PLAYBOOKS_DIR, "ops.activity-snapshot"),
  "operations.weekly-status-digest": join(BUILTIN_GRAPH_PLAYBOOKS_DIR, "ops.weekly-status-digest"),
  "ops.weekly-update": join(BUILTIN_GRAPH_PLAYBOOKS_DIR, "ops.weekly-update"),
  "sales.meeting-brief": join(BUILTIN_GRAPH_PLAYBOOKS_DIR, "sales.meeting-brief"),
};

export async function loadBuiltInGraphPlaybookPackages(options: {
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
  roots?: Record<string, string>;
}): Promise<LoadedGraphPlaybookPackage[]> {
  const packages = await Promise.all(
    Object.entries(options.roots ?? BUILTIN_GRAPH_PLAYBOOK_SOURCE_BUNDLES)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([id, source]) => {
        const loaded =
          typeof source === "string"
            ? await loadGraphPlaybookPackage({
                root: source,
                compilerVersion: options.compilerVersion,
                scriptSdkVersion: options.scriptSdkVersion,
                ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
              })
            : loadCollectedGraphPlaybookPackage({
                root: BUILTIN_GRAPH_PLAYBOOK_ROOTS[id] ?? `builtin:${id}`,
                sourceFiles: source.sourceFiles,
                compilerVersion: options.compilerVersion,
                scriptSdkVersion: options.scriptSdkVersion,
                ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
              });
        if (loaded.compiled.graph.id !== id) {
          throw new Error(
            `Built-in graph playbook root id mismatch: expected ${id}, got ${loaded.compiled.graph.id}`
          );
        }
        return loaded;
      })
  );
  return packages;
}
