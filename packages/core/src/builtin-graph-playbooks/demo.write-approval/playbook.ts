export default {
  schemaVersion: 1,
  id: "demo.write-approval",
  version: "1",
  name: "Demo Write Approval",
  description: "Proves deterministic workflow execution with HITL pause/resume.",
  metadata: {
    requiredCapabilities: [],
    optionalCapabilities: [],
    outputs: [],
    phases: ["Run"],
  },
  inputs: {
    message: {
      type: "string",
      required: true,
      default: "hello",
    },
    target: {
      type: "string",
      required: true,
      default: "lead",
    },
    value: {
      type: "string",
      required: true,
      default: "qualified",
    },
  },
  artifacts: {
    result: {
      schema: "schemas/result.schema.json",
    },
  },
  capabilities: [],
  limits: {},
  start: "ping",
  nodes: [
    {
      id: "ping",
      onSuccess: "writeProbe",
      kind: "script",
      run: "scripts/ping.ts",
      inputs: {
        args: {
          message: "{{inputs.message}}",
        },
        capability: "workspace.ping",
      },
    },
    {
      id: "writeProbe",
      onSuccess: "completed",
      kind: "script",
      outputArtifact: "result",
      run: "scripts/writeProbe.ts",
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
