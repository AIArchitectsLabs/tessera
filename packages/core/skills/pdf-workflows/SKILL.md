---
name: pdf-workflows
description: Inspect, extract, render, transform, validate, manifest, and package PDF-based business artifacts.
---

# PDF Workflows

Use this skill when the source or requested output is a PDF: contracts, reports, invoices, board packs, forms, research papers, exports, or scanned documents.

## Workflow

1. Always inspect PDFs before extracting or changing them.
2. Use `pdf_capabilities` before visual review, transforms, or packet work to confirm bundled extraction and optional managed engines are available.
3. Use `pdf_inspect` to identify page count, text-layer status, scan risk, engine metadata, and warnings.
4. Use `pdf_extract` for page-scoped text extraction. Keep page ranges narrow when the user asks about a specific clause, table, figure, or signature block.
5. Preserve page references for claims, issues, extracted facts, dates, parties, and financial values so the user can audit the result.
6. Use `pdf_render` when visual layout, signatures, scans, page appearance, or placement needs review. It uses Tessera-managed `pdftoppm` when available, with sidecar `PATH` as a development fallback.
7. Use `pdf_transform` only for split, merge, reorder, and rotate operations. It uses Tessera-managed `qpdf` when available, with sidecar `PATH` as a development fallback, and writes every transformed PDF to a new output path.
8. Use `pdf_validate` before relying on a PDF packet and after any transformed PDF is produced.
9. Use `pdf_manifest` for multi-step packets, transformed outputs, handoff, archive, or later business review. Include every material inspect, extract, render, transform, and validation result that supports the answer.
10. Treat OCR-derived content as lower-confidence than a text layer. Label OCR content when OCR tools become available.
11. Preserve originals. PDF mutation tools must create new output files and report provenance.
12. For review, flag missing pages, unreadable scans, inconsistent numbers, redaction risks, signature status, and terms that require legal or finance review.

## Tool Use

- `pdf_inspect`: first call for any PDF-specific workflow.
- `pdf_capabilities`: readiness check for bundled PDF text extraction and optional Tessera-managed `pdftoppm`/`qpdf` engines.
- `pdf_extract`: page-scoped extraction with page markers.
- `pdf_validate`: existence, page count, text-layer expectation, pass/fail checks, provenance, and warnings.
- `pdf_render`: page-scoped PNG outputs for visual review.
- `pdf_transform`: split, merge, reorder, and rotate into new PDF files.
- `pdf_manifest`: JSON packet manifest for audit, handoff, archive, and future review.
- `workspace_extract`: fallback reader for general document extraction when PDF-specific tools are unavailable.

## Delivery

Produce a concise extraction, review memo, conversion-ready structure, or file update. Always note scan quality, omitted pages, warnings, validation status, and content that could not be verified from the PDF.
