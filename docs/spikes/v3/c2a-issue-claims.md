> `$ npm run -s decisions`
> `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from the repository root.`
> `Approved but not live: unavailable; the command exited before producing its decisions list.`

# Issue claims and declared code leases

**Research note — 2026-10-15**  
**Decision status:** comparison for the owner; no policy or experiment is approved by this document. The recorded Issues UI decision says “assigned to” reflects the agent or agents holding the issue lease (D-GITHUB-UI). Candidate A below is therefore a research control, not a proposal to change that display rule.

## Summary and recommendation

An expiring issue work lease says which run may pursue a task now; a code-unit lease authorizes writes to specific files, rows or symbols. A change-to-issue link is only a relationship unless the server defines claim semantics. A separate durable planning assignment is possible, but the recorded Issues UI decision currently maps “assigned to” to issue-lease holders.

The conservative candidate is a **combined atomic start**: a worker asks for one open issue and its declared units together. The server grants the issue and every unit, or none. A busy unit leaves no issue claim or partial code lease. The issue claim prevents duplicate starts; unit leases protect code. Treat declarations as versioned predictions, not proof of the diff. On discovery, allow an all-or-nothing scope grow under the same intent; if a new unit is busy, preserve prior claims but refuse protected work or queue the complete grow. At publication, verify the diff against current fences.

This is a research recommendation, not selected policy. The record requires exclusive unit leases (D-UNIT-1-EXCLUSIVE) and issue-claim research (D-ISSUE-CLAIM-SPIKE), while leaving lifecycle and atomic issue-plus-code acquisition open. V2 research proposed assignment plus a lease and declare/grow/verify; neither approves this transaction. A separate approval is required before live-agent or spend work (D-RESEARCH-PHASE).

The comparison is whether exclusive issue ownership saves duplicate effort without leaving issues idle when required code is busy. It must not replace unit protection. Keep assignment visible after expiry and limit each worker's active claims.

**Evidence labels.** STRUCTURAL findings describe protocol boundaries. CAPABILITY-DEPENDENT findings must be re-tested with current agents. Sources are dated 2026-10-13 to 2026-10-15; historical counts are not population rates, and simulation inputs are assumptions.

## What “claim” means

Three concepts should have distinct names and user-visible state:

| Term | Promise | Lifetime and authority |
|---|---|---|
| Assignment | A durable planning signal: “expected owner.” | No expiry by itself; does not authorize work or block another worker. |
| Issue work lease | One run temporarily owns the attempt to do an issue. | Expires without renewal, carries a fencing token, and is checked at start, change-link and lifecycle transitions. |
| Code-unit lease | One run may write a protected code unit. | Exclusive under the current decision; checked against the actual published diff and the holder's fence. |

Assignment maps well to GitHub's assignee field: it identifies responsibility, may be set by a person or integration, and is not an expiring distributed lock. Linear similarly has assignee and workflow status; starting unassigned work can auto-assign the acting user. That convenience is a status/assignment rule, not proof that a worker remains alive or that another agent cannot start. These descriptions come from the full-read v2 issue-claim report (“Prior art and what transfers”), reviewed 2026-10-13. **STRUCTURAL (source date: 2026-10-13):** neither durable assignment nor a status label supplies TTL recovery or code-write authority.

An issue link is also not a claim. In the v2 snapshot, distinct active changes could link one open issue; a unit conflict only surfaced when their protected code scopes overlapped. The newer v3 options report states that issue links remain metadata and no atomic issue-plus-unit start shipped in the reviewed baseline (“0. V2 baseline, decisions and delivery,” 2026-10-15). Two agents can therefore duplicate work on different files without any unit conflict. **STRUCTURAL (source date: 2026-10-15):** unit leases alone cannot prevent duplicated task effort when scopes do not overlap.

The recommended object identity is a run/session plus a stable issue intent and principal, with one or more replaceable changes attached to it. Principal alone is too broad when many agents share a token. Change alone is too narrow when an attempt is replaced. Renew, release and override must compare the current fence; renewal should not invalidate the holder's own current fence. An issue fence and code-unit fences are separate namespaces. Issue claim tokens must never be passed as proof of a code write.

## What prior systems show

### Concord v2: issue claims

The v2 issue-claim research (“What Concord does today,” “Failure cases with 10 concurrent workers,” and “Options,” 2026-10-13) found no issue-level assignee or lease in its inspected snapshot. A change's issue number was a link, and `concord start` claimed Allowed-file units without choosing an issue. Alternatives included assignment, a separate lease, atomic start, claim-next scheduling, pools and status-only. Its recommendation was to keep assignment as intent and add an issue lease alongside code-unit leases.

