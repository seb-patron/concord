# Who may work on an issue?

**Research note, 2026-10-15.** This compares ways to prevent duplicate task work while keeping Concord's exclusive protection for code. It selects no product policy. The owner already approved the research and test spikes on 2026-10-15. A later live-agent pilot needs separate approval.

## Plain summary

An **issue** describes a task; a **change** proposes a code revision linked to it. A **code-unit lease** temporarily permits one agent to write a protected file, row or symbol. A proposed **issue work claim** would reserve the task itself. Today two agents can read one issue, plan edits to different files and both start because their code scopes do not collide. Conversely, claiming an issue while its required code is busy can leave that task idle. I recommend testing one server transaction that grants the issue and all declared code units, or grants nothing.

The owner's Issues UI decision says **“assigned to” reflects agents holding live leases for the issue**. The [Issues-list design](../../ui.md) uses code leases on linked changes; expired leases do not count. No issue work claim shipped in the reviewed baseline. A proposed **planned owner** would be a separate durable accountability field, visible after claim expiry and advisory rather than a restriction on who may claim. The existing “assigned to” behavior remains the baseline ([Issues UI decision (D-GITHUB-UI)](../../decisions.md); [source notes](reads/c2a-issue-claims-notes.md)).

The owner approved exclusive code-unit leases ([exclusive-unit decision (D-UNIT-1-EXCLUSIVE)](../../decisions.md)), an issue-claim research spike ([issue-claim spike decision (D-ISSUE-CLAIM-SPIKE)](../../decisions.md)), and a declare, grow and verify plan ([scope-plan decision (D-LEASE-Q5-CPLUS)](../../decisions.md)). The last plan was approved but not fully built. Atomic issue-plus-code acquisition remains open. The supplied claims options report records a research-phase test-approval rule (D-RESEARCH-PHASE), whose entry is absent from this checkout's decisions file; the spike brief records the owner's later approval of research and test spikes.

## Glossary

| Term | Meaning |
|---|---|
| Planned owner | Lasting planning signal; it is not a work permission. |
| Issue work claim | Proposed temporary, exclusive right for one attempt to pursue an issue. |
| Code-unit lease | Temporary right to edit a protected file, row or symbol. |
| Run, intent, principal, revision | Run: one agent execution. Intent: stable task-attempt identity across restarted runs and replacement changes. Principal: authenticated account, possibly shared. Revision: one published version of a change. |
| Fence | Server generation number. A new grant or override increases it; stale holders fail protected operations. Renewal preserves it. Issue and code fences are separate. |
| Lifetime, heartbeat | Time until expiry; a heartbeat renews an active writing claim. |
| Writing hold, landing authorization | A writing hold excludes another code writer. At first publish, new writers may claim the unit, while the published revision retains nonblocking permission to enter the landing queue. |
| Declare, grow, reconcile | Predict code units at start; request newly discovered units mid-run; before publication, compare actual diff, acquire missing units and release unused units. |
| Wait line | First-in, first-out order for refused code requests. A position is not a lease. |

**Accepted land** means a reviewed and checked revision joined the repository. A **ready issue** has no unmet prerequisite. A failed or abandoned attempt still contributes to cost.

## Evidence and limits

The v2 issue-claim research found no issue-level uniqueness check: distinct changes could link one issue. Its duplicate episode came from one orchestrator restarting an issue, rather than independent agents choosing it. The history records six attempts for one issue, at least three replacement changes, a cancelled duplicate and fourteen code refusals against ten chains. These are episodes, not population rates. **STRUCTURAL (source date: 2026-10-13):** disjoint code scopes cannot prevent duplicate task work. **CAPABILITY-DEPENDENT (source date: 2026-10-13; re-test):** whether agents respond to assignments or notices.

The supplied claims options report separates approved plans from shipped behavior. Issue links remain metadata. The published-lease change (specification 181) made code writing holds stop blocking new writers after first publish, while retaining revision-specific landing authorization. Full declaration, mid-run growth, exact pre-publish reconciliation and the fair wait line did not all ship. Five minutes is a default code-lease direction, not an approved issue-claim lifetime ([five-minute code-lease decision (D-LEASE-5MIN-EXTEND)](../../decisions.md)). **Review waits in Concord's earlier version ran 3–218 minutes, median 37**: the [Opus review](/Users/sebastianpatronsoto/agent-runs/_manual/concord-specs/v3-reads/inputs/review-opus-109.md) gives those figures and cites the supplied claims options report, which attributes them to its renewal-history source. A five-minute writing claim cannot silently lapse during review.

