import { describe, expect, test } from "bun:test";
import type { PlaybookGraphNode } from "@tessera/contracts";
import { PlaybookGraphRunRecordSchema } from "@tessera/contracts";
import {
  type PlaybookGraphScriptAdapterInput,
  compilePlaybookGraph,
  createPlaybookGraphQueueEntry,
  createPlaybookGraphSnapshot,
  hardTimeoutMs,
} from "@tessera/core";
import {
  SCRIPT_RUNNER_DEFAULT_TIMEOUT_MS,
  runPlaybookGraphScript,
} from "./playbook-graph-script-runner.js";

const now = "2026-05-15T00:00:00.000Z";

function scriptInput(
  scriptSource: string,
  extraSourceFiles: Record<string, string> = {}
): PlaybookGraphScriptAdapterInput {
  const sourceFiles = {
    "playbook.ts": "export default graph;\n",
    "scripts/score.ts": scriptSource,
    ...extraSourceFiles,
  };
  const compiledGraph = compilePlaybookGraph({
    graph: {
      schemaVersion: 1,
      id: "content.script-runner",
      version: "0.1.0",
      name: "Script Runner",
      artifacts: { scorecard: { schema: "schemas/scorecard.schema.json" } },
      start: "score",
      nodes: [
        {
          id: "score",
          kind: "script",
          run: "scripts/score.ts",
          inputs: {},
          outputArtifact: "scorecard",
          onSuccess: "completed",
        },
      ],
    },
    sourceFiles,
    compilerVersion: "server-test",
    scriptSdkVersion: "server-test",
    compiledAt: now,
  });
  const node = compiledGraph.graph.nodes[0] as Extract<PlaybookGraphNode, { kind: "script" }>;
  const run = PlaybookGraphRunRecordSchema.parse({
    schemaVersion: 1,
    runId: "run-script",
    playbookId: compiledGraph.graph.id,
    status: "running",
    input: { topic: "durability" },
    snapshot: createPlaybookGraphSnapshot({ compiledGraph, sourceFiles }),
    startedAt: now,
    updatedAt: now,
  });

  return {
    run,
    node,
    queueEntry: createPlaybookGraphQueueEntry({
      runId: run.runId,
      node,
      nodePath: node.id,
      now,
    }),
    input: run.input,
    artifacts: { brief: { title: "Pinned" } },
  };
}

describe("runPlaybookGraphScript", () => {
  test("uses the runtime script hard timeout by default", () => {
    const scriptHardTimeoutMs = hardTimeoutMs("script");
    if (scriptHardTimeoutMs === undefined) throw new Error("Expected script hard timeout");
    expect(SCRIPT_RUNNER_DEFAULT_TIMEOUT_MS).toBe(scriptHardTimeoutMs);
  });

  test("executes a pinned TypeScript script with relative imports", async () => {
    const output = await runPlaybookGraphScript({
      input: scriptInput(
        `import { titleCase } from "./helpers";
export default ({ input, artifacts }) => ({
  topic: titleCase(input.topic),
  title: artifacts.brief.title,
});
`,
        {
          "scripts/helpers.ts": `export function titleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
`,
        }
      ),
    });

    expect(output).toEqual({ topic: "Durability", title: "Pinned" });
  });

  test("resolves the plugin SDK from the production runner temp directory", async () => {
    const output = await runPlaybookGraphScript({
      input: scriptInput(`import { definePlaybook } from "@tessera/plugin-sdk";
export default () => ({
  graphId: definePlaybook({
    schemaVersion: 1,
    id: "content.sdk-import",
    version: "0.1.0",
    name: "SDK Import",
    start: "done",
    nodes: [{ id: "done", kind: "join", onSuccess: "completed" }],
  }).id,
});
`),
    });

    expect(output).toEqual({ graphId: "content.sdk-import" });
  });

  test("rejects source bundles that do not match pinned hashes", async () => {
    const input = scriptInput("export default () => ({ ok: true });\n");
    const sourceFiles = { ...input.run.snapshot.sourceFiles, "scripts/score.ts": "changed\n" };

    await expect(
      runPlaybookGraphScript({
        input: {
          ...input,
          run: {
            ...input.run,
            snapshot: { ...input.run.snapshot, sourceFiles },
          },
        },
      })
    ).rejects.toThrow(/source bundle hash mismatch|source file hash mismatch/);
  });

  test("rejects dangerous imports before execution", async () => {
    await expect(
      runPlaybookGraphScript({
        input: scriptInput('import { readFileSync } from "node:fs";\nexport default () => ({});\n'),
      })
    ).rejects.toThrow(/Dangerous imports/);
  });

  test("rejects direct runtime escape globals before execution", async () => {
    await expect(
      runPlaybookGraphScript({
        input: scriptInput("export default () => ({ env: process.env.HOME });\n"),
      })
    ).rejects.toThrow(/Runtime global process/);
    await expect(
      runPlaybookGraphScript({
        input: scriptInput("export default () => Bun.file('/etc/passwd').text();\n"),
      })
    ).rejects.toThrow(/Runtime global Bun/);
  });

  test("rejects global object escape attempts before execution", async () => {
    await expect(
      runPlaybookGraphScript({
        input: scriptInput("export default () => globalThis.Bun.file('/etc/passwd').text();\n"),
      })
    ).rejects.toThrow(/Runtime global globalThis/);
  });

  test("scrubs inherited environment from the script process", async () => {
    const output = await runPlaybookGraphScript({
      input: scriptInput("export default () => ({ ok: true });\n"),
    });

    expect(output).toEqual({ ok: true });
  });

  test("reports script errors without runner-exit noise", async () => {
    let error: unknown;
    try {
      await runPlaybookGraphScript({
        input: scriptInput("export default () => { throw new Error('Missing bodyMarkdown'); };\n"),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Graph script failed: Missing bodyMarkdown");
    expect(String(error)).not.toContain("process.exit");
  });

  test("times out scripts that do not finish", async () => {
    await expect(
      runPlaybookGraphScript({
        input: scriptInput("export default async () => await new Promise(() => {});\n"),
        timeoutMs: 20,
      })
    ).rejects.toThrow(/timed out/);
  });
});
