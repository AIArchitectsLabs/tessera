# Recipe 002: Supply Chain Early Warning and Disruption Response

This recipe turns `/Users/utpal/Code/projects/supply-chain-risk-playbook` into a reusable Tessera playbook pattern. It is a docs mirror of the external package shape, not a new runtime contract.

The external playbook should prove this shape:

1. Normalize intake and fixture inputs.
2. Extract supply-chain entities and risk-signaling surfaces.
3. Build a fixture-first risk-signal plan before any live connector usage.
4. Normalize noisy source outputs into strict `riskSignal[]` artifacts.
5. Give agents compact, schema-backed mitigation seeds.
6. Store raw agent output first, then structure it deterministically.
7. Review, rework, and human-approve before final materialization.
8. Write only durable user-facing outputs.

## Reference Package

| Field | Value |
| --- | --- |
| Path | `/Users/utpal/Code/projects/supply-chain-risk-playbook` |
| Manifest id | `supply-chain.early-warning-response` |
| Version | `0.1.0` |
| Capabilities | none in the scaffold; live source use is deferred until later V1 work |
| Final artifacts | `mitigationPlan`, `finalDisruptionPacket` |
| Final materialized file | `Supply Chain Risk Response/Final Disruption Packet.md` |

## V1 Free-Source Strategy

The future V1 design keeps the source surface free or public wherever possible:

- Mandatory later V1 sources: Gmail, `web.search`, `web.fetch`, GDELT, CBP feeds, NWS alerts.
- Optional later V1 sources: FDA recalls and curated trade press.
- Public feed content should be fetched and parsed by the playbook package, not by a Tessera-specific supply-chain runtime.
- Fixture-only validation must work before any live connector access is added.

## Core `riskSignal[]` Contract

Each later source should normalize into a `riskSignal[]` item with provenance:

```json
{
  "sourceType": "gmail | web | gdelt | cbp | weather | recall",
  "entityType": "supplier | sku | material | port | lane | region",
  "entityName": "...",
  "signalType": "delay | congestion | recall | strike | weather | customs | shortage | financial_distress | quality",
  "severity": "low | medium | high",
  "confidence": "low | medium | high",
  "observedAt": "2026-05-21T00:00:00.000Z",
  "sourceQuality": "primary | official | trade_press | internal | weak",
  "evidence": "...",
  "rationale": "...",
  "source": {
    "url": "...",
    "messageId": "...",
    "threadId": "...",
    "feedId": "...",
    "title": "..."
  }
}
```

## Graph Pattern

| Stage | Generic authoring pattern | Supply-chain implementation |
| --- | --- | --- |
| Intake normalization | Convert loose inputs into one strict artifact before tool use. | Parse notes, supplier lists, inventory tables, and scenario text. |
| Entity extraction | Keep entity maps as explicit artifacts. | Derive suppliers, lanes, SKUs, and materials. |
| Risk-signal planning | Turn sources into bounded work items. | Create Gmail/web/feed plans and fixture-only placeholders. |
| Branch normalization | Emit one schema-shaped summary per branch. | Normalize each source into `riskSignal[]` with provenance. |
| Fan-in aggregation | Merge branch outputs into a single evidence artifact. | Produce merged risk evidence plus traceable counts and gaps. |
| Mitigation drafting | Feed agents compact schema-shaped seeds. | Draft mitigation actions, outreach, and brief artifacts from evidence. |
| Review/rework | Bound the repair loop. | Keep mitigation review and human approval before finalization. |
| Final materialization | Write only user-facing files. | Materialize the final disruption packet and supporting markdown. |

## Boundary Rule

Do not move supply-chain scoring, signal taxonomies, or output formats into Tessera core. Tessera owns package loading, validation, execution, capability boundaries, review surfaces, artifact history, and materialization. The playbook package owns domain schemas, prompts, scripts, fixtures, and final templates.
