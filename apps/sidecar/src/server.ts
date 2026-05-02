import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTurnRequestSchema,
  SidecarReadySchema,
  SpawnRequestSchema,
  type SpawnResult,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskListResultSchema,
  TaskUpdateRequestSchema,
  WorkflowResumeRequestSchema,
  WorkflowRunListResultSchema,
  WorkflowRunRequestSchema,
} from "@tessera/contracts";
import { DEMO_WORKFLOW, executeAgentTurn, resumeWorkflowRun, runWorkflow } from "@tessera/core";
import { createTaskEventBus } from "./task-event-bus.js";
import { runTaskTurn } from "./task-runner.js";
import { createTaskStore } from "./task-store.js";
import { createWorkflowCheckpointStore } from "./workflow-store.js";

const TOKEN = randomBytes(32).toString("hex"); // 256-bit bearer token, rotates each launch
const TAURI_ORIGIN = "tauri://localhost";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1 MiB cap per stream
const WORKFLOW_DB_PATH =
  process.env.TESSERA_WORKFLOW_DB_PATH ?? join(homedir(), ".tessera", "workflow-runs.sqlite");
const TASK_DB_PATH =
  process.env.TESSERA_TASK_DB_PATH ?? join(homedir(), ".tessera", "tasks.sqlite");
const workflowStore = createWorkflowCheckpointStore(WORKFLOW_DB_PATH);
const taskStore = createTaskStore(TASK_DB_PATH);
const taskEventBus = createTaskEventBus();
const workflowRegistry = new Map([[DEMO_WORKFLOW.id, DEMO_WORKFLOW]]);

const isWindows = process.platform === "win32";
const socketPath = isWindows ? undefined : join(tmpdir(), `tessera-${process.pid}.sock`);

