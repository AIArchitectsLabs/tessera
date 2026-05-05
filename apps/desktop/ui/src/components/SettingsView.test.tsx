/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  IntegrationConnectionTestResult,
  IntegrationSettingsRead,
  IntegrationSettingsSaveRequest,
  ModelSettingsRead,
  SearchProvider,
} from "@tessera/contracts";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
  globals.HTMLInputElement = dom.window.HTMLInputElement as never;
  globals.HTMLButtonElement = dom.window.HTMLButtonElement as never;
  globals.HTMLTextAreaElement = dom.window.HTMLTextAreaElement as never;
  globals.HTMLIFrameElement = dom.window.HTMLIFrameElement as never;
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

type InvokeCall = {
  command: string;
  args?: {
    request?: Record<string, unknown>;
  };
};

const invokeCalls: InvokeCall[] = [];

const modelSettings: ModelSettingsRead = {
  selectedProvider: "openai",
  providers: {
    openai: {
      provider: "openai",
      model: "gpt-4.1",
      hasCredential: false,
    },
    anthropic: {
      provider: "anthropic",
      model: "claude-3.7-sonnet",
      hasCredential: false,
    },
    openrouter: {
      provider: "openrouter",
      model: "openrouter/openai/gpt-4.1",
      hasCredential: false,
    },
    local: {
      provider: "local",
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434/v1",
      hasCredential: false,
    },
  },
};

const initialIntegrationSettings = (): IntegrationSettingsRead => ({
  providers: {
    braveSearch: {
      provider: "brave-search",
      hasCredential: false,
    },
    googleCalendar: {
      provider: "google-calendar",
      hasCredential: false,
    },
  },
  search: {
    mode: "auto",
    allowKeylessFallback: false,
    providers: {
      braveSearch: {
        provider: "brave-search",
        hasCredential: false,
      },
      tavily: {
        provider: "tavily",
        hasCredential: false,
      },
      duckduckgo: {
        provider: "duckduckgo",
        hasCredential: false,
      },
    },
  },
});

let integrationSettings = initialIntegrationSettings();

function updateSearchState(provider: SearchProvider, request?: Record<string, unknown>) {
  const search = (request?.search as IntegrationSettingsSaveRequest["search"] | undefined) ?? {
    mode: integrationSettings.search.mode,
    allowKeylessFallback: integrationSettings.search.allowKeylessFallback,
  };
  const hasCredential = Boolean(request?.credential);

  integrationSettings = {
    ...integrationSettings,
    search: {
      ...integrationSettings.search,
      mode: search.mode,
      allowKeylessFallback: search.allowKeylessFallback,
      providers: {
        ...integrationSettings.search.providers,
        braveSearch: {
          ...integrationSettings.search.providers.braveSearch,
          hasCredential:
            provider === "brave-search"
              ? hasCredential
              : integrationSettings.search.providers.braveSearch.hasCredential,
        },
        tavily: {
          ...integrationSettings.search.providers.tavily,
          hasCredential:
            provider === "tavily"
              ? hasCredential
              : integrationSettings.search.providers.tavily.hasCredential,
        },
        duckduckgo: {
          ...integrationSettings.search.providers.duckduckgo,
          hasCredential: false,
        },
      },
    },
  };
}

const invoke = async (command: string, args?: InvokeCall["args"]) => {
  invokeCalls.push({ command, args: args ? JSON.parse(JSON.stringify(args)) : undefined });

  switch (command) {
    case "model_settings_get":
      return modelSettings;
    case "integration_settings_get":
      return integrationSettings;
    case "integration_settings_save": {
      const request = args?.request;
      const searchProvider = request?.searchProvider as SearchProvider | undefined;

      if (searchProvider) {
        updateSearchState(searchProvider, request);
      }

      return integrationSettings;
    }
    case "integration_credential_delete": {
      const searchProvider = args?.request?.searchProvider as SearchProvider | undefined;
      if (searchProvider) {
        updateSearchState(searchProvider, {
          search: integrationSettings.search,
        });
      }
      return integrationSettings;
    }
    case "integration_connection_test":
      return {
        ok: true,
        message: "Connection test succeeded",
        searchProvider: args?.request?.searchProvider as SearchProvider | undefined,
      } satisfies IntegrationConnectionTestResult;
    default:
      throw new Error(`Unexpected invoke command: ${command}`);
  }
};

mock.module("@tauri-apps/api/core", () => ({
  invoke,
}));

const { SettingsView } = await import("./SettingsView");

beforeEach(() => {
  invokeCalls.length = 0;
  integrationSettings = initialIntegrationSettings();
});

afterEach(() => {
  cleanup();
});

async function renderIntegrationsView() {
  const view = render(React.createElement(SettingsView, { onClose: () => undefined }));

  await waitFor(() => {
    expect(invokeCalls.some((call) => call.command === "integration_settings_get")).toBe(true);
  });

  fireEvent.click(view.getByRole("button", { name: /integrations/i }));

  await view.findByRole("heading", { name: "Integrations" });
  return view;
}

function searchModeSection(view: ReturnType<typeof render>) {
  const heading = view.getByText("Search mode");
  return heading.closest("section");
}

function searchProvidersSection(view: ReturnType<typeof render>) {
  const heading = view.getByText("Search providers");
  return heading.closest("section");
}

describe("SettingsView search flow", () => {
  test("switching search mode to Tavily updates selected search provider state", async () => {
    const view = await renderIntegrationsView();

    const section = searchModeSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing search mode section");

    fireEvent.click(within(section).getByRole("button", { name: /tavily/i }));

    const providers = searchProvidersSection(view);
    expect(providers).toBeTruthy();
    if (!providers) throw new Error("Missing search providers section");

    expect(view.getByPlaceholderText("Paste Tavily API key")).toBeTruthy();
  });

  test("DuckDuckGo renders as a keyless provider", async () => {
    const view = await renderIntegrationsView();

    const section = searchProvidersSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing search providers section");

    fireEvent.click(within(section).getByRole("button", { name: /duckduckgo/i }));

    expect(
      view.getByText("DuckDuckGo uses keyless search. No API key is required or stored.")
    ).toBeTruthy();
    expect(view.queryByPlaceholderText("Paste DuckDuckGo API key")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  test("saving Tavily sends a first-class searchProvider payload", async () => {
    const view = await renderIntegrationsView();

    const modeSection = searchModeSection(view);
    const providerSection = searchProvidersSection(view);
    expect(modeSection).toBeTruthy();
    expect(providerSection).toBeTruthy();
    if (!modeSection || !providerSection) {
      throw new Error("Missing search settings sections");
    }

    fireEvent.click(within(modeSection).getByRole("button", { name: /tavily/i }));
    fireEvent.click(within(providerSection).getByRole("button", { name: /tavily/i }));
    fireEvent.click(view.getByLabelText("Allow keyless fallback"));
    fireEvent.click(within(providerSection).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const saveCall = invokeCalls.find((call) => call.command === "integration_settings_save");
      expect(saveCall).toBeTruthy();
      expect(saveCall?.args?.request).toEqual({
        searchProvider: "tavily",
        hasExistingCredential: false,
        search: {
          mode: "tavily",
          allowKeylessFallback: true,
        },
      });
    });
  });
});
