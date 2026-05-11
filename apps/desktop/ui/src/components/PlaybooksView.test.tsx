/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentProfileListResult,
  IntegrationSettingsRead,
  ModelSettingsRead,
  PlaybookDetail,
  PlaybookListResult,
  PlaybookRunDetail,
  WorkflowRunListResult,
} from "@tessera/contracts";
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
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(cb, 0)) as never;
  globals.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
}

installDom();

const playbook = {
  id: "sales.meeting-brief",
  version: 1,
  name: "Sales Meeting Brief",
  description: "Prepare for a customer or prospect meeting",
  category: "Sales",
  businessUseCase: "Prepare for a customer or prospect meeting",
  requiredCapabilities: [],
  optionalCapabilities: [],
  inputs: {},
  outputs: [{ kind: "meetingBrief", label: "Meeting brief" }],
  steps: [],
  stepCount: 1,
  phases: ["Prepare"],
} satisfies PlaybookDetail;

const dashboardPlaybook = {
  id: "ops.activity-snapshot",
  version: 1,
  name: "Activity Snapshot",
  description: "Refreshable dashboard of recent workspace activity.",
  category: "Operations",
  businessUseCase: "Monitor recent workspace activity",
  requiredCapabilities: [],
  optionalCapabilities: [],
  inputs: {
    scope: {
      type: "string",
      required: true,
      label: "Scope",
      default: "this week",
      order: 1,
    },
  },
  outputs: [{ kind: "dashboard", label: "Activity dashboard", layout: "layouts/dashboard.json" }],
  steps: [],
  stepCount: 1,
  phases: ["Summarize"],
} satisfies PlaybookDetail;

const completedRun = {
  runId: "run-1",
  workflowId: "sales.meeting-brief",
  status: "completed",
  input: {
    company: "FOMORA",
    sources: ["web"],
  },
  outputs: {
    "draft-meeting-brief": {
      text: "Created the brief and saved it to: `Sales Meeting Brief - FOMORA.md`",
      boundaryViolations: 0,
    },
  },
  updatedAt: "2026-05-09T07:17:00.000Z",
  events: [],
  steps: [],
} as unknown as PlaybookRunDetail;

const dashboardRun = {
  runId: "run-dashboard",
  workflowId: "ops.activity-snapshot",
  status: "completed",
  input: {
    scope: "this week",
  },
  outputs: {
    draftSnapshot: {
      openItems: 7,
      atRisk: 2,
      highlights: ["Inbox cleared"],
      summary: "Workspace activity is steady.",
    },
  },
  updatedAt: "2026-05-10T07:17:00.000Z",
  events: [],
  steps: [],
} as unknown as PlaybookRunDetail;

const modelSettings: ModelSettingsRead = {
  selectedProvider: "openai",
  providers: {
    openai: { provider: "openai", model: "gpt-5.4", hasCredential: true },
    anthropic: { provider: "anthropic", model: "claude-sonnet-4-6", hasCredential: false },
    openrouter: { provider: "openrouter", model: "openai/gpt-5.4", hasCredential: false },
    local: {
      provider: "local",
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434/v1",
      hasCredential: false,
    },
  },
};

const integrationSettings: IntegrationSettingsRead = {
  providers: {
    braveSearch: { provider: "brave-search", hasCredential: false },
    googleWorkspace: { provider: "google-workspace", hasCredential: false },
  },
  search: {
    mode: "auto",
    allowKeylessFallback: true,
    providers: {
      braveSearch: { provider: "brave-search", hasCredential: false },
      tavily: { provider: "tavily", hasCredential: false },
      duckduckgo: { provider: "duckduckgo", hasCredential: false },
    },
  },
};

