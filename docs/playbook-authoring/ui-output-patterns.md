# Playbook UI Output Patterns

"Display in UI" is not one thing. Classify the requested surface before editing a playbook package.

## Run-Result UI

Use this when the user wants the final output to appear in the Tessera run result UI.

Package contract:

- Declare the final artifact in `artifacts` with a schema.
- Ensure a node actually produces that artifact or run output key.
- Declare `metadata.outputs` with `kind` equal to the produced artifact id or run output key.
- Add a clear `label`.
- Materialize the artifact or provide an effect-record path when the UI card should open a file.
- Keep intermediate research, raw source, and review artifacts out of the final output list unless the user asks to expose them.
- For existing packages, the smallest valid update is usually in `playbook.ts`: find the final produced artifact id from `output.artifact` or `outputArtifact`, preserve any existing workspace/document/file output, and append a `metadata.outputs` entry whose `kind` is exactly that artifact id.

Example:

```ts
metadata: {
  outputs: [{ kind: "emailSummary", label: "Email summary" }],
}
```

The graph must produce `emailSummary`; the value cannot be only a display label.

## Human Review UI

Use this when the user must approve, request changes, or deny the generated artifact before the graph continues.

Package contract:

- Add a `humanReview` node.
- Point it at the artifact being reviewed.
- Define actions and follow-up branches.
- Keep review output schemas separate from final output schemas when the review produces structured feedback.

## Dashboard UI

Use this only when the user asks for a dashboard, charted view, layout, refreshable view, or dashboard-like monitoring surface.

Package contract:

- Declare `metadata.outputs` with `kind: "dashboard"`.
- Keep the dashboard data artifact and schema in `artifacts`.
- Add a package-relative dashboard layout, usually `layouts/dashboard.json`.
- Bind layout widgets to run outputs with dotted paths.

Dashboard output is separate from a normal final run-result card.

## Clarify

Use task UI QnA mode when the user says "display in UI" but package inspection does not make the intended surface clear.

Default rule: if the user asks for final output visibility and does not mention dashboard, chart, layout, refresh, or monitoring, choose run-result UI.
