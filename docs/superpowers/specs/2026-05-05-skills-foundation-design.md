# Skills Foundation Design

## Summary

Tessera should add Skills as a first-class foundation feature for agent behavior.
A skill is a local instruction bundle that teaches an agent how to perform a
class of work. Skills are not tools, plugins, credentials, or executable
permissions. They add procedural context; existing tools and plugin surfaces
continue to own capabilities and integrations.

The first slice is local-first and deliberately narrow:

- curated built-in skills for the default Tessera agent
- user-local skills under `~/.tessera/skills`
- workspace-local skills under `<workspaceRoot>/.tessera/skills`
- compatible external local skills from Claude Code and Codex roots, shown as
  opt-in candidates
- agent profile skill selection
- task-level slash activation that persists for the whole task
- runtime `skill_list` and `skill_load` tools for agent discovery

This design borrows the useful parts of Hermes and OpenClaw without taking on
remote installation, marketplace behavior, env injection, or agent-created
procedural memory in v1.

## Goals

- Give Tessera agents reusable procedural knowledge without hardcoding every
  behavior into the base system prompt.
- Let the built-in Tessera agent start with a small curated skill set.
- Let custom Agent Profiles opt into specific local skills.
- Let users invoke skills inside task messages with slash-style commands.
- Persist slash-invoked skills as task context for later turns.
- Keep skills read-only and non-secret.
- Preserve the existing model, credential, tool policy, and workspace boundary
  architecture.

## Non-Goals

- Remote skill registries, skill installation, or update management.
- Skill trust/audit metadata beyond source and conflict display.
- Skill hot reload for authoring.
- Agent-created skills or procedural memory.
- Skill-specific credential/env injection.
- Executing foreign metadata such as Claude `allowed-tools`, Codex routing,
  subagent directives, plugin hooks, or env injection.
- Skills granting tools or relaxing tool policy.
- Marketplace UI or sharing flows.
- A general plugin loader.

## Current State

Tessera already has the right insertion points:

- `AgentProfile` controls task behavior through instructions, soul,
  user context, memory defaults, model selection, and tool policy.
- `agent_profiles` SQLite storage already includes a legacy `skills_json`
  column.
- `compileAgentRuntimeContext()` creates the sidecar/UI runtime summary for an
  agent profile.
- `runPiTaskTurn()` builds the prompt sent into the Pi agent session.
- `TOOL_POLICY_PRESET_DETAILS` controls which tools each agent policy can use.
- Task detail already exposes an `agentContext` snapshot that can be extended
  with active skill context.

The gap is that skills are not currently part of the public contracts, profile
storage round-trip, sidecar APIs, task persistence, UI, or Pi session runtime.

## Product Model

### Skill

A Skill is a folder with a required `SKILL.md` file:

```text
skill-slug/
  SKILL.md
  references/
  scripts/
  assets/
```

The v1 parser supports only this frontmatter subset:

```yaml
---
name: skill-slug
description: Short capability description shown to users and agents.
---
```

The markdown body is the prompt material. Supporting files may be present for
future use, but v1 only loads the `SKILL.md` body through the registry. Scripts
and assets are inert unless a later slice explicitly designs execution or file
exposure.

### Skill Sources

Tessera has three owned local sources:

- `curated`: skills shipped with Tessera
- `user`: skills under `~/.tessera/skills`
- `workspace`: skills under `<workspaceRoot>/.tessera/skills`

Tessera can also discover external AgentSkills-compatible sources:

- `external` with provider `claude-code`: `~/.claude/skills` and
  `<workspaceRoot>/.claude/skills`
- `external` with provider `codex`: `~/.codex/skills` and
  `<workspaceRoot>/.codex/skills` when present or configured

Resolution precedence is:

1. workspace
2. user
3. curated

If multiple sources define the same skill `name`, the highest-precedence source
wins and the summary records that a conflict exists. The UI should show the
winning source and a compact conflict indicator; v1 does not need a conflict
resolution editor.

External skills do not participate in owned-source precedence and do not
override curated, user, or workspace skills. They are listed as opt-in
candidates with their provider label. Users may explicitly enable an external
skill on an Agent Profile or copy/import it into `~/.tessera/skills`.

### Default Agent Skills

The built-in `DEFAULT_AGENT_PROFILE` starts with a curated allowlist only. The
first curated set should stay small and generic, such as:

- planning
- research synthesis
- document drafting

The default agent should not automatically consume user-local, workspace-local,
or external skills. This avoids surprising behavior from local files while still
giving new users a useful skills path.

### Custom Agent Skills

Custom Agent Profiles store `skills: string[]`. These are skill IDs selected by
the user in Agent Settings.