Agent Mail's session-start macro reserves paths but may still grant conflicting reservations; local hooks can be bypassed. Its useful precedent is visible holder, expiry and audit. Its pattern-overlap misses, stale reads, orphan records and archive rollback are cautions. **STRUCTURAL (source date: 2026-10-15 read):** advisory presence is not server-enforced exclusion. Gas Town's durable tasks (“Beads”), task groups (“convoys”) and serial integrator (“Refinery”) use disposable sessions without reported file/symbol locks. Its 12–30-worker practice is not a controlled comparison (**CAPABILITY-DEPENDENT; article 2026-01-01, read 2026-10-15; re-test**).

The v2 lease research also describes a claim bot limiting one issue per user, a job queue stopping after three recoveries in 72 hours, an agent board with atomic claims and activity heartbeats, and Linear's separation of accountable assignee and acting agent. GitHub and Linear issue relations distinguish dependencies and grouping from assignment; neither supplies a work lock. These are precedents, not Concord outcome estimates. The [full-read notes](reads/c2a-issue-claims-notes.md) identify the supplied sources.

## Proposed lifecycle for exclusive issue claims

For the atomic and issue-first designs, a holder is an authenticated **principal plus stable intent**, with one active run session. Replacement changes and revisions are children. Principal alone collapses distinct agents sharing a token. These matching rules are proposals:

| Operation | Match and result |
|---|---|
| Retry | Same principal, intent, issue and request key returns current result without a second grant. A request key identifies one call across retries. |
| Renew writing | Same principal, intent, active run and fence; extend expiry without changing fence. |
| Resume crashed session | Authenticated replacement run under same principal and intent; server checks fence and issue version, records handoff and revokes old session. A lapsed claim needs a new grant and reconciliation. |
| Release or cancel | Current holder/fence or reasoned owner override ends issue attempt and its code writing leases together. |
| Publish or land | Current issue fence, acknowledged issue version, linked revision and every actual code-unit fence must match. A stale issue holder cannot publish or land. |

Simulation cap: one active issue per run, two across all sessions of one principal, with explicit owner exception. After three failed reclaims for one issue in 72 simulated hours, send it to human review. These are test parameters, not selected policy. A sensitivity arm keys ownership on principal alone to expose shared-token collapse.

| Event | Proposed effect |
|---|---|
| Start | Validate open issue/version; atomically grant issue and complete declared code set or nothing. Empty known set permits bounded investigation, but no protected edit until units are claimed. Unknown units must be declared within ten simulated minutes or release the issue. |
| Busy unit | Grant nothing. Automatically enqueue code request by default, with opt-out, under the owner's [automatic-enqueue decision (D-LEASE-QUEUE-AUTO)](../../decisions.md). A queued atomic request reserves **no** issue. On its turn, recheck issue and all units. |
| Grow | Request newly discovered units atomically; refusal preserves prior grants but forbids editing missing units. Build a wait graph. For crossed growth, youngest intent by original claim time yields, releases issue and writing units, keeps draft and retries behind older work. Ties use stable intent key; retry keeps original age. Atomic grant safety alone does not prevent deadlock. |
| Scope edit | Increment issue version and notify holder. Added units need growth. Removed unused units are released on reconciliation; a published revision keeps only its exact landing authorization. Changed completion criteria require acknowledgment before publish. |
| First publish | Before push, derive actual diff units; atomically acquire missing units, refuse without pushing if any are busy, release unused writing units, verify exact revision footprint and code fences. Move issue claim to a **server-held revision reservation**. The agent need not heartbeat through inspection, review and queue. Code writing holds become nonblocking revision-specific landing authorizations. |
| Review, queue, repair | Server holds issue reservation while exact revision remains in inspection, review or queue. At maximum age it cancels that reservation and revision authorization, releases the issue and alerts the owner, unless the owner explicitly extends it with reason before the deadline. Repair needs fresh code claims and issue-version acknowledgment; new revision replaces reservation. Eject/cancel releases reservation and invalidates issue fence. Idle worker cannot renew forever. |
| Accepted land | Holder's linked revision closes issue as normal completion; issue reservation and residual code authorizations end together. |
| Issue expiry, override or owner close | While writing, atomically increment issue fence, revoke that attempt's code writing leases and invalidate its published landing authorization; then a new holder may claim. Owner close also closes issue. Old draft stays readable but cannot publish/land. Published reservation does not silently lapse after five minutes; its maximum-age cancellation is a separate audited transition. |
| Code expiry first | Pause protected work; reacquire complete needed code set under current issue fence/version or release issue and other writing units. Cannot publish with expired code permission. |
| Reopen | Fresh issue generation; no old fence revives. Planned owner, if added, remains planning after close/reopen until changed; current live-lease “assigned to” display empties on close. |

