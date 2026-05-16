export default {
  schemaVersion: 1,
  id: "customer.renewal-risk-review",
  version: "1",
  name: "Renewal Risk Review",
  description:
    "Creates a renewal risk brief with expansion signals, blockers, stakeholder gaps, and recommended actions.",
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
      {
        kind: "sourceSummary",
        label: "Source summary",
      },
    ],
    phases: ["Analyze"],
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
      description:
        "Sources to use when available. Unavailable selected sources are reported as gaps.",
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
    sourceSummary: {
      schema: "schemas/sourceSummary.schema.json",
    },
  },
  capabilities: ["web", "mail", "drive", "contacts"],
  limits: {},
  start: "draftRiskBrief",
  nodes: [
    {
      id: "draftRiskBrief",
      label: "Draft renewal risk brief",
      onSuccess: "completed",
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
      },
    },
  ],
};
