export default function run(context: {
  node: { inputs: Record<string, unknown> };
  input: Record<string, unknown>;
}) {
  return {
    capability: context.node.inputs.capability,
    args: context.node.inputs.args,
    input: context.input,
    status: "completed",
  };
}
