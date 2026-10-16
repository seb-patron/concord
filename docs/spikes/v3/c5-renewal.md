# Lease renewal: what this simulation can tell us

## Summary first

In this deterministic workload, keeping a published change alive through server-run checks, review, and queue work raised the share that reached landing from 26% to 87% for the 20-agent sample. It also increased unannounced abandoned-change retention: the server-phase designs held nonblocking landing permission for about 8.0 agent-minutes per run, compared with less than a third of a minute for the other designs. The paired 95% intervals are narrow for these simulated inputs, but they do not describe real Concord traffic or prove a production policy is safe.

The numbers support this limited statement: a server that preserves a published change’s landing permission during known platform phases can prevent lapses when client outages overlap those phases. They do not choose the recommended combination of session keepalives, stable fences, bounded server-phase holds, and a short reconnect grace. That combination is supported by the prior design research, not selected by this experiment. The model’s combined arm has the same modeled landing and abandonment tradeoff as server-phase holding, while its session and restart behaviors remain only small deterministic mechanisms.

Keep the decided five-minute default and exceptional, owner-approved long-hold direction (the five-minute lease decision, D-LEASE-5MIN-EXTEND). Keep exclusive writing while a change is being edited (the exclusive unit decision, D-UNIT-1-EXCLUSIVE). Once the first publication is accepted, release the exclusive writing hold and retain only a revision-bound, **nonblocking** authorization for checks, review, and landing (the post-publication bottleneck decision, D-LEASE-BOTTLENECK-ASAP). This report evaluates renewal mechanics around those recorded choices; it does not set product policy.

## What the simulation did

The model uses a 300-second lease and a client heartbeat every 100 seconds. It follows editing, checks, review, queue, and landing as separate phases. Inspection and review durations are drawn over the ranges recorded in `v2-history/lease-renewal-research.html`: 2–39.2 minutes for inspection and 3–218 minutes for review. Queue time is a stated scenario assumption of 5–30 minutes, not a Concord measurement. Time advances in five-second steps; scheduled restart events are delivered when the simulation crosses their actual time, including off-grid times.

Five designs use the same seeded fault for each agent within each sample:

| Design name | Modeled behavior |
|---|---|
| Agent heartbeat | The agent renews its leases while editing and keeps its published landing permission alive while connected. It has no reconnect grace. |
| Server phases | The agent renews while editing. During checks, review, and queue work, the server extends published landing permission. An unannounced abandonment is not visible to the server. |
| Session grace | One session heartbeat covers two units. After a lapse, the same holder may recover during a 45-second grace if nobody has replaced it. |
| Session with restart epoch | Session grace plus a server restart epoch. A delayed pre-restart write is checked and refused; the session refreshes its epoch and keeps its fence. |
| Server phases plus session | Server-phase extension plus session grace and restart-epoch handling. |

Publication releases the exclusive editing leases. Landing permission is tied to the published revision and does not block another writer. Each simulated edit attempt, restart-delayed write, and stale-holder attempt goes through the same `LeaseFence.protectedWrite` check using that holder’s fence and epoch. A failed write check can therefore raise the safety count. A deliberate mutation that makes the write guard accept every request is exercised in the test and produces nonzero violations.

Disconnects, sleep, restarts, clock-rate drift, and abandonment are drawn from seeded random streams rather than assigned by agent position. Disconnect and sleep times may fall in any phase. Abandonment may happen during editing, checks, review, or queue. A server learns of abandonment only when the fault includes an explicit close or cancellation signal; otherwise its known-phase deadline continues and contributes to the same dead-holder measure used for every design. That measure is elapsed time from abandonment while any lease or landing permission remains valid, including nonblocking landing permission.

If a lease has lapsed, ordinary renewal is refused. Session recovery can restore it with the same fence only through the stored expiry plus 45 seconds and only while no replacement has claimed it. After that, the test requires a new claim and a higher fence. The model does not silently treat an expired renewal as a reacquisition.

## Results

The primary measure was the share of runs that reached an authorized landing. Outage lapses and dead-holder minutes were selected as paired secondary measures before running the 200-seed comparison. Every interval below is a 95% normal interval across 200 independent seeded runs; each seed is paired across designs. The five-agent and twenty-agent samples use separate seed ranges, so the smaller sample is not a prefix of the larger one. Counts are normalized per simulated agent.

| Design | Agents | Outage lapses per agent, mean [95% interval] | Dead-held minutes per agent, mean [95% interval] | Reached landing, mean [95% interval] |
|---|---:|---:|---:|---:|
| Agent heartbeat | 5 | 0.531 [0.501, 0.561] | 0.229 [0.165, 0.293] | 0.257 [0.228, 0.286] |
| Server phases | 5 | 0.035 [0.024, 0.046] | 7.121 [5.518, 8.725] | 0.893 [0.879, 0.907] |
| Session grace | 5 | 0.532 [0.502, 0.562] | 0.229 [0.165, 0.293] | 0.276 [0.247, 0.305] |
| Session with restart epoch | 5 | 0.623 [0.593, 0.653] | 0.257 [0.192, 0.322] | 0.328 [0.299, 0.357] |
| Server phases plus session | 5 | 0.036 [0.025, 0.047] | 7.121 [5.518, 8.725] | 0.893 [0.879, 0.907] |
| Agent heartbeat | 20 | 0.523 [0.507, 0.539] | 0.265 [0.232, 0.298] | 0.260 [0.247, 0.273] |
| Server phases | 20 | 0.041 [0.035, 0.047] | 8.008 [7.041, 8.975] | 0.871 [0.861, 0.880] |
| Session grace | 20 | 0.521 [0.505, 0.537] | 0.271 [0.238, 0.304] | 0.282 [0.269, 0.294] |
| Session with restart epoch | 20 | 0.614 [0.601, 0.628] | 0.301 [0.267, 0.335] | 0.329 [0.316, 0.342] |
| Server phases plus session | 20 | 0.040 [0.034, 0.046] | 8.008 [7.041, 8.975] | 0.871 [0.861, 0.880] |

