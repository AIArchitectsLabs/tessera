# Tessera Roadmap

This roadmap is intentionally short. It describes the work needed to reach a
first public beta and the larger areas that remain intentionally deferred.

## First Beta Focus

- Public repository hygiene: contributor docs, security policy, issue templates,
  sanitized public documentation, and clear setup instructions.
- Packaging confidence: repeatable desktop builds on macOS, Windows, and Linux,
  plus a documented optional-capability story for Google Workspace and browser
  automation.
- Golden-path reliability: task chat, built-in playbook execution, human review,
  workspace write approval, and external playbook import, tracked through
  `docs/beta-dogfood-checklist.md`.
- Security hardening: sidecar transport checks, workspace filesystem boundaries,
  credential handling, and secret scans.
- Documentation polish: public playbook-authoring docs that are accurate,
  sanitized, and easy to follow.

## Beta Exit Criteria

- A new contributor can clone the repository, install dependencies, run checks,
  and launch the app from the README.
- Core checks pass in CI across lint, typecheck, tests, docs validation, and
  desktop builds.
- A beta user can run at least one built-in playbook from start to reviewed
  output without using internal development notes.
- Known limitations are documented instead of hidden.

## Deferred Work

- Code signing, update channels, and package-manager distribution.
- Enterprise SSO, organization administration, and centralized audit export.
- A public marketplace or registry for playbooks.
- Arbitrary workflow-supplied UI code.
- Production execution of generated workflow code before validation, sandboxing,
  signing, and rollback paths are in place.

## Contributing to the Roadmap

Open an issue for proposed roadmap changes. Include the user problem, expected
impact, security considerations, and how the work can be verified.
