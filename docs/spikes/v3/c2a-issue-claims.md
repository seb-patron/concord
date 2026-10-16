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
| Atomic transaction | One server step that grants every requested permission together or grants none. |
| Structural, capability-dependent | Structural means a consequence of the rule itself; capability-dependent means behavior may change as agents or their tools improve. |
| Nonterminal change | A change still open, under review, queued or in repair rather than completed or cancelled. |
| Paired seeds | Two designs face the same generated tasks and random timing draws, so their difference is less obscured by chance. A seed is the number that reproduces those draws. |
| Uncertainty interval | A range describing how much a measured difference could vary across repeated synthetic runs. It is not a promise about live agents. |
| Sensitivity | Rerunning the comparison after changing one assumption, such as how often issue scopes overlap. |
| Counterfactual | A comparison scenario that did not actually ship, used to isolate what a proposed change would cause. |
| Censored attempt | Work unfinished when the experiment stops; its effort still counts, but it is not treated as a completed issue or a known recovery duration. |

**Accepted land** means a reviewed and checked revision joined the repository. A **ready issue** has no unmet prerequisite. A failed or abandoned attempt still contributes to cost.

## Evidence and limits

The v2 issue-claim research found no issue-level uniqueness check: distinct changes could link one issue. Its duplicate episode came from one orchestrator restarting an issue, rather than independent agents choosing it. The history records six attempts for one issue, at least three replacement changes, a cancelled duplicate and fourteen code refusals against ten chains. These are episodes, not population rates. **STRUCTURAL (source date: 2026-10-13):** disjoint code scopes cannot prevent duplicate task work. **CAPABILITY-DEPENDENT (source date: 2026-10-13; re-test):** whether agents respond to assignments or notices.

The supplied claims options report separates approved plans from shipped behavior. Issue links remain metadata. The published-lease specification (181) made code writing holds stop blocking new writers after first publish, while retaining revision-specific landing authorization. Full declaration, mid-run growth, exact pre-publish reconciliation and the fair wait line did not all ship. Five minutes is a default code-lease direction, not an approved issue-claim lifetime ([five-minute code-lease decision (D-LEASE-5MIN-EXTEND)](../../decisions.md)). **Review waits in Concord's earlier version ran 3–218 minutes, median 37**: the [Opus review](/Users/sebastianpatronsoto/agent-runs/_manual/concord-specs/v3-reads/inputs/review-opus-109.md) gives those figures and cites the supplied claims options report, which attributes them to its renewal-history source. A five-minute writing claim cannot silently lapse during review.

Agent Mail can reserve paths at session start but may still grant conflicting reservations; optional local checks can be bypassed. Its useful precedent is visible holder, expiry and audit. Matching mistakes, out-of-date reads, reservations with no live owner, and failed rollback of archived records are cautions. **STRUCTURAL (source date: 2026-10-15 read):** advisory presence is not server-enforced exclusion. Gas Town's durable tasks (“Beads”), task groups (“convoys”) and serial integrator (“Refinery”) use disposable sessions without reported file/symbol locks. Its 12–30-worker practice is not a controlled comparison (**CAPABILITY-DEPENDENT; article 2026-01-01, read 2026-10-15; re-test**).

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

Simulation cap: one worker-managed writing, pending or repair issue per run, two across all sessions of one principal, with explicit owner exception. A server-held published reservation does not occupy that worker or count toward these worker-managed caps; its exact revision remains fenced. After three failed reclaims for one issue in 72 simulated hours, send it to human review. These are test parameters, not selected policy. A sensitivity arm keys ownership on principal alone to expose shared-token collapse.

