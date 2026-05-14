# PDF Document Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first slice of Tessera's business-grade PDF operation surface: contracts, `pdf_inspect`, `pdf_extract`, `pdf_validate`, policy wiring, and the canonical `pdf-workflows` skill update.

**Architecture:** Keep `workspace_extract` as the generic bounded document reader. Add a focused PDF service in `packages/core` and expose it through typed `pdf_*` tools registered with the existing workspace tool surface. Preserve `pdf-workflows` as the single curated PDF skill. Use `engineRuntime` metadata for observability, while keeping Python execution scoped to declared skill helper entrypoints through `skill_run_python`.

**Tech Stack:** TypeScript, Bun test, Zod contracts, `@mariozechner/pi-ai` tool schemas, existing `unpdf` text extraction, Tessera workspace guard.

---

## Scope

This plan implements Slice 1 from the approved spec:

- PDF contracts and policy entries.
- PDF service scaffold with a TypeScript `unpdf` engine.
- `pdf_inspect`, `pdf_extract`, and `pdf_validate`.
- No new package dependency.
- No PDF mutation tools.
- No Python package or script execution in this first slice. Later Python support is scoped to declared skill helper entrypoints, not service-level engine adapters.
- One canonical skill: `packages/core/skills/pdf-workflows/SKILL.md`.

## File Structure

- Modify `packages/contracts/src/index.ts`: add PDF result schemas and add PDF tools to policy presets.
- Create `packages/contracts/src/pdf-tools.test.ts`: contract coverage for result schemas and tool policy entries.
- Create `packages/core/src/pdf-service.ts`: PDF inspection, extraction, validation, page range normalization, warning generation, and engine metadata.
- Create `packages/core/src/pdf-service.test.ts`: service-level fixture tests.
- Create `packages/core/src/pdf-tools.ts`: Pi tool definitions for `pdf_inspect`, `pdf_extract`, and `pdf_validate`.
- Create `packages/core/src/pdf-tools.test.ts`: tool-level workspace guard and execution tests.
- Modify `packages/core/src/workspace-tools.ts`: include the PDF tools in the workspace tool list.
- Modify `packages/core/src/workspace-tools.test.ts`: update registered tool expectations.
- Modify `packages/core/src/pi-session.test.ts`: update task runtime tool expectations for the added policy tools.
- Modify `packages/contracts/src/agent-profile.test.ts`: assert PDF tools in resolved policy.
- Modify `packages/core/skills/pdf-workflows/SKILL.md`: evolve the existing skill in place.
- Modify `packages/core/src/skills.test.ts` only if the existing skill assertions need a more specific updated phrase.

## Task 1: Contracts And Tool Policy

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/pdf-tools.test.ts`
- Modify: `packages/contracts/src/agent-profile.test.ts`
- Modify: `packages/contracts/src/skill.test.ts`

- [ ] **Step 1: Write failing PDF contract tests**

Create `packages/contracts/src/pdf-tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  PdfEngineRuntimeSchema,
  PdfExtractResultSchema,
  PdfInspectResultSchema,
  PdfValidateResultSchema,
  TOOL_POLICY_PRESET_DETAILS,
} from "./index.js";

describe("pdf tool contracts", () => {
  test("parses PDF inspect results with engine provenance", () => {
    const result = PdfInspectResultSchema.parse({
      path: "contracts/master.pdf",
      fileType: "pdf",
      bytes: 2048,
      pageCount: 2,
      encrypted: false,
      hasTextLayer: true,
      pagesWithText: [1, 2],
      metadata: {},
      engine: "unpdf",
      engineRuntime: "typescript",
      warnings: [],
    });

    expect(result.pageCount).toBe(2);
    expect(result.engineRuntime).toBe("typescript");
  });

  test("parses PDF extract results with page-scoped text", () => {
    const result = PdfExtractResultSchema.parse({
      path: "contracts/master.pdf",
      fileType: "pdf",
      bytes: 2048,
      text: "Extracted from: master.pdf\nType: PDF\n\n[Page 1]\nHello",
      pages: [{ pageNumber: 1, text: "Hello", charCount: 5, ocr: false }],
      truncated: false,
      engine: "unpdf",
      engineRuntime: "typescript",
      warnings: [],
    });

    expect(result.pages[0]?.ocr).toBe(false);
    expect(result.text).toContain("[Page 1]");
  });

  test("parses PDF validation results", () => {
    const result = PdfValidateResultSchema.parse({
      path: "contracts/master.pdf",
      exists: true,
      fileType: "pdf",
      bytes: 2048,
      pageCount: 1,
      hasTextLayer: true,
      passed: true,
      checks: [
        {
          name: "file_exists",
          passed: true,
          message: "File exists inside the workspace.",
        },
      ],
      engine: "unpdf",
      engineRuntime: "typescript",
      warnings: [],
    });

    expect(result.passed).toBe(true);
  });

  test("keeps Python as an allowed engine runtime without granting execution", () => {
    expect(PdfEngineRuntimeSchema.parse("python")).toBe("python");
  });

  test("exposes read-only PDF tools in every policy preset", () => {
    for (const details of Object.values(TOOL_POLICY_PRESET_DETAILS)) {
      expect(details.allowedTools).toContain("pdf_inspect");
      expect(details.allowedTools).toContain("pdf_extract");
      expect(details.allowedTools).toContain("pdf_validate");
    }
  });
});
```

- [ ] **Step 2: Run the contract tests and verify failure**

Run:

```bash
bun test packages/contracts/src/pdf-tools.test.ts
```

Expected: fails because `PdfEngineRuntimeSchema`, `PdfInspectResultSchema`, `PdfExtractResultSchema`, and `PdfValidateResultSchema` are not exported.

- [ ] **Step 3: Add PDF schemas to contracts**

In `packages/contracts/src/index.ts`, add this block after `TaskSkillActivationSchema`:

```ts
export const PdfEngineRuntimeSchema = z.enum(["typescript", "python", "binary"]);
export type PdfEngineRuntime = z.infer<typeof PdfEngineRuntimeSchema>;