The same report warns that a held issue with busy units can strand work; it recommends all-unit acquisition or a bounded reservation. The issue-leases research (“Can an issue be a lease unit?”) explains why issue claims need separate state: unit overlap is path-based, queue fences must match verified writes, and existing claims are change-anchored. **STRUCTURAL (source date: 2026-10-13):** a task claim cannot grant source authorization.

The v3 options report corrects the historical baseline with the first-publish transition: a writing lease stops blocking new writers after initial publish, while its inspected revision retains nonblocking landing authorization (181, as summarized in “0. V2 baseline,” 2026-10-15). It distinguishes approved C+ declare/grow/verify from what actually shipped. Do not compare a proposed issue claim against an imagined v2 full-scope lock. Use the observed v2 issue-link behavior plus current exclusive unit claims as the baseline.

### Concord v2: code leases

The supplied issue and lease research traces duplicate starts, busy units, expiry and stale workers. The 2026-10-13 history records six attempts for one issue, at least three change replacements, a manually cancelled duplicate run, fourteen code-claim refusals against ten chains, and renewal/fence races. These are single episodes, not rates. The v3 options report notes an hour without queue landing and mutual waiting, short-notice expiries, inconsistent denominators and missing counterfactuals (“Measured v2 costs,” 2026-10-15).

The practical lesson is to keep issue attempt identity stable across replacement changes, make expiry and fencing explicit, and model duplicate starts separately from code overlap. Existing five-minute default unit-lease direction is a relevant precedent, not a settled issue-lease TTL (D-LEASE-5MIN-EXTEND). No issue-specific expiry duration is selected here. **STRUCTURAL (source date: 2026-10-15):** a stale worker must fail a server-side fence check after reassignment. **CAPABILITY-DEPENDENT (source date: 2026-10-13; re-test):** how much wasted work an agent can recover by rebasing or handing off context.

### Agent Mail

The Agent Mail implementation notes (pinned source and tests read 2026-10-15) describe project-scoped path reservations with holder, reason, mode, expiry and release state. A reservation can report conflict and still grant. Optional local Git hooks can block, but are bypassable. The notes identify uncertain overlap tests, reverse-glob misses, stale snapshots, orphan records, broad-glob cleanup cost, archive rollback and hook-chain risks.

For Concord, the transferable parts are visible holder/expiry/reason, auditable transitions, cleanup and useful diagnostics. Its advisory code reservation does not establish safe exclusion. **STRUCTURAL (source date: 2026-10-15):** an optional client hook cannot be the only server's correctness boundary. Concord should keep authoritative issue acquisition and unit acquisition in its coordinator and verify unit fences at publish/land.

### Gas Town

The supplied Gas Town blog note (“Welcome to Gas Town,” 2026-01-01; read date 2026-10-15) describes Beads work claims, dependency-ready tasks, convoys and durable state across disposable sessions. It reports no file or symbol locks. A Refinery serially merges and verifies, may reimplement work when the base moves, and watchdog agents nudge stuck workers. It accepts some repeated or lost work and reports 12–30 workers, without a controlled claim comparison.

This is precedent for issue-centric work selection and persistence, with a materially different integration model. Concord's server queue and code-unit leases can retain independent write safety. Do not infer that Gas Town proves either duplicate-free dispatch or that source locks are unnecessary. **CAPABILITY-DEPENDENT (source dates: 2026-01-01 and 2026-10-15 read; re-test):** reported scale, recovery and reimplementation costs.

### GitHub and Linear assignment and relations

The agents-notes input was read in full on 2026-10-15. GitHub's issue docs distinguish blocked-by/blocking dependencies from parent/sub-issue grouping and ordinary references; the REST and CLI expose relation changes in either direction. Linear's notes distinguish mutable parent/sub-issue hierarchy from project-level end-to-start dependencies. Neither relation system proves an issue is claimed by one worker or defines a Concord ready-set rule. The v2 issue-claim notes describe GitHub assignees as visible responsibility with no expiry and Linear as separate assignee/status fields, with an optional auto-assignment when moving unassigned work to a started state.

Concord can make the same semantic distinctions. Assignment, status, dependency, parent grouping and work lease are separate fields or relations. If assignment triggers work, that is an explicit dispatch policy layered on top. **STRUCTURAL (source date: 2026-10-15 read):** tracker relationships and assignee fields do not by themselves implement fencing, expiry or unit authorization. Whether an agent obeys a status/assignment signal is **CAPABILITY-DEPENDENT (source date: 2026-10-15; re-test).**

