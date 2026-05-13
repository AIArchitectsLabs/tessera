# App Login Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a polished app-level Google login gate that redirects authenticated users into Tessera's existing app shell.

**Architecture:** `App.tsx` owns a small persisted auth session and renders either `LoginView` or the current shell. `LoginView` is presentation-only and calls an injected `onAuthenticate` callback, keeping the future Tauri OAuth implementation behind a narrow interface.

**Tech Stack:** React 18, TypeScript, Vite, Bun test, Testing Library, Tailwind CSS, lucide-react.

---

## File Structure

- Create `apps/desktop/ui/src/components/LoginView.tsx`: visual login flow and button states.
- Modify `apps/desktop/ui/src/App.tsx`: auth session persistence, login gate, logout clearing.
- Create `apps/desktop/ui/src/App.test.tsx`: red/green coverage for app gate and logout.

### Task 1: App Gate Tests

**Files:**
- Create: `apps/desktop/ui/src/App.test.tsx`
- Modify: `apps/desktop/ui/src/App.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/ui/src/App.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import App from "./App";

const invokeMock = mock(async (command: string) => {
  if (command === "task_list") return { tasks: [] };
  if (command === "inbox_list") return { messages: [] };
  return {};
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("App login flow", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockClear();
  });

  test("shows login before the app shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /welcome to tessera/i })).toBeTruthy();
    expect(screen.queryByTitle("Tasks")).toBeNull();
  });

  test("continues into the app shell after Google authentication", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => {
      expect(screen.getByTitle("Tasks")).toBeTruthy();
    });
    expect(localStorage.getItem("tessera_auth_session")).toContain(
      "876556347828-cdd8n59esdnt33l3ojegi5g2oa5irpcf.apps.googleusercontent.com"
    );
  });

  test("logout clears the session and returns to login", async () => {
    localStorage.setItem(
      "tessera_auth_session",
      JSON.stringify({
        provider: "google",
        clientId: "876556347828-cdd8n59esdnt33l3ojegi5g2oa5irpcf.apps.googleusercontent.com",
        authenticatedAt: "2026-05-11T00:00:00.000Z",
      })
    );

    render(<App />);

    fireEvent.click(screen.getByTitle("User menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: /logout/i }));

    expect(localStorage.getItem("tessera_auth_session")).toBeNull();
    expect(screen.getByRole("heading", { name: /welcome to tessera/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/desktop/ui/src/App.test.tsx`

Expected: FAIL because the login heading is not rendered and the session gate does not exist.

- [ ] **Step 3: Implement the app gate and login view**

Create `LoginView.tsx` and update `App.tsx` with a persisted `tessera_auth_session`, a Google client id constant, `handleAuthenticate`, and `handleLogout`. Render `LoginView` when no session exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/desktop/ui/src/App.test.tsx`

Expected: PASS with all three login-flow tests green.

### Task 2: Full Verification

**Files:**
- Verify: `apps/desktop/ui/src/components/LoginView.tsx`
- Verify: `apps/desktop/ui/src/App.tsx`

- [ ] **Step 1: Run UI typecheck**

Run: `bun run --filter @tessera/ui typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 2: Run project check**

Run: `bun run check`

Expected: PASS for Biome and workspace typechecks.

- [ ] **Step 3: Start the desktop UI dev server**

Run: `bun run --filter @tessera/ui dev`

Expected: Vite serves the UI and prints a local URL.

## Self-Review

The plan covers the spec requirements: unauthenticated login, successful app-shell transition, logout return, secret-free frontend handling, and no dashboard changes. There are no placeholder implementation steps; exact files and commands are listed. The session key and client id are consistent between the test and design.
