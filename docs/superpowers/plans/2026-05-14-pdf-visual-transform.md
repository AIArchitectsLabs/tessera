# PDF Visual And Transform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Slice 2 of the PDF operations surface: page rendering plus safe immutable PDF split, merge, reorder, and rotate transforms.

**Architecture:** Extend the existing typed PDF tool family with `pdf_render` and `pdf_transform`. Keep source PDFs immutable, resolve every input/output through `WorkspaceGuard`, and put binary execution behind a small core service adapter with injectable runners for tests. Use `pdftoppm` for rendering and `qpdf` for transformations when present; return clear engine-unavailable errors when a binary is missing.

**Tech Stack:** Bun, TypeScript, Zod contracts, Pi tool definitions, existing workspace guard, controlled `node:child_process` binary adapters, `unpdf` inspection/validation for output verification.

---

## Scope

This implements Slice 2 from `docs/superpowers/specs/2026-05-13-pdf-document-operations-design.md`.

Included:
- `pdf_render` for page-scoped PNG rendering into a workspace output directory.
- `pdf_transform` for `split`, `merge`, `reorder`, and `rotate`.
- Structured result contracts with engine metadata, warnings, output paths, and provenance.
- Runtime tool registration and policy allowlist entries.
- Tests that do not require real `qpdf` or `pdftoppm`.

Excluded:
- OCR, redaction, forms, stamping, watermarking, compression, linearization.
- Arbitrary shell or Python execution from skills.
- In-place source mutation.

## File Map

- Modify `packages/contracts/src/index.ts`
  - Add render/transform result schemas and tool policy entries.
- Modify `packages/contracts/src/pdf-tools.test.ts`
  - Add contract tests for `pdf_render` and `pdf_transform`.
- Modify `packages/core/src/pdf-service.ts`
  - Add binary runner type, render, transform, page mapping helpers, and engine-unavailable handling.
- Modify `packages/core/src/pdf-service.test.ts`
  - Add fake-runner tests for render and transform outputs.
- Modify `packages/core/src/pdf-tools.ts`
  - Add `pdf_render` and `pdf_transform` tool definitions.
- Modify `packages/core/src/pdf-tools.test.ts`
  - Add workspace-boundary and output-path coverage.
- Modify `packages/core/src/workspace-tools.test.ts`
  - Update registered tool order assertions.
- Modify `packages/core/src/pi-session.test.ts`
  - Update task runtime tool allowlist/order expectations.
- Modify `packages/core/skills/pdf-workflows/SKILL.md`
  - Add render and transform guidance without overclaiming redaction/forms/OCR.
- Modify `packages/core/src/skills.test.ts`
  - Add durable content assertions for render/transform guidance.
- Modify `packages/core/src/index.ts`
  - Export new service types/functions if needed.

## Task 1: Contracts And Policy

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/pdf-tools.test.ts`
- Modify: `packages/contracts/src/agent-profile.test.ts`
- Modify: `packages/contracts/src/skill.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests in `packages/contracts/src/pdf-tools.test.ts`:

```ts
test("parses PDF render results with generated page images", () => {
  expect(
    PdfRenderResultSchema.parse({
      path: "docs/source.pdf",
      fileType: "pdf",
      outputs: [
        {
          pageNumber: 1,
          path: "renders/source-page-1.png",
          format: "png",
          width: 612,
          height: 792,
        },
      ],
      engine: "pdftoppm",
      engineRuntime: "binary",
      provenance: {
        createdAt: new Date().toISOString(),
        immutableSource: true,
      },
      warnings: [],
    }).outputs[0]?.path
  ).toBe("renders/source-page-1.png");
});

test("parses PDF transform results with source mapping", () => {
  expect(
    PdfTransformResultSchema.parse({
      outputPath: "out/packet.pdf",
      fileType: "pdf",
      operation: "merge",
      sourcePaths: ["a.pdf", "b.pdf"],
      pageMapping: [
        { sourcePath: "a.pdf", sourcePage: 1, outputPage: 1 },
        { sourcePath: "b.pdf", sourcePage: 1, outputPage: 2 },
      ],
      engine: "qpdf",
      engineRuntime: "binary",
      provenance: {
        createdAt: new Date().toISOString(),
        immutableSource: true,
      },
      warnings: [],
    }).operation
  ).toBe("merge");
});

test("exposes visual and transform PDF tools in every policy preset", () => {
  for (const policy of Object.values(ToolPolicyPresetSchema.enum)) {
    const tools = resolveToolPolicyPreset(policy).tools.map((tool) => tool.name);
    expect(tools).toContain("pdf_render");
    expect(tools).toContain("pdf_transform");
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test packages/contracts/src/pdf-tools.test.ts
```

