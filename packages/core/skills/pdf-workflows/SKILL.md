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
- `pdf_validate`: existence, page count, text-layer expectation, and output confidence checks.
- `workspace_extract`: fallback reader for general document extraction when PDF-specific tools are unavailable.

## Delivery

Produce a concise extraction, review memo, conversion-ready structure, or file update. Always note scan quality, omitted pages, warnings, validation status, and content that could not be verified from the PDF.
