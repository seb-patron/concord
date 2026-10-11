# Concord judging map

The supplied competition brief gives three criteria, each scored 1–5: originality and prototype quality **50%**, multi-agent concurrency/coordination/context/review/conflict handling **25%**, and ease of use/product UX **25%**. The weighted score is `0.50 × originality + 0.25 × coordination + 0.25 × UX`, still on a 1–5 scale. This is an evidence plan, not a self-assigned score or a claim about an implemented product.

## Feature-to-evidence map

Every planned feature below has an explicit contribution to all three criteria. “Supporting” means necessary credibility rather than the main novelty claim. Scene times refer to [the nine-minute script](DEMO.md); implementation ownership refers to [the slice index](specs/README.md).

| Feature / slice | Originality + quality (50%) | Coordination + context (25%) | Ease / UX (25%) | Evidence a judge sees |
| --- | --- | --- | --- | --- |
| Workers + Artifacts repo hosting / 01–02 | Supporting: coherent runnable git platform on required infrastructure | Shared canonical Git history for the fleet | Familiar clone/fetch and clear repository page | Final minute: deployed Worker URL, Artifacts repo metadata, Git-fetched canonical SHA equal to UI; clean-clone runbook |
| Fork-backed candidate branches and changes / 02 | Change is intent plus evidence, beyond a commit-only PR | Agents write isolated candidates; immutable published revisions | One change page replaces scattered branch/review state | 2:00: three real fork heads, common base, change URLs, versioned history |
| Semantic unit leases / 03 | Primary thesis: arbitrate meaning before edits collide | Atomic overlap refusal while distinct rows in one file coexist | Claim error names holder, intent, expiry, and next action | 1:00: two concurrent alpha claims yield one grant/one 409; gamma/delta continue |
| Lease fencing and intent history / 03 | Prototype correctness includes stale-worker handling | Expired workers cannot retain ownership; handoff context survives | Human-readable intent and countdown, history link | Lease card and local expiry/reacquisition test output in repo; no throughput claim |
| Checker-arbitrated speculative stacking / 04–05 | Acceptance uses exact composed content and machine-checkable done | Concurrent candidates checked together; only green stack lands | Queue shows membership, progress, result, and canonical tip | 2:00–4:00: real composed tree, red check, later green A+C and actual main readback |
| Bisection with interaction/dependency limits / 04 | Failure explanation is evidence-based, not blanket blame | One reproduced bad change stops; unrelated work can continue | Clear culprit/set and repair action | 3:00: split tree and singleton B failure; repository tests show interaction => blocked set, not false culprit |
| Trusted TSV row composition / 05 | Narrow semantic merge prototype works on a real shared table | Disjoint row edits survive same-file overlap | No manual conflict editor for unrelated rows | Show A/C deltas in families.tsv and merged table; same-row divergent test refuses |
| Score-based candidate arbitration / 04 | Explicit acceptance/quality policy chooses one candidate for a unit | Alternatives share one intent/reservation; only winner is queued | Winner card explains score and tie policy | 6:00: epsilon 2/4 vs 4/4 on same profile; labelled synthetic quality, not private byte-match performance |
| Local checker-runner protocol / 05 | Real compilers/checkers can remain outside Workers | Fenced jobs, heartbeat, result identity, and retry preserve correctness | Runner online/offline state and bounded logs | Job details: exact OIDs, checker/oracle/environment pins, real output; timeout/duplicate tests in repo |
| Persistent findings ledger / 06 | Review state survives source movement and revisions | One repair must cover every open finding; one independent delta review | Stable finding IDs and “2 unresolved” instead of manual ledgers | 4:00: incomplete repair 409, both open; complete round resolves only after reviewer evidence |
| Content-bound verdict carry / 07 | Review identity follows content and declared dependencies | Mechanical base movement can preserve review context | Parent verdict and delta evidence are visible | 5:00: different commit IDs, equal manifests, delta-check result, carried approval, then full stack check |
| Conservative carry invalidation / 07 | Quality claim has a visible failure boundary | Changed dependency or new finding cannot reuse approval | Specific reason explains why review is required | 6:00: beta dependency changes; H's old approval cannot land it |
| Fleet web UI / 08 | Supporting: prototype is operable, not only an API diagram | One view connects agents, leases, changes, checkers, and preserved review | Main UX evidence: keyboard access, clear blocked state, stable live updates | UI visible throughout; 8:00 walkthrough links actual evidence rather than success-only screenshots |
| Agent CLI / 09 | Agent-first structured interface to the collaboration model | Stable IDs/versions/idempotency avoid retry drift | JSON output, useful exit codes, standard local Git | Terminal commands, structured lease conflict, manifest with real IDs; documented clean-clone instructions |
| AW mock and intent-keyed dedupe / 10 | Supporting: credible migration boundary from a launcher | Seven retries and base changes still produce one task/change | Existing task concept maps to one Concord URL | 7:00: seven attempts, one active ID, awaiting independent review; clearly marked mock |
| Historical replay / 11 | Evidence discipline strengthens the prototype claim | Real timelines expose wait/check/conflict costs; simulation is qualified | Measured/simulated/unavailable labels are readable | 7:00 approved provenance-bearing report, or honest unavailable panel; no invented percentage saved |
| Owned synthetic repo and real checker / 12 | Reproducible prototype with inspectable correctness oracle | All visible queue outcomes come from actual checks | One seed and deterministic scene commands | Public table/checker/goldens, manifest, fresh local run; no proprietary inputs needed |
| Auth and canonical protection / 01–05 | Supporting: plausible platform boundary | Separate author/reviewer/checker/promoter roles; agents cannot write canonical | Viewer mode and actionable authorization errors | Candidate fork vs canonical write scope in runbook, self-review/stale-push rejection tests; never display secrets |
| Minimal environment/flake handling / 04–05 | Supporting: prototype does not equate flaky green with correctness | ENV_ERROR differs from product failure; inconsistent retry blocks | Clear offline/suspected-flake explanation | Job outcome schema and tests; optional short offline screenshot, no claimed statistical classifier |
| One-way GitHub mirror / 12 | Supporting: human compatibility without moving authority | Canonical SHA exported after confirmed landing; no reverse race | Humans can inspect an ordinary repository | Optional source/destination SHA equality, or labelled dry run; not required for core demo |
| Offline fake, real local gate, deployment package / 01,12 | Quality: implementation is reproducible without an account | Deterministic tests cover races/retries separately from cloud smoke | Documented first run and explicit backend mode | `sh scripts/validate.sh` output, run instructions, live Artifacts smoke evidence when provisioned |

