# Authoring Interview

Use this reference to run the interview or brainstorming session before generating files. The goal is to understand the end-to-end workflow well enough to choose graph shape, tools, effects, schemas, fixtures, and validation.

## Required Discovery

Outcome:

- What business decision or workflow should the playbook improve?
- Who uses the final output?
- What would make the output good enough to act on?
- What is explicitly out of scope?

Cadence:

- Is the playbook event-driven, scheduled, or manually triggered?
- What freshness does the user expect?
- What review or approval is required before final output?

Sources:

- What inputs are available?
- Which Tessera capabilities are needed?
- What fixtures or golden examples can prove behavior without live connector access?
- What fields require provenance?

Tools and effects:

- Which connector/tool calls are needed during Tessera execution?
- Which registered Tessera capability id backs each tool, connector, skill, or effect?
- Which source claims must be backed by executable graph nodes rather than prompt instructions?
- Which package-local scripts should normalize, score, parse, aggregate, or format data?
- Which durable effects should happen at the end, such as workspace writes?
- Which effects require approval, preview, idempotency, or audit notes?
- What should never be executed outside Tessera?

Data:

- What are the domain entities?
- What normalized records should scripts or agents produce?
- What confidence, severity, or quality fields are needed?
- What fields must never be invented?

Artifacts:

- What final markdown, CSV, JSON, or PDF outputs are required?
- Who reads each artifact?
- What schema or template backs each artifact?
- Should the result appear as a final run-result card, a human review step, a dashboard layout, or only as a materialized workspace file?

Packaging:

- What external package path should be created or repaired? For existing playbooks, first resolve the target from `playbooks/<name>`, folder name, manifest `id`, or manifest `name`.
- Should the package include a `package.json` for tests, or use manifest/playbook only?
- What build command should validate, package, and release the folder?
- What fixture coverage is required before import?
- What import surface is expected: folder, zip, or both?
- What should future maintainers edit when updating sources, prompts, schemas, review gates, outputs, or versions?

## Question Discipline

Ask one focused question at a time when requirements are unclear. Prefer inferring from local docs, examples, or package files before asking.

Good question:

```text
What recurring decision should this playbook help the operator make?
```

Avoid batching:

```text
What is the workflow, who uses it, what data exists, and what outputs do you want?
```

## Brief Gate

Do not generate package files until the brief names:

- runtime boundary
- package path
- business outcome
- primary user
- source inventory
- tools/effects inventory
- registered capability mapping for every source/effect/skill requirement
- executable source nodes for every required live source
- graph sketch
- schema plan
- review gates
- final artifacts
- update/upgrade plan
- validation commands
