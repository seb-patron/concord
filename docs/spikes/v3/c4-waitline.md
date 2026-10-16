# Wait-line spike: automatic grant or a fresh claim?

## Summary

This repaired prototype compares an original-style automatic queue grant with a fresh-authentication turn. A queued grant immediately creates a lease; a turn only reserves the waiter's place and requires a new authenticated claim. The simulation now uses the same scheduled arrivals, crashes, and credential revocations for both modes. Across two hundred traces per cell, results vary with agent count and turn length; they do not establish a generally faster mode. The automatic mode sometimes grants to a credential revoked after enqueue, which reproduces the risk in the original design.

The source designs support a fresh claim when authorization cannot be checked in the same atomic operation as granting a lease. The supplied material does not establish whether Concord's planned coordinator can make that operation atomic. Keep that architecture question open; do not choose a grant policy from these throughput results. The comparison and its raw output are in [the test output](../../../spikes/v3/c4/output.txt).

At twenty-five agents and the source-matched turn ratio, mean completed tasks were 36.09 for automatic grant and 25.59 for a fresh claim. Their per-mode 95% intervals were [35.30, 36.87] and [24.94, 26.24]. Mean calls were 95.51 [94.15, 96.87] and 133.92 [131.85, 135.99]. Those numbers describe this small synthetic workload only. They are not estimates of production task rates, and the experiment did not calculate an interval for the between-mode difference.

## Terms and model

A **wait line** orders claims that cannot yet receive every requested unit. A **lease** is a time-limited exclusive writing right. A **turn** reserves priority without granting a lease. A **writing hold** blocks an overlapping writer until release, expiry, or first publication. A **published hold** remains attached to its change while it is landing but does not block another writer; the queue handles landing order. A **principal** is the simulated agent identity associated with a credential. **Revocation** makes that credential invalid for a later authentication check. A **request key** identifies one attempt and safely replays its result only when the retried unit set matches. A **task** may have multiple attempts and counts as complete only when its lease is released after work.

The prototype is in-memory TypeScript with a single monotonic coordinator clock. It models canonical file and symbol overlap, all-or-nothing multi-unit claims, FIFO among overlapping waiters, bounded wait and lease deadlines, retries, credential revocation, and publication. It has no credential-expiry timestamp, cryptographic authentication, persistence, concurrent transactions, lease fence values, or production unit resolver. The report therefore makes no fencing or stale-write guarantee. Distinct symbols in one file do not overlap; a file and a symbol in that file do.

The automatic arm follows the original wait-queue design: it authenticates when the wait is enqueued and does not recheck the credential when the queue grants. A separate test revokes a queued credential and observes that grant. The fresh-claim arm checks the credential at the turn claim. This is a purposeful comparison of different authorization boundaries, not a claim that the automatic arm has the fresh arm's safety property.

The model forbids **hold-and-wait**: an agent with a writing lease cannot request another writing lease before publishing or releasing the first. A two-agent cycle test confirms both growing claims are refused. This is the deadlock policy modeled here; it does not detect cycles for an incremental-growth protocol. At first publication a lease changes from a blocking writing hold to a nonblocking published hold, then to a landing hold. Release represents a terminal landing outcome such as merge, close, or queue termination; expiry remains a recovery path. Multiple published holds may overlap, consistent with the supplied lifecycle design.

## Deterministic checks

Five scenario groups exercise both modes where applicable: FIFO/no-barging and the three broken turn-claim variants; simultaneous lease and waiter deadlines; enqueue-time versus fresh-claim revocation; attempt identity, terminal-wait recovery, lease-expiry retry, and stale-turn rejection; and published-hold transitions plus the hold-and-wait refusal. Additional assertions cover a turn capped by its wait deadline, cancellation followed by queue advancement, same-agent use of a replacement credential, alias overlap, and single event classification for fresh grants. The suite asserts successful acquisitions and resulting states rather than treating a missing lease as a passing case.

The cycle policy is deliberately restrictive. It proves only that this prototype refuses a second writing acquisition while the first writing hold remains. Atomic acquisition by itself would not prevent a cycle across separate claims. The supplied cycle design instead describes cycle detection and younger-change yield for a grow-capable protocol; that protocol is not implemented here.

## Seeded comparison

Each cell runs two hundred seeds. For every seed, purpose-specific random streams create one fixed arrival, crash, and revocation schedule, then the same schedule is replayed in each mode. Queue behavior can diverge, but a mode cannot consume extra random draws and thereby change future scheduled events. A single integer-tick event clock advances both modes. A fresh claim's two-tick reaction delay schedules when that request arrives; it never advances the shared clock or expires another agent's deadline by itself.

