# Google Workspace CLI Capability — Archive Install Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Test connection work for Google Workspace without a bundled `gws` binary. The capability manager must auto-detect a missing `gws`, download the official `@googleworkspace/cli` GitHub release archive for the host platform, verify its SHA-256, extract the `gws` binary, and place it under the managed capability root before retrying.

**Architecture:** Extend `OptionalCapabilityManager` so a capability asset can declare an archive format (`tar.gz` or `zip`) and an internal entry path; the manager downloads the archive into a temp dir, hashes the archive bytes against the allowlist, unpacks via host `tar`/`unzip` (matching upstream `@googleworkspace/cli/install.js`), then moves the named binary into the capability directory. Hardcode a `google-workspace-cli` allowlist entry per supported triple pointing at the published `v0.22.5` release artifacts, with env vars retained as a runtime override for QA/staging mirrors. Teach `google_workspace_cli_path()` in the desktop Rust shell to call the sidecar `install` endpoint when the binary is missing — mirroring how `pdf-service.ts` already does first-use install — so Test connection succeeds end-to-end on a clean machine.

**Tech Stack:** Bun, TypeScript, Node `crypto`/`fs`/`child_process`, system `tar` + `unzip` (already required by upstream installer), Tauri v2/Rust, existing `OptionalCapabilityManager`, `@googleworkspace/cli@0.22.5` release artifacts on GitHub.

---

## File Structure

- Modify `packages/core/src/optional-capabilities.ts`:
  - Add `archive?: { kind: "tar.gz" | "zip"; entry: string }` to `OptionalCapabilityAsset`.
  - Implement archive download → sha-check → temp extract → install pipeline.
  - Export a built-in `BUILTIN_CAPABILITY_DEFINITIONS` allowlist that includes `google-workspace-cli` v0.22.5 for the 7 upstream triples.
  - Update `optionalCapabilityDefinitionsFromEnv` to merge builtin + env definitions, with env taking precedence per `id`.
- Modify `packages/core/src/optional-capabilities.test.ts`:
  - Cover archive install (tar.gz + zip) using a fixture-driven downloader and a fake extractor injection (`extract` option) to avoid host `tar`/`unzip` in unit tests.
  - Assert checksum mismatch rejects archive before extraction.
  - Assert builtin allowlist exposes `google-workspace-cli` and that env values override builtin URLs/SHAs.
- Modify `apps/sidecar/src/server.ts`:
  - Pass `definitions: optionalCapabilityDefinitionsFromEnv(process.env)` already covers builtin (no signature change needed). Confirm `/capabilities/.../binaries/.../install` returns the resolved binary path for archive-based capabilities.
- Modify `apps/sidecar/src/server.test.ts`:
  - Add an archive-asset round trip test through the install endpoint using injected extractor.
- Modify `apps/desktop/src-tauri/src/lib.rs`:
  - Change `google_workspace_cli_path()` so that, when neither the managed path nor a bundled binary is present, it calls the sidecar install endpoint (`managed_capability_binary_install`) and uses the returned path. PATH fallback remains last-resort.
- Modify `apps/desktop/src-tauri/src/lib.rs` tests (Rust unit tests at the bottom of the file):
  - Cover the new install-on-missing branch with a mocked sidecar handle (or extract a helper that is testable without the real sidecar).
- (No UI changes required — install consent UI already exists and remains optional; the auto-install path covers Test connection + every CLI-driven action.)

## Task 1: Manager Archive Support

- [x] Write failing tests in `packages/core/src/optional-capabilities.test.ts`:
  - `install()` with a `tar.gz` archive asset downloads, sha-checks the **archive bytes**, invokes the injected extractor with the temp archive path + temp output dir, then copies the declared `archive.entry` file to the managed binary path and `chmod 0o755` on POSIX.
  - Same flow for a `zip` archive asset.
  - Checksum mismatch on the archive throws and leaves the capability dir empty.
  - Progress events still fire for `downloading` / `verifying` / `installing` / `installed` with archive byte totals.
- [x] Extend `OptionalCapabilityAsset` and `createOptionalCapabilityManager` in `packages/core/src/optional-capabilities.ts`:
  - Add `archive` field, an optional `extract` injection on `OptionalCapabilityManagerOptions` (defaults to `tar`/`unzip` via `node:child_process`).
  - When `archive` is set, write the downloaded bytes to a temp file, hash them, extract into a sibling temp dir, copy `archive.entry` to the managed path, then clean up.
  - Reject if `archive.entry` resolves outside the temp extract dir (same path-escape guard as `binaryPath`).
- [x] Run `bun test packages/core/src/optional-capabilities.test.ts` and verify pass.

## Task 2: Built-in Allowlist

