# Bundled Google Workspace Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle a pinned Google Workspace connector with Tessera Desktop and add a first-class Connect/Test/Disconnect flow for Google Workspace.

**Architecture:** Treat `@googleworkspace/cli` as a pinned build-time dependency that installs a native `gws` binary, then copy that binary into Tauri `externalBin` beside `tessera-cli` and `tessera-sidecar`. Desktop Rust owns OAuth env construction, app-scoped `gws` config paths, and direct auth commands; Tessera CLI continues to read Workspace data through `TESSERA_GWS_CLI_PATH` and `TESSERA_GWS_CONFIG_DIR`.

**Tech Stack:** Tauri v2/Rust, Bun workspaces, `@googleworkspace/cli@0.22.5`, React Settings UI, Bun tests, Rust unit tests.

---

## File Structure

- Modify `package.json`
  - Pin `@googleworkspace/cli` as a dev dependency so install/build downloads the native `gws` binary.
- Modify `bun.lock`
  - Lock the exact package version.
- Modify `scripts/build-sidecar.ts`
  - Locate the installed native `gws` binary, verify `gws --version`, and copy it to `apps/desktop/src-tauri/binaries/gws-${triple}`.
- Modify `apps/desktop/src-tauri/tauri.conf.json`
  - Add `binaries/gws` to `bundle.externalBin`.
- Modify `apps/desktop/src-tauri/src/integration_settings.rs`
  - Persist a Google Workspace connected flag and expose it as `providers.googleCalendar.hasCredential`.
- Modify `apps/desktop/src-tauri/src/lib.rs`
  - Resolve bundled `gws`, apply OAuth/config env, expose `google_workspace_connect` and `google_workspace_disconnect`, and inject Workspace env into sidecar/workspace CLI commands.
- Modify `apps/desktop/ui/src/components/SettingsView.tsx`
  - Add Connect/Disconnect actions for Google Workspace while preserving Test connection.
- Modify `apps/desktop/ui/src/components/SettingsView.test.tsx`
  - Cover Connect/Test/Disconnect UI and invoke payloads.

---

## Task 1: Bundle Pinned `gws` Binary

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `scripts/build-sidecar.ts`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

- [ ] **Step 1: Add the pinned package**

Run:

```bash
bun add -d @googleworkspace/cli@0.22.5
```

Expected:
- `package.json` includes `"@googleworkspace/cli": "0.22.5"` or `"^0.22.5"` under `devDependencies`.
- `bun.lock` changes.
- Postinstall downloads `node_modules/@googleworkspace/cli/bin/gws`.

- [ ] **Step 2: Verify the installed binary shape**

Run:

```bash
node_modules/@googleworkspace/cli/bin/gws --version
file node_modules/@googleworkspace/cli/bin/gws
```

Expected:
- Version prints `gws 0.22.5`.
- `file` reports a native executable for the host platform, not a JavaScript wrapper.

- [ ] **Step 3: Write a build-script helper for `gws`**

In `scripts/build-sidecar.ts`, add helpers near the existing `capture` function:

```ts
function verifyExecutable(path: string, args: string[], expected: string): void {
  const proc = Bun.spawnSync([path, ...args], { stdout: "pipe", stderr: "pipe" });
  const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  if (proc.exitCode !== 0 || !output.includes(expected)) {
    throw new Error(`Expected ${path} ${args.join(" ")} to include ${expected}, got:\n${output}`);
  }
}

function requireFile(path: string): string {
  if (!Bun.file(path).size) {
    throw new Error(`Required file is missing or empty: ${path}`);
  }
  return path;
}
```

- [ ] **Step 4: Copy the installed `gws` binary into Tauri binaries**

In `scripts/build-sidecar.ts`, after copying `tessera-cli`, add:

```ts
const gwsSrc = requireFile(join(repoRoot, `node_modules/@googleworkspace/cli/bin/gws${ext}`));
verifyExecutable(gwsSrc, ["--version"], "gws 0.22.5");

const gwsDst = join(binDir, `gws-${triple}${ext}`);
copyFileSync(gwsSrc, gwsDst);
if (!isWindows) chmodSync(gwsDst, 0o755);
verifyExecutable(gwsDst, ["--version"], "gws 0.22.5");
console.log(`[build-sidecar] copied gws    → ${gwsDst}`);
```