The baseline uses two, five, ten, or twenty-five agents, three planned tasks per agent, five shared units, a ninety-tick wait deadline, a twenty-four-tick lease, and a forty-five-tick turn. These are scenario settings, not recommended timeouts. A crash leaves the agent offline for the rest of that run; any held lease expires, while the simulation still records a queued grant to an offline agent as wasted. A task attempt is renewed after a terminal wait or lost lease with a new attempt key. Tasks count once, at completed release.

The interval shown after each mean is a two-sided 95% normal interval across the two hundred seed-level values. “Completed” counts useful finished tasks. “Online wait grants” counts queued leases or turns successfully claimed by agents still online. “Waiting grants” includes all successfully granted waits, including grants to agents that have since crashed. “Calls” counts simulated claim, release, and turn-claim requests. “Wasted unit-ticks” includes time spent in abandoned turns and writing leases held by offline agents, in both modes. The p95 is wait-to-action time in abstract simulation ticks. Automatic grants after revocation are counted separately; a negative interval endpoint is clipped to zero.

| Agents | Mode | Completed tasks, mean [95% interval] | Calls, mean [95% interval] | Wasted unit-ticks, mean [95% interval] | Revoked-credential grants, mean [95% interval] |
|---:|---|---:|---:|---:|---:|
| 2 | Automatic | 5.21 [5.06, 5.35] | 10.95 [10.73, 11.17] | 6.17 [4.73, 7.60] | 0.01 [0.00, 0.03] |
| 2 | Fresh claim | 5.16 [5.00, 5.31] | 12.08 [11.68, 12.48] | 7.82 [6.05, 9.58] | 0.00 [0.00, 0.00] |
| 5 | Automatic | 12.66 [12.42, 12.91] | 26.86 [26.49, 27.22] | 20.66 [18.19, 23.12] | 0.23 [0.16, 0.30] |
| 5 | Fresh claim | 12.07 [11.79, 12.36] | 35.94 [35.00, 36.87] | 33.02 [29.49, 36.54] | 0.00 [0.00, 0.00] |
| 10 | Automatic | 22.86 [22.39, 23.33] | 50.15 [49.44, 50.86] | 60.99 [57.06, 64.92] | 0.93 [0.80, 1.05] |
| 10 | Fresh claim | 20.00 [19.43, 20.56] | 73.77 [72.24, 75.30] | 87.04 [81.58, 92.50] | 0.00 [0.00, 0.00] |
| 25 | Automatic | 36.09 [35.30, 36.87] | 95.51 [94.15, 96.87] | 150.60 [144.22, 156.98] | 3.23 [2.99, 3.47] |
| 25 | Fresh claim | 25.59 [24.94, 26.24] | 133.92 [131.85, 135.99] | 182.12 [175.25, 188.99] | 0.00 [0.00, 0.00] |

The turn-duration sensitivity run uses the same two hundred traces at twenty-five agents and a two-tick reaction. Completed-task means were 29.51 with a nine-tick turn (4.5 times reaction), 27.70 with twenty ticks (10 times), 25.59 with forty-five ticks (22.5 times), and 24.62 with ninety ticks (45 times). Full intervals and the other measurements are in the raw output. The revised design uses a 45-second turn and requires polling no faster than every two seconds: at least a 22.5-to-one turn/reaction ratio. The model's forty-five-tick baseline represents that ratio; the other turn lengths show this workload is sensitive to the choice.

The fault run exercises revocation, including post-enqueue revocations that result in automatic grants. In the twenty-five-agent automatic cell, the mean was 3.23 revoked-credential grants per run [2.99, 3.47]; the fresh-claim cell recorded none. This is a simulated consequence of the original rule, not an estimate of actual authorization incidents. The source designs also call out queue capacity, status and position, ETA, force-release, ownership and close behavior, renewals, and retaining a turn when capacity blocks grant. This prototype does not model those behaviors, the separate lease fence path, cross-process races, or an actual landing stack.

## Limits and sources

The simulations use synthetic event schedules, five hot units, a short fixed horizon, a single coordinator, and an offline-agent crash rule. They do not model agent adaptation, real network distributions, task acceptance checks, repair costs, persisted queue state, change revisions, a real authorization catalog, or merged-tree validation. A mean confidence interval is not a policy decision threshold; there is no owner-approved minimum useful effect or safety margin here. The results are inconclusive for choosing a production design. In particular, the experiment cannot establish whether the planned single coordinator can atomically authenticate and grant; that decision needs an architecture review against the actual authorization boundary.

The report follows the supplied comparison plan's preference for useful completed work, deterministic protocol checks, common event traces, uncertainty ranges, sensitivity analysis, and an explicit inconclusive outcome. No external sources were fetched. The local source files read in full for this repair were:

