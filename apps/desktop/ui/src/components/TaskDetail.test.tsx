/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentProfileListResult,
  SkillListResult,
  TaskDetail as TaskDetailType,
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
  globals.HTMLDivElement = dom.window.HTMLDivElement as never;
  globals.HTMLTextAreaElement = dom.window.HTMLTextAreaElement as never;
  globals.SVGElement = dom.window.SVGElement as never;
  globals.Text = dom.window.Text as never;
  globals.Event = dom.window.Event as never;
  globals.KeyboardEvent = dom.window.KeyboardEvent as never;
  globals.MouseEvent = dom.window.MouseEvent as never;
  globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window) as never;
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(cb, 0)) as never;
  globals.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    value: () => undefined,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    value: () => undefined,
  });
}

installDom();

type InvokeCall = {
  command: string;
  args?: Record<string, unknown>;
};

const invokeCalls: InvokeCall[] = [];
let skillListMode: "normal" | "empty" | "error" | "pending" = "normal";
let fileTreeMode: "normal" | "empty" | "error" = "normal";

const invoke = async (command: string, args?: Record<string, unknown>) => {
  invokeCalls.push({ command, args: args ? JSON.parse(JSON.stringify(args)) : undefined });
  switch (command) {
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
            skills: ["planning", "word-docs", "pdf-workflows"],
            toolPolicyPreset: "workspace_editor",
            memoryDefaults: "",
            createdAt: "2026-05-07T00:00:00.000Z",
            updatedAt: "2026-05-07T00:00:00.000Z",
          },
          {
            id: "agent-1",
            name: "Operator",
            model: { mode: "default" },
            instructions: "",
            soul: "",
            userContext: "",
            skills: ["word-docs", "pdf-workflows"],
            toolPolicyPreset: "workspace_editor",
            memoryDefaults: "",
            createdAt: "2026-05-07T00:00:00.000Z",
            updatedAt: "2026-05-07T00:00:00.000Z",
          },
        ],
      } satisfies AgentProfileListResult;
    case "skill_list":
      if (skillListMode === "pending") {
        return await new Promise<SkillListResult>(() => undefined);
      }
      if (skillListMode === "error") {
        throw new Error("Skill load failed");
      }
      if (skillListMode === "empty") {
        return { skills: [] } satisfies SkillListResult;
      }
      if (args?.agentId === "default") {
        return {
          skills: [
            {
              id: "planning",
              name: "planning",
              description: "Plan multi-step business work.",
              source: "curated",
            },
            {
              id: "word-docs",
              name: "word-docs",
              description: "Create Word-style business documents.",
              source: "curated",
            },
          ],
        } satisfies SkillListResult;
      }
      if (args?.agentId === "agent-1") {
        return {
          skills: [
            {
              id: "word-docs",
              name: "word-docs",
              description: "Create Word-style business documents.",
              source: "curated",
            },
            {
              id: "pdf-workflows",
              name: "pdf-workflows",
              description: "Review PDF-based business artifacts.",
              source: "curated",
            },
          ],
        } satisfies SkillListResult;
      }
      return {
        skills: [
          {
            id: "word-docs",
            name: "word-docs",
            description: "Create Word-style business documents.",
            source: "curated",
          },
          {
            id: "pdf-workflows",
            name: "pdf-workflows",
            description: "Review PDF-based business artifacts.",
            source: "curated",
          },
          {
            id: "spreadsheets",
            name: "spreadsheets",
            description: "Analyze spreadsheet-based work.",
            source: "curated",
          },
        ],
      } satisfies SkillListResult;
    default:
      throw new Error(`Unexpected invoke command: ${command}`);
  }
};

mock.module("@tauri-apps/api/core", () => ({
  invoke,
}));

const readDir = mock(async (path: string) => {
  if (fileTreeMode === "error") {
    throw new Error("File load failed");
  }
  if (fileTreeMode === "empty") {
    return [];
  }
  if (path === "/tmp/workspace") {
    return [
      { name: "README.md", isDirectory: false },
      { name: "src", isDirectory: true },
      { name: ".git", isDirectory: true },
    ];
  }
  if (path === "/tmp/workspace/src") {
    return [
      { name: "app.ts", isDirectory: false },
      { name: "nested", isDirectory: true },
    ];
  }
  if (path === "/tmp/workspace/src/nested") {
    return [{ name: "plan.md", isDirectory: false }];
  }
  return [];
});

