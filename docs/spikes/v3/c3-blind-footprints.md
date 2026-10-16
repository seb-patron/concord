# Can an issue predict the files a worker will edit?

## Plain answer

**The historical data cannot justify automatic exclusive file claims from issue text.** Only four pre-specification GitHub issue bodies have a usable, verified starting tree and observed answer in this freeze, and three of those four name code or folders that lead to changed files. The issue writers knew the code. The larger redacted-spec sample is useful for debugging extraction and search baselines, but it is not blind evidence. Four of the same tasks appear in both samples.

**The growth model supports a live test, not a policy ranking.** It now starts from partial declared sets, grows missed files, retains tasks whose Allowed list missed a file, and keeps each lock for the whole modeled edit. Its predicted sets are constructed from the answer, so even a favorable result does not measure a real predictor. The owner-approved declare, grow and verify plan (D-LEASE-Q5-CPLUS) remains a plan; the current exclusive-write rule (D-UNIT-1-EXCLUSIVE) remains the policy.

**Recommendation:** collect new blind requests inside the planned live pilot and Concord's own issue store. Freeze the requester's words before anyone who has inspected the code writes a work specification. Record discovery, growth, waiting, failed work and accepted work. Use the redacted historical tier to debug the prediction harness only.

## Short glossary and worked example

- A **bundle** is the text shown to a future predictor plus the starting commit. An **answer key** separately records the observed changed files and any explicit refusal. Each JSONL line is one JSON record.
- A **file claim** or **lease** reserves a file for one writer; a **unit** is the file in this study. **Declare** requests an initial set, **grow** requests a newly discovered file, and **verify** checks the final changed set.
- The **base** is the commit used to start work; a SHA is its Git identifier. A **diffable** attempt has both starting and candidate commits locally. An **issue family** joins retries for one repository issue; the first attempt is used here. An **undiffable** attempt has no usable local before/after diff.
- **Tier A** is issue text recovered from the issue's first GitHub revision, written before the work spec. It is *pre-spec*, not code-blind. **Tier B** is the work spec's Goal or Outcome with paths redacted; its author knew the code, so it is *leaky*. The four Tier A families also have Tier B records.
- A **file stem** is a filename without its extension: `evidence-records` is the stem of `evidence-records.md`. A **symbol** is a named code element such as a function, class or variable; its name can reveal the file containing it even after paths are removed.
- **Recall** is the share of observed changed files in the initial set; **precision** is the share of initially named files that changed. **Over-declaration** is extra named files. An **exact set** has no observed miss or extra file. Because an Allowed list prevented some edits, the observed diff can be an incomplete, or **censored**, answer.
- A simulation **tick** is an arbitrary one-file work unit, not a second. **Wait** is time denied a claim; a **cycle** is a group of tasks each waiting for another's lock; **makespan** is the time until the last task in a window finishes. **First touch** is the first modeled edit to a file, not a timestamp recovered from a worker log.
- **Train** and **held out** are repository groups reserved for fitting and later evaluation. They do not make a leaky text blind. A **clustered interval** groups related tasks when estimating uncertainty. A **top-k** rule limits a prediction to its first k named files.
- A **95% proportion interval** is an estimated range for a share, such as the share of correct predictions. Its **half-width** is the distance from the estimated share to one end of that range, measured here in percentage points. Repeating samples under the stated assumptions would make about 95% of such ranges contain the true share; related tasks can make the range wider.

For example, the SwiftUI Rewine lint-dimensions issue says “evidence-records spec.” The starting tree contains `docs/specs/evidence-records.md`, one of five files in its answer key. A text search can find that answer without reasoning about future edits. Its bundle is Tier A because the first issue revision predates the work spec, but its wording is still a location clue.

## Data audit

The source cutoff is **October 15, 2026, 7:42:28 pm Chicago time**. Local assignments in the freeze begin September 16. The builder reads launcher run directories and local Git clones read-only; its GitHub calls retrieve issue creation revisions. It uses a logged worker-start marker where available, otherwise the run-name time as a conservative proxy; it excludes a base when its commit time cannot be shown to precede that bound. A future predictor must see only an export of that base tree, never the clone's later refs.

The history scan found **9,678** runs with the required local marker, status and prompt/spec; **8,518** lacked an issue number. That includes all **1,228** Concord runs in this source slice: Concord is absent from both historical issue-linked tiers and from the issue-linked growth model. There are **935** issue families, and their creation revisions were recovered. Among **898** families with a verified starting snapshot, **807** first bodies already contained a spec or Allowed list, **66** had a revealing path or location, **21** were too thin, and **4** entered Tier A. Another **37** lack a verifiable starting snapshot and are tracked separately. Creation-text eligibility is checked independently of whether an attempt produced a diff or a usable Goal/Outcome. Failed and abandoned families appear as audit records rather than scored tasks; the freeze cannot promise complete labels for them.

