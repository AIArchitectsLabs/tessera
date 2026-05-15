import type { CompiledPlaybookGraph } from "@tessera/contracts";
import { CompiledPlaybookGraphSchema } from "@tessera/contracts";
import {
  hashPlaybookGraph,
  hashPlaybookSourceFiles,
  validatePlaybookGraph,
} from "./playbook-graph.js";

export interface CompilePlaybookGraphOptions {
  graph: unknown;
  sourceFiles: Record<string, string>;
  compilerVersion: string;
  scriptSdkVersion: string;
  compiledAt?: string;
}

export function compilePlaybookGraph(options: CompilePlaybookGraphOptions): CompiledPlaybookGraph {
  const graph = validatePlaybookGraph(options.graph);

  return CompiledPlaybookGraphSchema.parse({
    graph,
    metadata: {
      schemaVersion: 1,
      playbookId: graph.id,
      packageVersion: graph.version,
      compilerVersion: options.compilerVersion,
      graphSchemaVersion: 1,
      scriptSdkVersion: options.scriptSdkVersion,
      sourceHash: hashPlaybookSourceFiles(options.sourceFiles),
      graphHash: hashPlaybookGraph(graph),
      compiledAt: options.compiledAt ?? new Date().toISOString(),
    },
  });
}
