import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDashboardLayout, runLayoutScript } from "./layout-runner.js";

async function makeScript(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "layout-script-"));
  const path = join(dir, "render.ts");
  writeFileSync(path, content);
  return path;
}

describe("runLayoutScript", () => {
  test("returns the validated layout on success", async () => {
    const scriptPath = await makeScript(`
      const input = JSON.parse(await Bun.stdin.text());
      const layout = {
        sections: [
          { type: "text", title: "Summary", binding: "step1.summary" }
        ]
      };
      process.stdout.write(JSON.stringify(layout));
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.layout.sections).toHaveLength(1);
    }
  });

  test("returns timeout on a script that hangs", async () => {
    const scriptPath = await makeScript(`
      await new Promise((r) => setTimeout(r, 60000));
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
      timeoutMs: 500,
    });
    expect(result.kind).toBe("timeout");
  });

  test("returns validation_failed when stdout is not a valid layout", async () => {
    const scriptPath = await makeScript(`
      process.stdout.write(JSON.stringify({ not: "a layout" }));
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
    });
    expect(result.kind).toBe("validation_failed");
  });

  test("returns crash when the script throws", async () => {
    const scriptPath = await makeScript(`
      throw new Error("boom");
    `);
    const result = await runLayoutScript({
      scriptPath,
      input: { outputs: {}, meta: { runId: "r", completedAt: "now", playbookId: "p" } },
    });
    expect(result.kind).toBe("crash");
  });
});

describe("generateDashboardLayout", () => {
  test("loads a static dashboard layout relative to the package root", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "dashboard-package-"));
    mkdirSync(join(packageRoot, "layouts"));
    writeFileSync(
      join(packageRoot, "layouts", "dashboard.json"),
      JSON.stringify({
        sections: [{ type: "text", title: "Summary", binding: "step1.summary" }],
      })
    );

    const layout = await generateDashboardLayout({
      definition: {
        id: "ops.dashboard",
        version: 1,
        name: "Dashboard",
        requiredCapabilities: [],
        optionalCapabilities: [],
        inputs: {},
        start: "completed",
        outputs: [{ kind: "dashboard", label: "Dashboard", layout: "layouts/dashboard.json" }],
        steps: [
          { id: "noop", kind: "tool", toolId: "workspace.ping", args: {}, onSuccess: "completed" },
        ],
      },
      packageRoot,
      outputs: { step1: { summary: "hello" } },
      runId: "run-1",
      completedAt: "2026-05-11T00:00:00.000Z",
    });

    expect(layout?.sections).toHaveLength(1);
  });

  test("rejects static layout paths outside the package root", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "dashboard-package-"));

    const layout = await generateDashboardLayout({
      definition: {
        id: "ops.dashboard",
        version: 1,
        name: "Dashboard",
        requiredCapabilities: [],
        optionalCapabilities: [],
        inputs: {},
        start: "completed",
        outputs: [{ kind: "dashboard", label: "Dashboard", layout: "../dashboard.json" }],
        steps: [
          { id: "noop", kind: "tool", toolId: "workspace.ping", args: {}, onSuccess: "completed" },
        ],
      },
      packageRoot,
      outputs: {},
      runId: "run-1",
      completedAt: "2026-05-11T00:00:00.000Z",
    });

    expect(layout).toBeNull();
  });
});