Tier A contains **four** usable creation-time issues across two repositories. The family audit includes **37** issue families whose base commit time was unavailable; their creation text is still screened for obvious spec and location clues, but they cannot enter a frozen predictor bundle without a verified starting tree. A base-tree search in the independent audit found direct clues in three usable records:

| Pre-spec issue, named in words | Clue in first body | Starting-tree result |
|---|---|---|
| Gen-V research tools interrupt residuals (issue 141) | `_packet_summary`, `STOP_INTERRUPTED`, `_hold_interrupts` | The first two find the changed probe script; the third finds the two changed files. |
| Gen-V research tools assumption register (issue 360) | “chosen by the spike” | No direct answer-file pointer, but the body lacks the parent context. |
| SwiftUI Rewine probe frame (issue 109) | `ScenarioSupport`, `SCN-0002`, `CounterCard` | The folder and matched scenario files lead to changed files. |
| SwiftUI Rewine lint dimensions (issue 115) | “evidence-records spec” | Names the changed evidence-records document. |

This is a pre-spec audit, not a claim that the writer lacked repository knowledge. The creation-revision method uses GitHub's earliest content edit only when its edit time equals the issue creation time; an unedited issue uses its body. A body containing a delegation spec, Allowed list, explicit location, or too little substance is excluded. The first four surviving revisions were independently checked against their GitHub creation bodies.

The regenerated Tier B has **702** records. Its per-bundle flags mark answer-file stems, non-generic answer folders and wording that grants edits. These are separate overlapping indicators, not a complete leak detector. The deterministic scan finds **81** file-stem clues (**11.5%**), **125** folder clues (**17.8%**) and **2** permission phrases (**0.3%**); **186** records (**26.5%**) have at least one flag. Three selected bundle/answer pairs show the residual clues directly:

| Task in the regenerated bundle | Named token still visible | Matched answer file |
|---|---|---|
| Gen-V decomp reviewer launch | `review_merge` | `tools/pipeline/review_merge.py` (file stem) |
| Gen-V research tools adapter validation | `validate_adapter_breakpoint_stream` | `src/gen_v_research_tools/runtime_instrumentation.py` (code identifier, as checked in the earlier independent base-tree search) |
| SwiftUI Rewine runtime diagnostics | `RuntimeDiagnostics` | `Sources/RewineUI/Runtime/RuntimeDiagnostics.swift` (file stem) |

The earlier independent Opus review sampled 60 records in the earlier freeze and found eight searchable code identifiers. That rate is not a measurement of this regenerated corpus; the previous report's fresh 5-of-60 count had no preserved selection or match record, so it is withdrawn. The old freeze also had five permission passages and four commit identifiers off the base ancestry. The extractor now stops at the next heading or labeled field, and the predictor protocol excludes those commits entirely. Literal answer-path matching alone was zero in the earlier freeze; that narrow fact did not mean the text was blind.

The redactor now preserves prose between paired code spans, matches full file extensions (including `.json`), keeps multiline goals, removes prose line numbers, templated paths and commit identifiers, and ignores fenced examples before choosing the outer Goal/Outcome. The old freeze damaged 116 of 702 Tier B records in the independent review, with overlap among the three bug categories. Regeneration changes both text and membership; the old hashes must not be used. The builder records a checked base commit time, the worker start, and a source run in the answer key. Refused-scope paths come from actual unmatched diagnostics and the candidate's changed files outside its Allowed set, excluding “nearest” suggestions; a dirty refusal is labeled separately. Missing refused paths mean “not reported,” not “none needed.”

The labels are observed changed files, not all files a worker would have needed without an Allowed-file gate. Scope refusals expose some misses, but unknown missed needs remain. There is no defensible symbol-level answer key here. The answer JSONL also contains **935** `family_audit` records, one for each issue family, giving source run, creation-revision status, snapshot evidence, label availability and exclusion reason. They are audit records, not scored answers. Concord's own issue store, not this historical GitHub-issue subset, is the natural source for its future blind data.

## Growth simulation: what changes when a declaration is partial?

The [simulation](../../../spikes/v3/c3/growth_sim.py) reads first issue-linked attempts with a local diff and Allowed list. It selects the first 40 tasks per repository **plus all 15** tasks whose changed files exceeded the list, yielding **295** tasks. One task has an order derived from successive commits; the other **294** use alphabetical first-touch order as an assumption. Worker logs were not mined for first-edit ordering. The [raw output](../../../spikes/v3/c3/output.txt) includes every selected run, declared set and derived order as an audit manifest, followed by all scenario metrics.

