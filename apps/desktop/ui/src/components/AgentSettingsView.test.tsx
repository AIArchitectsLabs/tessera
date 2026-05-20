/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentProfile,
  AgentProfileListResult,
  AgentProfileUpdateRequest,
  SkillListResult,
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
  globals.HTMLInputElement = dom.window.HTMLInputElement as never;
  globals.HTMLButtonElement = dom.window.HTMLButtonElement as never;
  globals.HTMLSelectElement = dom.window.HTMLSelectElement as never;
  globals.HTMLTextAreaElement = dom.window.HTMLTextAreaElement as never;
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
    id?: string;
    request?: Record<string, unknown>;
    userKey?: string;
  };
};

const now = "2026-05-12T00:00:00.000Z";
const invokeCalls: InvokeCall[] = [];

let profiles: AgentProfile[] = [];

function defaultProfile(): AgentProfile {
  return {
    id: "default",
    name: "Tessera",
    description: "Built-in workspace agent",
    model: { mode: "default" },
    instructions: "Turn broad requests into concrete deliverables.",
    soul: "Direct and calm.",
    userContext: "Supports business operators.",
    skills: [],
    toolPolicyPreset: "workspace_editor",
    memoryDefaults: "",
    createdAt: now,
    updatedAt: now,
  };
}

function openRouterProfile(): AgentProfile {
  return {
    id: "agent-router",
    name: "Router Analyst",
    description: "Uses a custom OpenRouter model",
    model: {
      mode: "override",
      provider: {
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        apiKeyEnv: "OPENROUTER_API_KEY",
        thinkingLevel: "medium",
      },
    },
    instructions: "Analyze workspace data.",
    soul: "Precise.",
    userContext: "",
    skills: [],
    toolPolicyPreset: "read_only",
    memoryDefaults: "",
    createdAt: now,
    updatedAt: now,
  };
}

const invoke = mock(async (command: string, args?: InvokeCall["args"]) => {
  invokeCalls.push(args ? { command, args } : { command });
  switch (command) {
    case "agent_profile_list":
      return { profiles } satisfies AgentProfileListResult;
    case "skill_list":
      return { skills: [] } satisfies SkillListResult;
    case "agent_profile_create": {
      const request = args?.request as Omit<AgentProfile, "createdAt" | "id" | "updatedAt">;
      const profile: AgentProfile = {
        id: "agent-created",
        createdAt: now,
        updatedAt: now,
        ...request,
      };
      profiles = [...profiles, profile];
      return profile;
    }
    case "agent_profile_update": {
      const id = args?.id;
      const request = args?.request as AgentProfileUpdateRequest;
      const existing = profiles.find((profile) => profile.id === id);
      if (!existing) throw new Error("Unknown agent profile");
      const updated: AgentProfile = {
        ...existing,
        name: request.name ?? existing.name,
        description: request.description ?? existing.description,
        templateId: request.templateId ?? existing.templateId,
        instructions: request.instructions ?? existing.instructions,
        model: request.model ?? existing.model,
        soul: request.soul ?? existing.soul,
        userContext: request.userContext ?? existing.userContext,
        skills: request.skills ?? existing.skills,
        toolPolicyPreset: request.toolPolicyPreset ?? existing.toolPolicyPreset,
        memoryDefaults: request.memoryDefaults ?? existing.memoryDefaults,
        updatedAt: now,
      };
      profiles = profiles.map((profile) => (profile.id === id ? updated : profile));
      return updated;
    }
    default:
      throw new Error(`Unexpected invoke command: ${command}`);
  }
});

mock.module("@tauri-apps/api/core", () => ({
  invoke,
}));

const { AgentSettingsView } = await import("./AgentSettingsView");

beforeEach(() => {
  invokeCalls.length = 0;
  profiles = [defaultProfile(), openRouterProfile()];
});

afterEach(() => {
  cleanup();
});

function setInputValue(input: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  fireEvent.input(input, { bubbles: true });
  fireEvent.change(input, { bubbles: true });
}

describe("AgentSettingsView model overrides", () => {
  test("creates a new agent with an OpenRouter model override", async () => {
    const view = render(React.createElement(AgentSettingsView, { userKey: "user.test" }));

    await waitFor(() => expect(view.getByRole("button", { name: "New Agent" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "New Agent" }));
    fireEvent.click(await view.findByRole("button", { name: /Business Operator/ }));

    setInputValue(view.getByLabelText("Name"), "GLM Analyst");
    fireEvent.click(view.getByLabelText("Use custom model"));
    fireEvent.change(view.getByLabelText("Provider"), { target: { value: "openrouter" } });
    await waitFor(() => {
      expect((view.getByLabelText("Provider") as HTMLSelectElement).value).toBe("openrouter");
    });
    fireEvent.change(view.getByLabelText("Model"), { target: { value: "z-ai/glm-4.6" } });
    await waitFor(() => {
      expect((view.getByLabelText("Model") as HTMLSelectElement).value).toBe("z-ai/glm-4.6");
    });
    fireEvent.change(view.getByLabelText("Thinking level"), { target: { value: "high" } });
    fireEvent.click(view.getByRole("button", { name: "Save Agent" }));

    await waitFor(() => {
      const createCall = invokeCalls.find((call) => call.command === "agent_profile_create");
      expect(createCall?.args?.userKey).toBe("user.test");
      expect(createCall?.args?.request?.model).toEqual({
        mode: "override",
        provider: {
          provider: "openrouter",
          model: "z-ai/glm-4.6",
          apiKeyEnv: "OPENROUTER_API_KEY",
          thinkingLevel: "high",
        },
      });
    });
  });

  test("updates an existing agent to use a Codex model override", async () => {
    const view = render(React.createElement(AgentSettingsView, { userKey: "user.test" }));

    fireEvent.click(await view.findByRole("button", { name: /Router Analyst/ }));
    expect(view.getByText("OpenRouter / qwen/qwen3-coder / Thinking medium")).toBeTruthy();

    fireEvent.change(view.getByLabelText("Provider"), { target: { value: "openai-codex" } });
    await waitFor(() => {
      expect((view.getByLabelText("Provider") as HTMLSelectElement).value).toBe("openai-codex");
    });
    fireEvent.change(view.getByLabelText("Model"), { target: { value: "gpt-5.5" } });
    await waitFor(() => {
      expect((view.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.5");
    });
    fireEvent.click(view.getByRole("button", { name: "Save Agent" }));

    await waitFor(() => {
      const updateCall = invokeCalls.find((call) => call.command === "agent_profile_update");
      expect(updateCall?.args?.userKey).toBe("user.test");
      expect(updateCall?.args?.request?.model).toEqual({
        mode: "override",
        provider: {
          provider: "openai-codex",
          model: "gpt-5.5",
        },
      });
    });
  });

  test("hides thinking level for local model overrides", async () => {
    const view = render(React.createElement(AgentSettingsView, { userKey: "user.test" }));

    fireEvent.click(await view.findByRole("button", { name: /Router Analyst/ }));
    fireEvent.change(view.getByLabelText("Provider"), { target: { value: "local" } });

    await waitFor(() => {
      expect((view.getByLabelText("Provider") as HTMLSelectElement).value).toBe("local");
    });
    expect(view.queryByLabelText("Thinking level")).toBeNull();
  });
});
