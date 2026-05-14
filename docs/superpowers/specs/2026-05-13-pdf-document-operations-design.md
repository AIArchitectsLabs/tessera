# PDF Document Operations Design

## Summary

Tessera should add a first-class PDF Document Operations surface for business
document packet workflows. The current `workspace_extract` tool is a bounded
reader for common document formats. It should remain that way. PDF packet work
needs stronger primitives: inspection, extraction, visual rendering, creation,
transformation, redaction, form handling, validation, and provenance.

The design pairs a Tessera-native PDF tool family with the existing portable
`pdf-workflows` skill. The skill should use a Claude-style skill folder shape
where practical, but the actual capabilities should come from Tessera tools and
engine adapters rather than from prompt-only shell instructions. The operation
map is inspired by Anthropic's PDF skill, but Tessera should expose narrower,
auditable tool contracts suited to business workflows.

Python is supported as a scoped skill helper runtime. A skill may declare
repo-owned Python entrypoints and requirements, and Tessera runs them in a
managed per-skill environment through `skill_run_python`. Python execution is
not a general PDF engine escape hatch and does not grant arbitrary shell access
to skills.

## Goals

- Support end-to-end PDF document packet workflows: intake, inspect, extract,
  review, create, transform, redact or fill, validate, and export.
- Preserve originals. No PDF tool modifies a source file in place.
- Give agents operation-specific PDF tools instead of overloading
  `workspace_extract`.
- Return structured metadata, warnings, and provenance for every operation.
- Keep the skill portable while letting Tessera use native tools where
  available.
- Keep transforms dependency-light with bundled TypeScript libraries, while
  allowing optional Tessera-managed render binaries for visual workflows.
- Keep Python helpers scoped to declared skill entrypoints and managed
  per-skill environments.

## Non-Goals

- Replacing the generic document extraction path for PDF, Word, Excel, and
  PowerPoint reads.
- Building a PDF editor UI in the first slice.
- Guaranteeing legal-grade redaction, signature validation, or archival
  conformance without engine support and explicit validation.
- Requiring customer-managed system installs for PDF dependencies.
- Adding GPL-licensed PDF binaries to the default desktop bundle.
- Allowing agent-authored skills, plugin permissions, or credential injection
  through the PDF skill.
- Executing scripts from user, workspace, or external skills without a separate
  execution-safety design.

## Current State

Tessera already has several relevant foundations:

- Skills are local instruction bundles with a `SKILL.md` file and optional
  supporting folders.
- Curated skills live under `packages/core/skills`.
- `workspace_read` can read text files and auto-extract supported document
  formats.
- `workspace_extract` can extract readable text from PDF, Word, Excel, and
  PowerPoint documents with bounded output controls.
- Tool policy presets already include `workspace_read`, `workspace_extract`,
  `skill_list`, and `skill_load`.

The current curated `pdf-workflows` skill is useful lightweight guidance, but
it does not define PDF tools, immutable outputs, operation provenance, OCR
handling, rendering, redaction, forms, or validation. This design expands that
capability into a first-class PDF surface.

## Canonical Skill Strategy

Tessera should have one canonical curated PDF skill, not parallel PDF skills.
The existing `packages/core/skills/pdf-workflows/SKILL.md` skill should be
evolved in place into the tool-backed procedural layer for PDF document
operations.

The implementation should not create a separate `pdf-documents` skill. Keeping
`pdf-workflows` as the canonical slug preserves existing profile defaults,
registry tests, task-model references, and external skill conflict behavior.
If product language later prefers "PDF documents", that can be handled through
the skill description, UI labels, or a deliberate rename migration. It should
not be handled by shipping two curated PDF skills.

Migration rule:

- `pdf-workflows` remains the only curated PDF skill ID.
- The existing skill body is replaced or expanded with the approved PDF tool
  workflow.
- External Claude or Codex skills named `pdf-workflows` remain opt-in external
  candidates and do not override the curated skill.