## Candidate designs

These five alternatives are for comparison. Issue close and declared-scope edits serialize against acquisition. Authorized close revokes with a reason/event; reopen allows a fresh claim, never restoring an old fence. Scope edits version the issue and notify its holder. Exclusive unit leases remain the baseline (D-UNIT-1-EXCLUSIVE).

### A. Assignment only, no work lease

- **Claim and override:** an owner assigns/reassigns; an agent can request assignment but not silently take another's. Owner changes are version-checked and audited.
- **Expiry and renewal:** assignment does not expire or renew. A human clears it. A workflow status may indicate “in progress,” but carries no authority.
- **Reassignment and issue changes:** reassignment changes the visible expected owner immediately. Edits notify the assigned worker. Close/reopen follow the common rules above.
- **Declared code units and busy rollback:** assignment does not obtain source units. A later start claims all requested units transactionally. If one is busy, no unit is granted; assignment remains visibly blocked. There is no issue claim to roll back.
- **Duplicate starts and hoarding:** does not prevent another run from starting the same issue, so it is a weak negative control. Add a configurable assignment cap only as a planning convention; it cannot stop unassigned work.

This cheap candidate does not prevent duplicate starts. It tests whether visibility alone changes agent behavior; any reduction is **CAPABILITY-DEPENDENT**.

### B. Atomic issue claim plus declared-unit start — recommended first candidate

- **Claim and override:** an eligible agent run claims one open, unclaimed issue and its full declared unit set in one server transaction. The holder is a run/session plus stable issue intent and principal; changes may be replaced under that intent. Owner may force-release/reassign with a reason, audit event and fence increment. Assignment remains a separate field.
- **Expiry and renewal:** issue and unit leases have server-clock expiries and separate fences; renewals require current holder/fence and preserve the fence. Use a parameterized short TTL; for the first simulation, use five minutes as an explicitly provisional scenario borrowed from current unit policy, heartbeat at one-third of TTL, and test missed renewals. This number is not approved for issue claims.
- **Reassignment and issue changes:** only after release, expiry or owner override can another run acquire. An edit to declared units increments issue version and emits a change event; the active holder must acknowledge/restart before claiming new scope. Close revokes live issue authority; reopen begins unclaimed.
- **Declared units and busy rollback:** validate the issue version and canonical units. Acquire all issue and code claims atomically. If one unit is busy, grant neither the issue claim nor any units; return all conflicts and optional FIFO queue position. No hidden partial reservation. During work, a discovered new unit is a versioned all-or-nothing grow request; refusal keeps prior grants, but the worker cannot publish protected changes outside them. At publish, derive and verify the actual diff units against current fences.
- **Duplicate starts and hoarding:** one active issue fence prevents another claim/start; repeated idempotency key by the same run returns the same grant. Enforce one active issue per run/session by default, with owner-configured exception for deliberate parallel subtasks. Expired/overridden work is visibly stale and must re-claim before protected progress.

This tests whether combined atomic start prevents duplicate effort and partial-lock hoarding. It has the strongest safety invariant but requires an atomic server operation. **STRUCTURAL (source date: 2026-10-15):** separate calls can strand half a claim after a crash.

### C. Separate issue lease, then atomic unit acquisition with bounded pending state

- **Claim and override:** an agent can claim an open issue before selecting or acquiring code units. One live claim per issue; only current holder renews/releases, owner override is reasoned and audited. Assignment remains independent.
- **Expiry and renewal:** same provisional five-minute issue TTL and one-third heartbeat in the simulation, with separate monotonic fence. No auto-extension merely because a process exists; renewal must report the active run.
- **Reassignment and issue changes:** release/expiry/override permits reassignment. A scope edit invalidates a pending unit plan and requires review against the new issue version. Close revokes, reopen starts fresh.
- **Declared units and busy rollback:** issue acquisition first creates a **pending** state with a short fixed reservation limit of one TTL. The agent attempts the complete declared unit set atomically. If units are busy, it either releases the issue immediately (C1) or keeps the pending issue claim only until that bounded deadline (C2); simulate both as distinct variants because C2 can reduce duplicate races but causes idle issues. Never retain a partial set of code units. At timeout, pending issue claim expires. After start, grow and publish checks match candidate B.
- **Duplicate starts and hoarding:** active issue lease prevents duplicate start. Limit one active issue per run/session; pending time counts against that limit. Display pending and blocked status, wait age and expiry. Apply FIFO to issue waiters only if no unit lock is being held while waiting.

C1 and C2 expose the rollback/idle trade-off and must remain separate arms. A pending lease is not proof that work started. **STRUCTURAL (source date: 2026-10-15):** holding an issue without usable code scope increases idle time.

