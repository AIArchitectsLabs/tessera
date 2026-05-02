import { describe, expect, it, mock } from "bun:test";
import type { TaskEvent } from "@tessera/contracts";
import { createTaskEventBus } from "./task-event-bus";

const makeEvent = (taskId = "task-1"): TaskEvent => ({
  type: "task.updated",
  taskId,
  emittedAt: new Date().toISOString(),
  task: {
    id: taskId,
    workspaceRoot: "/workspace",
    title: "Test",
    status: "active",
    agentId: "default",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});

describe("TaskEventBus", () => {
  it("subscribe receives published events", () => {
    const bus = createTaskEventBus();
    const subscriber = mock(() => {});
    bus.subscribe("task-1", subscriber);
    const event = makeEvent("task-1");
    bus.publish("task-1", event);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(event);
  });

  it("multiple subscribers all receive", () => {
    const bus = createTaskEventBus();
    const sub1 = mock(() => {});
    const sub2 = mock(() => {});
    bus.subscribe("task-1", sub1);
    bus.subscribe("task-1", sub2);
    const event = makeEvent("task-1");
    bus.publish("task-1", event);
    expect(sub1).toHaveBeenCalledTimes(1);
    expect(sub2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createTaskEventBus();
    const subscriber = mock(() => {});
    const unsubscribe = bus.subscribe("task-1", subscriber);
    unsubscribe();
    bus.publish("task-1", makeEvent("task-1"));
    expect(subscriber).toHaveBeenCalledTimes(0);
  });

  it("publish to absent taskId is a no-op", () => {
    const bus = createTaskEventBus();
    expect(() => bus.publish("no-such-task", makeEvent("no-such-task"))).not.toThrow();
  });

  it("throwing subscriber does not break others", () => {
    const bus = createTaskEventBus();
    const throwing = mock(() => {
      throw new Error("boom");
    });
    const surviving = mock(() => {});
    bus.subscribe("task-1", throwing);
    bus.subscribe("task-1", surviving);
    const event = makeEvent("task-1");
    bus.publish("task-1", event);
    expect(surviving).toHaveBeenCalledTimes(1);
    expect(surviving).toHaveBeenCalledWith(event);
  });
});
