# Skills Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first skills foundation to Tessera, covering skill discovery,
agent profile configuration, task-level slash activation, and runtime use by agents.

**Tech Stack:** Bun, TypeScript, Zod, SQLite, Tauri 2 commands, React + Vite.

**Scope:** Local MVP only. Do not add remote registries, marketplace install/update,
skill audits, env injection, agent-created procedural memory, or executable skill
permissions in this slice.

## Context

Tessera already has Agent Profiles, task execution config, tool policy presets,
and a Pi session prompt assembly path. A prior Agent Profiles design reserved
`skills: string[]`, and the sidecar SQLite table already has a legacy
`skills_json` column, but the current public `AgentProfile` contract no longer
exposes skills.

Hermes and OpenClaw both treat skills as structured instruction bundles rather
than credentials or executable integrations. Tessera should follow that split:
skills provide procedural context; tools/plugins provide capabilities and
secrets.

References:

- Hermes Skills System: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/
- Hermes Working with Skills: https://hermes-agent.nousresearch.com/docs/guides/work-with-skills
- Hermes Creating Skills: https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills
- OpenClaw Skills: https://docs.openclaw.ai/tools/skills
- OpenClaw Creating Skills: https://docs.openclaw.ai/tools/creating-skills
- OpenClaw Slash Commands: https://docs.openclaw.ai/tools/slash-commands
- Claude Code Skills: https://docs.claude.com/en/docs/claude-code/skills

## Product Decisions

- Skills are local instruction bundles with a `SKILL.md` file and optional
  supporting files.
- The first slice supports curated built-in, user-local, and workspace-local
  skills.
- The first slice discovers compatible external local skills from Claude Code
  and Codex roots, but never enables them automatically.
- The built-in Tessera default agent starts with curated built-in skills only.
- Custom agents select explicit skill IDs through Agent Profiles.
- `/skill-name ...` and `/skill skill-name ...` activate a skill for the whole
  task, not only the current turn.
- Task-activated skills are separate from profile-configured skills and persist
  with the task until removed.
- Skills never grant tools, inject credentials, install dependencies, or execute
  code in this slice.

## Skill Format

Use an AgentSkills-style folder:

```text
skill-slug/
  SKILL.md
  references/
  scripts/
  assets/
```

`SKILL.md` must support this frontmatter subset:

```yaml
---
name: skill-slug
description: Short capability description shown to agents and users.
---
```

Rules:

- `name` is the stable skill ID and must be a lowercase slug.
- `description` is required and must be non-empty.
- The markdown body is the skill prompt material.
- Supporting files are allowed but only read through validated registry paths.
- Ignore unsupported frontmatter keys in v1.

## Implementation Steps

- [ ] Add shared skill contracts in `packages/contracts/src/index.ts`:
  - `SkillSourceSchema`: `curated | user | workspace | external`
  - `ExternalSkillProviderSchema`: `claude-code | codex`
  - `SkillSummarySchema`: `id`, `name`, `description`, `source`, optional
    `externalProvider`, `path`, `updatedAt`, `conflict`
  - `SkillDetailSchema`: summary plus `content`
  - `TaskSkillActivationSchema`: `skillId`, `name`, `source`, `activatedAt`,
    `activatedByTurnId?`
  - list/detail response schemas for sidecar and Tauri commands
- [ ] Extend `AgentProfileSchema`, create request, update request, and templates
  with `skills: string[]`.
- [ ] Update `compileAgentRuntimeContext()` so the runtime summary includes a
  concise skills summary and active skill count where available.
- [ ] Add `skill_list` and `skill_load` to every `TOOL_POLICY_PRESET_DETAILS`
  `allowedTools` entry because they are read-only context tools.
- [ ] Implement a sidecar skill registry:
  - curated root: a repo-owned built-in skills directory packaged with the
    sidecar
  - user root: `~/.tessera/skills`
  - workspace root: `<workspaceRoot>/.tessera/skills`
  - external Claude Code roots: `~/.claude/skills` and
    `<workspaceRoot>/.claude/skills`
  - external Codex roots: `~/.codex/skills` and
    `<workspaceRoot>/.codex/skills` when present or configured
  - precedence: workspace > user > curated
  - external skills are listed as opt-in candidates and do not override
    Tessera-owned skills
  - same-name conflicts resolve to the highest-precedence source and expose
    conflict metadata in summaries
  - realpath containment checks must prevent path traversal and symlink escape