- [ ] **Step 5: Add `gws` to Tauri external binaries**

In `apps/desktop/src-tauri/tauri.conf.json`, update:

```json
"externalBin": ["binaries/tessera-sidecar", "binaries/tessera-cli", "binaries/gws"]
```

- [ ] **Step 6: Verify build output**

Run:

```bash
bun run build:sidecar
apps/desktop/src-tauri/binaries/gws-$(rustc -vV | awk '/^host:/ {print $2}') --version
```

Expected:
- Build succeeds.
- The copied binary prints `gws 0.22.5`.

- [ ] **Step 7: Commit packaging changes**

```bash
git add package.json bun.lock scripts/build-sidecar.ts apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/binaries/gws-*
git commit -m "Bundle pinned Google Workspace connector"
```

---

## Task 2: Persist Google Workspace Connected State

**Files:**
- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`

- [ ] **Step 1: Add failing tests**

Add tests in the existing `#[cfg(test)] mod tests`:

```rust
#[test]
fn google_workspace_connected_state_round_trips() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(SETTINGS_FILE);

    let first = set_google_workspace_connected_at_path(&path, true).expect("connect");
    assert!(first.providers.google_calendar.has_credential);

    let settings = load_settings_file(&path).expect("load settings");
    assert!(settings.providers.google_calendar.connected);

    let second = set_google_workspace_connected_at_path(&path, false).expect("disconnect");
    assert!(!second.providers.google_calendar.has_credential);
}

#[test]
fn missing_google_workspace_connected_state_defaults_to_false() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(SETTINGS_FILE);
    fs::write(
        &path,
        r#"{
          "providers": {
            "braveSearch": { "provider": "brave-search" },
            "googleCalendar": { "provider": "google-calendar" }
          }
        }"#,
    )
    .expect("write settings");

    let redacted = redact(load_settings_file(&path).expect("load")).expect("redact");
    assert!(!redacted.providers.google_calendar.has_credential);
}
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
cargo test integration_settings::tests::google_workspace_connected_state_round_trips integration_settings::tests::missing_google_workspace_connected_state_defaults_to_false
```

Expected: compile/test failure because `connected` and `set_google_workspace_connected_at_path` do not exist.

- [ ] **Step 3: Add the connected flag**

Modify `ProviderConfig`:

```rust
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: IntegrationProvider,
    #[serde(default)]
    pub connected: bool,
}
```

Update default provider configs:

```rust
fn default_brave_search_provider_config() -> ProviderConfig {
    ProviderConfig {
        provider: IntegrationProvider::BraveSearch,
        connected: false,
    }
}

fn default_google_calendar_provider_config() -> ProviderConfig {
    ProviderConfig {
        provider: IntegrationProvider::GoogleCalendar,
        connected: false,
    }
}
```

- [ ] **Step 4: Expose the connected state**

In `redact_with_settings`, change the Google Workspace redaction to:

```rust
google_calendar: ProviderSettings {
    provider: IntegrationProvider::GoogleCalendar,
    has_credential: settings.providers.google_calendar.connected,
},
```

- [ ] **Step 5: Add public setters**

Add below `delete`:

```rust
fn set_google_workspace_connected_at_path(
    path: &Path,
    connected: bool,
) -> Result<IntegrationSettingsRead> {
    let mut settings = load_settings_file(path)?;
    settings.providers.google_calendar.connected = connected;
    save_settings_file(path, &settings)?;
    redact_with_settings(settings)
}

pub fn set_google_workspace_connected(
    app: &AppHandle,
    connected: bool,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    set_google_workspace_connected_at_path(&path, connected)
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
cargo test integration_settings
```

Expected: all integration settings tests pass.

- [ ] **Step 7: Commit state changes**

```bash
git add apps/desktop/src-tauri/src/integration_settings.rs
git commit -m "Persist Google Workspace connection state"
```

---

## Task 3: Add Desktop `gws` Runtime Helpers and Env Injection

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add path/env unit tests**

In `#[cfg(test)] mod tests`, import the helper functions and add:

