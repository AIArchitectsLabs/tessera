---
name: tessera-playbook-author
description: Build or repair external Tessera playbook packages through an interview-first workflow. Use when an agent needs to brainstorm the end-to-end business workflow, tools, effects, data sources, capabilities, schemas, review gates, final artifacts, package skeleton, build scripts, validation loop, or SDK-helper candidates before generating or repairing playbook files. Use for from-scratch playbook authoring, existing playbook repair, validator-driven repair loops, and portable recipes for Claude Code, Codex, Claude Cowork, Pi Agent, Tessera agents, or any harness that supports skills.
---

# Tessera Playbook Author

Use this portable skill to author or repair external Tessera playbook packages from any agent harness. Start with interview-driven discovery and an authoring brief; generate package files only after the workflow, runtime boundary, source inventory, review gates, effects, artifacts, and validation path are coherent.

## Tessera Task Mode Contract

When running inside Tessera task mode:

- Use native Tessera tools, not textual tool markup. Never print `<tool_use>`, JSON command blobs, shell transcripts, or simulated tool calls as the answer.
- If the package name/path is not explicit, use the clarification UI to ask what to call the playbook package. Include a concise suggested name/path as the first option and allow a custom name.
- Once the package name/path is confirmed or accepted from the suggestion, start package generation by calling `playbook_package_scaffold` once. Use `workspace_write` afterward only for bespoke additions or repairs.
- After a clarification response is received, continue immediately into package generation; do not stop after acknowledging the answer.
- Completion requires a successful `playbook_package_scaffold` call or successful `workspace_write` calls under the package path. Prefer the scaffold tool for first-pass package creation.
- The final message must name the package path and summarize files actually written.

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

If time or model budget is tight, call `playbook_package_scaffold` first, then use `workspace_write` for the most important bespoke files. Do not claim the package is complete until every file you name has been written by a native tool.

## Canonical Contract

Prefer the repo-owned contract when the Tessera repo is available:

- `docs/playbook-authoring/authoring-brief-template.md`
- `docs/playbook-authoring/package-contract.md`
- `docs/playbook-authoring/validation-loop.md`
- `docs/playbook-authoring/sdk-helper-candidate-log.md`
- `docs/playbook-authoring-recipe.md`
- `docs/playbook-patterns.md`
- `docs/playbook-validation-guide.md`
- `docs/playbook-authoring/tessera-playbook-author-portable.md`

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

4. Package generation or repair:
   - Load `references/package-contract.md`.
   - Load `references/package-blueprint.md` for the from-scratch folder skeleton, graph conventions, build tooling, tests, and portability rules.
   - Use `docs/playbook-patterns.md` when choosing graph patterns.
   - In Tessera task mode, ask for the playbook package name/path first when it is not explicit, suggesting a fallback such as `playbooks/weekly-email-summary`; then create the initial package with `playbook_package_scaffold`, and use `workspace_write` for bespoke additions or repairs. Do not emit Claude/Codex-style `<tool_use>` tags, shell transcripts, or command JSON in chat text.
   - Create or repair the package folder with `manifest.json`, `playbook.ts`, schemas, prompts, deterministic scripts, fixtures, tests, `build.ts`, `BUILD.md`, `PLAYBOOK.md`, and optional `package.json` only when useful for package-local tests.
   - Do not report package generation as complete until workspace files have actually been written under the confirmed package path.
   - Use package-relative refs and explicit schemas for agent outputs.
   - Keep domain schemas, prompts, scripts, fixtures, scoring, and final templates in the external playbook package.
   - Keep dev build tooling outside the runtime payload and exclude generated archives, local metadata, dependency directories, and lockfiles.

5. Validation loop:
   - Load `references/validation-loop.md`.
   - Use `docs/playbook-validation-guide.md` for diagnostic repair examples when available.
   - Run package-local typecheck/tests when present, then Tessera text and JSON validation.
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
