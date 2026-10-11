# 11 — Derive a comparison only from provenance-bearing timelines

Budget: 60 minutes. Suggested worker: Codex gpt-6-luna. Dependency: 01; reuse 04 pure scheduling logic after it lands where compatible. Behavior: ingest sanitized evidence and produce an explicitly qualified replay report.

## Delegation spec

Goal:
  Outcome: Compare recorded collaboration events with a bounded Concord scheduling simulation without inventing historical timings or treating simulation as observed improvement.
  Done when:
    - npm run replay -- validate --input PATH checks schema/provenance and npm run replay -- compare --input PATH --output PATH produces a JSON/HTML report. --explain-missing emits an unavailable report when no approved export exists, with no speedup number.
    - JSONL v1 requires exportId, sourceType (dbos_export or pr_history), redacted sourceRef, sourceDigest, export timestamp, anonymization version, ownerReleaseApprovalRef, selected cohort/window, and per-event ID/task/unit/time/type/duration provenance. Every measured duration has paired or explicit source events; duplicate IDs, negative intervals, missing provenance, and fabricated placeholder timestamps fail validation. A release reference is attested provenance, not automatic verification of the underlying private source.
    - Owner supplies sanitized exports outside version control. No private database/chat connector or gh fetch is added. The committed tiny synthetic event fixture is labelled synthetic and cannot pass the real-baseline mode.
    - Before metrics use only recorded facts: wait duration, serialized checker time, conflict/recheck counts, repairs/reviews, and landed work for the same selected cohort/window. Preserve denominators, missing fields, censoring, and source IDs. Aggregate owner numbers alone cannot be expanded into a timeline.
    - After is labelled simulated and uses declared worker/checker capacities, the same task cohort and measured durations, and only observed semantic overlap/dependency evidence. Unknown outcome/timing stays unknown. No claim that a refused task would have passed or that unknown rechecks vanish.
    - Reports separate owner-reported aggregate context, measured historical baseline, simulation assumptions/output, and actual synthetic live-demo telemetry. No causal speedup claim is emitted without comparable observations; do not extrapolate fleet-wide savings from the toy repo.
    - Tests reject missing provenance and synthetic-as-history, check unit/time consistency, censor incomplete work, reproduce a known hand-computable synthetic schedule, and preserve unknown outcomes. UI/report display distinguishes unavailable from zero.
  Inputs:
    - docs/DEMO.md evidence export contract and docs/JUDGING.md evidence rules. Only the owner-provided aggregate facts in the architecture are available initially.
    - Owner chats may export real timelines later, but are not accessible to this slice. Missing export must not block building the harness; it blocks only historical comparison claims.
  Deliverables:
    - Parser/schema, pure replay/report logic, clearly synthetic test fixture, provenance tests, and export instructions for the owner.
  Stop and escalate when:
    - Requested public evidence contains proprietary code/identifiers, lacks release approval, or requires guessing historical data. Complete the unavailable-data path and report which evidence the owner must supply.
Allowed files:
  - replay/main.ts
  - replay/schema.ts
  - replay/simulate.ts
  - replay/report.ts
  - tests/node/replay.test.ts
  - tests/fixtures/replay-synthetic.jsonl
  - docs/replay-export.md
Validation:
  - npm run typecheck
  - npm run test:target -- tests/node/replay.test.ts
  - sh scripts/validate.sh
Commit message: feat: replay collaboration timelines with explicit provenance
Sandbox: on
