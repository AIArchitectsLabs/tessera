# Authoring Interview

Use this reference to produce the playbook authoring brief before generating files.

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

Data:

- What are the domain entities?
- What normalized records should scripts or agents produce?
- What confidence, severity, or quality fields are needed?
- What fields must never be invented?

Artifacts:

- What final markdown, CSV, or JSON outputs are required?
- Who reads each artifact?
- What schema or template backs each artifact?

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
- graph sketch
- schema plan
- review gates
- final artifacts
- validation commands
