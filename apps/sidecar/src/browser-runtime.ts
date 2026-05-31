import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionInput, BrowserToolResult } from "@tessera/contracts";
import { type BrowserRecipeActionInput, buildBrowserRecipeProposal } from "@tessera/core";
import { type BrowserContext, type Page, chromium } from "playwright";

const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const READ_ONLY_ACTIONS = new Set<BrowserActionInput["action"]>([
  "open",
  "snap",
  "see",
  "back",
  "reload",
  "close",
]);

export class BrowserRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserRuntimeUnavailableError";
  }
}

export function isBrowserRuntimeUnavailableError(
  error: unknown
): error is BrowserRuntimeUnavailableError {
  return error instanceof BrowserRuntimeUnavailableError;
}

export interface PlaywrightBrowserExecutorOptions {
  artifactDir: string;
  profileDir: string;
  recipeDir: string;
  browsersPath?: string;
  executablePath?: string;
  resolveLaunchOptions?: () =>
    | Promise<Pick<PlaywrightBrowserExecutorOptions, "browsersPath" | "executablePath">>
    | Pick<PlaywrightBrowserExecutorOptions, "browsersPath" | "executablePath">;
  headless?: boolean;
  now?: () => string;
}

interface ManagedPage {
  id: string;
  page: Page;
  sessionId: string;
  history: BrowserRecipeActionInput[];
  artifacts: Array<{ title: string; path: string }>;
}

export interface PlaywrightBrowserExecutor {
  executeBrowser(input: BrowserActionInput): Promise<BrowserToolResult>;
  dispose(): Promise<void>;
}

