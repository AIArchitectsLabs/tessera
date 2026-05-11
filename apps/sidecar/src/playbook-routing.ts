import { createHash } from "node:crypto";
import {
  type AgentProfile,
  type AgentProviderConfig,
  AgentProviderConfigSchema,
  type PlaybookAssignmentPreviewResult,
  PlaybookAssignmentPreviewResultSchema,
  type WorkflowCapabilityInventory,
  WorkflowCapabilityInventorySchema,
  type WorkflowDefinition,
  type WorkflowModelRequirement,
  type WorkflowNodeAssignment,
  WorkflowNodeAssignmentSchema,
  type WorkflowRunAssignmentPlan,
  WorkflowRunAssignmentPlanSchema,
  WorkflowRunResultSchema,
  type WorkflowSourceGap,
  WorkflowSourceGapSchema,
  type WorkflowStep,
  canonicalCapability,
} from "@tessera/contracts";

const TOOL_CAPABILITIES_BY_PRESET: Record<string, string[]> = {
  read_only: ["tool.workspace.read"],
  workspace_editor: ["tool.workspace.read", "tool.workspace.write"],
  elevated_with_approval: ["tool.workspace.read", "tool.workspace.write"],
};

export interface PlaybookExecutionContext {
  capabilityInventory: WorkflowCapabilityInventory;
  assignmentPlan: WorkflowRunAssignmentPlan;
  sourceGaps: WorkflowSourceGap[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCapability(value: string): string {
  return canonicalCapability(value)?.id ?? value;
}

function normalizedCapabilitySet(values: string[]): Set<string> {
  return new Set(values.map((value) => normalizeCapability(value)));
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.keys(nested)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (nested as Record<string, unknown>)[key];
        return acc;
      }, {});
  });
}

function modelClassMatches(model: string, modelClass: string): boolean {
  const normalizedModel = model.toLowerCase();
  const normalizedClass = modelClass.toLowerCase();
  return (
    normalizedModel === normalizedClass ||
    normalizedModel.startsWith(`${normalizedClass}.`) ||
    normalizedModel.startsWith(`${normalizedClass}-`) ||
    normalizedClass.startsWith(`${normalizedModel}.`) ||
    normalizedClass.startsWith(`${normalizedModel}-`)
  );
}

function modelMatchesRequirement(
  agent: WorkflowCapabilityInventory["agents"][number],
  requirement?: WorkflowModelRequirement
): { ok: boolean; missing: string[] } {
  if (!requirement) return { ok: true, missing: [] };

  const missing: string[] = [];
  const provider = agent.model?.provider;
  const modelId = agent.model?.model;
  const hasCredential = agent.model?.hasCredential ?? false;

  if (requirement.acceptableProviders.length > 0) {
    if (!provider || !requirement.acceptableProviders.includes(provider)) {
      missing.push(`provider:${requirement.acceptableProviders.join("|")}`);
    }
  }

  if (requirement.acceptablePortableModelIds.length > 0) {
    if (!modelId || !requirement.acceptablePortableModelIds.includes(modelId)) {
      missing.push(`model:${requirement.acceptablePortableModelIds.join("|")}`);
    }
  }

  if (requirement.acceptableModelClasses.length > 0) {
    if (
      !modelId ||
      !requirement.acceptableModelClasses.some((modelClass) =>
        modelClassMatches(modelId, modelClass)
      )
    ) {
      missing.push(`modelClass:${requirement.acceptableModelClasses.join("|")}`);
    }
  }

  const availableModelCapabilities = normalizedCapabilitySet(agent.modelCapabilities ?? []);
  for (const capability of requirement.capabilities) {
    const normalized = normalizeCapability(capability);
    if (!availableModelCapabilities.has(normalized)) {
      missing.push(normalized);
    }
  }

  if (typeof requirement.minContextTokens === "number") {
    if ((agent.contextTokens ?? 0) < requirement.minContextTokens) {
      missing.push(`contextTokens:${requirement.minContextTokens}`);
    }
  }

  if (requirement.dataPolicy) {
    const policies = new Set(agent.dataPolicies ?? []);
    if (!policies.has(requirement.dataPolicy)) {
      missing.push(`dataPolicy:${requirement.dataPolicy}`);
    }
  }

  if (provider && provider !== "local" && !hasCredential) {
    missing.push("credential");
  }

  return { ok: missing.length === 0, missing };
}

