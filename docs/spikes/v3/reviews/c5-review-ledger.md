# Lease renewal prototype review ledger

This ledger covers the findings in the supplied final delta review and the earlier Opus and Astra reviews. “Fixed” means the artifact now implements or tests the correction and the report limits its claims to what this model shows. It does not mean production behavior has been verified. No item is marked fixed solely because a previous ledger said so.

| Finding | Status | Current evidence |
|---|---|---|
| O1 — Safety count did not measure protected writes | fixed | `renewal.ts`: attempted writes use a guard and a separate grant-state monitor for owner, fence, expiry and epoch. Tests show always-accept and expiry-blind guards produce violations. |
| O2 — Session, multi-unit and restart behavior missing | fixed | Two edit units share session renewals; off-grid restart events and epoch refresh are modeled; counters are in `output.txt`. |
| O3 — Clock drift and restart faults ineffective | fixed | Clock rate changes heartbeat timing; restart events are delivered when a step crosses their timestamp and are asserted. |
| O4 — Server could see abandonment without a signal and retention cost was hidden | fixed | Unannounced abandonment does not stop phase extension; explicit cancellation releases permission. Dead-held time is reported. |
| O5 — Core renewal, claim, grace and phase mutations escaped | fixed | Tests assert stable renewal fences, exclusive live claims, lapse bounds, repeated recovery and phase renewal. Grace-disable and fence-increment mutations fail assertions. |
| O6 — Combined design and recommendation exceeded evidence | fixed | Combined arm is modeled; report confines findings to the simulated workload and leaves policy selection open. |
| O7 — Later abandonment did not clear review loss | fixed | Review-loss result is returned only for scenarios never abandoned; a regression fixture abandons after review loss. |
| O8 — Renewal paths and extension costs were unclear | fixed | Expired renewal is refused; client renewals and server extensions have separate counters; renewal stops after loss. |
| O9 — Seed pairing and uncertainty were unclear | fixed | 200 paired seeds per size, independent size seed ranges, and intervals across seeds are retained. |
| O10 — Editing duration and timing distributions unsupported | fixed | Editing and queue timing are explicit assumptions. Inspection uses the supplied measured quantile anchors; review uses the supplied range and median with its assumed within-band shape stated. |
| O11 — Grace source was conflated with Chubby | fixed | Report distinguishes lease-lapse recovery from Chubby’s master-outage recovery and identifies inherited source provenance. |
| O12 — Outage-duration split and abandonment filtering absent | fixed | Output separates outages at 45 seconds; review loss excludes any scenario later abandoned. |
| O13 — Report readability and terminology needed repair | fixed | Plain summary first; glossary defines terms; names precede technical distinctions; findings do not rely on unexplained shorthand. |
| O14 — Owner approval boundary was misstated | fixed | Report says the owner approved these offline tests on 2026-10-15 and that a live pilot needs separate approval. |
| O15 — Repeated simulation recovery remained broken | fixed | Recovery state is per lapse and separate before and after publication; regression test requires two recoveries in one scenario. |
| R01 — Astra safety accounting incomplete | fixed | Same independent grant-state monitor and guard-mutation assertions as O1. |
| R02 — Successful renewal and stable fence lacked sufficient coverage | fixed | Lease unit tests assert expiry extension without fence change; server-phase behavior is separately measured. |
| R03 — Ordinary renewal and recovery after expiry unclear | fixed | Ordinary renewal fails after expiry; recovery is a separate grace operation and reacquisition requires a higher fence. |
| R04 — Grace boundary and repeated recovery insufficient | fixed | Exact grace boundary/replacement assertions plus repeated recovery through `simulateScenario`. |
| R05 — Restart and old-epoch requests | fixed | Off-grid restart invalidates delayed old-epoch operations; session-aware designs refresh the epoch. |
| R06 — Clock drift test missing | fixed | Positive and negative clock rates produce different heartbeat schedules. |
| R07 — Publication, terminal landing and release lifecycle | fixed | Publication checks live editing grants and cannot mint permission after loss; landing checks its authorization and releases it on success. |
| R08 — Review loss survived abandonment | fixed | Later abandonment clears the returned review-loss measure and is tested. |
| R09 — Post-publication nonblocking hold unclear | fixed | Report explains that publication releases exclusive edit leases and leaves revision-bound nonblocking landing permission. |
| R10 — Combined arm and phase-spanning inputs unsupported | fixed | Combined arm and phase-spanning abandonment remain; report states limits and no policy selection. |
| R11 — Source provenance unclear | fixed | Report names local inputs and distinguishes supplied Chubby notes from an independent paper reread. |
| R12 — Terms and evidence labels unclear | fixed | Plain-language glossary and bounded interpretation are included. |
| N1 — Publication granted permission after editing authority was lost | fixed | `renewal.ts`: publication requires active work, no recorded loss, and valid edit grants on both units at the transition; a lost-edit fixture cannot land. |
| N2 — Accepted expired writes were omitted from safety count | fixed | Independent monitor evaluates every accepted simulated write. Expiry-blind and always-accept guard probes both produce nonzero violations. |
| N3 — Grace recovery worked only once per scenario | fixed | No scenario-wide recovered flag remains; each lapse has its own recovery window, with a regression test covering recovery before and after publication. |

The repaired model still has stated distribution-shape and fault-rate assumptions. Those are limitations in the report, not silently closed review findings. The output is regenerated from the targeted test command and is not independent production evidence.
