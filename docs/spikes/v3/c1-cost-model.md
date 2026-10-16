# Claim cost model: wait now or repair later

**Research snapshot, 15 October 2026.** The [standing exclusive-writing decision](../../decisions.md) (D-UNIT-1-EXCLUSIVE) remains in force. This report asks what gain might justify changing it; it does not change policy or authorize a trial.

## Plain answer

We cannot yet show that parallel editing saves time or money. The model shows possible gains, but actual claim waiting and conflict repair are not linked in the available records. A replay found textual conflicts concentrated in one repository's reading logs; it measured no agent waiting. The owner needs to choose the smallest worthwhile gain and acceptable added costs before a fair comparison. Until then, keep exclusive writing claims and collect complete task histories.

**Structural** means a mechanism or measurement limit independent of agent skill. **Capability dependent** means agent behavior, such as repair speed, that can change with models, prompts or tools; retest it with current agents. Evidence here has the snapshot date above.

## What the alternatives mean

A **claim** requests permission to write a protected **unit**, such as a file or verified part of it. A **lease** is the time-limited grant. Its **writing hold** excludes another writer until first publication, when a candidate is sent for inspection. A nonblocking landing hold remains afterward. A second writer can therefore still hit a merge conflict before a change **lands** (becomes accepted in the repository). The server checks the lease's generation marker (**fence**) and inspected revision before protected publication and landing. Those checks remain necessary with either writing policy.

Suppose two agents need a reading-trail log. Under exclusive writing, the second waits or switches tasks. Under parallel writing, both edit and one may repair a conflict. At an *assumed* 20% encounter rate and 15-minute unproductive wait, exclusivity spends three wait minutes per dispatched task. In the research-tools example, an equal-encounter-rate scenario spends about 1.7 repair minutes per task in parallel; a changed-file encounter proxy reduces that to about 0.5. These are model illustrations, not observed accepted tasks. The exclusive side may also pay repair costs after publication.

## What was measured

The script reads local status and usage records for five repositories, dated before 16 October UTC. It verifies repository labels and includes modern repository-hash/run directories plus older repository/run directories, without searching nested fixtures. The older layout adds 63 research-tools runs and two agent-workflows runs. Records without usage data remain in run counts but not timed medians; the zero-to-24-hour duration check removed no timed session. All-session medians mix implementations, read-only reviews, repairs and failed attempts. They are **active-time proxies**, not expected normal-task or restart costs. Retry links connect attempts but do not explain them.

| Repository | Runs | Timed sessions | Mixed-session median minutes | Repair-label median minutes | Explicit rebase/conflict sessions |
|---|---:|---:|---:|---:|---:|
| Concord | 1,225 | 1,205 | 4.5 | 7.8 | 37 |
| agent-workflows | 986 | 958 | 10.6 | 20.1 | 1 |
| gen-v-research-tools | 605 | 510 | 13.2 | 11.8 | 0 |
| mwcc-rs | 1,905 | 1,845 | 10.9 | 15.6 | 0 |
| gen-v-decomp | 3,463 | 3,408 | 6.1 | 10.3 | 1 |

A **repair label** is a target pull request or words such as repair, rebase, retry, address review, review fix or fix review in the work label or kind. Spaces and hyphens are accepted in the last three phrases, as is review fixes. Labels starting with review are excluded, even if they mention a rebase. This is a **repair-time proxy**: 220 of 227 research-tools repair-labeled runs explicitly say review fix, and none names rebase or conflict. Concord's 37 explicit rebase/conflict sessions have a 4.6-minute median, the closest available rebase proxy, but are not tied to a recorded merge conflict. The generated output gives category counts, timing coverage and run states. **Capability dependent:** these durations reflect the workers of this period. To measure true repair time, link a conflict to repair start/end, attempts, checks, accepted land and human actions.