The simulation varies server reservation maximum at 60, 120 and 240 minutes and includes an unsafe lapse-at-publish variant. The production maximum and whether the owner may extend it need a decision. Override never transfers old code leases, revision authorization or review verdict to a successor.

## Designs to compare

**Assignment only.** Proposed planned owner signals responsibility but neither expires nor blocks another run. Owner reassignment is versioned and audited. A crashed worker's planned owner remains until a human clears it. Code starts use common code rules. It survives close/reopen as a planning field, never a work grant. Existing “assigned to” remains based on live code leases.

**Atomic issue and code start — recommended first test.** One transaction grants issue and all known units, or none. A refusal joins the code wait line without issue reservation. Unknown scope follows bounded investigation. Current issue fence blocks a second task attempt even if planned files differ. Stable intent survives replacement change. This is research advice, not selected policy.

**Issue first, then code.** Claim issue before planning; after sampled planning delay request all code units at once. Immediate-release variant drops issue on code refusal; bounded-pending variant holds it for at most one writing lifetime. Neither retains partial code grants. A zero-delay immediate-release run should tie atomic start except when crash or concurrent call observes the two-call gap. Once writing begins, use common lifecycle.

**Claim derived from linked change.** A nonterminal linked change itself marks issue taken; **no separate issue work lease** exists. Creating linked change and code claims is atomic, but pre-change research is unprotected. Plain version lets idle draft hold indefinitely, with no renewal or automatic expiry. Closing draft before replacement creates gap for another author. Expiry variant ends claim when change's writing code leases expire; the worker renews code leases while writing, and after first publish its nonblocking landing authorization cannot represent exclusive issue ownership. Owner override closes the linked change with reason and audit, releasing its code leases; the old change cannot publish or land. These are measurable differences from atomic start. No issue-fence assertion applies.

**Advisory presence only.** Agent posts expiring “considering/working” signal; another may ignore it. This arm has no planned-owner field, separating it from assignment only. Owner may clear presence; issue close clears it automatically. Every code start retains exclusive unit claims. Signal response is **CAPABILITY-DEPENDENT (source date: 2026-10-15 read; re-test)**.

## Offline duplicate-work and hoarding simulation

This is a deterministic event-model plan, not output. The already approved research/test spike covers offline work; it does not authorize a live pilot or select policy. Use the supplied claims options report's owner-value frame: value accepted tasks and price idle agent time, duplicate work, repair, compute, tail wait, human intervention and lost accepted edits **before interpreting results**. Until the owner sets trade-offs and a minimum useful gain, report tables showing each measure and the trade-offs, not a winner.

### Primary result and preset decision rule

The sole primary result is **useful completed tasks per worker-hour from dispatch to accepted land**. Numerator: distinct issues whose accepted result lands by cutoff, counted once despite retries. Denominator: summed occupied worker minutes in planning, writing, waiting, repair, rework and idle commitment, divided by sixty. A worker released to other work stops consuming this workload's time; queued and abandoned attempts count until release. Report unfinished tasks and a longer-cutoff sensitivity run.

A design **wins** only if its paired-seed primary result beats the matched code-only baseline by at least the owner's prechosen minimum useful gain, its uncertainty interval excludes zero, duplicate-work and idle-issue minutes do not rise (zero loss tolerance unless the owner preapproves another tolerance), and all applicable safety assertions pass. It **loses** on safety violation, primary deficit beyond that threshold, or duplicate/idle loss beyond the preset tolerance. Otherwise it **ties or is inconclusive**. Apply the same rule between candidates. With owner values unset, label no policy winner; show thresholds where rankings change. This operationalizes the claims options report's decision-design section without inventing numeric approval.

### Arms and common code behavior

