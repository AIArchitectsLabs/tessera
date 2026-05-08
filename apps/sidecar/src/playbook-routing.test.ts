import { describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  WorkflowCapabilityInventorySchema,
  WorkflowDefinitionSchema,
} from "@tessera/contracts";
import {
  buildLocalPlaybookCapabilityInventory,
  parsePlaybookRunCreateRequest,
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

  test("parses raw playbook create bodies without losing capability metadata", () => {
    const inventory = WorkflowCapabilityInventorySchema.parse({
      agents: [],
      integrations: [],
    });
    const request = parsePlaybookRunCreateRequest(
      {
        input: { message: "weekly", target: "lead" },
        capabilityInventory: inventory,
      },
      "ops.weekly-update"
    );

    expect(request.workflowId).toBe("ops.weekly-update");
    expect(request.input).toEqual({ message: "weekly", target: "lead" });
    expect(request.capabilityInventory).toEqual(inventory);
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