### D. Claim derived from active change link

- **Claim and override:** atomically make the first eligible change linked to an open issue the issue holder. Another run's new linked change is rejected while a nonterminal linked attempt owns the claim. Owner may override/reassign with an audit event and fence bump. Do not key ownership by author alone.
- **Expiry and renewal:** the claim expires only when its linked run's issue lease expires; a draft change by itself never holds the issue forever. Use the same provisional TTL/heartbeat and stable issue intent as B. Change replacement under that intent preserves the lease; a new unrelated intent does not.
- **Reassignment and issue changes:** after lease expiry, close or owner override, another linked change can claim. Issue edits notify the linked run and version the declared scope. Close revokes and reopen creates a fresh claim opportunity.
- **Declared units and busy rollback:** change creation, issue-claim acquisition and all unit claims must be one transaction. If a unit is busy, reject change creation or leave only an unlinked draft; do not let an active link falsely imply ownership. Never grant a partial unit set. Grow and publish checks match B.
- **Duplicate starts and hoarding:** one live issue lease per issue blocks a second foreign change. Stable intent spans change retries. Cap one issue per run/session, and auto-release after lease expiry even if an abandoned draft remains.

This tests whether tying work to a change simplifies views or causes claim churn; research phases may have no change yet. Repeated replacements are **CAPABILITY-DEPENDENT (source date: 2026-10-13; re-test)**; a non-expiring draft hoarding an issue is **STRUCTURAL (source date: 2026-10-15)**.

### E. Advisory issue presence plus exclusive code-unit claims

- **Claim and override:** any authorized run can publish a time-limited “considering/working” presence record; it does not block another run. Owner can mark a preferred assignee or ask a holder to yield, but cannot treat presence as authority.
- **Expiry and renewal:** presence expires after the same provisional TTL and may renew; no fence is used as a grant. Stale presence is simply removed.
- **Reassignment and issue changes:** a new presence can supersede old presence. Issue edits notify all visible runs. Close removes presences; reopen permits new ones.
- **Declared units and busy rollback:** every start still acquires its full declared unit set atomically under existing exclusive policy. If any unit is busy, no units are held and the agent can wait or select other work. Mid-run grow is atomic; actual diff verification remains required. Presence never changes these rules.
- **Duplicate starts and hoarding:** does not prevent duplicate issue work; it provides a signal only. Cap one active presence per run or expire it quickly, but no cap can establish single ownership.

This is an advisory comparison for issue exclusion. Presence effectiveness is **CAPABILITY-DEPENDENT (source date: 2026-10-15; re-test)**; it does not guarantee unique starts.

## Offline duplicate and hoarding simulation plan

This is a design for a deterministic event simulation, not simulation code and not authorization to run a live pilot. It follows the supplied claims-options report’s sections “4. Stage-2 decision design” and “5. Open owner questions”: event-time knowledge only, synthetic arrival assumptions, uncensored scope demand, separated causal factors, explicit recovery metrics and an offline/live boundary. No source data currently provides per-agent arrival, true first-edit time, full discovered scope, or counterfactual repair time. Do not present a replay of declared footprints as measured lease benefit.

**Agents and arrivals.** Use 2, 5 and 10 worker slots per repository. These are scenario labels, not measured swarm sizes. Model each worker as one distinct run/session plus principal. Keep a separate shared-token variant to expose identity collapse. Simulate two arrival patterns: (1) uniform Poisson arrivals over an eight-hour synthetic workday and (2) a burst of five workers in 60 seconds followed by low background arrivals. Seed the event generator and publish seed, duration and all parameter tables. Use a fixed issue backlog with three declared scope sizes (1, 3 and 8 units), plus a mix of disjoint and overlapping actual scopes; these scope sizes are assumptions. Each issue has independent units and one “hidden need” fraction, initially test 0%, 10%, 25% as sensitivity assumptions. Worker service duration can use fixed 15-, 45- and 120-minute cases, with optional lognormal variation as a sensitivity, not claim it represents actual agent latency.

**Issue selection and duplicate policy.** Agents select the oldest eligible issue, breaking ties by a fixed issue number. A task instance is useful if one run reaches an accepted completion; concurrent attempts on the same issue count as duplicate work after the first attempt has acquired the issue or made progress, even when they touch different code. Include both “duplicate run started” and “duplicate useful-work minutes” so starting then quickly yielding differs from duplicating a full implementation. For A and E, use two documented agent policies: naive agents ignore advisory signals, and cooperative agents yield after observing an existing holder. The latter is a capability sensitivity, not an offline finding about current agents.

