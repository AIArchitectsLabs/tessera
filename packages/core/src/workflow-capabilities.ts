import { createHash } from "node:crypto";
import {
  type AgentProfile,
  type AgentProviderConfig,
  type WorkflowAgentStep,
  WorkflowCapabilitySchema,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  WorkflowInputDefinitionSchema,
  WorkflowOutputDeclarationSchema,
  type WorkflowRunEvent,
  type WorkflowRunStepRecord,
  type WorkflowStep,
  type WorkflowToolStep,
} from "@tessera/contracts";
import { z } from "zod";

const AgentProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("openai"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
  }),
  z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("ANTHROPIC_API_KEY"),
  }),
  z.object({
    provider: z.literal("openrouter"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENROUTER_API_KEY"),
  }),
  z.object({
    provider: z.literal("local"),
    model: z.string().min(1),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1).optional(),
  }),
]);

export const WorkflowCapabilityRequirementSchema = z.object({
  capability: z.string().min(1),
  optional: z.boolean().default(false),
});

export type WorkflowCapabilityRequirement = z.infer<typeof WorkflowCapabilityRequirementSchema>;

const WorkflowModelProviderSchema = z.enum(["openai", "anthropic", "openrouter", "local"]);

export const WorkflowModelRequirementSchema = z.object({
  acceptableProviders: z.array(WorkflowModelProviderSchema).default([]),
  acceptableModels: z.array(z.string().min(1)).default([]),
  acceptableModelClasses: z.array(z.string().min(1)).default([]),
  acceptablePortableModelIds: z.array(z.string().min(1)).default([]),
  acceptableCapabilities: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  minContextTokens: z.number().int().nonnegative().optional(),
  dataPolicy: z.enum(["cloud-ok", "workspace-local-ok", "local-only"]).optional(),
});

export type WorkflowModelRequirement = z.infer<typeof WorkflowModelRequirementSchema>;
export type WorkflowDataPolicy = NonNullable<WorkflowModelRequirement["dataPolicy"]>;

export const WorkflowNodeRequirementsSchema = z.object({
  model: WorkflowModelRequirementSchema.optional(),
  skills: z.array(WorkflowCapabilityRequirementSchema).default([]),
  tools: z.array(WorkflowCapabilityRequirementSchema).default([]),
  integrations: z.array(WorkflowCapabilityRequirementSchema).default([]),
});

export type WorkflowNodeRequirements = z.infer<typeof WorkflowNodeRequirementsSchema>;

export const WorkflowCapabilityInventoryAgentSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  fingerprint: z.string().min(1),
  model: z
    .object({
      provider: WorkflowModelProviderSchema,
      model: z.string().min(1),
      hasCredential: z.boolean().optional(),
    })
    .optional(),
  modelCapabilities: z.array(z.string().min(1)).default([]),
  contextTokens: z.number().int().nonnegative().optional(),
  dataPolicies: z.array(z.enum(["cloud-ok", "workspace-local-ok", "local-only"])).default([]),
  skillCapabilities: z.array(z.string().min(1)).default([]),
  toolCapabilities: z.array(z.string().min(1)).default([]),
});

export type WorkflowCapabilityInventoryAgent = z.infer<
  typeof WorkflowCapabilityInventoryAgentSchema
>;

export const WorkflowCapabilityInventoryIntegrationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  fingerprint: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
  dataPolicies: z.array(z.enum(["cloud-ok", "workspace-local-ok", "local-only"])).default([]),
  configured: z.boolean(),
});

export type WorkflowCapabilityInventoryIntegration = z.infer<
  typeof WorkflowCapabilityInventoryIntegrationSchema
>;

export const WorkflowCapabilityInventorySchema = z.object({
  fingerprint: z.string().min(1).optional(),
  agents: z.array(WorkflowCapabilityInventoryAgentSchema).default([]),
  models: z.array(z.unknown()).default([]),
  skills: z.array(z.unknown()).default([]),
  tools: z.array(z.unknown()).default([]),
  integrations: z.array(WorkflowCapabilityInventoryIntegrationSchema).default([]),
});

export type WorkflowCapabilityInventory = z.infer<typeof WorkflowCapabilityInventorySchema>;

export const WorkflowRunAssignmentSchema = z.object({
  stepId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentLabel: z.string().min(1).optional(),
  agentFingerprint: z.string().min(1).optional(),
  provider: AgentProviderConfigSchema.optional(),
  providerFingerprint: z.string().min(1).optional(),
  credentialRef: z.string().min(1).optional(),
  skillCapabilities: z.array(z.string().min(1)).default([]),
  toolCapabilities: z.array(z.string().min(1)).default([]),
  integrationCapabilities: z.array(z.string().min(1)).default([]),
});

