export default {
  schemaVersion: 1,
  id: "sales.meeting-brief",
  version: "1",
  name: "Sales Meeting Brief",
  description:
    "Creates a concise customer meeting brief and pauses before writing it to the workspace.",
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
    ],
    writingStyle: {
      enabled: true,
      defaultCopyType: "business.brief.medium",
      supportedCopyTypes: ["business.brief.medium", "blog.article.long"],
    },
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
      description: "Sources to use internally when available while drafting the brief.",
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
        workspaceRoot: {
          input: "workspaceRoot",
        },
      },
      tools: [],
      output: {
        artifact: "meetingBrief",
        schema: "schemas/meetingBrief.schema.json",
        style: { consume: true, purpose: "draft" },
      },
    },
    {
      id: "approveBrief",
      label: "Review meeting brief",
      kind: "humanReview",
      artifact: "meetingBrief",
      actions: ["approve", "request_changes", "deny"],
      onApprove: "writeBrief",
      onRequestChanges: "draftBrief",
    },
    {
      id: "writeBrief",
      label: "Write meeting brief",
      kind: "artifactWrite",
      artifact: "meetingBrief",
      path: "Sales Meeting Brief - {{inputs.company}}.md",
      onSuccess: "completed",
    },
  ],
};
