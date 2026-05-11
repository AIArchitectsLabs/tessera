import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLayoutScript } from "./layout-runner.js";

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
