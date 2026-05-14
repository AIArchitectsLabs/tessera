import { relative } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, type TSchema, Type } from "@mariozechner/pi-ai";
import { type ToolDefinition, defineTool } from "@mariozechner/pi-coding-agent";
import { extractPdfText, inspectPdfDocument, validatePdfDocument } from "./pdf-service.js";
import { WorkspaceBoundaryError, type WorkspaceGuard } from "./workspace-guard.js";

type PdfToolDefinition<TParams extends TSchema, TDetails = unknown> = ToolDefinition<
  TParams,
  TDetails
>;

const inspectSchema = Type.Object({
  path: Type.String(),
});

const extractSchema = Type.Object({
  path: Type.String(),
  pages: Type.Optional(
    Type.Object({
      start: Type.Optional(Type.Number()),
      end: Type.Optional(Type.Number()),
    })
  ),
  maxChars: Type.Optional(Type.Number()),
});

const validateSchema = Type.Object({
  path: Type.String(),
  expectedPageCount: Type.Optional(Type.Number()),
  expectedTextPresent: Type.Optional(Type.Boolean()),
});

function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function isWorkspaceBoundaryError(error: unknown): error is WorkspaceBoundaryError {
  return error instanceof WorkspaceBoundaryError;
}

async function resolveExistingWorkspacePath(
  guard: WorkspaceGuard,
  path: string,
  toolName: string,
  onViolation?: (toolName: string) => void
): Promise<string> {
  try {
    return await guard.resolveInsideWorkspace(path);
  } catch (error) {
    if (isWorkspaceBoundaryError(error)) {
      onViolation?.(toolName);
      throw error;
    }

    try {
      await guard.resolveInsideWorkspaceForCreate(path);
    } catch (createError) {
      if (isWorkspaceBoundaryError(createError)) {
        onViolation?.(toolName);
      }
      throw error;
    }

    throw error;
  }
}

export function createPdfToolDefinitions(
  guard: WorkspaceGuard,
  options?: { onViolation?: (toolName: string) => void }
): ToolDefinition[] {
  const inspectTool = defineTool({
    name: "pdf_inspect",
    label: "Inspect",
    description: "Inspect a PDF before extracting or transforming it.",
    promptSnippet: "pdf_inspect: inspect a PDF before extracting or transforming it.",
    parameters: inspectSchema,
    async execute(_toolCallId, params: Static<typeof inspectSchema>) {
      const absolute = await resolveExistingWorkspacePath(
        guard,
        params.path,
        "pdf_inspect",
        options?.onViolation
      );

      const result = await inspectPdfDocument(absolute, {
        displayPath: relative(guard.root, absolute),
      });
      return textResult(JSON.stringify(result), result);
    },
  }) satisfies PdfToolDefinition<typeof inspectSchema>;

  const extractTool = defineTool({
    name: "pdf_extract",
    label: "Extract",
    description: "Extract page-scoped text from a PDF.",
    promptSnippet:
      "pdf_extract: extract page-scoped text from a PDF. Use pages.start/pages.end to narrow the output and maxChars to keep it focused.",
    parameters: extractSchema,
    async execute(_toolCallId, params: Static<typeof extractSchema>) {
      const absolute = await resolveExistingWorkspacePath(
        guard,
        params.path,
        "pdf_extract",
        options?.onViolation
      );

      const result = await extractPdfText(absolute, {
        displayPath: relative(guard.root, absolute),
        ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
        ...(params.pages !== undefined ? { pages: params.pages } : {}),
      });
      return textResult(result.text, result);
    },
  }) satisfies PdfToolDefinition<typeof extractSchema>;

  const validateTool = defineTool({
    name: "pdf_validate",
    label: "Validate",
    description: "Validate PDF existence, page count, and text-layer expectations.",
    promptSnippet:
      "pdf_validate: validate that a PDF exists and optionally check page count and text-layer expectations.",
    parameters: validateSchema,
    async execute(_toolCallId, params: Static<typeof validateSchema>) {
      let absolute: string;
      let displayPath: string;
      try {
        absolute = await guard.resolveInsideWorkspace(params.path);
        displayPath = relative(guard.root, absolute);
      } catch (error) {
        if (isWorkspaceBoundaryError(error)) {
          options?.onViolation?.("pdf_validate");
          throw error;
        }

        try {
          absolute = await guard.resolveInsideWorkspaceForCreate(params.path);
        } catch (createError) {
          if (isWorkspaceBoundaryError(createError)) {
            options?.onViolation?.("pdf_validate");
          }
          throw createError;
        }

        displayPath = params.path;
      }

      const result = await validatePdfDocument(absolute, {
        displayPath,
        ...(params.expectedPageCount !== undefined
          ? { expectedPageCount: params.expectedPageCount }
          : {}),
        ...(params.expectedTextPresent !== undefined
          ? { expectedTextPresent: params.expectedTextPresent }
          : {}),
      });
      return textResult(JSON.stringify(result), result);
    },
  }) satisfies PdfToolDefinition<typeof validateSchema>;

  return [inspectTool, extractTool, validateTool];
}
