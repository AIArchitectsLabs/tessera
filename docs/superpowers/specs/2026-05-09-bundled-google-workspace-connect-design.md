# Bundled Google Workspace Connect Design

## Goal

Ship Tessera Desktop with a pinned Google Workspace command-line connector and a first-class **Connect Google Workspace** flow so business users can enable Calendar, Gmail, Drive, Contacts, Docs, and Sheets without installing `gws`, `npm`, `node`, or `gcloud` themselves.

## Context

Tessera already routes Workspace reads through the local Tessera CLI. The CLI now supports:

- `gcal list`
- `gcal read`
- `mail list`
- `mail search`
- `mail read`
- `drive search`
- `drive read`
- `contacts lookup`

Those commands delegate to `@googleworkspace/cli` through `TESSERA_GWS_CLI_PATH` when present, otherwise `gws` on `PATH`. The current desktop bundle includes `tessera-sidecar` and `tessera-cli` as Tauri external binaries, but does not bundle `gws`.

The `@googleworkspace/cli` package reports `gws 0.22.5` and prints a disclaimer that it is not an officially supported Google product. Tessera should avoid in-app copy that calls it official. Use “bundled Google Workspace connector” or “bundled Google Workspace CLI.”

## Product Behavior

Settings > Integrations should show Google Workspace as one integration with three actions:

- **Connect Google Workspace**: starts the bundled `gws auth login` OAuth flow.
- **Test connection**: checks auth status and a read-only Workspace command.
- **Disconnect**: runs `gws auth logout` and marks the integration disconnected.

When the user clicks **Connect Google Workspace**, Tessera should:

1. Run the bundled `gws auth login` with Tessera’s app-scoped config directory.
2. Show a progress message that the browser sign-in flow is running.
3. When the process exits, run `gws auth status`.
4. If auth is valid, save the integration state as configured.
5. If auth fails, show the first useful stderr/stdout line from `gws`.

The connection flow is allowed to open the system browser through the `gws` auth flow. Tessera should not ask users to paste API keys for Google Workspace.

## OAuth Client Policy

Tessera will provide its own Google OAuth client configuration for the bundled Workspace connector.

Because desktop apps are public clients, Tessera must not treat the OAuth client secret as a confidential secret. If `gws` requires both `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`, those values may be bundled only as public client metadata. Access tokens and refresh tokens must remain in the `gws` config/keyring storage, scoped under Tessera’s app config directory.

The implementation must centralize the OAuth env construction so future scope or client changes happen in one place.

## Packaging Design

The desktop build should produce and bundle:

- `tessera-sidecar-${TARGET_TRIPLE}`
- `tessera-cli-${TARGET_TRIPLE}`
- `gws-${TARGET_TRIPLE}`

`apps/desktop/src-tauri/tauri.conf.json` should include `binaries/gws` in `bundle.externalBin`.

The build should pin the `@googleworkspace/cli` version in repo-owned package metadata. The first implementation can compile or wrap the npm package as an executable only if the resulting artifact works without network access, Node, npm, or Bun installed on the user’s machine. If a direct standalone compile is not reliable, the implementation should fail the build with a clear error rather than shipping a runtime `npx` dependency.

## Runtime Environment

Every desktop-spawned Tessera CLI process should receive:

- `TESSERA_GWS_CLI_PATH=<path to bundled gws-${TARGET_TRIPLE}>`
- `TESSERA_GWS_CONFIG_DIR=<app config dir>/google-workspace`

Every direct `gws` auth command should receive:

- `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<app config dir>/google-workspace`
- `GOOGLE_WORKSPACE_CLI_CLIENT_ID=<Tessera OAuth client id>`
- `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET=<Tessera public native-client secret, if required>`

The sidecar should also receive the same `TESSERA_GWS_CLI_PATH` and `TESSERA_GWS_CONFIG_DIR` so Playbook runs can use Workspace commands.

## Backend API Design

Add Tauri commands:

- `google_workspace_connect() -> IntegrationConnectionTestResult`
- `google_workspace_disconnect() -> IntegrationSettingsRead`

`google_workspace_connect` runs `gws auth login`, then `gws auth status`, then persists Google Workspace as connected by reusing the integration settings write path.

`google_workspace_disconnect` runs `gws auth logout`, then persists Google Workspace as disconnected.

The existing `integration_connection_test` command should test Google Workspace with `gws auth status` first. If status passes, it should run a read-only smoke command through `tessera-cli`, for example `gcal list --limit 1`, with the bundled `gws` env injected.

## Frontend Design

SettingsView should keep a single Google Workspace card. When Google Workspace is selected:

- Hide API key controls.
- Show **Connect Google Workspace** when not connected.
- Show **Disconnect** when connected.
- Keep **Test connection** always available.
- Use concise status messages:
  - Connecting: “Opening Google sign-in...”
  - Success: “Google Workspace connected.”
  - Failure: the backend message.
  - Disconnect success: “Google Workspace disconnected.”

## Testing Strategy

Tests should cover:

- Build script refuses to continue when it cannot produce a local `gws-${TARGET_TRIPLE}` executable.
- Tauri config includes `binaries/gws`.
- Rust helper resolves the bundled `gws` path and app-scoped config directory.
- `google_workspace_connect` invokes `auth login` then `auth status`, and marks Google Workspace connected.
- `google_workspace_disconnect` invokes `auth logout`, and marks Google Workspace disconnected.
- `integration_connection_test` uses auth status for Google Workspace instead of API-key credential checks.
- SettingsView renders Connect/Test/Disconnect without key controls.

Manual verification should include:

- `gws --version` from the bundled binary.
- `gws auth status` before and after connect.
- A read-only Workspace smoke command after connect.

## Non-Goals

- Do not add Gmail send, Drive write, Docs write, or Sheets write.
- Do not require users to install `gws`, `node`, `npm`, `bun`, or `gcloud`.
- Do not add separate Gmail, Drive, Docs, Sheets, or Contacts integrations.
- Do not call the bundled connector an officially supported Google product.

## Risks

- Google OAuth verification may be required before public distribution because Gmail and Drive scopes can be sensitive or restricted.
- Workspace admins may block Tessera’s OAuth client.
- `@googleworkspace/cli` may change command shapes; release builds need pinned version and compatibility checks.
- Packaging a Node-oriented npm CLI as a standalone desktop binary may require a wrapper or a separate packaging strategy.
