# Task Agent UI/UX Design

## Summary

Update the Tessera frontend UI to fully expose the agent capabilities introduced in the backend (`2026-05-01-pi-coding-agent-mvp-design.md` and `2026-05-02-pi-session-context-and-policy-design.md`). This enables users to manage Agent Profiles (with custom instructions, soul, and skills) and select an agent when creating tasks, bringing the `AGENTS.md`, `SOUL.md`, and skills paradigms directly into the user interface.

## Goals

- Expose Agent Profile management in the desktop UI so users can define instructions, soul, and skills.
- Allow users to select an Agent Profile during task creation.
- Surface the active agent context in the Task Detail view so the user understands how the agent is configured.
- Gracefully handle the new `waiting` task status caused by workspace boundary violations.

## Non-Goals

- Do not implement a marketplace for downloading community agents in this slice.
- Do not add multi-agent orchestration (sub-agents calling other agents).
- Do not implement complex file-backed editing of profiles directly mapped to `AGENTS.md` and `SOUL.md` on the file system; these are stored in the sidecar database per `2026-05-02-task-model-settings-and-agent-profiles-design.md`.

## Architecture & Integration

All UI changes happen in `apps/desktop/ui/src/`. No new backend capabilities are added, only the frontend wiring to existing contracts (`packages/contracts/src/index.ts`).

### 1. Agent Profile Management UI

Agent Profiles govern task execution and can optionally override global model settings. Therefore, Agent Management naturally fits within the existing `SettingsView.tsx`.

**Changes to `SettingsView`:**
- Add a new "Agents" navigation item in the left sidebar of the settings pane (below "Model").
- **List View:** When "Agents" is selected, the main pane shows a list of configured Agent Profiles, including the read-only built-in "Tessera" default agent.
- **Form View:** Clicking "New Agent" or selecting an existing custom agent opens the profile editor.

**Form Fields (Mapping to `AgentProfileSchema`):**
- **Name:** Input field (e.g., "Frontend Specialist").
- **Description:** Optional short description.
- **Instructions:** A large multi-line `textarea`. This serves as the UI equivalent of `AGENTS.md`, giving the agent its primary directives.
- **Soul:** A multi-line `textarea`. This serves as the UI equivalent of `SOUL.md`, defining personality, tone, and stylistic constraints.
- **Skills:** A multi-select component populated by the backend's available skills.
- **Model Override:** A toggle or dropdown that switches between "Use Global Default" and "Override Model". If overridden, displays fields for Provider and Model selection.

### 2. Task Creation: Agent Selector

Currently, task creation is implicit when a user sends their first message in `TaskComposer` on an empty state.

**Changes to `TaskComposer` and `TaskDetail`:**
- When `task` is null (the user is viewing the empty state to create a new task), an **Agent Selector** dropdown appears.
- **Placement:** The selector sits compactly just above the `TaskComposer` input area, displaying a small bot icon and the currently selected agent's name.
- **Behavior:** Clicking it opens a dropdown of available Agent Profiles. It defaults to the built-in "Tessera" agent.
- **Submission:** When the user hits send, the `agentId` from the selector is passed to `onCreateTask`.
- Once the task is created (subsequent turns), the selector disappears since the task is locked to that agent.

### 3. Task Detail: Active Agent Context

Once a task is running, the user needs to know which agent is handling it and what instructions that agent has.

**Changes to `TaskDetail` Header:**
- The header currently displays `{task.status} • {task.agentLabel ?? "Tessera"}`.
- Make the `task.agentLabel` interactive (e.g., a clickable badge).
- Clicking the badge opens a **Popover or Drawer** that displays a read-only summary of the agent:
  - Agent Name
  - Model being used (Global or Override)
  - Instructions (Markdown rendered)
  - Soul (Markdown rendered)
  - Enabled Skills
- This ensures transparency so the user knows *why* the agent is behaving a certain way.

### 4. Task Turn Representation

**Changes to Turn Bubbles:**
- The `turnLabel` function currently falls back to `"Tessera"` for `role === "agent"`.
- Update this to use the task's `agentLabel` (e.g., `"Frontend Specialist"`) so the conversation feels driven by the specific persona.

### 5. Handling Workspace Boundary Violations (`waiting` status)

The `pi-session-context-and-policy-design.md` introduced a `waiting` state when an agent hits a workspace boundary violation.

**Changes to `TaskDetail` / `TaskList`:**
- When `task.status === "waiting"`, update the visual indicator (e.g., yellow/amber warning color instead of the active/done colors).
- Display the `latestActivity` message prominently below the latest turn. It will say something like: *"Paused: agent reached workspace boundary"*.
- The `TaskComposer` remains unlocked. The placeholder text should change to: *"Provide guidance or correct the boundary issue..."* to signal that the user needs to intervene and provide a follow-up turn to unblock the agent.

## Tauri Commands & State

The UI will need to interface with the sidecar's agent profile store. We will add thin Tauri commands to match the backend CRUD operations:
- `agent_profile_list`
- `agent_profile_get`
- `agent_profile_create`
- `agent_profile_update`
- `agent_profile_delete`

These will be invoked from the `SettingsView` and the `TaskComposer` (for populating the dropdown).

## Error Handling

- If the selected `agentId` is deleted while a task is running, the backend falls back gracefully or returns a validation error. The UI should catch this and display an inline error in the Task Detail view.
- If saving an Agent Profile fails (e.g., invalid model override config), display an inline error inside the Settings form.

## Verification

To verify this implementation slice:
1. Ensure the UI can create an Agent Profile with custom Instructions and Soul.
2. Ensure creating a task with that Agent Profile passes the correct `agentId`.
3. Verify that the task detail correctly displays the `agentLabel` on the agent's response turns.
4. Trigger a workspace boundary violation (e.g., ask the agent to list the root `/` directory) and verify the UI gracefully enters the `waiting` state, allowing the user to send a follow-up message to continue.