In the full 20-agent sample, review losses averaged 0.338 per agent for agent heartbeat, 0.000 for server phases, 0.340 for session grace, 0.403 for session with restart epoch, and 0.000 for the combined design. A review loss is counted only when the landing permission lapses during the review phase, and abandoned runs are excluded. Across the same 4,000 runs per design, the safety counter recorded zero accepted stale writes. The deliberately broken guard recorded three violations in its deterministic probe. The simulation refused 9,024–32,792 stale writes by design across the 20-agent sample. Session recovery occurred 11–158 times, and restart events fired 624 times per design.

Server-phase retention carries a clear cost in this scenario: dead-holder minutes are much higher because an unannounced abandonment is not guessed by the server and published landing permission continues through known platform work. Explicit cancellation reduces that hold. The simulated server extension count is reported separately from client renewal calls in `spikes/v3/c5/output.txt`; it is not treated as zero work.

## What the recommendation comes from

The design sources support preserving a fence when its holder renews, acquiring a higher fence only on a fresh claim, and checking the fence at the protected write destination. They also support one heartbeat for a session’s leases, server ownership during known platform phases with an explicit abandonment bound, and fail-closed reacquisition after an expired lease. These are design-source conclusions, not findings established by the simulation.

The source for the reconnect rule is the lapse-handling discussion in `v2-history/lease-renewal-research.html`, section “What happens when a lease lapses and nobody else took the unit?” It is not the same as Chubby’s 45-second client jeopardy period: Chubby’s grace concerns a client reconnecting after a master outage. The provided `s1-leases-lockservices-notes.md` summarizes that distinction and records the earlier researcher’s full-paper read; this repair did not fetch or independently re-read the paper.

The assigned work authorized this offline deterministic model repair. It did not run a live-agent pilot, measure user behavior, or approve a product change. The primary endpoint is landing; outage lapses and dead-holder time are the prespecified secondary measures. No p95 or monetary threshold is inferred because the model has no real task-time or cost distribution. The comparison is inconclusive for choosing a policy combination: the combined arm does not show a reliable advantage over server-phase holding alone, and the retention cost depends on abandonment signals and deadlines the workload only represents as assumptions.

## Terms

- **Lease:** time-limited permission to write one named unit.
- **Unit:** the protected resource, such as a file or row, represented here by one simulated lease.
- **Fence:** increasing number attached to a claim. The write destination refuses a request with an old number, even when the old and new claim use the same principal.
- **Session:** one agent run that can renew leases for several units with one heartbeat.
- **Heartbeat or keepalive:** a periodic message that asks to extend a live lease or session.
- **RPC:** a request from one process to a service. Here each client renewal call is counted as one request; server extensions are counted separately.
- **Epoch:** server generation number advanced on restart. A delayed request from an older generation is refused.
- **Fail closed:** refuse an operation when ownership or freshness cannot be established; the holder must claim again.
- **Renewal:** extension of a still-live lease without changing its fence. A lapsed lease cannot be renewed.
- **Grace:** the 45-second interval after recorded expiry during which the same holder can recover, if no replacement claim has occurred.
- **Publish:** submit a revision for platform checks and review. **Land:** accept that revision into the destination branch after queue processing. They are separate events.
- **Checker:** automated validation performed after publication.
- **Landing permission:** revision-bound authority for the platform to finish checks and landing. After publication it does not block another writer.
- **Seeded fault injection:** use a repeatable pseudo-random seed to choose scenario faults, so a run can be reproduced.
- **Idempotent:** safe to repeat without applying the same state change twice. The model does not implement request retries, so it makes no idempotency claim.
- **Orphan keeper:** a background renewal process that outlives the agent’s useful work. The model does not include one; an absent abandonment signal is represented by server retention until its phase deadline.
- **Refreshed base:** the latest destination revision used before retrying a claim or landing after another change has landed. The model does not simulate rebasing.
- **Tail behavior:** rare long waits or holds near the slow end of the observed distribution.
- **p95:** the value below which 95% of measured observations fall. No p95 is reported because this experiment has no real timing observations.
- **95% interval:** an uncertainty range around a sample mean across the modeled seeds. It does not cover errors in the assumptions or predict live-system outcomes.
- **STRUCTURAL:** a property of a deterministic mechanism or recorded artifact; it says nothing about whether current agents can use it well.
- **CAPABILITY-DEPENDENT:** an outcome that depends on current agent behavior and therefore needs a new live test; this offline model cannot establish it.

## Limits and source record

Each agent has two simulated units. One renewal call renews the session’s live edit leases, but the model does not measure database, network, or real server cost. A restart and delayed write are simplified events. The test exercises a deliberately broken write guard; it does not prove every possible product implementation correct. The 95% intervals describe seed-to-seed variation only. The model’s five-second step, queue range, fault probabilities, clock-rate drift, and abandonment-signal rate are scenario assumptions.

Inputs read for this repair: the complete Opus and Astra review files; `v2-history/lease-renewal-research.html`; `v2-history/v2-lease-decisions.md`; `s1-leases-lockservices-notes.md`; `v2-history/181-published-leases-stop-blocking.md`; and sections 4 and 5 of `claims-options.md`. The policy context was checked in `docs/decisions.md`. Section 4 of `claims-options.md` requires owner approval before a live research pilot; this delegated offline repair is not such a pilot.