```rust
#[test]
fn google_workspace_config_dir_is_app_scoped() {
    let app_config = std::path::PathBuf::from("/tmp/tessera-config");
    assert_eq!(
        google_workspace_config_dir(&app_config),
        std::path::PathBuf::from("/tmp/tessera-config/google-workspace")
    );
}

#[test]
fn first_useful_line_prefers_stderr_then_stdout() {
    let result = SpawnResult {
        stdout: "\nstdout detail\n".to_string(),
        stderr: "\nstderr detail\n".to_string(),
        exit_code: 2,
        signal: None,
        duration_ms: 1,
    };
    assert_eq!(first_useful_process_line(&result), "stderr detail");

    let result = SpawnResult {
        stdout: "\nstdout detail\n".to_string(),
        stderr: "\n".to_string(),
        exit_code: 2,
        signal: None,
        duration_ms: 1,
    };
    assert_eq!(first_useful_process_line(&result), "stdout detail");
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cargo test google_workspace_config_dir_is_app_scoped first_useful_line_prefers_stderr_then_stdout
```

Expected: compile failure for missing helpers.

- [ ] **Step 3: Add constants and helpers**

Near the existing `TARGET_TRIPLE`/binary helper area in `apps/desktop/src-tauri/src/lib.rs`, add:

```rust
const GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: &str =
    option_env!("TESSERA_GOOGLE_WORKSPACE_CLIENT_ID").unwrap_or("");
const GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: &str =
    option_env!("TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET").unwrap_or("");

fn google_workspace_config_dir(app_config_dir: &std::path::Path) -> std::path::PathBuf {
    app_config_dir.join("google-workspace")
}

fn google_workspace_oauth_configured() -> bool {
    !GOOGLE_WORKSPACE_OAUTH_CLIENT_ID.trim().is_empty()
}

fn apply_google_workspace_env(
    command: &mut std::process::Command,
    gws_path: &std::path::Path,
    config_dir: &std::path::Path,
) {
    command.env("TESSERA_GWS_CLI_PATH", gws_path.to_string_lossy().as_ref());
    command.env("TESSERA_GWS_CONFIG_DIR", config_dir.to_string_lossy().as_ref());
    command.env(
        "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
        config_dir.to_string_lossy().as_ref(),
    );
    if !GOOGLE_WORKSPACE_OAUTH_CLIENT_ID.trim().is_empty() {
        command.env(
            "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
            GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
        );
    }
    if !GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET.trim().is_empty() {
        command.env(
            "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
            GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
        );
    }
}

fn first_useful_process_line(result: &SpawnResult) -> String {
    result
        .stderr
        .lines()
        .chain(result.stdout.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Command failed")
        .to_string()
}
```

- [ ] **Step 4: Resolve bundled `gws` paths**

Add:

```rust
fn bundled_gws_path(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(binaries_dir(app)?.join(format!("gws-{TARGET_TRIPLE}{EXE_EXT}")))
}
```

- [ ] **Step 5: Inject env into sidecar startup**

In `setup`, after `cli_path`, compute:

```rust
let gws_path = bin_dir.join(format!("gws-{TARGET_TRIPLE}{EXE_EXT}"));
let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
fs::create_dir_all(&google_workspace_config_dir)
    .context("Could not create Google Workspace config dir")?;
```

Then add to the sidecar command chain:

```rust
.env("TESSERA_GWS_CLI_PATH", gws_path.to_string_lossy().as_ref())
.env(
    "TESSERA_GWS_CONFIG_DIR",
    google_workspace_config_dir.to_string_lossy().as_ref(),
)
```

- [ ] **Step 6: Inject env into `run_workspace_cli_command`**

Inside `run_workspace_cli_command`, compute:

```rust
let gws_path = bundled_gws_path(app).map_err(|error| error.to_string())?;
let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;
apply_google_workspace_env(&mut command, &gws_path, &google_workspace_config_dir);
```

Place this before `command.output()`.

- [ ] **Step 7: Add a direct `gws` runner**

Add:

```rust
async fn run_google_workspace_cli_command(
    app: &AppHandle,
    args: &[&str],
) -> Result<SpawnResult, String> {
    let gws_path = bundled_gws_path(app).map_err(|error| error.to_string())?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;

    let start = std::time::Instant::now();
    let mut command = std::process::Command::new(gws_path.clone());
    command.args(args);
    apply_google_workspace_env(&mut command, &gws_path, &google_workspace_config_dir);
    let output = command.output().map_err(|error| error.to_string())?;

    Ok(SpawnResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        signal: None,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
```

