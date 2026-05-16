# Playbook Graph Durable Runtime Landing Notes

**Status:** Landed in the Plan C slice.

**Goal:** Add a durable `PlaybookGraph` runtime lane beside legacy workflow
execution. Graph runs now pin compiled snapshots, persist queue state, memo node
outputs, resume after restart, execute supported node kinds, expose sidecar
handlers, and provide a basic desktop read model.

## Runtime Surface

- Shared contracts define graph run records, queue entries, branch items,
  artifact versions, review events, memo entries, resume decisions, and
  create/list/detail payloads.
- Core runtime executes against the pinned inline snapshot on each run record.
  It does not consult `latest.json` or the compiled graph cache after run
  creation.
- Queue entries are leased before execution and checkpointed through a matching
  lease. Stale leases are recoverable interruption, not success.
- Memo keys include run id, snapshot/graph hashes, node path, node spec hash,
  execution context hash, consumed artifact refs, and branch item identity/value
  where applicable.
- Supported execution now includes deterministic scripts, agent adapter nodes,
  idempotent/policy-approved tool nodes, `parallelMap` fan-out/fan-in, `join`,
  `condition`, `humanReview`, and workspace-backed `artifactWrite`.
- Production graph scripts execute from pinned source bundles in a constrained
  Bun subprocess with source hash verification, import filtering, runtime global
  escape checks, environment scrubbing, disabled auto-install, disabled `.env`
  loading, and a runtime preload lockdown.

## Persistence And Migration Notes

- Graph runs use new tables in the existing sidecar SQLite database:
  - `playbook_graph_runs`
  - `playbook_graph_queue`
  - `playbook_graph_branch_items`
  - `playbook_graph_artifact_versions`
  - `playbook_graph_review_events`
  - `playbook_graph_node_memos`
- Legacy `workflow_runs` storage is unchanged. Existing `/workflows/*` and
  `/playbook-runs/*` behavior remains separate from graph runs.
- No data migration is required for existing users. The graph-run store creates
  its tables lazily with `CREATE TABLE IF NOT EXISTS`.
- In-flight graph runs are pinned to their stored `snapshotJson` and
  `snapshotHash`. If the snapshot fails verification, reads and resume paths
  move the run to `needs_repair` rather than falling back to a newly installed
  playbook.
- Artifact/input/review edits create new durable evidence and requeue only
  downstream work. Stale `parallelMap` branch queue rows are skipped, and
  artifacts produced by skipped queue entries are excluded from future runtime
  artifact resolution.

## Sidecar And Desktop Surface

- Public sidecar handlers:
  - `POST /graph-runs`
  - `GET /graph-runs`
  - `GET /graph-runs/:runId`
  - `POST /graph-runs/:runId/resume`
- `POST /graph-runs` accepts either an inline compiled graph or a
  `{ playbookId, graphHash }` cache reference. Cache references are resolved
  only at creation time; the resulting run stores its own pinned snapshot.
- Background graph work is opt-in with `TESSERA_GRAPH_RUN_WORKER=1`.
- Tauri exposes `graph_run_create`, `graph_run_list`, `graph_run_get`, and
  `graph_run_resume`.
- The desktop playbook detail panel can list graph runs, inspect queue and
  branch state, show artifact/review counts, and trigger basic resume actions.

## Verification

The landing slice is covered by focused contracts, core, sidecar store, script
runner, and server tests:

```bash
bun test packages/contracts/src/playbook-graph-run.test.ts apps/sidecar/src/playbook-graph-run-store.test.ts
bun test apps/sidecar/src/playbook-graph-script-runner.test.ts packages/core/src/playbook-graph-runtime.test.ts
bun test apps/sidecar/src/server.test.ts
bun run check
```

## Follow-Ups

- The desktop graph-run UI is intentionally a read-model and coarse resume
  surface. Rich repair payloads, artifact/review editing, and branch drill-down
  remain future UI work.
- Script execution is constrained for Phase 1 graph packages, but it is not a
  general-purpose arbitrary-code security boundary. A stronger OS/process
  sandbox remains a future hardening slice before accepting untrusted third-party
  packages.
- Cross-run memo caching, graph-run migration across changed graph hashes, rich
  branch review UX, and git-aware milestone commits remain out of scope for this
  landing.
