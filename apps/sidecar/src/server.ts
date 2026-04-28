import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = randomBytes(32).toString("hex"); // 256-bit bearer token, rotates each launch
const TAURI_ORIGIN = "tauri://localhost";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

const isWindows = process.platform === "win32";
const socketPath = isWindows ? undefined : join(tmpdir(), `tessera-${process.pid}.sock`);

process.on("exit", () => {
  if (socketPath && existsSync(socketPath)) unlinkSync(socketPath);
});
["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig, () => process.exit(0)));

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

const server = Bun.serve({
  // Unix domain socket on macOS/Linux (no exposed TCP port).
  // TCP on Windows as a fallback; named pipe support is a future improvement.
  ...(socketPath ? { unix: socketPath } : { hostname: "127.0.0.1", port: 0 }),

  fetch(req, srv) {
    if (req.headers.get("upgrade") === "websocket") {
      const err = validateWebSocket(req);
      if (err) return err;
      srv.upgrade(req);
      return;
    }

    const err = validateRequest(req);
    if (err) return err;

    if (new URL(req.url).pathname === "/health") {
      return Response.json({ status: "ok" });
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

// Report connection info to the Tauri shell via stdout so Rust can inject it into the webview.
const info = socketPath
  ? { type: "ready", transport: "unix", path: socketPath, token: TOKEN }
  : { type: "ready", transport: "tcp", port: server.port, token: TOKEN };

process.stdout.write(JSON.stringify(info) + "\n");
