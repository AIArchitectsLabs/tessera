---
name: tessera-playbook-author
description: Build or repair external Tessera playbook packages through an interview-first workflow. Use when an agent needs to brainstorm the end-to-end business workflow, tools, effects, data sources, capabilities, schemas, review gates, final artifacts, package skeleton, build scripts, validation loop, or SDK-helper candidates before generating or repairing playbook files. Use for from-scratch playbook authoring, existing playbook repair, validator-driven repair loops, and portable recipes for Claude Code, Codex, Claude Cowork, Pi Agent, Tessera agents, or any harness that supports skills.
---

# Tessera Playbook Author

Use this portable skill to author or repair external Tessera playbook packages from any agent harness. Start with interview-driven discovery and an authoring brief; generate package files only after the workflow, runtime boundary, source inventory, review gates, effects, artifacts, and validation path are coherent.

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

This skill is an ergonomic wrapper around those docs, not a separate standard. Harness-specific adapters may copy or symlink this directory into their own skill roots, but this docs copy is the central source.

## Workflow

1. Boundary check:
   - Confirm Tessera is the only runtime.
   - Confirm the external playbook package path.
   - Reject standalone graph runners, `bin` entrypoints, lockfiles, dependency fields, live-credential fixtures, and local graph execution wrappers.

2. Interview and brainstorm:
   - Load `references/authoring-interview.md`.
   - Map the end-to-end workflow: trigger, user, decision, sources, tools/connectors, deterministic scripts, agent tasks, human review, effects, final artifacts, and import/use expectations.
   - Ask one focused question only when a missing answer would change graph shape, source access, effects, or final artifacts.

3. Authoring brief gate:
   - Use the canonical brief template when available.
   - Stop before generation if the brief is incoherent, material requirements are missing, or the package assumes a non-Tessera runtime.

4. Package generation or repair:
   - Load `references/package-contract.md`.
   - Load `references/package-blueprint.md` for the from-scratch folder skeleton, graph conventions, build tooling, tests, and portability rules.
   - Use `docs/playbook-patterns.md` when choosing graph patterns.
   - Create or repair the package folder with `manifest.json`, `playbook.ts`, schemas, prompts, deterministic scripts, fixtures, tests, `build.ts`, `BUILD.md`, `PLAYBOOK.md`, and optional `package.json` only when useful for package-local tests.
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
