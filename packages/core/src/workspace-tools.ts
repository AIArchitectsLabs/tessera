import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, type TSchema, Type } from "@mariozechner/pi-ai";
import { type ToolDefinition, defineTool } from "@mariozechner/pi-coding-agent";
import {
  type DocumentExtractionOptions,
  extractWorkspaceDocument,
  isExtractableDocumentPath,
} from "./document-extraction.js";
import { WorkspaceBoundaryError, type WorkspaceGuard } from "./workspace-guard.js";

type WorkspaceToolDefinition<TParams extends TSchema, TDetails = unknown> = ToolDefinition<
  TParams,
  TDetails
>;

const pathSchema = Type.Object({
  path: Type.String(),
});

const extractSchema = Type.Object({
  path: Type.String(),
  sheet: Type.Optional(Type.String()),
  maxChars: Type.Optional(Type.Number()),
  maxRows: Type.Optional(Type.Number()),
  pages: Type.Optional(
    Type.Object({
      start: Type.Optional(Type.Number()),
      end: Type.Optional(Type.Number()),
    })
  ),
});

const searchSchema = Type.Object({
  query: Type.String(),
  path: Type.Optional(Type.String()),
});

const writeSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const editSchema = Type.Object({
  path: Type.String(),
  oldText: Type.String(),
  newText: Type.String(),
});

function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function denied(path: string): never {
  throw new WorkspaceBoundaryError(`Workspace tool denied access outside the workspace: ${path}`);
}

async function walkFiles(root: string, dir: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const metadata = await stat(absolute).catch(() => null);
    if (metadata === null) continue;
    if (metadata.isDirectory()) {
      await walkFiles(root, absolute, files);
    } else if (metadata.isFile()) {
      files.push(relative(root, absolute));
    }
  }
  return files;
}

