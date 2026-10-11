# 07 — Carry a review only across a proven unchanged review scope

Budget: 75 minutes. Suggested worker: Codex gpt-6-sol. Dependency: 01; integrated acceptance uses 02, 05, 06. Behavior: content-bound approval survives a mechanical base change only with sufficient delta evidence.

## Delegation spec

Goal:
  Outcome: Bind independent review to inspected content and dependencies, and derive a new approval after a conservative delta check without equating equal patches with equal semantics.
  Done when:
    - Verdict list/create requires reviewer role distinct from the change author, current inspected revision, finding-set version, policy/checker/oracle pins, and complete review manifest. Missing inspection or unresolved findings cannot produce an eligible approval.
    - Canonical serialization sorts unit/dependency keys and includes before/after byte hashes, paths/modes, full declared trusted dependency closure, and policy/checker/oracle/toolchain pins. Whitespace and file-mode changes alter the digest. No candidate can choose a smaller dependency scope.
    - Carry request schedules an immutable delta-check job with old verdict, new base, candidate revision, and all expected versions. Only valid fenced results with the same reviewed writes and dependency digests, no new findings, and a green affected-unit check create a derived verdict.
    - Changed commit identity alone can carry when the trusted unit scope is unchanged. Changed dependency, mode, checker pin, unknown coverage, semantic conflict resolution, or a new finding instead returns review-required with a precise explanation. Preserve the old verdict as history.
    - verdicts.gate rechecks active content and findings version at enqueue and promotion freeze. A carried verdict includes parentVerdictId and deltaResultId. Full stack validation remains mandatory even after carry.
    - Tests include independent TSV row base advancement (carry), dependent-row base advancement (reject), forged manifest, stale result, changed oracle, self-review, unknown dependency coverage, whitespace change, and new finding after approval.
  Inputs:
    - docs/ARCHITECTURE.md Findings and content-bound review, runner protocol, and frozen contracts from 01. Implement manifest hashing as a pure helper usable by the runner without importing Workers runtime APIs.
    - The demo unit policy is finite and owner-controlled; broader language inference is out of scope. A safe refusal is acceptable when evidence is incomplete.
  Deliverables:
    - Verdict module, pure manifest helper, adversarial carry tests, and review API documentation with exact carry/invalidate examples.
  Stop and escalate when:
    - Review scope cannot be established from trusted metadata, a runner result cannot bind the requested delta, or a proposed shortcut would carry on patch-id alone. Preserve review-required rather than guessing.
Allowed files:
  src/features/verdicts.ts
  src/verdicts/manifest.ts
  tests/workers/verdicts.test.ts
  docs/api-verdicts.md
Validation:
  npm run typecheck
  npm run test:target -- tests/workers/verdicts.test.ts
  sh scripts/validate.sh
Commit message: feat: carry content-bound verdicts with delta evidence
Sandbox: on