export type WorkflowRunAssignment = z.infer<typeof WorkflowRunAssignmentSchema>;
export type WorkflowNodeAssignment = WorkflowRunAssignment;

export const WorkflowSourceGapSchema = z.object({
  stepId: z.string().min(1),
  kind: z.enum(["skill", "tool", "integration", "model"]),
  capability: z.string().min(1),
  optional: z.boolean().default(false),
  reason: z.string().optional(),
});

export type WorkflowSourceGap = z.infer<typeof WorkflowSourceGapSchema>;

export const WorkflowRunAssignmentPlanSchema = z.object({
  resolverVersion: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
  assignments: z.object({}).catchall(WorkflowRunAssignmentSchema),
});

export type WorkflowRunAssignmentPlan = z.infer<typeof WorkflowRunAssignmentPlanSchema>;

export type WorkflowExecutionStep = WorkflowToolStep & {
  assignment?: WorkflowRunAssignment;
} & {
  kind: "tool";
};

export type WorkflowExecutionAgentStep = WorkflowAgentStep & {
  assignment?: WorkflowRunAssignment;
} & {
  kind: "agent";
};

export type WorkflowExecutionStepRecord = WorkflowRunStepRecord & {
  assignment?: WorkflowRunAssignment | undefined;
};

export { WorkflowDefinitionSchema };
export type { WorkflowDefinition, WorkflowStep };

export interface WorkflowExecutionRun {
  assignmentPlan?: WorkflowRunAssignmentPlan | undefined;
  events?: WorkflowRunEvent[] | undefined;
  steps?: WorkflowExecutionStepRecord[] | undefined;
}

export function workflowCapabilityRef(value: WorkflowCapabilityRequirement | string): string {
  return typeof value === "string" ? value : value.capability;
}

export function workflowCapabilityRefs(
  values: Array<WorkflowCapabilityRequirement | string> = []
): string[] {
  return values.map(workflowCapabilityRef);
}

