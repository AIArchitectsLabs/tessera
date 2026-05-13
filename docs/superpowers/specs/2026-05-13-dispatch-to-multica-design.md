# Design: dispatch-to-multica — Plan → Multica Issue Pipeline

**Date:** 2026-05-13
**Status:** Approved

---

## Overview

A new superpowers skill (`/dispatch-to-multica`) that bridges the existing brainstorm → spec → plan pipeline with Multica issue tracking and agent execution. The skill reads an approved plan doc, derives a task breakdown using LLM reasoning, maps each task to a configured Multica agent, and creates issues in bulk — including full spec/plan context embedded in each issue description.

The skill is platform-portable: works identically in Claude Code and Codex.

---

## Full Pipeline

```
/brainstorm  →  spec doc  →  /writing-plans  →  plan doc  →  /dispatch-to-multica  →  Multica issues  →  agents execute
```

Each stage produces a durable artifact:
- Spec: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Plan: `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`
- Routing config: `docs/superpowers/multica-agents.json`
- Issues: created in Multica, assigned to configured agents

Agents are registered in Multica independently (e.g. "Agent A" = Codex/gpt-5.5-medium, "Agent B" = Codex/gpt-5.4-mini-medium, "Agent C" = pi-agent). They poll for assigned issues and execute on their own schedule — the skill does not trigger execution.

---

## Skill Interface

```
/dispatch-to-multica [plan-file] [flags]
```

**Arguments:**
- `plan-file` — path to a plan markdown file. Defaults to the most recently modified file in `docs/superpowers/plans/`

**Flags:**
- `--agent <name>` — override routing config; assign all tasks to one specific Multica agent
- `--project <id>` — target a specific Multica project (otherwise uses workspace default)
- `--reconfigure` — re-run the routing config setup wizard even if a config already exists
- `--dry-run` — print the derived task breakdown and assignments without creating any issues

---

## Execution Flow

### Step 1: Resolve plan file
Read the target plan doc (explicit path or latest in `docs/superpowers/plans/`).

### Step 2: Validate agents
Call `multica agent list`. If no routing config exists at `docs/superpowers/multica-agents.json`, run the first-run setup wizard (see below). If the config exists but references agents no longer in Multica, warn and prompt the user to update or `--reconfigure`.

### Step 3: Derive task breakdown
Use LLM reasoning to extract discrete, actionable tasks from the plan. Each task gets:
- A short title
- A description drawn from the relevant plan section
- A category (frontend, backend, research, etc.)

### Step 4: Map category → agent
Look up each task's category in the routing config to determine `--assignee`. Tasks with an unrecognized category fall back to the configured default agent. Log which tasks were defaulted.

### Step 5: Embed context
Each issue description includes:
- Path to the source spec doc
- The relevant plan section as a quoted block

This gives the assigned agent full context without needing to hunt for files.

### Step 6: Create issues in Multica
Create a parent issue for the feature (plan title), then create each task as a child issue via:

```
multica issue create \
  --title "<task title>" \
  --description "<description + spec context>" \
  --assignee "<agent name>" \
  --priority "<priority>" \
  --parent "<parent issue id>"
```

Parent issue is created first. If parent creation fails, abort — no orphaned child tickets.

---

## First-Run Routing Config Setup

Triggered when no `docs/superpowers/multica-agents.json` exists, or when `--reconfigure` is passed.

```
No routing config found at docs/superpowers/multica-agents.json
Found 3 agents in your workspace:
  1. Agent A (codex / gpt-5.5-medium)
  2. Agent B (codex / gpt-5.4-mini-medium)
  3. Agent C (pi-agent)

Which agent handles: frontend tasks? → 1
Which agent handles: backend tasks? → 2
Which agent handles: research/lightweight tasks? → 3
Which agent is the default for uncategorized tasks? → 1

Config saved. Re-run with --reconfigure to change this.
```

### Routing config format (`multica-agents.json`)

```json
{
  "routing": {
    "frontend": "Agent A",
    "backend": "Agent B",
    "research": "Agent C"
  },
  "default": "Agent A"
}
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Agent in routing config no longer exists in Multica | Warn user, prompt to update config or `--reconfigure` |
| No tasks derived from plan | Exit with clear message; do not create empty parent issue |
| `multica` CLI not authenticated | Detect auth failure, tell user to run `multica login` first |
| Task category has no routing match | Fall back to default agent; log which tasks were defaulted |
| Parent issue creation fails | Abort before creating child tasks |
| Spec doc path cannot be resolved | Create issues but note unresolved spec path in description; do not block |

---

## Routing Config Location

`docs/superpowers/multica-agents.json` — committed to the repo so the routing config is shared and versioned alongside specs and plans. The file is safe to commit: it contains only Multica agent names, not credentials.

---

## Out of Scope

- Triggering agent execution after ticket creation (agents poll Multica independently)
- Modifying the `writing-plans` skill or plan doc format
- Two-way sync (updating plan docs when Multica issues change)
- Multica autopilot / scheduled dispatch configuration
