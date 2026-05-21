# Tessera Playbook Authoring Checklist

Use this checklist when turning an idea into an external Tessera playbook package. It is based on Recipe 001, the SEO/GEO blog article reference playbook.

## 1. Boundary

- [ ] The playbook has no standalone runner.
- [ ] The playbook does not import Tessera app, sidecar, desktop, or runtime internals.
- [ ] Domain scoring, taxonomies, prompts, and final output schemas live in the playbook package.
- [ ] Tessera is used only as the runtime, validator, importer, capability boundary, artifact store, review surface, and materializer.
- [ ] `package.json` has no dependency fields, `bin`, or standalone runner scripts such as `start`, `dev`, `serve`, `run`, `execute`, or `playbook`.

## 2. Package Skeleton

- [ ] `manifest.json` exists and matches the graph id, version, and name.
- [ ] `playbook.ts` default-exports the graph.
- [ ] Package-relative refs are used for prompts, schemas, and scripts.
- [ ] No unsafe absolute paths, parent-directory escapes, dependency directories, or lockfiles are included.
- [ ] `PLAYBOOK.md` explains what the package exercises and what must not leak into Tessera core.

## 3. Schemas First

- [ ] Every artifact has a schema unless it is intentionally internal and validator-approved.
- [ ] Agent outputs declare schemas.
- [ ] Source outputs have normalized schemas before fan-in.
- [ ] Review outputs have explicit fields for pass/fail, findings, and revision routing.
- [ ] Final output schemas are distinct from intermediate research or review schemas.

## 4. Deterministic Scripts

- [ ] Intake normalization handles missing, string, array, and messy user input forms.
- [ ] Planning scripts produce bounded work items with stable ids.
- [ ] Source-normalization scripts tolerate empty, noisy, duplicate, and irrelevant inputs.
- [ ] Aggregation scripts preserve provenance, source quality, gaps, and evidence links.
- [ ] Structuring scripts convert raw agent output into strict artifacts.
- [ ] Scoring scripts keep domain thresholds outside Tessera.
- [ ] Final materialization scripts reject wrong-shaped drafts before writing user-facing outputs.

## 5. Graph Shape

- [ ] The graph starts with deterministic intake normalization.
- [ ] Tool nodes use only capabilities declared in `graph.capabilities`.
- [ ] Fanout nodes have generated item and concurrency limits.
- [ ] Every branch returns to a sensible downstream fan-in or terminal state.
- [ ] Review/rework loops are bounded and cannot spin forever.
- [ ] Human review pauses on artifacts the user can actually inspect.
- [ ] Final artifacts are materialized as markdown, CSV, or JSON.

## 6. Prompts

- [ ] Draft prompts consume compact, schema-shaped seeds.
- [ ] Review prompts output structured review artifacts.
- [ ] Rework prompts consume the prior artifact and review findings.
- [ ] Prompts avoid hidden runtime assumptions and external execution instructions.
- [ ] Prompts reinforce that Tessera is the runtime.

## 7. Fixtures And Tests

- [ ] Script tests cover happy path and noisy/negative path.
- [ ] Package tests load through Tessera's graph package loader.
- [ ] Tests assert required capabilities and final materialization paths.
- [ ] Tests assert internal artifacts are not accidentally written as final outputs.
- [ ] Fixtures run without live credentials or live connector access.
- [ ] Validator tests or validation evidence are recorded for the package.

## 8. Validation

Run text mode:

```bash
tessera playbook validate <path>
```

Or from the Tessera workspace before binary wiring is settled:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <path>
```

Run JSON mode for external-agent repair loops:

```bash
bun run --cwd apps/cli src/index.ts playbook validate <path> --json
```

Before import, fix all errors and record warnings intentionally. Expected clean result:

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

## 9. Import Readiness

- [ ] The package validates cleanly.
- [ ] Required capabilities are clear to the user before run.
- [ ] Fixture inputs can produce final artifacts without live connectors.
- [ ] Final files write into the selected workspace.
- [ ] Provenance is visible enough for review.
- [ ] The package can be zipped or folder-imported without generated junk files.

## 10. Copy, Rewrite, Ignore Rule

- Copy the package structure and graph choreography.
- Rewrite schemas, prompts, domain scripts, fixtures, scoring, and final templates.
- Ignore generated archives, local metadata, and SEO/GEO-specific strings unless the new playbook is also an SEO/GEO workflow.