mock.module("@tauri-apps/plugin-fs", () => ({
  readDir,
}));

const { TaskDetail } = await import("./TaskDetail");

function taskDetail(): TaskDetailType {
  return {
    id: "task-1",
    workspaceRoot: "/tmp/workspace",
    title: "Draft a memo",
    status: "done",
    agentId: "agent-1",
    agentLabel: "Operator",
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    notifications: [],
    auditRecords: [],
    activeSkills: [],
    turns: [],
    artifacts: [],
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  invokeCalls.length = 0;
  readDir.mockClear();
  skillListMode = "normal";
  fileTreeMode = "normal";
});

afterEach(() => {
  cleanup();
});

function renderTaskDetail(overrides: Partial<React.ComponentProps<typeof TaskDetail>> = {}) {
  const onCreateTask = mock(async () => undefined);
  const onCreateTurn = mock(async () => undefined);
  const props: React.ComponentProps<typeof TaskDetail> = {
    creatingTask: false,
    loading: false,
    onClarifyResolve: async () => undefined,
    onCreateTask,
    onCreateTurn,
    onSelectTask: () => undefined,
    onSkillRemove: async () => undefined,
    onTodoUpdate: async () => undefined,
    sendingTurn: false,
    task: taskDetail(),
    tasks: [],
    userKey: "user.test",
    workspaceRoot: "/tmp/workspace",
    ...overrides,
  };

  return { view: render(React.createElement(TaskDetail, props)), onCreateTask, onCreateTurn };
}

function typeComposerValue(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.input(textarea, { target: { value } });
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.select(textarea);
}

