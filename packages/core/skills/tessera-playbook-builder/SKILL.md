---
name: tessera-playbook-builder
description: Build, enhance, fix, or update Tessera playbooks through an interview-first workflow. Use when an agent needs to create a new playbook package from scratch, improve an existing playbook in the workspace, repair a failed or invalid playbook package, update workflow instructions, brainstorm tools/effects/data sources/review gates/final artifacts, generate or modify package files, run validation loops, or prepare portable recipes for Claude Code, Codex, Claude Cowork, Pi Agent, Tessera agents, or any harness that supports skills.
---

# Tessera Playbook Builder

Use this portable skill to build, enhance, fix, or update Tessera playbooks from any agent harness. Start with interview-driven discovery and an authoring brief; generate or modify package files only after the workflow, runtime boundary, source inventory, review gates, effects, artifacts, and validation path are coherent.

## Builder Modes

Choose the mode from the user request and workspace evidence:

- Create: no existing playbook is specified; design a new workflow and create a package.
- Enhance: an existing playbook works but needs better prompts, schemas, steps, outputs, review gates, or business fit.
- Fix: a playbook failed validation, import, execution, or user review; inspect diagnostics and repair the smallest broken surface.
- Update: the business workflow changed; preserve the package identity while modifying sources, tools, effects, outputs, or instructions.

If the mode, target playbook, source/effect choice, or requested UI surface is unclear after inspecting the workspace, ask one concise clarification question with a suggested default action in the task UI before editing.

Existing workspace playbooks live under `playbooks/<name>` by default. Treat a bare playbook id or name near the word "playbook" as an existing package target when a matching workspace folder, manifest `id`, or manifest `name` exists. Examples: `weekly-email-summary`, `playbook weekly-email-summary`, and `weekly email summary playbook` should resolve to `playbooks/weekly-email-summary` when that package exists.

## Production Grade Bar

Production-grade means the package is importable, runnable by Tessera, auditable, and maintainable by a future operator. Do not settle for a prompt-only demo package when the request implies real sources, tools, connectors, review, or durable outputs.

Before generating or updating files:

- Map every requested source, tool, connector, skill, and effect to Tessera's registered capability ids. Prefer canonical ids: `tool.workspace.read`, `tool.workspace.write`, `integration.calendar.events.read`, `integration.crm.accounts.read`, `integration.web.search`, `integration.web.fetch`, `integration.mail.messages.read`, `integration.mail.drafts.write`, `integration.drive.files.read`, `integration.contacts.read`, `integration.sheets.rows.write`, `integration.docs.documents.write`, `skill.meeting-prep`, and `skill.account-research`.
- Use legacy aliases such as `mail`, `web`, `drive`, or `calendar` only when repairing a legacy package; new packages should use canonical ids.
- For every required live source or connector, add an executable graph `tool` node with the matching capability, a schema-backed raw-source artifact, fixture coverage, downstream script or agent consumption, and explicit empty/error/source-gap handling.
- For every durable write or external side effect, add an `effect` node with capability, adapter, approval, preview, idempotency key, target, and final materialization format.
- Put required runtime capabilities in both `metadata.requiredCapabilities` and top-level `capabilities`. If you want to document optional sources, add them to `metadata.optionalCapabilities` — this field is UI/documentation metadata only, not a preflight gate; preflight treats every capability not in `metadata.requiredCapabilities` as optional automatically. Either way, make sure the graph still produces a useful artifact when optional sources are absent.
- Agent skills are capability requirements and assignment hints, not package-local runtimes. Do not invent a `skill` node or execute skills from package scripts. If a playbook requires a Tessera skill capability, declare it and document which agent step depends on it.
- The graph must have a reachable `start`, declared artifacts for every output, schemas for every agent output, explicit review/rework branches when review is needed, and a final artifact or effect that Tessera can show in the UI or materialize.
- Include package-local fixtures and tests for deterministic scripts, schemas, ids/versions, capability declarations, and source-gap behavior. Tests must not run live connectors or the graph outside Tessera.
- Include maintenance notes in `PLAYBOOK.md`: how to add/remove sources, change prompts, modify schemas, add review gates, change outputs, bump versions, validate, and import.

If a requested connector, skill, tool, or effect is not available in Tessera, stop and report the platform gap or create an explicitly fixture-first package. Do not claim the workflow is connector-backed unless the graph has executable nodes for those sources/effects.

## Tessera Task Mode Contract

When running inside Tessera task mode:

