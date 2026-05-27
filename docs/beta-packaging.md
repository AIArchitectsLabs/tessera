# Beta Packaging Smoke

The first beta keeps large or credentialed dependencies out of the desktop
bundle by default. The app should start cleanly, then guide users through
optional setup only when a workflow needs the capability.

## Install-on-Demand Capabilities

- Google Workspace CLI is a managed optional capability. It is downloaded and
  verified from the pinned built-in release metadata when the user confirms the
  connector install in Settings.
- Google Workspace OAuth client metadata is not bundled by default. Users can
  save their own OAuth client in Settings before connecting Google Workspace.
- Browser automation runtime is a managed optional capability. Release builds
  can expose it by setting browser runtime release metadata at build time. Users
  confirm the runtime download in Settings before browser automation depends on
  it.

## Browser Runtime Release Metadata

Set these values when the beta build should offer browser runtime download:

- `TESSERA_BROWSER_RUNTIME_URL`
- `TESSERA_BROWSER_RUNTIME_SHA256`
- `TESSERA_BROWSER_RUNTIME_VERSION`
- `TESSERA_BROWSER_RUNTIME_SIZE_BYTES`
- `TESSERA_BROWSER_RUNTIME_ARCHIVE_KIND`
- `TESSERA_BROWSER_RUNTIME_ARCHIVE_ENTRY`
- `TESSERA_BROWSER_RUNTIME_ARCHIVE_ROOT`

`TESSERA_BROWSER_RUNTIME_ARCHIVE_ENTRY` must point to the Chromium executable
inside the archive. `TESSERA_BROWSER_RUNTIME_ARCHIVE_ROOT` should point to the
directory that must be preserved beside that executable, such as the extracted
Chromium bundle root.

`TESSERA_BUNDLE_PLAYWRIGHT=1` still packages a local Playwright browser cache for
internal smoke builds, but it is not the default beta story.