The supplied *Declared and actual worker footprints* study compared overlapping approximate run intervals. Declared paths overlap far more often than changed paths, so the two policies cannot share one encounter rate. The table's **ratio proxy** divides changed-path overlapping pairs by declared-path overlapping pairs; it is a sensitivity input only. Changed paths require locally diffable commits, while declarations do not: just 5,367 of 10,513 eligible runs were diffable. The raw output prints 3,592,610 interval pairs but its prose says 3,800,963. Neither pair count estimates a newly dispatched task's chance of waiting. The launcher (the worker's run controller) rejects accepted edits outside its **Allowed-files list**, the approved paths for a task, so final diffs hide attempted scope growth. A scope refusal is not a competing-lease refusal.

| Repository | Declared-path pair share | Changed-path pair share | Ratio proxy |
|---|---:|---:|---:|
| Concord | 30.7% | 4.8% | 0.157 |
| agent-workflows | 26.6% | 7.6% | 0.285 |
| gen-v-research-tools | 48.6% | 15.4% | 0.317 |
| mwcc-rs | 19.0% | 0.9% | 0.047 |
| gen-v-decomp | 26.0% | 0.8% | 0.031 |

The supplied *Larger lock-scheme replay* compared overlapping **merged pull request pairs**, not tasks. It examined all 104 Concord pairs and 300 selected pairs in each other repository. A pair was **file blocked** when both final changes touched a path. Concord, agent-workflows, mwcc-rs and gen-v-decomp had respectively 18, 118, 19 and 25 file-blocked pairs with zero textual conflicts. Research-tools had 40 textual conflicts among 61 file-blocked pairs, giving a 65.6% **conditional conflict proxy**. Zero is a sample point count, not proof of zero risk. Simple upper-bound calculations for a yes/no conflict outcome are 17.6%, 3.2%, 76.3%, 16.8% and 13.3% in table order; they are not population intervals because pairs share requests, repositories have different caps, and final request versions can include later changes. File exclusion also blocked 201 textually clean pairs overall. The replay measured no failures in program meaning (semantic failures), checks on the proposed combined change (merged-tree checks), abandoned work or repair time.

Thirty-six of the 40 research-tools conflicts involved **append-only** logs or indexes, including reading-trail files such as LAB_READING_TRAIL.md; file classes overlap. An allowlisted **union merge** keeps both sides' text in such a file. It left eight textual conflicts, so its replay proxy is 8/61 or 13.1%. It did not verify ordering, duplicates or the merged tree. A separate structured-merge tool, Mergiraf, resolved three of 44 conflicted content files. Symbol-level and interface-versus-body lock schemes often widened to file scope when their extractors could not identify a safe smaller unit; similar totals are a test limitation, not proof of equal value.

The replay's 1,865.9 **pairwise serial-delay hours** sum, for each blocked pair, the time from the later request's creation until the earlier request merges, floored at zero. That may exceed the requests' actual intersection and repeatedly count one request. It is not worker wait time. **Structural:** a file intersection, a textual conflict and a semantic break are different events.

### Waiting and dollars are still unknown

The script extracts **dispatcher hold**, delay before the worker launches; its median is zero in all five repositories. It does **not** extract claim-request-to-grant intervals and makes no assertion that every status file lacks them. The supplied *Concord v3: claim and lease options* synthesis describes a separate Concord lease-event episode on 13 October: 2,392 claim-granted events and 2,306 refused events. If these are the two attempt outcomes, refusals are roughly half of the event attempts. Retries inflate that share, and only two holder principals made claims; it is not a task encounter rate. The separately approved lease-record audit should link each refusal to later grant or cancellation and measure the interval by phase. Its review waits and inspections occur after writing and must not be charged as initial claim wait.

Three selected usage records carry dollar cost as an object with value and USD unit; broad pricing is absent and selected tariff (price-list) fields are null. The supplied *Our measured usage* snapshot's Cloudflare request totals are service volume, not claim costs. After an idle-alarm fix, the hourly table shows eight requests per hour to Cloudflare's stateful storage service; earlier high volume may largely have been background traffic (an inference). Charges for stored artifacts and marginal provider prices are missing. No dollar saving can be calculated. Cached input tokens are part of input tokens, so they must not be added twice. The output retains token medians for engineers.

## Cost model and possible gain bars

Let **B** be a mixed-session median minutes proxy; **p_claim** the unmeasured chance a dispatched task meets a writing claim; **W** the unproductive minutes it waits; **p_change** the unmeasured chance parallel tasks change the same relevant area; **c** the replay conditional-conflict proxy; **R** the mixed repair-label minutes proxy; **f** an assumed repair-failure chance; and **A_exclusive** expected residual repair minutes per task after exclusive publication. Assume one predecessor, one repair and at most one restart, equal landing/check work and no useful task switching during W. No human or compute price is included.

> Exclusive agent minutes per dispatched task = B + p_claim × W + A_exclusive. Parallel agent minutes = B + p_change × c × (R + f × B). Break-even requires p_claim × W = p_change × c × (R + f × B) − A_exclusive.

The older expression W = c × (R + f × B) holds only if encounter rates are equal and exclusive repair is zero. The present exclusive policy can require repair after first publication. Zero exclusive repair is therefore an **idealized sensitivity case**, not a measured baseline. The CSV also tries one assumed residual repair minute per task. A lower changed-file rate or more exclusive-side repair lowers the wait needed for parallel writing to break even. Neither encounter rate is calibrated by the footprint pair shares.

For a relative **illustrative** throughput gain g, required wait is [g × B + (1 + g) × p_change × c × (R + f × B) − A_exclusive] / p_claim. Throughput here is 60 / modeled agent minutes for a continuously occupied agent, not accepted tasks from dispatch through land. With 20% assumed claim encounters, 10% assumed repair failure, zero exclusive repair and replay point conflicts:

| Repository | Break-even wait, equal rates (min) | Break-even wait, ratio proxy (min) | Gain at 15-min wait, equal rates | Gain at 15-min wait, ratio proxy |
|---|---:|---:|---:|---:|
| Concord | 0.0 | 0.0 | 66.2% | 66.2% |
| agent-workflows | 0.0 | 0.0 | 28.4% | 28.4% |
| gen-v-research-tools | 8.6 | 2.7 | 8.6% | 17.9% |
| mwcc-rs | 0.0 | 0.0 | 27.6% | 27.6% |
| gen-v-decomp | 0.0 | 0.0 | 49.2% | 49.2% |

For research-tools, substituting the union-log replay proxy gives about **1.7 minutes** break-even wait at equal rates, or **0.5 minutes** with the footprint ratio proxy. At a five-minute wait, ordinary-merge equal-rate arithmetic favors exclusivity; the union-log case favors parallel writing. Semantic safety remains untested.

The owner has **not** chosen a minimum worthwhile gain. Previous 15% proposals have no owner-backed valuation, and the model cannot choose a unique bar. Three **candidate owner choices** below show encounter wait needed for each modeled gain, using the ratio-proxy case above. Wait averaged over *all* dispatched tasks is one fifth of each cell. Choosing 5% accepts a small gain for changing authorization and recovery; choosing 30% demands more gain for that work. Fifteen percent is a middle discussion case, not a recommendation.

| Repository | 5% gain: wait min | 15% gain: wait min | 30% gain: wait min |
|---|---:|---:|---:|
| Concord | 1.1 | 3.4 | 6.8 |
| agent-workflows | 2.6 | 7.9 | 15.8 |
| gen-v-research-tools | 6.2 | 13.0 | 23.3 |
| mwcc-rs | 2.7 | 8.2 | 16.3 |
| gen-v-decomp | 1.5 | 4.6 | 9.1 |

These rows cannot select a default: rate and duration inputs are proxies, zero-conflict points are uncertain, and the denominator omits review, queue, landing, failed chains and task switching. The shipped [scenario CSV](../../../spikes/v3/c1/breakeven.csv) includes relative throughput percentages and all rate, wait, failure and residual-repair scenarios.

## Decision and measurement plan

The owner should choose values *before* a comparison:

| Outcome from dispatch to accepted land | Value choice and current gap | Instrumentation |
|---|---|---|
| Finished tasks per agent-hour and end-to-end elapsed time | Choose the smallest useful accepted-task gain and whether slower wall time can be traded for capacity. The model informs active-time scenarios only. | Link dispatch, work, review, repair, failed attempts and accepted land on one task chain. |
| Long waits: the 95th-percentile wait, below which 95% of waits fall, and starvation | Choose the longest tolerable tail wait and whether a mean gain can offset it. The model has no wait distribution. | Record request, refusal, wait entry/exit, grant, cancellation and task switching by unit and phase. |
| Repair and compute spend | Choose acceptable added tokens, dollars and runner minutes, or a value exchange against saved idle minutes. No zero-increase rule is justified. | Price every attempt, cached tokens, provider tariffs, service bills and retries per accepted task. |
| Human intervention and correctness | Choose acceptable human minutes/actions and an allowed rise, if any, in failed checks and reverts. Model prices neither. | Record human actions/minutes, checked merged trees, lost edits, failures, reverts and protected-asset violations. |

A fair current-agent comparison would keep task bundles, landing checks, review rules and protected-asset checks fixed while changing writing exclusion, and retain unsuccessful chains. Choose the primary accepted-task outcome and the owner's smallest worthwhile gain first. Plan sample size from pilot variation; report uncertainty by repository and issue family (related tasks), including an analysis without research-tools. An uncertainty interval around gain—a range of values consistent with the sample—should exclude zero before claiming improvement. Excluding zero is an **evidence rule**; the smallest worthwhile gain is a separate **value choice**. Requiring the interval to exceed that gain would be stricter and need a larger study. For costs, human effort, failed checks and reverts, the owner should first set acceptable increases (**margins**). If an interval cannot rule out an increase beyond a margin, the result is **inconclusive** and does not support a general default change. Inconclusive is not proof of no increase. Safety rules such as fenced publication need direct checks even if a small sample has no failures. **Capability dependent:** current agents' repair speed and response to signals showing another active writer (presence signals) require a separately approved trial.

The next collection should link task, issue family, run, unit and revision across claim request/grant/refusal, first edit, first publication, writing-hold release, review, queue, conflict, repair start/finish, human action and accepted land. Inventory existing event fields and report missing coverage by repository and phase before computing wait. Capture frozen path declarations, discovered files, grow requests and scope refusals; include abandoned and undiffable work so accepted diffs do not hide misses. Reconstruct only what each writer knew at task arrival, then build and check proposed merged trees. **Structural:** final changed-file replays cannot recover missing event times or agent behavior.

## For engineers

Run the Python cost model with bytecode writing disabled from the checkout root. It writes only the output text and scenario CSV beside the script. The output includes coverage, states, token medians, repair-label breakdown and assumptions. Local sources read: *Our measured usage*, *Declared and actual worker footprints* and its raw output, *Larger lock-scheme replay* and its raw output, and *Concord v3: claim and lease options*. No web source or new agent run was used.

## Review ledger

Each finding is fixed in the named section. A corrected gap states how to gather evidence; it does not claim that evidence now exists. Related findings share repairs.

| Finding | Disposition and location |
|---|---|
| O1 | fixed — Cost model and gain bars: throughput, candidate choices and wait thresholds; see R2. |
| O2 | fixed — Decision and measurement plan: four owner values and measurements. |
| O3 | fixed — Decision and measurement plan: cost margins and inconclusive rule. |
| O4 | fixed — Cost model: separate encounter rates and exclusive repair; see R1. |
| O5 | fixed — What was measured: review exclusion, label breakdown and rebase proxy. |
| O6 | fixed — Plain answer, worked example, definitions and engineering appendix; see R7. |
| O7 | fixed — What was measured and script: older run layout and untimed coverage. |
| O8 | fixed — Waiting and dollars and script: object-form dollar costs, empty tariffs. |
| O9 | fixed — Waiting and dollars: lease events, retry caveat and audit path. |
| O10 | fixed — Cost model and CSV: union-log case and safety caveat. |
| O11 | fixed — Plain answer and replay: advantage comes from model scenarios. |
| O12 | fixed — Waiting and dollars: service requests excluded from claim cost. |
| O13 | fixed — Script output and shipped CSV: source names and percentage gains. |
| R1 | fixed — Alternatives and Cost model: exclusive post-publication repair. |
| R2 | fixed — Cost model and gain bars: no asserted 15% bar; correct target formula. |
| R3 | fixed — What was measured: mixed-session medians are scenario proxies. |
| R4 | fixed — What was measured and script: exact classifier and kind search. |
| R5 | fixed — Replay paragraph: later creation to earlier merge. |
| R6 | fixed — Waiting and dollars: script does not extract lease waits. |
| R7 | fixed — Plain answer, alternatives and measurement plan: terms in words. |