function integrationCapabilitiesForInventory(inventory: WorkflowCapabilityInventory): Set<string> {
  return normalizedCapabilitySet(
    inventory.integrations.flatMap((integration) =>
      integration.configured ? (integration.capabilities ?? []) : []
    )
  );
}

function stepOptionalGaps(
  step: WorkflowStep,
  inventory: WorkflowCapabilityInventory
): WorkflowSourceGap[] {
  const gaps: WorkflowSourceGap[] = [];
  const availableSkills = normalizedCapabilitySet(
    inventory.agents.flatMap((agent) => agent.skillCapabilities ?? [])
  );
  const availableTools = normalizedCapabilitySet(
    inventory.agents.flatMap((agent) => agent.toolCapabilities ?? [])
  );
  const availableIntegrations = integrationCapabilitiesForInventory(inventory);

  for (const requirement of step.requires?.skills ?? []) {
    const capability = normalizeCapability(requirement.capability);
    if (!requirement.optional) continue;
    if (!availableSkills.has(capability)) {
      gaps.push(
        WorkflowSourceGapSchema.parse({
          stepId: step.id,
          kind: "skill",
          capability,
          optional: true,
          reason: "Optional skill capability is not available in the current inventory",
        })
      );
    }
  }

  for (const requirement of step.requires?.tools ?? []) {
    const capability = normalizeCapability(requirement.capability);
    if (!requirement.optional) continue;
    if (!availableTools.has(capability)) {
      gaps.push(
        WorkflowSourceGapSchema.parse({
          stepId: step.id,
          kind: "tool",
          capability,
          optional: true,
          reason: "Optional tool capability is not available in the current inventory",
        })
      );
    }
  }

  for (const requirement of step.requires?.integrations ?? []) {
    const capability = normalizeCapability(requirement.capability);
    if (!requirement.optional) continue;
    if (!availableIntegrations.has(capability)) {
      gaps.push(
        WorkflowSourceGapSchema.parse({
          stepId: step.id,
          kind: "integration",
          capability,
          optional: true,
          reason: "Optional integration capability is not available in the current inventory",
        })
      );
    }
  }

  return gaps;
}

function candidateIntegrationCapabilities(
  inventory: WorkflowCapabilityInventory,
  step: WorkflowStep
): string[] {
  const availableIntegrations = integrationCapabilitiesForInventory(inventory);
  const matched: string[] = [];

  for (const requirement of step.requires?.integrations ?? []) {
    const capability = normalizeCapability(requirement.capability);
    if (availableIntegrations.has(capability)) {
      matched.push(capability);
    }
  }

  return matched;
}

function candidateScore(options: {
  agent: WorkflowCapabilityInventory["agents"][number];
  step: WorkflowStep;
}): number {
  const agent = options.agent;
  const requirement = options.step.requires;
  let score = 0;

  if (requirement?.model) {
    score += 100;
    if (requirement.model.acceptableProviders.length > 0) score += 25;
    if (requirement.model.acceptablePortableModelIds.length > 0) score += 25;
    if (requirement.model.acceptableModelClasses.length > 0) score += 25;
    score += requirement.model.capabilities.length * 5;
    if (typeof requirement.model.minContextTokens === "number") {
      score += Math.min(requirement.model.minContextTokens / 1024, 50);
    }
    if (requirement.model.dataPolicy) score += 10;
  }

  score += agent.skillCapabilities.length + agent.toolCapabilities.length;
  return score;
}

function chooseAgentCandidate(options: {
  inventory: WorkflowCapabilityInventory;
  step: WorkflowStep;
}): WorkflowCapabilityInventory["agents"][number] | undefined {
  const integrations = integrationCapabilitiesForInventory(options.inventory);

  const candidates = options.inventory.agents
    .filter((agent) => modelMatchesRequirement(agent, options.step.requires?.model).ok)
    .filter((agent) => {
      const availableSkills = normalizedCapabilitySet(agent.skillCapabilities ?? []);
      const availableTools = normalizedCapabilitySet(agent.toolCapabilities ?? []);

      for (const requirement of options.step.requires?.skills ?? []) {
        const capability = normalizeCapability(requirement.capability);
        if (!availableSkills.has(capability) && !requirement.optional) return false;
      }

      for (const requirement of options.step.requires?.tools ?? []) {
        const capability = normalizeCapability(requirement.capability);
        if (!availableTools.has(capability) && !requirement.optional) return false;
      }

      for (const requirement of options.step.requires?.integrations ?? []) {
        const capability = normalizeCapability(requirement.capability);
        if (!integrations.has(capability) && !requirement.optional) return false;
      }

      return true;
    })
    .sort((left, right) => {
      const scoreDelta =
        candidateScore({ agent: right, step: options.step }) -
        candidateScore({ agent: left, step: options.step });
      if (scoreDelta !== 0) return scoreDelta;
      if (left.label !== right.label) return left.label.localeCompare(right.label);
      return left.id.localeCompare(right.id);
    });

  return candidates[0];
}

