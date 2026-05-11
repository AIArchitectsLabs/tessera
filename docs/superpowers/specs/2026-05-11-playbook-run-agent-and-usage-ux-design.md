# Playbook Run Agent and Usage UX Design

## Decision

Improve Playbook run and detail screens with a hybrid of the current guided flow
and a persistent inspect surface.

The main panel remains a business-friendly guided experience. Before the first
run, the user must explicitly review and confirm agent assignment instead of
Tessera silently auto-assigning. The right-side details panel becomes a richer
Playbook Inspector that can show workflow structure, per-node agent assignment,
source coverage, run history, and token usage.

This keeps Playbooks approachable while making the execution plan visible enough
for multi-agent playbooks.

## Context

The current implementation already has useful foundations:

- `PlaybookDetail` includes the playbook's ordered `steps`.
- `WorkflowRunResult` can persist `assignmentPlan`.
- Each `WorkflowRunStepRecord` can carry an `assignment`.
- The Playbooks UI already has guided states and a details panel.
- The runtime already validates assignment plans at the sidecar/core boundary.

The missing product layer is not a new workflow engine. It is a clearer run
setup and inspection experience.

## User Goals

- On the first run, choose the agent or confirm the recommended agent before the
  playbook starts.
- See what the playbook will do before running it.
- Understand each node in the playbook, especially when different nodes use
  different agents.
- Change the agent for a later run without editing the playbook package.
- Inspect what agent/model actually ran for a historical run.
- See input, output, and total token usage for a playbook run.
- Eventually compare usage across runs of the same playbook.

## Approaches Considered

### Guided Preflight

The Start screen adds a preflight block after intake fields. It shows workflow
steps and agent assignments, and the user confirms or edits assignments before
running.

Pros:
- Minimal change to the current UI.
- Excellent first-run clarity.
- Low implementation risk.

Cons:
- Workflow visibility is strongest only before run.
- Multi-agent workflows may become cramped in the main form.

### Workflow Canvas First

The detail screen becomes primarily a node canvas. Users configure agents by
clicking nodes, then run from the canvas.

Pros:
- Best mental model for complex multi-agent workflows.
- Scales to branching and larger workflows.

Cons:
- Heavy for business users.
- Larger design and implementation surface.
- Risks making simple playbooks feel like automation tooling.

### Split Run Workbench

Keep the guided center panel, but add an always-available inspect panel with
workflow, agents, sources, history, and usage.

Pros:
- Preserves the existing business-oriented flow.
- Supports advanced visibility without forcing it on every user.
- Gives each concept a stable home as playbooks become multi-agent.

Cons:
- Needs careful information hierarchy to avoid a noisy right panel.
- Requires new UI state for editing assignments before and after runs.

## Recommendation

Use Split Run Workbench as the destination, with Guided Preflight as the first
implementation slice.

The user should see a concise "Before you run" module in the Start state:

- Inputs summary
- Workflow steps
- Agent assignment summary
- Missing setup or optional source gaps
- Estimated readiness

The user should be able to open the inspector from the Start, Preparing, Review,
and Result states. The inspector should default to the most relevant tab for the
current state.

## Information Architecture

### Left Column

The left Playbooks column remains:

- Workspace picker
- Dashboard playbooks, when applicable
- Playbooks list
- Runs for the selected playbook

Run rows should add lightweight usage once available:

- Status
- Run time
- Assigned primary agent, if one agent dominated the run
- Total tokens, compacted as `7.2k tokens`

### Main Panel

The main panel remains the guided flow:

1. Start
2. Preparing
3. Review
4. Result

The Start state gains a required setup checkpoint:

- "Inputs" remains the existing form.
- "Workflow" shows a collapsed preview of the steps.
- "Agents" shows the resolved assignment plan and requires confirmation on the
  first run.
- The Run button is disabled until required inputs and required assignments are
  complete.

For repeat runs, the last confirmed assignment plan for this playbook should be
offered as the default. The user can run with the same setup or edit before
launching.

### Right Inspector

Replace the current generic Details panel with a Playbook Inspector. It should
use tabs or segmented controls:

- `Workflow`: playbook structure, phases, step nodes, transitions.
- `Agents`: current run assignment plan or next-run draft assignments.
- `Usage`: token usage for the selected run.
- `Events`: activity log and errors.

The inspector remains optional. The main guided flow should still explain the
current state without relying on the inspector.

## Workflow Visibility

The workflow view should render steps from `PlaybookDetail.steps`.

MVP display:

- Group by `phase`.
- Show step label, kind, status if a run is selected, and transition target.
- Agent steps show the assigned agent and model.
- Tool steps show the business-readable tool label and approval risk when known.

Future display:

- Render as a compact node graph once branching workflows become common.
- Show capability requirements per node.
- Show optional source availability per node.

This should not expose raw workflow ids as primary text. IDs can appear in a
secondary technical row or copyable developer detail.

## Agent Assignment UX

### First Run

The first run of a playbook in a workspace should not auto-start with an
invisible assignment.

Flow:

1. Tessera resolves candidate assignments from current agent profiles and
   settings.
2. If there is one valid candidate per node, show it as "Recommended" but still
   require the user to confirm before first run.
3. If multiple candidates exist, show a selector per agent node.
4. If no candidate exists, show a setup blocker with the missing capability.
5. Persist the confirmed assignment preference locally for that playbook and
   workspace.