- [ ] **Step 8: Run Rust tests**

Run:

```bash
cargo test google_workspace_config_dir_is_app_scoped first_useful_line_prefers_stderr_then_stdout
```

Expected: pass.

- [ ] **Step 9: Commit runtime helper changes**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "Wire bundled Google Workspace runtime env"
```

---

## Task 4: Add Connect and Disconnect Backend Commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`

- [ ] **Step 1: Add connection result helper tests**

In `apps/desktop/src-tauri/src/lib.rs` tests, add:

```rust
#[test]
fn google_workspace_auth_message_uses_useful_process_line() {
    let result = SpawnResult {
        stdout: "Open browser to continue\n".to_string(),
        stderr: "".to_string(),
        exit_code: 0,
        signal: None,
        duration_ms: 10,
    };
    assert_eq!(first_useful_process_line(&result), "Open browser to continue");
}
```

- [ ] **Step 2: Add a helper for status checks**

Add:

```rust
async fn google_workspace_auth_status(app: &AppHandle) -> Result<SpawnResult, String> {
    run_google_workspace_cli_command(app, &["auth", "status"]).await
}
```

- [ ] **Step 3: Update Google Workspace connection test**

In `integration_connection_test`, replace the `GoogleCalendar` branch from:

```rust
integration_settings::IntegrationProvider::GoogleCalendar => {
    (vec!["gcal", "list"], None)
}
```

to:

```rust
integration_settings::IntegrationProvider::GoogleCalendar => {
    let status = google_workspace_auth_status(&app).await?;
    if status.exit_code != 0 {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: first_useful_process_line(&status),
            provider: Some(provider),
            search_provider: None,
        });
    }
    (vec!["gcal", "list", "--limit", "1"], None)
}
```

- [ ] **Step 4: Add `google_workspace_connect`**

Add the Tauri command:

```rust
#[tauri::command]
async fn google_workspace_connect(
    app: AppHandle,
) -> Result<integration_settings::IntegrationConnectionTestResult, String> {
    if !google_workspace_oauth_configured() {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: "Google Workspace OAuth client is not configured for this build.".to_string(),
            provider: Some(integration_settings::IntegrationProvider::GoogleCalendar),
            search_provider: None,
        });
    }

    let login = run_google_workspace_cli_command(&app, &["auth", "login"]).await?;
    if login.exit_code != 0 {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: first_useful_process_line(&login),
            provider: Some(integration_settings::IntegrationProvider::GoogleCalendar),
            search_provider: None,
        });
    }

    let status = google_workspace_auth_status(&app).await?;
    let ok = status.exit_code == 0;
    if ok {
        integration_settings::set_google_workspace_connected(&app, true)
            .map_err(|error| error.to_string())?;
    }

    Ok(integration_settings::IntegrationConnectionTestResult {
        ok,
        message: if ok {
            "Google Workspace connected.".to_string()
        } else {
            first_useful_process_line(&status)
        },
        provider: Some(integration_settings::IntegrationProvider::GoogleCalendar),
        search_provider: None,
    })
}
```

- [ ] **Step 5: Add `google_workspace_disconnect`**

Add:

```rust
#[tauri::command]
async fn google_workspace_disconnect(
    app: AppHandle,
) -> Result<integration_settings::IntegrationSettingsRead, String> {
    let logout = run_google_workspace_cli_command(&app, &["auth", "logout"]).await?;
    if logout.exit_code != 0 {
        return Err(first_useful_process_line(&logout));
    }
    integration_settings::set_google_workspace_connected(&app, false)
        .map_err(|error| error.to_string())
}
```

- [ ] **Step 6: Register commands**

In the `invoke_handler`, add:

```rust
google_workspace_connect,
google_workspace_disconnect,
```

- [ ] **Step 7: Run Rust tests**

Run:

```bash
cargo test integration_settings google_workspace_auth_message_uses_useful_process_line
```

Expected: pass.

