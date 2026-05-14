# Optional Capability Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a global optional capability manager so Tessera can install allowlisted native capabilities on first use without requiring customer-managed system installs.

**Architecture:** Create a core manager that installs only allowlisted single-binary or archive assets into Tessera's app-managed data directory after SHA-256 verification. PDF rendering may use an optional managed `tessera-pdf-render` binary; PDF transforms are bundled TypeScript operations implemented with `pdf-lib` and do not use optional native binaries. Python support is scoped to skill helper execution: the manager may install the Python runner (`uv`), while skill package dependencies are installed into per-skill environments. Sidecar owns the app data install root and passes the manager into task execution.

**Tech Stack:** Bun, TypeScript, Node `crypto`/`fs`, existing PDF service/tool runtime, no new dependencies.

---

## File Structure

- Create `packages/core/src/optional-capabilities.ts`: allowlisted capability definitions, status checks, SHA-256 verification, single-binary install, binary path resolution.
- Create `packages/core/src/optional-capabilities.test.ts`: manager install/status/checksum tests with injected downloader.
- Modify `packages/core/src/pdf-service.ts`: accept a capability manager for `pdf_render`, prefer managed `tessera-pdf-render`, and install once on missing render binary.
- Modify `packages/core/src/pdf-service.test.ts`: prove render can install and retry a missing managed engine.
- Modify `packages/core/src/pdf-tools.ts`, `workspace-tools.ts`, and `pi-session.ts`: thread the manager through the tool stack.
- Modify `apps/sidecar/src/task-runner.ts` and `apps/sidecar/src/server.ts`: create and pass the app-data-backed manager.
- Modify exports/tests affected by constructor option changes.

## Task 1: Core Manager

- [x] Write failing tests in `packages/core/src/optional-capabilities.test.ts` for successful install and checksum rejection.
- [x] Implement `createOptionalCapabilityManager` in `packages/core/src/optional-capabilities.ts`.
- [x] Run `bun test packages/core/src/optional-capabilities.test.ts` and verify pass.

## Task 2: PDF Render First-Use Install

- [x] Write a failing `pdf-service.test.ts` case where `tessera-pdf-render` is missing from `PATH`, the manager installs it, and render retries using the managed path.
- [x] Add `capabilityManager` options to PDF capabilities and render paths.
- [x] Run `bun test packages/core/src/pdf-service.test.ts packages/core/src/pdf-tools.test.ts`.

## Current PDF Dependency Boundary

- `pdf_inspect`, `pdf_extract`, and `pdf_validate` use bundled TypeScript extraction via `unpdf`.
- `pdf_create` and `pdf_transform` use bundled TypeScript PDF generation/transforms via `pdf-lib`; no native transform dependency is required.
- `pdf_render` uses optional managed `tessera-pdf-render` when visual page output is requested.
- Skill-scoped Python helpers use `skill_run_python` and per-skill environments; Python packages are not global optional capabilities.

## Task 3: Runtime Wiring

- [x] Thread `capabilityManager` through workspace tools, Pi session, sidecar task runner, and sidecar startup.
- [x] Keep the no-manager behavior unchanged for tests and CLI use.
- [x] Run focused runtime tests for `pi-session`, `workspace-tools`, and `task-runner`.

## Task 4: Verification

- [x] Run `bun run check`.
- [x] Run `bun test`.
- [x] Run `git diff --check`.