function stepLabel(step: WorkflowStep): string {
  return step.label ?? step.id;
}

function agentAssignmentForStep(options: {
  agent: WorkflowCapabilityInventory["agents"][number];
  integrations: string[];
  step: WorkflowStep;
}): WorkflowNodeAssignment {
  return WorkflowNodeAssignmentSchema.parse({
    stepId: options.step.id,
    agentId: options.agent.id,
    agentLabel: options.agent.label,
    agentFingerprint: options.agent.fingerprint,
    ...(options.agent.model ? { provider: options.agent.model } : {}),
    ...(options.agent.model ? { providerFingerprint: stableHash(options.agent.model) } : {}),
    skillCapabilities: [...new Set(options.agent.skillCapabilities ?? [])].sort(),
    toolCapabilities: [...new Set(options.agent.toolCapabilities ?? [])].sort(),
    integrationCapabilities: [...new Set(options.integrations.map(normalizeCapability))].sort(),
  });
}

function normalizeAssignmentPlan(plan: WorkflowRunAssignmentPlan): WorkflowRunAssignmentPlan {
  return WorkflowRunAssignmentPlanSchema.parse({
    resolverVersion: plan.resolverVersion,
    createdAt: plan.createdAt,
    assignments: Object.fromEntries(
      Object.entries(plan.assignments)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([stepId, assignment]) => {
          const normalized = WorkflowNodeAssignmentSchema.parse(assignment);
          return [
            stepId,
            WorkflowNodeAssignmentSchema.parse({
              ...normalized,
              skillCapabilities: [...new Set(normalized.skillCapabilities ?? [])].sort(),
              toolCapabilities: [...new Set(normalized.toolCapabilities ?? [])].sort(),
              integrationCapabilities: [
                ...new Set(normalized.integrationCapabilities ?? []),
              ].sort(),
            }),
          ];
        })
    ),
  });
}

function previewNodeForStep(options: {
  assignment: WorkflowNodeAssignment | undefined;
  step: WorkflowStep;
}): PlaybookAssignmentPreviewResult["nodePreviews"][number] {
  const assignment = options.assignment;
  const recommendedAgentId = assignment?.agentId;
  const recommendedAgentLabel = assignment?.agentLabel;
  const hasAgentIdentity = Boolean(recommendedAgentId && recommendedAgentLabel);

  if (options.step.kind === "agent" && assignment && assignment.agentId && assignment.agentLabel) {
    return {
      stepId: options.step.id,
      stepLabel: stepLabel(options.step),
      kind: options.step.kind,
      recommendedAgentId: assignment.agentId,
      recommendedAgentLabel: assignment.agentLabel,
      candidates: [
        {
          agentId: assignment.agentId,
          agentLabel: assignment.agentLabel,
          assignment,
          recommended: true,
          disabled: false,
        },
      ],
    };
  }

  return {
    stepId: options.step.id,
    stepLabel: stepLabel(options.step),
    kind: options.step.kind,
    ...(hasAgentIdentity
      ? {
          recommendedAgentId,
          recommendedAgentLabel,
        }
      : {}),
    candidates: [],
  };
}

