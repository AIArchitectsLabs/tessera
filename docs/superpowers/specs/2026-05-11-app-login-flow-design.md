# App Login Flow Design

## Goal

Add an app-level Tessera login gate that authenticates the user with Google before the existing desktop workspace UI is shown.

## Scope

This slice covers only the login flow, authenticated shell gate, and logout return path. The existing dashboard, tasks, playbooks, inbox, and settings views remain unchanged after authentication.

## User Experience

Tessera opens to a full-window login screen. The visual direction borrows the split composition from the reference image, but uses Tessera's existing warm paper, ink, sun, and leaf palette instead of a dark e-commerce style. The left side establishes the product with the Tessera brand, a concise work-focused promise, and a few trust/value points. The right side contains a focused sign-in panel with a Google sign-in button, secure-session messaging, and clear feedback while authentication is running.

After authentication succeeds, the app renders the current shell exactly as it does today. Choosing Logout from the rail menu clears the app auth state and returns to the login screen.

## Architecture

The frontend owns the view gate: unauthenticated users see `LoginView`; authenticated users see the existing application shell. Authentication state is represented by a small frontend session object and persisted locally so a successful session survives a refresh in dev. The UI does not hardcode the provided Google client secret.

The production-safe auth boundary remains Tauri/backend-side. A future hardening pass can replace the current frontend session shim with a Tauri command that performs a full Google OAuth exchange and stores credentials in OS keychain. This design keeps the UI contract narrow enough for that swap: `LoginView` receives an `onAuthenticate` callback and does not know how tokens are stored.

## Components

- `apps/desktop/ui/src/components/LoginView.tsx`: renders the login experience and calls `onAuthenticate`.
- `apps/desktop/ui/src/App.tsx`: owns `authSession`, gates the existing shell, and implements logout.
- `apps/desktop/ui/src/App.test.tsx`: verifies login screen display, successful transition into the app shell, and logout return.

## Data Flow

1. App boot reads `tessera_auth_session` from `localStorage`.
2. If no session exists, `LoginView` is displayed.
3. User clicks Continue with Google.
4. The authenticate handler validates the configured Google client id shape and creates a local Tessera session record.
5. App writes the session to `localStorage` and renders the existing dashboard shell.
6. Logout removes `tessera_auth_session` and returns to `LoginView`.

## Error Handling

The login button shows a busy state during authentication. If the handler rejects, `LoginView` shows a concise inline error and keeps the user on the login screen. The first implementation treats a missing or malformed Google client id as a configuration error.

## Security

The frontend must not store the Google client secret. It may reference the public Google OAuth client id, but secrets belong on the Tauri/backend side or in OS keychain. The local UI session is not a replacement for backend authorization; it is a desktop app-level gate for this slice.

## Testing

Add React tests for:

- unauthenticated app boot shows Tessera login instead of the app rail
- clicking Continue with Google reaches the existing app shell
- logout clears the session and returns to login

Run the UI test file, TypeScript check, and the project check command where feasible.