- A future slug rename requires a compatibility plan for stored agent profile
  skill IDs and active task skill activations.

## Product Workflow

The primary workflow is PDF document packet operations:

1. The user asks Tessera to review, transform, redact, fill, or assemble PDF
   documents.
2. The agent activates or loads the `pdf-workflows` skill.
3. The skill directs the agent to inspect every source PDF before extraction or
   mutation.
4. The agent calls the narrow tool required for the current step.
5. Any mutating operation writes a new output file inside the workspace.
6. The agent validates the output and reports source paths, output paths, page
   references, warnings, and validation status.

This workflow should support contract packets, invoices, board packs, signed
forms, regulatory exports, research reports, and scanned business documents.

## Architecture

### PDF Service Module

Add a PDF service module in core. It owns common PDF operation behavior:

- workspace containment checks for input and output paths
- PDF-only validation
- file-size and page-count limits
- immutable output naming
- output collision protection
- page range normalization
- engine selection and capability checks
- structured warnings
- operation provenance

This module should sit beside `document-extraction.ts`. It should not merge into
that file because PDF operations have a broader lifecycle than text extraction.

### Engine Adapters

The PDF service should use engine adapters behind a stable internal interface.
The current architecture uses bundled TypeScript libraries where they are
reliable and keeps optional native binaries narrowly scoped:

- `unpdf` handles inspect, extract, and validate.
- `pdf-lib` handles simple PDF creation plus split, merge, reorder, and rotate
  transforms.
- `tessera-pdf-render` is an optional Tessera-managed binary for page rendering.

Tessera does not depend on customer-installed PDF transform or render binaries
for the current PDF tool surface.

Potential engine responsibilities:

- text and metadata extraction through bundled TypeScript libraries
- page rendering through the optional managed render binary
- simple business PDF creation and page transformations through `pdf-lib`
- compression or linearization
- form inspection and filling
- redaction planning and application
- OCR
- validation and repair diagnostics

Engines should declare capabilities. Tools should fail clearly when an operation
requires an unavailable capability instead of silently doing partial work.

### Python Skill Helpers

Python should be treated as a scoped skill runtime, not as a fallback shell
escape hatch for PDF tools. Curated skills may include helper scripts when a
Python library is materially better for a workflow, but the scripts must be
declared in the skill manifest and invoked through Tessera's `skill_run_python`
tool.

The current boundary is:

- PDF tools remain typed Tessera tools with workspace containment and
  provenance.
- Python helpers live inside skill bundles and declare their entrypoints and
  requirements.
- Tessera creates a managed per-skill Python environment before running a
  declared entrypoint.
- The optional capability manager may install the Python runner (`uv`) when
  configured, but Python package dependencies belong to the skill environment,
  not to global PDF capabilities.
- Scripts from undeclared paths or arbitrary workspace files are not executable
  through the skill runtime.

This lets Tessera benefit from Python's PDF ecosystem where a skill needs it,
while preserving tool policy, workspace containment, provenance, and predictable
packaging.

### Portable Skill

Evolve the curated `pdf-workflows` skill using the standard skill folder shape:

```text
pdf-workflows/
  SKILL.md
  references/
  scripts/
  assets/
```

The v1 Tessera registry loads `SKILL.md` as prompt content. References, scripts,
and assets remain optional support files and are inert unless a declared
`skill_run_python` entrypoint invokes them. The skill should be structured
portably so it can be copied into Claude-style or Codex-style skill roots.

The skill should teach process, not grant permissions:

- inspect first
- keep originals immutable
- use page-specific extraction
- render pages when layout or scan quality matters
- label OCR-derived content
- plan redactions explicitly
- validate every exported PDF
- cite page numbers for document claims

## Tool Surface

### `pdf_inspect`

Inspect a PDF and return document structure and risk signals.

Inputs:

- `path`
- optional page sampling controls for expensive scans

Outputs:

- page count
- page dimensions
- encrypted or password-protected status
- text-layer presence
- scanned-page hints
- forms, annotations, bookmarks, attachments, and signatures when detectable
- metadata fields
- warnings and unsupported-feature notes

### `pdf_extract`

Extract PDF content with page scope and content type controls.

Inputs:

- `path`
- optional `pages`
- optional content modes: text, tables, images, annotations, bookmarks, or
  attachments
- optional OCR flag
- output limits

Outputs:

- extracted content with page markers
- OCR provenance when OCR was used
- omitted-content warnings
- extraction confidence or quality notes where available

### `pdf_render`

Render selected pages to image files for visual review.

Inputs:

- `path`
- `pages`
- image format
- scale or DPI
- output directory or output path pattern

Outputs:

- generated image paths
- dimensions
- engine
- warnings

### `pdf_transform`

Create a new transformed PDF.

Supported operations:

- split
- merge
- reorder
- rotate

Transforms are currently implemented with bundled `pdf-lib`. Stamp, watermark,
compression, linearization, redaction, and form operations are separate future
capabilities, not part of `pdf_transform` today.

Inputs:

- source path or ordered source paths
- operation-specific parameters
- output path

Outputs:

- new output path
- source paths
- operation
- page mapping when applicable
- warnings
- provenance

### `pdf_create`

Create a new simple business PDF from structured content blocks.

Supported blocks:

- headings
- paragraphs
- simple tables
- page breaks
- embedded workspace images

Inputs:

- output path
- optional title and author
- optional source paths for provenance
- ordered content blocks

Outputs:

- new output path
- page count
- source paths
- engine metadata
- warnings
- provenance

### `pdf_redact`

Create a new redacted PDF from an explicit plan.

Inputs:

- `path`
- redaction regions by page and rectangle, or a reviewed text-match plan
- optional replacement label
- output path

Rules:

- No best-effort unsafe redaction.
- Region redaction is preferred over blind text replacement.
- Text-match redaction must produce a reviewable plan before applying changes.
- The tool must validate that redacted text is not extractable from the output
  when the engine supports that check.
- If safe redaction cannot be guaranteed, return a hard error.

### `pdf_form`

Inspect, fill, or flatten PDF forms where supported.

Inputs:

- `path`
- operation: inspect, fill, or flatten
- field values for fill
- output path for mutating operations

Outputs:

- form fields and types
- missing required fields
- output path for fill or flatten
- warnings for unsupported form technologies

### `pdf_validate`

Validate an existing or newly created PDF.

Inputs:

- `path`
- optional expected page count, text presence, source operation, or redaction
  assertions

Outputs:

- existence and containment status
- page count
- readable text status
- metadata summary
- redaction safety checks where applicable
- warnings
- pass/fail validation result

## Result Model

All PDF tools should return structured details. Mutating tools should share a
common result shape:

```ts
type PdfOperationResult = {
  sourcePath: string;
  outputPath?: string;
  operation: string;
  engine: string;
  engineRuntime?: "typescript" | "python" | "binary";
  pages?: number[];
  warnings: string[];
  provenance: {
    createdAt: string;
    immutableSource: true;
  };
};
```

Later packet-level work can aggregate these results into a manifest without
changing the first tool contracts.

## Safety And Error Handling

All PDF tools must enforce:

- workspace containment for every input and output path
- no source-file mutation
- no implicit overwrite
- clear errors for unsupported formats
- file-size and page-count limits for expensive operations
- structured warnings for partial extraction and engine fallbacks
- dependency and capability checks before invoking optional render binaries or
  skill-scoped Python helpers
- explicit OCR opt-in
- post-operation validation where feasible

Redaction is the highest-risk operation. It must fail closed when the available
engine cannot provide safe redaction and validation.

OCR output is lower-confidence than a text layer. Tools should label OCR-derived
content in details and in extracted text sections so agents do not present it as
equally reliable.

## Tool Policy

PDF tools should be added to tool policy presets deliberately:

