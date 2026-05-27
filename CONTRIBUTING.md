# Contributing to Tessera

Thanks for helping make Tessera better. This project is still moving toward a
first beta, so small, focused changes are easiest to review and ship.

## Before You Start

- Read [CLAUDE.md](./CLAUDE.md) for architecture, package boundaries, security
  defaults, and coding standards.
- Check [ROADMAP.md](./ROADMAP.md) to understand what is beta-critical and what
  is deliberately deferred.
- Open an issue before starting large features, architecture changes, security
  work, or public API changes.

## Local Setup

```bash
git clone https://github.com/AIArchitectsLabs/tessera.git
cd tessera
bun install
bun run dev
```

You will also need Rust stable and the platform build tools listed in
[README.md](./README.md).

## Development Workflow

- Keep pull requests scoped to one concern.
- Prefer existing patterns over new abstractions.
- Do not add dependencies unless the issue or pull request explains why they are
  needed.
- Keep `apps/desktop/ui` importing only from `packages/contracts`.
- Keep secrets out of config files, fixtures, logs, screenshots, and tests.

## Checks

Run the relevant focused tests while working, then run the broad checks before a
pull request:

```bash
bun run check
bun run test
```

For public documentation changes, also run:

```bash
bun run docs:check
```

For Tauri/Rust changes, run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Pull Requests

Every pull request should include:

- What changed.
- Why it changed.
- How it was tested.
- Any known gaps or follow-up work.

Security-sensitive changes should call out trust boundaries, credential handling,
filesystem access, network exposure, and approval behavior.

## Reporting Security Issues

Do not open public issues for vulnerabilities. Follow [SECURITY.md](./SECURITY.md)
for private reporting.
