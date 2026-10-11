# Queue API and recovery runbook

Queue decisions live in one repository coordinator. Workers use `RepoStorage` only to read immutable commits and refs; checker and promoter jobs run through `runners.schedule`. A missing repos change view, findings gate, verdict gate, lease reservation, or runner scheduler blocks the dependent action.

## Routes and limits

| Route | Caller | Body or result |
| --- | --- | --- |
| `GET /v1/repos/:repoId/queue` | repository reader | Ordered entries, generation, stack members, diagnostic results, contest reasons, ticket, and final canonical SHA. |
| `POST /v1/repos/:repoId/queue/enqueue` | change author or owner | `{expectedVersion, changeId, verdictId, leaseFences}`. Requires an idempotency key. |
| `POST /v1/repos/:repoId/queue/withdraw` | change author or owner | `{expectedVersion, changeId, reason}`. Releases the queue reservation. |
| `POST /v1/repos/:repoId/contests` | owner | `{intentKey, intentText, unitKey, baseOid, profileId, childChangeIds:[a,b], verdictIds:[va,vb], leaseFences:[fa,fb]}`. Both children pass normal admission and reserve atomically. |

At most eight candidates are active. A composed stack has at most four. Entries use server event sequence order. The queue waits up to two seconds after admission to coalesce candidates, then schedules an immutable `validate-stack` job. A contest schedules one child job for each of its two candidates. Its winner alone becomes a waiting stack entry; the loser is superseded and its reservation released. A lease implementation must support the two children under their shared contest intent; if either reservation rejects, contest creation rolls back.

Admission reads the exact ready revision and registered head/base/ref from the repos view. It requires lease fences for every verified unit, a findings gate with no open finding or pending repair round, and a verdict gate for the requested verdict and the same finding-set version. The verdict gate is responsible for independent reviewer and coverage checks. Every job and ticket records policy/profile pins. A candidate base must be canonical main or the exact head of an admitted declared prerequisite. Dependencies must already be admitted or merged; the stack planner includes only dependency-closed candidates. Any changed head, eligibility, or canonical main increments the queue generation and invalidates prior checks.

## Failure isolation and arbitration

A red stack starts with a baseline check, then checks deterministic halves from the same canonical base. Subsets include prerequisites. Only a reproduced red singleton receives individual blame. Red baseline is `BASE_RED`; two green halves with a red whole are `INTERACTION`; inseparable prerequisites are `DEPENDENCY_GROUP`. After a singleton, all survivors are checked together before a ticket. Eight diagnostic jobs per generation is the limit; exhaustion is `INCONCLUSIVE`. The snapshot retains each subset, job ID, result, and confidence; events retain the same observations.

Contest results must share canonical base and checker, toolchain, oracle, environment profile, and policy pins. Named hard gates must pass before scoring. A score uses the policy's fixed denominator, so comparing matched byte counts is exact. Hard-gate policies choose the first valid green by server result sequence; equal scores choose the lower creation sequence. Non-comparable results block arbitration. A retry of an environment failure uses the same immutable input. A different retry outcome records `SUSPECTED_FLAKE` and stops automatic landing.

## Promotion and reconciliation

A green result is checked against the scratch ref and immutable commit/tree through `RepoStorage`. The queue rechecks main and each admission gate before it creates a durable ticket with expected old OID, checked new OID, generation, and frozen revisions, heads, verdicts, finding versions, policy/profile pins, and reservation fences. While pending or reconciling, related repository mutations return `409 PROMOTION_IN_PROGRESS`. The pending promoter may poll and use only its ticket job's heartbeat, credentials, and result routes. Runners must enforce the promoter role and claim fence. An empty-repo bootstrap uses an internal owner-authorized handoff from repos and a ticket with `expectedOldOid:null`; the promoter must conditionally require branch absence. All other tickets require ordinary change admission.

Readback examples for a ticket expecting `old=111…`, `new=eee…`:

| Canonical readback | Action |
| --- | --- |
| `eee…` | Mark the ticket applied and entries merged; record `eee…` as final canonical SHA, even if the promoter response was lost. |
| `111…` after timeout or an environment response | Keep the ticket and freeze in reconciliation. The queue may schedule one retry of the same ticket and expected old/new OIDs. A delayed first push may still arrive. |
| `111…` with definitive `OLD_REF` responses from every ticket attempt | Mark that ticket failed, release the freeze, and requeue the entries for a fresh check. An unresolved earlier attempt keeps the freeze. |
| Any third OID | Keep the freeze and require manual reconciliation. Do not issue another ticket. |

The queue never marks entries merged from a promoter response alone. `RepoStorage.resolveRef` must read back the exact checked new OID. The promoter performs Git ancestry validation and conditional push outside Workers; slice 05 supplies that execution and result dispatch. Slice 02 supplies the authoritative read-only change view and owner-only bootstrap route. Until those modules register their hooks, dependent queue paths fail closed.
