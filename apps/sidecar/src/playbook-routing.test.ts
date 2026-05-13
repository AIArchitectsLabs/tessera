import { describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  PlaybookAssignmentPreviewResultSchema,
  WorkflowCapabilityInventorySchema,
  WorkflowDefinitionSchema,
  WorkflowRunAssignmentPlanSchema,
} from "@tessera/contracts";
import { runWorkflow } from "@tessera/core";
import {
  buildLocalPlaybookCapabilityInventory,
  createPlaybookAssignmentPreview,
  parsePlaybookRunCreateRequest,
  resolveCheckpointedPlaybookExecutionContext,
  resolvePlaybookExecutionContext,
  sameAssignmentPlan,
} from "./playbook-routing.js";

describe("playbook routing helpers", () => {
  test("builds a local capability inventory from agent profiles", () => {
    const inventory = buildLocalPlaybookCapabilityInventory([
      AgentProfileSchema.parse({
        id: "agent-sales",
        name: "Sales Agent",
        model: {
          mode: "override",
          provider: {
            provider: "openai",
            model: "gpt-5.4",
            hasCredential: true,
          },
        },
        skills: ["meeting-prep"],
        toolPolicyPreset: "workspace_editor",
        instructions: "",
        soul: "",
        userContext: "",
        memoryDefaults: "",
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
      }),
    ]);

    expect(inventory.agents).toHaveLength(1);
    expect(inventory.agents[0]?.toolCapabilities).toEqual([
      "tool.workspace.read",
      "tool.workspace.write",
    ]);
  });

  test("creates an assignment preview that recommends the default agent", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.preview",
      version: 1,
      name: "Preview",
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          label: "Draft brief",
          kind: "agent",
          prompt: "Draft the brief",
          workspaceRootInput: "workspaceRoot",
          requires: {
            tools: [{ capability: "tool.workspace.read" }],
          },
        },
      ],
    });
    const capabilityInventory = buildLocalPlaybookCapabilityInventory([
      AgentProfileSchema.parse({
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        skills: [],
        toolPolicyPreset: "workspace_editor",
        instructions: "",
        soul: "",
        userContext: "",
        memoryDefaults: "",
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
      }),
    ]);

    const preview = PlaybookAssignmentPreviewResultSchema.parse(
      createPlaybookAssignmentPreview({
        definition,
        capabilityInventory,
      })
    );

    expect(preview.confirmationRequired).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.nodePreviews).toHaveLength(1);
    expect(preview.nodePreviews[0]).toMatchObject({
      stepId: "draft",
      stepLabel: "Draft brief",
      kind: "agent",
      recommendedAgentId: "default",
      recommendedAgentLabel: "Tessera",
      candidates: [
        {
          agentId: "default",
          agentLabel: "Tessera",
          recommended: true,
          disabled: false,
          assignment: {
            stepId: "draft",
            agentId: "default",
            agentLabel: "Tessera",
          },
        },
      ],
    });
  });

  test("includes candidates for tool steps when the resolved assignment has an agent identity", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.tool-preview",
      version: 1,
      name: "Tool Preview",
      start: "ping",
      inputs: {
        workspaceRoot: { type: "string", required: true },
      },
      steps: [
        {
          id: "ping",
          label: "Ping workspace",
          kind: "tool",
          toolId: "workspace.ping",
          args: {},
          requires: {
            tools: [{ capability: "tool.workspace.read" }],
          },
        },
      ],
    });
    const capabilityInventory = buildLocalPlaybookCapabilityInventory([
      AgentProfileSchema.parse({
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        skills: [],
        toolPolicyPreset: "workspace_editor",
        instructions: "",
        soul: "",
        userContext: "",
        memoryDefaults: "",
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
      }),
    ]);

    const preview = PlaybookAssignmentPreviewResultSchema.parse(
      createPlaybookAssignmentPreview({
        definition,
        capabilityInventory,
      })
    );

    expect(preview.nodePreviews).toHaveLength(1);
    expect(preview.nodePreviews[0]).toMatchObject({
      stepId: "ping",
      stepLabel: "Ping workspace",
      kind: "tool",
      recommendedAgentId: "default",
      recommendedAgentLabel: "Tessera",
      candidates: [
        {
          agentId: "default",
          agentLabel: "Tessera",
          recommended: true,
          disabled: false,
        },
      ],
    });
  });

  test("resolves different agents for different workflow nodes and records optional gaps", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.capability-routing",
      version: 1,
      name: "Capability Routing",
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft the brief",
          workspaceRootInput: "workspaceRoot",
          requires: {
            model: {
              acceptableProviders: ["openai"],
              acceptablePortableModelIds: ["gpt-5.4"],
              capabilities: ["model.reasoning"],
              minContextTokens: 32000,
              dataPolicy: "workspace-local-ok",
            },
            skills: [{ capability: "skill.meeting-prep" }],
            integrations: [{ capability: "integration.calendar.events.read", optional: true }],
          },
          onSuccess: "publish",
        },
        {
          id: "publish",
          kind: "agent",
          prompt: "Publish the brief",
          workspaceRootInput: "workspaceRoot",
          requires: {
            tools: [{ capability: "tool.workspace.write" }],
            skills: [{ capability: "skill.account-research", optional: true }],
          },
          onSuccess: "completed",
        },
      ],
    });

    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "sales-agent",
          label: "Sales Agent",
          fingerprint: "sales-agent:fingerprint",
          model: {
            provider: "openai",
            model: "gpt-5.4",
            hasCredential: true,
          },
          modelCapabilities: ["model.reasoning"],
          contextTokens: 64000,
          dataPolicies: ["workspace-local-ok"],
          skillCapabilities: ["skill.meeting-prep"],
          toolCapabilities: ["tool.workspace.read"],
        },
        {
          id: "ops-agent",
          label: "Ops Agent",
          fingerprint: "ops-agent:fingerprint",
          model: {
            provider: "local",
            model: "llama3.2",
            baseUrl: "http://127.0.0.1:11434/v1",
            hasCredential: false,
          },
          modelCapabilities: [],
          contextTokens: 32000,
          dataPolicies: ["workspace-local-ok"],
          skillCapabilities: ["skill.account-research"],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
        },
      ],
      integrations: [],
    });

    const resolved = resolvePlaybookExecutionContext({
      definition,
      capabilityInventory: inventory,
    });

    const draftAssignment = resolved.assignmentPlan.assignments.draft;
    const publishAssignment = resolved.assignmentPlan.assignments.publish;

    expect(draftAssignment).toBeDefined();
    expect(publishAssignment).toBeDefined();
    if (!draftAssignment || !publishAssignment) {
      throw new Error("Expected resolved assignments for draft and publish");
    }

    expect(draftAssignment.agentId).toBe("sales-agent");
    expect(publishAssignment.agentId).toBe("ops-agent");
    expect(resolved.sourceGaps).toEqual([
      {
        stepId: "draft",
        kind: "integration",
        capability: "integration.calendar.events.read",
        optional: true,
        reason: "Optional integration capability is not available in the current inventory",
      },
    ]);
  });

  test("rejects assignment plans that do not match the current inventory", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.plan-validation",
      version: 1,
      name: "Plan Validation",
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft the brief",
          workspaceRootInput: "workspaceRoot",
          requires: {
            skills: [{ capability: "skill.meeting-prep" }],
          },
        },
      ],
    });

    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "sales-agent",
          label: "Sales Agent",
          fingerprint: "sales-agent:fingerprint",
          model: {
            provider: "openai",
            model: "gpt-5.4",
            hasCredential: true,
          },
          modelCapabilities: [],
          contextTokens: 64000,
          dataPolicies: [],
          skillCapabilities: ["skill.meeting-prep"],
          toolCapabilities: [],
        },
      ],
      integrations: [],
    });

    const resolved = resolvePlaybookExecutionContext({
      definition,
      capabilityInventory: inventory,
    });
    const invalidPlan = {
      ...resolved.assignmentPlan,
      assignments: {
        ...resolved.assignmentPlan.assignments,
        draft: {
          ...resolved.assignmentPlan.assignments.draft,
          agentFingerprint: "stale-fingerprint",
        },
      },
    } as typeof resolved.assignmentPlan;

    expect(() =>
      resolvePlaybookExecutionContext({
        definition,
        capabilityInventory: inventory,
        assignmentPlan: invalidPlan,
      })
    ).toThrow("stale or does not match the current inventory");
  });

  test("accepts a freshly resolved plan whose agent has a credentialed model", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.plan-save-roundtrip",
      version: 1,
      name: "Plan Save Roundtrip",
      start: "draft",
      inputs: { workspaceRoot: { type: "string", required: true } },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft the brief",
          workspaceRootInput: "workspaceRoot",
        },
      ],
    });
    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "sales-agent",
          label: "Sales Agent",
          fingerprint: "sales-agent:fingerprint",
          model: { provider: "openai", model: "gpt-5.4", hasCredential: true },
          modelCapabilities: [],
          dataPolicies: [],
          skillCapabilities: [],
          toolCapabilities: [],
        },
      ],
      integrations: [],
    });

    const resolved = resolvePlaybookExecutionContext({
      definition,
      capabilityInventory: inventory,
    });

    expect(() =>
      resolvePlaybookExecutionContext({
        definition,
        capabilityInventory: inventory,
        assignmentPlan: resolved.assignmentPlan,
      })
    ).not.toThrow();
  });

  test("resolves no-requirement assignments that pass core workflow validation", async () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.no-requirements",
      version: 1,
      name: "No Requirements",
      start: "draftBrief",
      inputs: { workspaceRoot: { type: "string", required: true } },
      steps: [
        {
          id: "draftBrief",
          kind: "agent",
          prompt: "Draft the brief",
          workspaceRootInput: "workspaceRoot",
        },
      ],
    });
    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "default",
          label: "Tessera",
          fingerprint: "default:fingerprint",
          model: { provider: "openai", model: "gpt-5.4", hasCredential: true },
          modelCapabilities: [],
          dataPolicies: [],
          skillCapabilities: [],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
        },
      ],
      integrations: [],
    });

    const resolved = resolvePlaybookExecutionContext({
      definition,
      capabilityInventory: inventory,
    });

    expect(resolved.assignmentPlan.assignments.draftBrief?.toolCapabilities).toEqual([]);

    const result = await runWorkflow({
      definition,
      input: { workspaceRoot: "/tmp/workspace" },
      capabilityInventory: inventory,
      assignmentPlan: resolved.assignmentPlan,
      cli: {
        async runWorkspaceCli() {
          throw new Error("tool CLI should not be used by agent-only workflow");
        },
      },
      async agentRunner() {
        return { text: "ok", boundaryViolations: 0 };
      },
    });

    expect(result.status).toBe("completed");
  });

  test("assignment preview refreshes stale previous plans against the current inventory", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.preview-stale-plan",
      version: 1,
      name: "Preview Stale Plan",
      start: "draftRiskBrief",
      inputs: {
        workspaceRoot: { type: "string", required: true },
      },
      steps: [
        {
          id: "draftRiskBrief",
          kind: "agent",
          prompt: "Draft the renewal risk brief",
          workspaceRootInput: "workspaceRoot",
          requires: {
            tools: [{ capability: "tool.workspace.read" }],
          },
        },
      ],
    });
    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "default",
          label: "Tessera",
          fingerprint: "default:fresh",
          modelCapabilities: [],
          dataPolicies: [],
          skillCapabilities: [],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
        },
      ],
      integrations: [],
    });
    const previousPlan = WorkflowRunAssignmentPlanSchema.parse({
      resolverVersion: 1,
      createdAt: "2026-05-11T00:00:00.000Z",
      assignments: {
        draftRiskBrief: {
          stepId: "draftRiskBrief",
          agentId: "default",
          agentLabel: "Tessera",
          agentFingerprint: "default:stale",
          skillCapabilities: [],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
          integrationCapabilities: [],
        },
      },
    });

    const preview = createPlaybookAssignmentPreview({
      definition,
      capabilityInventory: inventory,
      previousPlan,
    });

    expect(preview.blockers).toEqual([]);
    expect(preview.assignmentPlan?.assignments.draftRiskBrief?.agentFingerprint).toBe(
      "default:fresh"
    );
  });

  test("resumes checkpointed assignment plans when inventory fingerprints drift", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.checkpoint-resume",
      version: 1,
      name: "Checkpoint Resume",
      start: "draft",
      inputs: {
        workspaceRoot: { type: "string", required: true },
      },
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft the brief",
          workspaceRootInput: "workspaceRoot",
          requires: {
            skills: [{ capability: "skill.meeting-prep" }],
          },
        },
      ],
    });

    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "sales-agent",
          label: "Sales Agent",
          fingerprint: "sales-agent:fingerprint",
          model: {
            provider: "openai",
            model: "gpt-5.4",
            hasCredential: true,
          },
          modelCapabilities: [],
          contextTokens: 64000,
          dataPolicies: [],
          skillCapabilities: ["skill.meeting-prep"],
          toolCapabilities: [],
        },
      ],
      integrations: [],
    });
    const resolved = resolvePlaybookExecutionContext({
      definition,
      capabilityInventory: inventory,
    });
    const driftedInventory = WorkflowCapabilityInventorySchema.parse({
      ...inventory,
      agents: [
        {
          ...inventory.agents[0],
          fingerprint: "sales-agent:new-fingerprint",
        },
      ],
    });

    const checkpointed = resolveCheckpointedPlaybookExecutionContext({
      definition,
      capabilityInventory: driftedInventory,
      existingAssignmentPlan: resolved.assignmentPlan,
      requestedAssignmentPlan: resolved.assignmentPlan,
    });

    expect(checkpointed.assignmentPlan.assignments.draft?.agentFingerprint).toBe(
      "sales-agent:fingerprint"
    );
  });

  test("parses raw playbook create bodies without losing capability metadata", () => {
    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [],
      integrations: [],
    });
    const request = parsePlaybookRunCreateRequest(
      {
        input: { message: "weekly", target: "lead" },
        capabilityInventory: inventory,
        agentProvider: {
          provider: "openai",
          model: "gpt-5.4",
          apiKeyEnv: "OPENAI_API_KEY",
        },
        credential: { apiKey: "test-key" },
      },
      "ops.weekly-update"
    );

    expect(request.workflowId).toBe("ops.weekly-update");
    expect(request.input).toEqual({ message: "weekly", target: "lead" });
    expect(request.capabilityInventory).toEqual(inventory);
    expect(request.agentProvider?.provider).toBe("openai");
    expect(request.credential).toEqual({ apiKey: "test-key" });
  });

  test("parses Codex OAuth playbook credentials without dropping runtime auth", () => {
    const request = parsePlaybookRunCreateRequest(
      {
        input: { message: "weekly", target: "lead" },
        credential: {
          authType: "codex-oauth",
          accessToken: "access-token",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          accountId: "account-123",
        },
      },
      "ops.weekly-update"
    );

    expect(request.credential).toEqual({
      authType: "codex-oauth",
      accessToken: "access-token",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      accountId: "account-123",
    });
  });

  test("normalizes assignment plan equality for checkpoint validation", () => {
    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [],
      integrations: [],
    });
    const definition = WorkflowDefinitionSchema.parse({
      id: "playbook.checksum",
      version: 1,
      name: "Checksum",
      start: "draft",
      inputs: {},
      steps: [
        {
          id: "draft",
          kind: "agent",
          prompt: "Draft",
          workspaceRootInput: "workspaceRoot",
        },
      ],
    });

    const resolved = resolvePlaybookExecutionContext({
      definition,
      capabilityInventory: inventory,
    });

    const sameAssignmentsDifferentTimestamp = {
      ...resolved.assignmentPlan,
      createdAt: "2026-05-08T01:00:00.000Z",
    } as typeof resolved.assignmentPlan;

    expect(sameAssignmentPlan(resolved.assignmentPlan, sameAssignmentsDifferentTimestamp)).toBe(
      true
    );
  });
});
