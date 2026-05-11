import { type DashboardLayout, DashboardLayoutSchema } from "@tessera/contracts";

export interface RunLayoutScriptOptions {
  scriptPath: string;
  input: {
    outputs: Record<string, unknown>;
    meta: { runId: string; completedAt: string; playbookId: string };
  };
  timeoutMs?: number;
}

export type RunLayoutScriptResult =
  | { kind: "success"; layout: DashboardLayout }
  | { kind: "timeout" }
  | { kind: "validation_failed"; error: string }
  | { kind: "crash"; error: string };

const DEFAULT_TIMEOUT_MS = 5000;

export async function runLayoutScript(
  options: RunLayoutScriptOptions
): Promise<RunLayoutScriptResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = Bun.spawn(["bun", "run", options.scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  proc.stdin.write(JSON.stringify(options.input));
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timeout);

  if (timedOut) return { kind: "timeout" };
  if (proc.exitCode !== 0) return { kind: "crash", error: stderr || "non-zero exit" };

  try {
    const parsed = JSON.parse(stdout);
    const layout = DashboardLayoutSchema.parse(parsed);
    return { kind: "success", layout };
  } catch (err) {
    return { kind: "validation_failed", error: err instanceof Error ? err.message : String(err) };
  }
}