The up-front arm requests the author's whole Allowed list in an initial acquisition step. If a missing file is reached later, it pays one modeled refusal tick and then grows. The exact arm requests precisely the actual changed set in its own initial step. The partial arms acquire deterministic answer-derived subsets at **0%, 50%, 80% and 100%** recall, plus the original declared-but-unchanged files, as a separate step before the first edit or growth request whenever the set is nonempty. A nonempty initial acquisition consumes one modeled tick; an empty set consumes none. They keep that initial set while waiting to grow missed files. The first-touch arm has perfect foresight and claims changed files only as needed; it is an upper bound on discovery knowledge, not throughput. Comparing exact with first-touch holds footprint accuracy fixed and isolates acquisition timing. Comparing all with exact shows the effect of surplus declared files and misses. Every acquired lock remains held through the whole edit tick and until completion.

Across selected tasks, the historical Allowed lists named **1,321** files: **1,231** changed and **90** did not, while **87** changed files were missed. Thus **6.8%** of declared entries were extra. The earlier, broader declared-footprints study found **25.2%** extra entries; these selected issue-linked tasks are not representative of that larger history. The partial arms achieved **50.8%** and **79.7%** observed-file recall at their nominal 50% and 80% settings. They retain the same 90 extra files, so recall alone does not specify the footprint. In **105** of the 295 tasks at nominal 50% recall, and **40** at nominal 80%, a nonempty initial set omits the first touched file. Those tasks now acquire and hold the initial set before requesting that first growth.

Tasks start simultaneously in nonoverlapping same-repository windows of up to two, five or ten workers. The final smaller window is kept, so every selected task appears in each concurrency scenario. Agent order breaks claim ties. A denied claim counts once per uninterrupted wait; a wait cycle makes the youngest task release its locks and repeat its completed file work. An alternating reverse-file-order sensitivity exposes cycles hidden by alphabetical ordering. No-claim scenarios assume zero, one or two repair ticks for each pair sharing a changed file. The earlier larger lock replay observed textual conflicts in only 40 of 1,304 overlapping merged-change pairs, all in one repository; charging every overlap two repair ticks is deliberately pessimistic.

For windows of up to ten workers with alphabetical assumed edit order, the model gives:

| Initial claim strategy | Waiting worker-ticks | Scope refusals | Deadlocks | Window finish ticks |
|---|---:|---:|---:|---:|
| Author's full Allowed list, then grow misses | 2,021 | 15 modeled refusals | 0 | 873 |
| Exact changed set up front | 1,859 | 0 | 0 | 855 |
| Partial set at 50.8% recall, then grow | 1,972 | 0 | 12 | 857 |
| Partial set at 79.7% recall, then grow | 2,001 | 0 | 1 | 856 |
| Partial set at 100% recall, still with extras | 2,053 | 0 | 0 | 870 |
| Claim at first touch with perfect foresight | 1,283 | 0 | 0 | 696 |

Reversing every second task's assumed order yields **32** deadlocks and **102** repeated file-work units for perfect-foresight first touch at ten workers. With no claims, the same windows finish in **422**, **712** or **1,002** ticks under zero, one or two assumed repair ticks per overlapping pair. This range reverses apparent rankings and is not observed repair time.

The output is a mechanics sensitivity study, not elapsed time or measured agent throughput. The subset construction knows the answer and has no measured prediction cost. At the modeled ten-worker windows, the partial arms do not establish a reliable minimum recall: their wait and restart counts change with order and the arbitrary subset choice. In particular, a high recall can still hold extra files for the whole job, while a low recall can create growth waits or cycles. A real threshold requires frozen independent predictions and observed discovery, claim latency, repair and completion costs. No agent prediction or live run was made here.

## How to obtain and test blind data

The prediction protocol should first freeze task text and a base-tree export. Put each prediction in a fresh sandbox with no network, home directory, GitHub login, run directories, chat transcripts, memory, current branch, Git refs or reflog. Give only the base tree and the single task's permitted text; strip issue-family identifiers and candidate commit identifiers from the predictor view. A cited branch commit outside the base, even if older than the task, is unavailable unless it was explicitly present and frozen at assignment. Run Tier A before Tier B or use separate predictors with no shared memory; never reveal labels until both tiers' predictions are frozen. The original spec author cannot be the blind predictor.

Predeclare a file budget, top-k rule, time and spend. Use two simple baselines: search the issue words for file, folder and symbol names in the base tree, and reuse the previous task's changed files in the same repository. The author's Allowed list is an informed reference ceiling, not a blind comparator. Repeat each bundle in isolated sessions at least twice to expose prediction variance. Report Tier A and leaky Tier B separately, and split Tier B by its hint flags; quarantine related issue families and cross-repository links between train and held-out groups.

