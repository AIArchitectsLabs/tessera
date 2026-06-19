---
name: tessera-playbook-debugger
description: Debug, troubleshoot, and repair Tessera playbook runs from Task UI evidence. Use when a playbook fails, stalls, needs attention, produces a blank or tiny workspace file, writes the wrong artifact, skips a source lookup, cannot read mail/drive/calendar/web data, has suspicious run artifacts/effects/operation logs, or when the user asks to inspect playbook logs, graph run database records, run ids, output files, or execution diagnostics and then fix the playbook package.
---

# Tessera Playbook Debugger

Use this skill to move from "the playbook did not work" to a concrete root cause, package edit, and validation result. Prefer run evidence over speculation.

## Task UI Workflow

1. Run diagnostics first:
   - Call `playbook_run_diagnostics` before editing.
   - Use `runId` when the user provides it.
   - Use `playbookId` or `packagePath` such as `playbooks/weekly-email-summary` when the run id is unknown.
   - Set `includeArtifactPreviews: true` only when short artifact previews are needed to distinguish source, draft, and output failures.

2. Classify the failure:
   - Source gap: required mail/drive/calendar/web/workspace source is prompt-only or has no successful tool node.
   - Connector/tool gap: a tool node failed, used the wrong capability, or returned an empty/unexpected shape.
   - Artifact gap: an agent or script produced missing, invalid, schema-mismatched, or source-unavailable artifact content.
   - Materialization gap: a workspace output is missing, blank, tiny, or much smaller than the source artifact.
   - Runtime/package gap: the run is failed, blocked, needs repair, interrupted, or the pinned snapshot is invalid.

3. Inspect package files after diagnostics:
   - Read `manifest.json`, `playbook.ts`, relevant schemas, prompts, scripts, fixtures, and tests under the target package.
   - Do not scaffold over an existing package unless the user explicitly asks to regenerate it.
   - Preserve package id and intended output path unless the diagnostic proves they are wrong.

4. Fix the smallest broken surface:
   - Add executable source nodes for live sources; do not rely on agent prompt instructions to "look up" data.
   - Ensure declared `metadata.requiredCapabilities`, top-level `capabilities`, tool node `capability`, produced artifacts, and downstream inputs agree.
   - For blank markdown output, ensure the artifact passed to the write/materialization node contains a non-empty text field. The materializer extracts content from these keys in order: `text`, `markdown`, `summaryMarkdown`, `bodyMarkdown`, `contentMarkdown`, `content`, `body`, `summary`. It then falls back to composing a document from `title`, `thesis`, `audiencePromise`, and `outline` fields. If none of these are populated, the materialized output will be blank or use a raw JSON dump. Fix the agent prompt or script that produces the artifact to populate at least one of these fields.
   - Tighten prompts and schemas only after source and materialization nodes are structurally correct.
   - Add or update package tests/fixtures for the failure class when practical.

5. Validate:
   - Call `playbook_package_validate` for the package path after edits.
   - If validation fails, fix validator errors before reporting.
   - Final response must include the diagnosed run or package path, root cause, files changed, validation status, and any remaining run-time credential or connector gap.

## Guardrails

- Use native Tessera tools; do not print fake tool calls, JSON command blobs, raw SQL, or shell transcripts.
- Treat diagnostics as read-only evidence. Make repairs through workspace tools under the package path.
- Do not expose full email bodies, credentials, tokens, or raw private source dumps in the final answer. Quote only short previews needed to explain the fix.
- If the diagnostic points to Tessera platform code rather than the external playbook package, say so clearly and provide the smallest package-side workaround only when it is valid.