process.on("exit", () => {
  if (socketPath && existsSync(socketPath)) unlinkSync(socketPath);
  workflowStore.close();
  taskStore.close();
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(0));
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function validateRequest(req: Request): Response | null {
  // Host header allowlist — defeats DNS rebinding
  const [hostname = ""] = (req.headers.get("host") ?? "").split(":");
  if (hostname && !ALLOWED_HOSTS.has(hostname)) return forbidden();

  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return unauthorized();
  return null;
}

function validateWebSocket(req: Request): Response | null {
  const base = validateRequest(req);
  if (base) return base;

  // Origin allowlist on WS upgrades — prevents cross-site WebSocket hijacking
  if (req.headers.get("origin") !== TAURI_ORIGIN) return forbidden();
  return null;
}

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated at 1 MiB]`;
}

async function handleSpawn(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SpawnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  const request = parsed.data;

  try {
    const result = await runWorkspaceCli(request.args, request.timeoutMs);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "SPAWN_FAILED",
      },
      { status: 500 }
    );
  }
}

async function runWorkspaceCli(args: string[], timeoutMs = 10_000): Promise<SpawnResult> {
  // binary enum is validated by Zod; resolve to the path injected by Rust at launch
  const cliPath = process.env.TESSERA_CLI_PATH;
  if (!cliPath) {
    throw new Error("TESSERA_CLI_PATH not configured");
  }

  const startMs = Date.now();
  const proc = Bun.spawn([cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Kill the child on timeout; exited promise still resolves (with a non-zero code)
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [rawStdout, rawStderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const result: SpawnResult = {
    stdout: capOutput(rawStdout),
    stderr: capOutput(rawStderr),
    exitCode,
    signal: proc.signalCode ?? null,
    durationMs: Date.now() - startMs,
  };

  return result;
}

async function handleAgentTurn(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AgentTurnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const result = await executeAgentTurn({
      request: parsed.data,
      cli: {
        runWorkspaceCli,
      },
    });

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleWorkflowRun(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WorkflowRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const definition = workflowRegistry.get(parsed.data.workflowId);
  if (!definition) {
    return Response.json({ error: "Unknown workflow id" }, { status: 404 });
  }

  try {
    const result = await runWorkflow({
      definition,
      input: parsed.data.input,
      cli: {
        runWorkspaceCli,
      },
    });
    workflowStore.save(result);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

function handleWorkflowRunList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  if (status && status !== "blocked") {
    return Response.json({ error: "Unsupported workflow status filter" }, { status: 400 });
  }

  const result = WorkflowRunListResultSchema.parse({
    runs: workflowStore.list(status === "blocked" ? { status } : undefined),
  });
  return Response.json(result);
}

async function handleWorkflowResume(req: Request, runId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WorkflowResumeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  if (parsed.data.runId !== runId) {
    return Response.json({ error: "Resume body runId does not match URL" }, { status: 400 });
  }

  const existing = workflowStore.get(runId);
  if (!existing) {
    return Response.json({ error: "Unknown workflow run" }, { status: 404 });
  }
  const definition = workflowRegistry.get(existing.workflowId);
  if (!definition) {
    return Response.json({ error: "Unknown workflow id" }, { status: 404 });
  }

  try {
    const result = await resumeWorkflowRun({
      run: existing,
      decision: parsed.data.decision,
      definition,
      cli: {
        runWorkspaceCli,
      },
    });
    workflowStore.save(result);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

function handleTaskList(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceRoot = searchParams.get("workspaceRoot") ?? "";
  try {
    const result = TaskListResultSchema.parse({
      tasks: taskStore.listTasks({ workspaceRoot }),
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}

async function handleTaskCreate(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TaskCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const task = taskStore.createTask(parsed.data);
    const userTurn = task.turns.at(-1);
    if (!userTurn) throw new Error("Created task has no user turn");
    const agentTurn = taskStore.createQueuedAgentTurn(task.id);
    const snapshot = taskStore.getTask(task.id);
    const taskId = task.id;
    const agentTurnId = agentTurn.id;
    const userTurnId = userTurn.id;
    queueMicrotask(() => {
      void runTaskTurn({
        store: taskStore,
        taskId,
        userTurnId,
        agentTurnId,
        ...(parsed.data.execution ? { execution: parsed.data.execution } : {}),
        publish: (e) => taskEventBus.publish(taskId, e),
      });
    });
    return Response.json(snapshot);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

function handleTaskGet(req: Request, taskId: string): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const task = taskStore.getTask(taskId);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  return Response.json(task);
}

async function handleTaskUpdate(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "PATCH") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TaskUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const task = taskStore.updateTask(taskId, parsed.data);
  if (!task) {
    return Response.json({ error: "Unknown task" }, { status: 404 });
  }
  return Response.json(task);
}

async function handleTaskCreateTurn(req: Request, taskId: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TaskCreateTurnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const userTurn = taskStore.createUserTurn(taskId, parsed.data.content);
    const agentTurn = taskStore.createQueuedAgentTurn(taskId);
    const snapshot = taskStore.getTask(taskId);
    const userTurnId = userTurn.id;
    const agentTurnId = agentTurn.id;
    queueMicrotask(() => {
      void runTaskTurn({
        store: taskStore,
        taskId,
        userTurnId,
        agentTurnId,
        ...(parsed.data.execution ? { execution: parsed.data.execution } : {}),
        publish: (e) => taskEventBus.publish(taskId, e),
      });
    });
    return Response.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Unknown task") ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}

async function handleTaskEvents(_req: Request, taskId: string): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      send(": open\n\n");

      const heartbeat = setInterval(() => {
        try {
          send(": ping\n\n");
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      const unsubscribe = taskEventBus.subscribe(taskId, (event) => {
        try {
          send(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      });

      // _cleanup is attached here so the cancel() hook can tear down the interval
      // and subscription without a class wrapper — standard workaround for
      // ReadableStreamController having no built-in cancellation state slot.
      (controller as unknown as { _cleanup: () => void })._cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      (this as unknown as { _cleanup?: () => void })._cleanup?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  // Unix domain socket on macOS/Linux (no exposed TCP port).
  // TCP on Windows as a fallback; named pipe support is a future improvement.
  ...(socketPath ? { unix: socketPath } : { hostname: "127.0.0.1", port: 0 }),

  async fetch(req, srv) {
    if (req.headers.get("upgrade") === "websocket") {
      const err = validateWebSocket(req);
      if (err) return err;
      srv.upgrade(req);
      return;
    }

    const err = validateRequest(req);
    if (err) return err;

    const { pathname } = new URL(req.url);

    if (pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (pathname === "/spawn") {
      return handleSpawn(req);
    }

    if (pathname === "/agent/turn") {
      return handleAgentTurn(req);
    }

    if (pathname === "/workflows/run") {
      return handleWorkflowRun(req);
    }

    if (pathname === "/workflows/runs") {
      return handleWorkflowRunList(req);
    }

    if (pathname === "/tasks") {
      if (req.method === "GET") return handleTaskList(req);
      return handleTaskCreate(req);
    }

    const taskEventsMatch = pathname.match(/^\/tasks\/([^/]+)\/events$/);
    const taskEventsId = taskEventsMatch?.[1];
    if (taskEventsId) {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return handleTaskEvents(req, decodeURIComponent(taskEventsId));
    }

    const taskTurnMatch = pathname.match(/^\/tasks\/([^/]+)\/turns$/);
    const taskTurnTaskId = taskTurnMatch?.[1];
    if (taskTurnTaskId) {
      return handleTaskCreateTurn(req, taskTurnTaskId);
    }

    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    const taskId = taskMatch?.[1];
    if (taskId) {
      if (req.method === "GET") return handleTaskGet(req, taskId);
      return handleTaskUpdate(req, taskId);
    }

    const workflowResumeMatch = pathname.match(/^\/workflows\/([^/]+)\/resume$/);
    const workflowRunId = workflowResumeMatch?.[1];
    if (workflowRunId) {
      return handleWorkflowResume(req, workflowRunId);
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(_ws) {},
    message(ws, data) {
      ws.send(data);
    },
    close(_ws) {},
  },
});

// Validate and report connection info to the Tauri shell via stdout.
const info = SidecarReadySchema.parse(
  socketPath
    ? { type: "ready", transport: "unix", path: socketPath, token: TOKEN }
    : { type: "ready", transport: "tcp", port: server.port, token: TOKEN }
);

process.stdout.write(`${JSON.stringify(info)}\n`);
