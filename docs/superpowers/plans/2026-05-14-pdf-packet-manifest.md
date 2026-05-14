# PDF Packet Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Slice 3A of the PDF operations surface: a durable packet manifest that aggregates PDF operation results, validation status, warnings, page mappings, and provenance into a workspace JSON artifact.

**Architecture:** Extend the existing PDF contracts with packet manifest schemas and add one `pdf_manifest` tool. The tool does not inspect or mutate PDFs itself; it validates supplied operation results, records workspace-relative input/output paths, writes a JSON manifest inside the workspace, and returns the parsed manifest. This keeps business audit trails separate from engine adapters while giving future form and redaction tools one canonical record format.

**Tech Stack:** Bun, TypeScript, Zod contracts, Pi tool definitions, existing workspace guard, JSON manifest persistence.

---

## Scope

Included:
- `PdfPacketManifestSchema` and supporting manifest entry schemas.
- `pdf_manifest` tool policy exposure in every preset.
- A core service function that writes a JSON manifest with deterministic ordering and operation summary counts.
- Workspace boundary enforcement for the manifest output path.
- Skill guidance that tells agents to create manifests for multi-step packets and after transformed outputs.

Excluded:
- `pdf_form`, `pdf_redact`, OCR, signatures, archival conformance, or compliance checks.
- Append/update-in-place manifest editing. This first pass writes a complete new manifest artifact.
- Automatic filesystem discovery of PDF outputs. The caller supplies the operation results to record.

## File Map

- Modify `packages/contracts/src/index.ts`
  - Add packet manifest schemas.
  - Add `pdf_manifest` to tool policy presets and capability text.
- Modify `packages/contracts/src/pdf-tools.test.ts`
  - Add schema and policy coverage.
- Modify `packages/contracts/src/agent-profile.test.ts`
  - Update default tool assertions.
- Modify `packages/contracts/src/skill.test.ts`
  - Update skill/tool policy assertions.
- Modify `packages/core/src/pdf-service.ts`
  - Add `writePdfPacketManifest`.
- Modify `packages/core/src/pdf-service.test.ts`
  - Add manifest persistence tests.
- Modify `packages/core/src/pdf-tools.ts`
  - Add `pdf_manifest` tool definition.
- Modify `packages/core/src/pdf-tools.test.ts`
  - Add tool registration, output boundary, and persistence tests.
- Modify `packages/core/src/workspace-tools.test.ts`
  - Update registered tool order assertions.
- Modify `packages/core/src/pi-session.test.ts`
  - Update custom tool order expectations.
- Modify `packages/core/src/index.ts`
  - Export manifest service type/function.
- Modify `packages/core/skills/pdf-workflows/SKILL.md`
  - Add packet manifest workflow guidance.
- Modify `packages/core/src/skills.test.ts`
  - Assert manifest guidance is present.

## Manifest Shape

The manifest is intentionally an audit artifact, not a hidden database:

```ts
type PdfPacketManifest = {
  manifestVersion: 1;
  packetId: string;
  outputPath: string;
  title?: string;
  sourcePaths: string[];
  artifactPaths: string[];
  operations: PdfPacketManifestOperation[];
  validations: PdfValidateResult[];
  warnings: PdfWarning[];
  summary: {
    operationCount: number;
    validationCount: number;
    failedValidationCount: number;
    warningCount: number;
  };
  provenance: {
    createdAt: string;
    immutableSource: true;
  };
};
```

The first implementation accepts operation results from existing tools:
- `PdfInspectResult`
- `PdfExtractResult`
- `PdfValidateResult`
- `PdfRenderResult`
- `PdfTransformResult`

## Task 1: Contracts And Policy

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/pdf-tools.test.ts`
- Modify: `packages/contracts/src/agent-profile.test.ts`
- Modify: `packages/contracts/src/skill.test.ts`

- [ ] **Step 1: Add failing contract tests**

Add a test that parses a packet manifest with one transform, one validation, and one warning:

```ts
test("parses PDF packet manifests with operation summaries", () => {
  const result = PdfPacketManifestSchema.parse({
    manifestVersion: 1,
    packetId: "packet-2026-05-14",
    outputPath: "out/packet-manifest.json",
    title: "Board packet assembly",
    sourcePaths: ["docs/a.pdf", "docs/b.pdf"],
    artifactPaths: ["out/packet.pdf"],
    operations: [
      {
        operationId: "op-1",
        kind: "transform",
        result: {
          outputPath: "out/packet.pdf",
          fileType: "pdf",
          operation: "merge",
          sourcePaths: ["docs/a.pdf", "docs/b.pdf"],
          pageMapping: [
            { sourcePath: "docs/a.pdf", sourcePage: 1, outputPage: 1 },
            { sourcePath: "docs/b.pdf", sourcePage: 1, outputPage: 2 },
          ],
          engine: "pdf-lib",
          engineRuntime: "typescript",
          provenance: {
            createdAt: "2026-05-14T00:00:00.000Z",
            immutableSource: true,
          },
          warnings: [],
        },
      },
    ],
    validations: [
      {
        path: "out/packet.pdf",
        exists: true,
        fileType: "pdf",
        bytes: 2048,
        pageCount: 2,
        hasTextLayer: true,
        passed: true,
        checks: [{ name: "file_exists", passed: true, message: "PDF file exists." }],
        engine: "unpdf",
        engineRuntime: "typescript",
        provenance: {
          createdAt: "2026-05-14T00:00:00.000Z",
          immutableSource: true,
        },
        warnings: [],
      },
    ],
    warnings: [{ code: "manual_review", message: "Signature page needs review." }],
    summary: {
      operationCount: 1,
      validationCount: 1,
      failedValidationCount: 0,
      warningCount: 1,
    },
    provenance: {
      createdAt: "2026-05-14T00:00:00.000Z",
      immutableSource: true,
    },
  });

  expect(result.summary.operationCount).toBe(1);
});
```

Update the policy test so `pdf_manifest` appears after `pdf_transform` in every preset.

- [ ] **Step 2: Add schemas and policy entries**

Add:
- `PdfManifestOperationKindSchema`
- `PdfManifestOperationResultSchema`
- `PdfPacketManifestOperationSchema`
- `PdfPacketManifestSummarySchema`
- `PdfPacketManifestSchema`

Then add `pdf_manifest` after `pdf_transform` in all policy presets.

- [ ] **Step 3: Run focused contract tests**

Run:

```bash
bun test packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts
```

Expected: all pass.

## Task 2: Manifest Service

**Files:**
- Modify: `packages/core/src/pdf-service.ts`
- Modify: `packages/core/src/pdf-service.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add service test**