This means "auto-resolve" may still compute a recommendation, but the first-run
user experience is explicit.

### Later Runs

For repeat runs:

- Default to the last confirmed assignment preference.
- Show "Using Maeve for Draft meeting brief" near the Run button.
- Provide `Change agents` to reopen the assignment editor.
- If an agent profile, model, tool policy, or credential changed, show
  "Setup changed" and require reconfirmation.

Changing agents affects future runs only. Historical runs keep their persisted
assignment plan.

### Per-Node Assignment

Agent nodes should support independent assignment. A playbook can use different
agents for research, drafting, review, and publishing.

Each agent-node row should show:

- Step label
- Required capabilities
- Selected agent
- Provider/model
- Tool policy summary
- Source/integration fit
- Credential status

The default edit control should be a compact selector, not a free-form config
editor. Full agent editing remains in Settings.

## Token Usage

Token usage belongs on the run record, not only in transient logs.

Add a structured usage object to run and step records:

```ts
type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};
```

Recommended additive contract:

- `WorkflowRunStepRecord.usage?: TokenUsage`
- `WorkflowRunResult.usage?: TokenUsage`

The run-level usage is the sum of all step usage values that report token data.
Tool-only steps usually have no token usage unless they call a model.

### Runtime Capture

`runPiTaskTurn` should expose usage from the Pi SDK event stream or final model
response when available. If the provider or local model does not report usage,
the field should be omitted rather than guessed.

Provider differences should be normalized into `TokenUsage`:

- OpenAI-style `prompt_tokens` -> `inputTokens`
- OpenAI-style `completion_tokens` -> `outputTokens`
- Anthropic-style input/output tokens map directly
- Reasoning and cache tokens are optional provider-specific additions

The UI must label missing usage as "Not reported by provider" rather than `0`.

### Usage UI

Usage summary should appear in three places:

- Run history row: compact total token count.
- Result header: input, output, total tokens for the selected run.
- Inspector `Usage` tab: per-step breakdown.

The detailed view should show:

- Step label
- Agent/model
- Input tokens
- Output tokens
- Total tokens
- Optional cache/reasoning tokens
- "Not reported" state per step

Do not add cost estimates in this phase. Token counts are the requirement; cost
requires a separate model pricing design.

## Data Persistence

### Assignment Preferences

Add local, non-secret playbook run preferences scoped by workspace and playbook:

```ts
type PlaybookRunPreference = {
  workspaceRoot: string;
  playbookId: string;
  assignmentPlan: WorkflowRunAssignmentPlan;
  updatedAt: string;
};
```

This can initially live in the sidecar SQLite database alongside workflow runs.
It must not be written into playbook packages.

Preferences store local profile ids and fingerprints but no credentials.

### Run Records

Historical run records should persist:

- Assignment plan used for that run
- Per-step assignment snapshot
- Per-step token usage
- Run-level token usage
- Source gaps
- Events

This allows users to understand why two runs differed after changing agents.

## API Shape

Additive sidecar commands/endpoints:

- `playbook_assignment_preview(playbookId, capabilityInventory, previousPlan?)`
  returns candidate assignments, blockers, recommendations, and whether
  confirmation is required.
- `playbook_run_preference_get(playbookId, workspaceRoot)`
  returns the stored assignment preference for this workspace/playbook.
- `playbook_run_preference_save(playbookId, workspaceRoot, assignmentPlan)`
  validates and stores a preference.

Existing run creation continues to accept an `assignmentPlan`. The sidecar still
validates the plan against the current inventory before execution.

## Error Handling

- Missing required agent capability blocks before run.
- Missing provider credential blocks before run.
- Stale preference shows "Setup changed" and asks the user to choose again.
- Missing token data shows "Not reported by provider."
- Runtime assignment mismatch remains a sidecar/core validation error.

## Testing

Contract tests:

- Token usage schemas accept complete and partial usage.
- Workflow run records accept step-level and run-level usage.
- Assignment preferences reject stale or invalid plans.

Core tests:

- Agent step usage is captured when the runner returns usage.
- Run usage sums step usage.
- Missing provider usage remains undefined.

Sidecar tests:

- Assignment preview returns recommended candidates.
- First-run preference save validates assignment plans.
- Run create uses explicit assignment plans and persists usage.

UI tests:

- First run requires assignment confirmation.
- Repeat run uses last confirmed assignment.
- User can change the agent before a later run.
- Workflow tab renders playbook steps.
- Usage tab shows input/output/total tokens and missing usage states.

## Out of Scope

- Cost estimation.
- Full visual node-canvas editing.
- Editing agent profile definitions inside Playbook run setup.
- Playbook package authoring changes beyond existing step metadata.
- Provider pricing catalogs.
- Multi-workspace synchronization of playbook assignment preferences.

## Acceptance Criteria

- A first-time playbook run cannot start without visible assignment confirmation.
- Users can inspect workflow structure before and after a run.
- Users can assign different agents to different agent nodes.
- Users can change assignments for later runs without mutating past runs.
- Historical runs show the assignment plan that was used.
- Completed runs show input, output, and total token usage when reported.
- Missing token data is clearly shown as provider-unreported, not zero.
- The main guided flow remains understandable without opening the inspector.
