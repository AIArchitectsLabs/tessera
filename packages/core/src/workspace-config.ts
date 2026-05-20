import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  type WorkspaceStyleGuideReadResult,
  WorkspaceStyleGuideReadResultSchema,
  type WorkspaceStyleGuideSaveResult,
  WorkspaceStyleGuideSaveResultSchema,
} from "@tessera/contracts";
import { createWorkspaceGuard } from "./workspace-guard.js";

const WORKSPACE_CONFIG_PATH = ".tessera/config.json";
const MISSING_CONFIG_FINGERPRINT = "sha256:missing";

export class WorkspaceConfigConflictError extends Error {
  readonly currentFingerprint: string;

  constructor(currentFingerprint: string) {
    super("The workspace style guide changed outside Tessera.");
    this.name = "WorkspaceConfigConflictError";
    this.currentFingerprint = currentFingerprint;
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function configFingerprint(content: string | null): string {
  return content === null ? MISSING_CONFIG_FINGERPRINT : sha256(content);
}

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return WorkspaceConfigSchema.parse({ schemaVersion: 1 });
}

export async function readWorkspaceConfig(
  workspaceRoot: string
): Promise<WorkspaceStyleGuideReadResult> {
  const guard = await createWorkspaceGuard(workspaceRoot);
  const absolute = await guard.resolveInsideWorkspaceForCreate(WORKSPACE_CONFIG_PATH);
  const content = await readFile(absolute, "utf8").catch((error) => {
    const code = typeof error === "object" && error ? (error as { code?: unknown }).code : "";
    if (code === "ENOENT") return null;
    throw error;
  });

  const config =
    content === null ? defaultWorkspaceConfig() : WorkspaceConfigSchema.parse(JSON.parse(content));
  const metadata = content === null ? null : await stat(absolute);
  return WorkspaceStyleGuideReadResultSchema.parse({
    schemaVersion: 1,
    workspaceRoot: guard.root,
    exists: content !== null,
    config,
    fingerprint: configFingerprint(content),
    ...(metadata ? { updatedAt: metadata.mtime.toISOString() } : {}),
  });
}

export async function saveWorkspaceConfig(input: {
  workspaceRoot: string;
  config: WorkspaceConfig;
  expectedFingerprint?: string;
  overwrite?: boolean;
}): Promise<WorkspaceStyleGuideSaveResult> {
  const current = await readWorkspaceConfig(input.workspaceRoot);
  if (
    input.expectedFingerprint &&
    !input.overwrite &&
    input.expectedFingerprint !== current.fingerprint
  ) {
    throw new WorkspaceConfigConflictError(current.fingerprint);
  }

  const guard = await createWorkspaceGuard(input.workspaceRoot);
  const absolute = await guard.resolveInsideWorkspaceForCreate(WORKSPACE_CONFIG_PATH);
  const parsed = WorkspaceConfigSchema.parse(input.config);
  await mkdir(dirname(absolute), { recursive: true });
  const content = prettyJson(parsed);
  await writeFile(absolute, content, "utf8");
  const metadata = await stat(absolute);
  return WorkspaceStyleGuideSaveResultSchema.parse({
    schemaVersion: 1,
    workspaceRoot: guard.root,
    exists: true,
    config: parsed,
    fingerprint: configFingerprint(content),
    updatedAt: metadata.mtime.toISOString(),
    savedAt: new Date().toISOString(),
  });
}

export function workspaceConfigRelativePath(workspaceRoot: string, absolutePath: string): string {
  return relative(workspaceRoot, absolutePath);
}