Add a test that writes a manifest JSON file and verifies summary counts:

```ts
test("writes a packet manifest with summary counts", async () => {
  const { root } = await makeFixture();
  const outputPath = join(root, "out", "packet-manifest.json");

  const manifest = await writePdfPacketManifest({
    packetId: "packet-1",
    title: "Packet 1",
    outputPath,
    displayOutputPath: "out/packet-manifest.json",
    operations: [
      {
        operationId: "inspect-1",
        kind: "inspect",
        result: await inspectPdfDocument(join(root, "sample.pdf"), {
          displayPath: "sample.pdf",
        }),
      },
    ],
    validations: [
      await validatePdfDocument(join(root, "sample.pdf"), {
        displayPath: "sample.pdf",
        expectedPageCount: 1,
      }),
    ],
    warnings: [{ code: "manual_review", message: "Review terms manually." }],
  });

  expect(manifest).toMatchObject({
    manifestVersion: 1,
    packetId: "packet-1",
    outputPath: "out/packet-manifest.json",
    summary: {
      operationCount: 1,
      validationCount: 1,
      failedValidationCount: 0,
      warningCount: 1,
    },
  });
});
```

- [ ] **Step 2: Implement `writePdfPacketManifest`**

The function should:
- create the output directory
- derive `sourcePaths` from operation result source/path fields
- derive `artifactPaths` from render outputs and transform output paths
- count failed validations with `passed === false`
- include all supplied warnings plus warnings embedded in operation and validation results
- write pretty JSON with a trailing newline
- return `PdfPacketManifestSchema.parse(manifest)`

- [ ] **Step 3: Export the service function and types**

Export `writePdfPacketManifest` and its options type from `packages/core/src/index.ts`.

## Task 3: Manifest Tool

**Files:**
- Modify: `packages/core/src/pdf-tools.ts`
- Modify: `packages/core/src/pdf-tools.test.ts`
- Modify: `packages/core/src/workspace-tools.test.ts`
- Modify: `packages/core/src/pi-session.test.ts`

- [ ] **Step 1: Add tool tests**

Add tests proving:
- tool order includes `pdf_manifest` after `pdf_transform`
- a manifest can be written to a workspace output path
- an outside manifest output path is rejected and reports `pdf_manifest`

- [ ] **Step 2: Add `pdf_manifest` schema and tool**

Parameters:

```ts
{
  packetId: string;
  outputPath: string;
  title?: string;
  operations: PdfPacketManifestOperation[];
  validations?: PdfValidateResult[];
  warnings?: PdfWarning[];
}
```

The tool should resolve only `outputPath` through `resolvePdfWorkspaceOutputPath`, then call `writePdfPacketManifest`.

- [ ] **Step 3: Update runtime order assertions**

Expected order:

```ts
[
  "pdf_inspect",
  "pdf_extract",
  "pdf_validate",
  "pdf_render",
  "pdf_transform",
  "pdf_manifest",
]
```

## Task 4: Skill Guidance

**Files:**
- Modify: `packages/core/skills/pdf-workflows/SKILL.md`
- Modify: `packages/core/src/skills.test.ts`

- [ ] **Step 1: Add durable workflow guidance**

Teach the skill:
- create `pdf_manifest` for multi-step packets
- include every inspect/extract/render/transform/validate result that materially supports the answer
- use manifests before handoff, archive, or further business review
- preserve originals and validate transformed outputs before adding them to the manifest

- [ ] **Step 2: Add skill assertions**

Assert that the skill contains:
- `pdf_manifest`
- `packet manifest`
- `handoff`

## Task 5: Verification And Commit

**Files:**
- All modified files.

- [ ] **Step 1: Run focused tests**

```bash
bun test packages/contracts/src/pdf-tools.test.ts packages/contracts/src/agent-profile.test.ts packages/contracts/src/skill.test.ts packages/core/src/pdf-service.test.ts packages/core/src/pdf-tools.test.ts packages/core/src/workspace-tools.test.ts packages/core/src/pi-session.test.ts packages/core/src/skills.test.ts
```

- [ ] **Step 2: Run typechecks**

```bash
bun run --filter ./packages/contracts typecheck
bun run --filter ./packages/core typecheck
```

- [ ] **Step 3: Run full checks**

```bash
bun run check
bun test
```

- [ ] **Step 4: Commit with Lore protocol**

Commit the slice as small logical commits:
- contracts/policy
- service/tool implementation
- skill guidance

Record unavailable runtime gaps honestly in `Not-tested`.
