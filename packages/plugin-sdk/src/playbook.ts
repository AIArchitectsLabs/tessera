import { type PlaybookGraph, PlaybookGraphSchema } from "@tessera/contracts";

export function definePlaybook(graph: unknown): PlaybookGraph {
  return PlaybookGraphSchema.parse(graph) as PlaybookGraph;
}
