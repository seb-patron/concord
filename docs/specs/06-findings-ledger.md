# 06 — Clear an entire findings round with one reviewed repair

Budget: 60 minutes. Suggested worker: Codex gpt-6-luna. Dependency: 01. Behavior: persistent finding identities gate a repair as one atomic round.

## Delegation spec

Goal:
  Outcome: Preserve findings across edits and require one repair to account for every open finding before an independent delta review can clear the round.
  Done when:
    - Finding list/create, repair submit, and repair review routes use stable IDs, semantic anchors, origin revision, evidence digests, and append-only events. Text/line movement does not delete or silently resolve a finding.
    - Submission captures current head revision and findingSetVersion and includes dispositions/evidence for exactly all open findings. Omitted or extra IDs, stale revisions, duplicate inconsistent IDs, and concurrent new findings reject the entire repair with 409.
    - Findings remain open after author submission. An independent reviewer accepts or rejects the whole repair against the same snapshot; partial resolution is not possible. Rejection preserves every unresolved item and allows a new numbered round.
    - A new head after submission invalidates pending resolution. Resolved finding history survives later revisions, and a reviewer can reopen with a new evidence event. Unknown anchors remain visible and blocking.
    - findings.gate returns finding-set version, unresolved IDs, and pending round status for queue/review hooks. Mutations obey promotion freeze; author-as-reviewer is forbidden even when the token has both roles.
    - Tests cover a two-finding repair with one omission, concurrent third finding, changed head, repeat identical review, author self-resolution, reopened finding, moved anchor, and immutable audit history.
  Inputs:
    - docs/ARCHITECTURE.md findings/content review, data model, and API conventions. Use frozen change/review hooks with test fixtures until 02 and 07 land.
    - The owner's RE-2 workflow is the product behavior. No AI reviewer is launched and no GitHub issue/PR is written.
  Deliverables:
    - Findings module, repair invariants, transactional tests, and findings API documentation.
  Stop and escalate when:
    - Stable identity or finding-set version cannot survive a revision using the frozen contract. Do not use head SHA as finding identity or silently mark an unattributable item resolved.
Allowed files:
  - src/features/findings.ts
  - src/findings/round.ts
  - tests/workers/findings.test.ts
  - docs/api-findings.md
Validation:
  - npm run typecheck
  - npm run test:target -- tests/workers/findings.test.ts
  - sh scripts/validate.sh
Commit message: feat: preserve findings through atomic repair rounds
Sandbox: on