- “Wait queue” design, `v2-history/72-lease-wait-queue.md`: original enqueue-authorized automatic grant, queue order, caps, and lifecycle.
- “Fresh-authentication wait turn” design, `v2-history/116-lease-wait-v2.md`: turn deadlines, a later authenticated claim, expiry ordering, and queue limits.
- “Refuse deadlocking lease growth” design, `v2-history/73-lease-deadlock.md`: waits-for cycle detection and younger-change yield for incremental acquisition.
- “Published leases stop blocking” design, `v2-history/181-published-leases-stop-blocking.md`: writing holds end at first publication; landing holds no longer block other writers.
- “Claims experiment options,” sections four and five of `claims-options.md`: comparison methods, useful-work endpoint, uncertainty, and open owner decisions.
- The complete supplied Opus and Astra reviews, `review-opus-111.md` and `review-astra-111.md`, plus all four original spike files on this branch.

## Review ledger

Every supplied finding is accounted for below. Entries marked fixed describe code, tests, or report sections in this repair. Cross-references identify shared repairs.

| Finding | Disposition |
|---|---|
| O1 | fixed — task, attempt, and completion are distinct; a new key follows terminal waits and lease loss; see simulator and retry tests. |
| O2 | fixed — independent schedule streams, shared predetermined events, two hundred seeds per cell, and intervals; see seeded comparison. |
| O3 | fixed — four turn/reaction ratios are reported, including the source ratio; see sensitivity paragraph and output. |
| O4 | fixed — all agents share one event clock; request reaction is scheduled without advancing that clock. |
| O5 | fixed — useful completions, online grants, dead-agent grants, and unit-time waste are counted; see metrics definitions and table. |
| O6 | fixed — original automatic grant omits a grant-time recheck; revocation is injected; its measured risk is reported separately. |
| O7 | fixed — regression checks reject a foreign claimant, a later waiter, and turn extension. |
| O8 | fixed — the model explicitly forbids hold-and-wait and tests both sides of a two-agent cycle; no general no-cycle claim remains. |
| O9 | fixed — waits, turns, and leases expire before queue advancement; simultaneous deadlines have a regression test. |
| O10 | fixed — completion increments only after a completed release. |
| O11 | fixed — crash rule is explicit: agents stay offline and their leases expire; no return is assumed. |
| O12 | fixed — all time is labeled in abstract ticks; no multiplication is presented as measured milliseconds. |
| O13 | fixed — the report says fence values are not modeled and removes claims that a lease grants a fence. |
| O14 | fixed — a live duplicate is identified by agent, change, and normalized unit set; mismatched payload reuse is rejected; token expiry is not claimed. |
| O15 | fixed — successful grant, replacement credential, deadline cap, cancellation advancement, lease-loss retry, and stale-turn outcomes are asserted. |
| O16 | fixed — queue capacities, position and ETA, ownership and close, force-release, renewals, capacity behavior, and landing-stack gaps are listed. |
| O17 | fixed — the report leads with a plain summary, defines essential terms, names local sources, and keeps finding identifiers in this ledger. |
| O18 | fixed — the coordinator's atomic authentication ability is stated as an open architecture question; throughput does not decide the policy. |
| R01 | fixed — simultaneous expiry and delayed advancement are covered by the same expire-before-grant implementation and test. |
| R02 | fixed — task identity, attempt identity, completion count, terminal recovery, and completion timing are separate. |
| R03 | fixed — both modes replay common arrivals and faults over two hundred seeds per cell with intervals. |
| R04 | fixed — hold-and-wait is refused and the two-agent cycle is tested; incremental cycle detection is not claimed. |
| R05 | fixed — writing, published, and landing phases are modeled; terminal release and expiry are exercised. |
| R06 | fixed — live-wait deduplication uses agent, change, and normalized units, while request-key payload mismatch is rejected. |
| R07 | fixed — no unsupported token-expiry or fencing guarantee is claimed; revocation is tested and the remaining limits are explicit. |
| R08 | fixed — a stale turn retry is rejected rather than reporting a released or expired lease as current. |
| R09 | fixed — assertions require concrete successful state transitions and cover expiry and progression. |
| R10 | fixed — the report uses regenerated per-cell totals and no incorrect aggregate. |
| R11 | fixed — a fresh grant emits one correctly classified acquisition event. |
| R12 | fixed — descriptive titles and filenames identify the four source designs; alias overlap is tested. |
| R13 | fixed — terms are defined in plain language and source provenance and model limits are explicit. |

## Validation

The required test command is `node --experimental-strip-types spikes/v3/c4/test.ts`. The report's raw results are regenerated from that command in [output.txt](../../../spikes/v3/c4/output.txt). The required finding-row count command is `grep -c -E '^\| *(O[0-9]|R[0-9])' docs/spikes/v3/c4-waitline.md`; it should report 31.
