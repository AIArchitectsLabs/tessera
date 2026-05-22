/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  IntegrationConnectionTestResult,
  IntegrationSettingsRead,
  IntegrationSettingsSaveRequest,
  MemoryForgetRequest,
  MemoryReviewDecisionRequest,
  MemoryReviewListResult,
  MemoryRuntimeStatus,
  ModelSettingsRead,
  SearchProvider,
  WorkspaceConfig,
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
    decision?: MemoryReviewDecisionRequest;
    deviceAuthId?: string;
    request?: Record<string, unknown>;
    userKey?: string;
    userCode?: string;
  };
};

const invokeCalls: InvokeCall[] = [];

let modelSettings: ModelSettingsRead = {
  selectedProvider: "openai",
  providers: {
    openai: {
      provider: "openai",
      model: "gpt-4.1",
      hasCredential: false,
    },
    "openai-codex": {
      provider: "openai-codex",
      model: "gpt-5.4",
      hasCredential: false,
    },
    anthropic: {
      provider: "anthropic",
      model: "claude-3.7-sonnet",
      hasCredential: false,
    },
    google: {
      provider: "google",
      model: "gemini-2.5-flash",
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
    googleWorkspace: {
      provider: "google-workspace",
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
let memoryStatus: MemoryRuntimeStatus | Error = {
  enabled: true,
  mode: "active",
  dbPath: "/tmp/tessera-memory.sqlite",
};
let memoryReview: MemoryReviewListResult = {
  active: [
    {
      id: "memory-active-style",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "workspace",
      type: "preference",
      title: "Weekly style",
      body: "Prefer concise bullets.",
      status: "active",
      confidence: 0.92,
      freshness: "fresh",
      sourceEventIds: ["event-1"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    },
  ],
  candidates: [
    {
      id: "memory-candidate-style",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "workspace",
      type: "preference",
      title: "Meeting brief style",
      body: "Prefer action items first.",
      status: "candidate",
      confidence: 0.62,
      freshness: "fresh",
      sourceEventIds: ["event-2"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      rationale: {
        supportingEventIds: ["event-2"],
        conflictingMemoryIds: [],
        promotionReason: "Semantic extraction needs review.",
        riskFlags: ["low_confidence"],
      },
    },
  ],
};
let googleWorkspaceOAuthClientStatus = {
  hasClient: false,
  source: "missing",
};
type GoogleWorkspaceCapabilityStatus = {
  capabilityId: string;
  binaryName: string;
  path?: string;
  installed: boolean;
  installAvailable: boolean;
  version: string;
  sizeBytes?: number;
  progress?: {
    phase: string;
    downloadedBytes?: number;
    totalBytes?: number;
  };
};
let googleWorkspaceCapabilityStatus: GoogleWorkspaceCapabilityStatus = {
  capabilityId: "google-workspace-cli",
  binaryName: "gws",
  path: "/tmp/tessera-gws",
  installed: true,
  installAvailable: true,
  version: "0.22.5",
  sizeBytes: 15_371_280,
  progress: {
    phase: "installed",
    downloadedBytes: 15_371_280,
    totalBytes: 15_371_280,
  },
};
let googleWorkspaceConnectResult: IntegrationConnectionTestResult = {
  ok: true,
  message: "Google Workspace connected.",
  provider: "google-workspace",
};
let integrationConnectionTestResult: IntegrationConnectionTestResult = {
  ok: true,
  message: "Connection test succeeded",
  provider: "google-workspace",
};
let googleWorkspaceConnectionStatusResult: IntegrationConnectionTestResult = {
  ok: true,
  message: "Google Workspace connected.",
  provider: "google-workspace",
};
let workspaceStyleConfig: WorkspaceConfig = { schemaVersion: 1 };
let workspaceStyleExists = false;
let workspaceStyleFingerprint = "sha256:missing";
let workspaceStyleConflictOnce = false;

function workspaceStyleReadResult() {
  return {
    schemaVersion: 1,
    workspaceRoot: "/tmp/workspace",
    exists: workspaceStyleExists,
    config: workspaceStyleConfig,
    fingerprint: workspaceStyleFingerprint,
  };
}

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
    case "model_codex_oauth_device_code":
      return {
        deviceAuthId: "device-123",
        interval: 60,
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
      };
    case "model_codex_oauth_poll":
      return { status: "pending" };
    case "integration_settings_get":
      return integrationSettings;
    case "memory_status_get":
      if (memoryStatus instanceof Error) {
        throw memoryStatus;
      }
      return memoryStatus;
    case "memory_review_list":
      return memoryReview;
    case "memory_review_decide": {
      const decision = args?.decision;
      if (!decision) throw new Error("Missing memory decision");
      const candidate = memoryReview.candidates.find((memory) => memory.id === decision.memoryId);
      const active = memoryReview.active.find((memory) => memory.id === decision.memoryId);
      if (candidate && decision.decision === "accept") {
        const accepted = {
          ...candidate,
          status: "active" as const,
          updatedAt: decision.decidedAt,
        };
        memoryReview = {
          active: [accepted, ...memoryReview.active],
          candidates: memoryReview.candidates.filter((memory) => memory.id !== decision.memoryId),
        };
        return accepted;
      }
      if (candidate && decision.decision !== "accept") {
        memoryReview = {
          ...memoryReview,
          candidates: memoryReview.candidates.filter((memory) => memory.id !== decision.memoryId),
        };
        return { ...candidate, status: decision.decision === "reject" ? "rejected" : "archived" };
      }
      if (active && decision.decision === "archive") {
        memoryReview = {
          ...memoryReview,
          active: memoryReview.active.filter((memory) => memory.id !== decision.memoryId),
        };
        return { ...active, status: "archived", updatedAt: decision.decidedAt };
      }
      throw new Error("Unknown memory");
    }
    case "memory_forget": {
      const request = args?.request as MemoryForgetRequest | undefined;
      if (!request) throw new Error("Missing memory forget request");
      const active = memoryReview.active.find((memory) => memory.id === request.memoryId);
      if (!active) throw new Error("Unknown memory");
      memoryReview = {
        ...memoryReview,
        active: memoryReview.active.filter((memory) => memory.id !== request.memoryId),
      };
      return { ok: true };
    }
    case "google_workspace_oauth_client_status":
      return googleWorkspaceOAuthClientStatus;
    case "google_workspace_oauth_client_save":
      googleWorkspaceOAuthClientStatus = {
        hasClient: true,
        source: "saved",
      };
      return googleWorkspaceOAuthClientStatus;
    case "google_workspace_oauth_client_delete":
      googleWorkspaceOAuthClientStatus = {
        hasClient: false,
        source: "missing",
      };
      return googleWorkspaceOAuthClientStatus;
    case "google_workspace_capability_status":
      return googleWorkspaceCapabilityStatus;
    case "google_workspace_capability_install":
      googleWorkspaceCapabilityStatus = {
        ...googleWorkspaceCapabilityStatus,
        path: "/tmp/tessera-gws",
        installed: true,
        progress: {
          phase: "installed",
          ...(googleWorkspaceCapabilityStatus.sizeBytes !== undefined
            ? {
                downloadedBytes: googleWorkspaceCapabilityStatus.sizeBytes,
                totalBytes: googleWorkspaceCapabilityStatus.sizeBytes,
              }
            : {}),
        },
      };
      return googleWorkspaceCapabilityStatus;
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
      if (args?.request?.provider === "google-workspace") {
        if (!integrationConnectionTestResult.ok) {
          integrationSettings = {
            ...integrationSettings,
            providers: {
              ...integrationSettings.providers,
              googleWorkspace: {
                ...integrationSettings.providers.googleWorkspace,
                hasCredential: false,
              },
            },
          };
        }
        return integrationConnectionTestResult;
      }
      return {
        ok: true,
        message: "Connection test succeeded",
        searchProvider: args?.request?.searchProvider as SearchProvider | undefined,
      } satisfies IntegrationConnectionTestResult;
    case "google_workspace_health":
      return [
        { service: "Calendar", ok: true, message: "Ready" },
        { service: "Gmail", ok: true, message: "Ready" },
        { service: "Drive", ok: true, message: "Ready" },
        { service: "Contacts", ok: true, message: "Ready" },
        { service: "Docs", ok: true, message: "Available through Drive reads." },
        { service: "Sheets", ok: true, message: "Available through Drive reads." },
      ];
    case "google_workspace_connect":
      if (googleWorkspaceConnectResult.ok) {
        integrationSettings = {
          ...integrationSettings,
          providers: {
            ...integrationSettings.providers,
            googleWorkspace: {
              ...integrationSettings.providers.googleWorkspace,
              hasCredential: true,
            },
          },
        };
      }
      return googleWorkspaceConnectResult;
    case "google_workspace_connection_status":
      if (googleWorkspaceConnectionStatusResult.ok) {
        integrationSettings = {
          ...integrationSettings,
          providers: {
            ...integrationSettings.providers,
            googleWorkspace: {
              ...integrationSettings.providers.googleWorkspace,
              hasCredential: true,
            },
          },
        };
      }
      return googleWorkspaceConnectionStatusResult;
    case "google_workspace_disconnect":
      integrationSettings = {
        ...integrationSettings,
        providers: {
          ...integrationSettings.providers,
          googleWorkspace: {
            ...integrationSettings.providers.googleWorkspace,
            hasCredential: false,
          },
        },
      };
      return integrationSettings;
    case "workspace_style_guide_get":
      return workspaceStyleReadResult();
    case "workspace_style_guide_save": {
      const request = args?.request as
        | { config?: WorkspaceConfig; overwrite?: boolean; expectedFingerprint?: string }
        | undefined;
      if (!request?.config) throw new Error("Missing style guide config");
      if (workspaceStyleConflictOnce && !request.overwrite) {
        workspaceStyleConflictOnce = false;
        workspaceStyleExists = true;
        workspaceStyleFingerprint = "sha256:external";
        throw new Error(
          "Sidecar returned error: The workspace style guide changed outside Tessera."
        );
      }
      workspaceStyleConfig = request.config;
      workspaceStyleExists = true;
      workspaceStyleFingerprint = request.overwrite ? "sha256:overwrite" : "sha256:saved";
      return workspaceStyleReadResult();
    }
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
  modelSettings = {
    selectedProvider: "openai",
    providers: {
      openai: {
        provider: "openai",
        model: "gpt-4.1",
        hasCredential: false,
      },
      "openai-codex": {
        provider: "openai-codex",
        model: "gpt-5.4",
        hasCredential: false,
      },
      anthropic: {
        provider: "anthropic",
        model: "claude-3.7-sonnet",
        hasCredential: false,
      },
      google: {
        provider: "google",
        model: "gemini-2.5-flash",
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
  integrationSettings = initialIntegrationSettings();
  memoryStatus = {
    enabled: true,
    mode: "active",
    dbPath: "/tmp/tessera-memory.sqlite",
  };
  memoryReview = {
    active: [
      {
        id: "memory-active-style",
        workspaceKey: "workspace:one",
        ownerId: "local-owner",
        scope: "workspace",
        type: "preference",
        title: "Weekly style",
        body: "Prefer concise bullets.",
        status: "active",
        confidence: 0.92,
        freshness: "fresh",
        sourceEventIds: ["event-1"],
        sourceDocumentIds: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ],
    candidates: [
      {
        id: "memory-candidate-style",
        workspaceKey: "workspace:one",
        ownerId: "local-owner",
        scope: "workspace",
        type: "preference",
        title: "Meeting brief style",
        body: "Prefer action items first.",
        status: "candidate",
        confidence: 0.62,
        freshness: "fresh",
        sourceEventIds: ["event-2"],
        sourceDocumentIds: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
        rationale: {
          supportingEventIds: ["event-2"],
          conflictingMemoryIds: [],
          promotionReason: "Semantic extraction needs review.",
          riskFlags: ["low_confidence"],
        },
      },
    ],
  };
  googleWorkspaceOAuthClientStatus = {
    hasClient: false,
    source: "missing",
  };
  googleWorkspaceCapabilityStatus = {
    capabilityId: "google-workspace-cli",
    binaryName: "gws",
    path: "/tmp/tessera-gws",
    installed: true,
    installAvailable: true,
    version: "0.22.5",
    sizeBytes: 15_371_280,
    progress: {
      phase: "installed",
      downloadedBytes: 15_371_280,
      totalBytes: 15_371_280,
    },
  };
  googleWorkspaceConnectResult = {
    ok: true,
    message: "Google Workspace connected.",
    provider: "google-workspace",
  };
  integrationConnectionTestResult = {
    ok: true,
    message: "Connection test succeeded",
    provider: "google-workspace",
  };
  googleWorkspaceConnectionStatusResult = {
    ok: true,
    message: "Google Workspace connected.",
    provider: "google-workspace",
  };
  workspaceStyleConfig = { schemaVersion: 1 };
  workspaceStyleExists = false;
  workspaceStyleFingerprint = "sha256:missing";
  workspaceStyleConflictOnce = false;
});

afterEach(() => {
  cleanup();
});

async function renderIntegrationsView() {
  const view = render(
    React.createElement(SettingsView, { onClose: () => undefined, userKey: "user.test" })
  );

  await waitFor(() => {
    expect(invokeCalls.some((call) => call.command === "integration_settings_get")).toBe(true);
  });

  fireEvent.click(view.getByRole("button", { name: /integrations/i }));

  await view.findByRole("heading", { name: "Integrations" });
  return view;
}

async function renderModelView() {
  const view = render(
    React.createElement(SettingsView, { onClose: () => undefined, userKey: "user.test" })
  );

  await waitFor(() => {
    expect(invokeCalls.some((call) => call.command === "model_settings_get")).toBe(true);
  });

  await view.findByRole("heading", { name: "Model" });
  return view;
}

async function renderMemoryView() {
  const view = render(
    React.createElement(SettingsView, { onClose: () => undefined, userKey: "user.test" })
  );

  await waitFor(() => {
    expect(invokeCalls.some((call) => call.command === "memory_status_get")).toBe(true);
  });

  fireEvent.click(view.getByRole("button", { name: /memory/i }));

  await view.findByRole("heading", { name: "Memory" });
  return view;
}

async function renderStyleGuideView(workspaceRoot: string | null = "/tmp/workspace") {
  const view = render(
    React.createElement(SettingsView, {
      onClose: () => undefined,
      userKey: "user.test",
      workspaceRoot,
    })
  );

  await waitFor(() => {
    expect(invokeCalls.some((call) => call.command === "model_settings_get")).toBe(true);
  });

  fireEvent.click(view.getByRole("button", { name: /style guide/i }));

  await view.findByRole("heading", { name: "Style Guide" });
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

function workspaceIntegrationSection(view: ReturnType<typeof render>) {
  const heading = view.getByText("Workspace integration");
  return heading.closest("section");
}

function setInputValue(input: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing input value setter");
  setter.call(input, value);
  fireEvent.change(input, { bubbles: true });
}

function setTextAreaValue(textarea: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  if (!setter) throw new Error("Missing textarea value setter");
  setter.call(textarea, value);
  fireEvent.change(textarea, { bubbles: true });
}

describe("SettingsView style guide flow", () => {
  test("renders workspace-scoped empty state without a selected workspace", async () => {
    const view = await renderStyleGuideView(null);

    expect(
      view.getByText("Select a workspace to create or edit its local style guide.")
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Start from defaults" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  test("starts from defaults, edits major fields, and saves workspace config", async () => {
    const view = await renderStyleGuideView();

    fireEvent.click(view.getByRole("button", { name: "Start from defaults" }));
    await view.findByLabelText("Profile name");

    fireEvent.input(view.getByLabelText("Profile name"), {
      target: { value: "Teserra Editorial Voice" },
    });
    fireEvent.input(view.getByLabelText("Voice principles"), {
      target: { value: "Lead with a direct answer\nPrefer specific evidence" },
    });
    fireEvent.input(view.getByLabelText("Banned terms"), {
      target: { value: "synergy\nbest-in-class" },
    });

    fireEvent.click(view.getByRole("button", { name: "Save style guide" }));

    await waitFor(() => {
      const saveCall = invokeCalls.find((call) => call.command === "workspace_style_guide_save");
      const config = saveCall?.args?.request?.config as WorkspaceConfig | undefined;
      expect(config?.styleGuide?.profile.name).toBe("Teserra Editorial Voice");
      expect(config?.styleGuide?.voice.principles).toEqual([
        "Lead with a direct answer",
        "Prefer specific evidence",
      ]);
      expect(config?.styleGuide?.language.bannedTerms).toEqual(["synergy", "best-in-class"]);
    });
    expect(await view.findByText("Style guide saved")).toBeTruthy();
  });

  test("validates malformed JSON before saving", async () => {
    const view = await renderStyleGuideView();

    const jsonEditor = view.getByLabelText("Style guide JSON") as HTMLTextAreaElement;
    fireEvent.input(jsonEditor, { target: { value: "{not-json" } });
    await waitFor(() => {
      expect(jsonEditor.value).toBe("{not-json");
    });
    fireEvent.click(view.getByRole("button", { name: "Save style guide" }));

    await waitFor(() => {
      expect(view.getAllByText(/Expected property name|JSON/).length).toBeGreaterThan(0);
    });
    expect(invokeCalls.some((call) => call.command === "workspace_style_guide_save")).toBe(false);
  });

  test("stale save conflicts offer reload and intentional overwrite", async () => {
    workspaceStyleConflictOnce = true;
    const view = await renderStyleGuideView();

    fireEvent.click(view.getByRole("button", { name: "Start from defaults" }));
    fireEvent.click(view.getByRole("button", { name: "Save style guide" }));

    await view.findByText(/changed outside Tessera/);
    expect(view.getByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Overwrite" }));

    await waitFor(() => {
      const saveCalls = invokeCalls.filter((call) => call.command === "workspace_style_guide_save");
      expect(saveCalls[saveCalls.length - 1]?.args?.request?.overwrite).toBe(true);
    });
    expect(await view.findByText("Style guide saved")).toBeTruthy();
  });
});

describe("SettingsView model flow", () => {
  test("legacy settings missing the selected provider fall back without crashing", async () => {
    modelSettings.selectedProvider = "openai-codex";
    Reflect.deleteProperty(
      modelSettings.providers as unknown as Record<string, unknown>,
      "openai-codex"
    );

    const view = await renderModelView();

    expect(view.getByText("ChatGPT sign-in")).toBeTruthy();
    expect(view.queryByText("API key")).toBeNull();
  });

  test("Codex selected from saved settings never renders API key controls", async () => {
    modelSettings.selectedProvider = "openai-codex";
    const view = await renderModelView();

    expect(view.getByText("ChatGPT sign-in")).toBeTruthy();
    expect(view.queryByText("API key")).toBeNull();
    expect(view.getByRole("button", { name: "Sign in with ChatGPT" })).toBeTruthy();
  });

  test("Codex provider uses ChatGPT sign-in controls instead of API key input", async () => {
    const view = await renderModelView();

    fireEvent.click(view.getByRole("button", { name: /openai codex/i }));

    expect((view.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.4");
    expect(view.getByText("ChatGPT sign-in")).toBeTruthy();
    expect(view.getByText("No ChatGPT session connected")).toBeTruthy();
    expect(view.queryByText("API key")).toBeNull();
    expect(view.getByRole("button", { name: "Sign in with ChatGPT" })).toBeTruthy();
  });

  test("renders curated model choices for cloud providers", async () => {
    const view = await renderModelView();

    const openAiModel = view.getByLabelText("Model") as HTMLSelectElement;
    expect(openAiModel.tagName).toBe("SELECT");
    expect(Array.from(openAiModel.options).map((option) => option.value)).toContain("gpt-5.5");
  });

  test("starting Codex sign-in requests a device code", async () => {
    const view = await renderModelView();

    fireEvent.click(view.getByRole("button", { name: /openai codex/i }));
    fireEvent.click(view.getByRole("button", { name: "Sign in with ChatGPT" }));

    await waitFor(() => {
      expect(invokeCalls.some((call) => call.command === "model_codex_oauth_device_code")).toBe(
        true
      );
    });
    await waitFor(() => {
      expect(view.getByText(/ABCD-EFGH/)).toBeTruthy();
    });
  });
});

describe("SettingsView search flow", () => {
  test("selecting Google AI Studio backfills the Gemini model when saved settings are old", async () => {
    const { google: _missing, ...providers } = modelSettings.providers;
    modelSettings = {
      ...modelSettings,
      providers,
    } as ModelSettingsRead;
    const view = await renderModelView();

    fireEvent.click(view.getByRole("button", { name: /google ai studio/i }));

    await waitFor(() => {
      expect((view.getByLabelText("Model") as HTMLSelectElement).value).toBe("gemini-2.5-flash");
    });
  });

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

describe("SettingsView memory flow", () => {
  test("renders active local memory status", async () => {
    const view = await renderMemoryView();

    expect(view.getByText("Local memory store")).toBeTruthy();
    expect(view.getByText("Memory capture and recall are available for local tasks.")).toBeTruthy();
    expect(view.getAllByText("Active").length).toBeGreaterThan(0);
    expect(view.getByText("/tmp/tessera-memory.sqlite")).toBeTruthy();
  });

  test("renders memory review candidates and active memories", async () => {
    const view = await renderMemoryView();

    expect(view.getByText("Review queue")).toBeTruthy();
    expect(view.getByText("Meeting brief style")).toBeTruthy();
    expect(view.getByText("Prefer action items first.")).toBeTruthy();
    expect(view.getByText("Semantic extraction needs review.")).toBeTruthy();
    expect(view.getByText("Active memories")).toBeTruthy();
    expect(view.getByText("Weekly style")).toBeTruthy();
  });

  test("accepts a review candidate and refreshes the memory lists", async () => {
    const view = await renderMemoryView();

    const candidateSection = view.getByText("Meeting brief style").closest("article");
    if (!candidateSection) throw new Error("Missing candidate section");
    fireEvent.click(within(candidateSection).getByRole("button", { name: /accept/i }));

    await waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call.command === "memory_review_decide" &&
            call.args?.userKey === "user.test" &&
            call.args?.decision?.memoryId === "memory-candidate-style" &&
            call.args.decision.decision === "accept"
        )
      ).toBe(true);
    });
    await waitFor(() => {
      expect(view.queryByText("Semantic extraction needs review.")).toBeNull();
    });
    expect(view.getAllByText("Meeting brief style").length).toBeGreaterThan(0);
  });

  test("forgets an active memory with explicit delete action", async () => {
    const view = await renderMemoryView();

    const activeSection = view.getByText("Weekly style").closest("article");
    if (!activeSection) throw new Error("Missing active memory section");
    fireEvent.click(within(activeSection).getByRole("button", { name: /forget/i }));

    await waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call.command === "memory_forget" &&
            call.args?.userKey === "user.test" &&
            call.args?.request?.memoryId === "memory-active-style" &&
            call.args.request.action === "delete"
        )
      ).toBe(true);
    });
    await waitFor(() => {
      expect(view.queryByText("Weekly style")).toBeNull();
    });
  });

  test("renders fallback startup warning", async () => {
    memoryStatus = {
      enabled: false,
      mode: "fallback",
      dbPath: "/unavailable/memory.sqlite",
      startupWarning: {
        type: "tessera.memory.startup_failed",
        message: "sqlite unavailable",
      },
    };

    const view = await renderMemoryView();

    expect(
      view.getByText("Memory is unavailable, so Tessera is using the no-op fallback.")
    ).toBeTruthy();
    expect(view.getByText("sqlite unavailable")).toBeTruthy();
  });

  test("memory status errors do not block the rest of settings", async () => {
    memoryStatus = new Error("memory endpoint unavailable");
    const view = await renderMemoryView();

    expect(view.getByRole("heading", { name: "Memory" })).toBeTruthy();
    expect(view.getByText("Memory status is not available from the sidecar.")).toBeTruthy();
    expect(view.getByText("memory endpoint unavailable")).toBeTruthy();
    expect(invokeCalls.some((call) => call.command === "model_settings_get")).toBe(true);
  });
});

describe("SettingsView workspace integration flow", () => {
  test("saving Google Workspace OAuth client sends client metadata without echoing the secret", async () => {
    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    setInputValue(
      within(section).getByLabelText("OAuth client ID"),
      "client-id.apps.googleusercontent.com"
    );
    setInputValue(within(section).getByLabelText("OAuth client secret"), "client-secret");
    await waitFor(() => {
      expect(
        within(section).getByRole("button", { name: "Save OAuth client" }).hasAttribute("disabled")
      ).toBe(false);
    });
    const saveButton = within(section).getByRole("button", { name: "Save OAuth client" });
    fireEvent.click(saveButton);

    await waitFor(() => {
      const saveCall = invokeCalls.find(
        (call) => call.command === "google_workspace_oauth_client_save"
      );
      expect(saveCall?.args?.request).toEqual({
        clientId: "client-id.apps.googleusercontent.com",
        clientSecret: "client-secret",
      });
    });
    await waitFor(() => {
      expect(within(section).getByText("OAuth client saved.")).toBeTruthy();
    });
    expect((within(section).getByLabelText("OAuth client secret") as HTMLInputElement).value).toBe(
      ""
    );
  });

  test("Google Workspace renders as CLI-authenticated without key controls", async () => {
    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    expect(within(section).getByText("Google Workspace")).toBeTruthy();
    expect(within(section).getByText("Uses Google Workspace CLI")).toBeTruthy();
    expect(
      within(section).getByText(
        "Connect once to let Tessera read Calendar, Gmail, Drive, Contacts, Docs, and Sheets with Google Workspace."
      )
    ).toBeTruthy();
    for (const service of ["Calendar", "Gmail", "Drive", "Contacts", "Docs", "Sheets"]) {
      expect(within(section).getByText(service)).toBeTruthy();
    }
    expect(
      within(section).queryByText(/Tessera stores the Workspace session in its app config/)
    ).toBeNull();
    expect(within(section).queryByText("API key")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Remove key" })).toBeNull();
    expect(within(section).getByRole("button", { name: "Connect Google Workspace" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Test connection" })).toBeTruthy();
  });

  test("Google Workspace asks before installing the managed CLI", async () => {
    googleWorkspaceOAuthClientStatus = {
      hasClient: true,
      source: "saved",
    };
    googleWorkspaceCapabilityStatus = {
      capabilityId: "google-workspace-cli",
      binaryName: "gws",
      installed: false,
      installAvailable: true,
      version: "0.22.5",
      sizeBytes: 15_371_280,
      progress: {
        phase: "available",
        totalBytes: 15_371_280,
      },
    };

    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    expect(within(section).getByText("Google Workspace CLI")).toBeTruthy();
    expect(within(section).getByText("Download required")).toBeTruthy();
    expect(
      within(section)
        .getByRole("button", { name: "Connect Google Workspace" })
        .hasAttribute("disabled")
    ).toBe(true);

    fireEvent.click(within(section).getByRole("button", { name: "Download connector" }));

    expect(invokeCalls.some((call) => call.command === "google_workspace_capability_install")).toBe(
      false
    );
    expect(within(section).getByRole("button", { name: "Install connector" })).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Install connector" }));

    await waitFor(() => {
      expect(
        invokeCalls.some((call) => call.command === "google_workspace_capability_install")
      ).toBe(true);
    });
    await waitFor(() => {
      expect(within(section).getByText("Connector ready")).toBeTruthy();
    });
    expect(
      within(section)
        .getByRole("button", { name: "Connect Google Workspace" })
        .hasAttribute("disabled")
    ).toBe(false);
  });

  test("testing Google Workspace sends no credential payload", async () => {
    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    fireEvent.click(within(section).getByRole("button", { name: "Test connection" }));

    await waitFor(() => {
      const testCall = invokeCalls.find((call) => call.command === "integration_connection_test");
      expect(testCall).toBeTruthy();
      expect(testCall?.args?.request).toEqual({
        provider: "google-workspace",
      });
    });
    await waitFor(() => {
      expect(invokeCalls.some((call) => call.command === "google_workspace_health")).toBe(true);
    });
  });

  test("failed Google Workspace test clears stale connected state", async () => {
    googleWorkspaceOAuthClientStatus = {
      hasClient: true,
      source: "saved",
    };
    integrationSettings = {
      ...integrationSettings,
      providers: {
        ...integrationSettings.providers,
        googleWorkspace: {
          ...integrationSettings.providers.googleWorkspace,
          hasCredential: true,
        },
      },
    };
    integrationConnectionTestResult = {
      ok: false,
      message: "Google Workspace is not connected. Connect Google Workspace in Settings.",
      provider: "google-workspace",
    };
    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    expect(within(section).getByRole("button", { name: "Disconnect" })).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Test connection" }));

    await waitFor(() => {
      expect(invokeCalls.some((call) => call.command === "integration_connection_test")).toBe(true);
    });
    await waitFor(() => {
      expect(
        within(section).getByRole("button", { name: "Connect Google Workspace" })
      ).toBeTruthy();
    });
    expect(within(section).queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  test("connecting Google Workspace uses the dedicated auth command", async () => {
    googleWorkspaceOAuthClientStatus = {
      hasClient: true,
      source: "saved",
    };
    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    fireEvent.click(within(section).getByRole("button", { name: "Connect Google Workspace" }));

    await waitFor(() => {
      expect(invokeCalls.some((call) => call.command === "google_workspace_connect")).toBe(true);
    });
    await waitFor(() => {
      expect(within(section).getByText("Google Workspace connected.")).toBeTruthy();
    });
  });

  test("connecting Google Workspace polls after browser sign-in starts", async () => {
    googleWorkspaceOAuthClientStatus = {
      hasClient: true,
      source: "saved",
    };
    googleWorkspaceConnectResult = {
      ok: false,
      message:
        "Google sign-in opened in your browser. Complete it there, then click Test connection.",
      provider: "google-workspace",
    };
    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    fireEvent.click(within(section).getByRole("button", { name: "Connect Google Workspace" }));

    await waitFor(
      () => {
        expect(
          invokeCalls.some((call) => call.command === "google_workspace_connection_status")
        ).toBe(true);
      },
      { timeout: 3_000 }
    );
    await waitFor(() => {
      expect(within(section).getByText("Google Workspace connected.")).toBeTruthy();
    });
  });

  test("disconnecting Google Workspace uses the dedicated logout command", async () => {
    integrationSettings = {
      ...integrationSettings,
      providers: {
        ...integrationSettings.providers,
        googleWorkspace: {
          ...integrationSettings.providers.googleWorkspace,
          hasCredential: true,
        },
      },
    };
    const view = await renderIntegrationsView();

    const section = workspaceIntegrationSection(view);
    expect(section).toBeTruthy();
    if (!section) throw new Error("Missing workspace integration section");

    fireEvent.click(within(section).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(invokeCalls.some((call) => call.command === "google_workspace_disconnect")).toBe(true);
    });
    await waitFor(() => {
      expect(within(section).getByText("Google Workspace disconnected.")).toBeTruthy();
    });
  });
});
