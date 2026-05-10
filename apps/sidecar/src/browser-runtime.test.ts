import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlaywrightBrowserExecutor,
  isBrowserRuntimeUnavailableError,
  resolveBrowserRuntimeConfigFromEnv,
} from "./browser-runtime.js";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let rootDir = "";
let serverAvailable = true;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

async function makeExecutor() {
  rootDir = await mkdtemp(join(tmpdir(), "tessera-browser-runtime-"));
  return createPlaywrightBrowserExecutor({
    artifactDir: join(rootDir, "browser-artifacts"),
    profileDir: join(rootDir, "browser-profile"),
    recipeDir: join(rootDir, "browser-recipes"),
    now: () => "2026-05-10T00:00:00.000Z",
  });
}

async function runIfBrowserAvailable(
  fn: (executor: Awaited<ReturnType<typeof makeExecutor>>) => Promise<void>
) {
  const executor = await makeExecutor();
  try {
    await fn(executor);
  } catch (error) {
    if (isBrowserRuntimeUnavailableError(error)) {
      console.warn(`Skipping browser runtime test: ${error.message}`);
      return;
    }
    throw error;
  } finally {
    await executor.dispose();
  }
}

beforeAll(async () => {
  const port = await freePort().catch((error) => {
    serverAvailable = false;
    console.warn(
      `Skipping browser runtime server tests: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  });
  if (!port) return;
  server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/second") {
        return new Response(
          "<!doctype html><title>Second</title><main><h1>Second Page</h1><p>More Tessera content.</p></main>",
          { headers: { "content-type": "text/html" } }
        );
      }
      return new Response(
        `<!doctype html><title>Example</title><main><h1>Example Domain</h1><p>Tessera browser runtime text.</p><a href="/second">Second</a></main>`,
        { headers: { "content-type": "text/html" } }
      );
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
  }
});

describe("createPlaywrightBrowserExecutor", () => {
  test("resolves packaged browser runtime configuration from env", () => {
    expect(
      resolveBrowserRuntimeConfigFromEnv({
        TESSERA_PLAYWRIGHT_BROWSERS_PATH: " /tmp/ms-playwright ",
        TESSERA_BROWSER_EXECUTABLE_PATH: " /tmp/chrome ",
      })
    ).toEqual({
      browsersPath: "/tmp/ms-playwright",
      executablePath: "/tmp/chrome",
    });
  });

  test("keeps browser runtime configuration empty when env is unset", () => {
    expect(resolveBrowserRuntimeConfigFromEnv({})).toEqual({});
  });

  test("opens a page and extracts visible text", async () => {
    await runIfBrowserAvailable(async (executor) => {
      if (!serverAvailable) return;
      const opened = await executor.executeBrowser({ action: "open", url: baseUrl });
      expect(opened.sessionId).toBeTruthy();
      expect(opened.pageId).toBeTruthy();
      expect(opened.url).toContain(baseUrl);

      const seen = await executor.executeBrowser({ action: "see", pageId: opened.pageId });
      expect(seen.content).toContain("Example Domain");
      expect(seen.content).toContain("Tessera browser runtime text");
    });
  }, 20_000);

  test("captures screenshots in the controlled artifact directory", async () => {
    await runIfBrowserAvailable(async (executor) => {
      if (!serverAvailable) return;
      const opened = await executor.executeBrowser({ action: "open", url: baseUrl });
      const snap = await executor.executeBrowser({
        action: "snap",
        pageId: opened.pageId,
        fullPage: false,
      });

      expect(snap.screenshotPath).toContain("browser-artifacts");
      expect(snap.screenshotPath).toEndWith(".png");
    });
  }, 20_000);

  test("supports reload, back, and close", async () => {
    await runIfBrowserAvailable(async (executor) => {
      if (!serverAvailable) return;
      const opened = await executor.executeBrowser({ action: "open", url: `${baseUrl}/second` });
      await executor.executeBrowser({ action: "open", pageId: opened.pageId, url: baseUrl });

      const back = await executor.executeBrowser({ action: "back", pageId: opened.pageId });
      expect(back.url).toContain("/second");

      const reload = await executor.executeBrowser({ action: "reload", pageId: opened.pageId });
      expect(reload.summary).toContain("Reloaded");

      const closed = await executor.executeBrowser({ action: "close", pageId: opened.pageId });
      expect(closed.summary).toContain("Closed");
      expect(closed.summary).toContain("Drafted browser recipe proposal");
      expect(closed.metadata?.recipeProposal).toBeTruthy();
    });
  }, 20_000);

  test("rejects invalid URLs and unsupported mutating actions", async () => {
    await runIfBrowserAvailable(async (executor) => {
      await expect(
        executor.executeBrowser({ action: "open", url: "file:///etc/passwd" })
      ).rejects.toThrow("Unsupported browser URL protocol");
      await expect(
        executor.executeBrowser({ action: "click", selector: "button.danger" })
      ).rejects.toThrow("requires supervised mode");
    });
  }, 20_000);
});