- Use native Tessera tools, not textual tool markup. Never print `<tool_use>`, JSON command blobs, shell transcripts, or simulated tool calls as the answer.
- If the package name/path is not explicit, use the clarification UI to ask what to call the playbook package. Include a concise suggested name/path as the first option and allow a custom name.
- For new playbooks, once the package name/path is confirmed or accepted from the suggestion, start package generation by calling `playbook_package_scaffold` once. Use `workspace_write` afterward only for bespoke additions or repairs, then call `playbook_package_validate` for the package path.
- For existing playbooks, enhancements, updates, or follow-up complaints such as blank output, failed validation, bad artifacts, or "not working", do not ask what to call a new package. First resolve the target from the workspace `playbooks/` folder, then inspect the existing package files, preserve unrelated files and user edits, use `workspace_write` or `workspace_edit` only for the files that need enhancement, repair, or update, and call `playbook_package_validate` for the package path. If no matching folder, manifest `id`, or manifest `name` can be found, ask which existing `playbooks/<name>` folder to inspect.
- For ambiguous update requests, use the clarification UI before editing. For example, "display in UI" must resolve to run-result output, human review UI, dashboard UI, or a clarification question. Default to run-result UI only when the user asks for final output visibility and does not mention dashboards, charts, layouts, refreshable views, or monitoring.
- For run-result UI, declare `metadata.outputs` with a `kind` that matches an actually produced artifact id or run output key, back that artifact with a schema, and materialize/provide a path when the result card should open a file.
- Minimal run-result UI edit for an existing package: inspect `playbook.ts`, find the final produced artifact id from `output.artifact` or `outputArtifact`, then add or append `metadata.outputs: [{ kind: "<thatArtifactId>", label: "<human label>" }]`. Preserve existing markdown, workspace document, or file materialization outputs unless the user explicitly asks to replace them. If the final artifact has no schema, add or repair the schema in the same edit pass.
- After a clarification response is received, continue immediately into package generation; do not stop after acknowledging the answer.
- Completion requires successful package writes under the package path, production-grade graph wiring, update documentation, and successful validation through `playbook_package_validate`. Validation-only is not completion for a feature/update ask. Prefer the scaffold tool for first-pass package creation, then make the bespoke edits required for the real workflow.
- The final message must name the package path, summarize files actually written, and include validation status.

Minimum viable package writes:

```text
<package-path>/manifest.json
<package-path>/playbook.ts
<package-path>/schemas/finalArtifact.schema.json
<package-path>/prompts/draft.md
<package-path>/scripts/normalize.ts
<package-path>/fixtures/sample.json
<package-path>/tests/package.test.ts
<package-path>/build.ts
<package-path>/BUILD.md
<package-path>/PLAYBOOK.md
```

Minimum content guidance:

- `manifest.json`: `schemaVersion`, stable dotted or hyphenated `id`, `version`, `name`, `entrypoint: "playbook.ts"`.
- `playbook.ts`: default-export a Tessera graph with `schemaVersion`, matching `id`/`version`, `inputs`, `artifacts`, declared `capabilities`, `start`, and `nodes`.
- `schemas/*.schema.json`: JSON Schema for every agent output and final artifact.
- `prompts/*.md`: task-specific instructions that return schema-shaped outputs only.
- `scripts/*.ts`: deterministic package-local helpers only; no Tessera runtime imports and no standalone graph runner.
- `tests/*.test.ts`: validate JSON files, lockstep ids/versions, references, and script behavior over fixtures.
- `BUILD.md` and `build.ts`: dev-only validation/package notes; no dependency fields, lockfiles, or `bin` entrypoints.

Working playbook bar:

- A playbook that names a live source must collect that source through an executable graph node. Do not leave Gmail, web, drive, calendar, or workspace evidence as a prompt-only instruction.
- Required live sources must appear in both `metadata.requiredCapabilities` and top-level `capabilities`, and the source node must produce a declared raw-source artifact consumed by downstream scripts or agents.
- Tool and effect nodes must use registered Tessera capability ids. Do not invent connector ids, shell commands, or capability names to satisfy the prompt.
- The graph should be easy to evolve: preserve package identity, keep node ids stable when possible, isolate source normalization in scripts, version schema changes, and update `PLAYBOOK.md`, fixtures, tests, and validation evidence with every workflow change.
- Fixtures prove empty/noisy/duplicate data handling, but fixtures are not a substitute for live source nodes when the user asked for a runtime connector-backed workflow.
- For email or Gmail summaries, generate a `tool` node using `integration.mail.messages.read` with `mail search` or `mail list`, write the result to a schema-backed artifact such as `mailSearch`, and pass that artifact into the draft node.
- If Tessera lacks the connector needed for the requested live workflow, stop and report the platform gap or create an explicitly fixture-first package; do not claim a usable connector-backed playbook.

If time or model budget is tight, call `playbook_package_scaffold` first, then use `workspace_write` for the most important bespoke files. Do not claim the package is complete until every file you name has been written by a native tool and the package has passed validation.

## Canonical Contract

Prefer the repo-owned contract when the Tessera repo is available:

- `docs/playbook-authoring/authoring-brief-template.md`
- `docs/playbook-authoring/agentic-update-flow.md`
- `docs/playbook-authoring/package-contract.md`
- `docs/playbook-authoring/ui-output-patterns.md`
- `docs/playbook-authoring/validation-loop.md`
- `docs/playbook-authoring/sdk-helper-candidate-log.md`
- `docs/playbook-authoring-recipe.md`
- `docs/playbook-patterns.md`
- `docs/playbook-validation-guide.md`
- `docs/playbook-authoring/tessera-playbook-builder-portable.md`

