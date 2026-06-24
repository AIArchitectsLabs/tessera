# Agentic Existing Playbook Update Flow

Use this flow when a user asks to enhance, modify, upgrade, or repair an existing Tessera playbook package.

## Contract

1. Resolve the target package from `playbooks/<name>`, folder name, manifest `id`, or manifest `name`.
2. Inspect the existing package before editing: `manifest.json`, `playbook.ts`, schemas, prompts, scripts, fixtures, tests, and `PLAYBOOK.md`.
3. Classify the requested change:
   - clear package update: edit package files, then validate.
   - run troubleshooting: inspect recent run evidence, then edit only when the evidence identifies a package issue.
   - ambiguous target or workflow change: ask one focused clarification in the task UI before editing.
   - platform gap: report the missing connector, tool, skill, effect, or runtime behavior.
4. Preserve package identity unless the user explicitly requests a replacement: keep stable `id`, existing purpose, and compatible inputs/outputs where possible.
5. Update maintenance docs, fixtures, tests, and schemas when behavior changes.
6. Run `playbook_package_validate` after edits and report changed files plus validation status.

Validation-only is not completion for an update request. It proves package shape and tests, not that the requested semantic change was implemented.

## QnA Mode

When the request remains ambiguous after package inspection, use the task UI clarification tool instead of guessing. Ask one short question with concrete options when possible.

Examples:

- "Should this appear as a final run result card, a human review step, or a dashboard?"
- "Which existing `playbooks/<name>` package should I update?"
- "Should the workflow send a Gmail draft, write a workspace artifact, or only show the result in Tessera?"

Do not ask when the workspace already answers the question. For example, `weekly-email-summary`, `playbook weekly-email-summary`, and `weekly email summary playbook` should resolve to `playbooks/weekly-email-summary` when that package exists.

## Deterministic Guardrail Boundary

Tessera runner code may resolve packages, assemble context, validate, import, run diagnostics, enforce changed-file requirements, and fail honestly. It should not use canned package-mutating transforms as the hidden implementer for feature/update asks.

PI should make the package edits through workspace tools when the update is clear.