- `read_only` can include `pdf_inspect`, `pdf_extract`, `pdf_render`, and
  `pdf_validate` for existing files.
- `workspace_editor` can include all PDF tools because mutating tools write new
  workspace files.
- `elevated_with_approval` can include all PDF tools, preserving the preset's
  normal approval behavior.

The portable skill must not imply extra permission. If a selected agent profile
does not have a PDF tool, the skill should tell the agent to fall back to
available read-only extraction or explain the missing capability.

Python-backed skill helpers remain governed by `skill_run_python` policy.
Enabling a PDF skill does not grant general Python execution.

## Testing Strategy

### Contracts

Add schema tests for PDF tool inputs and results:

- page ranges
- output paths
- operation names
- created PDF source provenance
- provenance
- warnings
- validation summaries

### Unit Tests

Cover:

- path containment
- immutable output behavior
- page range normalization
- output collision handling
- unsupported-operation errors
- engine capability routing
- unavailable render-engine reporting
- Python skill-helper invocation with controlled arguments

### Fixture Tests

Use small PDF fixtures:

- text-layer PDF
- synthetic image-only or scanned-style PDF
- multi-page PDF
- form PDF when practical
- encrypted PDF when practical
- annotation or bookmark PDF when practical

### Tool Tests

Verify:

- `pdf_inspect` reports page count and text-layer hints.
- `pdf_extract` supports page-scoped text.
- `pdf_render` produces image files with expected dimensions.
- `pdf_transform` can split, merge, reorder, or rotate via `pdf-lib` without
  touching originals.
- `pdf_create` can write simple business PDFs with headings, text, tables, page
  breaks, embedded images, and source provenance.
- `pdf_validate` catches missing output, page-count mismatch, and extractable
  redacted text where supported.

### Skill Tests

Verify that the curated PDF skill is discoverable and loadable, and that it
contains the core workflow requirements:

- inspect first
- preserve originals
- validate outputs
- label OCR
- cite page evidence

If the skill includes Python helper scripts, tests should also verify that the
scripts are packaged with the curated skill but are not loaded as prompt content
by `skill_load`.

## Phasing

### Slice 1: Foundations

- Add contracts for PDF tool inputs and result metadata.
- Add PDF service scaffolding and engine capability model.
- Add `pdf_inspect`, `pdf_extract`, and `pdf_validate`.
- Evolve the existing curated portable `pdf-workflows` skill.
- Keep Python helper support scoped to declared skill entrypoints.
- Update tool policy capability descriptions.

### Slice 2: Visual And Transform

- Add `pdf_render`.
- Add `pdf_transform` for split, merge, reorder, and rotate.
- Add `pdf_create` for simple business PDFs.
- Add fixture coverage for generated outputs.

### Slice 3: Business Controls

- Add `pdf_form` inspect/fill/flatten where supported.
- Add planned `pdf_redact` with fail-closed validation.
- Add packet-level manifest aggregation if workflows need durable audit trails.

### Slice 4: Advanced Engines

- Add optional OCR engine support.
- Add stronger rendering or repair engines.
- Add Python helper scripts for skill workflows where Python provides the best
  fidelity or safety.
- Add signature, attachment, archival, or compliance checks as engine
  capabilities allow.

## Open Risks

- True redaction safety depends on engine capability and validation rigor.
- OCR introduces latency and lower-confidence text.
- PDF forms vary widely across AcroForm, XFA, and generated PDFs.
- Rendering fidelity depends on the optional `tessera-pdf-render` engine.
- Python skill environments add dependency detection and caching complexity.
- Signature validation and archival compliance are specialized and should not be
  overpromised in early slices.

## Recommendation

Use the first-class PDF tool surface with pluggable engines. Keep
`workspace_extract` focused on bounded text extraction, and evolve the existing
`pdf-workflows` skill into the procedural layer that teaches agents how to
operate the PDF tools safely. Start with inspect, extract, validate, and the
portable skill, then add rendering and transformations before attempting
redaction or forms.
