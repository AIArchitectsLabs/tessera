# Guided Playbooks UX Design

## Decision

Playbooks should use a guided, same-flow experience. A business user chooses a
playbook, answers plain-language intake questions, starts the work, reviews any
approval request, and opens the result without being moved into a technical run
console.

The Playbooks surface should present outcomes and artifacts, not workflow
internals. `workflow` remains the internal engine term. `Playbook` is the
user-facing product concept.

## Product Principle

A playbook is a repeatable business job that Tessera prepares with the user's
business context. The user should feel they are asking Tessera to prepare a
meeting brief, risk review, or digest, not operating an automation engine.

Default UI language must avoid:

- Workflow IDs such as `ops.weekly-update`
- Tool names such as `workspace.writeProbe`
- Raw JSON payloads
- Event logs as the main artifact
- Millisecond durations as primary information
- "Run console" or "Inspector" as default labels

Acceptable technical detail can exist behind a developer/debug affordance later,
but it must not be the default business-user path.

## Primary Flow

The selected playbook owns one centered guided page with four states:

1. **Start**
   The user sees the playbook name, business use case, what Tessera will prepare,
   connected sources it may use, and a short intake form.

2. **Preparing**
   The form transforms in place into a progress view. Progress rows use business
   phrasing such as "Draft meeting brief" and "Check source coverage." The page
   should say the user can leave and return later.

3. **Review**
   If the workflow blocks on approval, the same page explains the business
   consequence: for example, "Approve the workspace prep?" The user approves or
   stops the business action, not a tool grant.

4. **Result**
   The page ends on the prepared artifact and next action: open brief, copy
   summary, start another, or view source coverage. Run history remains
   accessible but secondary.

## Layout

Use a quiet operational layout:

- Left rail remains global navigation.
- Playbooks view has a narrow left column for playbook selection and recent
  runs for the selected playbook.
- Main panel is the guided flow.
- Right panel is optional and contextual. It should show "Details" only when it
  helps: request summary, expected outputs, source coverage, approval summary.

The main panel must be able to stand alone. A user should understand the current
state by reading the main panel only.

## Playbook Selection

The playbook list should show:

- Playbook name
- Business use case
- Category, when useful
- Last run status for that playbook, if present

The previous finalized test playbook set must remain available:

- Sales Meeting Brief
- Renewal Risk Review
- Weekly Status Digest

Demo or compatibility workflows may remain registered internally but should not
be promoted over business examples in the default Playbooks experience.

## Intake Forms

Inputs come from manifest metadata:

- `label`
- `description`
- `placeholder`
- `group`
- `order`
- `ui.control`
- `options`

The form should render only user-meaningful fields. System fields such as
`workspaceRoot` should be injected, not displayed.

Controls:

- `text` for short values
- `textarea` for objectives and longer prompts
- `date` for date fields
- `multiselect` for sources and focus areas
- `checkbox` for boolean choices

Start buttons should use specific action copy where possible:

- `Prepare brief`
- `Prepare risk review`
- `Create digest`

Fallback copy can be `Start playbook`.

## Progress And Review Copy

Step labels should be business labels from the manifest. Status labels should be:

- `Not started`
- `Working`
- `Done`
- `Waiting for your review`
- `Needs attention`
- `Stopped`

Approval copy should explain:

- What Tessera prepared
- What will change if approved
- What happens if stopped

It should not expose raw permission payloads by default.

## Result View

The result state should prioritize artifacts:

- Prepared brief, digest, or review
- Source summary and source gaps
- Workspace update status, when applicable

Raw output payloads are not acceptable as the primary output view. Until rich
artifact rendering exists, show structured, readable summaries and a lightweight
placeholder for the prepared artifact.

## Error And Empty States

Empty:

- If no playbook is selected, show a business-oriented prompt to choose a
  playbook.
- If a playbook is selected but has no runs, show the intake form, not an empty
  run list.

Blocked:

- Use "Needs review" rather than "blocked."

Failed:

- Use "Needs attention."
- Show a short reason and a retry or start-over action when possible.

Workspace missing:

- Disable start and explain "Select a workspace before starting this playbook."

## Testing

Add focused UI tests for:

- Playbook list renders business names and use cases.
- Selecting a playbook shows the guided intake form.
- `workspaceRoot` is not shown as a user input.
- Starting a playbook sends normalized input with hidden workspace root.
- Preparing state renders business step labels, not tool names.
- Approval state uses business copy and calls resume APIs.
- Result state renders declared outputs without raw JSON.
- Empty, failed, and missing-workspace states use business copy.

Backend and contract tests should keep covering:

- Rich manifest input metadata.
- Restored test playbook manifests.
- Run display records/events remain available for UI progress.

## Implementation Notes

The current MVP already added several useful backend pieces: manifest-backed
playbook APIs, run detail schemas, step records, and persisted events. The next
implementation pass should reuse those contracts but replace the current
Playbooks UI structure with the guided same-flow model.

Avoid broad renaming of workflow internals. Keep the split:

- Internal: workflow definition, workflow runner, workflow checkpoints.
- External: playbook launcher, playbook intake, playbook result.