An empty list means the profile has no extra skills enabled. A custom profile
does not implicitly inherit every workspace or user skill. This keeps profile
behavior predictable and makes skills part of the agent contract.

### Task-Activated Skills

A task can have active skills independent of the selected Agent Profile. Active
skills come from slash invocation or explicit UI activation. They persist with
the task and are preloaded into later turns until removed.

Task activation does not mutate the Agent Profile. It is session-specific
context, not a global profile edit.

## Contracts

Add shared schemas in `packages/contracts`:

```ts
type SkillSource = "curated" | "user" | "workspace" | "external";
type ExternalSkillProvider = "claude-code" | "codex";

type SkillSummary = {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  externalProvider?: ExternalSkillProvider;
  path?: string;
  updatedAt?: string;
  conflict?: {
    shadowedSources: SkillSource[];
  };
};

type SkillDetail = SkillSummary & {
  content: string;
};

type TaskSkillActivation = {
  skillId: string;
  name: string;
  source: SkillSource;
  activatedAt: string;
  activatedByTurnId?: string;
};
```

Extend `AgentProfile`, create requests, update requests, and templates:

```ts
type AgentProfile = {
  // existing fields
  skills: string[];
};
```

Extend task detail with active skill data. Prefer a top-level
`activeSkills: TaskSkillActivation[]` field on `TaskDetail` to avoid overloading
`agentContext`, while still allowing `compiledSummary` to mention skill state.

## Architecture

### Skill Registry

The sidecar owns skill discovery and loading because skills are local
non-secret data and because sidecar task execution also needs the same registry.

Responsibilities:

- scan configured roots
- parse `SKILL.md` frontmatter
- validate skill IDs and descriptions
- enforce precedence
- expose conflict metadata
- discover external Claude Code and Codex roots when present
- keep external skills opt-in and separate from Tessera-owned precedence
- perform realpath containment checks before loading content
- filter skills by agent eligibility

Malformed skills should not crash the whole list. The registry should skip them
and optionally expose diagnostics in logs or future UI. Directly loading a
malformed or missing skill should fail clearly.

External adapters should parse only compatible `SKILL.md` metadata and markdown
content. Tessera should ignore foreign-only fields in v1, including Claude
`allowed-tools`, Codex workflow routing, dynamic context injection, subagent
directives, plugin hooks, and environment declarations.

### Profile Store

`apps/sidecar/src/agent-profile-store.ts` should read and write the existing
`skills_json` column. Legacy rows with missing, empty, or malformed values load
as `[]`.

Profile create/update should validate skill IDs syntactically. Existence checks
should happen in API handlers where `workspaceRoot` and registry context are
available.

### Task Store

Task skill activations should be stored in SQLite with a table keyed by
`task_id + skill_id`. The stored row should include:

- task id
- skill id
- resolved skill name
- resolved source
- activation timestamp
- optional turn id that activated it

The task detail read path should include active skills. Removing an active skill
deletes the row and stops future prompt preloading.

### Runtime Tools

Add two read-only Pi tools:

- `skill_list`: returns eligible skill summaries.
- `skill_load`: returns full `SKILL.md` content for one eligible skill.

Both tools must respect the selected agent profile and task context. They must
not load arbitrary filesystem paths. They should be available in all tool policy
presets because they only read skill metadata/content and do not mutate the
workspace.

### Prompt Assembly

Prompt composition should keep stable ordering:

1. Tessera base system prompt.
2. Agent profile sections.
3. Tool policy guidance.
4. Active task skill content.
5. Skill discovery guidance.
6. Prior conversation.
7. Current user task.

Active task skills are preloaded every turn. Profile-enabled skills are not all
preloaded by default; agents can discover and load them with `skill_list` and
`skill_load`. This keeps prompts smaller while preserving access to procedural
knowledge.

## Slash Invocation

Tessera supports two task-message forms:

```text
/skill skill-slug optional instruction
/skill-slug optional instruction
```

Behavior:

1. Parse slash invocation before creating the user turn.
2. Resolve the skill against the current task workspace and selected agent.
3. If allowed, add the skill to the task activation table.
4. Strip the slash command from the user-visible instruction.
5. If no instruction remains, use `Use the <skill name> skill for this task.`
6. Run the task turn normally with the active skill preloaded.

Unknown generic `/skill missing` should return a clear validation error. Unknown
direct `/foo` should remain normal user text, because users may paste commands
or slash-looking content that is unrelated to Tessera skills.

Slash invocation persists for the whole task. It does not update the selected
Agent Profile.

## API Surface

Sidecar endpoints:

