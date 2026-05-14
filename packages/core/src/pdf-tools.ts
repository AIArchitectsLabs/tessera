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

type PdfPathResolutionMode = "mustExist" | "allowMissingInsideWorkspace";

async function resolvePdfWorkspacePath(
  guard: WorkspaceGuard,
  path: string,
  options: {
    mode: PdfPathResolutionMode;
    onViolation: ((toolName: string) => void) | undefined;
    toolName: string;
  }
): Promise<{ absolute: string; displayPath: string }> {
  try {
    const absolute = await guard.resolveInsideWorkspace(path);
    return {
      absolute,
      displayPath: relative(guard.root, absolute),
    };
  } catch (error) {
    if (isWorkspaceBoundaryError(error)) {
      options.onViolation?.(options.toolName);
      throw error;
    }

    try {
      const absolute = await guard.resolveInsideWorkspaceForCreate(path);
      if (options.mode === "mustExist") {
        throw error;
      }

      return {
        absolute,
        displayPath: path,
      };
    } catch (createError) {
      if (isWorkspaceBoundaryError(createError)) {
        options.onViolation?.(options.toolName);
        throw createError;
      }
      throw error;
    }
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
      const { absolute, displayPath } = await resolvePdfWorkspacePath(guard, params.path, {
        mode: "mustExist",
        onViolation: options?.onViolation,
        toolName: "pdf_inspect",
      });

      const result = await inspectPdfDocument(absolute, {
        displayPath,
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
      const { absolute, displayPath } = await resolvePdfWorkspacePath(guard, params.path, {
        mode: "mustExist",
        onViolation: options?.onViolation,
        toolName: "pdf_extract",
      });

      const result = await extractPdfText(absolute, {
        displayPath,
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
      const { absolute, displayPath } = await resolvePdfWorkspacePath(guard, params.path, {
        mode: "allowMissingInsideWorkspace",
        onViolation: options?.onViolation,
        toolName: "pdf_validate",
      });

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