export const PdfWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type PdfWarning = z.infer<typeof PdfWarningSchema>;

export const PdfPageRangeSchema = z
  .object({
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  })
  .strict();
export type PdfPageRange = z.infer<typeof PdfPageRangeSchema>;

export const PdfOperationProvenanceSchema = z
  .object({
    createdAt: z.string().datetime(),
    immutableSource: z.literal(true),
  })
  .strict();
export type PdfOperationProvenance = z.infer<typeof PdfOperationProvenanceSchema>;

export const PdfInspectResultSchema = z
  .object({
    path: z.string().min(1),
    fileType: z.literal("pdf"),
    bytes: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    encrypted: z.boolean(),
    hasTextLayer: z.boolean(),
    pagesWithText: z.array(z.number().int().positive()),
    metadata: z.record(z.string(), z.string()).default({}),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfInspectResult = z.infer<typeof PdfInspectResultSchema>;

export const PdfExtractPageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    text: z.string(),
    charCount: z.number().int().nonnegative(),
    ocr: z.boolean(),
  })
  .strict();
export type PdfExtractPage = z.infer<typeof PdfExtractPageSchema>;

export const PdfExtractResultSchema = z
  .object({
    path: z.string().min(1),
    fileType: z.literal("pdf"),
    bytes: z.number().int().nonnegative(),
    text: z.string(),
    pages: z.array(PdfExtractPageSchema),
    truncated: z.boolean(),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfExtractResult = z.infer<typeof PdfExtractResultSchema>;

export const PdfValidationCheckSchema = z
  .object({
    name: z.string().min(1),
    passed: z.boolean(),
    message: z.string().min(1),
  })
  .strict();
export type PdfValidationCheck = z.infer<typeof PdfValidationCheckSchema>;

export const PdfValidateResultSchema = z
  .object({
    path: z.string().min(1),
    exists: z.boolean(),
    fileType: z.literal("pdf"),
    bytes: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    hasTextLayer: z.boolean(),
    passed: z.boolean(),
    checks: z.array(PdfValidationCheckSchema),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfValidateResult = z.infer<typeof PdfValidateResultSchema>;
```

- [ ] **Step 4: Add PDF tools to tool policy presets**

In `packages/contracts/src/index.ts`, update every `TOOL_POLICY_PRESET_DETAILS` entry.

For `read_only`, change capabilities from:

```ts
"Extract PDF, Word, and Excel content",
```

to:

```ts
"Extract PDF, Word, Excel, and PowerPoint content",
"Inspect and validate PDFs",
```

Then insert these tools immediately after `"workspace_extract"`:

```ts
"pdf_inspect",
"pdf_extract",
"pdf_validate",
```

Make the same capability and allowed-tool additions in `workspace_editor` and `elevated_with_approval`.

- [ ] **Step 5: Update existing contract assertions**

In `packages/contracts/src/agent-profile.test.ts`, add these expectations in the `resolves tool policy presets into concrete capabilities` test:

```ts
expect(readOnly.allowedTools).toContain("pdf_inspect");
expect(readOnly.allowedTools).toContain("pdf_extract");
expect(readOnly.allowedTools).toContain("pdf_validate");
```

In the `compiles runtime summaries for the task inspector` test, add:

```ts
expect(runtime.toolPolicy.allowedTools).toContain("pdf_inspect");
expect(runtime.toolPolicy.allowedTools).toContain("pdf_extract");
expect(runtime.toolPolicy.allowedTools).toContain("pdf_validate");
```

In `packages/contracts/src/skill.test.ts`, extend the existing policy test:

```ts
expect(details.allowedTools).toContain("pdf_inspect");
expect(details.allowedTools).toContain("pdf_extract");
expect(details.allowedTools).toContain("pdf_validate");
```

- [ ] **Step 6: Run contract tests and verify pass**

Run:

```bash
bun test packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit contracts**

Run:

```bash
git add packages/contracts/src/index.ts packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts
git commit -m "Define PDF tool contracts and policy" -m "PDF operations need typed result metadata before core tools can expose inspect, extract, and validate behavior. This adds the read-only first-slice contracts and policy allowlist entries." -m "Constraint: First slice must not add new dependencies or PDF mutation tools" -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Keep Python as an engine runtime value, not as permission for arbitrary skill script execution" -m "Tested: bun test packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts"
```

## Task 2: PDF Service

**Files:**
- Create: `packages/core/src/pdf-service.ts`
- Create: `packages/core/src/pdf-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `packages/core/src/pdf-service.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extractPdfText,
  inspectPdfDocument,
  normalizePdfPageRange,
  validatePdfDocument,
} from "./pdf-service.js";

async function makeWorkspace() {
  const root = await mkdtemp("/tmp/tessera-pdf-service-");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "sample.pdf"), samplePdf("Hello PDF"));
  await writeFile(join(root, "docs", "not-pdf.txt"), "hello\n");
  return root;
}

function samplePdf(text: string): string {
  return `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length ${text.length + 35} >>stream
BT /F1 24 Tf 100 100 Td (${text}) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
trailer<< /Root 1 0 R >>
%%EOF`;
}

describe("pdf service", () => {
  test("normalizes page ranges against page count", () => {
    expect(normalizePdfPageRange(undefined, 3)).toEqual([1, 2, 3]);
    expect(normalizePdfPageRange({ start: 2 }, 3)).toEqual([2, 3]);
    expect(normalizePdfPageRange({ end: 2 }, 3)).toEqual([1, 2]);
    expect(normalizePdfPageRange({ start: 4, end: 6 }, 3)).toEqual([]);
  });

  test("inspects a text-layer PDF", async () => {
    const root = await makeWorkspace();
    const result = await inspectPdfDocument(join(root, "docs", "sample.pdf"), {
      displayPath: "docs/sample.pdf",
    });

    expect(result).toMatchObject({
      path: "docs/sample.pdf",
      fileType: "pdf",
      pageCount: 1,
      encrypted: false,
      hasTextLayer: true,
      pagesWithText: [1],
      engine: "unpdf",
      engineRuntime: "typescript",
    });
  });

  test("extracts page-scoped text with formatted page markers", async () => {
    const root = await makeWorkspace();
    const result = await extractPdfText(join(root, "docs", "sample.pdf"), {
      displayPath: "docs/sample.pdf",
      pages: { start: 1, end: 1 },
      maxChars: 1000,
    });

    expect(result.text).toContain("Extracted from: sample.pdf");
    expect(result.text).toContain("[Page 1]");
    expect(result.text).toContain("Hello PDF");
    expect(result.pages).toEqual([
      { pageNumber: 1, text: "Hello PDF", charCount: 9, ocr: false },
    ]);
  });

  test("validates a PDF against expected page count and text presence", async () => {
    const root = await makeWorkspace();
    const result = await validatePdfDocument(join(root, "docs", "sample.pdf"), {
      displayPath: "docs/sample.pdf",
      expectedPageCount: 1,
      expectedTextPresent: true,
    });

    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      "file_exists",
      "page_count",
      "text_present",
    ]);
  });

  test("reports missing PDFs as failed validation", async () => {
    const root = await makeWorkspace();
    const result = await validatePdfDocument(join(root, "docs", "missing.pdf"), {
      displayPath: "docs/missing.pdf",
      expectedPageCount: 1,
    });

    expect(result.exists).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "file_exists", passed: false });
  });

  test("rejects non-PDF files", async () => {
    const root = await makeWorkspace();

    await expect(inspectPdfDocument(join(root, "docs", "not-pdf.txt"))).rejects.toThrow(
      "Unsupported PDF input"
    );
  });
});
```

- [ ] **Step 2: Run the service tests and verify failure**

Run:

```bash
bun test packages/core/src/pdf-service.test.ts
```

Expected: fails because `packages/core/src/pdf-service.ts` does not exist.

- [ ] **Step 3: Implement the PDF service**

Create `packages/core/src/pdf-service.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type {
  PdfExtractResult,
  PdfInspectResult,
  PdfPageRange,
  PdfValidateResult,
  PdfValidationCheck,
  PdfWarning,
} from "@tessera/contracts";
import { extractText } from "unpdf";

