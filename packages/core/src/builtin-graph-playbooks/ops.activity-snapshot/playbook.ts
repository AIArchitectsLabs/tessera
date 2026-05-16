export default {
  schemaVersion: 1,
  id: "ops.activity-snapshot",
  version: "1",
  name: "Activity Snapshot",
  description: "Refreshable dashboard of recent workspace activity.",
  metadata: {
    category: "operations",
    businessUseCase: "Latest workspace update",
    requiredCapabilities: [],
    optionalCapabilities: ["drive", "mail", "calendar"],
    outputs: [
      {
        kind: "dashboard",
        label: "Activity dashboard",
        layout: "layouts/dashboard.json",
      },
    ],
    phases: ["Summarize"],
  },
  inputs: {
    scope: {
      type: "string",
      required: true,
      label: "Scope",
      default: "this week",
      order: 1,
      group: "Dashboard",
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
    dashboard: {
      schema: "schemas/dashboard.schema.json",
    },
  },
  capabilities: ["drive", "mail", "calendar"],
  limits: {},
  start: "draftSnapshot",
  nodes: [
    {
      id: "draftSnapshot",
      label: "Draft activity snapshot",
      onSuccess: "completed",
      kind: "agent",
      prompt: "prompts/draft-snapshot.md",
      inputs: {
        scope: {
          input: "scope",
        },
        workspaceRoot: {
          input: "workspaceRoot",
        },
      },
      tools: [],
      output: {
        artifact: "dashboard",
        schema: "schemas/dashboard.schema.json",
      },
    },
  ],
};
