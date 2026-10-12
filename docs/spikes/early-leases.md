# Early leases for Mother Base

## 1. Root cause

Mother Base's AW workers edit GitHub clones without contacting Concord. The coordinator calls `concord land` only after review; `cli/land.ts:land` then creates a change, derives units from the finished diff with `unitKeys`, and claims leases. Leases prevent competing admissions, not competing work. On 2026-10-12, 9 runs landed but roughly 4 needed rebase/re-review: R1 met F3's `MERGE_CONFLICT`, D0 rebased after R1, and J1a/CT2 were still being rebased. Granularity compounds this: 8/9 runs touched `docs/architecture.md`, 5/9 touched `src/mother_base/db.py`; `unitKeys` maps both non-TSV files to `file:<path>`. Early file claims would avoid wasted edits but serialize much of this cohort.

## 2. When to claim

Create a draft against observed canonical head **before** claiming: `src/features/leases.ts:claim` requires an owned draft/ready change. Keep one intent key and author identity. Claims are atomic for at most 16 registered, nonoverlapping units (`src/leases/units.ts:normalizeUnits`); `409 LEASE_CONFLICT` means queue without editing. Track each `leaseId` and changing fence. TTL is 120 seconds by default, at most 300, with renewal guidance at 40 (`src/features/leases.ts`); the 30-minute `reserved` state applies **after queue admission**.

| Option | Token custody and survival through work + review | Adoption, conflict, cleanup |
| --- | --- | --- |
| **A. Coordinator preclaim from Allowed files** | Create the draft as eventual author, store fences privately, renew under supervision through review. Claims cannot transfer between principals. A longer TTL is unavailable today and delays crash recovery. | Queue conflicts before launch. Pass intent/change ID to `land`; release on abandon/failure, with expiry as fallback. Whole-file claims overqueue distinct sections. |
| **B. Worker claims first via MCP/CLI** | Worker creates draft and claims via `mcp/tools.ts:change_create`/`lease_claim` or `cli/main.ts`; it renews while editing, then hands renewal to a review-phase supervisor. | Worker waits on conflict; launcher must enforce the gate. `land` reuses intent/change and releases unused claims. A crash leaves TTL recovery; ignored prompts defeat the gate. |
| **C. AW launcher integration** | Launcher gates runs, creates the draft under assigned author identity, and supervises renewal in run state. | Queue conflicts with holder/expiry before spawn; release on cancellation/failure. `land --aw-run` receives intent/change and fences. Strongest enforcement, but needs AW integration and identity design. |

`src/features/repos.ts:changeCreate` returns an active change only for the same author, intent, and task content. Today `land()` rebuilds base, units, and branch; reusing an early key can yield `INTENT_CONFLICT`. Adoption must persist draft metadata, verify owner/task, use current fences, and reconcile changed paths. `src/features/repos.ts:publish` permits a new unit set, but `src/features/leases.ts:reserve` requires equality with checker-verified writes and exact fenced coverage. Release unused claims; acquire newly needed units **before** further edits or fail and rerun. Never silently widen at land.

## 3. Granularity for the hot files

**Markdown.** Mother Base's ~41 KB `docs/architecture.md` has nine numbered top-level sections, including 8.1. Its rule requires contract-changing V1 specs to update this structural source of truth in the same PR. Concord could register heading resources such as `section:architecture:5` and `section:architecture:8.1`; preamble, heading, boundary, or spanning edits take the file unit. A lease permits concurrent disjoint edits but cannot ensure stale full-file commits merge or pass review. Independent landing needs trusted heading parsing, section-level write verification and three-way merge, plus cross-section dependencies; otherwise retain the file lease. Reject ambiguous heading changes.

**Python.** `db.py` has ~30 mostly independent top-level functions, so symbol resources could separate `watch_*`, `alert_*`, `note_*`, `facts_as_of`, etc. Concord needs trusted symbol verification in `runner/units.ts:inspectUnits` and symbol-aware composition in `runner/execute.ts:compose`. Today non-TSV inspection yields file footprints and composition resolves only TSV-row conflicts; policy names alone cannot unlock parallel landings. Imports, shared globals, decorators, class bodies, and moved symbols need file or shared-resource claims. Merging still requires syntax and full checks.

**Actual schema hotspot.** `SCHEMA_VERSION` and `_migrate(conn)` are shared by every schema change. Keep a coarse schema unit until Mother Base replaces the central switch/version with an ordered per-feature migration registry, unique migration IDs, and compatibility tests. This is a Mother Base restructure, not a Concord parser feature. The registry reduces edit collisions but migration ordering, data compatibility, and runtime dependencies still require a serialized integration check. Section and symbol policy/merge support belongs to Concord; migration modularity belongs to Mother Base. Narrow units cost parser/merge complexity and review-dependency accuracy; coarse units cost throughput.