| Arm | Issue behavior | Code behavior |
|---|---|---|
| Historical v2 anchor | Links only. | Observed refuse/retry and first-publish phase change; no full grow or durable fair line. Hidden unit causes failed attempt or replacement after release. Descriptive only. |
| Matched code-only baseline | No issue claim or signal. | Same declaration, all-unit growth, automatic fair line, first-publish phase change and exact pre-publish reconciliation as candidates. Approved but unbuilt counterfactual, never called current. |
| Assignment only | Durable advisory planned owner. | Identical common code behavior. |
| Atomic start | Issue and code in one transaction. | Identical common code behavior. |
| Issue first: immediate release / bounded pending | Issue claim precedes code request by planning delay. | Identical common code behavior after start. |
| Change-link: plain / lease-ended | Ownership derives from active linked change. | Identical common code behavior. |
| Presence only | Advisory signal, no assignment. | Identical common code behavior. |

All causal arms share code-unit mapping, checker, queue events, actual diff, workload, worker slots and seeded draws. Model separate list, claim, code-request and link calls with declared call latency and races. If zero latency makes atomic and immediate-release issue-first indistinguishable, report tie. Include pre-change research so link-derived ownership differs from atomic start.

### Workload and event settings

Every value is a **synthetic assumption** saved with fixed seeds before running. Use at least thirty paired seeds per cell, show raw counts and across-seed intervals. No timing here estimates real agent performance.

| Setting | Base and sensitivity |
|---|---|
| Shape | Mostly disjoint, shared hot unit, mixed hidden scope. Base: 30 open issues, 60 code units as normalized by the server; vary 10/30/60 issues, 20/60/120 units, and 0%/25%/60% issues whose scopes overlap another. Construct overlap with fixed seeded mapping. |
| Per-attempt scope | Declarations belong to attempts, not issues. In 25% of competing same-issue attempts draw disjoint declared and actual units; another 10% start with no known units and discover later. Future actual units stay hidden from selection. |
| Arrival and capacity | Base five slots, five arrivals/hour plus two unrelated background starts/hour; vary two/five/ten slots and light/equal/twice-capacity arrival. Burst of five only with five slots; excess wait in two-slot case. Worker takes next issue after release/completion until eight-hour cutoff. |
| Durations and races | One agent model/tool planning call takes 0/30/120 seconds between an issue-first claim and its code request; writing takes 10/30/90 minutes. Server call delay is 0/0.2/2 seconds; list-to-claim race is 0/2/10 seconds. Same sampled work for each attempt across arms. These calls create observable two-call gaps. |
| Selection | Separate oldest eligible; uniform random among five oldest; seeded worker-specific preference-spread ranking. Eligibility uses only visible event-time state. Skip known code-blocked issue under move-on policy; stale lists may still select it. Add orchestrator restart of same issue as fault. |
| Refusal | Base: automatically queue then move to another eligible issue while request waits without claim. On turn, revalidate; cancel if worker busy. Sensitivity: wait for same issue, occupying slot. Hold policy equal across arms. Later overlapping requests cannot bypass earlier compatible turn. |
| Advisory delay | Assignment/presence observed after 0/30/120 seconds. Report always-cooperative and signal-ignoring behavior; zero delay still is not a lock. |
| Hidden need and grow | Reveal at 25%/50%/75% of writing; 0%/10%/25% of attempts have extra need. Crossed requests block when each needs another's writing unit; youngest original intent yields/releases and retries with stable age. Published landing holds do not block. |
| Publish and review | Draw total coding time, then first publish after 40%/70%/90% of it; any remaining coding time occurs only after review feedback. Vary chance of feedback/repair at 0%/25%/50%; with no feedback, discard the unused remaining coding-time draw equally in every arm. Model inspection, review and queue separately: base 10/37/60 minutes, sensitivity including 3 and 218. Accepted land only completion. Repair returns to writing with fresh claims. Compare server reservation with five-minute lapse-at-publish fault. |
| Stale state | Human clears crashed planned owner after 15/60/240 minutes. Provisional writing issue lifetime five minutes, heartbeat each third. Published reservation maximum 60/120/240 minutes with escalation, not silent renewal. |

“Eligible” means open, prerequisite-ready and visibly unclaimed in exclusive arms; code blockage is checked after selection, never using future scope. Preserve the first-publish transition: code writing exclusion ends, exact revision authorization remains. Count concurrent duplicate starts and sequential reimplementation after crash/expiry.

### Metrics and fault expectations