function validateAssignmentAgainstInventory(options: {
  assignment: WorkflowNodeAssignment;
  step: WorkflowStep;
  inventory: WorkflowCapabilityInventory;
}): void {
  const candidate = options.inventory.agents.find((agent) => {
    if (agent.id !== options.assignment.agentId) return false;
    if (
      options.assignment.agentFingerprint &&
      options.assignment.agentFingerprint !== agent.fingerprint
    ) {
      return false;
    }
    if (options.assignment.agentLabel && options.assignment.agentLabel !== agent.label) {
      return false;
    }
    if (options.assignment.provider) {
      if (!agent.model) return false;
      if (stableStringify(agent.model) !== stableStringify(options.assignment.provider))
        return false;
    }
    if (options.assignment.providerFingerprint && agent.model) {
      if (stableHash(agent.model) !== options.assignment.providerFingerprint) return false;
    }
    return true;
  });

  if (!candidate) {
    throw new Error(
      `Assignment for step ${options.step.id} is stale or does not match the current inventory`
    );
  }

  const expected = agentAssignmentForStep({
    agent: candidate,
    integrations: candidateIntegrationCapabilities(options.inventory, options.step),
    step: options.step,
  });

  if (
    stableStringify(expected.skillCapabilities) !==
    stableStringify(options.assignment.skillCapabilities ?? [])
  ) {
    throw new Error(`Assignment for step ${options.step.id} does not match the current inventory`);
  }
  if (
    stableStringify(expected.toolCapabilities) !==
    stableStringify(options.assignment.toolCapabilities ?? [])
  ) {
    throw new Error(`Assignment for step ${options.step.id} does not match the current inventory`);
  }
  if (
    stableStringify(expected.integrationCapabilities) !==
    stableStringify(options.assignment.integrationCapabilities ?? [])
  ) {
    throw new Error(`Assignment for step ${options.step.id} does not match the current inventory`);
  }

  const modelMatch = modelMatchesRequirement(candidate, options.step.requires?.model);
  if (!modelMatch.ok) {
    throw new Error(
      `Assignment for step ${options.step.id} does not satisfy the current requirements`
    );
  }
}

function createResolvedAssignmentPlan(options: {
  definition: WorkflowDefinition;
  inventory: WorkflowCapabilityInventory;
}): { assignmentPlan: WorkflowRunAssignmentPlan; sourceGaps: WorkflowSourceGap[] } {
  const assignments: Record<string, WorkflowNodeAssignment> = {};
  const sourceGaps: WorkflowSourceGap[] = [];

  for (const step of options.definition.steps) {
    const candidate = chooseAgentCandidate({ inventory: options.inventory, step });
    if (!candidate) {
      const requiredGaps = [
        ...(step.requires?.model?.capabilities ?? []).map((capability) =>
          WorkflowSourceGapSchema.parse({
            stepId: step.id,
            kind: "model",
            capability: normalizeCapability(capability),
            optional: false,
            reason: "Required model capability is not available in the current inventory",
          })
        ),
        ...(step.requires?.skills ?? [])
          .filter((requirement) => !requirement.optional)
          .map((requirement) =>
            WorkflowSourceGapSchema.parse({
              stepId: step.id,
              kind: "skill",
              capability: normalizeCapability(requirement.capability),
              optional: false,
              reason: "Required skill capability is not available in the current inventory",
            })
          ),
        ...(step.requires?.tools ?? [])
          .filter((requirement) => !requirement.optional)
          .map((requirement) =>
            WorkflowSourceGapSchema.parse({
              stepId: step.id,
              kind: "tool",
              capability: normalizeCapability(requirement.capability),
              optional: false,
              reason: "Required tool capability is not available in the current inventory",
            })
          ),
        ...(step.requires?.integrations ?? [])
          .filter((requirement) => !requirement.optional)
          .map((requirement) =>
            WorkflowSourceGapSchema.parse({
              stepId: step.id,
              kind: "integration",
              capability: normalizeCapability(requirement.capability),
              optional: false,
              reason: "Required integration capability is not available in the current inventory",
            })
          ),
      ];

      if (requiredGaps.length > 0 || step.requires?.model) {
        throw new Error(
          `Unable to resolve assignment for step ${step.id}: current inventory does not satisfy requirements`
        );
      }
      continue;
    }

    assignments[step.id] = agentAssignmentForStep({
      agent: candidate,
      integrations: candidateIntegrationCapabilities(options.inventory, step),
      step,
    });
    sourceGaps.push(...stepOptionalGaps(step, options.inventory));
  }

  return {
    assignmentPlan: WorkflowRunAssignmentPlanSchema.parse({
      resolverVersion: 1,
      createdAt: new Date().toISOString(),
      assignments,
    }),
    sourceGaps,
  };
}

