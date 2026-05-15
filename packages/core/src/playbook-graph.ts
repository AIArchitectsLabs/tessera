import { createHash } from "node:crypto";
import {
  type PlaybookGraph,
  PlaybookGraphSchema,
  type PlaybookGraphNode,
} from "@tessera/contracts";

const TERMINAL_GRAPH_STEPS = new Set(["completed", "failed", "denied"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!isRecord(nested)) return nested;

    return Object.keys(nested)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = nested[key];
        return accumulator;
      }, {});
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashPlaybookGraph(graph: unknown): string {
  const parsed = PlaybookGraphSchema.parse(graph);
  return sha256(stableJsonStringify(parsed));
}

export function hashPlaybookSourceFiles(files: Record<string, string>): string {
  return sha256(stableJsonStringify(files));
}

function transitionTargets(node: PlaybookGraphNode): string[] {
  const targets = [node.onSuccess, node.onFailure].filter((value): value is string =>
    typeof value === "string"
  );

  if (node.kind === "condition") {
    targets.push(node.onTrue, node.onFalse);
  }
  if (node.kind === "humanReview") {
    if (node.onApprove !== undefined) targets.push(node.onApprove);
    if (node.onRequestChanges !== undefined) targets.push(node.onRequestChanges);
  }

  return targets;
}

function outputArtifacts(node: PlaybookGraphNode): string[] {
  if (node.kind === "script" || node.kind === "tool" || node.kind === "join") {
    return node.outputArtifact === undefined ? [] : [node.outputArtifact];
  }

  if (node.kind === "parallelMap") {
    return node.outputArtifact === undefined ? [] : [node.outputArtifact];
  }

  if (node.kind === "agent" && node.output?.artifact !== undefined) {
    return [node.output.artifact];
  }

  return [];
}

function collectArtifactRefs(value: unknown, refs: string[]): void {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      for (const item of value) collectArtifactRefs(item, refs);
    }
    return;
  }

  if (typeof value.artifact === "string") {
    refs.push(value.artifact);
  }

  for (const nested of Object.values(value)) {
    collectArtifactRefs(nested, refs);
  }
}

function consumedArtifacts(node: PlaybookGraphNode): string[] {
  const refs: string[] = [];

  if (node.kind === "script" || node.kind === "agent") {
    collectArtifactRefs(node.inputs, refs);
  }
  if (node.kind === "parallelMap") {
    collectArtifactRefs(node.items, refs);
  }
  if (node.kind === "humanReview") {
    collectArtifactRefs({ artifact: node.artifact }, refs);
  }
  if (node.kind === "condition") {
    collectArtifactRefs(node.when, refs);
  }
  if (node.kind === "artifactWrite") {
    collectArtifactRefs({ artifact: node.artifact }, refs);
  }

  return refs;
}

function validateGraphNodes(options: {
  artifacts: Set<string>;
  nodes: PlaybookGraphNode[];
  start: string;
  path: string;
}): void {
  const nodeIds = new Set<string>();

  for (const node of options.nodes) {
    if (nodeIds.has(node.id)) {
      throw new Error(`Duplicate node id at ${options.path}: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  if (!nodeIds.has(options.start)) {
    throw new Error(`Unknown start node at ${options.path}: ${options.start}`);
  }

  for (const node of options.nodes) {
    for (const target of transitionTargets(node)) {
      if (!nodeIds.has(target) && !TERMINAL_GRAPH_STEPS.has(target)) {
        throw new Error(`Unknown transition from ${options.path}.${node.id}: ${target}`);
      }
    }

    for (const artifact of outputArtifacts(node)) {
      if (!options.artifacts.has(artifact)) {
        throw new Error(`Unknown artifact produced by ${options.path}.${node.id}: ${artifact}`);
      }
    }

    for (const artifact of consumedArtifacts(node)) {
      if (!options.artifacts.has(artifact)) {
        throw new Error(`Unknown artifact consumed by ${options.path}.${node.id}: ${artifact}`);
      }
    }

    if (node.kind === "parallelMap") {
      validateGraphNodes({
        artifacts: options.artifacts,
        nodes: node.branch.nodes,
        start: node.branch.start,
        path: `${options.path}.${node.id}.branch`,
      });
    }
  }
}

export function validatePlaybookGraph(graph: unknown): PlaybookGraph {
  const parsed = PlaybookGraphSchema.parse(graph);

  validateGraphNodes({
    artifacts: new Set(Object.keys(parsed.artifacts)),
    nodes: parsed.nodes,
    start: parsed.start,
    path: parsed.id,
  });

  const { description, ...rest } = parsed;
  if (description === undefined) {
    return rest as PlaybookGraph;
  }

  return { ...rest, description } as PlaybookGraph;
}
