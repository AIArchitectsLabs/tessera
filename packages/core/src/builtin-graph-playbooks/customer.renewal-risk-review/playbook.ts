export default {
  schemaVersion: 1,
  id: "customer.renewal-risk-review",
  version: "1",
  name: "Renewal Risk Review",
  description:
    "Creates a renewal risk brief with expansion signals, blockers, stakeholder gaps, and recommended actions, then pauses before writing it to the workspace.",
  metadata: {
    category: "customer-success",
    businessUseCase: "Prepare a renewal risk brief for an account",
    requiredCapabilities: [],
    optionalCapabilities: ["web", "mail", "drive", "contacts"],
    outputs: [
      {
        kind: "businessBrief",
        label: "Renewal risk brief",
      },
    ],
    writingStyle: {
      enabled: true,
      defaultCopyType: "business.brief.medium",
      supportedCopyTypes: ["business.brief.medium", "blog.article.long"],
    },
    phases: ["Analyze", "Review"],
  },
  inputs: {
    account: {
      type: "string",
      required: true,
      label: "Account",
      description: "Customer account name.",
      placeholder: "Acme Corp",
      order: 1,
      group: "Renewal",
      ui: {
        control: "text",
      },
    },
    owner: {
      type: "string",
      required: true,
      label: "Owner",
      description: "Internal account owner.",
      placeholder: "Dana Lee",
      order: 2,
      group: "Renewal",
      ui: {
        control: "text",
      },
    },
    renewalDate: {
      type: "string",
      required: true,
      label: "Renewal date",
      order: 3,
      group: "Renewal",
      ui: {
        control: "date",
      },
    },
    objective: {
      type: "string",
      required: true,
      label: "Objective",
      description: "Decision or action this review should support.",
      placeholder: "Identify save plan priorities before exec review.",
      order: 4,
      group: "Renewal",
      ui: {
        control: "textarea",
      },
    },
    sources: {
      type: "string[]",
      required: true,
      label: "Evidence sources",
      description: "Sources to use internally when available while drafting the brief.",
      order: 5,
      group: "Evidence",
      default: ["web", "drive"],
      options: [
        {
          value: "web",
          label: "Web",
        },
        {
          value: "mail",
          label: "Mail",
        },
        {
          value: "drive",
          label: "Drive",
        },
        {
          value: "contacts",
          label: "Contacts",
        },
      ],
      ui: {
        control: "multiselect",
      },
    },
    workspaceRoot: {
      type: "string",
      required: true,
      label: "Workspace",
      group: "System",
      ui: {
        control: "text",
      },
    },
  },
  artifacts: {
    businessBrief: {
      schema: "schemas/businessBrief.schema.json",
    },
  },
  capabilities: ["web", "mail", "drive", "contacts", "tool.workspace.write"],
  limits: {},
  start: "draftRiskBrief",
  nodes: [
    {
      id: "draftRiskBrief",
      label: "Draft renewal risk brief",
      onSuccess: "approveRiskBrief",
      kind: "agent",
      prompt: "prompts/draft-risk-review.md",
      inputs: {
        account: {
          input: "account",
        },
        owner: {
          input: "owner",
        },
        renewalDate: {
          input: "renewalDate",
        },
        objective: {
          input: "objective",
        },
        sources: {
          input: "sources",
        },
        workspaceRoot: {
          input: "workspaceRoot",
        },
      },
      tools: [],
      output: {
        artifact: "businessBrief",
        schema: "schemas/businessBrief.schema.json",
        style: { consume: true, purpose: "draft" },
      },
    },
    {
      id: "approveRiskBrief",
      label: "Review renewal risk brief",
      kind: "humanReview",
      artifact: "businessBrief",
      actions: ["approve", "request_changes", "deny"],
      onApprove: "writeRiskBrief",
      onRequestChanges: "draftRiskBrief",
    },
    {
      id: "writeRiskBrief",
      label: "Write renewal risk brief",
      kind: "effect",
      effectId: "workspace.write",
      capability: "tool.workspace.write",
      adapterId: "workspace",
      sideEffect: "write",
      approval: "required",
      idempotency: "required",
      idempotencyKey: "workspace.write:customer.renewal-risk-review:{{inputs.account}}",
      input: {
        sourceArtifact: "businessBrief",
        value: { artifact: "businessBrief" },
        path: "Renewal Risk Review - {{inputs.account}}.md",
        format: "markdown",
      },
      preview: {
        schemaVersion: 1,
        title: "Write renewal risk brief",
        summary: "Write the approved renewal risk brief to the selected workspace.",
      },
      onSuccess: "completed",
    },
  ],
};
