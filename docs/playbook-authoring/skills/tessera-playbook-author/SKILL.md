---
name: tessera-playbook-author
description: Author external Tessera playbook packages through an interview-first workflow. Use when an agent needs to brainstorm a playbook's business workflow, data requirements, capabilities, schemas, review gates, final artifacts, package contract, validation loop, or SDK-helper candidates before generating or repairing playbook files. Use for new playbook authoring, existing playbook repair, validator-driven repair loops, and cross-agent authoring recipes for Claude Code, Codex, Claude Cowork, Pi Agent, or Tessera agents.
---

# Tessera Playbook Author

Use this portable skill to author or repair external Tessera playbook packages from any agent harness. Start with discovery and an authoring brief; generate package files only after the brief is coherent.

## Canonical Contract

Prefer the repo-owned contract when the Tessera repo is available:

- `docs/playbook-authoring/authoring-brief-template.md`
- `docs/playbook-authoring/package-contract.md`
- `docs/playbook-authoring/validation-loop.md`
- `docs/playbook-authoring/sdk-helper-candidate-log.md`

This skill is an ergonomic wrapper around those docs, not a separate standard. Harness-specific adapters may copy or symlink this directory into their own skill roots, but this docs copy is the central source.

## Workflow

1. Boundary check:
   - Confirm Tessera is the only runtime.
   - Confirm the external playbook package path.
   - Reject standalone runners, `bin` entrypoints, lockfiles, dependency fields, and local graph execution wrappers.

2. Business discovery:
   - Load `references/authoring-interview.md`.
   - Identify the business outcome, user, recurring decision, cadence, data sources, capabilities, review gates, and final artifacts.
   - Ask one focused question only when the answer cannot be inferred.

3. Authoring brief gate:
   - Use the canonical brief template when available.
   - Stop before generation if the brief is incoherent, material requirements are missing, or the package assumes a non-Tessera runtime.

4. Package generation or repair:
   - Load `references/package-contract.md`.
   - Keep domain schemas, prompts, scripts, fixtures, scoring, and final templates in the external playbook package.
   - Use package-relative refs and explicit schemas for agent outputs.

5. Validation loop:
   - Load `references/validation-loop.md`.
   - Run text and JSON validation.
   - Fix errors first, warnings second, then record evidence.

6. SDK helper notes:
   - Load `references/sdk-helper-candidates.md`.
   - Record helper candidates only when friction repeats across SEO/GEO, supply-chain, or a forward test.
   - Do not implement SDK helpers from this skill unless the user explicitly starts Phase 2B.

## Stop Conditions

Stop and ask or report a blocker when:

- The runtime boundary is unclear or violated.
- The package path is missing.
- The business outcome or final artifact audience is unknown.
- A live connector requires credentials or production access not granted by the user.
- Validator errors expose missing platform behavior rather than package authoring mistakes.