export interface BrowserRuntimeEnv extends Record<string, string | undefined> {
  TESSERA_PLAYWRIGHT_BROWSERS_PATH?: string;
  TESSERA_BROWSER_EXECUTABLE_PATH?: string;
  TESSERA_PLAYWRIGHT_EXECUTABLE_PATH?: string;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function validateHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported browser URL protocol: ${url.protocol}`);
  }
  return url;
}

function describePlaywrightLaunchError(error: unknown): BrowserRuntimeUnavailableError {
  const message = error instanceof Error ? error.message : String(error);
  return new BrowserRuntimeUnavailableError(
    `Browser runtime unavailable. Install the browser automation runtime from Settings, install Playwright Chromium for local browser tests, or set TESSERA_PLAYWRIGHT_BROWSERS_PATH / TESSERA_BROWSER_EXECUTABLE_PATH. ${message}`
  );
}

function isBrowserRuntimeFailureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Protocol error") ||
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("browser has been closed") ||
    message.includes("Connection closed")
  );
}

function describePlaywrightRuntimeError(error: unknown): Error {
  if (!isBrowserRuntimeFailureError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const message = error instanceof Error ? error.message : String(error);
  return new BrowserRuntimeUnavailableError(
    `Browser runtime became unavailable while executing an action. Install the browser automation runtime from Settings, install Playwright Chromium for local browser tests, or set TESSERA_PLAYWRIGHT_BROWSERS_PATH / TESSERA_BROWSER_EXECUTABLE_PATH. ${message}`
  );
}

export function resolveBrowserRuntimeConfigFromEnv(
  env: BrowserRuntimeEnv = process.env
): Pick<PlaywrightBrowserExecutorOptions, "browsersPath" | "executablePath"> {
  const browsersPath = env.TESSERA_PLAYWRIGHT_BROWSERS_PATH?.trim();
  const browserExecutablePath = env.TESSERA_BROWSER_EXECUTABLE_PATH?.trim();
  const playwrightExecutablePath = env.TESSERA_PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  const executablePath = browserExecutablePath || playwrightExecutablePath;

  return {
    ...(browsersPath ? { browsersPath } : {}),
    ...(executablePath ? { executablePath } : {}),
  };
}

async function visibleText(page: Page): Promise<string> {
  const text = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  return text.length > MAX_VISIBLE_TEXT_LENGTH
    ? `${text.slice(0, MAX_VISIBLE_TEXT_LENGTH)}\n[visible text truncated]`
    : text;
}

async function pageMetadata(page: Page): Promise<Record<string, unknown>> {
  const title = await page.title().catch(() => "");
  const pageUrl = page.url();
  const headings = await page
    .locator("h1, h2, h3")
    .allInnerTexts()
    .catch(() => []);
  const links = await page
    .locator("a")
    .evaluateAll((items) =>
      items
        .map((item) => ({
          text: item.textContent?.trim() ?? "",
          href: item.getAttribute("href") ?? "",
        }))
        .filter((item) => item.text || item.href)
        .slice(0, 30)
    )
    .catch(() => []);

  return {
    title,
    url: pageUrl,
    headings: headings
      .map((heading) => heading.trim())
      .filter(Boolean)
      .slice(0, 20),
    links,
  };
}

export function createPlaywrightBrowserExecutor(
  options: PlaywrightBrowserExecutorOptions
): PlaywrightBrowserExecutor {
  let context: BrowserContext | undefined;
  let activePageId: string | undefined;
  const sessionId = createId("browser-session");
  const pages = new Map<string, ManagedPage>();
  const now = options.now ?? (() => new Date().toISOString());

  async function ensureContext(): Promise<BrowserContext> {
    if (context) return context;
    await mkdir(options.profileDir, { recursive: true });
    await mkdir(options.artifactDir, { recursive: true });
    await mkdir(options.recipeDir, { recursive: true });
    const launchOptions = {
      browsersPath: options.browsersPath,
      executablePath: options.executablePath,
      ...(options.resolveLaunchOptions ? await options.resolveLaunchOptions() : {}),
    };
    if (launchOptions.browsersPath) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = launchOptions.browsersPath;
    }

    try {
      context = await chromium.launchPersistentContext(options.profileDir, {
        headless: options.headless ?? true,
        ...(launchOptions.executablePath ? { executablePath: launchOptions.executablePath } : {}),
        viewport: { width: 1280, height: 900 },
      });
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      context.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      return context;
    } catch (error) {
      throw describePlaywrightLaunchError(error);
    }
  }

  function getManagedPage(pageId?: string): ManagedPage {
    const id = pageId ?? activePageId;
    if (!id) {
      throw new Error("No active browser page. Open a page first.");
    }
    const managed = pages.get(id);
    if (!managed) {
      throw new Error(`Browser page not found: ${id}`);
    }
    return managed;
  }

  async function open(input: Extract<BrowserActionInput, { action: "open" }>) {
    const url = validateHttpUrl(input.url);
    const browserContext = await ensureContext();
    const managed =
      input.pageId && pages.has(input.pageId)
        ? pages.get(input.pageId)
        : {
            id: createId("browser-page"),
            page: await browserContext.newPage(),
            sessionId,
            history: [],
            artifacts: [],
          };
    if (!managed) {
      throw new Error(`Browser page not found: ${input.pageId}`);
    }

    pages.set(managed.id, managed);
    activePageId = managed.id;
    await managed.page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    const title = await managed.page.title().catch(() => "");
    managed.history.push({
      action: "open",
      url: managed.page.url(),
      expectedState: title || url.hostname,
    });

    return {
      action: "open",
      summary: `Opened ${title || managed.page.url()}`,
      sessionId: managed.sessionId,
      pageId: managed.id,
      url: managed.page.url(),
      metadata: await pageMetadata(managed.page),
    } satisfies BrowserToolResult;
  }

  async function see(input: Extract<BrowserActionInput, { action: "see" }>) {
    const managed = getManagedPage(input.pageId);
    const text = await visibleText(managed.page);
    const metadata = await pageMetadata(managed.page);
    const firstLine = text
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
    const action: BrowserRecipeActionInput = {
      action: "see",
      url: managed.page.url(),
    };
    if (firstLine) action.expectedState = firstLine;
    managed.history.push(action);
    return {
      action: "see",
      summary: `Read ${metadata.title || managed.page.url()}`,
      sessionId: managed.sessionId,
      pageId: managed.id,
      url: managed.page.url(),
      content: text,
      metadata,
    } satisfies BrowserToolResult;
  }

  async function snap(input: Extract<BrowserActionInput, { action: "snap" }>) {
    const managed = getManagedPage(input.pageId);
    await mkdir(options.artifactDir, { recursive: true });
    const filename = sanitizeFilename(`${managed.id}-${now()}.png`);
    const screenshotPath = join(options.artifactDir, filename);
    await managed.page.screenshot({
      path: screenshotPath,
      fullPage: input.fullPage,
    });
    managed.artifacts.push({ title: "Browser screenshot", path: screenshotPath });
    managed.history.push({
      action: "snap",
      url: managed.page.url(),
      expectedState: "Screenshot captured",
    });
    return {
      action: "snap",
      summary: `Captured screenshot for ${managed.page.url()}`,
      sessionId: managed.sessionId,
      pageId: managed.id,
      url: managed.page.url(),
      screenshotPath,
      metadata: { artifactDir: options.artifactDir },
    } satisfies BrowserToolResult;
  }

  async function back(input: Extract<BrowserActionInput, { action: "back" }>) {
    const managed = getManagedPage(input.pageId);
    await managed.page.goBack({ waitUntil: "domcontentloaded" });
    managed.history.push({
      action: "back",
      url: managed.page.url(),
      expectedState: "Navigated back",
    });
    return {
      action: "back",
      summary: `Went back to ${managed.page.url()}`,
      sessionId: managed.sessionId,
      pageId: managed.id,
      url: managed.page.url(),
      metadata: await pageMetadata(managed.page),
    } satisfies BrowserToolResult;
  }

  async function reload(input: Extract<BrowserActionInput, { action: "reload" }>) {
    const managed = getManagedPage(input.pageId);
    await managed.page.reload({ waitUntil: "domcontentloaded" });
    managed.history.push({
      action: "reload",
      url: managed.page.url(),
      expectedState: "Reloaded page",
    });
    return {
      action: "reload",
      summary: `Reloaded ${managed.page.url()}`,
      sessionId: managed.sessionId,
      pageId: managed.id,
      url: managed.page.url(),
      metadata: await pageMetadata(managed.page),
    } satisfies BrowserToolResult;
  }

  async function close(input: Extract<BrowserActionInput, { action: "close" }>) {
    const managed = getManagedPage(input.pageId);
    await managed.page.close();
    pages.delete(managed.id);
    if (activePageId === managed.id) {
      activePageId = pages.keys().next().value;
    }
    const recipeProposal =
      managed.history.length > 0
        ? buildBrowserRecipeProposal({
            goal: `Review ${managed.history[0]?.url ?? "browser session"}`,
            sessionId: managed.sessionId,
            createdAt: now(),
            actions: managed.history,
            artifacts: managed.artifacts,
          })
        : undefined;
    const recipeSummary = recipeProposal
      ? ` Drafted browser recipe proposal ${recipeProposal.id} for ${recipeProposal.domain}.`
      : "";
    return {
      action: "close",
      summary: `Closed browser page ${managed.id}.${recipeSummary}`,
      sessionId: managed.sessionId,
      pageId: managed.id,
      metadata: {
        recipeProposal,
      },
    } satisfies BrowserToolResult;
  }

  return {
    async executeBrowser(input) {
      if (!READ_ONLY_ACTIONS.has(input.action)) {
        throw new Error(`Browser action ${input.action} requires supervised mode.`);
      }

      try {
        switch (input.action) {
          case "open":
            return await open(input);
          case "see":
            return await see(input);
          case "snap":
            return await snap(input);
          case "back":
            return await back(input);
          case "reload":
            return await reload(input);
          case "close":
            return await close(input);
        }
      } catch (error) {
        throw describePlaywrightRuntimeError(error);
      }
      throw new Error(`Unsupported browser action: ${input.action}`);
    },
    async dispose() {
      await context?.close();
      context = undefined;
      pages.clear();
      activePageId = undefined;
    },
  };
}