- [ ] **Step 8: Commit backend commands**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/integration_settings.rs
git commit -m "Add Google Workspace auth commands"
```

---

## Task 5: Add Settings Connect/Disconnect UI

**Files:**
- Modify: `apps/desktop/ui/src/components/SettingsView.tsx`
- Modify: `apps/desktop/ui/src/components/SettingsView.test.tsx`

- [ ] **Step 1: Add failing UI tests**

In `SettingsView.test.tsx`, add to `describe("SettingsView workspace integration flow", ...)`:

```tsx
test("connecting Google Workspace uses the dedicated auth command", async () => {
  const view = await renderIntegrationsView();
  const section = workspaceIntegrationSection(view);
  if (!section) throw new Error("Missing workspace integration section");

  fireEvent.click(within(section).getByRole("button", { name: "Connect Google Workspace" }));

  await waitFor(() => {
    expect(invokeCalls.some((call) => call.command === "google_workspace_connect")).toBe(true);
  });
});

test("disconnecting Google Workspace uses the dedicated logout command", async () => {
  integrationSettings = {
    ...integrationSettings,
    providers: {
      ...integrationSettings.providers,
      googleCalendar: {
        ...integrationSettings.providers.googleCalendar,
        hasCredential: true,
      },
    },
  };
  const view = await renderIntegrationsView();
  const section = workspaceIntegrationSection(view);
  if (!section) throw new Error("Missing workspace integration section");

  fireEvent.click(within(section).getByRole("button", { name: "Disconnect" }));

  await waitFor(() => {
    expect(invokeCalls.some((call) => call.command === "google_workspace_disconnect")).toBe(true);
  });
});
```

Update the mock invoke switch to return:

```ts
case "google_workspace_connect":
  integrationSettings = {
    ...integrationSettings,
    providers: {
      ...integrationSettings.providers,
      googleCalendar: {
        ...integrationSettings.providers.googleCalendar,
        hasCredential: true,
      },
    },
  };
  return { ok: true, message: "Google Workspace connected.", provider: "google-calendar" };
case "google_workspace_disconnect":
  integrationSettings = {
    ...integrationSettings,
    providers: {
      ...integrationSettings.providers,
      googleCalendar: {
        ...integrationSettings.providers.googleCalendar,
        hasCredential: false,
      },
    },
  };
  return integrationSettings;
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test apps/desktop/ui/src/components/SettingsView.test.tsx
```

Expected: fail because the buttons/commands do not exist.

- [ ] **Step 3: Extend active integration action state**

In `SettingsView.tsx`, update:

```ts
const [activeIntegrationAction, setActiveIntegrationAction] = useState<
  "connect" | "disconnect" | "remove" | "save" | "test" | null
