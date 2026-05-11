/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { JSDOM } from "jsdom";
import React from "react";
import { DashboardView } from "./DashboardView";

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

describe("DashboardView", () => {
  test("renders metric tiles", () => {
    const view = render(
      <DashboardView
        layout={{
          sections: [
            {
              type: "metrics",
              title: "Pipeline",
              items: [{ label: "Open deals", binding: "step1.open", unit: "deals" }],
            },
          ],
        }}
        outputs={{ step1: { open: 12 } }}
      />
    );
    expect(view.getByText("12")).toBeTruthy();
    expect(view.getByText(/Open deals/)).toBeTruthy();
  });

  test("renders dashboard fields from JSON text returned by an agent step", () => {
    const view = render(
      <DashboardView
        layout={{
          sections: [
            {
              type: "metrics",
              title: "Activity",
              items: [{ label: "Open items", binding: "draftSnapshot.openItems" }],
            },
            { type: "list", title: "Highlights", binding: "draftSnapshot.highlights" },
            { type: "text", title: "Summary", binding: "draftSnapshot.summary" },
          ],
        }}
        outputs={{
          draftSnapshot: {
            text: `{
  "openItems": 15,
  "highlights": ["Reels outperformed carousels."],
  "summary": "Reels are the clearest signal."
}

Caveat: counts were inferred from the digest.`,
            boundaryViolations: 0,
          },
        }}
      />
    );

    expect(view.getByText("15")).toBeTruthy();
    expect(view.getByText("Reels outperformed carousels.")).toBeTruthy();
    expect(view.getByText("Reels are the clearest signal.")).toBeTruthy();
  });

  test("renders empty-label when list binding is empty", () => {
    const view = render(
      <DashboardView
        layout={{
          sections: [
            { type: "list", title: "Risks", binding: "step1.risks", emptyLabel: "Nothing yet" },
          ],
        }}
        outputs={{ step1: { risks: [] } }}
      />
    );
    expect(view.getByText("Nothing yet")).toBeTruthy();
  });

  test("renders table with declared columns", () => {
    const view = render(
      <DashboardView
        layout={{
          sections: [
            {
              type: "table",
              title: "Deals",
              binding: "step1.deals",
              columns: [
                { key: "name", label: "Name" },
                { key: "stage", label: "Stage" },
              ],
            },
          ],
        }}
        outputs={{ step1: { deals: [{ name: "Acme", stage: "Proposal" }] } }}
      />
    );
    expect(view.getByText("Acme")).toBeTruthy();
    expect(view.getByText("Proposal")).toBeTruthy();
  });

  test("renders text section", () => {
    const view = render(
      <DashboardView
        layout={{ sections: [{ type: "text", title: "Summary", binding: "step1.summary" }] }}
        outputs={{ step1: { summary: "Hello world." } }}
      />
    );
    expect(view.getByText("Hello world.")).toBeTruthy();
  });
});
