# Claims design repair ledger

Independent review of the claims design, 16 October 2026. Each row identifies the reviewed finding, the repair in the current design file, and its status. “Fixed” means the design gives a build rule or an explicit unavailable result; it does not claim that a prototype or a repository check has run. Section and line numbers refer to `c123-claims-design.md` in this change.

| Review finding | One-line summary | What changed in the design | Status |
| --- | --- | --- | --- |
| Review finding (R1) | Unstaffed custody could last indefinitely. | Issue lifecycle, lines 58–118: timed Intervention, automatic release, owner cancel and synchronized diagram/table. | Fixed |
| Review finding (R2) | Child repair had no fresh writer authority. | Queued changes, lines 148–154; prototype rules, lines 163–166: phase-specific revocation and fresh issue/code authority for every replacement. | Fixed |
| Review finding (R3) | Git ref movement and cancellation lacked a race contract. | Git substrate, line 162: durable intent, serialized cancel/CAS decision and before/after-CAS recovery. | Fixed |
| Review finding (R4) | Aggregate events could not recover authoritative state. | Observability, line 167: complete identity, unit, deadline, fence, policy and ref payloads with state/log recovery. | Fixed |
| Review finding (R5) | Preview tree omitted commit ancestry and child delta mapping. | Queued changes, lines 148–154: preview commit chain, child parent, explicit-base transplant and landed-commit mapping. | Fixed |
| Review finding (R6) | Issue edits, owner close and reopen left stale operations possible. | Issue lifecycle, lines 64–118; issue custody, line 163: version acknowledgment, result invalidation, close revocation and new reopen generation. | Fixed |
| Review finding (R7) | Releasing an empty hold did not break FIFO cycles. | Code handover, lines 131–135: graph includes queued blockers; youngest wait is withdrawn and requeued; exact X/Y fixture. | Fixed |
| Review finding (R8) | Final diffs could not establish discovery and progress events. | Replay extraction, lines 177–183: provenance fields, issue grouping, observed/scenario split and extraction audit. | Fixed |
| Review finding (R9) | Policy arms had ambiguous event schedule and no finite run bounds. | Replay schedule, line 183; Git substrate, line 162: fixed arrivals, derived queue events, capacity, ordering, cutoffs and retry/watchdog caps. | Fixed |
| Review finding (R10) | New combined trees lacked runnable checks and review oracle. | Checks and review oracle, line 173; measurements, line 197: literal per-attempt commands, prerequisites, unavailable rules, revision-bound review, explicit revert and CPU accounting. | Fixed |
| Review finding (R11) | Symbol experiment could collapse to file fallback. | Symbol slice, line 171; comparison, line 200: pinned Python AST finder, canonical keys, overlap fixtures and matched file/symbol cohort. | Fixed |
| Review finding (R12) | Rate, recovery and hoarding measures were ambiguous. | Measurements, lines 187–197: explicit rate equations, two recovery clocks and union of overlapping holds. | Fixed |
| Review finding (R13) | Automatic enqueue and human code-wait controls were missing. | Code handover, lines 131–135; prototype rule, line 164: default/opt-out, holder diagnostics, pause and priority semantics. | Fixed |
| Review finding (R14) | Chubby fencing statement overstated its source. | Prior art, line 35: sequencers and weaker lock-delay distinguished; Concord fencing rationale stated separately. | Fixed |
| Review finding (R15) | Important terms and a worked lifecycle example were absent. | Terms, lines 13–21; issue lifecycle, lines 58–118; measurements, line 187: terms, evidence labels, maximum-age explanation and example. | Fixed |
| Review finding (R16) | Update-ref example omitted its ref argument. | Git substrate, line 162: complete `git update-ref refs/heads/main NEW OLD` form. | Fixed |
| Review finding (R17) | Extra blank lines appeared at end of file. | End of design, line 208: single final newline, without surplus blank lines. | Fixed |

The design remains a proposal under the owner-approved local research plan (D-RESEARCH-PLAN-2-GO). The owner retains choice of product limits and any future policy change; no new owner decision was needed to repair these findings. The status record for existing decisions is unchanged because this documentation change does not deliver a product decision.
