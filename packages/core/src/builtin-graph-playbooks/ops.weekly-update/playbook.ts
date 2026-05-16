export default {
  schemaVersion: 1,
  id: "ops.weekly-update",
  version: "1",
  name: "Weekly Update",
  description: "Prepare and stage a weekly status update with one approval checkpoint.",
  metadata: {
    requiredCapabilities: [],
    optionalCapabilities: [],
    outputs: [],
    phases: ["Collect", "Draft", "Approval"],
  },
  inputs: {
    message: {
      type: "string",
      required: true,
      default: "weekly status",
    },
    target: {
      type: "string",
      required: true,
      default: "weekly-update",
    },
    value: {
      type: "string",
      required: true,
      default: "draft-ready",
    },
  },
  artifacts: {
    result: {
      schema: "schemas/result.schema.json",
    },
  },
  capabilities: [],
  limits: {},
  start: "collectContext",
  nodes: [
    {
      id: "collectContext",
      label: "Collect context",
      onSuccess: "stageDraft",
      kind: "script",
      run: "scripts/collectContext.ts",
      inputs: {
        args: {
          message: "{{inputs.message}}",
        },
        capability: "workspace.ping",
      },
    },
    {
      id: "stageDraft",
      label: "Stage update draft",
      onSuccess: "completed",
      kind: "script",
      outputArtifact: "result",
      run: "scripts/stageDraft.ts",
      inputs: {
        args: {
          target: "{{inputs.target}}",
          value: "{{inputs.value}}",
        },
        capability: "workspace.writeProbe",
      },
    },
  ],
};
