import { join } from "node:path";

const PORT = 3000;
const PUBLIC_DIR = __dirname;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Prevent directory traversal
    let pathname = url.pathname;
    if (pathname === "/") {
      pathname = "/index.html";
    }

    const filePath = join(PUBLIC_DIR, pathname);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(file);
  },
});

console.log(`Tessera download website running at http://localhost:${server.port}`);