Let **K** be known needed files (changed files plus explicit refused paths) and **P** the prediction. Files in both are confirmed hits; files in K but not P are confirmed misses; files in P but not K are **unknown**, not confirmed false positives. Report precision against K as a lower bound, `|P ∩ K| / |P|`, with upper bound 1 if every unverified prediction was needed. Report `|P ∩ K| / |K|` as *observed-label recall*, never as true recall. True recall has no useful lower bound without a finite, justified universe of possible unseen needs; its upper bound assumes every unverified predicted file was needed and no other unseen file was. Exact-set accuracy is unidentified where the answer is censored. Failed, undiffable and unlabeled tasks belong in a missingness table, not a falsely scored denominator. New pilot work should log every first edit, attempted out-of-scope edit, growth request, abandoned task and accepted change so independent adjudicators can produce an uncensored outcome. Report uncertainty by issue family and repository, plus elapsed time, wait, refusal and repair cost. Prediction accuracy alone cannot choose a lease policy.

The historical Tier A count is too small to promise a useful sample. Fifty independent new families would have a worst-case simple 95% proportion interval extending about 14 percentage points on either side of the estimate before accounting for related tasks; about 200 would approach seven points on either side. These are planning illustrations, not recruitment promises or product gates. The planned live pilot in the claims-options study is the right place to estimate actual variance, with owner-approved arms and spend before any policy comparison.

## Owner's choices for blind text

| Choice | Who writes and freezes the text | Benefit | Cost and limit |
|---|---|---|---|
| **Collect new requests inside the live pilot and Concord issue store** | The requester writes the original request without consulting the target code; Concord freezes it before a code-aware orchestrator writes the spec. | Directly matches agent work; can collect uncensored edits, growth, waiting and failure, including Concord's own runs. | Requires a changed issue-creation workflow, instrumentation, review and pilot agent time; early sample is small. Recommended. |
| **Use a public issue-to-change dataset** | Public issue authors wrote text; the researcher freezes a verifiable first revision and assignment-time tree. | Potentially large and unconstrained by this launcher's Allowed list. | Data acquisition and historical audit cost; models may have trained on public fixes, human open-source issues differ from orchestrated agent work, and first-edit timing is usually absent. Useful only for a quick outside check. |
| **Accept the measured leaky spec tier** | A code-aware spec author wrote the Goal/Outcome; the researcher freezes the repaired redaction. | Available now, cheap, useful for testing parsing, isolation and scoring code. | Residual names and permission clues bias accuracy upward; not evidence for initial claims. |
| **Mine the owner's original requests** | The owner wrote past requests; a researcher with authorized access freezes the earliest untouched wording before any code-aware response. | Closer to the owner's real task mix and often less code-informed than a spec. | Retrieval, privacy review, chronology checks, matching to runs and missing or informal context cost; some requests may already name code. No such text was included in this freeze. |

## Reproduction notes

### Named inputs and read extent

This repair read the complete supplied `review-delta-112.md`, `review-opus-112.md` and `review-astra-112.md` and sections 4 and 5 of `claims-options.md`. It inspected the branch's builder, simulator, report, ledger and generated records; the JSONL files were scanned programmatically, with selected bundle/answer pairs checked against their source runs. The builder reads shallow launcher `status.json`, `work-spec.md` or `prompt.md`, `allowed-files.txt` and relevant `run.log` entries under `/Users/sebastianpatronsoto/agent-runs/`; these run directories were not read exhaustively. It queries local clones for base commit times and changed paths, and read-only GitHub issue history for first revisions. The simulator uses those local records and Git commit order where available; it does not extract first-edit order from worker transcripts. The repository's `docs/decisions.md` supplies the cited owner policies. No external web summary or prediction model was used. The three independent reviews are assessments of earlier candidates, not new measurements made by this repair.

The allowed deliverables are [bundles](../../../spikes/v3/c3/bundles.jsonl), [answers](../../../spikes/v3/c3/answers.jsonl), the [builder](../../../spikes/v3/c3/build_dataset.py), simulation and raw output. The JSONL pair remains below the 20 MB cap. Rebuild with `PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c3/build_dataset.py` using local runs/clones and read-only GitHub history, then `PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c3/growth_sim.py`. The required redirected simulation command checks a successful rerun while leaving the generated output in place. `npm run -s decisions` was attempted; local `tsx` was missing, so its “Approved but not live” list was unavailable. The decisions cited above were checked in the readable decision record.

Frozen SHA-256 checksums for the regenerated files:

```text
92dc8dc19f2a20c203d65d2354ad983c329eb98de8b411f86be95e721dc6ed86  spikes/v3/c3/bundles.jsonl
57e89043dd681536d8ca772b93bb27c220fa677578f5b8d5f3bb01ceb769e80f  spikes/v3/c3/answers.jsonl
2002f9211b7c84c4ccd3ef4b24238b64bcb7df8b7cd5db0a58b9a1dfddfdc8f9  spikes/v3/c3/output.txt
```