This skill is an ergonomic wrapper around those docs, not a separate standard. Harness-specific adapters may copy or symlink this directory into their own skill roots, but this installed skill directory is the central task-skill source.

## Workflow

1. Boundary check:
   - Confirm Tessera is the only runtime.
   - Confirm the external playbook package path.
   - Reject standalone graph runners, `bin` entrypoints, lockfiles, dependency fields, live-credential fixtures, and local graph execution wrappers.

2. Interview and brainstorm:
   - Load `references/authoring-interview.md`.
   - Map the end-to-end workflow: trigger, user, decision, sources, tools/connectors, deterministic scripts, agent tasks, human review, effects, final artifacts, and import/use expectations.
   - Ask one focused question only when a missing answer would change graph shape, source access, effects, or final artifacts.
   - When a structured clarification or ask-question tool is available, use that UI with concise options instead of embedding reply examples in transcript text.

3. Authoring brief gate:
   - Use the canonical brief template when available.
   - Stop before generation if the brief is incoherent, material requirements are missing, or the package assumes a non-Tessera runtime.

4. Package creation, enhancement, repair, or update:
   - Load `references/package-contract.md`.
   - Load `references/package-blueprint.md` for the from-scratch folder skeleton, graph conventions, build tooling, tests, and portability rules.
   - Use `docs/playbook-patterns.md` when choosing graph patterns.
   - In Tessera task mode for new playbooks, ask for the playbook package name/path first when it is not explicit, suggesting a fallback such as `playbooks/weekly-email-summary`; then create the initial package with `playbook_package_scaffold`, use `workspace_write` for bespoke additions or repairs, and call `playbook_package_validate` for the package path. Do not emit Claude/Codex-style `<tool_use>` tags, shell transcripts, or command JSON in chat text.
   - For existing playbooks or repair/improvement follow-ups, locate and inspect the existing package before editing. Search the workspace `playbooks/` folder and match the user's target against package path, folder name, manifest `id`, and manifest `name`. Do not scaffold over an existing package unless the user explicitly asks to regenerate it.
   - For existing playbook updates, PI should edit package files through workspace tools when the requested change is clear. Deterministic runner validation or diagnostics are guardrails, not substitutes for package edits.
   - For UI output requests, load `docs/playbook-authoring/ui-output-patterns.md` when available and classify the requested surface before editing.
   - Create, enhance, fix, or update the package folder with `manifest.json`, `playbook.ts`, schemas, prompts, deterministic scripts, fixtures, tests, `build.ts`, `BUILD.md`, `PLAYBOOK.md`, and optional `package.json` only when useful for package-local tests.
   - Do not report package generation or update as complete until workspace files have actually been written under the confirmed package path.
   - Use package-relative refs and explicit schemas for agent outputs.
   - Keep domain schemas, prompts, scripts, fixtures, scoring, and final templates in the external playbook package.
   - Keep dev build tooling outside the runtime payload and exclude generated archives, local metadata, dependency directories, and lockfiles.

5. Validation loop:
   - Load `references/validation-loop.md`.
   - Use `docs/playbook-validation-guide.md` for diagnostic repair examples when available.
   - In Tessera task mode, call `playbook_package_validate` after creating, enhancing, fixing, or updating package files; it runs package-local checks plus Tessera text and JSON validation when the CLI is available.
   - Outside Tessera task mode, run package-local typecheck/tests when present, then Tessera text and JSON validation.
   - Fix errors first, warnings second, then record command, exit code, `ok`, diagnostic counts, unresolved diagnostics, and repair notes.

6. SDK helper notes:
   - Load `references/sdk-helper-candidates.md`.
   - Record helper candidates only when friction repeats across SEO/GEO, supply-chain, or a forward test.
   - Do not implement SDK helpers from this skill unless the user explicitly starts Phase 2B.

## External Harness Portability

- Keep this skill self-contained: `SKILL.md`, `agents/openai.yaml`, and `references/*` should be enough for Claude Code, Codex, Claude Cowork, Pi Agent, Tessera agents, or another skill-capable harness.
- When the Tessera repo is not available, use the bundled references first, then ask for the package contract or validation command only if generation would otherwise be unsafe.
- When the Tessera repo is available, prefer repo-owned docs over memory and run validation through the local Tessera CLI.
- A finished pass should leave a folder or zip ready for Tessera import, not a standalone runner.

## Stop Conditions

Stop and ask or report a blocker when:

- The runtime boundary is unclear or violated.
- The package path is missing.
- The business outcome or final artifact audience is unknown.
- Source/tool/effect choices are missing and would change the graph.
- A live connector requires credentials or production access not granted by the user.
- Validator errors expose missing platform behavior rather than package authoring mistakes.