function planKey(plan: WorkflowRunAssignmentPlan): string {
  const normalized = normalizeAssignmentPlan(plan);
  return stableStringify({
    resolverVersion: normalized.resolverVersion,
    assignments: normalized.assignments,
  });
}

export function buildLocalPlaybookCapabilityInventory(
  profiles: AgentProfile[]
): WorkflowCapabilityInventory {
  const agents = profiles.map((profile) => ({
    id: profile.id,
    label: profile.name,
    fingerprint: stableHash({
      id: profile.id,
      name: profile.name,
      description: profile.description ?? "",
      model: profile.model,
      skills: profile.skills ?? [],
      toolPolicyPreset: profile.toolPolicyPreset,
      instructions: profile.instructions,
      soul: profile.soul,
      userContext: profile.userContext,
      memoryDefaults: profile.memoryDefaults,
      updatedAt: profile.updatedAt,
    }),
    ...(profile.model.mode === "override" ? { model: profile.model.provider } : {}),
    modelCapabilities: [],
    contextTokens: undefined,
    dataPolicies: [],
    skillCapabilities: [...new Set((profile.skills ?? []).map(normalizeCapability))],
    toolCapabilities: [...(TOOL_CAPABILITIES_BY_PRESET[profile.toolPolicyPreset] ?? [])],
  }));

  return WorkflowCapabilityInventorySchema.parse({
    agents,
    integrations: [],
  });
}

export function resolvePlaybookExecutionContext(options: {
  capabilityInventory: WorkflowCapabilityInventory;
  definition: WorkflowDefinition;
  assignmentPlan?: WorkflowRunAssignmentPlan;
}): PlaybookExecutionContext {
  const capabilityInventory = WorkflowCapabilityInventorySchema.parse(options.capabilityInventory);
  const requestedPlan = options.assignmentPlan
    ? WorkflowRunAssignmentPlanSchema.parse(options.assignmentPlan)
    : undefined;

  if (requestedPlan) {
    const normalizedPlan = normalizeAssignmentPlan(requestedPlan);
    const stepById = new Map(options.definition.steps.map((step) => [step.id, step]));
    const expectedStepIds = new Set(stepById.keys());

    for (const stepId of Object.keys(normalizedPlan.assignments)) {
      if (!expectedStepIds.has(stepId)) {
        throw new Error(`Assignment plan includes unknown step: ${stepId}`);
      }
    }

    for (const step of options.definition.steps) {
      const assignment = normalizedPlan.assignments[step.id];
      if (!assignment) {
        throw new Error(`Assignment plan is missing a resolved assignment for step: ${step.id}`);
      }
      validateAssignmentAgainstInventory({ assignment, step, inventory: capabilityInventory });
    }

    const sourceGaps = options.definition.steps.flatMap((step) =>
      stepOptionalGaps(step, capabilityInventory)
    );
    return {
      capabilityInventory,
      assignmentPlan: normalizedPlan,
      sourceGaps,
    };
  }

  return {
    capabilityInventory,
    ...createResolvedAssignmentPlan({
      definition: options.definition,
      inventory: capabilityInventory,
    }),
  };
}

function validateAssignmentPlanShape(
  definition: WorkflowDefinition,
  plan: WorkflowRunAssignmentPlan
): WorkflowRunAssignmentPlan {
  const normalizedPlan = normalizeAssignmentPlan(plan);
  const expectedStepIds = new Set(definition.steps.map((step) => step.id));

  for (const stepId of Object.keys(normalizedPlan.assignments)) {
    if (!expectedStepIds.has(stepId)) {
      throw new Error(`Assignment plan includes unknown step: ${stepId}`);
    }
  }

  for (const step of definition.steps) {
    if (!normalizedPlan.assignments[step.id]) {
      throw new Error(`Assignment plan is missing a resolved assignment for step: ${step.id}`);
    }
  }

  return normalizedPlan;
}

