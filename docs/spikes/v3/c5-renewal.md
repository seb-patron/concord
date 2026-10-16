# Lease renewal prototype: final repair

## Summary first

This repaired deterministic model now refuses publication after editing authority is lost, checks every accepted simulated write against an independent grant-state monitor, permits a new grace recovery for each lapse, clears review-loss results when the run is later abandoned, and releases landing permission on successful landing. Its tests detect disabled grace, a suppressed contender fence increment, and guards that accept expired writes. These are offline model results, not evidence that a production service is safe.

In the twenty-agent workload, the server-phase design reached landing in 70.2% of runs, compared with 28.1% for agent heartbeats; the combined server/session design reached 82.9%. Server-phase holding also retained abandoned landing permission longer: 4.06 dead-held agent-minutes per agent for server phases and 4.88 for the combined design, compared with 0.26 for agent heartbeats. The numerical comparison is conditional on the stated workload and timing assumptions; it cannot select a production policy.

The offline prototype repair was approved by the owner on 2026-10-15. A live-agent pilot requires separate owner approval. The five-minute lease default, exclusive editing claim and first-publication transition follow the recorded five-minute lease decision (D-LEASE-5MIN-EXTEND), exclusive unit decision (D-UNIT-1-EXCLUSIVE), and published-change bottleneck decision (D-LEASE-BOTTLENECK-ASAP). This report does not change those policies.

## Model and inputs

Each simulated agent holds two editing units under a 300-second lease, with a heartbeat every 100 seconds. The phases are editing, automated checks, review, queue wait, and landing. Time advances in five-second steps. Five designs share each seeded fault stream: agent heartbeat; server renewal during checks, review and queue; session heartbeat with 45-second lapse grace; session heartbeat with a restart epoch; and server renewal combined with session recovery.

Editing lasts ten minutes and queue wait is sampled from five to thirty minutes; both are scenario assumptions because the supplied measurements do not provide those distributions. The supplied lease-renewal research measured 121 inspections: 62% exceeded five minutes, the median was 6.8 minutes, the 90th percentile was 23.8 minutes, and the maximum was 39.2 minutes. The model uses those reported quantile anchors, with interpolation inside each band as an explicit assumption because the raw observations are not supplied. The same research measured 13 reviews from 3 to 218 minutes, with a 37-minute median. The model samples each side of that median uniformly; that shape is an assumption, not a measured distribution. Abandonment, disconnection, sleep, clock-rate drift, restart time, and explicit cancellation are seeded scenario inputs.

Publication is allowed only if the change is still active, has not lost editing authority, and both editing leases pass their current fence, epoch and expiry checks at the publication transition. Publication releases the exclusive edit leases and creates revision-bound, nonblocking landing permission. A later loss cannot mint new permission. A successful landing releases the landing permission. A server learns about abandonment only from an explicit cancellation signal; otherwise its phase-based extension continues and contributes to dead-held time.

The safety monitor independently checks holder, fence, expiry and server epoch against recorded lease state whenever the simulated write guard accepts a request. It counts each accepted write whose authorization is expired or superseded. The model probes edit writes at each five-second simulation step, sends one late write when a contender replaces a holder, and sends a terminal stale-write probe. Refused stale writes are attempts, not unique leases. Grace recovery is tracked for each lapse and independently for editing and landing permission.

## Results

The primary measure is the fraction of runs that reached authorized landing. Outage lapses and dead-held time are secondary measures. Results average 200 independent seeds per design and size; each seed is paired across designs, and the five-agent and twenty-agent samples use separate seed ranges. Intervals are 95% normal intervals across seeds and cover seed variation only.

| Design | Agents | Outage lapses per agent | Dead-held minutes per agent | Landed fraction | Review losses per agent |
|---|---:|---:|---:|---:|---:|
| Agent heartbeat | 5 | 0.512 [0.480, 0.544] | 0.270 [0.204, 0.336] | 0.256 [0.228, 0.284] | 0.297 [0.269, 0.325] |
| Server phases | 5 | 0.057 [0.042, 0.072] | 4.765 [3.496, 6.034] | 0.682 [0.653, 0.711] | 0.000 [0.000, 0.000] |
| Session grace | 5 | 0.512 [0.480, 0.544] | 0.277 [0.211, 0.343] | 0.276 [0.247, 0.305] | 0.299 [0.271, 0.327] |
| Session with restart epoch | 5 | 0.595 [0.565, 0.625] | 0.299 [0.232, 0.366] | 0.339 [0.308, 0.370] | 0.355 [0.327, 0.383] |
| Server phases plus session | 5 | 0.055 [0.041, 0.069] | 5.172 [3.879, 6.464] | 0.824 [0.802, 0.846] | 0.000 [0.000, 0.000] |
| Agent heartbeat | 20 | 0.507 [0.491, 0.523] | 0.256 [0.227, 0.285] | 0.281 [0.266, 0.295] | 0.271 [0.258, 0.284] |
| Server phases | 20 | 0.059 [0.051, 0.066] | 4.057 [3.444, 4.670] | 0.702 [0.687, 0.717] | 0.000 [0.000, 0.000] |
| Session grace | 20 | 0.507 [0.491, 0.523] | 0.261 [0.231, 0.291] | 0.305 [0.290, 0.320] | 0.272 [0.260, 0.285] |
| Session with restart epoch | 20 | 0.583 [0.567, 0.599] | 0.294 [0.262, 0.326] | 0.361 [0.345, 0.377] | 0.316 [0.303, 0.329] |
| Server phases plus session | 20 | 0.056 [0.049, 0.063] | 4.875 [4.205, 5.545] | 0.829 [0.818, 0.840] | 0.000 [0.000, 0.000] |