## Narrative priority

Spend the first four minutes proving the thesis: an early semantic refusal followed by concurrent shared-file work, a real failed stack, an isolated bad candidate, and a checked survivor landing. The next three minutes prove context: findings persist, carry is earned, unsafe carry is refused, and a checker can arbitrate alternatives. Use the final two minutes to make adoption and reproduction credible through the mock adapter, UI, evidence provenance, and platform proof.

The supplied private-project numbers motivate design choices; they do not measure Concord. Decomp's checker statuses and mwcc-rs oracle pins inform the score protocol, but the public live repo is owned synthetic code. Do not imply the original compilers ran on Cloudflare or that production projects migrated.

## Evidence gates and honest gaps

| Gate | Passing evidence | If absent |
| --- | --- | --- |
| Required Cloudflare platform | A deployed Worker using real Artifacts plus one verified Git/check/promotion flow | Local rehearsal only; owner must resolve account/capability before claiming compliance |
| Open source | Public repo, MIT LICENSE, exact candidate SHA, clean-clone instructions | Submission bundle incomplete |
| No proprietary material | Original synthetic fixture/checker; numeric/anonymized decomp context; default C flag off | Remove unauthorized input; owner decides any future C sample separately |
| Concurrent behavior | Simultaneous claim requests and distinct agents with overlapping work lifetimes; event timestamps | Do not call a purely sequential scripted edit “concurrent” |
| Correctness under failure | Real red result, diagnostic evidence, refused unsafe carry, unresolved-repair rejection | Do not substitute a narrated happy path |
| Performance claim | Comparable recorded cohort/window with provenance; simulations labelled and assumptions shown | Omit improvement claims; missing is not zero |
| UX | One viewer can follow a change from intent through findings/checks to canonical history and reproduce commands | Prioritize UI repair over extra metrics or animations |
| Video | 5–10 minute exported video with legible screens and links matching reviewed code | Recut/re-record before owner submission |

No predicted judging score is assigned. General semantic parsers, statistical flake classification, full GitHub parity, and real AW integration are cut features. The [cut list](specs/README.md#cut-list) keeps scope and claims aligned with what the judge can actually see.