Expected: fails because `PdfRenderResultSchema` and `PdfTransformResultSchema` are not exported and policy presets do not include the new tools.

- [ ] **Step 3: Add schemas**

Add these schemas near the existing PDF schemas in `packages/contracts/src/index.ts`:

```ts
export const PdfRenderOutputSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    path: z.string().min(1),
    format: z.enum(["png"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type PdfRenderOutput = z.infer<typeof PdfRenderOutputSchema>;

export const PdfRenderResultSchema = z
  .object({
    path: z.string().min(1),
    fileType: z.literal("pdf"),
    outputs: z.array(PdfRenderOutputSchema),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfRenderResult = z.infer<typeof PdfRenderResultSchema>;

export const PdfTransformOperationSchema = z.enum(["split", "merge", "reorder", "rotate"]);
export type PdfTransformOperation = z.infer<typeof PdfTransformOperationSchema>;

export const PdfPageMappingSchema = z
  .object({
    sourcePath: z.string().min(1),
    sourcePage: z.number().int().positive(),
    outputPage: z.number().int().positive(),
  })
  .strict();
export type PdfPageMapping = z.infer<typeof PdfPageMappingSchema>;

export const PdfTransformResultSchema = z
  .object({
    outputPath: z.string().min(1),
    fileType: z.literal("pdf"),
    operation: PdfTransformOperationSchema,
    sourcePaths: z.array(z.string().min(1)).min(1),
    pageMapping: z.array(PdfPageMappingSchema),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfTransformResult = z.infer<typeof PdfTransformResultSchema>;
```

- [ ] **Step 4: Add policy entries**

Add `pdf_render` and `pdf_transform` after `pdf_validate` in each tool policy preset. Use descriptions:

```ts
{ name: "pdf_render", description: "Render PDF pages to workspace image files" }
{ name: "pdf_transform", description: "Create transformed PDF outputs without mutating originals" }
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
bun test packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts
bun run --filter ./packages/contracts typecheck
```

Commit:

```bash
git add packages/contracts/src/index.ts packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts
git commit -m "Define PDF render and transform contracts" -m "Slice 2 needs typed outputs before runtime tools can expose generated images and immutable transformed PDFs." -m "Constraint: Transform tools must create new workspace outputs instead of mutating sources." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: bun test packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts" -m "Tested: bun run --filter ./packages/contracts typecheck"
```

## Task 2: PDF Service Render And Transform

**Files:**
- Modify: `packages/core/src/pdf-service.ts`
- Modify: `packages/core/src/pdf-service.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing service tests**

Add tests with injected fake runners:

```ts
test("renders selected pages with an injected binary runner", async () => {
  const { root, pdfPath } = await makeFixture();
  const result = await renderPdfPages(pdfPath, {
    outputDir: join(root, "renders"),
    pages: { start: 1, end: 1 },
    binaryRunner: async ({ args }) => {
      const outputPrefix = args.at(-1);
      if (typeof outputPrefix !== "string") throw new Error("missing output prefix");
      await writeFile(`${outputPrefix}-1.png`, Buffer.from("png"));
      return { stdout: "", stderr: "" };
    },
    dimensionsReader: async () => ({ width: 612, height: 792 }),
  });

  expect(result.outputs).toEqual([
    { pageNumber: 1, path: "sample-page-1.png", format: "png", width: 612, height: 792 },
  ]);
  expect(result.engineRuntime).toBe("binary");
});

