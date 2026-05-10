# Google Workspace OAuth Client Settings

Tessera should not ask users to run `gcloud` or manually place a `client_secret.json` file before connecting Google Workspace. Settings will support developer/admin configuration of a Google Workspace Desktop OAuth client, then reuse that client for the existing Google sign-in flow.

## Design

The Integrations settings page adds a Google Workspace OAuth client section with Client ID and Client Secret inputs, plus Save and Remove controls. The inputs are for OAuth app metadata, not Workspace user credentials. Saved values are redacted after save.

The desktop backend exposes commands to read OAuth client status, save a client, and delete a saved client. Saving generates the `installed` JSON shape expected by `@googleworkspace/cli` and stores it as `client_secret.json` in Tessera's scoped Google Workspace config directory. On Unix, the file is written with user-only permissions. Reads only return whether a client exists and where it came from: build env, saved config file, bundled file, or missing.

The existing Google Workspace connect/test paths continue to use `gws`. Before launching `gws`, Tessera ensures a usable OAuth client exists. Build-time env values remain supported for packaged builds, while the UI path gives local/dev builds a first-class setup path.

## Error Handling

Empty client ID or secret is rejected before writing. Missing OAuth configuration is shown as actionable settings copy instead of raw `gws` auth output.

## Testing

Rust tests cover JSON generation, scoped file path behavior, and status copy. UI tests cover saving the OAuth client and verify that the secret is not echoed back after saving.
