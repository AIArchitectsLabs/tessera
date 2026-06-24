/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TaskDetail, TaskEvent } from "@tessera/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
  globals.Text = dom.window.Text as never;
  globals.Event = dom.window.Event as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
}

installDom();

type Listener = (event: { payload: string }) => void;

const listeners = new Map<string, Listener>();
const unlistenCalls: string[] = [];
const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let snapshots: TaskDetail[] = [];
let subscribeFailuresRemaining = 0;

const invoke = mock(async (command: string, args?: Record<string, unknown>) => {
  invokeCalls.push(args === undefined ? { command } : { command, args });
  if (command === "task_subscribe") {
    if (subscribeFailuresRemaining > 0) {
      subscribeFailuresRemaining -= 1;
      throw new Error("stream unavailable");
    }
    return null;
  }
  if (command === "task_get") {
    const snapshot = snapshots.shift();
    if (!snapshot) throw new Error("missing snapshot");
    return snapshot;
  }
  if (command === "task_unsubscribe") {
    return null;
  }
  throw new Error(`Unexpected invoke command: ${command}`);
});

const listen = mock(async (eventName: string, listener: Listener) => {
  listeners.set(eventName, listener);
  return () => {
    listeners.delete(eventName);
    unlistenCalls.push(eventName);
  };
});

mock.module("@tauri-apps/api/core", () => ({
  invoke,
}));

mock.module("@tauri-apps/api/event", () => ({
  listen,
}));

const { useTaskEvents } = await import("./useTaskEvents");

function taskDetail(id: string, updatedAt = "2026-05-01T00:00:00.000Z"): TaskDetail {
  return {
    id,
    workspaceRoot: "/workspace",
    title: "Task",
    status: "active",
    agentId: "default",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt,
    notifications: [],
    auditRecords: [],
    activeSkills: [],
    turns: [],
    artifacts: [],
  };
}

function Harness({
  taskId,
  onEvent,
  onReconnect,
  onSnapshot,
}: {
  taskId: string | null;
  onEvent: (event: TaskEvent) => void;
  onReconnect: () => void;
  onSnapshot: (task: TaskDetail) => void;
}) {
  useTaskEvents({ taskId, onEvent, onReconnect, onSnapshot });
  return null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  listeners.clear();
  unlistenCalls.length = 0;
  invokeCalls.length = 0;
  snapshots = [];
  subscribeFailuresRemaining = 0;
  invoke.mockClear();
  listen.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useTaskEvents", () => {
  test("subscribes and loads an initial snapshot", async () => {
    const receivedSnapshots: TaskDetail[] = [];
    const onEvent = mock(() => undefined);
    const onReconnect = mock(() => undefined);
    const onSnapshot = mock((task: TaskDetail) => {
      receivedSnapshots.push(task);
    });
    snapshots = [taskDetail("task-1")];

    render(
      <Harness
        taskId="task-1"
        onEvent={onEvent}
        onReconnect={onReconnect}
        onSnapshot={onSnapshot}
      />
    );

    await waitFor(() => {
      expect(onSnapshot).toHaveBeenCalledTimes(1);
    });

    expect(invokeCalls.map((call) => call.command)).toEqual(["task_subscribe", "task_get"]);
    expect(listen).toHaveBeenCalledWith("task:event:task-1", expect.any(Function));
    expect(listen).toHaveBeenCalledWith("task:event:task-1:closed", expect.any(Function));
    expect(receivedSnapshots[0]?.id).toBe("task-1");
    expect(onEvent).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  test("retries a closed stream and refreshes the snapshot", async () => {
    const receivedSnapshots: TaskDetail[] = [];
    const onEvent = mock(() => undefined);
    const onReconnect = mock(() => undefined);
    const onSnapshot = mock((task: TaskDetail) => {
      receivedSnapshots.push(task);
    });
    snapshots = [
      taskDetail("task-1", "2026-05-01T00:00:00.000Z"),
      taskDetail("task-1", "2026-05-01T00:01:00.000Z"),
    ];

    render(
      <Harness
        taskId="task-1"
        onEvent={onEvent}
        onReconnect={onReconnect}
        onSnapshot={onSnapshot}
      />
    );

    await waitFor(() => {
      expect(onSnapshot).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      listeners.get("task:event:task-1:closed")?.({ payload: "" });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await waitFor(() => {
      expect(onSnapshot).toHaveBeenCalledTimes(2);
    });

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(invokeCalls.map((call) => call.command)).toEqual([
      "task_subscribe",
      "task_get",
      "task_subscribe",
      "task_get",
    ]);
    expect(receivedSnapshots[1]?.updatedAt).toBe("2026-05-01T00:01:00.000Z");
  });

  test("backs off after subscribe failure and keeps retrying", async () => {
    const onEvent = mock(() => undefined);
    const onReconnect = mock(() => undefined);
    const onSnapshot = mock(() => undefined);
    snapshots = [taskDetail("task-1", "2026-05-01T00:02:00.000Z")];
    subscribeFailuresRemaining = 1;

    render(
      <Harness
        taskId="task-1"
        onEvent={onEvent}
        onReconnect={onReconnect}
        onSnapshot={onSnapshot}
      />
    );

    await waitFor(
      () => {
        expect(onSnapshot).toHaveBeenCalledTimes(1);
      },
      { timeout: 1_000 }
    );

    expect(invokeCalls.map((call) => call.command)).toEqual([
      "task_subscribe",
      "task_subscribe",
      "task_get",
    ]);
  });

  test("unsubscribes listeners and stream on cleanup", async () => {
    const onEvent = mock(() => undefined);
    const onReconnect = mock(() => undefined);
    const onSnapshot = mock(() => undefined);
    snapshots = [taskDetail("task-1")];

    const view = render(
      <Harness
        taskId="task-1"
        onEvent={onEvent}
        onReconnect={onReconnect}
        onSnapshot={onSnapshot}
      />
    );

    await waitFor(() => {
      expect(onSnapshot).toHaveBeenCalledTimes(1);
    });

    view.unmount();

    expect(unlistenCalls).toEqual(["task:event:task-1", "task:event:task-1:closed"]);
    expect(invokeCalls[invokeCalls.length - 1]).toEqual({
      command: "task_unsubscribe",
      args: { taskId: "task-1" },
    });
  });
});