test("creates a rotated PDF output with an injected qpdf runner", async () => {
  const { root, pdfPath } = await makeFixture();
  const outputPath = join(root, "out", "rotated.pdf");
  const result = await transformPdfDocument({
    operation: "rotate",
    sources: [{ path: pdfPath }],
    outputPath,
    rotation: { degrees: 90, pages: { start: 1, end: 1 } },
    binaryRunner: async ({ args }) => {
      const destination = args.at(-1);
      if (typeof destination !== "string") throw new Error("missing destination");
      await writeFile(destination, samplePdf("Rotated"));
      return { stdout: "", stderr: "" };
    },
  });

  expect(result).toMatchObject({
    outputPath: "rotated.pdf",
    operation: "rotate",
    sourcePaths: ["sample.pdf"],
    pageMapping: [{ sourcePath: "sample.pdf", sourcePage: 1, outputPage: 1 }],
    engine: "qpdf",
    engineRuntime: "binary",
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test packages/core/src/pdf-service.test.ts
```

Expected: fails because `renderPdfPages` and `transformPdfDocument` are not implemented.

- [ ] **Step 3: Implement service functions**

In `packages/core/src/pdf-service.ts`:

- Add `BinaryRunner` with `command`, `args`, `cwd` input.
- Add default runner using `node:child_process` `execFile`.
- Add `renderPdfPages(path, options)`:
  - inspect source page count with existing PDF helpers.
  - normalize requested pages.
  - create output directory with `mkdir(..., { recursive: true })`.
  - run `pdftoppm -png -f <first> -l <last> -r <dpi> <source> <prefix>`.
  - return one output per page with relative display paths, `engine: "pdftoppm"`, `engineRuntime: "binary"`.
- Add `transformPdfDocument(options)`:
  - validate all source inputs are PDFs.
  - create output parent directory.
  - build qpdf args for:
    - split/reorder: `qpdf <source> --pages <source> <ranges> -- <output>`.
    - merge: `qpdf --empty --pages <source1> <range> <source2> <range> -- <output>`.
    - rotate: `qpdf <source> --rotate=<degrees>:<range> -- <output>`.
  - compute page mapping from inspected source page counts and normalized ranges.
  - return structured result and provenance.
- On missing binary (`ENOENT`), throw `PDF engine unavailable: <binary>`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
bun test packages/core/src/pdf-service.test.ts
bun run --filter ./packages/core typecheck
bunx biome check packages/core/src/pdf-service.ts packages/core/src/pdf-service.test.ts packages/core/src/index.ts
```

Commit:

```bash
git add packages/core/src/pdf-service.ts packages/core/src/pdf-service.test.ts packages/core/src/index.ts
git commit -m "Add PDF render and transform service adapters" -m "Slice 2 needs generated page images and immutable PDF outputs behind typed service boundaries. Binary adapters are injectable for tests and fail clearly when qpdf or pdftoppm are unavailable." -m "Constraint: Source PDFs are never modified in place." -m "Rejected: Use arbitrary shell commands from skills | PDF binaries must stay behind typed tool APIs." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: bun test packages/core/src/pdf-service.test.ts" -m "Tested: bun run --filter ./packages/core typecheck"
```

## Task 3: Tool Definitions And Workspace Boundaries

**Files:**
- Modify: `packages/core/src/pdf-tools.ts`
- Modify: `packages/core/src/pdf-tools.test.ts`
- Modify: `packages/core/src/workspace-tools.test.ts`
- Modify: `packages/core/src/pi-session.test.ts`

- [ ] **Step 1: Write failing tool tests**

Add tests that:
- assert registered PDF tool order includes `pdf_render`, `pdf_transform`.
- render output path stays inside workspace.
- transform output path stays inside workspace.
- outside output path is denied and calls `onViolation`.

- [ ] **Step 2: Implement tools**

Add:
- `pdf_render` parameters: `{ path, pages?, outputDir, dpi? }`
- `pdf_transform` parameters:

```ts
{
  operation: "split" | "merge" | "reorder" | "rotate",
  sources: Array<{ path: string; pages?: { start?: number; end?: number } }>,
  outputPath: string,
  rotation?: { degrees: 90 | 180 | 270; pages?: { start?: number; end?: number } }
}
```

Use `guard.resolveInsideWorkspace` for source paths and `guard.resolveInsideWorkspaceForCreate` for output paths. Return JSON text plus structured details.

- [ ] **Step 3: Wire order**

Tool order should be:

```ts
workspace_read
workspace_extract
pdf_inspect
pdf_extract
pdf_validate
pdf_render
pdf_transform
workspace_list
workspace_search
workspace_write
workspace_edit
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
bun test packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts
bun run --filter ./packages/core typecheck
bunx biome check packages/core/src/pdf-tools.ts packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts
```

Commit:

```bash
git add packages/core/src/pdf-tools.ts packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts
git commit -m "Expose PDF render and transform tools" -m "Agents need visual review outputs and immutable transform outputs through the same workspace-safe PDF tool surface as inspect, extract, and validate." -m "Constraint: Output paths must remain inside the selected workspace." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: bun test packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts"
```

## Task 4: Canonical Skill Update

**Files:**
- Modify: `packages/core/skills/pdf-workflows/SKILL.md`
- Modify: `packages/core/src/skills.test.ts`

- [ ] **Step 1: Update skill guidance**

Add:
- use `pdf_render` when visual layout, signatures, scans, or page appearance matters.
- use `pdf_transform` for split, merge, reorder, and rotate only.
- transformed PDFs must be validated with `pdf_validate`.
- no redaction/forms/OCR claims.

- [ ] **Step 2: Add durable tests**

Assert the skill content includes:
- `pdf_render`
- `pdf_transform`
- `split, merge, reorder, and rotate`
- `Preserve originals`

- [ ] **Step 3: Verify and commit**

Run:

```bash
bun test packages/core/src/skills.test.ts
bunx biome check packages/core/src/skills.test.ts packages/core/skills/pdf-workflows/SKILL.md
```

Commit:

```bash
git add packages/core/skills/pdf-workflows/SKILL.md packages/core/src/skills.test.ts
git commit -m "Teach the PDF workflow skill visual transforms" -m "The canonical PDF skill now routes visual review and immutable split, merge, reorder, and rotate operations through the new Slice 2 tools without claiming OCR, forms, or redaction support." -m "Constraint: Keep pdf-workflows as the only curated PDF skill." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: bun test packages/core/src/skills.test.ts"
```

## Task 5: Full Verification

**Files:**
- Review all changed files from Tasks 1-4.

- [ ] **Step 1: Run focused suite**

```bash
bun test packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts packages/core/src/pdf-service.test.ts packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts packages/core/src/skills.test.ts
```

- [ ] **Step 2: Run package checks**

```bash
bun run --filter ./packages/contracts typecheck
bun run --filter ./packages/core typecheck
bun run check
bun test
```

- [ ] **Step 3: Inspect final diff**

```bash
git status --short
git diff --stat 7f1aaff..HEAD
rg "pdf-documents|redact|OCR|form" packages/core/skills/pdf-workflows/SKILL.md packages/core/src packages/contracts/src/index.ts
```

Expected:
- no live `pdf-documents` skill.
- no redaction/form/OCR overclaims.
- no uncommitted files.

