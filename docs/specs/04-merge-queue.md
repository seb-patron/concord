# 04 — Land only the checker-approved speculative stack

Budget: 90 minutes. Suggested worker: Codex gpt-6-sol. Dependency: 01 for implementation; 02, 03, 05, 06, 07 for integrated acceptance. Behavior: a bounded landing state machine turns approved candidates into a checked canonical update.

## Delegation spec

Goal:
  Outcome: Implement speculative stacking, evidence-based failure isolation, candidate arbitration, and fenced promotion without performing Git or checker execution inside Workers.
  Done when:
    - Enqueue atomically gates exact revision, verified unit coverage, current lease fences, independent approval, and the findings set, then converts leases to queue reservations. Queue GET/withdraw and owner-only contest creation use stable sequence ordering and architecture limits (8 candidates, stack width 4).
    - A two-second coalescing window builds immutable job inputs and increments generation whenever main, an admitted head, or its eligibility changes. No stale job result or changed finding set can authorize a new promotion. Missing hooks fail closed.
    - A green composed-stack result creates one durable promotion ticket with expected old/new OIDs and a frozen eligibility snapshot. Related mutations are temporarily rejected with PROMOTION_IN_PROGRESS. No entry becomes merged until RepoStorage reads back the exact checked canonical OID.
    - Owner-authorized empty-repo bootstrap is the explicit initial case: a green checked seed creates a ticket with expectedOldOid=null, conditional branch absence, and normal readback. Existing main cannot reenter bootstrap and two initializers cannot both succeed. All later promotions require ordinary change admission.
    - Lost promotion responses reconcile old/new/third-OID cases. A pending ambiguous promotion prevents another ticket. The timeout path preserves the freeze until reconciliation; it cannot unlock and allow a delayed stale push. Confirmed failure releases the freeze and requeues or blocks with reason.
    - Deterministic failure bisects subsets from the same base with dependency closure, attributes only a reproduced failing singleton, and rechecks survivors together. Green halves with a red whole become INTERACTION; inseparable dependencies become DEPENDENCY_GROUP; red baseline becomes BASE_RED. Stop after eight diagnostic jobs with INCONCLUSIVE.
    - An explicit two-candidate contest evaluates identical base/profile/oracle inputs. Hard acceptance gates precede score comparison; byte-match score uses a fixed denominator; pass/fail selects first valid green by server sequence. Loser is superseded and only the winner can enter the stack. Mismatched profiles are never compared.
    - One retry may distinguish environment failure; disagreement records SUSPECTED_FLAKE and blocks automatic landing. Event and snapshot projections show stack membership, every diagnostic result, blame confidence, arbitration reason, and final canonical SHA.
    - Tests cover A-good/B-bad/C-good isolation, pairwise interaction, dependencies, stale main, stale head, lost promotion response, duplicate results, in-flight finding mutation, score ties, non-comparable profiles, baseline failure, and diagnostic budget exhaustion.
  Inputs:
    - docs/ARCHITECTURE.md queue algorithm and Open risks; frozen hook contracts from 01. Use deterministic runner/provider fakes in this slice; compose/promote execution belongs to 05.
    - No general optimal scheduling, unbounded delta debugging, or speculative execution of arbitrary shell is required. Safety may reduce throughput; it must not invent individual blame.
  Deliverables:
    - Queue module and pure scheduling/arbitration logic, adversarial state-machine tests, and queue runbook with reconciliation examples.
  Stop and escalate when:
    - Atomic admission cannot be expressed within RepoCoordinator, a promotion race cannot be fenced, or required hooks differ from the frozen contract. Do not work around a missing review/lease gate with test-only success in production.
Allowed files:
  src/features/queue.ts
  src/queue/plan.ts
  src/queue/arbitrate.ts
  tests/workers/queue.test.ts
  docs/api-queue.md
Validation:
  npm run typecheck
  npm run test:target -- tests/workers/queue.test.ts
  sh scripts/validate.sh
Commit message: feat: arbitrate speculative landing with bounded bisection
Sandbox: on
