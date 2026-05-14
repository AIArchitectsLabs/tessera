import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, type TSchema, Type } from "@mariozechner/pi-ai";
import { type ToolDefinition, defineTool } from "@mariozechner/pi-coding-agent";
import {
  type BinaryRunner,
  type PdfImageDimensionsReader,
  extractPdfText,
  inspectPdfDocument,
  renderPdfPages,
  transformPdfDocument,
  validatePdfDocument,
} from "./pdf-service.js";
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

const renderSchema = Type.Object({
  path: Type.String(),
  outputDir: Type.String(),
  pages: Type.Optional(
    Type.Object({
      start: Type.Optional(Type.Number()),
      end: Type.Optional(Type.Number()),
    })
  ),
  dpi: Type.Optional(Type.Number()),
});

const transformSourceSchema = Type.Object({
  path: Type.String(),
  pages: Type.Optional(
    Type.Object({
      start: Type.Optional(Type.Number()),
      end: Type.Optional(Type.Number()),
    })
  ),
});

const transformSchema = Type.Object({
  operation: Type.String(),
  sources: Type.Array(transformSourceSchema),
  outputPath: Type.String(),
  rotation: Type.Optional(
    Type.Object({
      degrees: Type.Number(),
      pages: Type.Optional(
        Type.Object({
          start: Type.Optional(Type.Number()),
          end: Type.Optional(Type.Number()),
        })
      ),
    })
  ),
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

function isSameOrChild(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

type PdfPathResolutionMode = "mustExist" | "allowMissingInsideWorkspace";

function resolveLexicalWorkspaceTarget(guard: WorkspaceGuard, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(guard.root, path);
}

async function resolvePdfWorkspacePath(
  guard: WorkspaceGuard,
  path: string,
  options: {
    mode: PdfPathResolutionMode;
    onViolation: ((toolName: string) => void) | undefined;
    toolName: string;
  }
): Promise<{ absolute: string; displayPath: string }> {
  const lexicalTarget = resolveLexicalWorkspaceTarget(guard, path);

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

    if (!isSameOrChild(guard.root, lexicalTarget)) {
      const boundaryError = new WorkspaceBoundaryError(`Path is outside the workspace: ${path}`);
      options.onViolation?.(options.toolName);
      throw boundaryError;
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

async function resolvePdfWorkspaceOutputPath(
  guard: WorkspaceGuard,
  path: string,
  options: {
    onViolation: ((toolName: string) => void) | undefined;
    toolName: string;
  }
): Promise<{ absolute: string; displayPath: string }> {
  const lexicalTarget = resolveLexicalWorkspaceTarget(guard, path);
  if (!isSameOrChild(guard.root, lexicalTarget)) {
    const boundaryError = new WorkspaceBoundaryError(`Path is outside the workspace: ${path}`);
    options.onViolation?.(options.toolName);
    throw boundaryError;
  }

  try {
    const parentPath = dirname(path);
    const parent =
      parentPath === "."
        ? dirname(await guard.resolveInsideWorkspaceForCreate(path))
        : await guard.resolveInsideWorkspaceForCreate(parentPath);
    const absolute = resolve(parent, basename(path));
    return {
      absolute,
      displayPath: relative(guard.root, absolute),
    };
  } catch (error) {
    if (isWorkspaceBoundaryError(error)) {
      options.onViolation?.(options.toolName);
      throw error;
    }
    throw error;
  }
}

async function resolvePdfWorkspaceOutputDir(
  guard: WorkspaceGuard,
  path: string,
  options: {
    onViolation: ((toolName: string) => void) | undefined;
    toolName: string;
  }
): Promise<{ absolute: string; displayPath: string }> {
  const lexicalTarget = resolveLexicalWorkspaceTarget(guard, path);
  if (!isSameOrChild(guard.root, lexicalTarget)) {
    const boundaryError = new WorkspaceBoundaryError(`Path is outside the workspace: ${path}`);
    options.onViolation?.(options.toolName);
    throw boundaryError;
  }
  let absolute: string;
  try {
    absolute = await guard.resolveInsideWorkspaceForCreate(path);
  } catch (error) {
    if (isWorkspaceBoundaryError(error)) {
      options.onViolation?.(options.toolName);
      throw error;
    }
    throw error;
  }
  return {
    absolute,
    displayPath: relative(guard.root, absolute),
  };
}

function parseTransformOperation(operation: string): "split" | "merge" | "reorder" | "rotate" {
  if (
    operation === "split" ||
    operation === "merge" ||
    operation === "reorder" ||
    operation === "rotate"
  ) {
    return operation;
  }
  throw new Error(`Unsupported PDF transform operation: ${operation}`);
}

function parseRotationDegrees(degrees: number): 90 | 180 | 270 {
  if (degrees === 90 || degrees === 180 || degrees === 270) return degrees;
  throw new Error("PDF rotation degrees must be 90, 180, or 270.");
}

export function createPdfToolDefinitions(
  guard: WorkspaceGuard,
  options?: {
    onViolation?: (toolName: string) => void;
    binaryRunner?: BinaryRunner;
    dimensionsReader?: PdfImageDimensionsReader;
  }
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

  const renderTool = defineTool({
    name: "pdf_render",
    label: "Render",
    description: "Render selected PDF pages to PNG files inside the selected workspace.",
    promptSnippet:
      "pdf_render: render selected PDF pages to PNG files for visual review. Use after pdf_inspect when appearance, signatures, scans, or layout matter.",
    parameters: renderSchema,
    async execute(_toolCallId, params: Static<typeof renderSchema>) {
      const { absolute, displayPath } = await resolvePdfWorkspacePath(guard, params.path, {
        mode: "mustExist",
        onViolation: options?.onViolation,
        toolName: "pdf_render",
      });
      const outputDir = await resolvePdfWorkspaceOutputDir(guard, params.outputDir, {
        onViolation: options?.onViolation,
        toolName: "pdf_render",
      });

      const result = await renderPdfPages(absolute, {
        displayPath,
        outputDir: outputDir.absolute,
        displayOutputDir: outputDir.displayPath,
        ...(params.pages !== undefined ? { pages: params.pages } : {}),
        ...(params.dpi !== undefined ? { dpi: params.dpi } : {}),
        ...(options?.binaryRunner !== undefined ? { binaryRunner: options.binaryRunner } : {}),
        ...(options?.dimensionsReader !== undefined
          ? { dimensionsReader: options.dimensionsReader }
          : {}),
      });
      return textResult(JSON.stringify(result), result);
    },
  }) satisfies PdfToolDefinition<typeof renderSchema>;

  const transformTool = defineTool({
    name: "pdf_transform",
    label: "Transform",
    description: "Create a transformed PDF output without mutating source PDFs.",
    promptSnippet:
      "pdf_transform: create a new PDF by split, merge, reorder, or rotate. Always write outputPath inside the workspace and validate the result with pdf_validate.",
    parameters: transformSchema,
    async execute(_toolCallId, params: Static<typeof transformSchema>) {
      const operation = parseTransformOperation(params.operation);
      const sources = await Promise.all(
        params.sources.map(async (source) => {
          const resolvedSource = await resolvePdfWorkspacePath(guard, source.path, {
            mode: "mustExist",
            onViolation: options?.onViolation,
            toolName: "pdf_transform",
          });
          return {
            path: resolvedSource.absolute,
            displayPath: resolvedSource.displayPath,
            ...(source.pages !== undefined ? { pages: source.pages } : {}),
          };
        })
      );
      const output = await resolvePdfWorkspaceOutputPath(guard, params.outputPath, {
        onViolation: options?.onViolation,
        toolName: "pdf_transform",
      });
      const rotation =
        params.rotation === undefined
          ? undefined
          : {
              degrees: parseRotationDegrees(params.rotation.degrees),
              ...(params.rotation.pages !== undefined ? { pages: params.rotation.pages } : {}),
            };

      const result = await transformPdfDocument({
        operation,
        sources,
        outputPath: output.absolute,
        displayOutputPath: output.displayPath,
        ...(rotation !== undefined ? { rotation } : {}),
        ...(options?.binaryRunner !== undefined ? { binaryRunner: options.binaryRunner } : {}),
      });
      return textResult(JSON.stringify(result), result);
    },
  }) satisfies PdfToolDefinition<typeof transformSchema>;

  return [inspectTool, extractTool, validateTool, renderTool, transformTool];
}
