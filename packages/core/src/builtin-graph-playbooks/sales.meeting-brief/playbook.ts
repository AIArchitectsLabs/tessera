export default {
  schemaVersion: 1,
  id: "sales.meeting-brief",
  version: "1",
  name: "Sales Meeting Brief",
  description:
    "Creates a source-aware customer meeting brief and pauses before preparing a workspace artifact.",
  metadata: {
    category: "sales",
    businessUseCase: "Prepare for a customer or prospect meeting",
    requiredCapabilities: [],
    optionalCapabilities: ["web", "calendar", "mail", "drive", "contacts"],
    outputs: [
      {
        kind: "meetingBrief",
        label: "Meeting brief",
      },
      {
        kind: "sourceSummary",
        label: "Source summary",
      },
      {
        kind: "approvalRequest",
        label: "Workspace prep approval",
      },
    ],
    phases: ["Prepare", "Review"],
  },
  inputs: {
    company: {
      type: "string",
      required: true,
      label: "Company",
      description: "Account or prospect name.",
      placeholder: "Acme Corp",
      order: 1,
      group: "Meeting",
      ui: {
        control: "text",
      },
    },
    stakeholder: {
      type: "string",
      required: true,
      label: "Stakeholder",
      description: "Primary person you are meeting with.",
      placeholder: "Dana Lee, VP Sales",
      order: 2,
      group: "Meeting",
      ui: {
        control: "text",
      },
    },
    meetingDate: {
      type: "string",
      required: true,
      label: "Meeting date",
      order: 3,
      group: "Meeting",
      ui: {
        control: "date",
      },
    },
    objective: {
      type: "string",
      required: true,
      label: "Objective",
      description: "What should be true by the end of the meeting.",
      placeholder: "Agree on expansion next steps.",
      order: 4,
      group: "Meeting",
      ui: {
        control: "textarea",
      },
    },
    sources: {
      type: "string[]",
      required: true,
      label: "Research sources",
      description:
        "Sources to use when available. Unavailable selected sources are reported as gaps.",
      order: 5,
      group: "Research",
      default: ["web"],
      options: [
        {
          value: "web",
          label: "Web",
        },
        {
          value: "calendar",
          label: "Calendar",
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
    approvalTarget: {
      type: "string",
      required: true,
      label: "Approval target",
      description: "Workspace artifact or follow-up note destination.",
      placeholder: "meeting-prep",
      order: 6,
      group: "Approval",
      default: "meeting-prep",
      ui: {
        control: "text",
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
    meetingBrief: {
      schema: "schemas/meetingBrief.schema.json",
    },
    sourceSummary: {
      schema: "schemas/sourceSummary.schema.json",
    },
    approvalRequest: {
      schema: "schemas/approvalRequest.schema.json",
    },
  },
  capabilities: ["web", "calendar", "mail", "drive", "contacts"],
  limits: {},
  start: "draftBrief",
  nodes: [
    {
      id: "draftBrief",
      label: "Draft meeting brief",
      onSuccess: "approveBrief",
      kind: "agent",
      prompt: "prompts/draft-brief.md",
      inputs: {
        company: {
          input: "company",
        },
        stakeholder: {
          input: "stakeholder",
        },
        meetingDate: {
          input: "meetingDate",
        },
        objective: {
          input: "objective",
        },
        sources: {
          input: "sources",
        },
        approvalTarget: {
          input: "approvalTarget",
        },
        workspaceRoot: {
          input: "workspaceRoot",
        },
      },
      tools: [],
      output: {
        artifact: "meetingBrief",
        schema: "schemas/meetingBrief.schema.json",
      },
    },
    {
      id: "approveBrief",
      label: "Review workspace preparation",
      kind: "humanReview",
      artifact: "meetingBrief",
      actions: ["approve", "request_changes", "deny"],
      onApprove: "completed",
      onRequestChanges: "draftBrief",
    },
  ],
};