```text
GET /skills?workspaceRoot=...&agentId=...
GET /skills/:id?workspaceRoot=...&agentId=...
POST /tasks/:taskId/skills
DELETE /tasks/:taskId/skills/:id
```

Tauri commands should wrap these endpoints so the React UI continues to call
desktop commands rather than sidecar HTTP directly.

Request behavior:

- `workspaceRoot` is required for workspace skills and containment checks.
- `agentId` defaults to `default`.
- profile skill eligibility is enforced server-side.
- task skill activation validates that the skill is eligible for the task's
  selected agent or is part of the default curated set.

## UI Behavior

### Agent Settings

Add a compact skills picker to Agent Profile create/edit flows:

- show skill name, description, and source
- show external provider labels for discovered Claude Code and Codex skills
- show a conflict indicator when a higher-precedence skill shadows another
  source
- persist selected skill IDs with the profile
- allow explicit external skill enablement without copying files
- optionally offer copy/import into `~/.tessera/skills`
- keep model/tool policy controls unchanged

The picker should optimize for scanning, not marketplace browsing. No remote
search in v1.

### Task Detail

Show active task skills near the existing agent context:

- skill chips display skill name and source
- each chip can be removed
- slash activation should appear after the sidecar accepts the turn

The composer does not need autocomplete in v1. Plain slash invocation is enough
for the first vertical slice.

## Security And Boundaries

- Skills are read-only instruction material.
- Skills never store credentials.
- Skills never change tool policy.
- `skill_load` must only load registry-resolved `SKILL.md` content.
- Registry paths must use realpath containment checks.
- Workspace-local skills must stay inside the selected workspace.
- User-local skills must stay inside `~/.tessera/skills`.
- Curated skills must stay inside the shipped curated skills root.
- Claude Code external skills must stay inside `~/.claude/skills` or
  `<workspaceRoot>/.claude/skills`.
- Codex external skills must stay inside `~/.codex/skills` or
  `<workspaceRoot>/.codex/skills`.
- External skills are never enabled by default and are never part of the default
  agent curated allowlist.
- Foreign skill metadata must not grant tools, route subagents, inject env, or
  invoke plugin behavior in Tessera.
- Malformed skills are skipped during list and rejected on direct load.
- Skill content should be treated as untrusted prompt context. Tessera's base
  system prompt and tool policy remain higher priority.

## Error Handling

- Missing skill on `/skill missing`: return a validation error naming the skill.
- Unknown direct `/foo`: treat as normal text.
- Malformed `SKILL.md` during list: skip it.
- Malformed `SKILL.md` during direct load: fail with a clear message.
- Selected profile references a missing skill: omit it from runtime eligibility
  and surface a compact warning in profile or task context.
- Active task skill disappears from disk: keep the activation row but skip prompt
  preload and show it as unavailable in task detail.
- External skill root is missing: omit that source silently.

## Acceptance Criteria

- Agent Profiles can save, list, update, and load selected skills.
- Default agent can discover only curated built-in skills before user
  configuration.
- Custom agents can discover and load only their selected eligible skills.
- Claude Code and Codex skills appear as external opt-in candidates when their
  local roots exist.
- External skills are not usable by an agent until explicitly enabled or
  imported.
- `/skill skill-slug ...` and `/skill-slug ...` activate a skill for the whole
  task.
- Active task skills are included in later turns until removed.
- Skills do not grant additional workspace tools or credentials.
- Path traversal and symlink escape attempts cannot load content outside the
  configured skill roots.
- Existing task execution works unchanged when no skills are configured.

## Test Plan

- Contract tests for skill schemas, agent profile `skills`, task activations,
  and tool policy entries.
- Registry tests for discovery, external adapters, precedence, conflict metadata,
  malformed skills, and containment checks.
- Profile store tests for create/update/list/get round-tripping `skills_json`
  and legacy fallback behavior.
- Task store tests for active skill add/list/remove and task detail inclusion.
- Slash parser tests for generic invocation, direct invocation, missing skills,
  empty instruction fallback, and unknown direct slash text.
- Runtime tests for `skill_list`, `skill_load`, profile eligibility, default
  curated visibility, external opt-in behavior, and active skill prompt
  preloading.
- UI tests for Agent Settings skill selection and Task Detail active skill chips.

## Verification

Run:

```bash
bun run check
bun run --filter '*' test
```

For UI work, also run the desktop UI dev server and inspect Agent Settings and
Task Detail flows in the browser.

## Follow-Ups

- Remote skill install/update.
- Skill trust and audit metadata.
- Hot reload for local skill authoring.
- Agent-created procedural memory.
- Skill autocomplete in the task composer.
- Plugin-backed executable skills after a separate security design.
