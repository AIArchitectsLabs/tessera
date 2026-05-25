import {
  type CompiledPlaybookGraph,
  type PlaybookAssignmentPreviewResult,
  PlaybookAssignmentPreviewResultSchema,
  type WorkflowCapabilityInventory,
  type WorkflowNodeAssignment,
  type WorkflowRunAssignmentPlan,
  type WorkflowSourceGap,
} from "@tessera/contracts";

const LEGACY_CAPABILITY_ALIASES: Record<string, string[]> = {
  web: ["integration.search.read"],
  calendar: ["integration.calendar.events.read"],
  mail: ["integration.mail.read"],
  drive: ["integration.drive.read"],
  contacts: ["integration.contacts.read"],
};

export interface ResolvePlaybookGraphPreflightOptions {
  compiledGraph: CompiledPlaybookGraph;
  capabilityInventory?: WorkflowCapabilityInventory;
  previousPlan?: WorkflowRunAssignmentPlan;
  now?: Date;
}

function titleFromId(id: string): string {
  return id
    .replace(/[-_.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function assignmentForInventoryAgent(
  stepId: string,
  agent: WorkflowCapabilityInventory["agents"][number]
): WorkflowNodeAssignment {
  return {
    stepId,
    agentId: agent.id,
    agentLabel: agent.label,
    agentFingerprint: agent.fingerprint,
    skillCapabilities: agent.skillCapabilities,
    toolCapabilities: agent.toolCapabilities,
    integrationCapabilities: [],
  };
}

function inventoryCapabilityIds(inventory: WorkflowCapabilityInventory): Set<string> {
  return new Set([
    ...inventory.tools.map((tool) => tool.id),
    ...inventory.integrations.flatMap((integration) =>
      integration.configured ? integration.capabilities : []
    ),
    ...inventory.agents.flatMap((agent) => [
      ...agent.modelCapabilities,
      ...agent.skillCapabilities,
      ...agent.toolCapabilities,
    ]),
    ...inventory.models.flatMap((model) => (model.hasCredential ? model.capabilities : [])),
  ]);
}

function capabilitySatisfied(capability: string, available: Set<string>): boolean {
  if (available.has(capability)) return true;
  return (LEGACY_CAPABILITY_ALIASES[capability] ?? []).some((alias) => available.has(alias));
}

function capabilityKind(capability: string): WorkflowSourceGap["kind"] {
  if (capability.startsWith("tool.")) return "tool";
  if (capability.startsWith("skill.")) return "skill";
  if (capability.startsWith("model.")) return "model";
  return "integration";
}

function graphRequiredCapabilities(graph: CompiledPlaybookGraph["graph"]): Set<string> {
  const required = graph.metadata?.requiredCapabilities;
  return new Set(
    Array.isArray(required)
      ? required.filter((value): value is string => typeof value === "string")
      : []
  );
}

export function resolvePlaybookGraphPreflight(
  options: ResolvePlaybookGraphPreflightOptions
): PlaybookAssignmentPreviewResult {
  const { compiledGraph, capabilityInventory, previousPlan } = options;
  const createdAt = (options.now ?? new Date()).toISOString();
  const graph = compiledGraph.graph;
  const requiredCapabilities = graphRequiredCapabilities(graph);
  const blockers: WorkflowSourceGap[] = [];
  const sourceGaps: WorkflowSourceGap[] = [];
  const assignments: WorkflowRunAssignmentPlan["assignments"] = {};

  const agentSteps = graph.nodes.filter((node) => node.kind === "agent");
  if (!capabilityInventory) {
    if (agentSteps.length > 0) {
      blockers.push({
        stepId: agentSteps[0]?.id ?? graph.start,
        kind: "model",
        capability: "model.reasoning",
        optional: false,
        reason: "Capability inventory is required before assigning graph agent steps.",
      });
    }
    for (const capability of graph.capabilities ?? []) {
      const optional = !requiredCapabilities.has(capability);
      const gap = {
        stepId: graph.start,
        kind: capabilityKind(capability),
        capability,
        optional,
        reason: "Capability inventory is required before preflight can verify this capability.",
      };
      if (optional) sourceGaps.push(gap);
      else blockers.push(gap);
    }
    return PlaybookAssignmentPreviewResultSchema.parse({
      assignmentPlan: {
        resolverVersion: 2,
        createdAt,
        assignments,
      },
      confirmationRequired: blockers.length > 0,
      blockers,
      sourceGaps,
      nodePreviews: [],
    });
  }

  const availableCapabilities = inventoryCapabilityIds(capabilityInventory);
  for (const capability of graph.capabilities ?? []) {
    if (capabilitySatisfied(capability, availableCapabilities)) continue;
    const optional = !requiredCapabilities.has(capability);
    const gap = {
      stepId: graph.start,
      kind: capabilityKind(capability),
      capability,
      optional,
      reason: optional
        ? "This optional capability is not configured in the current workspace."
        : "This required capability is not configured in the current workspace.",
    };
    if (optional) sourceGaps.push(gap);
    else blockers.push(gap);
  }

  const nodePreviews = agentSteps.map((step) => {
    const candidates = capabilityInventory.agents.map((agent) => {
      const saved = previousPlan?.assignments[step.id];
      return {
        agentId: agent.id,
        agentLabel: agent.label,
        assignment: assignmentForInventoryAgent(step.id, agent),
        recommended: saved?.agentId === agent.id,
        disabled: false,
      };
    });
    const hasSavedRecommendation = candidates.some((candidate) => candidate.recommended);
    if (!hasSavedRecommendation && candidates[0]) {
      candidates[0] = { ...candidates[0], recommended: true };
    }
    const recommended = candidates.find((candidate) => candidate.recommended);
    if (recommended) assignments[step.id] = recommended.assignment;

    const blocker =
      candidates.length === 0
        ? {
            stepId: step.id,
            kind: "model" as const,
            capability: "model.reasoning",
            optional: false,
            reason: "No agent is available to run this graph step.",
          }
        : undefined;
    if (blocker) blockers.push(blocker);

    return {
      stepId: step.id,
      stepLabel: step.label ?? titleFromId(step.id),
      kind: "agent" as const,
      ...(recommended
        ? {
            recommendedAgentId: recommended.agentId,
            recommendedAgentLabel: recommended.agentLabel,
          }
        : {}),
      candidates,
      ...(blocker ? { blocker } : {}),
    };
  });

  return PlaybookAssignmentPreviewResultSchema.parse({
    assignmentPlan: {
      resolverVersion: 2,
      createdAt,
      assignments,
    },
    confirmationRequired: blockers.length > 0,
    blockers,
    sourceGaps,
    nodePreviews,
  });
}