describe("TaskDetail composer", () => {
  test("opens the slash menu immediately while enabled skills load", async () => {
    skillListMode = "pending";
    const { view } = renderTaskDetail({ task: null });
    const textarea = view.getByPlaceholderText("How can I help you today?") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/");

    await view.findByText("Loading enabled skills...");
  });

  test("shows slash completions in the new-task composer for the default agent", async () => {
    const { view } = renderTaskDetail({ task: null });
    const textarea = view.getByPlaceholderText("How can I help you today?") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/");

    await view.findByText("/planning");
    expect(view.getByText("/word-docs")).toBeTruthy();
    expect(
      invokeCalls.some(
        (call) =>
          call.command === "skill_list" &&
          call.args?.agentId === "default" &&
          call.args?.userKey === "user.test" &&
          call.args?.workspaceRoot === "/tmp/workspace"
      )
    ).toBe(true);
  });

  test("keeps the slash menu visible when no skills are enabled", async () => {
    skillListMode = "empty";
    const { view } = renderTaskDetail({ task: null });
    const textarea = view.getByPlaceholderText("How can I help you today?") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/");

    await view.findByText("No skills enabled for Tessera.");
  });

  test("keeps the slash menu visible when enabled skills fail to load", async () => {
    skillListMode = "error";
    const { view } = renderTaskDetail({ task: null });
    const textarea = view.getByPlaceholderText("How can I help you today?") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/");

    await view.findByText("Could not load enabled skills.");
  });

  test("shows slash completions for the selected agent's enabled skills", async () => {
    const { view } = renderTaskDetail();
    const textarea = view.getByPlaceholderText("Write a message...") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/");

    await view.findByText("/word-docs");
    expect(view.getByText("/pdf-workflows")).toBeTruthy();
    expect(view.queryByText("/spreadsheets")).toBeNull();
    expect(
      invokeCalls.some(
        (call) =>
          call.command === "skill_list" &&
          call.args?.agentId === "agent-1" &&
          call.args?.userKey === "user.test" &&
          call.args?.workspaceRoot === "/tmp/workspace"
      )
    ).toBe(true);
  });

  test("omits redundant progress and working folder sections from the side pane", () => {
    const { view } = renderTaskDetail({
      task: {
        ...taskDetail(),
        todo: {
          items: [{ id: "todo-1", label: "Draft outline", status: "pending", order: 1 }],
          updatedAt: "2026-05-07T00:00:00.000Z",
        },
      },
    });

    expect(view.queryByText("Progress")).toBeNull();
    expect(view.queryByText("Working folder")).toBeNull();
    expect(view.getByText("Todo")).toBeTruthy();
    expect(view.getByText("Agent Context")).toBeTruthy();
  });

  test("expands hidden context items from the side pane", () => {
    const artifacts = Array.from({ length: 14 }, (_, index) => ({
      id: `artifact-${index + 1}`,
      taskId: "task-1",
      kind: "text" as const,
      title: `Context Item ${index + 1}`,
      contentPreview: `Preview ${index + 1}`,
      createdAt: "2026-05-07T00:00:00.000Z",
    }));
    const { view } = renderTaskDetail({ task: { ...taskDetail(), artifacts } });

    expect(view.getByText("Context Item 1")).toBeTruthy();
    expect(view.queryByText("Context Item 14")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "+10 more context items." }));

    expect(view.getByText("Context Item 14")).toBeTruthy();
    expect(view.queryByRole("button", { name: "+10 more context items." })).toBeNull();
  });

  test("autocompletes a highlighted slash skill without sending the message", async () => {
    const { view, onCreateTurn } = renderTaskDetail();
    const textarea = view.getByPlaceholderText("Write a message...") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/");
    await view.findByText("/word-docs");
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("/word-docs ");
    });
    expect(onCreateTurn).not.toHaveBeenCalled();
  });

  test("supports generic /skill completions", async () => {
    const { view, onCreateTurn } = renderTaskDetail();
    const textarea = view.getByPlaceholderText("Write a message...") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/skill ");
    await view.findByText("/skill word-docs");
    expect(view.getByText("/skill pdf-workflows")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("/skill word-docs ");
    });
    expect(onCreateTurn).not.toHaveBeenCalled();
  });

  test("does not send a bare slash while the slash menu has no selectable skill", async () => {
    skillListMode = "empty";
    const { view, onCreateTask, onCreateTurn } = renderTaskDetail({ task: null });
    const textarea = view.getByPlaceholderText("How can I help you today?") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/");
    await view.findByText("No skills enabled for Tessera.");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onCreateTask).not.toHaveBeenCalled();
    expect(onCreateTurn).not.toHaveBeenCalled();
  });

  test("sends a slash command after the user adds instruction text", async () => {
    const { view, onCreateTurn } = renderTaskDetail();
    const textarea = view.getByPlaceholderText("Write a message...") as HTMLTextAreaElement;

    typeComposerValue(textarea, "/word-docs Draft the memo");
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onCreateTurn).toHaveBeenCalledWith("/word-docs Draft the memo");
    });
  });

  test("sends a message when Enter is pressed", async () => {
    const { view, onCreateTurn } = renderTaskDetail();
    const textarea = view.getByPlaceholderText("Write a message...") as HTMLTextAreaElement;

    typeComposerValue(textarea, "Please draft the memo");
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onCreateTurn).toHaveBeenCalledWith("Please draft the memo");
    });
  });

  test("shows workspace file completions for @ mentions", async () => {
    const { view } = renderTaskDetail();
    const textarea = view.getByPlaceholderText("Write a message...") as HTMLTextAreaElement;

    typeComposerValue(textarea, "Review @src/");

    await waitFor(() => {
      expect(view.getByText("@src/app.ts")).toBeTruthy();
    });
    expect(view.getByText("@src/nested/plan.md")).toBeTruthy();
    expect(view.queryByText("@.git")).toBeNull();
  });

  test("inserts a workspace file mention without sending the message", async () => {
    const { view, onCreateTurn } = renderTaskDetail();
    const textarea = view.getByPlaceholderText("Write a message...") as HTMLTextAreaElement;

    typeComposerValue(textarea, "Review @src/app");

    await waitFor(() => {
      expect(view.getByText("@src/app.ts")).toBeTruthy();
    });

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("Review @src/app.ts ");
    });
    expect(onCreateTurn).not.toHaveBeenCalled();
  });
});
