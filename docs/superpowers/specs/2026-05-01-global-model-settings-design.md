# Global Model Settings Design

## Context

Tessera needs an app-level Settings entry point for configuring the model provider used by agent tasks. The current desktop UI has a left rail with workspace modes and a standalone Settings icon. Provider configuration already exists in the contracts and core packages, but credentials are currently resolved from environment variables.

This design adds a user/account menu at the bottom of the rail, moves Settings behind that menu, and introduces global model settings with secure credential storage.

## Goals

- Provide a bottom rail user icon that opens a popup menu.
- Include `Settings` and `Logout` in the popup menu.
- Keep `Logout` visible but no-op until the login/logout feature is designed.
- Add an app-level Settings surface that can grow beyond model settings.
- Add a `Model` settings section for global provider configuration.
- Store credentials securely in the OS keychain.
- Never return stored credential values to React.

## Non-Goals

- Real login/logout behavior.
- Per-workspace model settings.
- Account identity or profile management.
- Provider model catalog fetching.
- Billing, usage, or quota display.
- Plugin-specific model settings.
- Syncing settings across machines.

## Navigation

The rail should keep workspace modes at the top or middle and reserve the bottom for identity/account controls.

The existing standalone Settings rail button should be removed or demoted. Settings should be reached through the user menu rather than treated as another workspace mode.

Rail behavior:

- Show a circular user icon/avatar button pinned to the bottom of the rail.
- Clicking it opens a small popup menu above or to the right of the icon.
- The menu contains `Settings` and `Logout`.
- `Settings` opens the app-level Settings surface.
- `Logout` is present but no-op in this implementation.

The no-op Logout item should not clear workspace state, model settings, credentials, or task history.

## Settings Surface

Settings is an app-level surface, not a workspace-specific sidebar mode. It should have a left settings navigation area so future settings sections can be added without changing the rail menu.

Initial sections:

- `Model`

Possible future sections:

- General
- Workspace defaults
- Account
- Privacy
- Plugins

The first implementation can use either a modal or a full main-pane settings view, as long as it is clearly app-level and does not imply settings belong to the selected workspace.

## Model Settings

Model settings are global for the whole desktop app and apply to every workspace.

The UI should expose the existing provider set:

- OpenAI
- Anthropic
- OpenRouter
- Local OpenAI-compatible

OpenAI should be the default provider.

Fields:

- `Provider`: selectable cards or compact select input.
- `Model`: free-text input initially, with provider-specific placeholders.
- `API key`: password-style input for cloud providers.
- `Base URL`: visible for the local provider.
- `Save`: stores non-secret preferences and any newly entered secret.
- `Test connection`: validates the current form values.
- `Remove key`: explicitly deletes the stored credential for the selected provider.

Credential display rules:

- Stored keys are never returned to the frontend.
- Reads return only `hasCredential: true | false`.
- When a key exists, the API key field shows placeholder copy such as `Saved key present`.
- Entering a new key replaces the stored key on save.
- Clearing the visible key field does not delete the existing key.
- Only `Remove key` deletes a stored credential.

## Secure Storage

Secrets should live only in the OS keychain through the Tauri/Rust layer. Non-secret settings can live in app config.

Secret examples:

- OpenAI API key
- Anthropic API key
- OpenRouter API key
- Optional local provider API key, if configured later

Non-secret examples:

- Selected provider
- Selected model
- Local base URL
- Whether a provider has a credential

Rust should store provider credentials under stable service/account names, for example:

- Service: `Tessera`
- Account: `model.openai`
- Account: `model.anthropic`
- Account: `model.openrouter`
- Account: `model.local`

Credentials must not be written to:

- workspace files
- task history
- app logs
- sidecar config files
- localStorage
- plaintext app config

## Command Surface

React should interact with model settings through Tauri commands.

Suggested commands:

- `model_settings_get`
- `model_settings_save`
- `model_credential_delete`
- `model_connection_test`

`model_settings_get` returns redacted settings only.

`model_settings_save` validates non-secret settings and stores an API key only when the request includes a non-empty replacement key.

`model_credential_delete` deletes the key for one provider only.

`model_connection_test` validates the current form state. It can use an unsaved key from the request or the stored key for the selected provider.

## Agent Runtime Flow

When an agent task runs from the desktop app, the runtime should resolve the selected global provider settings and credential through an in-memory path only.

Keychain credentials should take precedence over environment-variable credentials for desktop app runs. Existing environment-variable support can remain as a development or CLI fallback.

If a cloud provider is selected and no credential exists, agent execution should fail with a clear setup-required error that points the user to Settings > Model.

Local OpenAI-compatible providers may run without an API key when their configuration does not require one.

## Error Handling

Settings should distinguish:

- No credential saved.
- Invalid credential.
- Network or provider endpoint failure.
- Unsupported provider/model combination.
- Keychain unavailable or permission denied.

Credential errors must not include the credential value or enough detail to reconstruct it.

Connection testing should report a concise result in the Settings UI without changing saved settings unless the user explicitly saves.

## Testing

Unit and integration coverage should verify:

- Redacted reads never expose API keys.
- Saving a provider without a new key preserves an existing key.
- Saving with a new key replaces the existing key.
- Removing a key deletes only the selected provider credential.
- Switching providers preserves other providers' saved keys.
- The frontend treats `Logout` as no-op.
- Agent execution reports a setup-required error when a cloud provider has no credential.
- Local provider configuration can be saved without an API key.

Manual QA should verify:

- User icon stays pinned to the bottom of the rail.
- Popup menu opens and closes predictably.
- Settings opens from the popup menu.
- Model settings remain global when switching workspaces.
- API keys are not visible after save and reload.

## Implementation Note

There are no blocking product decisions for the first implementation. The implementation plan should choose the exact storage crate or Tauri plugin after checking current Tauri 2 compatibility and project dependency constraints.