## 4. Effect on the observed nine runs

The run-level section/symbol diffs were not supplied, so these are bounds, not reconstructed outcomes. Counts overlap: 8/9 architecture edits and 5/9 db edits do not imply 13 different runs.

| Change pressure | A/B/C with early file claims | Narrow units plus verified merge |
| --- | --- | --- |
| R1 versus F3 (`MERGE_CONFLICT`) | If their allowed files shared either hot file, one would wait **before launch**; the observed overlapping edit/late conflict would be prevented by serialization. | Only distinct sections/symbols could run together; same section/schema unit still queues. Exact result needs diffs. |
| D0 after R1 | Shared hot-file claims would serialize D0 and give it the newer base at start, likely avoiding that rebase/re-review; unrelated paths would not. | Distinct units might run concurrently, but base movement can still trigger rebase or review carry checks. |
| J1a and CT2 rebases | Each run touching an occupied hot file would wait; no evidence identifies their exact conflicting hunks or sequence. | Distinct units may reduce waits, but stale bases and dependencies remain. |
| Whole cohort | Architecture file claims allow at most one of its 8 editors at a time; db file claims at most one of its 5. This trades late repairs for launch delay. | Potentially more parallel starts; no defensible numerical savings without per-unit diff history. |

Worker-first B has a small pre-claim race and can fail to gate if the worker ignores instructions. A/C enforce the gate externally. None prevents unrelated later canonical changes or semantic conflicts across units.

## 5. Recommendation and slices

Use **A now**, with a coordinator renewal supervisor and whole-file claims for the hot paths; move admission into **C** when the AW launcher can enforce it. Avoid B as the sole control. For the submission, show two conflicting specs: the second remains queued before spawn, then starts on a fresh canonical base after the first lands; show lease holder, intent, expiry, and cleanup. Do not claim improved concurrent throughput until narrow-unit verification and merging exist.

| Order | One behavior per slice; likely files | Size | Before 10-15 1:59 am CT? |
| --- | --- | --- | --- |
| 1 | Coordinator creates an early draft/claims Allowed-file units before spawning; AW coordinator adapter, `cli/main.ts`, `docs/cli.md` | M | Yes |
| 2 | Supervisor renews current fences through work and review; AW run state/adapter, `src/features/leases.ts` only if API gaps arise | M | Yes |
| 3 | `land` adopts the draft by intent and reconciles exact published units/fences; `cli/land.ts`, `src/features/repos.ts`, `tests/node/land.test.ts` | M/L | Yes |
| 4 | Coordinator queues conflicts fairly and releases on cancellation/failure; AW coordinator adapter, lease integration tests | M | Yes |
| 5 | Verify Markdown heading units and dependency scope; `src/leases/units.ts`, `runner/units.ts`, policy template, tests | L | After |
| 6 | Merge disjoint Markdown sections; `runner/execute.ts`, `runner/units.ts`, tests | L | After |
| 7 | Verify and merge Python top-level symbol units; same runner paths, policy template, tests | XL | After |
| 8 | Replace central migration switch with ordered per-feature migrations; Mother Base `src/mother_base/db.py`, migration modules/tests | L | After |

**Seb's product decision:** whether early claims are binding reservations for the *entire Allowed-files set* (safe, low concurrency), or whether the coordinator may admit on a trusted narrower planned-unit declaration (higher concurrency, requires a pre-edit scope gate and a policy for newly discovered writes). Also choose whether ownership stays with an assigned worker principal or AW gains a delegated author identity; current author/fence checks do not allow casual transfer.

## 6. Risks and demo limit

Claim all planned units atomically where possible; never hold a subset indefinitely while waiting for the rest. The 16-unit cap may require splitting a spec, and a hot architecture unit can starve lower-priority runs: use FIFO or aging, bounded retries, and visible queue position. A crashed supervisor leaks exclusivity for at most the remaining TTL, but renewal failure during a live run is worse: pause edits, reacquire before continuing, then inspect and re-review any unprotected work. Do not treat queue's 30-minute reservation as an hour-long worker lease.

Early admission prevents simultaneous edits; it does not prove review carry. `cli/land.ts` currently carries approval after a clean cherry-pick only with equal stable patch IDs and changed paths (#42), and `docs/ARCHITECTURE.md` calls for content/dependency manifests and delta checks. A narrower heading or symbol unit can invalidate dependencies across units. Range-based multi-commit review (#44) still needs correct run-start base and exact reviewed range; `docs/land.md` documents `--base` and the AW adapter. The demo should show both a queued collision and a disjoint-change case, labeling the latter as future work until trusted parsing, merge, and review semantics exist.