**Compare.** Baseline A0 is observed v2-style issue linkage with exclusive unit claims and current first-publish behavior, no issue work lease. Compare A, B, C1, C2, D and E. Do not pool C1/C2. Keep issue backlog, scope truth, worker capacities, queue policy, renewal schedule and arrival seed fixed across arms. To isolate the source of improvement, separately run assignment/presence off/on with the same lease behavior; do not bundle presence into B and attribute its effect to the issue lease. Candidate A and E are weaker policy controls; B, C and D test mutually exclusive issue-lease acquisition shapes.

**Fault cases.** Inject crashes before/after start, a partition across expiry, stale resume, same-key retry, new change under old intent, scope edits while pending/active, close/reopen racing with claim, override while paused, one busy declared unit, a busy hidden unit discovered mid-run, duplicate renewers, a worker renewing without progress, work longer than TTL, and one run claiming the backlog. Assert a single valid issue fence, stale-holder rejection, zero partial unit grants, distinct issue/code fences, fresh ownership after reopen, idempotency and audited override.

**Metrics.** Report by arm and repository: duplicate starts and useful-work minutes; completed tasks; idle issues/time; arrival-to-start and start-to-accepted-completion; issue versus code wait and p50/p95; leases without progress and hoarded lease-minutes; expiry/override/reassignment; partial-start attempts (zero expected for atomic arms); busy-unit failures and rollback; recovery time; hidden-scope grow delay; and starvation. Include failures and abandoned runs. Show raw counts and across-seed uncertainty; synthetic timings are not real timings.

**Analysis limits.** Use fixed seeds and sensitivity ranges; never generate load against the live service. Arrival/work durations are assumptions. A fixed schedule can test state-machine properties and bound mechanical costs, but cannot establish that agents notice signals, select other work or rebase. Those results are **CAPABILITY-DEPENDENT** and require an approved pilot. Historical attempts are too sparse and censored to calibrate universal distributions. Report by repository/workload shape.

## Open questions for the owner

These are open because the decision record and v2 research leave them unanswered. Recommended answers below are proposed starting points, not recorded owner decisions.

1. **Should Concord add a durable planned-owner field separate from “assigned to”?** The recorded UI decision maps “assigned to” to lease holders. Recommend defer a separate owner-intent field until there is a workflow that needs it; keep the issue lease as concurrency authority and allow explicit parallel/contest work by policy.
2. **Who may claim and override?** Recommend any eligible agent may atomically claim an unassigned open issue; an assignment to another worker requires that worker's release or an owner override. Only the owner can force-release/reassign, with reason, audit event and fence bump. Decide explicitly whether a team pool permits non-assignee claim.
3. **What should happen when declared code units are busy?** Recommend atomic all-or-nothing issue-plus-unit start and immediate rollback. Add a bounded pending-issue variant as a comparison arm, not default, because it can hoard an issue while waiting on code.
4. **What expiry and identity?** Recommend run/session plus stable issue intent, not shared principal alone or one disposable change ID. Start with a configurable short TTL; use five minutes only as a provisional test value borrowed from current unit policy. Renew with a stable fence, and prevent stale resumes by checking at every protected transition.
5. **How do issue edits and close/reopen interact with a live holder?** Recommend version every edit; declared-scope edits require holder acknowledgment or reacquisition. Authorized close revokes with an event and invalidates its fence. Reopen creates an unclaimed issue; never restore an old holder automatically.
6. **What hoarding limit and fairness policy?** Recommend one active issue lease per run/session, a bounded pending count of zero by default, FIFO waiters with no barging, and human-only override. Keep explicit multi-issue exceptions for an owner-directed run. Track renew-without-progress as a signal, but do not revoke on an unvalidated activity heuristic.
7. **Which stage-two work is approved?** Recommend first approve an offline data audit and deterministic simulation/fault matrix, then separately approve any live-agent trial, repositories and spend ceiling. The research-phase decision requires this approval; this document itself grants none (D-RESEARCH-PHASE).

## Sources and scope

The full-read notes are in `docs/spikes/v3/reads/c2a-issue-claims-notes.md`. Inputs were the supplied claims options report; Concord v2 issue-claim research and issue-leases HTML; Agent Mail implementation notes; Gas Town blog notes; and the agents notes containing GitHub and Linear issue relations. No web sources were fetched for this report. Issue-text collaborative editing (section locks, three-way merge or CRDT) is not selected here; it is a separate problem from assignment and issue work ownership. No simulation or live pilot was run, and no product behavior is changed by this research.
