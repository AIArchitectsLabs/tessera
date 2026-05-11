/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { JSDOM } from "jsdom";
import React from "react";
import { PlaybookRefreshButton } from "./PlaybookRefreshButton";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });

  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  globals.window = dom.window as never;
  globals.document = dom.window.document as never;
  globals.navigator = dom.window.navigator as never;
  globals.Node = dom.window.Node as never;
  globals.Element = dom.window.Element as never;
  globals.HTMLElement = dom.window.HTMLElement as never;
  globals.HTMLButtonElement = dom.window.HTMLButtonElement as never;
  globals.SVGElement = dom.window.SVGElement as never;
  globals.Text = dom.window.Text as never;
  globals.Event = dom.window.Event as never;
  globals.MouseEvent = dom.window.MouseEvent as never;
  globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window) as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
}

installDom();

afterEach(() => {
  cleanup();
});

describe("PlaybookRefreshButton", () => {
  test("calls onRefresh on click", () => {
    let called = 0;
    const view = render(
      <PlaybookRefreshButton
        label="Refresh"
        isRefreshing={false}
        onRefresh={() => {
          called += 1;
        }}
      />
    );
    fireEvent.click(view.getByRole("button", { name: /refresh/i }));
    expect(called).toBe(1);
  });

  test("is disabled and shows refreshing label when isRefreshing", () => {
    const view = render(
      <PlaybookRefreshButton label="Refresh" isRefreshing={true} onRefresh={() => {}} />
    );
    const button = view.getByRole("button");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(view.getByText(/Refreshing/i)).toBeTruthy();
  });
});