export function resolveCheckpointedPlaybookExecutionContext(options: {
  capabilityInventory: WorkflowCapabilityInventory;
  definition: WorkflowDefinition;
  existingAssignmentPlan: WorkflowRunAssignmentPlan;
  requestedAssignmentPlan?: WorkflowRunAssignmentPlan;
}): PlaybookExecutionContext {
  if (
    options.requestedAssignmentPlan &&
    !sameAssignmentPlan(options.requestedAssignmentPlan, options.existingAssignmentPlan)
  ) {
    throw new Error("Assignment plan does not match the checkpointed plan");
  }

  const capabilityInventory = WorkflowCapabilityInventorySchema.parse(options.capabilityInventory);
  const assignmentPlan = validateAssignmentPlanShape(
    options.definition,
    options.existingAssignmentPlan
  );
  const sourceGaps = options.definition.steps.flatMap((step) =>
    stepOptionalGaps(step, capabilityInventory)
  );

  return {
    capabilityInventory,
    assignmentPlan,
    sourceGaps,
  };
}

export function createPlaybookAssignmentPreview(options: {
  capabilityInventory: WorkflowCapabilityInventory;
  definition: WorkflowDefinition;
  previousPlan?: WorkflowRunAssignmentPlan;
}): PlaybookAssignmentPreviewResult {
  try {
    const resolved = resolvePlaybookExecutionContext({
      definition: options.definition,
      capabilityInventory: options.capabilityInventory,
      ...(options.previousPlan ? { assignmentPlan: options.previousPlan } : {}),
    });
    return PlaybookAssignmentPreviewResultSchema.parse({
      assignmentPlan: resolved.assignmentPlan,
      confirmationRequired: true,
      blockers: [],
      sourceGaps: resolved.sourceGaps,
      nodePreviews: options.definition.steps.map((step) =>
        previewNodeForStep({
          step,
          assignment: resolved.assignmentPlan.assignments[step.id],
        })
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return PlaybookAssignmentPreviewResultSchema.parse({
      confirmationRequired: true,
      blockers: [
        WorkflowSourceGapSchema.parse({
          stepId: options.definition.start,
          kind: "model",
          capability: "assignment-preview",
          optional: false,
          reason: message,
        }),
      ],
      sourceGaps: [],
      nodePreviews: [],
    });
  }
}

export function mergePlaybookRunMetadata(run: unknown, context: PlaybookExecutionContext) {
  return WorkflowRunResultSchema.parse({
    ...(run && typeof run === "object" ? run : {}),
    assignmentPlan:
      (run && typeof run === "object" && "assignmentPlan" in run
        ? (run as { assignmentPlan?: WorkflowRunAssignmentPlan }).assignmentPlan
        : undefined) ?? context.assignmentPlan,
    sourceGaps:
      (run && typeof run === "object" && "sourceGaps" in run
        ? (run as { sourceGaps?: WorkflowSourceGap[] }).sourceGaps
        : undefined) ?? context.sourceGaps,
  });
}

export function parsePlaybookRunCreateRequest(
  body: unknown,
  playbookId: string
): {
  agentProvider?: AgentProviderConfig;
  capabilityInventory?: WorkflowCapabilityInventory;
  credential?: { apiKey: string };
  assignmentPlan?: WorkflowRunAssignmentPlan;
  input: Record<string, unknown>;
  workflowId: string;
} {
  const payload = isRecord(body) ? body : {};
  const input = isRecord(payload.input)
    ? (payload.input as Record<string, unknown>)
    : Object.fromEntries(
        Object.entries(payload).filter(
          ([key]) =>
            key !== "input" &&
            key !== "capabilityInventory" &&
            key !== "assignmentPlan" &&
            key !== "agentProvider" &&
            key !== "credential" &&
            key !== "workflowId"
        )
      );

  return {
    workflowId: playbookId,
    input,
    ...(payload.agentProvider !== undefined
      ? { agentProvider: AgentProviderConfigSchema.parse(payload.agentProvider) }
      : {}),
    ...(isRecord(payload.credential) && typeof payload.credential.apiKey === "string"
      ? { credential: { apiKey: payload.credential.apiKey } }
      : {}),
    ...(payload.capabilityInventory !== undefined
      ? {
          capabilityInventory: WorkflowCapabilityInventorySchema.parse(payload.capabilityInventory),
        }
      : {}),
    ...(payload.assignmentPlan !== undefined
      ? { assignmentPlan: WorkflowRunAssignmentPlanSchema.parse(payload.assignmentPlan) }
      : {}),
  };
}

export function sameAssignmentPlan(
  left: WorkflowRunAssignmentPlan,
  right: WorkflowRunAssignmentPlan
): boolean {
  return planKey(left) === planKey(right);
}