Secondary metrics: **duplicate useful-work minutes** = planning/writing for a losing attempt or completed issue, including sequential rework; **idle-issue minutes** = ready issue with demand but no productive holder because claim/assignment deters start, with code-blocked time separate; **hoarded claim minutes** = exclusive issue held more than one writing lifetime without planning, writing, inspection, review or queue transition; **recovery time** = failure/override to successor's first productive work; **starvation** = demanded ready issue never started before cutoff. Also report arrival-to-start, start-to-land, issue/code wait, median and 95th-percentile waits, refusal, partial grant, abandoned attempt, failed check, human action and compute. Specifically count **overprediction cost** as unused-unit writing-hold minutes until pre-publish release, and **missing-unit cost** as grow wait plus failed pre-publish reconciliation and retry minutes. Renewal alone is not progress. If successor reuses reviewed artifact, subtract reused work from duplicate minutes but include review/repair; show zero-reuse and full-reuse bounds. Include failures and unfinished work.

| Injected case | Code-only, assignment, presence | Atomic and issue-first | Change-link derived |
|---|---|---|---|
| Busy unit, partial grant, exact diff, stale code fence | Common code rules reject unclaimed publish and partial grants; historical anchor follows observed behavior. | Same. | Same. |
| Two starts on one issue with disjoint code | Permitted; cooperative signal may reduce starts. | At most one current issue fence; pending gap observable. | One linked active change while present, but pre-change/replacement gaps may duplicate. |
| Issue expiry/override, stale publish/land, close/reopen | No issue-fence assertion. | Paired revocation; stale operations rejected; reopen fresh generation. | No issue-fence assertion; measure duplicate window. |
| Retry, crash between calls, crossed growth | Repeated code request returns the same result; youngest grow waiter yields. | Repeated issue request returns same result, no partial grants; pending expires; youngest yields. | Repeated link request returns same result; draft hoarding and replacement gap observed; youngest yields. |
| Publish, long review, cancellation | Revision-bound code landing authorization. | Server reservation holds through review/queue; cancellation releases; lapse fault admits duplicate. | Plain draft may hoard; lease-ended version may duplicate after code hold ends. |

Safety assertions are deterministic state-machine checks, not empirical zero-incident estimates. Only atomic and issue-first arms assert exclusive issue-fence safety. Inject crashes before/after claim, publish, renewal and override; partition across expiry; stale resume; duplicate request; version edit; cancel; and one principal opening many sessions. The historical anchor's missing grow is an observed behavior difference, not a common-code invariant.

Synthetic runs test protocol consistency and mechanical costs, not whether present agents notice signals, choose another task or reuse work. Those are **CAPABILITY-DEPENDENT (source date: 2026-10-15; re-test in an approved pilot)**. Report by named workload shape, not an invented repository rate.

## Decisions still for the owner

Research/test spikes were already approved. These answers are recommendations, not recorded policy.

1. **Display and planning.** Keep “assigned to” tied to live code leases on linked changes. Add separate durable planned-owner field if accountability after expiry is desired; it does not restrict claims. Decide whether issue holder needs its own badge. Earlier assignment-plus-lease recommendation was research, not approval.
2. **Eligibility and override.** Let eligible agents claim open work regardless of planned owner. Only authorized person may force reassignment with reason and audit. Parallel contest work is outside these arms and needs separate contract.
3. **Busy/unknown scope.** Prefer atomic start, no issue reservation during code wait, bounded investigation. Automatic enqueue is already decided; grant protocol remains separate.
4. **Lifetime.** Prefer renewable short writing claim and server-held revision reservation through review/queue. Choose production maximum age and whether an owner can extend it with a recorded reason.
5. **First shipping slice.** If atomic start chosen, ship holder identity, all-or-nothing acquisition, paired release/override, publish/land fence checks and visible states before sophisticated scheduling.
6. **Owner values.** Set minimum useful gain and tolerable duplicate, idle, tail-wait, compute and human-intervention cost before reading simulation outcomes.
7. **Later pilot.** Decide separately whether to authorize bounded live-agent pilot, its repositories/issues and spend cap. The supplied options report cites research-phase decision (D-RESEARCH-PHASE); its entry is absent here.

## Sources and scope

