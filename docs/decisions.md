# Owner decisions — Concord

This file is the permanent record of Seb's (the owner's) decisions for Concord. Each decision has a stable ID. A chat, a worker or a reviewer must read this file before it asks the owner a question or changes a decided policy. Do not ask again about a decision in this file. A new decision gets a new entry; a changed decision gets a new dated entry that names the one it replaces.

Every entry has Date, Owner words, Decision, Status, and Source; older entries may include additional fields. Owner words are verbatim where recorded, with '[log paraphrase]' marking the few entries based on a paraphrase. Entries are appended in the order recorded (oldest first).

Seed written 2026-10-13 ~2:15 pm CT from an audit of memory/cloudflare-git-competition.md (M:line) and concord-specs/STATE.md (S:line), checked against concord-v2 main dcf31c4. Global standing rules (RE-2 one-shot repairs, worker routing, machine load, light mode, recording decisions) live in ~/.claude/CLAUDE.md and are not repeated here.

Liveness: `decision-status.tsv` has one row per ID: `id  check  argument  expected  next_action`. Checks are `file` (`path:regex`, matched against the file; expected `present` or `absent`), `route` (`METHOD /v1/path`, with `:r` matching any repo ID; expected `registered` or `absent`), `test` (a test file or test name must be present; the checker does not run tests), and `manual` (the expected column preserves free-text status). For manual rows, `next_action` controls the `Approved but not live` list: `None` (optionally followed by a period) means informational; any other value is an outstanding action. File, route and test checks are live when the recorded condition is present.

## D-DECISIONS-IN-GIT — Decisions live in source control, copied from decomp's system

- **Date (CT):** 2026-10-13 1:57-2:01 pm.
- **Owner's words:** "ok copy decomp and message aw about getting all other agents up to date on this better system and having aw build a blueprint so new repos can easily use this and 52 are top priority".
- **Decision:** concord-v2 gets docs/decisions.md, a status TSV, a live check and an AGENTS.md rule. AW rolls the system out to all projects and builds a blueprint for new repos. This and #1 are top priority.
- **What it changes:** Agents read decisions from the repo, not chat memory.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** IN FLIGHT. This audit seeds decisions-seed/decisions.md and decision-status.tsv. No docs/decisions.md on main.
- **Source:** M:240, S:575-576.

## D-LEASE-LANGUAGE-AGNOSTIC — One language-agnostic symbol-unit engine

- **Date (CT):** 2026-10-13 1:56 pm.
- **Owner's words:** "why c specific? what about all the other languages?".
- **Decision:** One symbol-unit engine (tree-sitter grammars: TS/JS, Python, Rust, C/C++, Go, Markdown) with line-range, then file, fallback; no per-language adapters.
- **What it changes:** Replaces per-repo adapters (D-LEASE-ADAPTERS).
- **Options not chosen:** per-language or per-repo adapters.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** IN FLIGHT. Decided 1:56 pm; respec only. No symbol, section or line units on main.
- **Source:** M:239.

## D-LEASE-UNPARK — Sub-file lease units are ship-list items, not parked