Outage durations are split at the 45-second grace boundary. Across 200 runs of 20 agents (4,000 agent scenarios) per design, each design received 68 injected outages of 45 seconds or less and 4,127 outages longer than 45 seconds. Across 200 runs of five agents (1,000 agent scenarios), there were 13 short and 1,051 longer outages. These count each seeded disconnect and sleep event separately, including overlapping events; they are not normalized per-agent rates.

The accepted-unauthorized-write count was zero for every design and sample. The test mutations show the counter is active: an always-accept guard produced 119 violations; a guard that ignored expiry produced 78. Disabling grace yielded zero recoveries in a scenario requiring two and failed its assertion. Suppressing the contender fence increment produced `1 -> 1` and failed the higher-fence assertion. The full refusal, recovery, restart and server-extension counts are recorded in `spikes/v3/c5/output.txt`.

Review loss means that a lease lapse occurred during review and the scenario was never abandoned. A later abandonment removes that scenario from the review-loss result. Server-phase designs show no such losses in this workload, alongside higher dead-held time because the server cannot infer an unannounced abandonment. Those results do not establish how often real agents abandon work or how long a live service should retain a published change.

## Interpretation and limits

The modeled safety invariant is that a protected write is accepted only while the same holder owns the same fence in the current server epoch and before expiry. Renewal preserves a fence; only a new claim advances it. Grace recovery preserves the current fence only if no replacement has claimed. If editing authority has been lost, publication does not grant a new landing authorization.

The simulation supports a narrow workload statement: server extension during known platform phases lowers modeled lapses and raises landing completion, while increasing retention after an unannounced abandonment. The combined design also improves modeled completion, with a higher retention cost than server phases alone. The model cannot select a production combination; that requires real workload evidence and separate approval for a live pilot.

The reconnect rule is from the supplied lapse-handling discussion in `v2-history/lease-renewal-research.html`. It is distinct from Chubby's 45-second client jeopardy period, which concerns reconnection after a master outage. The supplied `s1-leases-lockservices-notes.md` summarizes this distinction and records the prior researcher's full-paper read; this repair did not independently fetch or reread that paper. The post-publication nonblocking hold follows the published-change transition in `v2-history/181-published-leases-stop-blocking.md`.

This is a deterministic prototype, not a production implementation. It simplifies server clocks, writes, restarts, the queue, and cancellation. Its step size, editing duration, queue distribution, fault probabilities, interpolation within measured quantiles, and review distribution shape are assumptions. The reported confidence intervals do not capture those assumption errors, real traffic variation, or current-agent capability. The result does not establish production safety or a policy choice.

## Terms

- **Lease:** time-limited permission to write one named unit.
- **Unit:** a protected resource, such as a file or row.
- **Fence:** increasing number attached to a claim; a newer claim must have a higher number.
- **Session:** one agent run that can renew more than one lease with one heartbeat.
- **Heartbeat:** periodic request to extend a live lease without changing its fence.
- **Epoch:** server generation number advanced on restart; delayed requests from an older generation are refused.
- **Grace:** 45 seconds after lease expiry during which the same holder may recover if nobody has replaced it.
- **Landing permission:** revision-bound permission for platform checks and landing; it does not block a new writer after publication.
- **Dead-held minutes:** time after abandonment during which any edit lease or landing permission remains valid.
- **Review loss:** lapse during review for a run that is not later abandoned.
- **95% interval:** range describing seed-to-seed uncertainty in a sample mean, not a prediction interval for live behavior.

## Sources and approval boundary

Inputs for this repair were the supplied delta, Opus and Astra reviews; the lease-renewal research and lease decisions; the published-change lease specification; the supplied lease and lock-service notes; and sections 4 and 5 of the claims-options report. The lease-renewal research reports the measured inspection and review summaries stated above. The claims-options report requires owner approval for the selected offline research tests and separate approval for a live-agent pilot. The owner approved these offline tests on 2026-10-15; the live pilot remains unapproved and out of scope.