export function createWorkspaceToolDefinitions(
  guard: WorkspaceGuard,
  options?: { onViolation?: (toolName: string) => void }
): ToolDefinition[] {
  const readTool = defineTool({
    name: "workspace_read",
    label: "Read",
    description:
      "Read a text file inside the selected workspace, or extract readable content from supported documents.",
    promptSnippet:
      "workspace_read: read text files and supported PDF, Word, and Excel documents inside the selected workspace.",
    parameters: pathSchema,
    async execute(_toolCallId, params: Static<typeof pathSchema>) {
      let absolute: string;
      try {
        absolute = await guard.resolveInsideWorkspace(params.path);
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_read");
        throw error;
      }
      const metadata = await stat(absolute);
      if (!metadata.isFile()) throw new Error(`Path is not a file: ${params.path}`);
      if (isExtractableDocumentPath(absolute)) {
        const extracted = await extractWorkspaceDocument(absolute);
        return textResult(extracted.text, {
          ...extracted.details,
          path: relative(guard.root, absolute),
        });
      }
      const text = await readFile(absolute, "utf8");
      return textResult(text, { path: relative(guard.root, absolute) });
    },
  }) satisfies WorkspaceToolDefinition<typeof pathSchema, { path: string }>;

  const extractTool = defineTool({
    name: "workspace_extract",
    label: "Extract",
    description:
      "Extract readable content from PDF, Word, and Excel files inside the selected workspace.",
    promptSnippet:
      "workspace_extract: extract readable text from PDF, Word (.docx), and Excel (.xlsx/.xls) files inside the selected workspace.",
    parameters: extractSchema,
    async execute(_toolCallId, params: Static<typeof extractSchema>) {
      let absolute: string;
      try {
        absolute = await guard.resolveInsideWorkspace(params.path);
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_extract");
        throw error;
      }
      const extractionOptions: DocumentExtractionOptions = {};
      if (params.sheet !== undefined) extractionOptions.sheet = params.sheet;
      if (params.maxChars !== undefined) extractionOptions.maxChars = params.maxChars;
      if (params.maxRows !== undefined) extractionOptions.maxRows = params.maxRows;
      if (params.pages !== undefined) extractionOptions.pages = params.pages;
      const extracted = await extractWorkspaceDocument(absolute, extractionOptions);
      return textResult(extracted.text, {
        ...extracted.details,
        path: relative(guard.root, absolute),
      });
    },
  }) satisfies WorkspaceToolDefinition<
    typeof extractSchema,
    {
      path: string;
      fileType: string;
      bytes: number;
      truncated: boolean;
      warnings: string[];
    }
  >;

  const listTool = defineTool({
    name: "workspace_list",
    label: "List",
    description: "List files and folders inside the selected workspace.",
    promptSnippet: "workspace_list: list files and folders inside the selected workspace.",
    parameters: pathSchema,
    async execute(_toolCallId, params: Static<typeof pathSchema>) {
      let absolute: string;
      try {
        absolute = await guard.resolveInsideWorkspace(params.path);
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_list");
        throw error;
      }
      const entries = await readdir(absolute, { withFileTypes: true });
      const names = entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort();
      return textResult(names.join("\n"), { path: relative(guard.root, absolute), entries: names });
    },
  }) satisfies WorkspaceToolDefinition<typeof pathSchema, { path: string; entries: string[] }>;

  const searchTool = defineTool({
    name: "workspace_search",
    label: "Search",
    description: "Search text files inside the selected workspace.",
    promptSnippet: "workspace_search: search text files inside the selected workspace.",
    parameters: searchSchema,
    async execute(_toolCallId, params: Static<typeof searchSchema>) {
      let base: string;
      try {
        base = await guard.resolveInsideWorkspace(params.path ?? ".");
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_search");
        throw error;
      }
      const matches: string[] = [];
      for (const file of await walkFiles(guard.root, base)) {
        const absolute = await guard.resolveInsideWorkspace(file);
        const text = await readFile(absolute, "utf8").catch(() => "");
        if (text.includes(params.query)) matches.push(file);
      }
      return textResult(matches.join("\n"), { query: params.query, matches });
    },
  }) satisfies WorkspaceToolDefinition<typeof searchSchema, { query: string; matches: string[] }>;

  const writeTool = defineTool({
    name: "workspace_write",
    label: "Write",
    description: "Write a text file inside the selected workspace.",
    promptSnippet: "workspace_write: write text files inside the selected workspace.",
    parameters: writeSchema,
    async execute(_toolCallId, params: Static<typeof writeSchema>) {
      const absolute = await guard.resolveInsideWorkspaceForCreate(params.path).catch((error) => {
        if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_write");
        denied(params.path);
      });
      await writeFile(absolute, params.content, "utf8");
      return textResult(`Wrote ${relative(guard.root, absolute)}`, {
        path: relative(guard.root, absolute),
        bytes: Buffer.byteLength(params.content),
      });
    },
  }) satisfies WorkspaceToolDefinition<typeof writeSchema, { path: string; bytes: number }>;

  const editTool = defineTool({
    name: "workspace_edit",
    label: "Edit",
    description: "Replace exact text in a file inside the selected workspace.",
    promptSnippet: "workspace_edit: replace exact text in workspace files.",
    parameters: editSchema,
    async execute(_toolCallId, params: Static<typeof editSchema>) {
      let absolute: string;
      try {
        absolute = await guard.resolveInsideWorkspace(params.path);
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) options?.onViolation?.("workspace_edit");
        throw error;
      }
      const text = await readFile(absolute, "utf8");
      if (!text.includes(params.oldText)) {
        throw new Error(`Text to replace was not found in ${params.path}`);
      }
      const count = text.split(params.oldText).length - 1;
      if (count > 1) {
        throw new Error(
          `oldText matches ${count} times in ${params.path}; provide unique context to replace exactly one occurrence`
        );
      }
      const updated = text.replace(params.oldText, params.newText);
      await writeFile(absolute, updated, "utf8");
      return textResult(`Edited ${relative(guard.root, absolute)}`, {
        path: relative(guard.root, absolute),
      });
    },
  }) satisfies WorkspaceToolDefinition<typeof editSchema, { path: string }>;

  return [readTool, extractTool, listTool, searchTool, writeTool, editTool];
}
