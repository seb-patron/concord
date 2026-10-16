# Wait-line review ledger

Each entry records where the finding was addressed or explains why it remains open. “O” entries are from the Opus review, “R” entries are from the Astra review, and “N” entries are new findings in the delta review.

## Opus review

| Finding | Disposition |
|---|---|
| O1 | Fixed — `spikes/v3/c4/test.ts`, simulation attempt counters and fresh attempt keys after terminal waits or lease loss; regenerated output. |
| O2 | Fixed — `test.ts` uses separate prepared workload and fault streams and replays the same two hundred schedules in each mode; `output.txt` reports per-cell intervals. |
| O3 | Fixed — `test.ts` sweeps turn length, reaction delay, and attempt probability; the report describes the limits of the source polling interval. |
| O4 | Fixed — `test.ts` advances one shared integer-tick clock and schedules requests without serially advancing it. |
| O5 | Fixed — `test.ts` records grant-time online and authorization state and integrates abandoned turns and offline writing leases over one observation window; report defines the measures. |
| O6 | Fixed — `test.ts` models enqueue-time authorization for automatic grants and fresh authorization for turns, with a deterministic revocation contrast; the report ties the recommendation to the source and leaves coordinator capability open. |
| O7 | Fixed — `test.ts`, `testTurnGuardsAndFIFO`, rejects a foreign claimant, a later waiter's attempt, and deadline extension. |
| O8 | Fixed — `waitline.ts` enforces the no-hold-and-wait restriction across queued and fresh claims and automatic advancement; `test.ts`, `testQueuedRequestCannotCreateHoldAndWait`, covers the bypass. The report does not claim cycle detection. |
| O9 | Fixed — `waitline.ts`, `advanceTime`, expires leases, waits, and turns before advancement; `testSimultaneousDeadlines` checks coincident deadlines in both modes. |
| O10 | Fixed — `test.ts` increments completed tasks only after a completed release. |
| O11 | Fixed — the report states that a crash leaves an agent offline for the rest of a run; simulation blocks offline fresh claims. |
| O12 | Fixed — report and regenerated output use abstract ticks and describe waste as integrated unit-time, without presenting it as milliseconds. |
| O13 | Fixed — report defines a fence and states that fence values and stale-write checks are not modeled. |
| O14 | Fixed — `waitline.ts` deduplicates live requests by agent, change, and normalized units; request-key payload checks include change identity. |
| O15 | Fixed — `test.ts` asserts successful turn claims, replacement credentials, deadline caps, immediate advancement after cancellation, lease-loss retry, and stale-turn rejection. |
| O16 | Fixed — report “Limits and sources” lists capacity, position, arrival estimates, ownership and close, force release, renewals, capacity behavior, and landing serialization as omissions. |
| O17 | Fixed — report defines technical terms, starts with plain findings, names sources, and has no review-ledger section or finding identifiers. |
| O18 | Fixed — report states the coordinator's atomic authentication ability as an open architecture question and does not use throughput to decide policy. |

## Astra review

| Finding | Disposition |
|---|---|
| R01 | Fixed — expire-before-advance implementation and simultaneous-deadline tests cover automatic and fresh-claim modes. |
| R02 | Fixed — `test.ts` separates task identity, attempt identity, and completion; terminal retry and completion behavior are asserted. |
| R03 | Fixed — common prepared traces, one shared clock, multiple seeds, and intervals are used; the report limits conclusions to this scenario. |
| R04 | Fixed — model enforces and tests the restricted no-hold-and-wait policy; no claim of general cycle detection remains. |
| R05 | Fixed — `testPublishedHoldsAndDeadlockRule` exercises publication, landing, and overlapping published holds on the same unit in both modes. |
| R06 | Fixed — request retries compare units and change identity; live-wait deduplication includes agent, change, and normalized units. |
| R07 | Fixed — the report disclaims credential-expiry and fence guarantees and names revocation behavior and limits. |
| R08 | Fixed — `freshClaim` rejects a retry after its turn is no longer live; deterministic tests cover stale-turn rejection. |
| R09 | Fixed — assertions require concrete grants and live states; holder expiry with waiter success and cancellation-driven progress are tested. |
| R10 | Fixed — report and output contain regenerated per-cell values without the incorrect aggregate. |
| R11 | Fixed — `grant` records one mode-specific acquisition event; tests assert one fresh-claim event. |
| R12 | Fixed — report names all four source designs by descriptive title and filename; alias overlap is tested. |
| R13 | Fixed — report defines essential terms and explains the remaining model limitations in ordinary language. |

## Delta review findings

| Finding | Disposition |
|---|---|
| N1 | Fixed — `WaitLine.claim` rejects direct and turn claims from an offline agent; simulation checks online status before a fresh turn claim and snapshots online state at grant. Only online grant events contribute to the online metric. |
| N2 | Fixed — direct and fresh claims are rejected when the agent has a writing hold or a live queued request; automatic advancement also skips an agent with a writing hold. `testQueuedRequestCannotCreateHoldAndWait` exercises both modes. |
| N3 | Fixed — request-result payloads store and compare change identity; `freshClaim` requires the wait's change identity. Tests cover changed-change key reuse and a turn claimed under another change. |
| N4 | Fixed — authorization is snapshotted in the grant operation for both modes; the metric reads that snapshot instead of checking a credential later. |
| N5 | Fixed — `testMultiUnitNoBargingAndHolderExpiry` restores all-or-nothing multi-unit priority, direct-claim non-barging, and holder-expiry progression in both modes. |
| N6 | Fixed — report says the source's two-second minimum polling interval sets no maximum reaction time; it labels simulated reaction delays as assumptions. |
| N7 | Fixed — turn request keys use the task attempt counter stored in the agent's attempt map. |
| N8 | Fixed — both offline writing leases and open turns accrue unit-time tick by tick inside the same fixed observation window; online action latency excludes offline recipients. |
| N9 | Fixed — pending claim deadlines are tied to a wait ID and reset when a wait becomes terminal or a claim succeeds. |