| Event | Proposed effect |
|---|---|
| Start | Validate open issue/version; atomically grant issue and complete declared code set or nothing. Empty known set permits bounded investigation, but no protected edit until units are claimed. Unknown units must be declared within ten simulated minutes or release the issue. |
| Busy unit | Grant nothing. Automatically enqueue code request by default, with opt-out, under the owner's [automatic-enqueue decision (D-LEASE-QUEUE-AUTO)](../../decisions.md). A queued atomic request reserves **no** issue. On its turn, recheck issue and all units. |
| Grow | Request newly discovered units atomically; refusal preserves prior grants but forbids editing missing units. Build a wait graph. For crossed growth, youngest intent by original claim time yields, releases issue and writing units, keeps draft and retries behind older work. Ties use stable intent key; retry keeps original age. Atomic grant safety alone does not prevent deadlock. |
| Scope edit | Increment issue version and notify holder. Added units need growth. Removed unused units are released on reconciliation; a published revision keeps only its exact landing authorization. Changed completion criteria require acknowledgment before publish. |
| First publish | Before push, derive actual diff units; atomically acquire missing units, refuse without pushing if any are busy, release unused writing units, verify exact revision footprint and code fences. Move issue claim to a **server-held revision reservation**. The agent need not heartbeat through inspection, review and queue. Code writing holds become nonblocking revision-specific landing authorizations. |
| Review, queue, repair | Server holds issue reservation while exact revision remains in inspection, review or queue. At maximum age it cancels that reservation and revision authorization, releases the issue and alerts the owner, unless the owner explicitly extends it with reason before the deadline. Repair needs fresh code claims and issue-version acknowledgment; new revision replaces reservation. Eject/cancel releases reservation and invalidates issue fence. Idle worker cannot renew forever. |
| Accepted land | Holder's linked revision closes issue as normal completion; issue reservation and residual code authorizations end together. |
| Issue expiry, override or owner close | While writing, atomically increment issue fence, revoke that attempt's code writing leases and invalidate its published landing authorization. A successor may claim if the issue remains open, or after a separately recorded reopen following owner close. Old draft stays readable but cannot publish/land. Published reservation does not silently lapse after five minutes; its maximum-age cancellation is a separate audited transition. |
| Code expiry first | Pause protected work; reacquire complete needed code set under current issue fence/version or release issue and other writing units. Cannot publish with expired code permission. |
| Reopen | Fresh issue generation; no old fence revives. Planned owner, if added, remains planning after close/reopen until changed; current live-lease “assigned to” display empties on close. |

The simulation varies server reservation maximum at 60, 120 and 240 minutes and includes an unsafe lapse-at-publish variant. The production maximum and whether the owner may extend it need a decision. Override never transfers old code leases, revision authorization or review verdict to a successor.

An owner may override the holder, or close the issue, in **each** phase. The following transitions apply to the exclusive issue-claim designs; advisory and link-derived designs cancel their current change authorization and code leases in the same phase, but have no issue fence. Override means a fresh successor may pursue the still-open issue. Owner close means nobody may do so until a separately recorded reopen. In either case, the old attempt's issue fence becomes stale, its linked revision loses landing authorization, and current code writing leases are revoked. A successor must obtain its own issue and code grants, acknowledge the current issue version and earn its own review. A normal close caused by accepted land is a completion, not an override.

| Phase when owner acts | Old attempt and successor |
|---|---|
| Writing | Revoke issue fence and all writing code leases immediately; stop protected edits and reject old publish. A successor may claim only after override or reopen, with fresh grants. |
| Inspection | Cancel the exact published revision's landing authorization and server issue reservation, advance issue fence, and reject any pending inspection result. Any new writer takes fresh code leases; old inspection cannot authorize land. |
| Review | Cancel reservation, revision authorization and pending review result. A review already returned for the old revision cannot be reused. Successor starts its own revision and review. |
| Queue | Remove the old revision from the landing queue, cancel its authorization and reservation, advance the issue fence, and reject a late queue turn. Successor may enqueue only a newly checked revision. |
| Repair | Cancel the old reservation and revision authorization; revoke all fresh repair code leases, even if repair is partway through. Successor must obtain new code leases and cannot inherit repair progress as authority. |

