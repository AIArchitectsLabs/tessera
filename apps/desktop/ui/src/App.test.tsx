/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { JSDOM } from "jsdom";
import React from "react";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });

  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  globals.window = dom.window as never;
  globals.document = dom.window.document as never;
  globals.localStorage = dom.window.localStorage as never;
  globals.navigator = dom.window.navigator as never;
  globals.Node = dom.window.Node as never;
  globals.Element = dom.window.Element as never;
  globals.HTMLElement = dom.window.HTMLElement as never;
  globals.HTMLButtonElement = dom.window.HTMLButtonElement as never;
  globals.SVGElement = dom.window.SVGElement as never;
  globals.Text = dom.window.Text as never;
  globals.Event = dom.window.Event as never;
  globals.MouseEvent = dom.window.MouseEvent as never;
  globals.PointerEvent = dom.window.PointerEvent as never;
  globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window) as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
}

installDom();

const invokeMock = mock(async (command: string) => {
  if (command === "google_identity_connect") {
    return {
      ok: true,
      message: "Google sign-in complete.",
      provider: null,
    };
  }
  if (command === "google_identity_connection_status") {
    return {
      ok: true,
      message: "Google sign-in complete.",
      provider: null,
    };
  }
  if (command === "task_list") return { tasks: [] };
  if (command === "inbox_list") return { messages: [] };
  if (command === "agent_profile_list") return { profiles: [] };
  if (command === "skill_list") return { skills: [] };
  return {};
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import App from "./App";

describe("App login flow", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows login before the app shell", () => {
    const view = render(<App />);

    expect(view.getByRole("heading", { name: /welcome to tessera/i })).toBeTruthy();
    expect(view.queryByTitle("Tasks")).toBeNull();
  });

  test("continues into the app shell after Google authentication", async () => {
    const view = render(<App />);

    fireEvent.click(view.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => {
      expect(view.getByTitle("Tasks")).toBeTruthy();
    });
    expect(invokeMock.mock.calls.some((call) => call[0] === "google_identity_connect")).toBe(true);
    expect(localStorage.getItem("tessera_auth_session")).toContain(
      "876556347828-cdd8n59esdnt33l3ojegi5g2oa5irpcf.apps.googleusercontent.com"
    );
  });

  test("waits for browser consent to finish before entering the app shell", async () => {
    invokeMock.mockImplementationOnce(async (command: string) => {
      if (command === "google_identity_connect") {
        return {
          ok: false,
          message: "Google sign-in opened in your browser. Complete it there.",
          provider: null,
        };
      }
      return {};
    });
    const view = render(<App />);

    fireEvent.click(view.getByRole("button", { name: /continue with google/i }));

    await waitFor(
      () => {
        expect(
          invokeMock.mock.calls.some((call) => call[0] === "google_identity_connection_status")
        ).toBe(true);
      },
      { timeout: 3_000 }
    );
    await waitFor(() => {
      expect(view.getByTitle("Tasks")).toBeTruthy();
    });
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

    const view = render(<App />);

    await waitFor(() => {
      expect(view.getByTitle("User menu")).toBeTruthy();
    });
    fireEvent.click(view.getByTitle("User menu"));
    fireEvent.click(view.getByRole("menuitem", { name: /logout/i }));

    expect(localStorage.getItem("tessera_auth_session")).toBeNull();
    expect(view.getByRole("heading", { name: /welcome to tessera/i })).toBeTruthy();
  });
});
