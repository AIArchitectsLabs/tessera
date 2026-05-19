export default {
  schemaVersion: 1,
  id: "operations.weekly-status-digest",
  version: "1",
  name: "Weekly Status Digest",
  description:
    "Creates a concise weekly operating digest with progress, risks, decisions, and follow-ups, then pauses before writing it to the workspace.",
  metadata: {
    category: "operations",
    businessUseCase: "Summarize weekly team progress for stakeholders",
    requiredCapabilities: [],
    optionalCapabilities: ["calendar", "mail", "drive"],
    outputs: [
      {
        kind: "statusDigest",
        label: "Weekly status digest",
      },
    ],
    phases: ["Summarize", "Review"],
  },
  inputs: {
    team: {
      type: "string",
      required: true,
      label: "Team",
      description: "Team or workstream name.",
      placeholder: "Customer Operations",
      order: 1,
      group: "Digest",
      ui: {
        control: "text",
      },
    },
    weekEnding: {
      type: "string",
      required: true,
      label: "Week ending",
      order: 2,
      group: "Digest",
      ui: {
        control: "date",
      },
    },
    focusAreas: {
      type: "string[]",
      required: true,
      label: "Focus areas",
      description: "Topics to emphasize in the digest.",
      order: 3,
      group: "Digest",
      default: ["wins", "risks", "decisions"],
      options: [
        {
          value: "wins",
          label: "Wins",
        },
        {
          value: "risks",
          label: "Risks",
        },
        {
          value: "decisions",
          label: "Decisions",
        },
        {
          value: "follow-ups",
          label: "Follow-ups",
        },
      ],
      ui: {
        control: "multiselect",
      },
    },
    sources: {
      type: "string[]",
      required: true,
      label: "Workspace sources",
      description:
        "Sources to use internally when available while drafting the digest.",
      order: 4,
      group: "Evidence",
      default: ["calendar", "mail", "drive"],
      options: [
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
    statusDigest: {
      schema: "schemas/statusDigest.schema.json",
    },
  },
  capabilities: ["calendar", "mail", "drive"],
  limits: {},
  start: "draftStatusDigest",
  nodes: [
    {
      id: "draftStatusDigest",
      label: "Draft weekly status digest",
      onSuccess: "approveStatusDigest",
      kind: "agent",
      prompt: "prompts/draft-status-digest.md",
      inputs: {
        team: {
          input: "team",
        },
        weekEnding: {
          input: "weekEnding",
        },
        focusAreas: {
          input: "focusAreas",
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
        artifact: "statusDigest",
        schema: "schemas/statusDigest.schema.json",
      },
    },
    {
      id: "approveStatusDigest",
      label: "Review weekly status digest",
      kind: "humanReview",
      artifact: "statusDigest",
      actions: ["approve", "request_changes", "deny"],
      onApprove: "writeStatusDigest",
      onRequestChanges: "draftStatusDigest",
    },
    {
      id: "writeStatusDigest",
      label: "Write weekly status digest",
      kind: "artifactWrite",
      artifact: "statusDigest",
      path: "Weekly Status Digest - {{inputs.team}} - {{inputs.weekEnding}}.md",
      onSuccess: "completed",
    },
  ],
};