The fence change and cancellation form one server transition, so a racing publish or land sees either the old authorized state before the owner action or the new rejected state afterward. A closed issue stays ineligible even if its old code leases have expired. On reopen it gets a new issue generation. Planned owner survives close and reopen as an advisory planning record unless the owner changes it; live “assigned to” empties when the live leases end. A published revision's long inspection or review does not occupy an agent, but its server-held issue reservation prevents a second exclusive claimant until land, cancellation or its recorded maximum age.

## Designs to compare

**Assignment only.** Proposed planned owner signals responsibility but neither expires nor blocks another run. Owner reassignment is versioned and audited. A crashed worker's planned owner remains until a human clears it. Code starts use common code rules. It survives close/reopen as a planning field, never a work grant. Existing “assigned to” remains based on live code leases.

**Atomic issue and code start — recommended first test.** One transaction grants issue and all known units, or none. A refusal joins the code wait line without issue reservation. Unknown scope follows bounded investigation. Current issue fence blocks a second task attempt even if planned files differ. Stable intent survives replacement change. This is research advice, not selected policy.

**Issue first, then code.** Claim issue before planning; after sampled planning delay request all code units at once. Immediate-release variant drops issue on code refusal; bounded-pending variant holds it for at most one writing lifetime. Neither retains partial code grants. A zero-delay immediate-release run should tie atomic start except when crash or concurrent call observes the two-call gap. Once writing begins, use common lifecycle.

**Claim derived from linked change.** A nonterminal linked change itself marks issue taken; **no separate issue work lease** exists. Creating linked change and code claims is atomic, but pre-change research is unprotected. Plain version lets idle draft hold indefinitely, with no renewal or automatic expiry. Closing draft before replacement creates gap for another author. Expiry variant ends claim when change's writing code leases expire; the worker renews code leases while writing, and after first publish its nonblocking landing authorization cannot represent exclusive issue ownership. Owner override closes the linked change with reason and audit, releasing its code leases; the old change cannot publish or land. These are measurable differences from atomic start. No issue-fence assertion applies.

**Advisory presence only.** Agent posts expiring “considering/working” signal; another may ignore it. This arm has no planned-owner field, separating it from assignment only. Owner may clear presence; issue close clears it automatically. Every code start retains exclusive unit claims. Signal response is **CAPABILITY-DEPENDENT (source date: 2026-10-15 read; re-test)**.

## Offline duplicate-work and hoarding simulation

The [executable simulation specification](c2a-sim-spec.md) freezes the synthetic work arrivals, worker capacity, code scopes, possible hidden work, publication and review times, random draws, refusal behavior, and fault checks. A separate worker can implement it without selecting a favorable workload. It compares each design with a **matched code-only baseline**: identical code protection and queue behavior, with no issue claim. The observed older Concord behavior is shown only as historical context, because its code rules differ. No simulation or live pilot was run for this report.

The one primary measure is **distinct accepted issues per occupied worker-hour**. Time spent planning, writing, blocked on a required claim, or repairing counts; a worker released after publication can take another issue while the server handles inspection, review and queue. A failed or unfinished attempt still consumes time. Secondary measures expose duplicate effort, idle issues, waiting, hoarded claims, recovery, unused code claims, extra discovered scope and human intervention. The specification treats work that is required from the start separately from work caused by review feedback: a proposed early publish cannot erase unfinished required work.

The comparison uses the same underlying work for each design. It reports how much the primary measure changes in each matched run and how uncertain that difference is. A safety failure disqualifies a design. A numerical winner requires an owner-set minimum useful improvement and acceptable losses in duplicate and idle time before outcomes are read; without those values the output is a table and threshold range, with no selected winner. Synthetic results cannot establish how current agents react to a signal or reuse a predecessor's work. Those behavioral questions require a separately approved pilot.

The fault checks cover two attempts with different files on one issue, a busy code unit, partial requests, crossed growth, crashes between calls, expired permissions, hidden required work, owner action during every phase, long review, repair and reopen. They check protocol behavior directly; an observed zero failure rate in a simulation is not proof of production safety.

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