- **Date (CT):** 2026-10-13 1:54 pm.
- **Owner's words:** "why does a lease cover a whole file??? i already approved plans for something else".
- **Decision:** Markdown sections (#8), generated files (#9) and C units (#11) go back on the ship list, plus a new symbol-unit spec.
- **What it changes:** Undoes the 1:40 pm ship-list parking.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #8, #9, #11).
- **Audit (2026-10-13):** IN FLIGHT. Opus respec launched 1:54 pm. No worker yet. Main has no markdown-units or keyed-lines tests.
- **Source:** M:238, S:574.

## D-NUMBERING — Human-friendly numbers for changes, issues and milestones

- **Date (CT):** 2026-10-13 1:35 pm.
- **Owner's words:** "i feel like we should have a number system for PRs and issues and milestones etc ... we need to make the github/gitlab transition as smooth as possible".
- **Decision:** Per-repo numbers and #N references, and GitHub/GitLab imports keep their numbers.
- **What it changes:** PR-like change numbers.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** IN FLIGHT. Spike 46ojs41DWgME3J4KUy9QnG; spec wave2/s-numbering.md held for Seb's Q1-3. The spike recommends doing the GitHub/GitLab import (the part he asked for) after submission, against D-NO-DEFER.
- **Source:** M:237, S:572.

## D-LEASE-WAIT-LINE — Lease wait line plus human-only emergency controls

- **Date (CT):** 2026-10-13 1:29 pm.
- **Owner's words:** "I approve the wait line spike".
- **Decision:** Fair FIFO line for refused claims; human-only force-release, move-to-front and pause.
- **What it changes:** Swarms queue for units instead of failing; humans can intervene.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #16).
- **Audit (2026-10-13):** IN FLIGHT. Specs s16 and s16b written 1:45 pm (Opus, checked). s16 is queued after #1 and #50, s16b last, and nothing is launched. s16b says force-release needs Access login.
- **Source:** M:235, S:570.

## D-FREEZE-RESPEC — Scope freeze, respec, ship list

- **Date (CT):** 2026-10-13 1:29 pm.
- **Owner's words:** "yes do the freeze and respec, post the ship list. also add the bug fix for the change limit that motherbase has".
- **Decision:** Scope frozen to a ship list; every item respecced before launch; the MB change-limit fix is on it.
- **What it changes:** Launch order and gating.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** ship list 1:40 pm.
- **Audit (2026-10-13):** SHIPPED. Ship list written 1:40 pm (scratchpad reading/concord-ship-list.html). But its 'Parked (out of scope until submission)' section shelves approved items; see D-NO-DEFER.
- **Source:** M:235, S:565.

## D-SPEC-AND-CONCORD — Every piece of work has a proper spec and goes through Concord

- **Date (CT):** 2026-10-13 1:29 pm.
- **Owner's words:** "for this project add to memory every piece of work needs a proper spec and to go through concord".
- **Decision:** No worker launch without a spec checked against current main, with exact acceptance tests, interactions, and in/out of scope; every change lands through Concord.
- **What it changes:** Spec gate.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** process.
- **Audit (2026-10-13):** SHIPPED. In effect since 1:29 pm: s14, s16, s16b, s23, s24, s38, s48, s67 and s-numbering were Opus-drafted and checked. Before it, specs carried errors: the wrong digest claim (S:168), a wrong test requirement (S:195), '(new)' annotations (S:431), the wrong checkout claim (S:445).
- **Source:** M:236.

## D-START-OPUS — An Opus 5.5 subagent finishes #52 in one shot

- **Date (CT):** 2026-10-13 ~1:15 pm.
- **Owner's words:** "silly this is taking 6 repair rounds ... the workers and you are not properly checking the work. use an opus 5.5 subagent to get 52 done, it should one shot the change".
- **Decision:** An exception to light mode: an Opus subagent finishes #52, and the Codex 52-r6 run is cancelled.
- **What it changes:** Model routing for #1.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #1).
- **Audit (2026-10-13):** IN FLIGHT. Opus subagent running (scratchpad c52m-logs updated 1:58 pm).
- **Source:** M:234, S:564.

## D-CHANGE-LIMIT — Active-change limit configurable above 32; landed changes don't count

- **Date (CT):** 2026-10-13 ~1:10 pm.
- **Owner's words:** "this should be configurable beyond 32 for swarms (we will stay at 32 for now) and landed changes should not count against this".
- **Decision:** Landed changes become terminal (#43) as soon as possible. The active-change limit becomes configurable per repo (#51), with the default and Mother Base staying at 32.
- **What it changes:** Mother Base stops hitting CHANGE_LIMIT.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #43, #51).
- **Audit (2026-10-13):** IN FLIGHT. 90-r6 (#43) and 94-limit (#51) are running on SWE-2. Both reviews were blocked at 1:38-1:41 pm (vitest missing, no defect found) and are re-queued after #1. #43 had 3 earlier reviews with every property met, withheld on load timeouts.
- **Source:** M:232, S:563, S:568-569.

## D-SWE2-LUNA — SWE-2 implements and reviews; Codex Luna fallback; Sol only when needed

- **Date (CT):** 2026-10-13 12:50-1:10 pm.
- **Owner's words:** "lets really go ham on swe2 usage for the next 2 days so we dont burn all my codex / why so many sol runs? ... prioritize luna and good specs".
- **Decision:** codex-mode review-only. SWE-2 (cap 8) implements and reviews; Luna is the fallback; Sol only for reviews Luna can't do (reason in the spec); Astra only with Seb's OK.
- **What it changes:** Routing.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** codex-mode; concord-path.
- **Audit (2026-10-13):** SHIPPED. codex-mode review-only set 12:50 pm (~/.config/claude-routing/codex-mode); concord-path SWE-2 at 12:51/12:58 pm. The latest runs (90-r6, 94-limit, s67, s23, s24, s38) are SWE-2.
- **Source:** M:230-231, M:233, S:560-562.

## D-LEASE-LONG-TTL — Long leases with background parallel renewal

- **Date (CT):** 2026-10-13 11:39 am.
- **Owner's words:** "the leases keep expiring why are you dying on this 5 minute hill ... why is it serial?".
- **Decision:** Raise the lease max TTL to about 2 h with background batch renewal in concord land. A human force-releases dead holders.
- **What it changes:** Long landings stop losing their leases.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #50).
- **Audit (2026-10-13):** IN FLIGHT. Worker validated 997141a (Concord #50) at 12:45 pm; the chain was killed so it would not take leases ahead of #1. Unpublished. No renew-batch route on main.
- **Source:** M:228, S:554-559.

## D-MORE-CHECKERS — Run more local checker processes now

- **Date (CT):** 2026-10-13 11:27 am.
- **Owner's words:** "how can we run more checkers at the same time? im ok doing this until i review adding cloudflare workers as checkers".
- **Decision:** More local concord-v2 checkers on the Mac now; Cloudflare checkers stay held.
- **What it changes:** Checker throughput.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** ops.
- **Audit (2026-10-13):** SHIPPED. mac-checker-2 and -3 started 11:30 am (S:551).
- **Source:** M:226.

## D-REVIEWERS-NO-SUITE — Reviewers stop running the full suite

- **Date (CT):** 2026-10-13 11:27 am.
- **Owner's words:** "can we stop having reviewers run the full suite they should be able to see the results of the implementing agent".
- **Decision:** Reviewers use the worker's validation log plus the Concord checker PASS, and run focused tests only (all AW reviews).
- **What it changes:** Review cost.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** agent-workflows #667.
- **Audit (2026-10-13):** SHIPPED. AW agent-workflows #667 (09c7485) live 12:30 pm; concord-path claim text (S:551, S:558).
- **Source:** M:227.

## D-LEASE-WAIT-SPIKE — Spike the wait line first; emergency override is human-only

- **Date (CT):** 2026-10-13 10:59-11:02 am.
- **Owner's words:** "yes but spike bc what if an outtage or emergency happens ... it should be human driven bc im worried about agents abusing this".
- **Decision:** No wait-line work until a spike covers emergency release and move-to-top, which only humans may use.
- **What it changes:** Concord #16 held.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-LEASE-WAIT-LINE
- **Delivered by:** spike 8bTQwjSbG6uKBah6hEFfSo.
- **Audit (2026-10-13):** SHIPPED. Hold respected (S:549); spike 8bTQwjSbG6uKBah6hEFfSo delivered; approved 1:29 pm.
- **Source:** M:224-225, S:546-549.

## D-START-ASAP — #52 concord start first, whatever it takes

- **Date (CT):** 2026-10-13 10:59 am.
- **Owner's words:** "I want 52 landed asap. whatever it takes. this whole system is built around it, it is unacceptable you keep delaying the core feature of concord".
- **Decision:** #52 preempts everything; other chains pause until it lands.
- **What it changes:** Priority order.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #1).
- **Audit (2026-10-13):** IN FLIGHT. 3 h later, still not landed. The 11:00 am pause also stopped #52's own land process (S:551). Sticky checker failures and a real test interaction followed (S:556-561).
- **Source:** M:223, S:546-561.

## D-CHECKER-PASS-COUNTS — Reviewer may approve on Concord checker PASS when only unrelated load timeouts fail locally

- **Date (CT):** 2026-10-13 8:40 am.
- **Owner's words:** "Checker PASS counts (Recommended)".
- **Decision:** Concord's checker PASS on the exact head counts when the reviewer's only local failures are load timeouts in untouched tests.
- **What it changes:** Review gate.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** concord-path.
- **Audit (2026-10-13):** SHIPPED. Applied to #90 (S:527-529); concord-path review claim carries the policy.
- **Source:** M:222.

## D-FLEET-HOLD — Hold all fleet and pinning work until Seb reads the spike

- **Date (CT):** 2026-10-13 ~2:05 am.
- **Owner's words:** "can we hold off on this until the morning but remember to remind me in the morning on this i dont want to do this until i fully read".
- **Decision:** No multi-checker rollout or config-pin work until he reads #89; remind him in the morning.
- **What it changes:** Hold.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** hold.
- **Audit (2026-10-13):** SHIPPED. Hold respected (#68 paused, S:444); 9:07 am reminder planned in handoff 0756.
- **Source:** M:220.

## D-DEMO-BATCH-P — Demo A/B replays group P only

- **Date (CT):** 2026-10-13 ~2:00 am.
- **Owner's words:** "Replay group P only (Recommended)".
- **Decision:** 10 fully approved P changes; batch M dropped.
- **What it changes:** A/B scope.
- **Options not chosen:** batch M; both.
- **Status:** active
- **Delivered by:** manifest only.
- **Audit (2026-10-13):** PARKED. Manifest ab/P.json built 10-12 9:49 pm. The report and serial-arm slices are not on main (see D-DEMO-NUMBERS).
- **Source:** M:218, S:397.

## D-PUBLIC-FLAG — Per-repo public flag: anonymous read-only

- **Date (CT):** 2026-10-13 ~1:57 am.
- **Owner's words:** "Yes, build the flag (Recommended)".
- **Decision:** The owner sets public=true per repo, for anonymous read-only access (concord-v2, demo); all other repos stay owner-only.
- **What it changes:** Judges can read the live repo.
- **Options not chosen:** embedded viewer token.
- **Status:** active
- **Delivered by:** not yet (Concord #47).
- **Audit (2026-10-13):** PARKED. 3 rounds. Chain 91-r3 has been SIGSTOPped since 10:52 am to make room for #52 (pid 25322 alive 5 h); the ship list says 'paused'. No public-repos test on main.
- **Source:** M:217, S:438, S:545.

## D-NO-REASK — Don't re-ask decided questions

- **Date (CT):** 2026-10-13 ~1:55 am.
- **Owner's words:** "i thought i already answered this? ... lock at start and also an api to add things to the lock".
- **Decision:** Concord #45 closed, citing the 10-12 6:35 pm Q5 decision.
- **What it changes:** Process.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** n/a.
- **Audit (2026-10-13):** RULE BROKEN. Concord #45 asked Seb again about a decided question. The global rule says a successor never asks again about something decided.
- **Source:** M:216.

## D-QUESTIONS-FORMAT — Ask one question at a time, labelled Qn of N

- **Date (CT):** 2026-10-13 ~1:50 am.
- **Owner's words:** "ask the questions in the proper format one at a time ... label the questions properly".
- **Decision:** AskUserQuestion, one per call, labelled 'Qn of N'.
- **What it changes:** Question format.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** process.
- **Audit (2026-10-13):** SHIPPED. Q1-Q4 of 4 asked 1:50-2:02 am.
- **Source:** M:215-216.

## D-SWE2-EFFORT — AW fixes --effort for SWE-2

- **Date (CT):** 2026-10-13 ~1:30 am.
- **Owner's words:** "the swe 2 effort issue are you using the delegate-cli? whats the problem? aw should fix this".
- **Decision:** delegate-work handles --effort for devin.
- **What it changes:** AW launcher.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** agent-workflows #664.
- **Audit (2026-10-13):** SHIPPED. agent-workflows #664 (5462852) live 3:48 am (S:480).
- **Source:** M:214.

## D-MB-MIRROR — MB GitHub mirror: fast-forward from mother-base-v2; MB chat pushes it

- **Date (CT):** 2026-10-13 ~1:25 am / ~2:02 am.
- **Owner's words:** "MB chat pushes it (Recommended)".
- **Decision:** The MB chat does the catch-up fast-forward of seb-patron/mother-base main and adds --mirror-to on every landing.
- **What it changes:** MB backup.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** MB chat.
- **Audit (2026-10-13):** IN FLIGHT. Delegated to the MB chat (S:434); not verified here.
- **Source:** M:213, M:219.

## D-STANDING-APPROVALS — Concord's standing worker approvals = Mother Base #129

- **Date (CT):** 2026-10-13 ~1:25 am.
- **Owner's words:** "Same as Mother Base #129".
- **Decision:** Concord's standing worker approvals use the same text as MB #129.
- **What it changes:** Approval record.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** Concord #46.
- **Audit (2026-10-13):** SHIPPED. Recorded in Concord issue #46.
- **Source:** M:213.

## D-MUSE-SPARK — Muse spark 1.3 contributor as general worker, SWE-2 too, Codex for reviews

- **Date (CT):** 2026-10-13 ~1:10-1:15 am.
- **Owner's words:** "i feel we keep spark 1.3 contributor as a general worker and codex for reviews in the meantime / also use swe2".
- **Decision:** Implementation on Muse spark-1.3-contributor and SWE-2; reviews on Codex; no Wonder runs.
- **What it changes:** Routing.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-SWE2-LUNA
- **Delivered by:** concord-path.
- **Audit (2026-10-13):** SHIPPED. Rotation in concord-path (S:429-435). Muse quota ran out 4:55 am (S:491).
- **Source:** M:210-211.

## D-UI-AGENT-COUNT — UI agent count is real: agents tracked through leases

- **Date (CT):** 2026-10-13 ~1:05 am.
- **Owner's words:** "the ui showed 2 ... make sure the ui is correct we should be able to track agents through leases".
- **Decision:** Every working agent holds leases from the moment it starts (#1), and the tracker counts agents from live leases.
- **What it changes:** Truthful agent count.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** IN FLIGHT. Depends on #1 (not landed) and s23 (launched 1:47 pm).
- **Source:** M:212.

## D-RUNNER-FLEET-SPIKE — Spike more runners, including real Cloudflare ones

- **Date (CT):** 2026-10-13 ~12:55 am.
- **Owner's words:** "spike adding more runners incl. real Cloudflare ones [log paraphrase]".
- **Decision:** Runner-fleet spike.
- **What it changes:** Checker capacity.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** reading artifact.
- **Audit (2026-10-13):** SHIPPED. Report runner-fleet-r2.md in the reading artifact (2 doc-review rounds).
- **Source:** M:209, S:524.

## D-DEMO-NOT-SYNTHETIC — Why can't Concord or Mother Base be the demo?

- **Date (CT):** 2026-10-13 ~12:55 am.
- **Owner's words:** "why cant concord or motherbase be the demo? [log quote]".
- **Decision:** Real demo = Concord building Concord + MB + replay A/B; spike #40 decides whether demo.test shrinks or goes.
- **What it changes:** Demo + suite.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** PARKED. Spike #40 (#87) parked at 8:44 am; see D-DEMO-REAL-PROJECTS.
- **Source:** M:209.

## D-TEST-SUITE-SPIKE — Spike the test-suite plan before changing tests (is demo.test needed?)

- **Date (CT):** 2026-10-13 ~12:45 am.
- **Owner's words:** "spike the spec i want to make sure what we do is good".
- **Decision:** Spike first; the fast-suite spec (85) waits on it.
- **What it changes:** Suite speed and flake rate.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #40).
- **Audit (2026-10-13):** PARKED. Spike #87 got 3 doc-review rounds and was parked for Seb at 8:44 am (in the reading artifact). The ship list parks '#40 test-suite spike'. Spec 85 was never launched. demo.test is 230 s of the 333 s suite (S:423).
- **Source:** M:208, S:536.

## D-REVIEW-NETWORK — Review runs may use the network sandbox

- **Date (CT):** 2026-10-13 ~12:40 am.
- **Owner's words:** "Yes, network sandbox".
- **Decision:** Reviewers can run the suite on the exact head.
- **What it changes:** Review sandbox.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** concord-path.
- **Audit (2026-10-13):** SHIPPED. Applied 12:37 am (S:426).
- **Source:** M:207.

## D-CF-CONTAINERS-SPIKE — Spike checks on Cloudflare Containers now (1-2 h, artifact)

- **Date (CT):** 2026-10-13 ~12:40 am.
- **Owner's words:** "spike now".
- **Decision:** 1-2 h spike on running checks on Cloudflare from the Worker; report as an artifact.
- **What it changes:** Possible cloud checkers.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** reading artifact JWz4DWqUTynJgajCAf7mFR.
- **Audit (2026-10-13):** SHIPPED. The report (/tmp/claude-501/spikes/cf-container-checker.md) is in the reading artifact JWz4DWqUTynJgajCAf7mFR, about 7 h after the ask. The prototype change (#86, Concord #39) is parked on UNKNOWN_UNIT container/.
- **Source:** M:207, S:464.

## D-AGENT-MILESTONES — Agents may create milestones; optional owner-only lock

- **Date (CT):** 2026-10-13 ~12:35 am.
- **Owner's words:** "agents should be allowed to make milestones. we can add it as optionally lockable to only humans but i want my ai's to be able to make them".
- **Decision:** Agent principals create milestones by default; a per-repo setting can restrict it to humans.
- **What it changes:** Milestone permissions.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #38).
- **Audit (2026-10-13):** IN FLIGHT. Legacy #84, 4 runs; the final round failed and it was parked at 11:00 am. The s38 respec launched 1:47 pm. On main, POST /milestones is owner-only (src/features/issues.ts:112).
- **Source:** M:206, S:548, S:571.

## D-TESTS-EVERY-FIX — Every fix ships with a test; concurrency integration test; coverage audit

- **Date (CT):** 2026-10-13 ~12:30 am.
- **Owner's words:** "problem 3: make sure to include tests for this as well. what other core features are not tested? i trusted you to write tests as we go. no excessive tests".
- **Decision:** Each fix has a test that would have caught it. Several lands at once on one repo get a real integration test. Fill the coverage-audit gaps with a few high-value tests.
- **What it changes:** Test policy.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. The coverage audit found 6 missing tests (S:423). The planned spec 'after #35/#37 land' was never written. The only multi-land test is still the 2-way one from 10-11 (bfdbc9f, tests/node/land.test.ts:797).
- **Source:** M:205, S:421-423.

## D-DECOMP-DBOS-LAND — Decomp DBOS merge step calls concord land

- **Date (CT):** 2026-10-13 ~12:15 am.
- **Owner's words:** "Land via Concord".
- **Decision:** Decomp's DBOS merge step lands via Concord; GitHub mirror only.
- **What it changes:** Decomp landing path.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. Depends on the decomp import (not done).
- **Source:** M:203.

## D-MWCC-GATE-SPIKE — mwcc-rs spikes its own slow gate

- **Date (CT):** 2026-10-13 ~12:15 am.
- **Owner's words:** "sorry can we spike this? i dont want to create issues with the gate it takes forever for some reason have mwcc-rs handle this".
- **Decision:** The mwcc-rs chat spikes why its gate is slow and proposes the Concord gate.
- **What it changes:** Input for the mwcc-rs onboarding.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** mwcc-rs#944.
- **Audit (2026-10-13):** SHIPPED. seb-patron/mwcc-rs#944 (main b2f9592): Gate A 25-27 min, Gate B 43-45 min (S:553).
- **Source:** M:203, S:553.

## D-MWCC-HISTORY — mwcc-rs imported with history, private, never in the demo

- **Date (CT):** 2026-10-13 ~12:15 am.
- **Owner's words:** "i dont understand whats the problem".
- **Decision:** Default: import with history, repo private, never in the demo, unless Seb objects.
- **What it changes:** mwcc-rs in Concord.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. Not imported (see D-ONBOARD-NOW).
- **Source:** M:203.

## D-ONBOARD-NOW — Onboard mwcc-rs and decomp NOW (don't ask again)

- **Date (CT):** 2026-10-13 ~12:05 am.
- **Owner's words:** "why didn't you send the mwcc-ra chat the onboarding and why so decomp not using the checks build into concord?".
- **Decision:** Import both with history, checker on the PC runner, agents land via concord land, issues/milestones in Concord, GitHub mirror only.
- **What it changes:** Concord works for all our repos.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #36).
- **Audit (2026-10-13):** NEVER SPECCED. 14 h later neither is imported. Decomp is blocked on #36 trusted-config scale: the r3 worker blocked on an owner question, and Seb replied 'can we spike all this? i still dont know what youre asking'. mwcc-rs 'stays on GitHub/merge.sh until Concord sends the workflow' (S:553). The ship list says 'needs spec' for the PC checker and the mwcc-rs gate.
- **Source:** M:202, S:418-419, S:539, S:553.

## D-NO-GITHUB-WORK — No more work through GitHub

- **Date (CT):** 2026-10-12 ~9:30-9:35 pm.
- **Owner's words:** "ok stop having work go through github i though we had issues and milestones already? ... let prioritize getting concord off github github only mirrors no more work through github".
- **Decision:** Work items are Concord issues, changes are published into Concord, reviews are Concord verdicts, and landing goes through the Concord queue. GitHub is a mirror only.
- **What it changes:** Top priority before more feature work.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** partly; Concord #4 and #5 open.
- **Audit (2026-10-13):** SHIPPED. No GitHub PR since #78 (opened 8:58 pm 10-12). Still missing: agents can't clone or checkout from the Concord CLI (409 bug; Concord #4, gate passed 10-12, never landed, not on the ship list). Reviews are AW reports plus evidence files, not Concord verdicts written by the reviewer (Concord #5).
- **Source:** M:198-199, S:384-388.

## D-PUBLIC-REPO — Make seb-patron/concord public just before submit

- **Date (CT):** 2026-10-12 6:55 pm -> 2026-10-13 ~1:50 am.
- **Owner's words:** "Just before submit (Recommended)".
- **Decision:** Fresh secrets and private-name sweep Wed afternoon, then flip public before the 6 pm CT submit (the rules require a public repo).
- **What it changes:** Repo visibility.
- **Options not chosen:** public now; embedded viewer token.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** IN FLIGHT. Scheduled for Wed. The repo is private now (the 10-12 6:58 pm sweep found no secrets).
- **Source:** M:194, M:196, M:215.

## D-RUNNER-S3 — Owner-minted checker tokens up to 30 days (never promoter)

- **Date (CT):** 2026-10-12 6:55 pm.
- **Owner's words:** "yes to all three [runner spike S1, S3, drained-queue switch]".
- **Decision:** The owner mints checker tokens up to 30 days, never promoter.
- **What it changes:** Runners on other hosts.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 068f599.
- **Audit (2026-10-13):** SHIPPED. 068f599 (legacy #67, Concord #7).
- **Source:** M:194, S:409.

## D-RUNNER-S1 — S1: drop host shell/Node refusal, pin check config, record host facts

- **Date (CT):** 2026-10-12 6:55 pm.
- **Owner's words:** "yes to all three [runner spike S1, S3, drained-queue switch]".
- **Decision:** Pin the check config and log host facts instead of refusing other hosts.
- **What it changes:** Checkers on i7/PC.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #6).
- **Audit (2026-10-13):** PARKED. Legacy #68, 4 runs with RC rounds. Paused by Seb's own 2:05 am hold on fleet and pinning work (a legitimate hold).
- **Source:** M:194, M:220, S:444.

## D-RUNNER-DRAIN-SWITCH — One-time profile switch on drained queues (no S2)

- **Date (CT):** 2026-10-12 6:55 pm.
- **Owner's words:** "yes to all three [runner spike S1, S3, drained-queue switch]".
- **Decision:** Switch the checker profile once, when queues are drained.
- **What it changes:** Runner migration.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. No spec mentions it (grep 'drain' over wave2 specs: none). Now also under the fleet/pinning hold.
- **Source:** M:194.

## D-SCOPE-KEEP-ALL — Keep everything as planned despite the judge review's cut advice

- **Date (CT):** 2026-10-12 6:55 pm.
- **Owner's words:** "Keep everything as planned".
- **Decision:** Cloudflare Access, passkeys and all five C+ slices (69-73) stay in scope.
- **What it changes:** Scope.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** n/a.
- **Audit (2026-10-13):** CONTRADICTED. The ship list parks 69/70/71/73 and omits passkeys; Access was dropped for ~16 h.
- **Source:** M:194.

## D-RUNNER-SPIKE — Spike runner portability and install simplicity before any fix

- **Date (CT):** 2026-10-12 6:41 pm.
- **Owner's words:** "lets spike the solution im worried we are just fixing without understanding the issue. i dont want to overengineer this ... i want this to be easy to install by anyone".
- **Decision:** Neutral Opus spike; no multi-fingerprint spec until he reads it.
- **What it changes:** Runner design.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** spike.
- **Audit (2026-10-13):** SHIPPED. Artifact Uh2EtRkuGzp9S5NeZaFRGn (S:334).
- **Source:** M:191-192.

## D-LEASE-Q5-CPLUS — Claim model C+: declare, grow, verify

- **Date (CT):** 2026-10-12 6:35 pm.
- **Owner's words:** "ok go with c, declare, grow verify".
- **Decision:** Start claims declared units (70), concord claim grows mid-run (69) through a FIFO wait queue with ETA (72) and deadlock refusal (73), and publish/land auto-claim from the diff (71).
- **What it changes:** Agents can add claims mid-run instead of failing.
- **Options not chosen:** A coordinator pre-claim; B whole Allowed-files reservations.
- **Status:** active
- **Delivered by:** not yet (Concord #30, #31, #32, #33).
- **Audit (2026-10-13):** PARKED. Specs 69-73 written 6:35 pm 10-12. Only 72 was launched (GitHub #66, 4 rounds, never landed); 69, 70, 71 and 73 never launched. The 10-13 1:40 pm ship list parks them 'after the wait line'. No claim command or --units on main.
- **Source:** M:190, S:323-324, ship list.

## D-LOGIN-ACCESS — Phone login A: Cloudflare Access

- **Date (CT):** 2026-10-12 6:28 pm.
- **Owner's words:** "let's spec out a and then spec b? if we can do it before the countest ends even better".
- **Decision:** Sign in with Cloudflare Access (the signed identity header maps to a principal); no token pasting.
- **What it changes:** Seb can use Concord from his phone.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #28/#52).
- **Audit (2026-10-13):** IN FLIGHT. Built 10-12 ~7:10 pm, failed Mac launcher validation, never published, and lost across two handoffs. Found 10-13 11:32 am after Seb asked 'this login stuff isnt working ... where is that better version?'. Respecced and relaunched 1:46 pm (SWE-2, Concord #52). About 18 h lost. No session routes on main.
- **Source:** M:189, M:229, S:552, S:570.

## D-LOGIN-PASSKEYS — Phone login B: passkeys

- **Date (CT):** 2026-10-12 6:28 pm.
- **Owner's words:** "let's spec out a and then spec b? if we can do it before the countest ends even better".
- **Decision:** Passkey sign-in after Access, before the deadline if possible.
- **What it changes:** Login without Access.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #29).
- **Audit (2026-10-13):** PARKED. Silently dropped. Spec 68 was written 6:29 pm 10-12 and never launched. s67 lists passkeys as out of scope, and the 10-13 ship list omits them entirely.
- **Source:** M:189, M:194, S:321.

## D-LAND-VIA-CONCORD — Land via Concord, mirror GitHub, close the PR

- **Date (CT):** 2026-10-12 5:03 pm / 10:22 pm.
- **Owner's words:** "Yes, land via Concord / i approve land via concord, only mirror github i want all development done on concord".
- **Decision:** Approved changes land in concord-v2 (its checker and queue); then GitHub main is fast-forwarded (never forced) and the PR or issue is closed.
- **What it changes:** Replaces gh pr merge for this repo.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 3ce410c..dcf31c4.
- **Audit (2026-10-13):** SHIPPED. 6 landings mirrored. Gap: GitHub PRs #61 and #72 are still OPEN although they landed as 8516a60 and 1b2134e.
- **Source:** M:186, M:200-201.

## D-PATH-PROTECTION — Per-path protection levels (agent / human-approve / human-only)

- **Date (CT):** 2026-10-12 ~4:35 pm.
- **Owner's words:** "concord should have some level of impact on a repo but not require huge changes".
- **Decision:** Repo settings with per-path levels: (a) agents edit and land, (b) agents edit but a human approves in the UI, (c) humans only (agent leases refused). Applies to AGENTS.md and any file.
- **What it changes:** Human control over sensitive paths.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #10).
- **Audit (2026-10-13):** PARKED. Legacy #57 plus 3 Concord rounds, never landed. The 10-13 ship list parks it ('#10 protected paths (57)'). Main has no settings route.
- **Source:** M:180, ship list.

## D-AGENTS-TAB — Agents tab: what the AI sees vs what humans see

- **Date (CT):** 2026-10-12 ~4:35 pm.
- **Owner's words:** "concord should have some level of impact on a repo but not require huge changes".
- **Decision:** Show humans what agents see.
- **What it changes:** Agent context visible.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #24).
- **Audit (2026-10-13):** IN FLIGHT. 'For agents' toggle in s24 (launched 1:47 pm). Nothing on main.
- **Source:** M:180.

## D-LONG-TOKENS — 7-day principals kept across demo refreshes

- **Date (CT):** 2026-10-12 4:29 pm.
- **Owner's words:** "Yes, add 7-day tokens".
- **Decision:** Owner, AW author and reviewer, i7 agent and reviewer, and runner checker and promoter principals last 7 days.
- **What it changes:** Fewer token refreshes.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** ops config.
- **Audit (2026-10-13):** SHIPPED. ops/long-tokens.py; ~/.config/concord/long/ (S:278-280).
- **Source:** M:185, S:278.

## D-GLOSSARY — Concord terminology in docs/GLOSSARY.md

- **Date (CT):** 2026-10-12 ~4:00 pm.
- **Owner's words:** "save Concord terminology in the docs (docs/GLOSSARY.md, slice 59 Muse) so he can remember change, landing, etc. [log paraphrase; verbatim not recorded]".
- **Decision:** A glossary of change, landing, lease and so on.
- **What it changes:** Docs.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #26).
- **Audit (2026-10-13):** PARKED. Legacy #78 failed the checker 4 times on port flakes and was parked behind #92, itself parked. The ship list parks '#26 glossary (78)'. No docs/GLOSSARY.md on main.
- **Source:** M:182, S:504.

## D-CONCORD-ON-CONCORD — Build Concord on Concord; GitHub hourly backup only

- **Date (CT):** 2026-10-12 ~3:55 pm.
- **Owner's words:** "lets plan to swap to building concord on concord, and use github only for like an hourly write back up or something".
- **Decision:** Concord's own development moves onto Concord; GitHub only gets a backup.
- **What it changes:** concord-v2 is canonical.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 3ce410c..dcf31c4.
- **Audit (2026-10-13):** SHIPPED. concord-v2 imported 10-12 4:59 pm. 6 changes landed through Concord (3ce410c, 6faf482, 068f599, 8516a60, 1b2134e, dcf31c4). The hourly backup was never specced; instead the orchestrator's scripts fast-forward GitHub after each landing.
- **Source:** M:179, S:286, S:379.

## D-DIRECT-AGENTS — Plain agents may work on Concord directly, outside the AW launcher

- **Date (CT):** 2026-10-12 ~3:50 pm.
- **Owner's words:** "yes they may!".
- **Decision:** Codex or another plain agent on the i7/Mac may run Concord's CLI/MCP loop on concord-v2 until the AW adapter is ready.
- **What it changes:** Launcher-only exception.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** permission.
- **Audit (2026-10-13):** SHIPPED. Permission granted; not used (every run went through the AW launcher).
- **Source:** M:181.

## D-DEMO-NUMBERS — Measured before/after numbers for the demo

- **Date (CT):** 2026-10-12 ~3:50 pm.
- **Owner's words:** "i want to make sure at some point we get some numbers, like how many less conflicts or how much faster landing is then merges? i want our demo to have numbers on how much faster our repos go".
- **Decision:** The demo shows measured conflicts and landing time against GitHub merges.
- **What it changes:** Demo evidence.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #13, #18, #19, #34).
- **Audit (2026-10-13):** PARKED. Metrics (Concord #13): chain 60-r3 SIGSTOPped since 10:52 am (pid 19458). Replay serial (#19): parked for Seb at 8:39 am. A/B report (#18): 8 runs, waits behind the parked #92. Swarm arm (#34): never launched. Exporter (#25): parked. Nothing on main: no metrics route, no docs/replay-ab.md.
- **Source:** M:181, S:526-544.

## D-UI-FOR-HUMANS — Repo page fixes: 'For humans', no inverted area, 'Working now' stays

- **Date (CT):** 2026-10-12 ~3:45 pm.
- **Owner's words:** "overall good directions lets get on with it".
- **Decision:** Rename 'For people' to 'For humans', don't invert one area in agent mode, keep the 'Working now' view.
- **What it changes:** Prototype corrections.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** IN FLIGHT. Carried in s24 and s23 specs (grep 'For humans', 'invert', 'Working now'); nothing on main.
- **Source:** M:178.

## D-DEPLOY-FLOW — 'Let's deploy concord' install flow like yc-software/qm

- **Date (CT):** 2026-10-12 ~3:45 pm.
- **Owner's words:** "install needs a simple "Let's deploy concord" flow like github.com/yc-software/qm".
- **Decision:** Anyone deploys their own Concord by telling a coding agent one sentence.
- **What it changes:** Easy install for judges and others.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #27).
- **Audit (2026-10-13):** PARKED. Silently dropped. Spec 55 (Muse) failed launcher validation on a load flake ~4:55 pm 10-12 and went to reval-first, but was never published. Concord #27 is open. Not on the 10-13 ship list, not even under Parked.
- **Source:** M:178, S:259, S:275.

## D-AW-PRIVATE-AUTH — No owner-comment authorization gate for private repos (AW)

- **Date (CT):** 2026-10-12 ~3:45 pm.
- **Owner's words:** "this owner permission for private repos should not exist ... we have approval".
- **Decision:** AW stops requiring a per-repo owner comment before Muse/SWE-2 runs on private repos.
- **What it changes:** AW launcher policy.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** AW launcher.
- **Audit (2026-10-13):** SHIPPED. AW removed the gate (S:267); Muse 55 launched with no authorization refusal (S:261).
- **Source:** M:178, S:267.

## D-MUSE-SWE2-LANES — Use Muse and SWE-2 lanes, not only Codex

- **Date (CT):** 2026-10-12 ~3:35 pm.
- **Owner's words:** "why only codex build each slice? we have swe2 and muse, if we used concord to build concord we could have way more workers on it".
- **Decision:** Muse and SWE-2 build Concord slices too (the global routing rule is Muse first, SWE-2 second).
- **What it changes:** Routing.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-SWE2-LUNA
- **Delivered by:** n/a.
- **Audit (2026-10-13):** RULE BROKEN. Of 775 Concord worker runs, 713 were Codex (644 gpt-6-sol, 56 luna, 3 astra), 54 SWE-2 and 8 Muse. 'Sol for final reviews' became the default (S:197). Seb, 10-13 1:10 pm: 'why so many sol runs?'
- **Source:** M:177, M:233.

## D-UI-PROJECT-PAGE — Project page (README, files) with human and agent layers

- **Date (CT):** 2026-10-12 ~3:20 pm.
- **Owner's words:** "like github we need that project page that shows the repo, readme, and files ... basically i dont want any of this to step on agents".
- **Decision:** A GitHub-style repo page with README and file browser, separate human and agent layers, and a spike on human vs agent docs.
- **What it changes:** Repo browsing in Concord.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #24).
- **Audit (2026-10-13):** IN FLIGHT. Docs spike delivered (VCdymFm4r55MwM4H7CfpaD). Page: legacy #76, 6 runs, parked 10:49 am (404 vs 400); s24 respec launched 1:47 pm. Main has no tree route and no web/repo.js.
- **Source:** M:176, S:262, S:541, S:571.

## D-UI-ISSUES-TRACKER — Issues and milestones UI better than GitHub, default tracker, prototypes first

- **Date (CT):** 2026-10-12 ~3:10 pm.
- **Owner's words:** "dont forget to make the milestones and issues ui, it should be better than github, include a tracker by default like i always ask for, and should have protoypes for human editable interface".
- **Decision:** Prototypes for Seb first; then a tracker as the default view (with a friction log), an issue editor, a plan view and a milestones screen.
- **What it changes:** Human-editable work tracking.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #23, #12/#38).
- **Audit (2026-10-13):** IN FLIGHT. Prototypes delivered; tracker prototype RN5EetGqopPCvZBU1uDaak approved 3:45 pm. Main has only read-only issue cards (web/app.js:374-383). The tracker (legacy #75, 6 runs) was parked 8:43 am; the s23 respec launched 1:47 pm. The milestones screen is in s38 (launched 1:47 pm).
- **Source:** M:175, M:178, S:571.

## D-UI-ISSUE-EDITOR — Issue editor (part of the issues UI ask)

- **Date (CT):** 2026-10-12 ~3:10 pm.
- **Owner's words:** "should have protoypes for human editable interface bc thats pribably wehre humans will interact the most".
- **Decision:** Humans edit issues in the UI.
- **What it changes:** Editable issues.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #22).
- **Audit (2026-10-13):** PARKED. Silently dropped. The SWE-2 run (legacy #74) died ~1:20 am 10-13 on the --effort bug and was not in any relaunch list (relaunch-0122/0125/0132). Not on the ship list; Concord #22 open.
- **Source:** M:175, /tmp/claude-501/chain-cp74-ui-issue.log.

## D-UI-PLAN-VIEW — Plan view (part of the issues UI ask)

- **Date (CT):** 2026-10-12 ~3:10 pm.
- **Owner's words:** "dont forget to make the milestones and issues ui, it should be better than github".
- **Decision:** Milestone/plan view in the UI.
- **What it changes:** Planning UI.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #21).
- **Audit (2026-10-13):** PARKED. Silently dropped. Validated (870b06b) and published into Concord at 1:24 am 10-13 (change e6f6c892, awaiting review), then the chain died on a git-token 409 and was never resumed. Not on the ship list; Concord #21 open.
- **Source:** /tmp/claude-501/chain-cp73-ui-plan.log.

## D-I7-LANES — mwcc-rs capped at one Mac run; i7 for Concord runs and more lanes

- **Date (CT):** 2026-10-12 ~3:10 pm / ~7:28 pm.
- **Owner's words:** "i agree mwcc-rs should cap at one mac run ... I can turn on the i7 for concord runs if it helps / use the i7 for more lanes".
- **Decision:** mwcc-rs uses at most 1 Mac run (rest on the PC); the i7 takes Concord lanes.
- **What it changes:** Capacity.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** i7 repos.conf.
- **Audit (2026-10-13):** SHIPPED. i7 ready 10-12 ~4:20 pm, lanes from 7:26 pm (S:272, S:354).
- **Source:** M:175, M:197.

## D-MB-HISTORY — Re-import Mother Base with history; private PDF stays owner-only

- **Date (CT):** 2026-10-12 ~2:25 pm / ~4:50 pm.
- **Owner's words:** "1 yes ... / yes motherbase should be reimported with its git history".
- **Decision:** History import (owner-only storage of the private PDF, never in the demo).
- **What it changes:** MB history in Concord.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 982b604.
- **Audit (2026-10-13):** SHIPPED. mother-base-v2 imported with history 10-12 4:36 pm (a8347932) via import --with-history (982b604).
- **Source:** M:174, M:184, S:280.

## D-DECOMP-PC-RUNNER — Decomp checks on a Concord runner on the PC, ROM read locally

- **Date (CT):** 2026-10-12 ~2:25 pm.
- **Owner's words:** "1 yes 2 yes 3 yes 4 yes".
- **Decision:** A Concord checker on the PC reads the ROM from a local path; nothing uploaded.
- **What it changes:** Decomp can land via Concord.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. A PC wrapper and profile were prepared 10-13 12:10 am (S:419). The ship list at 1:40 pm says 'PC checker for decomp and mwcc-rs: needs spec'. No runner is live.
- **Source:** M:174, S:419, ship list.

## D-CODEX-LANES — 4 Codex lanes for Concord

- **Date (CT):** 2026-10-12 ~2:25 pm.
- **Owner's words:** "1 yes 2 yes 3 yes 4 yes".
- **Decision:** Four parallel Concord lanes.
- **What it changes:** Throughput.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-SWE2-LUNA
- **Delivered by:** ops.
- **Audit (2026-10-13):** SHIPPED. Lane cap 4, then 7 (S:247, S:267).
- **Source:** M:174.

## D-SWARMS — The goal is swarms: many agents and harnesses, no coordinator

- **Date (CT):** 2026-10-12 ~2:20 pm.
- **Owner's words:** "if aw can add an adapter for our workflows great but this needs to be neutral. so any agent or harness can use and get our benefits for swarm work. think about the swarm that's the goal. github sucks for swarms".
- **Decision:** Many agents in parallel on one repo with no coordinator.
- **What it changes:** Product goal.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** CONTRADICTED. With ~10 parallel chains on one repo, leases livelocked: #52 'lost 14 claims to 10 chains since 7:54' (S:545). Queued changes lose eligibility when their reservations are re-leased (Concord #49 open). The fix was a human SIGSTOP of every other chain. The wait line is not built.
- **Source:** M:173, S:541-547.

## D-AGENT-NEUTRAL — Agent-neutral: no AW dependency in product or flow

- **Date (CT):** 2026-10-12 ~2:10 pm.
- **Owner's words:** "no it doesn't need to involve aw. i already said this. it needs to be agent neutral ... remember how i said others dont have aw??".
- **Decision:** Any agent or harness (Claude Code, Codex, Cursor, any MCP client, plain git and the CLI) uses Concord directly; AW is just one client.
- **What it changes:** Product scope.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** CONTRADICTED. The product still ships AW-specific code: cli/main.ts:22 --aw-run, cli/land.ts:211-217 readAwRun, src/auth.ts:11 local-mock-aw, src/features/queue.ts:214-238 AW-only demo stages, and the AW scene at docs/DEMO.md:94. The earlier statement had not been saved to memory ('not saved; saved now').
- **Source:** M:172.

## D-FORGE-ISSUES — Concord is the forge: issues and milestones that leases link to

- **Date (CT):** 2026-10-12 ~2:00 pm.
- **Owner's words:** "the point is that you're not in the loop, that agents just use concord for work to get changes into main ... even put issues and milestones so the leases can link up too".
- **Decision:** Agents base, claim, publish, review and land in Concord, and Concord gets issues and milestones that link to changes and leases.
- **What it changes:** No GitHub PR or issue flow.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** d6d00b7 (GitHub #51).
- **Audit (2026-10-13):** SHIPPED. Issues and milestones API, CLI and MCP: d6d00b7 (#51, feat 4de1fda). Concord issues #1-#52 are in use. Web shows read-only issue cards only (web/app.js:374-383).
- **Source:** M:171, S:241, S:249.

## D-NO-DEFER — Nothing that fixes our git friction is deferred past submission

- **Date (CT):** 2026-10-12 ~1:50 pm.
- **Owner's words:** "stop telling everyone to delay after submission it needs to be good before submission so we can win come on think for a moment why would we fix this after submission".
- **Decision:** Build friction fixes before 10-15 (finer units, generated-file regen, mwcc-rs adoption).
- **What it changes:** Scope rule.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** n/a.
- **Audit (2026-10-13):** RULE BROKEN. The 10-13 1:40 pm ship list has 'Parked (out of scope until submission)': protected paths, the glossary, C+ claim slices 69/70/71/73, replay serial, the exporter, and spikes. Markdown, generated and C units were also parked there until 1:54 pm. Passkeys and the deploy flow are omitted. The numbering spike puts GitHub/GitLab import after submission.
- **Source:** M:170, ship list, numbering spike.

## D-NO-COORDINATOR — Replace GitHub; Claude is not in the middle

- **Date (CT):** 2026-10-12 ~1:25 pm.
- **Owner's words:** "you're making too many compromises the point of this contest is to replace github the fact you're sitting in the middle is a failure".
- **Decision:** Agents use Concord directly with no orchestrator in the loop; survey every chat's git friction and design around it.
- **What it changes:** The orchestrator stops driving every change.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** CONTRADICTED. Every Concord change still runs through the orchestrator's chain scripts (cpath-run-*.sh: worker, publish, review, land, mirror, close issue; 222 chain copies in /tmp/claude-501). At 10-13 10:59 am the orchestrator SIGSTOPped every other chain so #52 could claim leases. The ship list says 'Changes land one at a time in this order'. The friction survey did happen (git-competition/friction/).
- **Source:** M:169, S:238-240, S:547.

## D-LEASE-AGENTS-CLAIM — Agents claim their own leases at task start (concord start)

- **Date (CT):** 2026-10-12 ~1:15 pm.
- **Owner's words:** "what do you mean you claim each runs file leases? that makes no sense why would you claim another agents work? the managing agent should be using concord?".
- **Decision:** Agents claim leases at task start via MCP or the CLI, push to Concord and land there. The coordinator does not claim for them.
- **What it changes:** concord start (approved slice 33; legacy #52, Concord #1).
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #1).
- **Audit (2026-10-13):** IN FLIGHT. Launched 10-12 1:28 pm; about 17 worker and review runs reference it (9 implementation runs) and about 6 repair rounds. A lease livelock, plus the orchestrator's own 11:00 am pause, which SIGSTOPped #52's land and let its leases expire. Not on main after 24.5 h. An Opus subagent has had it since ~1:04 pm; at 12:48 pm land.test was still 40/41.
- **Source:** M:168, S:240, S:541-561.

## D-MB-FULL-CONCORD — Mother Base fully on Concord; GitHub for backups only

- **Date (CT):** 2026-10-12 ~10:25 am.
- **Owner's words:** "ok and can we swap motherbase over to concord completly? and only use github for regular like backups or somethign similar?".
- **Decision:** MB source of truth = Concord; GitHub = backup mirror.
- **What it changes:** MB stops using GitHub for work.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** partly.
- **Audit (2026-10-13):** IN FLIGHT. MB lands through Concord. At 10-12 9:32 pm MB still used GitHub PRs for intake and review (S:387). At 10-13 1:14 am the mirror lagged (canonical de7ce90 not on GitHub). The MB chat owns the catch-up; not verified from here.
- **Source:** M:167, S:387, S:433.

## D-LEASE-OVERLAP-SPIKE — Spike why leases don't stop overlap

- **Date (CT):** 2026-10-12 ~10:05 am.
- **Owner's words:** "why arent leasess stopping overlap? can we spike this so motherbase doesnt haev this issue anymore?".
- **Decision:** Spike early leases and hot-file granularity for Mother Base.
- **What it changes:** Input for the claim model.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-LEASE-AGENTS-CLAIM
- **Delivered by:** spike artifact RSDBC1MYRzVHKHpKekSRDF.
- **Audit (2026-10-13):** SHIPPED. Spike artifact RSDBC1MYRzVHKHpKekSRDF published 12:40 pm 10-12. It recommended coordinator pre-claims, which Seb rejected at 1:15 pm.
- **Source:** M:166, S:234.

## D-UI-MOBILE — Mobile friendly

- **Date (CT):** 2026-10-11 ~8:00 pm.
- **Owner's words:** "dont forget to make this mobile friendly as well".
- **Decision:** The phone layout works.
- **What it changes:** Responsive UI.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** d42090d.
- **Audit (2026-10-13):** SHIPPED. Live first-run page checked at 375 px with no horizontal scroll (S:162).
- **Source:** M:154, S:162.

## D-UI-FLEET-DESK — Fleet desk direction: header, stats, dark mode, agent board, Inbox, first-run

- **Date (CT):** 2026-10-11 ~7:58-8:03 pm.
- **Owner's words:** "ok looking good i approve lets go in that direction now".
- **Decision:** A's header, logo, stat strip and dark mode; B's in-progress board with each agent's model; the alert bar becomes an Inbox page; a first-run screen.
- **What it changes:** New web UI.
- **Options not chosen:** A control room alone; B pipeline board alone.
- **Status:** active
- **Delivered by:** d42090d, dae0ba6.
- **Audit (2026-10-13):** SHIPPED. d42090d (#35, 7 repair rounds) and authorModel dae0ba6 (#33); web/index.html first-run section, Inbox; web/app.js:36 modelFor.
- **Source:** M:153-155, S:106-107, S:161-162.

## D-UI-REDESIGN — UI is brutal: mockups first, then implement before the demo

- **Date (CT):** 2026-10-11 ~7:45 pm.
- **Owner's words:** "that ui is brutal, we need to work on some new mockups asap and fix before the demo this is super important".
- **Decision:** Mockups first (Seb picks), then a worker implements before the recording.
- **What it changes:** UI redesign on the critical path.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-UI-FLEET-DESK
- **Delivered by:** d42090d.
- **Audit (2026-10-13):** SHIPPED. Mockups ARo2CLEnuj9E8gVLhVjUWn; implemented as D-UI-FLEET-DESK.
- **Source:** M:152, S:102-103.

## D-SUBDOMAIN — Subdomain 'sebpatron' (question)

- **Date (CT):** 2026-10-11 ~7:36 pm.
- **Owner's words:** "asked if the subdomain can become 'sebpatron' eventually [log paraphrase]".
- **Decision:** Undecided; change before the recording if wanted.
- **What it changes:** URL.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. No follow-up recorded; URL is still concord.sebastian-patrones.workers.dev.
- **Source:** M:151.

## D-DEPLOY-COSTS — Deploy to Cloudflare and track costs

- **Date (CT):** 2026-10-11 7:29 pm.
- **Owner's words:** "ok deploy and track costs as well".
- **Decision:** Production deploy and ongoing cost tracking.
- **What it changes:** Live Worker.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 531967aa; cost.sh.
- **Audit (2026-10-13):** SHIPPED. Deployed 7:36 pm 10-11 (531967aa); cost.sh (S:100). Caveat: the live Worker was last deployed at 3ce410c; #61's server changes (8516a60, landed 3:29 am) have been undeployed for 10+ h.
- **Source:** M:150-151, S:98-100, S:477.

## D-CONTESTS-SPIKE — Spike generic contests and model-assisted review (bonus)

- **Date (CT):** 2026-10-11 ~6:46-6:50 pm.
- **Owner's words:** "i like the idea of contests, and maybe even a model being able to also review? can we spike this? ... if we can get it done in time though bonus points".
- **Decision:** Spike generic scored contests (including N candidates from different specs), with optional Workers AI or any agent as reviewer. Off the critical path.
- **What it changes:** Contests beyond the demo fixture.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. The Opus spike was done 10-11 ~7:10 pm, and the duplicate Astra spike is still open as GitHub #30. No spec followed. Main refuses contests for every non-dispatch-lab policy (src/features/queue.ts:254-255, 467-473), per Claude's own 6:29 pm integrator call.
- **Source:** M:145-148, S:79-83.

## D-GENERIC-FIRST — Generic agent path first; AW only an optional adapter

- **Date (CT):** 2026-10-11 ~6:18 pm.
- **Owner's words:** "let's make sure we aren't over engineering for ourselves. others won't have the delegate cli make sure this works for regular agents using sub agents as well".
- **Decision:** The primary path is MCP, concord land and runtime-minted subagent tokens. AW is only an optional adapter, and the docs and demo lead with a plain agent and its subagents.
- **What it changes:** Product and docs are agent-neutral.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** partly: 1f2f2f8; AW code still in cli/main.ts:22, cli/land.ts:211-217.
- **Audit (2026-10-13):** CONTRADICTED. concord land shipped (1f2f2f8). After this decision the product gained AW-specific code: the AW review trailer counts as approval evidence (#39 16a8b31, 10-12 12:17 am), and --aw-run base rules were added (#44). docs/DEMO.md:94 keeps the AW-mock scene in the 9-minute flow, and README.md:3 leads with the scripted dispatch-lab fixture.
- **Source:** M:144, S:76, S:163.

## D-DEMO-REAL-PROJECTS — Demo uses real working projects; dispatch-lab is the fallback

- **Date (CT):** 2026-10-11 ~5:46 pm.
- **Owner's words:** "yes let's expand past the demo maybe we can use these use cases for the demo instead an actually working project".
- **Decision:** Feature Concord dogfood, Mother Base V1 and possibly mwcc-rs; dispatch-lab stays as the reproducible fallback.
- **What it changes:** Demo content.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** IN FLIGHT. The real evidence exists: 21 MB V1 landings and 6 Concord-on-Concord landings. But the judge-facing docs/DEMO.md on main is still the scripted 9-scene dispatch-lab run with the AW scene, README.md:3 leads with the fixture, and no real-project demo script is on main. Plan artifact: 1szrNBh6gWDmGTCYeHt7Fm.
- **Source:** M:142, M:195.

## D-MB-SNAPSHOT — Mother Base snapshot import (no history, docs/owner excluded)

- **Date (CT):** 2026-10-11 ~5:35 pm.
- **Owner's words:** "ok the snapshot import".
- **Decision:** One root commit from the current tree, excluding docs/owner/**.
- **What it changes:** MB enters Concord.
- **Options not chosen:** full-history import.
- **Status:** superseded by D-MB-HISTORY
- **Delivered by:** 5b969a6.
- **Audit (2026-10-13):** SHIPPED. Imported 10-12 2:41 am (canonical a5f2f4d from 8b63c18); importer 5b969a6 (#26).
- **Source:** M:139, S:185.

## D-MB-V1-ON-CONCORD — Build Mother Base V1 on Concord before Wednesday

- **Date (CT):** 2026-10-11 ~5:30 pm.
- **Owner's words:** "lets work on the pieces so motherbase v1 can be built before wednesday and even better if it can be part of the demo".
- **Decision:** Concord is where MB merges happen; GitHub is a one-way mirror. MB content in the demo needs Seb's sign-off.
- **What it changes:** MB as a real tenant.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** mother-base / mother-base-v2 canonicals.
- **Audit (2026-10-13):** SHIPPED. 11 MB V1 changes landed in 'mother-base' by 10-12 12:38 pm, then 10 in mother-base-v2 by 5:33 pm (e32920c).
- **Source:** M:137, S:199-231, S:304.

## D-LEASE-ADAPTERS — Pluggable lease-unit adapters for all our projects

- **Date (CT):** 2026-10-11 ~5:25 pm.
- **Owner's words:** "lets make this tool work for all our projects, decomp, mwcc-rs, motherbase, and building concord ... in order to win we need to make this a good tool for not just our repos".
- **Decision:** A generic zero-config default plus opt-in per-repo lease-unit adapters; decomp symbol units as the flagship.
- **What it changes:** Leases cover meaning (symbols, sections, rows), not whole files.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-LEASE-LANGUAGE-AGNOSTIC
- **Status detail:** (per-repo adapters replaced by one engine)
- **Delivered by:** not yet.
- **Audit (2026-10-13):** CONTRADICTED. 48 h later main has only file: and row: unit kinds (src/leases/units.ts). There is no adapter interface and no zero-config default: every repo needs an owner policy (Mother Base = 259 file units). In practice a lease covers a whole file. Nothing was specced until Seb's 10-13 1:54 pm complaint.
- **Source:** M:134, S:574.

## D-LEASE-15-PLAN — 15B and 15C now, 15A next, skip 15D

- **Date (CT):** 2026-10-11 ~5:15 pm.
- **Owner's words:** "ok proceed with the recomendation".
- **Decision:** Transitive dependency evidence (15B) and stale-base queue blocking (15C) now, the unit-list generator (15A) next, and no 15D.
- **What it changes:** Queue blocks stale bases; verdicts track transitive dependencies; generator writes unit lists.
- **Options not chosen:** 15D (dogfooding as a separate slice).
- **Status:** active
- **Delivered by:** 5ac07cd, e5e2df5, 009eaf9.
- **Audit (2026-10-13):** SHIPPED. 5ac07cd (#23 15b), e5e2df5 (#22 15c), 009eaf9 (#24 15a); STALE_MAIN in src/features/queue.ts.
- **Source:** M:133, S:61, S:70, S:76-77.

## D-LEASE-TSV-ROWS — FIX 1: general TSV row units now

- **Date (CT):** 2026-10-11 ~5:05 pm.
- **Owner's words:** "message the concord agent working on implementation about this".
- **Decision:** Policy declares each table's file, header, key column and a pattern, so new keys become row units (mwcc-rs families.tsv tail conflicts).
- **What it changes:** Row-level leases for declared tables.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 99f899d (GitHub #29).
- **Audit (2026-10-13):** SHIPPED. PR #29 merged 99f899d; src/leases/units.ts emits 'row:' unit keys.
- **Source:** M:131-132, S:113.

## D-LEASE-GENERATED-DECL — FIX 2: generated-file regen and declaration units after the deploy works

- **Date (CT):** 2026-10-11 ~5:05 pm.
- **Owner's words:** "message the concord agent working on implementation about this".
- **Decision:** Generated files are rebuilt on land and declarations (decomp callees.h) become units, but only after the production deploy works.
- **What it changes:** Generated files and header declarations stop colliding as whole files.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet (Concord #9).
- **Audit (2026-10-13):** IN FLIGHT. Deploy worked 10-11 7:36 pm, but spec 36 only launched ~10-12 3:10 pm. GitHub #56 plus 4 Concord rounds never landed; the 10-13 1:40 pm ship list parked it (#9); un-parked 1:54 pm after Seb objected. Only an Opus respec is running. Concord #9 is open, and main has no generator tests.
- **Source:** M:131-132, S:259, S:574.

## D-LEASE-SPIKE-15 — Spike lease units for real repos before slice 15

- **Date (CT):** 2026-10-11 ~4:22 pm.
- **Owner's words:** "spike slice 15 first i want to make sure we are building the best possible product while also targetting an MVP for the demo".
- **Decision:** Compare lease-unit options for real repos, pick the demo MVP and the best-product path before building slice 15.
- **What it changes:** Slice 15 waits on a spike.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-LEASE-15-PLAN
- **Delivered by:** spike artifact 3HLf8PNh3UNS4DKE9DfLao.
- **Audit (2026-10-13):** SHIPPED. Spike artifact 3HLf8PNh3UNS4DKE9DfLao published 10-11 4:45 pm (S:58).
- **Source:** M:130, S:55-58.

## D-MCP-AGENTS — Fix 2: MCP server and AGENTS.md so any agent can use Concord

- **Date (CT):** 2026-10-11 ~4:15 pm.
- **Owner's words:** "ok agree on fix 1 and 2".
- **Decision:** An MCP server and AGENTS.md give any agent the Concord loop.
- **What it changes:** Non-AW agents can drive Concord.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 2293969 (GitHub #21).
- **Audit (2026-10-13):** SHIPPED. PR #21 merged 2293969; mcp/server.ts, docs/mcp.md.
- **Source:** M:127, S:91.

## D-SUBAGENT-TOKENS — Fix 1: runtime-minted scoped expiring subagent tokens

- **Date (CT):** 2026-10-11 ~4:15 pm.
- **Owner's words:** "ok agree on fix 1 and 2".
- **Decision:** Agents mint scoped, expiring tokens for their subagents at runtime.
- **What it changes:** Subagents act under their own principals.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 23b826b (GitHub #25).
- **Audit (2026-10-13):** SHIPPED. 23b826b (#25, 6 repair rounds); cli/main.ts 'principals mint'.
- **Source:** M:127, S:153.

## D-RECORD-TUE — Record Tuesday night; Monday night is the dry run

- **Date (CT):** 2026-10-11 ~4:14 pm / ~5:52 pm.
- **Owner's words:** "record monday night / i can record tuesday night if we need more time".
- **Decision:** Recording Tue 10-13 night with MB V1 on Concord; Monday night dry run.
- **What it changes:** Schedule.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. No dry run is logged in STATE.md for Monday night or Tuesday so far; the 10-12 9:58 pm handoff moved it to 'Tue: demo dry run'. Recording is tonight and the demo numbers are not on main.
- **Source:** M:128, M:143.

## D-HANDOFF-60 — Hand off at 60%; separate write-up chat

- **Date (CT):** 2026-10-11 ~2:50 pm.
- **Owner's words:** "dont forget to handoff soon at the 60% like the other chats. you might want a seperate chat just to handle this write up for me".
- **Decision:** The orchestrator hands off at 60% context; another chat owns the explainer.
- **What it changes:** Chat hygiene.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** handoffs.
- **Audit (2026-10-13):** SHIPPED. Handoffs at 52-57% (9 orchestrator handoffs); write-up chat produced the Field Manual.
- **Source:** M:117.

## D-CLAUDE-MERGES — Claude may merge Concord PRs after independent approval

- **Date (CT):** 2026-10-10 ~11:58 pm.
- **Owner's words:** "yes you may".
- **Decision:** Merge after an independent APPROVE and passing launcher validation (this repo only, until submission).
- **What it changes:** Merge authority.
- **Options not chosen:** not recorded.
- **Status:** superseded by D-LAND-VIA-CONCORD
- **Delivered by:** merge.sh.
- **Audit (2026-10-13):** SHIPPED. merge.sh (--merge --match-head-commit); 49 PRs merged.
- **Source:** M:75.

## D-PLAN-ASTRA — Approve the build plan and the Astra spec

- **Date (CT):** 2026-10-10 ~11:10 pm.
- **Owner's words:** "i approve the plan and the astra spec".
- **Decision:** Build Concord: semantic leases, a checker-gated speculative queue with bisection, content-bound verdicts, a findings ledger, CLI, UI, replay, deploy.
- **What it changes:** Concord exists.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** 702a576..313548c (GitHub #1-#17).
- **Audit (2026-10-13):** SHIPPED. Slices 01-12 merged by 10-11 9:23 am (#1-#17, main 313548c, 309 tests).
- **Source:** M:55, S:26-31.

## D-DECOMP-C-DEMO — Decomp in the demo: numbers and anonymized symbols, C behind an off switch

- **Date (CT):** 2026-10-10 ~10:50 pm / ~11:20 pm.
- **Owner's words:** "for decomp we can change the rules and just include decomped c it should be ok we can review later / ok sounds good".
- **Decision:** The demo may include decomp C; by default it shows numbers and anonymized symbols, with real C behind a switch that is off. ROM and target bytes stay out.
- **What it changes:** Decomp's role in the demo.
- **Options not chosen:** not recorded.
- **Status:** active
- **Delivered by:** not yet.
- **Audit (2026-10-13):** NEVER SPECCED. Decomp appears nowhere in the demo or the repo: no switch, no scene. docs/DEMO.md:126 only quotes owner-reported decomp counts. Partly superseded by Seb's 10-13 2:00 am batch-P pick.
- **Source:** M:29, M:66.

## D-ROUTING-1013 — SWE-2 first, Luna for urgent blockers (relayed)

- **Date (CT):** 2026-10-13, ~2:15 pm CT.
- **Owner's words:** "yes use luna for urgent blockers ... yes we can use luna and swe2 just want more swe2 usage when we cna".
- **Decision:** implement on SWE-2 whenever it works; Codex Luna for urgent blockers and when SWE-2 cannot; Sol never implements; reviews on Luna.
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Source:** AW chat, relayed to Concord 10-13.

## D-SUITE-BLOAT-ASTRA — investigate test-suite bloat with Astra (relayed)

- **Date (CT):** 2026-10-13, ~2:50 pm CT.
- **Owner's words:** "jesus why did it bloat so much? message the new chat to investigate with astra asap this is unacceptable we don't even have core features working and test suite is super bloated".
- **Decision:** a gpt-6-astra investigation of the Concord test suite (185 tests on 10-11, 552 on 10-13; validate.sh ~5 min; land.test.ts 150-290 s). Output: where time goes, what to cut/merge/move to unit level, a target, and a trim spec that keeps every core-behavior assertion. Astra approved by the owner for this run.
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Source:** retired Concord chat 10-13 7:56 am, relayed to Concord 10-13 2:31 pm.

## D-NO-REPEAT-RUNS — one test run as proof, never repeats (relayed)

- **Date (CT):** 2026-10-13, ~2:55 pm CT.
- **Owner's words:** "why run the same test 3 times? this is unacceptable time".
- **Decision:** specs and subagent prompts ask for ONE run of a test or suite as proof, plus Concord's checker. Repeat runs only to reproduce a named flake on purpose, and the spec says so.
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Source:** retired Concord chat 10-13 7:56 am, relayed to Concord 10-13 2:31 pm.

## D-NO-LOAD-REPRO — never reproduce load or flakes in the Concord repo (relayed)

- **Date (CT):** 2026-10-13, ~3:00 pm CT.
- **Owner's words:** "fuck off with this flake it was load stop trying to reproduce load that's a rule for this repo".
- **Decision:** no load or flake reproduction in specs, subagent prompts or worker runs (no CPU throttling such as slow-host.mjs, no port thief, no repeated runs to catch intermittent failures). A timeout under machine load is load, not a bug.
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Status detail:** active. s14 (load-robust waits) and s48 (own-port stacks) are on hold pending the owner (Q-LOAD-SPECS)
- **Source:** retired Concord chat 10-13 7:56 am, relayed to Concord 10-13 2:31 pm.

## D-LOAD-SPECS-DROPPED — drop s14 and s48

- **Date (CT):** 2026-10-13, ~3:08 pm CT.
- **Owner's words:** "a) drop both" (Q-LOAD-SPECS).
- **Decision:** s14 (load-scaled test waits, Concord #14) and s48 (own-port test stacks, Concord #48) are dropped; both issues closed. Test speed goes through the Astra suite trim.
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Status detail:** live
- **Source:** Concord chat 10-13 2:31 pm.

## D-E2E-LESS-OFTEN — end-to-end tests run less often and cost less

- **Date (CT):** 2026-10-13, ~3:05 pm CT.
- **Owner's words:** "why so many end to end tests? they should not run that often. they should be more efficient".
- **Decision:** tiered tests: a fast tier (without starting the local Worker or bridge) for worker validation and review; a small end-to-end smoke set per head in Concord's checker; the full end-to-end set only where it pays (e.g. per landing batch or when land/lease/bridge paths change). Each end-to-end test gets cheaper (shared stack per file). Designed in the Astra suite-trim spike plus a tier follow-up.
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Status detail:** active (spike running)
- **Source:** Concord chat 10-13 2:31 pm.

## D-52-MERGE-NOW — land #1 now, fix review findings in a follow-up

- **Date (CT):** 2026-10-13, ~2:58 pm CT.
- **Owner's words:** "holy shit just merge it in and fix ina. follow up too much work is waiting on land".
- **Decision:** land #1 (concord start, head c66f724 / cd7df8f) despite the Luna REQUEST CHANGES; the 3 findings (ledger wave2/52-r8-findings-ledger.md) ship as a follow-up change.
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Status detail:** active. Owner-override land was blocked by the auto-mode permission classifier at ~3:00 pm CT; waiting for the owner
- **Source:** Concord chat 10-13 2:31 pm.

## D-DEMO-DOCS-TESTS-OUT — no demo tests, no tests that run the docs

- **Date (CT):** 2026-10-13, ~3:10 pm CT (first asked ~12:45 am CT, parked behind spike #40 without his OK).
- **Owner's words:** "why is demo still in??? i asked for it removed a long time ago. why are we running tests on docs??" and "write the spec now jesus no point in waiting".
- **Decision:** delete tests/node/demo.test.ts and tests/node/docs.test.ts; product assertions they held move to cheap Worker tests. The demo CLI stays for recordings. Spec wave2/t1-drop-demo-docs-tests.md (Concord #40).
- **What it changes:** See Decision.
- **Options not chosen:** Not recorded.
- **Delivered by:** Not yet.
- **Status:** active
- **Status detail:** in flight
- **Source:** Concord chat 10-13 2:31 pm.

## D-UNIT-PLUGINS — agnostic core, optional language plugins

- **Date:** 2026-10-13, ~3:32 pm CT.
- **Owner words:** "why markdown symbols?? that sounds so specific what does it actually help with? i though we were spiking some language agnostic stuff?" then "im also open to some sort of plugin extension system for different languages if a full agnostic system is hard or there is extra nuance with some languages".
- **Decision:** one language-agnostic lease-unit core; an optional per-language plugin interface is allowed where a language needs finer or more stable units. s8 (markdown adapter) held; unit-engine spike decides the design (Q-UNIT-ENGINE).
- **Status:** spike running.
- **Source:** Concord chat 10-13 2:31 pm.

## D-SPIKE-MEANS-RESEARCH — a spike is research, judged against the long-term goal

- **Date:** 2026-10-13, ~3:35 pm CT.
- **Owner words:** "no dont design the plugin system i want to spike if its a good idea. can you please just actually spike things? i want to research and find the best option. its like you always take the last thing you read and ignore everything else. this is to be a fully future proof github replacement system not this constant short sighted thinking."
- **Decision:** a spike researches the question broadly (prior art with sources, real data from our repos, every serious option incl. the baseline and radical ones), judges options against the long-term goal first (future-proof GitHub/GitLab replacement for many agents, any language) and the deadline second, and ends with a fair comparison and decision questions. No design, no spec, no chosen answer inside a spike. A new owner remark adds to the question; it does not replace earlier decisions.
- **Status:** active. Lease-granularity research spike relaunched under this rule (3:35 pm).
- **Source:** Concord chat 10-13 2:31 pm.

## D-FREEZE-AFTER-START — after #1 lands, only spikes until the owner review

- **Date:** 2026-10-13, ~4:20 pm CT.
- **Owner words:** "once concord start and release lands dont kick off anything except spikes. i really want to understand whats holding us back, what we have so far, and how to best use our time before the due date to make something thats useful".
- **Decision:** after #1 lands, no new worker launches, publishes or deploys; only research spikes. Two Opus 5.5 spikes: (1) retrospective on everything that went wrong (why #1 was delayed, all problems, why the process is slow, would GitHub have been faster, checking time and serial checks); (2) inventory of what is built to date and how to use the time before the due date. Owner reviews when back from a walk.
- **Status:** active.
- **Source:** Concord chat 10-13 2:31 pm.

## D-FREEZE-EXCEPT-DEPLOY-43 — deploy allowed; fix the 32-change limit

- **Date:** 2026-10-13, ~4:25 pm CT.
- **Owner words:** "well you can deploy the worker thats ok, i want that deployed. also one exception fix the 32 change limit so motherbase gets unblocked.".
- **Decision:** Freeze exceptions: deploy the Worker after #1 lands; fix #43 (landed changes stop counting toward the limit) with one repair, a delta review and a land.
- **Status:** done (#43 landed b6c24e1, deployed).
- **Source:** Concord chat 10-13 4:44 pm.

## D-CHECKER-SPEED-LATER — checker speed is discussed later

- **Date:** 2026-10-13, ~4:30 pm CT.
- **Owner words:** "def want to figure out how to speed up concord's checker too ... options like finally using cloudflare ... for a swarm this is taking too long. this is something we should discuss later".
- **Decision:** Discuss later. The reading list carries cf-container-checker and runner-fleet-r2; the retrospective spike covers checker speed and serial checks.
- **Status:** parked.
- **Source:** Concord chat 10-13 4:44 pm.

## D-COMMIT-IDENTITY-SPIKE — spike squash policy and approval binding

- **Date:** 2026-10-13, ~4:35-4:40 pm CT.
- **Owner words:** "ok so concord always squashes? but by squashing we change the commit? ... do we always want to squash? ..." and "def want to understand why our manual land command had this issue but it normally wouldnt. maybe the cli or mcp needs improvements as well?".
- **Decision:** Commit Identity Research spike (squash policy, approval binding, owner amend/attest, authorship, manual-land failure chain, CLI/MCP gaps) before fixing related issues.
- **Status:** spike delivered; questions pending.
- **Source:** Concord chat 10-13 4:44 pm.

## D-RETRO-SUSTAIN — retrospective covers why things get missed

- **Date:** 2026-10-13, ~4:47 pm CT.
- **Owner words:** "nooooo what? whats this policy problem? lmao how are we missing so much? we also need the spikes to help make this project more sustainable we are missing too many things".
- **Decision:** Retrospective spike extended: why things get missed and sustainability options (Q-RETRO-SUSTAIN-*), incl. the trusted-config 64-part deploy failure.
- **Status:** spike delivered.
- **Source:** Concord chat 10-13 4:44 pm.

## D-POLICY-DRAWING-BOARD — policy and scale-out back to the drawing board

- **Date:** 2026-10-13, ~4:55 pm CT.
- **Owner words:** "spike the 64 part policy fix. i dont understand why the same worker has policies for each repo this seems unsustainable ... a generic worker blueprint and each repo gets its own version based on its own policy ... i want to go back to the drawing board on this and make something sustainable. its too fragile rn".
- **Decision:** Policy & Scale-Out Research spike (Q-POLICY-*), drawing-board scope.
- **Status:** spike delivered (SM7bQ2oubQKiCNCfWKU35y).
- **Source:** Concord chat 10-13 4:44 pm.

## D-CHANGE-MODEL-SPIKE — no question without a spike; change-model spike

- **Date:** 2026-10-13, ~4:57 pm CT.
- **Owner words:** "dont add the autoclose question without a spike. spike it, i want research on the best option. in github new commits on a PR update the PR, why does that not happen on a change? ...".
- **Decision:** Q-AUTOCLOSE withdrawn; Change Model Research spike. Rule: no new owner question without a spike behind it.
- **Status:** active rule; spike delivered (9EeAo6UJ6MpLfSjVWXH4Pj).
- **Source:** Concord chat 10-13 4:44 pm.

## D-LEASE-5MIN-EXTEND — leases default to 5 minutes, extension made reliable

- **Date:** 2026-10-13, ~5:10 pm CT.
- **Owner words:** "it should not default to 2 hours. go back to 5 mins and make the extend lease better. spike if needed. that's special exception by default we should just extend".
- **Decision:** Default hold 5 min; a long hold is an explicit exception; renewal made reliable (lease renewal spike first). Specs 100, 102, 101a, 101b.
- **Status:** in progress.
- **Source:** Concord chat 10-13 4:44 pm.

## D-OWNER-FORCE-RELEASE — owner can force-release a lease

- **Date:** 2026-10-13, ~5:10 pm CT.
- **Owner words:** "this inability to force release is not ok we need a spec to fix ... as the human operator i should be able to do this".
- **Decision:** Spec now (freeze exception): Concord #66.
- **Status:** in progress (#66 waits for #65).
- **Source:** Concord chat 10-13 4:44 pm.

## D-CLOSE-RELEASES-LEASES — closing a change releases its leases

- **Date:** 2026-10-13, ~5:10 pm CT.
- **Owner words:** "how did we not catch the bug about closing a change not releasing a lock. this needs a spec asap".
- **Decision:** Spec now (freeze exception): Concord #65.
- **Status:** in progress (Seb owner-override land).
- **Source:** Concord chat 10-13 4:44 pm.

## D-WORKER-FAILURE-SPIKE — spike the 43 worker failure; recommend other spikes

- **Date:** 2026-10-13, ~5:10 pm CT.
- **Owner words:** "spike the 43 luna issue this makes concord basically useless if it can't work properly" and "what else do we need to spike? ... we have 12 hours to get this back on track".
- **Decision:** Worker Failure spike (43-r7) plus recommended spikes.
- **Status:** spike delivered (TRR9MVdyNkEkoYFhYUbyX5).
- **Source:** Concord chat 10-13 4:44 pm.

## D-QA-OPS-SPIKES — launch Bug Escapes and Identity & Operator spikes

- **Date:** 2026-10-13, ~5:20 pm CT.
- **Owner words:** "go".
- **Decision:** Spikes Bug Escapes & Lifecycle Invariants (Q-QA-*) and Agent Identity & Operator Control (Q-OPS-*).
- **Status:** spikes delivered.
- **Source:** Concord chat 10-13 4:44 pm.

## D-FORCE-RELEASE-OWNER-TOKEN — any owner token may force-release (Q-OPS-1 b)

- **Date:** 2026-10-13, ~5:42 pm CT.
- **Owner words:** "b".
- **Decision:** Any owner token may force-release through API, CLI and MCP; supersedes the human-only part of D-LEASE-WAIT-SPIKE/s16b for force-release. #66 resumes from built commit 796f3a0.
- **Status:** active.
- **Source:** Concord chat 10-13 4:44 pm.

## D-PLAN-A-PLUS-C — core-loop bugs first, UI asap, submission in parallel (Q-PLAN-STRATEGY)

- **Date:** 2026-10-13, ~5:45 pm CT.
- **Owner words:** "a + c but by swarms i mean mwcc-rs or decompy for now, motherbase as well" + "theres some core bugs i want to fix first. like 43 and others preventing motherbase and other repos from working" + "we want the ui done asap as well we cant demo without it".
- **Decision:** Core-loop fixes first (bugs blocking Mother Base, gen-v-decomp, mwcc-rs); real-repo swarms, not synthetic; UI asap for the demo; C submission work in parallel. Freeze ends for core bugs and UI.
- **Status:** active.
- **Source:** Concord chat 10-13 4:44 pm.

## D-POLICY-6B-9A — slim decomp policy now; hygiene h1+h2; remind 6D/6E (Q-POLICY-6)

- **Date:** 2026-10-13, ~5:52 pm CT.
- **Owner words:** "6b +9a but dont forget about 6d and 6e lets remind would be cool to get them done by submission".
- **Decision:** Slim decomp policy now (no code) + specs h1 (parse config once per request, 103) and h2 (no policy copies in job records, 104 / #69). Remind Seb of 6D (rules-only generator + re-pin) and 6E (per-repo policy home) as stretch goals by submission.
- **Status:** h1 landed 28c62f4; h2 pending (#69).
- **Source:** Concord chat 10-13 4:44 pm.

## D-TARGET-10-WORKERS — target 10+ concurrent workers on real repos

- **Date:** 2026-10-13, ~5:52 pm CT.
- **Owner words:** "if concord is working right we could run like 10+ workers at the same time".
- **Decision:** Target: 10+ concurrent workers on Mother Base, decomp and mwcc-rs.
- **Status:** target.
- **Source:** Concord chat 10-13 4:44 pm.

## D-ISSUE-CLAIMS-MUST-FIX — issue claims and lease granularity must be fixed

- **Date:** 2026-10-13, ~5:52 pm CT.
- **Owner words:** "dont want to forget the question on leases and claim locks bc that needs to be fixed unless its included in improving core loop".
- **Decision:** Issue claims (#64, Q-ISSUE-LEASE-*) and lease granularity (Q-UNIT-*) must be fixed; not in Strategy A as written, so ask after the core specs.
- **Status:** pending question.
- **Source:** Concord chat 10-13 4:44 pm.

## D-CLI-TOKEN-PROFILE — CLI loads its own token by profile (#67)

- **Date:** 2026-10-13, ~5:55 pm CT.
- **Owner words:** [log paraphrase, via Mother Base] CLI must load its own token by profile so agents never read token files; CREDENTIAL_EXPIRED names principal and expiry.
- **Decision:** Concord #67.
- **Status:** open.
- **Source:** Concord chat 10-13 4:44 pm.

## D-OPUS-NEEDS-OK — no Opus/Claude subagent without Seb's OK

- **Date:** 2026-10-13, ~5:57-5:58 pm CT.
- **Owner words:** "are you still running claude sub agents? remember opus 5.5 was a special exception you need my permission" and "let them finish but stop launching new ones without my permission".
- **Decision:** No Opus/Claude subagent without Seb's explicit OK per launch. Superseded for Concord chats by D-NO-CLAUDE-SUBAGENTS.
- **Status:** superseded.
- **Source:** Concord chat 10-13 4:44 pm.

## D-NO-CLAUDE-SUBAGENTS — Concord chats stop using Claude subagents

- **Date:** 2026-10-13, ~6:10 pm CT.
- **Owner words:** [log paraphrase, via AW] stop using Claude subagents in concord chats (concord was 42% of Mac Claude usage; 30 mostly-Opus subagents = 21%).
- **Decision:** Light mode: SWE-2/Codex implement, review and research through the AW launcher; a Claude subagent only for a short read-only job.
- **Status:** active.
- **Source:** Concord chat 10-13 4:44 pm.

## D-POLICY-4-CODEX-SPIKE — rule changes for existing repos: Codex research spike (Q-POLICY-4)

- **Date:** 2026-10-13, ~6:13 pm CT.
- **Owner words:** "these options seem to complex spike with codex i want research and options, explore options outside these as well".
- **Decision:** Codex research spike on how rule changes reach existing repos, incl. options outside 4A-4C.
- **Status:** spike done (run work-codex-20261013T231353Z-d4e7fea9); questions pending.
- **Source:** Concord chat 10-13 4:44 pm.

## D-65-OWNER-LAND — owner-override land of #65 (Q-65-LAND a)

- **Date:** 2026-10-13, ~6:24 pm CT.
- **Owner words:** "ok im running the command".
- **Decision:** Seb runs the owner-override land of #65 (head 49bd2b1) after four reviews found the code correct.
- **Status:** in progress (re-run ~6:55 pm).
- **Source:** Concord chat 10-13 4:44 pm.

## D-ISSUECLOSE-OWNER-TOKEN — Mother Base closes its 5 issues with the owner token; option C filed (Q-ISSUECLOSE)

- **Date:** 2026-10-13, ~6:14 pm CT.
- **Owner words:** [log paraphrase, via Mother Base] owner token OK for Mother Base's 5 issue closes; option C as an issue.
- **Decision:** Mother Base uses seb-owner for its 5 closes only; agents closing issues of expired same-repo principals filed as Concord #68.
- **Status:** active.
- **Source:** Concord chat 10-13 4:44 pm.

## D-WORKER-NO-ADOPT — a worker run that failed validation is not landed (Q-WORKER-2 a)

- **Date:** 2026-10-13, ~7:00 pm CT.
- **Owner words:** "Q-WORKER-2: a".
- **Decision:** validation-failed is NOT LANDED: the chain never adopts a commit that failed the worker's own validation; the coordinator reads the report and sends one repair. Applied in /tmp/claude-501/concord-path.sh (chains started before 7:00 pm keep the old rule).
- **Status:** active.
- **Source:** Concord chat 10-13 6:48 pm.

## D-DECISIONS-HOME — decisions go in the decisions log, not memory

- **Date:** 2026-10-13, ~7:05 pm CT.
- **Owner words:** "no we have a better place to store decisions, please find it and add to memory to use it instead".
- **Decision:** Owner decisions are recorded here (decisions-seed/decisions.md + decision-status.tsv) until concord-v2 docs/decisions.md lands (s-decisions-d, D-DECISIONS-IN-GIT), then there. Memory keeps a pointer only.
- **Status:** active.
- **Source:** Concord chat 10-13 6:48 pm.

## D-DEPLOY-WORKERS-BUILDS — landed changes deploy through Workers Builds; Concord self-deploy is a stretch goal (Q-DEPLOY-1)

- **Date:** 2026-10-13, ~8:10 pm CT.
- **Owner words:** "a now, c as a stretch goal by submission."
- **Decision:** a: Cloudflare Workers Builds on seb-patron/concord main deploys the Worker on every mirror push (code only; trusted-config policy changes still go through ops/install-trusted.sh). c: Concord deploys itself on landing (post-land hook) is a stretch goal by submission.
- **Status:** active. ~8:25 pm CT Seb connected Workers Builds to the Artifacts namespace concord-demo, repo concord-r-0898953c (concord-v2 canonical), branch main: deploys come from Concord's own canonical main, not the GitHub mirror (Seb: "wait could we connect concord itself from artifacts? instead of thorugh github?" ... "ok done"). c: spec after the lock fixes.
- **Source:** Concord chat 10-13 6:48 pm.

## D-STORAGE-SCALE — storage repo lifecycle: choose the option that scales best (#71)

- **Date:** 2026-10-13, ~8:55 pm CT.
- **Owner words:** "wait so how will this deploy if we keep creating new repos? or its just the -f-* versions? yeah lets do the options that scales best".
- **Decision:** fix #71 (forks and scratch repos never deleted) with the best-scaling design, researched first (Codex spike: fewer repos created + cleanup), then specced and built.
- **Status:** spike done (artifact QfNzczqthjSCUGqn38kXnn); Q-STORAGE-1..6 next, then spec and land.
- **Source:** Concord chat 10-13 6:48 pm.

## D-CLI-MCP-FIRST — agent self-service in the CLI and MCP is a priority

- **Date:** 2026-10-13, ~9:00 pm CT.
- **Owner words:** "why are you not able to clear old dead work? you should be able to. why are we using the cli or mcp? can we prioritize getting the cli and mcp up to date so you can and other agents can use it".
- **Decision:** prioritize CLI and MCP so agents (incl. the coordinator) do routine work themselves without the owner: load credentials by profile, never from token files (#67); list and close their own changes from the CLI and MCP without hand-fetching versions; then supersede/auto-close (Q-CHANGE-2). Order after #35 (same files). Widened ~9:10 pm CT, Seb: "i wnat the cli and mcp to be powerful enough to do everything an agent who uses concord needs" -> full agent parity: parity audit (Codex spike) of every route vs CLI vs MCP, then one spec per missing behavior.
- **Status:** specs 106 (#67) and 107 queued behind 105 (#35).
- **Source:** Concord chat 10-13 6:48 pm.

## D-CHANGE-REVISIONS — a repair is a new revision of the same change (Q-CHANGE-2 a)

- **Date:** 2026-10-13, ~9:02 pm CT.
- **Owner words:** "Q-CHANGE-2:a".
- **Decision:** one stable intent key per work item (cp-<issue>-<lane>); each repair republishes as a new revision of the same change and review evidence binds to the new head. No new change (and fork) per repair round.
- **Status:** applied to the chain template for new launches; verify on the next repair; product gaps (if a reviewed change refuses a new revision) become a spec.
- **Source:** Concord chat 10-13 6:48 pm.

## D-RUNNER-BACKOFF — idle runners back off 1 s -> 30 s with jitter before submission (Q-SCALE-POLL.1)

- **Date:** 2026-10-13, ~9:12 pm CT.
- **Owner words:** "Should idle runners back off from polling every 1 s to every 30 s, with jitter, before submission: yes".
- **Decision:** ship capped idle backoff with jitter in the runner (runner-only, no protocol change), reset on a job; long-poll / WebSocket stay later options (Push Not Poll spike).
- **Status:** landed da2fb26 (spec 108, #70 part 1); #70 part 2 is #75.
- **Source:** Concord chat 10-13 6:48 pm.

## D-ISSUE-CLAIM-SPIKE — research what "claim an issue" means before building it

- **Date:** 2026-10-13, ~9:20 pm CT.
- **Owner words:** "idk with claim an issue maybe both> we might want to spike this".
- **Decision:** Codex research spike on issue claims (assignment, lease, both, or other), covering #64 / Q-ISSUE-LEASE-* / Q-UNIT-*; questions follow the spike.
- **Status:** spike done (artifact GAU8hBkQjNeyZWBEXoM1Vg); Q-ISSUE-CLAIM.1-5 next.
- **Source:** Concord chat 10-13 6:48 pm.

## D-CLOSE-REASON — closing a change takes an optional stored reason

- **Date:** 2026-10-13, 10:22 pm CT.
- **Owner words:** "a an optional reason".
- **Decision:** `concord change close --reason TEXT` (and MCP change_close `reason?`) is optional; when given it is stored in the close event and shown in the change history (UI, CLI, MCP). Closing without a reason still works.
- **Status:** spec after 107 on the cli/main.ts + mcp/tools.ts lane.
- **Source:** Concord chat 10-13 9:32 pm.

## D-CF-CHECKER-MORNING — Cloudflare Containers checker experiment waits for the morning

- **Date:** 2026-10-14, 12:11 am CT.
- **Owner words:** "lets hold off on it until tomorrow morning".
- **Decision:** No container experiment tonight. Said at 12:11 am Wednesday, so "tomorrow morning" means Wednesday morning after sleep (the submission is Wednesday 6 pm CT; Thursday would be after it). Ask Q-CF-CHECKER again Wednesday morning (options: a capped experiment: 1 instance, 15-min job limit, idle sleep, read-only token, stop after 3 checks; b 2-vCPU; c not now). Seb's concern: cost.
- **Status:** deferred to Wed morning.
- **Source:** Concord chat 10-13 9:32 pm.

## D-REVIEW-ORDER — Luna reviews first, SWE-2 is the fallback

- **Date:** 2026-10-14, 12:12 am CT.
- **Owner words:** "Q-REVIEW-ORDER: a".
- **Decision:** Concord chain reviews run on Codex gpt-6-luna first; SWE-2 (swe-2-high) only if Luna's review dies. Replaces the 10-13 ~1 pm rule (SWE-2 first). Reason: SWE-2 reviewers died with no report 7 of 7 times on 10-13 night (~12 min lost each).
- **Status:** live in the chain template (/tmp/claude-501/concord-path.sh) for every launch after 12:12 am.
- **Source:** Concord chat 10-13 9:32 pm.

## D-FILM-PLAN — Wednesday schedule: freeze noon, film 2-4 pm, submit 6 pm

- **Date:** 2026-10-14, 12:15 am CT.
- **Owner words:** "Q-FILM:yes".
- **Decision:** Wed 10-14 (CT): 12:00 pm feature freeze (fixes only after); 1 pm demo dry run (docs/DEMO.md, Mother Base swarm as the live part); 2-4 pm film (5-10 min video); 4-5 pm final secrets/private-name sweep, then make seb-patron/concord public; 6 pm Seb submits the form himself. Hard deadline Thu 10-15 1:59 am CT.
- **Status:** scheduled.
- **Source:** Concord chat 10-13 9:32 pm.

## D-STRANDED-1014 — what happens to the 7 stranded items

- **Date:** 2026-10-14, ~10:45 am CT.
- **Owner words:** "#8 i thought we had worked on a language agnostic system? not sure this makes sense / #11 feel like we should spike to see if theres a better system that could be built into concord thats not tsv files in source control, can we spike that? if #11 is the best option we cna proceed but if something built into concord that requires some changes but is better im down, otherwise we can continue this track / #16 can we spike quickly first to make sure it still fits with the current way concord works / #9 #10 #21 continue / #6 what would it help with".
- **Decision:** #8 (Markdown section units) stays held under D-UNIT-PLUGINS / D-LEASE-LANGUAGE-AGNOSTIC. #11 (keyed-line units): spike first, compare built-in Concord options against keyed lines in TSV files; proceed with #11 only if it is the best option. #16 (lease wait queue): quick fit spike against current main first. #9 (generated files), #10 (path protection), #21 (plan view): continue (repair + land). #6 (runner pin): explained, owner to decide.
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-RUNNER-PIN-GO — build #6 runner profile pin now

- **Date:** 2026-10-14, ~11:05 am CT.
- **Owner words:** "#6 do it".
- **Decision:** Repair and land stranded #6 (check profiles pin the check config, not Mac executables, so the i7, PC and container checkers can run checks). Lifts the 10-13 hold on config-pin work for #6.
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-CF-CHECKER-GO — run the capped Cloudflare Containers checker experiment

- **Date:** 2026-10-14, ~11:05 am CT.
- **Owner words:** "Q-CF-CHECKER: lets do it but be carefule with costs".
- **Decision:** Option a: capped experiment (1 instance, 15-min job limit, idle sleep, read-only token, stop after 3 checks). Cost caps are binding.
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-LEASE-WAIT-V2 — close #16 as built; spec a newer wait queue and try to land it before submission

- **Date:** 2026-10-14, ~11:05 am CT.
- **Owner words:** "#16 lets close it, then spike a spec for the newer better version and lets try to finish before submission".
- **Decision:** Close stranded #16 (10-13 build). A spike writes a spec for a wait queue that fits main (lease-wait-fit.md); implement and land it before submission if possible.
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-FREEZE-2PM — feature freeze moves from noon to 2 pm CT

- **Date:** 2026-10-14, ~11:05 am CT.
- **Owner words:** "im moving the freeze to 2pm so we have more tiem".
- **Decision:** Feature freeze at 2:00 pm CT Wed 10-14 (was 12:00 pm in D-FILM-PLAN). Fixes only after 2 pm. Other D-FILM-PLAN times unchanged unless Seb says.
- **Status:** active.
- **Source:** Concord chat 10-14 7:16 am.

## D-SYMBOL-LEASES — symbol leases alongside file leases, from git's own function rules, as a milestone project

- **Date:** 2026-10-14, ~11:45 am CT.
- **Owner words:** "ok agree on , build symbol leases alongside file leases, using git's own function rules and no per-language code. With the whats holding us back, lets properly spec out everything needed. i say this whole thing gets its own milestones and issues. i can authroize some claude agents if it would be faster. but first i want the login and ui working so i can track the progress on this."
- **Decision:** Q-UNIT-SYMBOL a. Agents keep file leases and may also lease `symbol:path#name`; symbols come from git's built-in funcname (userdiff) rules plus config regexes, with no per-language code in Concord. Spec every blocker (verifier proof, declare-before-edit, identical key derivation in CLI/runner/server, the open Q-UNIT questions) as issues in a dedicated Concord milestone. Order: login (Cloudflare Access) and UI first so Seb can track it; then Q-UNIT questions one at a time with background; then the milestone, issues and specs. Claude agents are offered by Seb if faster (not yet used).
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-UNIT-1-EXCLUSIVE — a lease stays an exclusive lock, now at symbol size

- **Date:** 2026-10-14, ~11:50 am CT.
- **Owner words:** "Q-UNIT-1:a".
- **Decision:** A lease remains an exclusive write lock on its unit (file or, with D-SYMBOL-LEASES, symbol). Shared intent / hybrid modes wait for a land-time merge (Q-UNIT-4).
- **Status:** active (symbol units in progress under D-SYMBOL-LEASES).
- **Source:** Concord chat 10-14 7:16 am.

## D-LEASE-QUEUE-AUTO — a refused lease request is queued automatically and tells the agent who holds it and the expected wait

- **Date:** 2026-10-14, ~11:50 am CT.
- **Owner words:** "also do we have plans for a lease queue? seems useful so that way a rejected lease request could get auto queued and the agent maybe even gets a note on estimated wait time (current lease expiration barring renewal, what agent has the lease, what the work is, what issue, etc)?"
- **Decision:** Follow-up on spec 116 (lease wait v2): a refused claim is queued automatically (agent path default, opt-out allowed), and the refusal/queue status carries the advisory wait estimate (holder lease expiry, barring renewal), holder agent, its intent text and issue.
- **Status:** decided; spec after 116 lands.
- **Source:** Concord chat 10-14 7:16 am.

## D-UNIT-4-STRUCT-MERGE — add a structure-aware merge step at land (milestone issue, after symbol core)

- **Date:** 2026-10-14, ~11:55 am CT.
- **Owner words:** "Q-UNIT-4: b".
- **Decision:** The checker gains an opt-in, sandboxed structure-aware merge step (Mergiraf-class) with fallback to git's line merge; the full suite still runs on the result. Language knowledge lives only in the merge tool, never in lease identity. Built as an issue in the symbol-lease milestone after the core symbol leases land. Conflict records (option c) go to the post-submission "is git the problem" spike.
- **Status:** decided; in the symbol-lease milestone.
- **Source:** Concord chat 10-14 7:16 am.

## D-UNIT-6-REGEN — generated files are rebuilt at land; exclusive lock only where the generator can't run on the checker

- **Date:** 2026-10-14, ~12:00 pm CT.
- **Owner words:** "Q-UNIT-6: b with c as a fallback for a generator that can't run on the checker."
- **Decision:** Generated outputs are regenerated at land (#9, s9); a generator that cannot run on the checker (e.g. decomp generators that need the ROM) falls back to an exclusive lease on its outputs.
- **Status:** #9 approved, landing; fallback to spec in the symbol-lease milestone.
- **Source:** Concord chat 10-14 7:16 am.

## D-UNIT-7-DRAFTS — close #8 (replaced by symbol leases); #11 waits for its spike

- **Date:** 2026-10-14, ~12:05 pm CT.
- **Owner words:** "Q-UNIT-7: a, the tsv i think is bc the decomp and mwcc-rs repos use it for tracking work but i think concord could replace this with a built in system potentially lets see what the spike says".
- **Decision:** Close #8 (Markdown section units): symbol leases from git funcname rules cover Markdown headings. #11 (keyed lines) waits for the keyed-data spike; Seb leans toward a Concord built-in tracking system replacing work-tracking TSVs in decomp and mwcc-rs.
- **Status:** active.
- **Source:** Concord chat 10-14 7:16 am.

## D-LANDING-SPIKE — spike why landing is slow and whether disjoint changes can land in parallel

- **Date:** 2026-10-14, ~12:05 pm CT.
- **Owner words:** "we need to spike this landing issue, the tests suite exploded and i thought we had worked to improve it and reduce how long it takes? is there no way to do parrallel landings for things that dont touch each other? is this possible? feels slow for swarm work?"
- **Decision:** Research spike on landing throughput: serial promotion, full-suite checks per land, suite growth, parallel landing of disjoint changes, test selection, sharding, checker capacity.
- **Status:** spike running.
- **Source:** Concord chat 10-14 7:16 am.

## D-LAND-FIX-NOW — an admission no longer cancels the running landing check; land before the 1 pm swarm

- **Date:** 2026-10-14, ~12:20 pm CT.
- **Owner words:** "yes spec the fix to the slow landing and lets fix before the 1pm swarm".
- **Note:** the fix deadline is "before the Mother Base swarm"; the swarm itself later moved to no earlier than 2 pm CT (D-FREEZE-3PM), and still waits for this fix.
- **Decision:** Spec and land, before the 1 pm Mother Base swarm, the fix for src/features/queue.ts:416 (`bump(..., 'ADMITTED')` resets the in-flight stack on every admission). Other landing causes (lease loss during review, STALE_MAIN churn, test tiers, speculative stacks) become issues in a landing milestone.
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-CFEXP-R2 — one more repair for the containers experiment

- **Date:** 2026-10-14, ~12:20 pm CT.
- **Owner words:** "Q-CFEXP: a".
- **Decision:** One extra repair (beyond the one-shot rule) for the capped containers experiment: reject oversized request bodies while reading (16 KiB cap enforced during the stream) and split timeout timing by phase.
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-UI-CONCORD-V2-ONLY — Seb's UI shows only concord-v2 and opens on it

- **Date:** 2026-10-14, ~12:35 pm CT.
- **Owner words:** "dont show these other repos and open to concord v2 each time".
- **Decision:** Seb's Access login maps to repoIds ["concord-v2"] (trusted config humans entry), so the repo picker lists only concord-v2 and the UI opens on it. Other repos stay reachable for agents and tokens.
- **Status:** superseded by D-UI-WORK-PROTOTYPES (Seb ~12:45 pm: "yes i want motherbase visible as well"): the login now maps to repoIds ["concord-v2","mother-base-v2"] and still opens on concord-v2.
- **Source:** Concord chat 10-14 7:16 am.

## D-UI-WORK-PROTOTYPES — the UI follows the approved Work UI prototypes (GitHub-like, light), not the Synthesis desk

- **Date:** 2026-10-14, ~12:45 pm CT.
- **Owner words:** "also i wnat the light mode and toggle able dark mode. some decisions were lost. the recommended synthesis looks like some kids toy. i had approved a code ui that looked more like github with an agent tab to see what agetns get. it had an issues and milestones tab, pls a view of what was in glight. somehow this got lost. now i need you to either find it or recreate it. this is ridiculous" and "yes i want motherbase visible as well".
- **Decision:** Rebuild the web UI shell to the "Concord Work UI prototypes" canvas (RN5EetGqopPCvZBU1uDaak, 10-12): light theme by default with a dark-mode toggle; GitHub-like header and tabs (Code with For humans / For agents, Tracker/Issues, Plan, Milestones) plus an In flight view (work in progress, fleet, leases, queue). Seb's login sees concord-v2 and mother-base-v2, opening on concord-v2; this supersedes the single-repo login scope of D-UI-CONCORD-V2-ONLY. Supersedes the Synthesis dark fleet desk as the main look (D-UI-FLEET-DESK).
- **Status:** in progress.
- **Source:** Concord chat 10-14 7:16 am.

## D-UI-PROFILE-MENU — Work UI prototypes approved; add a GitHub-style profile menu and inbox at top right

- **Date:** 2026-10-14, ~12:50 pm CT.
- **Owner words:** "YES!! great!!! awesome!! i love it! one more tweak: github has a little profile section on the rop right along with an inbox. can we do that as well? the inbox can be a placeholder just when a human needs to be alerted (ie planning, or landing issue, etc) plus having the user profile pic would be huge. here is mine. it doesnt need all the options maybe just placeholders + working links to the repos here later we can respike what it should look like (post competition i think its worth investigating if concord is a self host tool or something we host for others like github. Also we can tie in the sign out to the acutal cloud flare sign up".
- **Decision:** The Work UI prototypes (RN5EetGqopPCvZBU1uDaak) are confirmed as the UI (spec 121). Follow-up spec 123: top-right inbox icon with a count of things a human must handle (planning, landing problems) opening the Inbox, and a profile avatar menu (avatar from an optional avatarUrl on the human mapping, initials fallback; name; links to the viewer's repos; placeholder items; theme toggle; Sign out = Cloudflare Access logout). Post-competition spike: self-hosted tool vs hosted service (D-HOSTING-SPIKE-LATER).
- **Status:** 121 building; 123 after 121 lands.
- **Source:** Concord chat 10-14 7:16 am.

## D-HOSTING-SPIKE-LATER — after the competition, spike whether Concord is a self-hosted tool or a hosted service

- **Date:** 2026-10-14, ~12:50 pm CT.
- **Owner words:** "post competition i think its worth investigating if concord is a self host tool or something we host for others like github".
- **Decision:** No change before submission. After the competition, run a spike comparing Concord as a self-hosted tool against a hosted service for others (like GitHub).
- **Status:** deferred until after submission.
- **Source:** Concord chat 10-14 7:16 am.

## D-FREEZE-3PM — feature freeze moves from 2 pm to 3 pm CT; Mother Base swarm at 2 pm

- **Date:** 2026-10-14, ~12:50 pm CT.
- **Owner words:** "tell moterbase to delay swarm to 2pm, we are delaying code freeze until 3pm".
- **Decision:** Feature freeze at 3:00 pm CT Wed 10-14 (was 2 pm, D-FREEZE-2PM). The Mother Base swarm starts no earlier than 2 pm CT (and still only after the landing fix 118 is live).
- **Status:** active.
- **Source:** Concord chat 10-14 12:42 pm.

## D-CFEXP-R3 — one more repair for the containers experiment's alarm/run race

- **Date:** 2026-10-14, ~12:50 pm CT.
- **Owner words:** "Q-CFEXP-R3:: a".
- **Decision:** One more repair of cfexp-checker: when the 15-minute alarm has already finished a run, /run returns the persisted alarm result (no contradicting pass or 500), with a test of the in-flight response and stored status.
- **Status:** in progress.
- **Source:** Concord chat 10-14 12:42 pm.

## D-SYMBOL-TIMING — build symbol leases now; land what is ready by the 3 pm freeze, the rest before submission

- **Date:** 2026-10-14, ~12:55 pm CT.
- **Owner words:** "Q-SYMBOL-TIMING: a".
- **Decision:** Launch the symbol-lease specs (#91 keys, #89 units, #90 verify at land, #92 start/grow) in dependency order as soon as each is checked against main. Changes done by the 3 pm freeze land then; the rest land after filming and before submission.
- **Status:** in progress.
- **Source:** Concord chat 10-14 12:42 pm.

## D-PILOT-OPENROUTER — run an OpenRouter pilot (3-5 small Concord tasks) on DeepSeek-v4-flash

- **Date:** 2026-10-14, ~1:15 pm CT.
- **Owner words:** "Q-PILOT: yes".
- **Decision:** Run 3-5 small, non-critical Concord tasks on openrouter/deepseek/deepseek-v4-flash through the AW launcher (caps $1/run, $10/day shared with decomp); Luna reviews; run dirs go to the AW chat for the pilot report.
- **Status:** in progress.
- **Source:** Concord chat 10-14 12:42 pm.

## D-UI-POLISH-FREEZE — UI polish spec 130 may land after the 3 pm freeze

- **Date:** 2026-10-14, ~1:45 pm CT.
- **Owner words:** "Q-UI-POLISH-FREEZE: a".
- **Decision:** Freeze exception for spec 130 only (GitHub-style owner/repo header without the dropdown, Code view details, clone panel with git / Concord / GitHub mirror options, signed-in UI never hits the anonymous rate limit), because it is the UI the video shows. It builds after 123 and lands before filming.
- **Status:** in progress.
- **Source:** Concord chat 10-14 12:42 pm.

## D-POLL-SPIKE — spike live UI updates (#110) before building any polling change

- **Date:** 2026-10-14, ~2:00 pm CT.
- **Owner words:** "i thought we had fixed the constant polling? or is this a different issue? why every 5 seconds when active? can we spike this to get the better long term solution i want to make sure you arent just responding without thinking. Make 110 spiked first."
- **Decision:** Spec 132 (adaptive 5 s -> 30 s polling) is held. A Sol spike researches the long-term design (long-poll, SSE, hibernatable WebSockets, one shared event stream, snapshot row-read cost) with measured Cloudflare usage; implementation specs come from it.
- **Status:** spike running.
- **Source:** Concord chat 10-14 12:42 pm.

## D-FREEZE-4PM — feature freeze at 4 pm CT

- **Date:** 2026-10-14, ~2:05 pm CT.
- **Owner words:** "Q-SCHEDULE: freeze at 4pm".
- **Decision:** Feature freeze moves to 4:00 pm CT (was 3 pm, D-FREEZE-3PM); filming after the freeze; D-UI-POLISH-FREEZE (spec 130 may land after the freeze) still applies.
- **Status:** active.
- **Source:** Concord chat 10-14 12:42 pm.

## D-CHANGE-LIMIT-64 — raise the active-change limit to 64 per repo and clean up stale changes automatically

- **Date:** 2026-10-14, ~2:35 pm CT.
- **Owner words:** "let's increase changes to 64. we need better cleanup of the change count this keeps happening".
- **Decision:** trusted config costLimits.maxActiveChangesPerRepo = 64 (live after install-trusted.sh); #60 gets a spec for automatic cleanup so stale drafts, superseded and orphaned changes stop counting against the limit.
- **Status:** config written; needs install-trusted.sh; cleanup spec in the throughput spec spike.
- **Source:** Concord chat 10-14 12:42 pm.

## D-POLL-FIX-FIRST — stop constant Durable Object polling; the fix lands first

- **Date:** 2026-10-14, ~2:50-2:58 pm CT.
- **Owner words:** "why did we engineer the durable object to be constantly polled this makes no sense"; "we need to get this fix to the front of the line asap"; "then force land the fix for constant durable object polling".
- **Decision:** web UI stops background polling and loads on demand (page load, tab focus, navigation, Refresh button) = Q-LIVE-UPDATES option a (spec 141, #110); `concord land` waits back off to 10 s and read version without the snapshot (spec 142, #75). Both jump the queue. WebSocket push stays after submission.
- **Status:** 141 and 142 building (Luna).
- **Source:** Concord chat 10-14 2:39 pm.

## D-FORCE-LAND — owner-only, audited force land (Q-FORCE-LAND a)

- **Date:** 2026-10-14, ~3:05 pm CT.
- **Owner words:** "yes build now rn the video wouldn't work bc of these issues" (to Q-FORCE-LAND, recommendation a); earlier "can we force land those 4 changes that were approved"; 10-13 3:52 pm "not ok. fucking force it".
- **Decision:** a: owner token may force-land an approved change (still needs a clean rebase); skips only the stack validation; audited ('queue.forced' event, "Forced by owner" badge). Spec 143, Concord #59.
- **Status:** building.
- **Source:** Concord chat 10-14 2:39 pm.

## D-FORCE-MAIN-1014 — outage: canonical main force-updated outside the queue

- **Date:** 2026-10-14, ~3:20-3:35 pm CT.
- **Owner words:** "bro just overwrite the main codebase ... this is an outage now it needs to be force fixed"; "ok the apply and push the copy of main"; "manual mode go".
- **Decision:** coordinator composed 118, 124, 121, 128, cfexp, 139, 141 (polling fix; conflict with 121 resolved by hand), 140 onto 98a3611; typecheck clean, full suite 45/45 files passed; pushed to canonical concord-r-0898953c... main 98a3611 -> 5d0707a (force-with-lease). Workers Builds deployed it (live app.js has the Refresh button, 3:36 pm).
- **Status:** done; Concord queue/change records still show those changes unlanded (reconcile); GitHub mirror push denied by Seb's permission prompt.
- **Source:** Concord chat 10-14 2:39 pm.

## D-FREEZE-5PM — feature freeze moves to 5:00 pm CT

- **Date:** 2026-10-14, ~3:58 pm CT.
- **Owner words:** "im extending the freee to 5pm but then we really need to have this ready for submission".
- **Decision:** freeze 5 pm CT (was 4 pm, D-FREEZE-4PM); submission readiness right after.
- **Status:** active.
- **Source:** Concord chat 10-14 2:39 pm.

## D-PUSH-AFTER-SUBMISSION — runners and UI move from polling to WebSocket push after submission

- **Date:** 2026-10-14, ~4:20 pm CT.
- **Owner words:** "it’s not the number of checkers it then constantly polling? ... i pick the websocket push after submission".
- **Decision:** after submission, checkers/promoters and the web UI get live work and updates over hibernatable WebSockets from the repo DO (option a); tonight only 144 (cheap polls) and fewer runners.
- **Status:** active (post-submission).
- **Source:** Concord chat 10-14 2:39 pm.

## D-UI-FIXES-PAST-FREEZE — UI fixes may land after the 5 pm freeze

- **Date:** 2026-10-14, ~4:50 pm CT.
- **Owner words:** "allow the ui fixes past the freeze."
- **Decision:** UI fixes (130 polish, 145 nav/logo colors, 146 Code view read limit, and similar UI bug fixes) may land after the 5 pm freeze, before filming/submission.
- **Status:** active.
- **Source:** Concord chat 10-14 2:39 pm.

## D-OPUS-SUBAGENTS-1014 — Opus 5.5 subagents for the call audit and the video

- **Date:** 2026-10-14, ~4:50 pm CT.
- **Owner words:** "i want an opus 5.5 subagent to investigate, find them all, and put them into a milestone and issue to fix"; "can we can an opus 5.5 subagent to also read the script and work on finalizing it ... would love opus to help with video".
- **Decision:** two Claude Opus 5.5 subagents (owner override of the light-mode no-subagent default): (1) excessive polling/reads/calls audit -> Concord milestone + issues; (2) video script finalization + recording list + what Opus can produce itself.
- **Status:** running.
- **Source:** Concord chat 10-14 2:39 pm.

## D-CFEXP-HOLD — no container checker experiment before submission

- **Date:** 2026-10-14, ~4:58 pm CT.
- **Owner words:** "lets hold off on the experiment worker rn bc we are too close to 5pm. can we stop the container stuff as well?"
- **Decision:** do not deploy or run the checker-exp Worker / Cloudflare Container tonight (Q-CFEXP-RUN b); nothing was deployed (script 404); cancelled the pending secret prompt.
- **Status:** active.
- **Source:** Concord chat 10-14 2:39 pm.

## D-FREEZE-5PM-FINAL — 5 pm: no new work launched; already-queued work finishes

- **Date:** 2026-10-14, ~5:00 pm CT.
- **Owner words:** "5pm launch no new work but everything already queued let finish".
- **Decision:** from 5 pm no new specs/launches; everything already launched or queued (rebases, repairs, publishes, landings, the two Opus subagents) may finish and land.
- **Status:** active.
- **Source:** Concord chat 10-14 2:39 pm.

## D-WORKING-NOW-AND-PERF — grouped Working-now panel and load-time fixes after 5 pm

- **Date:** 2026-10-14, ~5:05 pm CT.
- **Owner words:** "yes build the panel group now we need it for the video ..."; "also need to fix super slow load times for readme files, tracker, everything loads too slow".
- **Decision:** Q-WORKING-NOW a (147 grouped panel, #124) plus load-time fixes 148 (canonical read cache, #125) and 149 (snapshot memo + ETag, #126) launched after 5 pm as owner-approved exceptions to D-FREEZE-5PM-FINAL.
- **Status:** building.
- **Source:** Concord chat 10-14 2:39 pm.

## D-AUDIT-P0-TONIGHT — launch call-audit P0s after Working now is ready

- **Date:** 2026-10-14, ~5:25 pm CT.
- **Owner words:** "Q-AUDIT-P0: a, launch them once the working now shows the agents actually working ...".
- **Decision:** call-audit P0s #127-#131 launch after 147 (grouped Working now) lands.
- **Status:** queued.
- **Source:** Concord chat 10-14 2:39 pm.

## D-HIDE-DEMO-REPOS — hide demo repos and open on concord-v2

- **Date:** 2026-10-14, ~5:25 pm CT.
- **Owner words:** "can we hide all these demo repos ... and start the first page load on concord-v2 not a demo".
- **Decision:** spec 150 hides demo repos and defaults to concord-v2 (after 130 lands). Video shows Concord developed on Concord.
- **Status:** queued.
- **Source:** Concord chat 10-14 2:39 pm.

## D-FORCE-BATCH-B — force-batch the validated UI and speed fixes

- **Date:** 2026-10-14, ~5:30 pm CT.
- **Owner words:** "Q-FORCE-BATCH:b".
- **Decision:** compose 146, 148, 144, 145, 130 (validated, tests passing) onto main, full suite once, push to canonical main; queue/lease logic changes (133, 138, 137, 129, 131) and 122 keep normal review.
- **Status:** in progress.
- **Source:** Concord chat 10-14 2:39 pm.

## D-VIDEO-REMAKE — footage-first video after UI and speed fixes land

- **Date:** 2026-10-14, ~5:45 pm CT.
- **Owner words:** "video feels too much like a slide show. lets remake once the ui fixes and speed up are all in, with footage actually of the app, showing how it works. i feel like some of thesee things can pop up over using the app?"
- **Decision:** remake: real app + terminal footage (Opus may record scripted read-only browser footage), slides become pop-up overlays; low-volume royalty-free music.
- **Status:** preparing.
- **Source:** Concord chat 10-14 2:39 pm.

## D-VIDEO-KEEP-REVISE — keep cut and revise script (supersedes D-VIDEO-REMAKE)

- **Date:** 2026-10-14, ~5:47 pm CT.
- **Owner words:** "actually just keep it and tell me where to film over using the app. also we dont mention symbol leases? can we revise to include that ... how humans drive the issue, milestones, planning, and resolving conflicts or reviews that need a human, and that this can be configured on a per file basis".
- **Decision:** keep the 7:03 cut; add a film-over table (app footage under slide segments, slides as pop-ups); revise script for symbol leases, human-driven planning/review/conflict resolution, per-file protection levels.
- **Status:** in progress (Opus video agent).
- **Source:** Concord chat 10-14 2:39 pm.

## D-VIDEO-FACECAM-NOLIMITS — no limitations in form or video; facecam intro (2026-10-14)
- **Date:** 2026-10-14, ~5:55-6:15 pm CT.
- **Owner words:** "dont mention what the prototype cant do yet" (submission answers); "i need to do the intro with face cam so they know its a human ... ill do the rest of the voiceover however you want".
- **Decision:** form answers and video mention no limitations; S24 "honest limits" rewritten to a no-caveat line; a ~20 s facecam intro opens the video and replaces the S02 title card.
- **Status:** in progress (video helper chat; Opus prep agent building a minimum timeline, safety-net MP4 and 10 pm runbook).
- **Source:** Video helper chat 10-14.

## D-10PM-PERFECT — everything fixed by 10 pm; Seb submits at 10 pm

- **Date:** 2026-10-14, ~6:25 pm CT.
- **Owner words:** "i now will come back at 10pm to submit. i need all ui and speed fixes done by then. i want all the excessive calls and polling fixed by then. i need this to be perfect for the demo, i want no more issues. fix all the outtage issues asap. put my profile pic into the app like i asked several times. remove the demo repos like ia sked. make sure nothing slips".
- **Decision:** by 10 pm CT: all UI fixes, speed fixes, call-efficiency milestone (7312ba8a) fixes, outage/queue fixes landed and live; avatar = the brown Snoopy image Seb sent (6:25 pm); demo repos hidden, open on concord-v2.
- **Status:** in progress.
- **Source:** Concord chat 10-14 2:39 pm.

## D-VIDEO-SCRIPT-V3 — revise full script and animatic (2026-10-14)
- **Date:** 2026-10-14, ~6:20 pm CT.
- **Owner words:** "at 9pm redo the script. no mentions of what isnt working. mention the symbol lease. redo the initial video as well. update the script. make it sound less like a sales pitch and more in my voice. make it so it explains the problems clearly up front. mention how this is meant for swarms of agents"
- **Decision:** at ~9 pm CT, rewrite the full script and re-render the animatic: problems first, symbol leases in, swarm framing, Seb's plain voice, no limitations. Seb records at 10 pm CT.
- **Status:** scheduled (video helper chat, one-shot 8:57 pm CT).
- **Source:** Video helper chat 10-14.

## D-GITHUB-UI — Issues/Milestones like GitHub; Settings replaces In flight; GitHub-replaceable UI milestone

- **Date:** 2026-10-14, ~6:40 pm CT.
- **Owner words:** "this milestones ui is still trash, and it should be issues/milestones ..."; "get rid of inflight. we need a repo settings menu up there instead"; "the issues needs a more github esque ui ... with assigned to, tags ... searchable ... add that as a milestone to fix the full ui and make it more github replaceable".
- **Decision:** milestone "GitHub-replaceable UI" (a3c7b110-3e6d-445d-b0cd-e4a12d262047) with specs 172 (nav+Settings, #152), 173 (Issues list, #153), 174 (Milestones list, #154); assignee = agent(s) holding leases for the issue.
- **Status:** building.
- **Source:** Concord chat 10-14 2:39 pm.

## D-AGENT-FIRST-HUMAN-CONTROLS — GitHub-replaceable but agent-first; human control surface

- **Date:** 2026-10-14, ~6:40 pm CT.
- **Owner words:** "github replaceable but agent first. humans are not allowed to open changes for landing. they should have a good ui for managing issues/milestones, tracking planning, bumping changes queued for landing, cancelling work to release leases, and locking files for human review only, and also a way to apply a human review. maybe some rules too that can be configured like ui changes need a human approval to land always, rules that can be configured but dont configure them for this repo".
- **Decision:** UI milestone a3c7b110 scope: humans manage issues/milestones/planning, bump queued changes, cancel work (release leases), lock paths for human review, apply human reviews; configurable landing rules (e.g. UI paths need human approval) exist but are NOT configured on concord-v2; humans never open changes for landing.
- **Status:** to spec (successor).
- **Source:** Concord chat 10-14 2:39 pm.

## D-LEASE-BOTTLENECK-ASAP — fix lease serialization of landing now (Seb AFK until 10 pm)

- **Date:** 2026-10-14, ~6:58 pm CT.
- **Owner words:** "bro i'm afk i wont be back until 10. why didn't you raise this earlier? it needs to be fixed asap the point of concord is it multi agents this blocks concords usefulness".
- **Decision:** top priority tonight: published changes must stop blocking other agents' publishes on the same files for their whole check/review/queue lifetime (file leases serialize multi-agent work). Spec + land through the queue now; no manual-mode force batch is possible before 10 pm (Seb AFK).
- **Status:** in progress.
- **Source:** Concord chat 10-14 6:35 pm.

## D-BOTTLENECK-FIRST — order: lease bottleneck, then excess calls (DO usage), then everything else

- **Date:** 2026-10-14, ~7:08 pm CT.
- **Owner words:** "fix the bottleneck first before trying to land anything else. don't let this bottleneck pile up. then fix all the excess calls bc we are at my durable storage usage and im about ti pay for usage. then fix everything else".
- **Decision:** pause publishing/landing of every other change until the lease-bottleneck fix (spec 181) lands; then the call-efficiency milestone (7312ba8a) lands first; then UI and the rest. Cut Concord DO traffic now (fewer checkers, no idle chain polling).
- **Status:** active.
- **Source:** Concord chat 10-14 6:35 pm.