The [full-read source notes](reads/c2a-issue-claims-notes.md) cover the supplied claims options report; v2 issue-claim, issue-lease and lease-decision histories; Agent Mail implementation notes; Gas Town notes; and GitHub/Linear agent notes. The [Opus review](/Users/sebastianpatronsoto/agent-runs/_manual/concord-specs/v3-reads/inputs/review-opus-109.md) supplies review-wait figures and names their underlying renewal-history source; the [Astra review](/Users/sebastianpatronsoto/agent-runs/_manual/concord-specs/v3-reads/inputs/review-astra-109.md) supplies independent critiques. No web source was fetched, simulation run or live pilot performed for this report. Collaborative editing of issue text is separate.

The decisions-list command could not run because `tsx` is absent; its “Approved but not live” list was unavailable. Decision status uses local decision text and supplied reports, not a successful live-status check. Publication dates include Gas Town's 2026-01-01 article and a 2020-03-04 Linear changelog; local reads were 2026-10-15.

## Review ledger

Overlapping findings share repairs. Each finding is marked fixed; no product policy is claimed as approved.

| Finding | Resolution |
|---|---|
| O1 | Fixed in “Primary result and preset decision rule”; owner values in “Decisions still for the owner.” |
| O2 | Fixed in “Arms and common code behavior”: matched code-only baseline and historical anchor. |
| O3 | Fixed in “Designs to compare” and “Workload and event settings”: planning gap, call races, derived link, expected tie. |
| O4 | Fixed in “Workload and event settings”: selection, refusal, backlog, delays, publish and crossed growth. |
| O5 | Fixed in “Proposed lifecycle” and fault table: server reservation through review and lapse variant. |
| O6 | Fixed in “Plain summary” and source notes, “Claims options report”: correct UI interpretation/provenance. |
| O7 | Fixed in “Plain summary,” “Designs to compare” and owner questions: separate advisory planned owner. |
| O8 | Fixed in opening and owner questions: prior research approval, later pilot only. |
| O9 | Fixed in “Proposed lifecycle” and fault table: paired revocation and issue-fence checks. |
| O10 | Fixed in “Proposed lifecycle” and arms: holder matching, principal cap, shared-token variant. |
| O11 | Fixed in “Designs to compare”: true change-link claim, replacement gap and draft hoarding. |
| O12 | Fixed in “Proposed lifecycle”: automatic queue without issue reservation, youngest yield, unknown scope. |
| O13 | Fixed in “Metrics and fault expectations” and workload table: definitions, arm applicability and seeds. |
| O14 | Fixed in “Plain summary” and “Glossary”: example and definitions. |
| O15 | Fixed throughout body: descriptive design names and named decision/specification references. |
| O16 | Fixed in “Sources and scope”: missing command dependency moved after summary. |
| O17 | Fixed in “Evidence and limits” and “Sources and scope”: dated and qualified evidence labels. |
| O18 | Fixed in “Plain summary,” “Evidence and limits” and arm table: approved plan versus shipped behavior. |
| O19 | Fixed in source notes: issue-claim, issue-leases, Agent Mail, Gas Town and tracker source locations. |
| O20 | Fixed in “Evidence and limits,” “Proposed lifecycle” and workload table: precedents and reclaim cap. |
| O21 | Fixed in “Proposed lifecycle” and “Assignment only”: land, close, removed units, reopen. |
| O22 | Fixed in owner question “First shipping slice.” |
| O23 | Fixed in “Advisory presence only” and rewritten workload table. |
| F01 | Fixed in “Plain summary,” owner questions and source notes: UI and planned-owner model. |
| F02 | Fixed in “Claim derived from linked change” and arms: pre-change and replacement phases. |
| F03 | Fixed in “Proposed lifecycle”: paired resources, renewal and review responsibility. |
| F04 | Fixed in lifecycle grow row and workload table: crossed-growth yield and stable age. |
| F05 | Fixed in lifecycle publish row and “Metrics and fault expectations”: pre-push reconciliation and costs. |
| F06 | Fixed in “Workload and event settings”: per-attempt scope, disjoint duplicates and capacity. |
| F07 | Fixed in “Arms and common code behavior” and fault table: matched rules and assertions. |
| F08 | Fixed in “Primary result and preset decision rule” and metrics: cutoff, recovery credit and trade-offs. |
| F09 | Fixed in “Plain summary,” “Evidence and limits” and source notes: named references/provenance. |
| F10 | Fixed in “Plain summary,” “Glossary” and simplified simulation language. |
| F11 | Fixed in source notes, “Agent and tracker notes” and “Reading limits and provenance”; report “Sources and scope.” |