>(null);
```

- [ ] **Step 4: Add connect handler**

Add near the other integration handlers:

```ts
async function connectGoogleWorkspace() {
  if (integrationBusy) return;
  const requestId = ++integrationRequestIdRef.current;
  setActiveIntegrationAction("connect");
  setIntegrationStatus({ message: "Opening Google sign-in...", tone: "info" });
  try {
    const result = await invokeWithTimeout<ModelConnectionTestResult>(
      "google_workspace_connect",
      undefined,
      120_000
    );
    if (!mountedRef.current || integrationRequestIdRef.current !== requestId) return;
    setIntegrationStatus({
      message: result.message,
      tone: result.ok ? "success" : "error",
    });
    if (result.ok) {
      const next = await invokeWithTimeout<IntegrationSettingsRead>("integration_settings_get");
      if (mountedRef.current && integrationRequestIdRef.current === requestId) {
        hydrateFromIntegrations(next);
      }
    }
  } catch (error) {
    if (mountedRef.current && integrationRequestIdRef.current === requestId) {
      setIntegrationStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  } finally {
    if (mountedRef.current && integrationRequestIdRef.current === requestId) {
      setActiveIntegrationAction(null);
    }
  }
}
```

- [ ] **Step 5: Add disconnect handler**

Add:

```ts
async function disconnectGoogleWorkspace() {
  if (integrationBusy) return;
  const requestId = ++integrationRequestIdRef.current;
  setActiveIntegrationAction("disconnect");
  setIntegrationStatus(null);
  try {
    const next = await invokeWithTimeout<IntegrationSettingsRead>("google_workspace_disconnect");
    if (!mountedRef.current || integrationRequestIdRef.current !== requestId) return;
    hydrateFromIntegrations(next);
    setIntegrationStatus({ message: "Google Workspace disconnected.", tone: "success" });
  } catch (error) {
    if (mountedRef.current && integrationRequestIdRef.current === requestId) {
      setIntegrationStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    }
  } finally {
    if (mountedRef.current && integrationRequestIdRef.current === requestId) {
      setActiveIntegrationAction(null);
    }
  }
}
```

- [ ] **Step 6: Render Google Workspace buttons**

In the Google Workspace card action row, before the `Test connection` button, render:

```tsx
{!integrationAllowsCredentials && !hasIntegrationCredential && (
  <button
    className="btn-primary"
    type="button"
    disabled={integrationBusy}
    onClick={connectGoogleWorkspace}
  >
    Connect Google Workspace
  </button>
)}
{!integrationAllowsCredentials && hasIntegrationCredential && (
  <button
    className="btn-secondary"
    type="button"
    disabled={integrationBusy}
    onClick={disconnectGoogleWorkspace}
  >
    Disconnect
  </button>
)}
```

Keep the existing `Test connection` button.

- [ ] **Step 7: Run UI tests**

Run:

```bash
bun test apps/desktop/ui/src/components/SettingsView.test.tsx
bun run --filter './apps/desktop/ui' typecheck
```

Expected: pass.

- [ ] **Step 8: Commit UI changes**

```bash
git add apps/desktop/ui/src/components/SettingsView.tsx apps/desktop/ui/src/components/SettingsView.test.tsx
git commit -m "Add Google Workspace connect controls"
```

---

## Task 6: End-to-End Verification

**Files:**
- Modify only if verification reveals a mismatch.

- [ ] **Step 1: Build bundled binaries**

Run:

```bash
bun run build:sidecar
```

Expected:
- `tessera-sidecar-${TARGET_TRIPLE}` exists.
- `tessera-cli-${TARGET_TRIPLE}` exists.
- `gws-${TARGET_TRIPLE}` exists.

- [ ] **Step 2: Verify bundled `gws`**

Run:

```bash
apps/desktop/src-tauri/binaries/gws-$(rustc -vV | awk '/^host:/ {print $2}') --version
apps/desktop/src-tauri/binaries/gws-$(rustc -vV | awk '/^host:/ {print $2}') auth --help
```

Expected:
- Version is `gws 0.22.5`.
- Auth help lists `login`, `status`, and `logout`.

- [ ] **Step 3: Run checks**

Run:

```bash
bun test apps/desktop/ui/src/components/SettingsView.test.tsx
bun test apps/cli/src/shell.test.ts packages/core/src/shell-runtime.test.ts packages/contracts/src/integration-settings.test.ts
bun run check
cargo test integration_settings google_workspace
```

Expected: all pass.

- [ ] **Step 4: Manual auth smoke test**

If `TESSERA_GOOGLE_WORKSPACE_CLIENT_ID` is available for the build, run the desktop app and verify:

1. Settings > Integrations > Google Workspace shows **Connect Google Workspace**.
2. Clicking it opens Google sign-in.
3. Returning to Tessera shows “Google Workspace connected.”
4. **Test connection** succeeds.
5. A read-only command such as `gcal list --limit 1` works through `tessera-cli`.

- [ ] **Step 5: Commit verification fixes if needed**

If files changed during verification:

```bash
git add <changed-files>
git commit -m "Fix bundled Workspace connector verification"
```

If no files changed, do not create a commit.

---

## Self-Review

- Spec coverage: packaging, OAuth env, connect/test/disconnect backend, Settings UI, and verification are covered by Tasks 1-6.
- Placeholder scan: no task uses placeholder implementation language; OAuth client values are intentionally compile-time release inputs via `TESSERA_GOOGLE_WORKSPACE_CLIENT_ID` and optional `TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET`.
- Type consistency: existing `IntegrationConnectionTestResult`, `IntegrationSettingsRead`, `IntegrationProvider::GoogleCalendar`, `hasCredential`, and Tauri invoke command names are used consistently.
- Scope check: write/send/edit Workspace actions remain out of scope.
