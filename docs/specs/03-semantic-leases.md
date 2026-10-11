# 03 — Refuse overlapping intent before work begins

Budget: 75 minutes. Suggested worker: Codex gpt-6-sol. Dependency: 01. Behavior: atomic acquisition and fenced lifetime of a set of semantic resources.

## Delegation spec

Goal:
  Outcome: Give agents an exclusive claim on registered symbols, declarations, table rows, or conservative file footprints, while preserving intent across handoffs.
  Done when:
    - Lease list/claim/renew/release routes and reserve/releaseReservation hooks are implemented in RepoCoordinator's transactional state. Claim accepts at most 16 normalized keys and succeeds for all or none.
    - The trusted registry maps unit aliases and footprints; a file claim conflicts with contained units, declaration aliases collide, distinct table rows coexist, and unknown keys return 422. No arbitrary string bypass creates a second identity for the same unit.
    - Concurrent same-unit claim requests produce exactly one grant and a 409 LEASE_CONFLICT containing holder, intent, expiry, and keys. A failed multi-key claim leaves no partial leases. Different repositories remain independent.
    - Server time enforces default TTL 120 seconds, maximum 300, and renew-at-40-seconds guidance. Renew/release require current holder and monotonic fence. Expiry/reacquisition rejects the previous holder even if the alarm has not fired; alarm replay is harmless.
    - Admission reserves only a verified write footprint with current fences. Queue reservations cannot be released by agents, expire after the queue's bounded timeout, and are released only by terminal queue transitions. Explicit owner-created contest children share their parent reservation; ordinary overlap requests cannot opt into that exception.
    - Intent text and lease events remain readable after expiry, release, or handoff. The snapshot projection exposes countdown data and a concrete next action for refused work.
  Inputs:
    - docs/ARCHITECTURE.md Semantic leases, auth, and DO consistency; contracts from 01. Use fake change and queue hooks until other slices land.
    - The initial domain is explicit metadata and TSV row footprints. General language parsing, predictive overlap, priority waiting queues, and automatic claim overrides are out of scope.
  Deliverables:
    - Lease module, unit identity helper, concurrency/expiry/reservation tests, and lease API runbook.
  Stop and escalate when:
    - A unit cannot be mapped conservatively to an existing footprint, or integration requires a cross-DO transaction. Never weaken overlap checks or introduce a permissive claim fallback.
Allowed files:
  - src/features/leases.ts
  - src/leases/units.ts
  - tests/workers/leases.test.ts
  - docs/api-leases.md
Validation:
  - npm run typecheck
  - npm run test:target -- tests/workers/leases.test.ts
  - sh scripts/validate.sh
Commit message: feat: fence semantic leases and preserve agent intent
Sandbox: on