- [ ] Add external skill import/enable behavior:
  - show compatible external skills in the picker with their provider label
  - allow explicit profile enablement without copying files
  - optionally support copying an external skill into `~/.tessera/skills`
  - ignore foreign-only metadata such as Claude `allowed-tools`, env injection,
    subagent routing, and plugin hooks
  - never include external skills in the default agent's curated allowlist
- [ ] Add a small curated built-in skill set for the default agent. Keep it
  business-oriented and generic, such as planning, research synthesis, and
  document drafting. Do not add many skills in this slice.
- [ ] Update `apps/sidecar/src/agent-profile-store.ts`:
  - read and write `skills_json`
  - round-trip profile skills in create, update, get, and list
  - preserve existing rows by defaulting null or malformed legacy values to `[]`
- [ ] Add task skill activation persistence to the sidecar task database:
  - create a table keyed by `task_id + skill_id`
  - add store methods to list, add, and remove active skills
  - expose active skills on task detail responses
- [ ] Add sidecar endpoints:
  - `GET /skills?workspaceRoot=...&agentId=...`
  - `GET /skills/:id?workspaceRoot=...&agentId=...`
  - `POST /tasks/:taskId/skills`
  - `DELETE /tasks/:taskId/skills/:id`
- [ ] Add matching Tauri commands so the React UI never calls sidecar endpoints
  directly.
- [ ] Implement runtime skill tools in `packages/core/src/pi-session.ts`:
  - `skill_list` returns eligible skill summaries for the selected agent and
    workspace.
  - `skill_load` returns full `SKILL.md` content for one eligible skill.
  - Both tools must use the same registry eligibility rules as the sidecar API.
- [ ] Update Pi prompt assembly:
  - include active task skill content in every turn
  - tell agents that `skill_list` and `skill_load` are available when procedural
    knowledge may help
  - keep base Tessera identity before profile and skill material
- [ ] Implement slash-style task parsing in sidecar task creation and task turn
  creation:
  - `/skill-slug optional instruction` activates that skill for the task
  - `/skill skill-slug optional instruction` behaves the same
  - when no instruction remains, use `Use the <skill name> skill for this task.`
  - unknown generic `/skill missing` returns a clear validation error
  - unknown direct `/foo` stays normal user text to avoid breaking arbitrary
    slash-looking content
- [ ] Update Agent Settings UI:
  - add a compact skills picker to create/edit profile flows
  - show skill source and conflict status
  - save selected skill IDs with the profile
- [ ] Update Task UI:
  - show active task skills as chips near existing agent context
  - allow removing active task skills
  - reflect slash activation after the sidecar accepts a task turn

## Test Plan

- [ ] Contract tests:
  - valid skill summaries/details parse
  - invalid IDs and missing descriptions fail
  - agent profiles round-trip `skills`
  - tool policy presets include `skill_list` and `skill_load`
- [ ] Registry tests:
  - scans curated, user, and workspace roots
  - scans Claude Code and Codex external roots when present
  - applies workspace > user > curated precedence
  - keeps external skills opt-in and separate from Tessera-owned precedence
  - exposes conflict metadata
  - blocks path traversal and symlink escape
  - skips malformed `SKILL.md` files without crashing the full list
- [ ] Profile store tests:
  - create profile with skills
  - update profile skills
  - legacy rows with empty or invalid `skills_json` load safely as `[]`
- [ ] Task activation tests:
  - `/skill-slug do X` activates the skill and runs `do X`
  - `/skill skill-slug do X` activates the skill and runs `do X`
  - active skill persists into later turns
  - removing a skill stops preloading it on later turns
  - unknown generic `/skill missing` fails clearly
  - unknown direct `/foo` is treated as normal text
- [ ] Runtime tests:
  - default agent sees only curated built-ins
  - custom agent sees only selected skills
  - external skills are invisible until explicitly enabled or imported
  - `skill_list` and `skill_load` respect profile eligibility
  - active task skill content is included in prompt assembly
- [ ] UI tests:
  - Agent Settings saves and reloads selected skills
  - Task Detail shows active skill chips

## Verification

Run:

```bash
bun run check
bun run --filter '*' test
```

If UI behavior changes are substantial, also start the desktop UI dev server and
inspect the Agent Settings and Task Detail flows in the browser.

## Follow-Up Slices

- Remote skill installation and update flow.
- Skill trust/audit metadata.
- Hot reload for local skill authoring.
- Agent-created procedural memory.
- Skill-specific tool recommendations.
- Env injection or plugin-backed executable skills, only after a separate
  security design.