const invoke = mock(async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case "playbook_list":
      return { playbooks: [playbook, dashboardPlaybook] } satisfies PlaybookListResult;
    case "playbook_get":
      return args?.playbookId === dashboardPlaybook.id ? dashboardPlaybook : playbook;
    case "playbook_run_list":
      if (args?.playbookId === dashboardPlaybook.id) {
        return { runs: [dashboardRun] } satisfies WorkflowRunListResult;
      }
      if (args?.playbookId === playbook.id) {
        return { runs: [completedRun] } satisfies WorkflowRunListResult;
      }
      return { runs: [dashboardRun, completedRun] } satisfies WorkflowRunListResult;
    case "playbook_run_get":
      return args?.runId === dashboardRun.runId ? dashboardRun : completedRun;
    case "playbook_get_dashboard_layout":
      return {
        layout: {
          refreshLabel: "Refresh snapshot",
          sections: [
            {
              type: "metrics",
              title: "Activity",
              items: [{ label: "Open items", binding: "draftSnapshot.openItems" }],
            },
            { type: "text", title: "Summary", binding: "draftSnapshot.summary" },
          ],
        },
      };
    case "model_settings_get":
      return modelSettings;
    case "integration_settings_get":
      return integrationSettings;
    case "agent_profile_list":
      return {
        profiles: [
          {
            id: "default",
            name: "Tessera",
            model: { mode: "default" },
            instructions: "",
            soul: "",
            userContext: "",
            skills: [],
            toolPolicyPreset: "workspace_editor",
            memoryDefaults: "",
            createdAt: "2026-05-09T00:00:00.000Z",
            updatedAt: "2026-05-09T00:00:00.000Z",
          },
        ],
      } satisfies AgentProfileListResult;
    default:
      throw new Error(`Unexpected invoke command: ${command}`);
  }
});

mock.module("@tauri-apps/api/core", () => ({
  invoke,
}));

const { PlaybooksView } = await import("./PlaybooksView");

beforeEach(() => {
  invoke.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("PlaybooksView", () => {
  test("keeps run history when the selected playbook is clicked again", async () => {
    const view = render(React.createElement(PlaybooksView, { workspaceRoot: "/tmp/workspace" }));

    await waitFor(() => {
      expect(view.getByText(/May 9/)).toBeTruthy();
    });

    const playbookButton = view.getAllByText("Sales Meeting Brief")[0]?.closest("button");
    if (!playbookButton) throw new Error("Expected playbook button");
    fireEvent.click(playbookButton);

    expect(view.queryByText(/May 9/)).toBeTruthy();
  });

  test("renders completed runs even when older payloads omit sourceGaps", async () => {
    const view = render(React.createElement(PlaybooksView, { workspaceRoot: "/tmp/workspace" }));

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 9/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected run button");

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText("Sales Meeting Brief is ready.")).toBeTruthy();
    });
    expect(view.getByText("Meeting brief")).toBeTruthy();
    expect(view.getByText(/Research requested: Web/)).toBeTruthy();
  });

  test("renders pinned dashboard runs with dashboard layout and refresh button", async () => {
    const view = render(React.createElement(PlaybooksView, { workspaceRoot: "/tmp/workspace" }));

    await waitFor(() => {
      expect(view.getByText("Dashboards")).toBeTruthy();
      expect(view.getAllByText("Dashboard").length).toBeGreaterThan(0);
    });

    const dashboardButton = view.getAllByText("Activity Snapshot")[0]?.closest("button");
    if (!dashboardButton) throw new Error("Expected dashboard playbook button");
    fireEvent.click(dashboardButton);

    let runButton: HTMLElement | null = null;
    await waitFor(() => {
      runButton = view.getByText(/May 10/).closest("button");
      expect(runButton).toBeTruthy();
    });
    if (!runButton) throw new Error("Expected dashboard run button");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(view.getByText("Activity Snapshot is ready.")).toBeTruthy();
      expect(view.getByText("7")).toBeTruthy();
      expect(view.getByRole("button", { name: /Refresh snapshot/i })).toBeTruthy();
    });
  });
});