function agentCapabilities(profile: AgentProfile): {
  dataPolicies: string[];
  modelCapabilities: string[];
  skillCapabilities: string[];
  toolCapabilities: string[];
  contextTokens: number;
  provider: AgentProviderConfig;
} {
  const provider: AgentProviderConfig =
    profile.model.mode === "override"
      ? profile.model.provider
      : {
          provider: "openai",
          model: "gpt-5.4",
          apiKeyEnv: "OPENAI_API_KEY",
        };
  const skills = profile.skills ?? [];
  const toolCapabilities =
    profile.toolPolicyPreset === "read_only"
      ? ["tool.workspace.read"]
      : profile.toolPolicyPreset === "elevated_with_approval"
        ? ["tool.workspace.read", "tool.workspace.write", "tool.workspace.shell"]
        : ["tool.workspace.read", "tool.workspace.write"];
  const modelCapabilities = [
    "model.reasoning",
    "model.summarization",
    "model.drafting",
    "model.analysis",
  ];

  return {
    dataPolicies:
      provider.provider === "local"
        ? ["workspace-local-ok", "local-only"]
        : ["cloud-ok", "workspace-local-ok"],
    modelCapabilities,
    skillCapabilities: skills.map((skill) => `skill.${skill}`),
    toolCapabilities,
    contextTokens: provider.provider === "anthropic" ? 200_000 : 128_000,
    provider,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createWorkflowCapabilityInventory(
  profiles: AgentProfile[]
): WorkflowCapabilityInventory {
  return WorkflowCapabilityInventorySchema.parse({
    agents: profiles.map((profile) => {
      const caps = agentCapabilities(profile);
      return {
        id: profile.id,
        label: profile.name,
        fingerprint: fingerprint({
          id: profile.id,
          updatedAt: profile.updatedAt,
          model: profile.model,
          skills: profile.skills,
          toolPolicyPreset: profile.toolPolicyPreset,
        }),
        model: {
          provider: caps.provider.provider,
          model: caps.provider.model,
        },
        modelCapabilities: caps.modelCapabilities,
        contextTokens: caps.contextTokens,
        dataPolicies: caps.dataPolicies,
        skillCapabilities: caps.skillCapabilities,
        toolCapabilities: caps.toolCapabilities,
      };
    }),
    integrations: [],
  });
}

function requirementsForStep(step: WorkflowStep): WorkflowNodeRequirements {
  const requires = (step as WorkflowStep & { requires?: WorkflowNodeRequirements }).requires;
  return WorkflowNodeRequirementsSchema.parse(
    requires ?? {
      skills: [],
      tools: [],
      integrations: [],
    }
  );
}

function matchesRequirements(
  inventory: WorkflowCapabilityInventory,
  agent: WorkflowCapabilityInventory["agents"][number],
  requirements: WorkflowNodeRequirements
): boolean {
  const model = requirements.model;
  if (model) {
    const provider = agent.model?.provider;
    const modelId = agent.model?.model;
    const requiredCapabilities = [...model.acceptableCapabilities, ...model.capabilities];
    if (
      model.acceptableProviders.length > 0 &&
      (!provider || !model.acceptableProviders.includes(provider))
    ) {
      return false;
    }
    if (
      model.acceptableModels.length > 0 &&
      (!modelId || !model.acceptableModels.includes(modelId))
    ) {
      return false;
    }
    if (
      requiredCapabilities.length > 0 &&
      !requiredCapabilities.every((capability) => agent.modelCapabilities.includes(capability))
    ) {
      return false;
    }
    if (model.minContextTokens && (agent.contextTokens ?? 0) < model.minContextTokens) {
      return false;
    }
    if (model.dataPolicy && !agent.dataPolicies.includes(model.dataPolicy)) {
      return false;
    }
  }

  const skillCapabilities = workflowCapabilityRefs(requirements.skills);
  if (!skillCapabilities.every((capability) => agent.skillCapabilities.includes(capability))) {
    return false;
  }

  const toolCapabilities = workflowCapabilityRefs(requirements.tools);
  if (!toolCapabilities.every((capability) => agent.toolCapabilities.includes(capability))) {
    return false;
  }

  const integrationCapabilities = workflowCapabilityRefs(requirements.integrations);
  if (
    integrationCapabilities.length > 0 &&
    !integrationCapabilities.every((capability) =>
      inventory.integrations.some(
        (integration) => integration.configured && integration.capabilities.includes(capability)
      )
    )
  ) {
    return false;
  }

  return true;
}

function candidateScore(
  inventory: WorkflowCapabilityInventory,
  agent: WorkflowCapabilityInventory["agents"][number],
  requirements: WorkflowNodeRequirements
): number {
  let score = 0;
  const model = requirements.model;
  if (model) {
    if (agent.model?.provider && model.acceptableProviders.includes(agent.model.provider))
      score += 10;
    if (agent.model?.model && model.acceptableModels.includes(agent.model.model)) score += 20;
    score += [...model.acceptableCapabilities, ...model.capabilities].filter((capability) =>
      agent.modelCapabilities.includes(capability)
    ).length;
    if (model.minContextTokens) score += Math.min((agent.contextTokens ?? 0) / 10_000, 20);
    if (model.dataPolicy && agent.dataPolicies.includes(model.dataPolicy)) score += 5;
  }

  score += workflowCapabilityRefs(requirements.skills).filter((capability) =>
    agent.skillCapabilities.includes(capability)
  ).length;
  score += workflowCapabilityRefs(requirements.tools).filter((capability) =>
    agent.toolCapabilities.includes(capability)
  ).length;
  score += workflowCapabilityRefs(requirements.integrations).filter((capability) =>
    inventory.integrations.some(
      (integration) => integration.configured && integration.capabilities.includes(capability)
    )
  ).length;
  return score;
}

function selectAgent(
  inventory: WorkflowCapabilityInventory,
  requirements: WorkflowNodeRequirements
): WorkflowCapabilityInventory["agents"][number] {
  const candidates = inventory.agents.filter((agent) =>
    matchesRequirements(inventory, agent, requirements)
  );
  if (candidates.length === 0) {
    throw new Error(
      "Assignment plan validation failed: no available agent matched the workflow requirements"
    );
  }
  const [selected] = candidates.slice().sort((left, right) => {
    const scoreDiff =
      candidateScore(inventory, right, requirements) -
      candidateScore(inventory, left, requirements);
    if (scoreDiff !== 0) return scoreDiff;
    if (left.label !== right.label) return left.label.localeCompare(right.label);
    return left.id.localeCompare(right.id);
  });
  if (!selected) {
    throw new Error(
      "Assignment plan validation failed: no available agent matched the workflow requirements"
    );
  }
  return selected;
}

function providerFingerprint(provider: AgentProviderConfig): string {
  return `provider:${provider.provider}:${provider.model}`;
}

function assignmentForAgent(
  stepId: string,
  agent: WorkflowCapabilityInventory["agents"][number],
  requirements: WorkflowNodeRequirements
): WorkflowRunAssignment {
  if (!agent.model) {
    throw new Error(
      `Assignment plan validation failed: agent ${agent.id} is missing model metadata`
    );
  }
  return {
    stepId,
    agentId: agent.id,
    agentLabel: agent.label,
    agentFingerprint: agent.fingerprint,
    provider: {
      provider: agent.model.provider,
      model: agent.model.model,
      ...(agent.model.provider === "local" ? { baseUrl: "http://127.0.0.1:11434/v1" } : {}),
    } as AgentProviderConfig,
    providerFingerprint: providerFingerprint({
      provider: agent.model.provider,
      model: agent.model.model,
      ...(agent.model.provider === "local" ? { baseUrl: "http://127.0.0.1:11434/v1" } : {}),
    } as AgentProviderConfig),
    credentialRef:
      agent.model.provider === "local"
        ? undefined
        : `${agent.model.provider.toUpperCase()}_API_KEY`,
    skillCapabilities: workflowCapabilityRefs(requirements.skills),
    toolCapabilities: workflowCapabilityRefs(requirements.tools),
    integrationCapabilities: workflowCapabilityRefs(requirements.integrations),
  };
}

export function resolveWorkflowAssignmentPlan(
  definition: WorkflowDefinition,
  inventory: WorkflowCapabilityInventory
): WorkflowRunAssignmentPlan {
  const createdAt = new Date().toISOString();
  const assignments: Record<string, WorkflowRunAssignment> = {};

  for (const step of definition.steps) {
    const requirements = requirementsForStep(step);
    const selected = selectAgent(inventory, requirements);
    assignments[step.id] = assignmentForAgent(step.id, selected, requirements);
  }

  return WorkflowRunAssignmentPlanSchema.parse({
    resolverVersion: 1,
    createdAt,
    assignments,
  });
}

export function validateWorkflowAssignmentPlan(
  definition: WorkflowDefinition,
  inventory: WorkflowCapabilityInventory,
  plan: WorkflowRunAssignmentPlan
): WorkflowRunAssignmentPlan {
  const parsed = WorkflowRunAssignmentPlanSchema.parse(plan);
  const expected = resolveWorkflowAssignmentPlan(definition, inventory);

  for (const [stepId, expectedAssignment] of Object.entries(expected.assignments)) {
    const actualAssignment = parsed.assignments[stepId];
    if (!actualAssignment) {
      throw new Error(`Assignment plan validation failed: missing assignment for ${stepId}`);
    }
    if (
      actualAssignment.agentId !== expectedAssignment.agentId ||
      actualAssignment.agentLabel !== expectedAssignment.agentLabel ||
      actualAssignment.agentFingerprint !== expectedAssignment.agentFingerprint ||
      actualAssignment.provider?.provider !== expectedAssignment.provider?.provider ||
      actualAssignment.provider?.model !== expectedAssignment.provider?.model ||
      actualAssignment.providerFingerprint !== expectedAssignment.providerFingerprint ||
      actualAssignment.credentialRef !== expectedAssignment.credentialRef ||
      JSON.stringify(actualAssignment.skillCapabilities) !==
        JSON.stringify(expectedAssignment.skillCapabilities) ||
      JSON.stringify(actualAssignment.toolCapabilities) !==
        JSON.stringify(expectedAssignment.toolCapabilities) ||
      JSON.stringify(actualAssignment.integrationCapabilities) !==
        JSON.stringify(expectedAssignment.integrationCapabilities)
    ) {
      throw new Error(`Assignment plan validation failed: ${stepId}`);
    }
  }

  return parsed;
}

export function extractWorkflowAssignmentPlan(
  run: WorkflowExecutionRun
): WorkflowRunAssignmentPlan | undefined {
  if (run.assignmentPlan) {
    return WorkflowRunAssignmentPlanSchema.parse(run.assignmentPlan);
  }

  const events = run.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const metadata = event?.metadata;
    if (metadata && typeof metadata === "object" && "assignmentPlan" in metadata) {
      return WorkflowRunAssignmentPlanSchema.parse(
        (metadata as { assignmentPlan: unknown }).assignmentPlan
      );
    }
  }

  return undefined;
}

export function withWorkflowAssignmentPlan<T extends WorkflowExecutionRun>(
  run: T,
  assignmentPlan: WorkflowRunAssignmentPlan
): T & { assignmentPlan: WorkflowRunAssignmentPlan } {
  return {
    ...run,
    assignmentPlan,
  };
}
