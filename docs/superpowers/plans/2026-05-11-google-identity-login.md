# Google Identity Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change first-run login to request only basic Google identity so users select a Gmail account and enter the dashboard without Workspace consent during login.

**Architecture:** Reuse the existing Google OAuth client file and browser-opening helper, but add identity-only Tauri commands that call the bundled `gws auth login` command with `openid,email,profile` scopes. The React login flow will call these identity commands and keep dashboard session storage local to the UI.

**Tech Stack:** Tauri 2, Rust, Google Workspace CLI sidecar binary, React, Bun test, Testing Library.

---

### Task 1: Add Identity-Only Backend Commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add an identity auth args helper**

Add a helper next to `google_workspace_readonly_auth_args`:

```rust
fn google_identity_auth_args() -> Vec<&'static str> {
    vec!["auth", "login", "--scopes", "openid,email,profile"]
}
```

- [ ] **Step 2: Add identity status and connect commands**

Add `google_identity_connection_status` and `google_identity_connect` using `google_workspace_auth_status`, `start_google_workspace_login_command`, and `install_google_workspace_oauth_client_file`. Return `IntegrationConnectionTestResult` with `provider: None`, `ok: true` only when auth status is connected, and messages `"Google sign-in complete."` or `"Waiting for Google sign-in to finish."`.

- [ ] **Step 3: Register the commands**

Add both commands to the `tauri::generate_handler!` list.

- [ ] **Step 4: Add a focused Rust test**

Add a unit test asserting:

```rust
assert_eq!(
    google_identity_auth_args(),
    vec!["auth", "login", "--scopes", "openid,email,profile"]
);
```

Run: `cargo test google_identity_auth_uses_basic_profile_scopes --lib`

Expected: PASS.

### Task 2: Point React Login To Identity Commands

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx`
- Modify: `apps/desktop/ui/src/App.test.tsx`

- [ ] **Step 1: Update tests first**

Change login-flow mocks and expectations from `google_workspace_connect` / `google_workspace_connection_status` to `google_identity_connect` / `google_identity_connection_status`.

- [ ] **Step 2: Update implementation**

In `handleAuthenticate`, invoke `google_identity_connect`. In `pollGoogleAuthConnection`, invoke `google_identity_connection_status`. Keep the existing polling behavior and local `tessera_auth_session` save.

- [ ] **Step 3: Verify UI tests**

Run: `bun test apps\desktop\ui\src\App.test.tsx`

Expected: 4 pass, 0 fail.

### Task 3: Verify And Restart

**Files:**
- No new files.

- [ ] **Step 1: Run formatting**

Run: `cargo fmt`

Expected: no errors.

- [ ] **Step 2: Run focused Rust test**

Run: `cargo test google_identity_auth_uses_basic_profile_scopes --lib`

Expected: PASS.

- [ ] **Step 3: Restart dev app if needed**

Run: `bun run dev`

Expected: Vite starts on `http://localhost:5173/` and Tauri runs `target\debug\tessera.exe`.
