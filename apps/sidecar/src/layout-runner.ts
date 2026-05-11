import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type DashboardLayout,
  DashboardLayoutSchema,
  type WorkflowDefinition,
} from "@tessera/contracts";
import { BUILTIN_DASHBOARD_LAYOUTS } from "@tessera/core";

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

export async function generateDashboardLayout(options: {
  definition: WorkflowDefinition;
  packageRoot: string;
  outputs: Record<string, unknown>;
  runId: string;
  completedAt: string;
}): Promise<DashboardLayout | null> {
  const dashboardOutput = options.definition.outputs?.find((output) => output.kind === "dashboard");
  if (!dashboardOutput) return null;

  const packageRoot = resolve(options.packageRoot);
  if (dashboardOutput.layoutScript) {
    const scriptPath = resolve(packageRoot, dashboardOutput.layoutScript);
    if (!isInsidePackageRoot(packageRoot, scriptPath)) return null;

    const result = await runLayoutScript({
      scriptPath,
      input: {
        outputs: options.outputs,
        meta: {
          runId: options.runId,
          completedAt: options.completedAt,
          playbookId: options.definition.id,
        },
      },
    });
    return result.kind === "success" ? result.layout : null;
  }

  if (dashboardOutput.layout) {
    const layoutPath = resolve(packageRoot, dashboardOutput.layout);
    if (!isInsidePackageRoot(packageRoot, layoutPath)) {
      return BUILTIN_DASHBOARD_LAYOUTS[options.definition.id] ?? null;
    }

    try {
      const raw = JSON.parse(readFileSync(layoutPath, "utf8"));
      return DashboardLayoutSchema.parse(raw);
    } catch {
      return BUILTIN_DASHBOARD_LAYOUTS[options.definition.id] ?? null;
    }
  }

  return BUILTIN_DASHBOARD_LAYOUTS[options.definition.id] ?? null;
}

function isInsidePackageRoot(packageRoot: string, path: string): boolean {
  const fromRoot = relative(packageRoot, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
