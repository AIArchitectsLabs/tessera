import { describe, expect, test } from "bun:test";
import { loadPlaybookManifest } from "./playbook-loader.js";

const baseManifest = {
  schemaVersion: 1,
  meta: { id: "demo", version: 1, name: "Demo" },
  workflow: {
    id: "demo",
    version: 1,
    name: "Demo",
    start: "ping",
    inputs: {},
    steps: [
      {
        id: "ping",
        kind: "tool",
        toolId: "workspace.ping",
        args: {},
        onSuccess: "completed",
      },
    ],
  },
};

describe("loadPlaybookManifest", () => {
  test("loads a tool-only manifest with no prompts", () => {
    const manifest = loadPlaybookManifest({ manifestJson: baseManifest });
    expect(manifest.meta.id).toBe("demo");
    const step = manifest.workflow.steps[0];
    if (!step) throw new Error("expected step");
    expect(step.id).toBe("ping");
  });

  test("resolves file: prompt references against the prompts map", () => {
    const manifest = loadPlaybookManifest({
      manifestJson: {
        ...baseManifest,
        workflow: {
          ...baseManifest.workflow,
          start: "draft",
          steps: [
            {
              id: "draft",
              kind: "agent",
              prompt: "file:prompts/draft.md",
              onSuccess: "completed",
            },
          ],
        },
      },
      prompts: { "prompts/draft.md": "Draft a summary." },
    });
    const step = manifest.workflow.steps[0];
    if (!step) throw new Error("expected step");
    if (step.kind !== "agent") throw new Error("expected agent step");
    expect(step.prompt).toBe("Draft a summary.");
  });

  test("leaves literal prompts unchanged", () => {
    const manifest = loadPlaybookManifest({
      manifestJson: {
        ...baseManifest,
        workflow: {
          ...baseManifest.workflow,
          start: "draft",
          steps: [
            {
              id: "draft",
              kind: "agent",
              prompt: "Draft a summary.",
              onSuccess: "completed",
            },
          ],
        },
      },
    });
    const step = manifest.workflow.steps[0];
    if (!step) throw new Error("expected step");
    if (step.kind !== "agent") throw new Error("expected agent step");
    expect(step.prompt).toBe("Draft a summary.");
  });

  test("rejects unresolved file: references", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: {
            ...baseManifest.workflow,
            start: "draft",
            steps: [
              {
                id: "draft",
                kind: "agent",
                prompt: "file:prompts/missing.md",
                onSuccess: "completed",
              },
            ],
          },
        },
        prompts: {},
      })
    ).toThrow(/prompts\/missing\.md/);
  });

  test("rejects prompt references that escape the prompts/ directory", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: {
            ...baseManifest.workflow,
            start: "draft",
            steps: [
              {
                id: "draft",
                kind: "agent",
                prompt: "file:../escape.md",
                onSuccess: "completed",
              },
            ],
          },
        },
        prompts: { "../escape.md": "nope" },
      })
    ).toThrow(/prompts\//);
  });

  test("rejects manifests with an unknown start step", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: { ...baseManifest.workflow, start: "ghost" },
        },
      })
    ).toThrow(/Unknown workflow start step/);
  });

  test("rejects transitions to unknown steps", () => {
    expect(() =>
      loadPlaybookManifest({
        manifestJson: {
          ...baseManifest,
          workflow: {
            ...baseManifest.workflow,
            steps: [
              {
                id: "ping",
                kind: "tool",
                toolId: "workspace.ping",
                args: {},
                onSuccess: "ghost",
              },
            ],
          },
        },
      })
    ).toThrow(/Unknown workflow transition/);
  });
});