- [x] Write failing tests in `packages/core/src/optional-capabilities.test.ts`:
  - `optionalCapabilityDefinitionsFromEnv({})` returns a `google-workspace-cli` definition with all 7 published triples and version `0.22.5`.
  - Each platform/arch entry uses URL `https://github.com/googleworkspace/cli/releases/download/v0.22.5/google-workspace-cli-<triple>.<ext>` and the SHA below, with `archive` set correctly.
  - When `TESSERA_GWS_CLI_URL` is set in env, the env definition replaces the builtin entry for the current platform/arch.
- [x] Add a `BUILTIN_CAPABILITY_DEFINITIONS` constant in `packages/core/src/optional-capabilities.ts` with the following allowlist (verified 2026-05-14):

| Triple | Archive | SHA-256 |
| --- | --- | --- |
| `aarch64-apple-darwin` | `tar.gz` | `1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac` |
| `x86_64-apple-darwin` | `tar.gz` | `51f9bd731404d4bba26c36e2e30dd68c56dccd1f834c01252cb0b14d6a6544b2` |
| `aarch64-unknown-linux-gnu` | `tar.gz` | `94490295d9580e1e88574e715a0a162991747d12d62f8c7b8dcc8268b6c1cea0` |
| `aarch64-unknown-linux-musl` | `tar.gz` | `e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a` |
| `x86_64-unknown-linux-gnu` | `tar.gz` | `de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f` |
| `x86_64-unknown-linux-musl` | `tar.gz` | `4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920` |
| `x86_64-pc-windows-msvc` | `zip` | `407705d695dc83d48b1c5f50d71b5aa64095bf6f17d5b439b2e9a373bbe67ec2` |

  - URL pattern: `https://github.com/googleworkspace/cli/releases/download/v0.22.5/google-workspace-cli-<triple>.<ext>`.
  - `archive.entry` is `gws` on POSIX targets and `gws.exe` on the windows target (matches upstream `supportedPlatforms.binary`).
  - Map Node `platform`/`arch` to the right triple: `darwin/arm64 → aarch64-apple-darwin`, `darwin/x64 → x86_64-apple-darwin`, `linux/arm64 → aarch64-unknown-linux-gnu` (glibc default — musl variant remains available via env override), `linux/x64 → x86_64-unknown-linux-gnu`, `win32/x64 → x86_64-pc-windows-msvc`.
- [x] Update `optionalCapabilityDefinitionsFromEnv` to start from the builtin allowlist and overlay env-driven asset URLs/SHAs/versions per capability id, so QA mirrors can override without code changes.
- [x] Run `bun test packages/core/src/optional-capabilities.test.ts`.

## Task 3: Sidecar Install Endpoint Round Trip

- [x] Write failing tests in `apps/sidecar/src/server.test.ts`:
  - Hitting `POST /capabilities/google-workspace-cli/binaries/gws/install` with a stubbed downloader + extractor returns `installed: true` and a non-empty `path`.
  - The follow-up `GET .../gws` reports the same managed path.
- [x] Confirm `apps/sidecar/src/server.ts` already routes archive-based capabilities through the manager (it should — no new server logic should be needed, but adjust if it short-circuits on raw-binary assumptions).
- [x] Run `bun test apps/sidecar/src/server.test.ts`.

## Task 4: Desktop Auto-Install on Missing `gws`

- [x] Write failing Rust unit test(s) covering the new branch (extract a `resolve_google_workspace_cli_path` helper that takes a trait/closure for the sidecar lookup so the install branch is reachable from tests).
- [x] Modify `apps/desktop/src-tauri/src/lib.rs`:
  - In `google_workspace_cli_path`: if `managed_capability_binary_path` returns `None` and `bundled_gws_path` does not exist, call `managed_capability_binary_install(state, "google-workspace-cli", "gws").await` and use the returned path. Surface install errors via the standard `Result<_, String>` return so the UI banner shows the manager's message.
  - Keep the PATH fallback only for the case where the install endpoint returns no path (e.g., asset definition missing) — at that point we are confident the host has no managed/bundled gws and PATH is the last resort.
- [x] Verify Test connection on a clean machine triggers a one-time download in the background log and then succeeds (manual smoke; capture before/after in the task PR).
- [x] `cargo test -p tessera` for the new helper.

## Task 5: Verification

- [x] `bun run check`
- [x] `bun test`
- [x] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- [ ] Manual smoke: launch desktop dev with `~/Library/Application Support/dev.tessera.app/capabilities/` removed → click Settings ▸ Integrations ▸ Google Workspace ▸ Test connection → observe the manager download `gws` from the GitHub release and Test connection succeed (or, if Google sign-in has not been completed, return the actual `gws auth status` message rather than a missing-binary error).
- [x] `git diff --check`
