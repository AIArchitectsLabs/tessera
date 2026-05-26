# Portability Proof 002: Procurement Supplier RFQ Follow-Up

This proof records actual third-playbook evidence for Phase 7. The package is neither SEO/GEO nor supply-chain, and it validates, packages, and imports through generic Tessera playbook surfaces.

## Package

| Field | Evidence |
| --- | --- |
| Path | `/Users/utpal/Code/playbooks/procurement.supplier-rfq-followup` |
| Manifest id | `procurement.supplier-rfq-followup` |
| Version | `1.0.6` |
| Name | Procurement Supplier RFQ Follow-Up Desk |
| Existing archive | `/Users/utpal/Code/playbooks/procurement.supplier-rfq-followup/procurement.supplier-rfq-followup-1.0.6.zip` |

## Why This Proves Portability

The package uses the cookbook patterns without relying on SEO/GEO or supply-chain domain knowledge:

- Intake normalization for RFQ fields and supplier JSON.
- Deterministic scripts for quote scoring, ledger planning, queue construction, and materialization.
- Agent prompts for supplier follow-up drafting and review.
- Human review before final outputs.
- Declared capabilities for workspace writes and Google Workspace effects.
- Final artifacts for run summary, follow-up queue CSV, and decision log.

The domain-owned pieces stay in the package:

- Supplier and RFQ schemas.
- Quote completeness scoring.
- Gmail draft request shape.
- Google Sheets row/workbook planning.
- Procurement decision log and follow-up queue templates.

Tessera-owned behavior remains generic:

- Package validation.
- Folder/archive import.
- Capability preview.
- Effect commit semantics.
- Artifact history and workspace materialization.

## Validation Evidence

Text mode:

```bash
bun run --cwd apps/cli src/index.ts playbook validate /Users/utpal/Code/playbooks/procurement.supplier-rfq-followup
```

Result:

```text
Playbook validation passed: /Users/utpal/Code/playbooks/procurement.supplier-rfq-followup
Summary: 0 error(s), 0 warning(s), 0 info
```

JSON mode:

```bash
bun run --cwd apps/cli src/index.ts playbook validate /Users/utpal/Code/playbooks/procurement.supplier-rfq-followup --json
```

Result:

```json
{
  "ok": true,
  "summary": {
    "errors": 0,
    "warnings": 0,
    "info": 0
  },
  "diagnostics": []
}
```

## Import Evidence

Folder and archive import were exercised through Tessera's graph playbook importer using isolated temporary install/cache roots.

Folder import result:

```json
{
  "id": "procurement.supplier-rfq-followup",
  "version": "1.0.6",
  "status": "installed",
  "name": "Procurement Supplier RFQ Follow-Up Desk",
  "graphHash": "sha256:feeb4d2c5c6266afb6c7261c12010d35fcf6dfd40e7a3518cb3af2dfc2ab0482",
  "sourceHash": "sha256:5b47fafa559032a38ec58f5209a94b7fe3bd7e51715b7e958d4f0fa840418328",
  "warnings": []
}
```

Archive import result:

```json
{
  "id": "procurement.supplier-rfq-followup",
  "version": "1.0.6",
  "status": "unchanged",
  "name": "Procurement Supplier RFQ Follow-Up Desk",
  "graphHash": "sha256:feeb4d2c5c6266afb6c7261c12010d35fcf6dfd40e7a3518cb3af2dfc2ab0482",
  "sourceHash": "sha256:5b47fafa559032a38ec58f5209a94b7fe3bd7e51715b7e958d4f0fa840418328",
  "warnings": []
}
```

## Portability Verdict

Pass.

- The third playbook validates with zero diagnostics.
- The existing package archive imports with matching graph/source hashes and no warnings.
- The package proves the cookbook's split between SDK helpers, domain scripts, and Tessera runtime responsibilities.
- No procurement concepts need to move into Tessera core for the package to validate or import.

No SDK helper is promoted from this proof alone. The evidence should be added to the helper candidate log only when the same authoring friction repeats across reference packages or validator diagnostics.