const DEFAULT_MAX_CHARS = 100_000;
const MAX_PDF_FILE_BYTES = 25 * 1024 * 1024;
const ENGINE = "unpdf";
const ENGINE_RUNTIME = "typescript" as const;

export interface PdfDocumentOptions {
  displayPath?: string;
}

export interface PdfExtractOptions extends PdfDocumentOptions {
  pages?: PdfPageRange;
  maxChars?: number;
}

export interface PdfValidateOptions extends PdfDocumentOptions {
  expectedPageCount?: number;
  expectedTextPresent?: boolean;
}

interface PdfLoadResult {
  bytes: number;
  pages: string[];
}

function displayPathFor(path: string, displayPath?: string): string {
  return displayPath ?? basename(path);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

async function assertPdfFile(path: string): Promise<{ size: number }> {
  if (extname(path).toLowerCase() !== ".pdf") {
    throw new Error(`Unsupported PDF input: ${path}`);
  }
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Path is not a file: ${path}`);
  if (metadata.size > MAX_PDF_FILE_BYTES) {
    throw new Error(
      `PDF is too large to process (${metadata.size} bytes). Maximum supported size is ${MAX_PDF_FILE_BYTES} bytes.`
    );
  }
  return { size: metadata.size };
}

async function loadPdfText(path: string): Promise<PdfLoadResult> {
  const { size } = await assertPdfFile(path);
  const buffer = await readFile(path);
  const result = await extractText(new Uint8Array(buffer), { mergePages: false });
  return { bytes: size, pages: result.text };
}

export function normalizePdfPageRange(range: PdfPageRange | undefined, pageCount: number): number[] {
  if (pageCount <= 0) return [];
  const start = Math.max(1, positiveInteger(range?.start, 1));
  const end = Math.min(pageCount, positiveInteger(range?.end, pageCount));
  if (start > end) return [];
  return Array.from({ length: end - start + 1 }, (_value, index) => start + index);
}

function textLayerWarnings(pagesWithText: number[]): PdfWarning[] {
  return pagesWithText.length === 0
    ? [
        {
          code: "no_text_layer",
          message: "No extractable text layer was found. OCR may be required for scanned pages.",
        },
      ]
    : [];
}

export async function inspectPdfDocument(
  path: string,
  options: PdfDocumentOptions = {}
): Promise<PdfInspectResult> {
  const loaded = await loadPdfText(path);
  const pagesWithText = loaded.pages
    .map((text, index) => ({ pageNumber: index + 1, text: text.trim() }))
    .filter((page) => page.text.length > 0)
    .map((page) => page.pageNumber);

  return {
    path: displayPathFor(path, options.displayPath),
    fileType: "pdf",
    bytes: loaded.bytes,
    pageCount: loaded.pages.length,
    encrypted: false,
    hasTextLayer: pagesWithText.length > 0,
    pagesWithText,
    metadata: {},
    engine: ENGINE,
    engineRuntime: ENGINE_RUNTIME,
    warnings: textLayerWarnings(pagesWithText),
  };
}

function limitText(text: string, maxChars: number, warnings: PdfWarning[]) {
  if (text.length <= maxChars) return { text, truncated: false };
  warnings.push({
    code: "output_truncated",
    message: `Output truncated to ${maxChars} characters.`,
  });
  return { text: `${text.slice(0, maxChars)}\n\n[Output truncated]`, truncated: true };
}

export async function extractPdfText(
  path: string,
  options: PdfExtractOptions = {}
): Promise<PdfExtractResult> {
  const loaded = await loadPdfText(path);
  const selectedPages = normalizePdfPageRange(options.pages, loaded.pages.length);
  const extractedPages = selectedPages.map((pageNumber) => {
    const text = (loaded.pages[pageNumber - 1] ?? "").trim();
    return {
      pageNumber,
      text,
      charCount: text.length,
      ocr: false,
    };
  });
  const body = extractedPages
    .map((page) => `[Page ${page.pageNumber}]\n${page.text}`)
    .join("\n\n");
  const formatted = `Extracted from: ${basename(path)}\nType: PDF\n\n${body}`.trimEnd();
  const warnings = textLayerWarnings(
    extractedPages.filter((page) => page.text.length > 0).map((page) => page.pageNumber)
  );
  const limited = limitText(formatted, positiveInteger(options.maxChars, DEFAULT_MAX_CHARS), warnings);

  return {
    path: displayPathFor(path, options.displayPath),
    fileType: "pdf",
    bytes: loaded.bytes,
    text: limited.text,
    pages: extractedPages,
    truncated: limited.truncated,
    engine: ENGINE,
    engineRuntime: ENGINE_RUNTIME,
    warnings,
  };
}

export async function validatePdfDocument(
  path: string,
  options: PdfValidateOptions = {}
): Promise<PdfValidateResult> {
  if (extname(path).toLowerCase() !== ".pdf") {
    throw new Error(`Unsupported PDF input: ${path}`);
  }

  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) {
    const checks: PdfValidationCheck[] = [
      {
        name: "file_exists",
        passed: false,
        message: "PDF file does not exist inside the workspace.",
      },
    ];
    return {
      path: displayPathFor(path, options.displayPath),
      exists: false,
      fileType: "pdf",
      bytes: 0,
      pageCount: 0,
      hasTextLayer: false,
      passed: false,
      checks,
      engine: ENGINE,
      engineRuntime: ENGINE_RUNTIME,
      warnings: [],
    };
  }

  const inspected = await inspectPdfDocument(path, options);
  const checks: PdfValidationCheck[] = [
    {
      name: "file_exists",
      passed: true,
      message: "File exists inside the workspace.",
    },
  ];

  if (options.expectedPageCount !== undefined) {
    const passed = inspected.pageCount === options.expectedPageCount;
    checks.push({
      name: "page_count",
      passed,
      message: passed
        ? `Page count matches expected value ${options.expectedPageCount}.`
        : `Expected ${options.expectedPageCount} pages but found ${inspected.pageCount}.`,
    });
  }

  if (options.expectedTextPresent !== undefined) {
    const passed = inspected.hasTextLayer === options.expectedTextPresent;
    checks.push({
      name: "text_present",
      passed,
      message: passed
        ? "Text-layer presence matches expectation."
        : `Expected text-layer presence ${options.expectedTextPresent} but found ${inspected.hasTextLayer}.`,
    });
  }

  return {
    path: inspected.path,
    exists: true,
    fileType: "pdf",
    bytes: inspected.bytes,
    pageCount: inspected.pageCount,
    hasTextLayer: inspected.hasTextLayer,
    passed: checks.every((check) => check.passed),
    checks,
    engine: inspected.engine,
    engineRuntime: inspected.engineRuntime,
    warnings: inspected.warnings,
  };
}
```

- [ ] **Step 4: Run service tests and verify pass**

Run:

```bash
bun test packages/core/src/pdf-service.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit service**

Run:

```bash
git add packages/core/src/pdf-service.ts packages/core/src/pdf-service.test.ts
git commit -m "Add PDF service foundation" -m "The PDF tools need a focused service for inspection, extraction, validation, page ranges, warnings, and engine metadata. This first engine reuses existing unpdf capability without adding dependencies." -m "Constraint: Originals remain immutable and first slice exposes no mutation operations" -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Add Python adapters behind this service boundary rather than calling Python directly from skills" -m "Tested: bun test packages/core/src/pdf-service.test.ts"
```

## Task 3: PDF Tool Definitions

**Files:**
- Create: `packages/core/src/pdf-tools.ts`
- Create: `packages/core/src/pdf-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Create `packages/core/src/pdf-tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPdfToolDefinitions } from "./pdf-tools.js";
import { createWorkspaceGuard } from "./workspace-guard.js";

async function makeTools() {
  const root = await realpath(await mkdtemp("/tmp/tessera-pdf-tools-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "sample.pdf"), samplePdf("Hello PDF"));
  const guard = await createWorkspaceGuard(root);
  return { root, tools: createPdfToolDefinitions(guard) };
}

function samplePdf(text: string): string {
  return `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length ${text.length + 35} >>stream
BT /F1 24 Tf 100 100 Td (${text}) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
trailer<< /Root 1 0 R >>
%%EOF`;
}

function tool(tools: ReturnType<typeof createPdfToolDefinitions>, name: string) {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (item?.type !== "text" || typeof item.text !== "string") {
    throw new Error("Expected a text tool result");
  }
  return item.text;
}

describe("createPdfToolDefinitions", () => {
  test("registers read-only PDF tools", async () => {
    const { tools } = await makeTools();

    expect(tools.map((item) => item.name).sort()).toEqual([
      "pdf_extract",
      "pdf_inspect",
      "pdf_validate",
    ]);
  });

  test("inspects, extracts, and validates workspace PDFs", async () => {
    const { tools } = await makeTools();

    const inspect = await tool(tools, "pdf_inspect").execute(
      "call-inspect",
      { path: "docs/sample.pdf" },
      undefined,
      undefined,
      undefined as never
    );
    const extract = await tool(tools, "pdf_extract").execute(
      "call-extract",
      { path: "docs/sample.pdf", pages: { start: 1, end: 1 }, maxChars: 1000 },
      undefined,
      undefined,
      undefined as never
    );
    const validate = await tool(tools, "pdf_validate").execute(
      "call-validate",
      { path: "docs/sample.pdf", expectedPageCount: 1, expectedTextPresent: true },
      undefined,
      undefined,
      undefined as never
    );

    expect(inspect.details).toMatchObject({
      path: "docs/sample.pdf",
      pageCount: 1,
      hasTextLayer: true,
    });
    expect(resultText(extract)).toContain("Hello PDF");
    expect(validate.details).toMatchObject({
      path: "docs/sample.pdf",
      passed: true,
    });
  });

  test("denies PDF reads outside the workspace and reports the tool name", async () => {
    const root = await realpath(await mkdtemp("/tmp/tessera-pdf-tools-deny-"));
    const guard = await createWorkspaceGuard(root);
    const violations: string[] = [];
    const tools = createPdfToolDefinitions(guard, {
      onViolation: (toolName) => violations.push(toolName),
    });

    await expect(
      tool(tools, "pdf_inspect").execute(
        "call-inspect",
        { path: "../outside.pdf" },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow("outside the workspace");

    expect(violations).toEqual(["pdf_inspect"]);
  });

  test("validates missing PDF paths without leaving the workspace boundary", async () => {
    const { tools } = await makeTools();

    const validate = await tool(tools, "pdf_validate").execute(
      "call-validate",
      { path: "docs/missing.pdf" },
      undefined,
      undefined,
      undefined as never
    );

    expect(validate.details).toMatchObject({
      path: "docs/missing.pdf",
      exists: false,
      passed: false,
    });
  });
});
```

- [ ] **Step 2: Run tool tests and verify failure**

Run:

```bash
bun test packages/core/src/pdf-tools.test.ts
```

Expected: fails because `packages/core/src/pdf-tools.ts` does not exist.

- [ ] **Step 3: Implement PDF tool definitions**

Create `packages/core/src/pdf-tools.ts`:

```ts
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, type TSchema, Type } from "@mariozechner/pi-ai";
import { type ToolDefinition, defineTool } from "@mariozechner/pi-coding-agent";
import {
  extractPdfText,
  inspectPdfDocument,
  validatePdfDocument,
  type PdfExtractOptions,
  type PdfValidateOptions,
} from "./pdf-service.js";
import { WorkspaceBoundaryError, type WorkspaceGuard } from "./workspace-guard.js";

type PdfToolDefinition<TParams extends TSchema, TDetails = unknown> = ToolDefinition<
  TParams,
  TDetails
>;

const pageRangeSchema = Type.Object({
  start: Type.Optional(Type.Number()),
  end: Type.Optional(Type.Number()),
});

const inspectSchema = Type.Object({
  path: Type.String(),
});

const extractSchema = Type.Object({
  path: Type.String(),
  pages: Type.Optional(pageRangeSchema),
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

async function resolveExisting(
  guard: WorkspaceGuard,
  toolName: string,
  path: string,
  onViolation?: (toolName: string) => void
): Promise<string> {
  try {
    return await guard.resolveInsideWorkspace(path);
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) onViolation?.(toolName);
    throw error;
  }
}

async function resolveForValidation(
  guard: WorkspaceGuard,
  path: string,
  onViolation?: (toolName: string) => void
): Promise<string> {
  try {
    return await guard.resolveInsideWorkspace(path);
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) {
      onViolation?.("pdf_validate");
      throw error;
    }
    return guard.resolveInsideWorkspaceForCreate(path).catch((createError) => {
      if (createError instanceof WorkspaceBoundaryError) onViolation?.("pdf_validate");
      throw createError;
    });
  }
}

export function createPdfToolDefinitions(
  guard: WorkspaceGuard,
  options?: { onViolation?: (toolName: string) => void }
): ToolDefinition[] {
  const inspectTool = defineTool({
    name: "pdf_inspect",
    label: "Inspect PDF",
    description: "Inspect a PDF inside the selected workspace for page count and text-layer status.",
    promptSnippet:
      "pdf_inspect: inspect a PDF before extracting or transforming it. Returns page count, text-layer status, engine metadata, and warnings.",
    parameters: inspectSchema,
    async execute(_toolCallId, params: Static<typeof inspectSchema>) {
      const absolute = await resolveExisting(
        guard,
        "pdf_inspect",
        params.path,
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
    label: "Extract PDF",
    description: "Extract page-scoped text from a PDF inside the selected workspace.",
    promptSnippet:
      "pdf_extract: extract page-scoped text from a PDF. Use pages and maxChars to keep output focused. OCR is not enabled in this first slice.",
    parameters: extractSchema,
    async execute(_toolCallId, params: Static<typeof extractSchema>) {
      const absolute = await resolveExisting(
        guard,
        "pdf_extract",
        params.path,
        options?.onViolation
      );
      const extractOptions: PdfExtractOptions = {
        displayPath: relative(guard.root, absolute),
      };
      if (params.pages !== undefined) extractOptions.pages = params.pages;
      if (params.maxChars !== undefined) extractOptions.maxChars = params.maxChars;
      const result = await extractPdfText(absolute, extractOptions);
      return textResult(result.text, result);
    },
  }) satisfies PdfToolDefinition<typeof extractSchema>;

  const validateTool = defineTool({
    name: "pdf_validate",
    label: "Validate PDF",
    description: "Validate an existing or expected PDF path inside the selected workspace.",
    promptSnippet:
      "pdf_validate: validate PDF existence, page count, and text-layer expectations. Use after any PDF export or before relying on a PDF packet.",
    parameters: validateSchema,
    async execute(_toolCallId, params: Static<typeof validateSchema>) {
      const absolute = await resolveForValidation(guard, params.path, options?.onViolation);
      const validateOptions: PdfValidateOptions = {
        displayPath: relative(guard.root, absolute),
      };
      if (params.expectedPageCount !== undefined) {
        validateOptions.expectedPageCount = params.expectedPageCount;
      }
      if (params.expectedTextPresent !== undefined) {
        validateOptions.expectedTextPresent = params.expectedTextPresent;
      }
      const exists = await stat(absolute).then(
        () => true,
        () => false
      );
      const result = await validatePdfDocument(absolute, {
        ...validateOptions,
        displayPath: exists ? relative(guard.root, absolute) : params.path,
      });
      return textResult(JSON.stringify(result), result);
    },
  }) satisfies PdfToolDefinition<typeof validateSchema>;

  return [inspectTool, extractTool, validateTool];
}
```

- [ ] **Step 4: Run PDF tool tests and verify pass**

Run:

```bash
bun test packages/core/src/pdf-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit PDF tools**

Run:

```bash
git add packages/core/src/pdf-tools.ts packages/core/src/pdf-tools.test.ts
git commit -m "Expose PDF inspect extract and validate tools" -m "Agents need first-class read-only PDF operations before mutation workflows are added. This wires the PDF service into Pi tool definitions with workspace containment and structured details." -m "Constraint: Tools must not read outside the selected workspace" -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Keep mutating PDF tools out of this first slice" -m "Tested: bun test packages/core/src/pdf-tools.test.ts"
```

## Task 4: Runtime Wiring

**Files:**
- Modify: `packages/core/src/workspace-tools.ts`
- Modify: `packages/core/src/workspace-tools.test.ts`
- Modify: `packages/core/src/pi-session.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Update failing workspace registration expectations**

In `packages/core/src/workspace-tools.test.ts`, update the `registers workspace tools without bash` expectation to include the new tools:

```ts
expect(tools.map((item) => item.name).sort()).toEqual([
  "pdf_extract",
  "pdf_inspect",
  "pdf_validate",
  "workspace_edit",
  "workspace_extract",
  "workspace_list",
  "workspace_read",
  "workspace_search",
  "workspace_write",
]);
```

- [ ] **Step 2: Update Pi session tool expectations**

In `packages/core/src/pi-session.test.ts`, update exact sorted tool arrays that currently list only workspace tools.

The default tool list expectation should become:

```ts
expect(seen.customTools?.map((item) => item.name).sort()).toEqual([
  "pdf_extract",
  "pdf_inspect",
  "pdf_validate",
  "workspace_edit",
  "workspace_extract",
  "workspace_list",
  "workspace_read",
  "workspace_search",
  "workspace_write",
]);
```

The elevated-with-approval exact tool list should become:

```ts
expect(seen.customToolNames).toEqual([
  "pdf_extract",
  "pdf_inspect",
  "pdf_validate",
  "workspace_edit",
  "workspace_extract",
  "workspace_list",
  "workspace_read",
  "workspace_search",
  "workspace_write",
]);
```

- [ ] **Step 3: Run runtime tests and verify failure**

Run:

```bash
bun test packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts
```

Expected: fails because `createWorkspaceToolDefinitions` has not included the PDF tools yet.

- [ ] **Step 4: Wire PDF tools into workspace tools**

In `packages/core/src/workspace-tools.ts`, add this import:

```ts
import { createPdfToolDefinitions } from "./pdf-tools.js";
```

At the bottom of `createWorkspaceToolDefinitions`, replace:

```ts
return [readTool, extractTool, listTool, searchTool, writeTool, editTool];
```

with:

```ts
return [
  ...createPdfToolDefinitions(guard, options),
  readTool,
  extractTool,
  listTool,
  searchTool,
  writeTool,
  editTool,
];
```

- [ ] **Step 5: Export the PDF tool factory**

In `packages/core/src/index.ts`, add:

```ts
export { createPdfToolDefinitions } from "./pdf-tools.js";
export {
  extractPdfText,
  inspectPdfDocument,
  normalizePdfPageRange,
  validatePdfDocument,
  type PdfDocumentOptions,
  type PdfExtractOptions,
  type PdfValidateOptions,
} from "./pdf-service.js";
```

- [ ] **Step 6: Run runtime tests and verify pass**

Run:

```bash
bun test packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit runtime wiring**

Run:

```bash
git add packages/core/src/workspace-tools.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts packages/core/src/index.ts
git commit -m "Wire PDF tools into task runtime" -m "PDF inspect, extract, and validate should be available through the existing workspace tool registration and policy filtering path. This keeps the Pi session integration centralized." -m "Constraint: Tool policy controls which registered tools reach the active task" -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Register future pdf_* tools through the same PDF tool factory" -m "Tested: bun test packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts"
```

## Task 5: Canonical PDF Skill Update

**Files:**
- Modify: `packages/core/skills/pdf-workflows/SKILL.md`
- Modify: `packages/core/src/skills.test.ts`

- [ ] **Step 1: Update the skill test expectation first**

In `packages/core/src/skills.test.ts`, keep the existing `pdf-workflows` skill ID and replace the PDF content assertion with:

```ts
await expect(registry.loadSkill("pdf-workflows")).resolves.toMatchObject({
  source: "curated",
  content: expect.stringContaining("Always inspect PDFs before extracting or changing them."),
});
```

- [ ] **Step 2: Run skill tests and verify failure**

Run:

```bash
bun test packages/core/src/skills.test.ts
```

Expected: fails because the existing skill body does not contain the new inspection-first sentence.

- [ ] **Step 3: Replace the PDF skill body in place**

Replace `packages/core/skills/pdf-workflows/SKILL.md` with:

```md
---
name: pdf-workflows
description: Inspect, extract, validate, and package PDF-based business artifacts.
---

# PDF Workflows

Use this skill when the source or requested output is a PDF: contracts, reports, invoices, board packs, forms, research papers, exports, or scanned documents.

## Workflow

1. Always inspect PDFs before extracting or changing them.
2. Use `pdf_inspect` to identify page count, text-layer status, scan risk, engine metadata, and warnings.
3. Use `pdf_extract` for page-scoped text extraction. Keep page ranges narrow when the user asks about a specific clause, table, figure, or signature block.
4. Preserve page references for claims, issues, extracted facts, dates, parties, and financial values so the user can audit the result.
5. Use `pdf_validate` before relying on a PDF packet and after any exported PDF is produced by a future transform, form, or redaction tool.
6. Treat OCR-derived content as lower-confidence than a text layer. Label OCR content when OCR tools become available.
7. Preserve originals. PDF mutation tools must create new output files and report provenance.
8. For review, flag missing pages, unreadable scans, inconsistent numbers, redaction risks, signature status, and terms that require legal or finance review.

## Tool Use

- `pdf_inspect`: first call for any PDF-specific workflow.
- `pdf_extract`: page-scoped extraction with page markers.
- `pdf_validate`: existence, page count, text-layer expectation, pass/fail checks, provenance, and warnings.
- `workspace_extract`: fallback reader for general document extraction when PDF-specific tools are unavailable.

## Delivery

Produce a concise extraction, review memo, conversion-ready structure, or file update. Always note scan quality, omitted pages, warnings, validation status, and content that could not be verified from the PDF.
```

- [ ] **Step 4: Run skill tests and verify pass**

Run:

```bash
bun test packages/core/src/skills.test.ts
```

Expected: all tests pass and the curated skill list still contains only `pdf-workflows` for PDF behavior.

- [ ] **Step 5: Commit skill update**

Run:

```bash
git add packages/core/skills/pdf-workflows/SKILL.md packages/core/src/skills.test.ts
git commit -m "Evolve the canonical PDF workflow skill" -m "The repo already has pdf-workflows as the curated PDF skill, so the first PDF operations slice updates it in place with tool-backed guidance instead of introducing a duplicate skill." -m "Constraint: Maintain one curated PDF skill ID" -m "Rejected: Add pdf-documents | duplicates the feature surface and breaks the canonical skill strategy" -m "Confidence: high" -m "Scope-risk: narrow" -m "Directive: Keep pdf-workflows as the canonical PDF skill unless a migration handles stored skill references" -m "Tested: bun test packages/core/src/skills.test.ts"
```

## Task 6: Full Verification And Cleanup

**Files:**
- Review all files changed in Tasks 1-5.

- [ ] **Step 1: Run focused PDF and skill tests**

Run:

```bash
bun test packages/contracts/src/pdf-tools.test.ts packages/core/src/pdf-service.test.ts packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts packages/core/src/skills.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run package-level type checks**

Run:

```bash
bun run --filter ./packages/contracts typecheck
bun run --filter ./packages/core typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Run full repository verification**

Run:

```bash
bun run check
bun test
```

Expected: both commands exit 0.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD~5..HEAD
```

Expected: only PDF operation contracts, service, tools, tests, runtime wiring, and `pdf-workflows` skill changes are present.

- [ ] **Step 5: Create final verification commit if needed**

If Step 1-4 required fixes after the previous commits, commit only those fixes:

```bash
git add packages/contracts/src/index.ts packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts packages/core/src/pdf-service.ts packages/core/src/pdf-service.test.ts packages/core/src/pdf-tools.ts packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts packages/core/src/index.ts packages/core/skills/pdf-workflows/SKILL.md packages/core/src/skills.test.ts
git commit -m "Stabilize first PDF operations slice" -m "Focused and full verification identified final integration fixes for the PDF inspect, extract, validate, and canonical skill slice." -m "Constraint: Keep first slice read-only and dependency-light" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: bun run check; bun test"
```

Expected: if no fixes were needed, skip this commit and leave the tree clean.

## Implementation Notes

- Do not add `pdf_transform`, `pdf_render`, `pdf_redact`, or `pdf_form` in this slice.
- Do not add a `pdf-documents` skill.
- Do not install Python packages in this slice.
- Do not let `pdf-workflows` imply extra permissions; tool policy remains the authority.
- Preserve `workspace_extract` behavior except for the policy capability wording.
- Use `engineRuntime: "typescript"` for the first engine. Python remains a runtime metadata value, but execution is introduced through scoped skill helpers rather than arbitrary PDF service adapters.

## Self-Review

Spec coverage:

- First-class PDF tool surface: covered by Tasks 1, 3, and 4.
- Immutable originals: first slice is read-only; mutating tools are out of scope.
- Structured metadata, warnings, and provenance-ready engine runtime: covered by Tasks 1 and 2.
- Python as a scoped helper runtime: covered by contract `PdfEngineRuntimeSchema` and later `skill_run_python` implementation notes.
- One canonical skill: covered by Task 5.
- `workspace_extract` remains focused: no plan step changes its extraction behavior.

Known remaining work after this plan:

- `pdf_redact` and `pdf_form`.
- More Python helper scripts and dependency discovery for skill workflows.
- OCR, table extraction, signature checks, archival checks, and packet manifests.
