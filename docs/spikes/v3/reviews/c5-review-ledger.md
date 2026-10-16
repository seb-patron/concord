# Lease renewal repair review ledger

Every review item is mapped below to the repair or report section that addresses it. “Fixed” means the submitted artifact now corrects the identified defect or clearly limits the claim to what the model establishes; it does not mean the model is production evidence.

| Finding | Status | Where addressed |
|---|---|---|
| O1 | fixed | `spikes/v3/c5/renewal.ts`: actual fenced write attempts; `spikes/v3/c5/test.ts`: same-holder stale write and deliberately broken guard probe; report “What the simulation did.” |
| O2 | fixed | Session heartbeat renews multiple units; restart epoch is event-driven and reported; reconnect and restart counters appear in `output.txt`. |
| O3 | fixed | Clock-rate drift changes local heartbeat scheduling; restart events fire across off-grid time; tests compare fast and slow clocks. |
| O4 | fixed | Abandonment is sampled across phases; server renewal stops only on an explicit signal or phase completion; dead-held time is shown beside outcome measures. |
| O5 | fixed | Deterministic assertions cover stable renewal fences, fence-enforcing writes, live-holder conflicts, stored grace boundaries, phase renewal, session recovery, restart, clock drift, cadence, and lapse handling. The mutation probe reports its measured result. |
| O6 | fixed | Report narrows the recommendation to the measured server-phase effect and source-backed design hypothesis; the combined server/session arm is included; lapse recovery, disconnect, abandonment, explicit signals, and limitations are described. |
| O7 | fixed | Loss time is associated with the current phase; review losses count only lapses during review and exclude abandoned runs. |
| O8 | fixed | Renewal stops after loss; expired renewal is refused; client renewal calls and server phase extensions are separate counts. |
| O9 | fixed | 200 seeds per size; independent seed ranges for five and twenty agents; paired seeds across designs; intervals are reported. |
| O10 | fixed | Editing, checks, review, and queue are separate; inspection and review ranges follow the supplied lease-renewal research; queue range is labeled a scenario assumption. |
| O11 | fixed | Report distinguishes lapse recovery from Chubby’s master-outage grace and identifies the local notes’ inherited paper-read provenance. |
| O12 | fixed | Metric is named “outage lapses,” not “wrongly lost”; report defines it as a scenario outcome rather than protocol misbehavior. |
| O13 | fixed | Plain summary precedes the results; glossary defines the terms; tables are rendered as Markdown tables; toolchain details and bare finding references are absent from the report. |
| O14 | fixed | Landing is declared as the primary measure before results; outage lapses and dead-held minutes are prespecified secondary measures; offline scope and lack of live-pilot authorization are explicit. |
| O15 | fixed | Epoch must be supplied to protected writes; server and client renewal paths are distinct; lapse recovery uses the current stored expiry; dead simulation block is removed. |
| R01 | fixed | Real protected-write calls determine safety and refusal counts; broken-guard mutation creates measurable violations. |
| R02 | fixed | Tests assert stable successful renewal and compare connected and disconnected review behavior, including server-held landing permission. |
| R03 | fixed | `LeaseFence.renew` rejects expired ownership; recovery is a separate grace operation; tests require fresh claims and higher fences. |
| R04 | fixed | Grace derives from the stored expiry; exact 45-second and 46-second cases, replacement, and repeated lapse are tested. |
| R05 | fixed | Restart events are delivered when time crosses the event timestamp; delayed packets use the old epoch and are checked. |
| R06 | fixed | Clock drift is modeled as a rate change and is asserted to alter renewal timing. |
| R07 | fixed | Completion requires the exact terminal time, a valid revision-bound landing permission, and no abandonment. |
| R08 | fixed | Review loss is phase-specific; editing, checks, and queue losses do not enter that count. |
| R09 | fixed | First publication releases exclusive write leases; landing permission remains revision-bound and nonblocking. |
| R10 | fixed | Server-plus-session is an explicit arm; abandonment occurs in all phases; the report states that the model cannot choose a recommended production combination. |
| R11 | fixed | Report names every supplied local source and distinguishes the supplied Chubby notes from an independent paper read. |
| R12 | fixed | The report glossary defines the requested protocol, lifecycle, measurement, and evidence labels in plain language. |
