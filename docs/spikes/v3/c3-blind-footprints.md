# Blind issue footprints and mid-run growth

**Answer for the owner.** The available history does not yet justify making an issue's proposed files its exclusive leases. Only **four** substantive, pre-assignment issue bodies survive a conservative blind-data audit, across **two** repositories. Another **702** tasks have usable redacted outcome text, but an author who knew the code wrote that text; this is a **LEAKY** tier. A mechanical growth simulation shows why gradual claims deserve a live test: it reduces modeled waiting, while plausible changes to the unknown first-touch order create deadlocks and restarts. These are scenario results, not measured agent speed or a policy recommendation. The current exclusive-write decision (D-UNIT-1-EXCLUSIVE) remains the baseline; the owner's 2026-10-15 approval covers this research spike, not a policy change.

**STRUCTURAL (local launcher and issue-history sources dated through 2026-10-15; audited 2026-10-16 UTC):** issue bodies commonly already contain delegation specs and Allowed-file lists. Accepted commits are constrained by those lists, so a final diff cannot reveal every file the agent needed. **CAPABILITY-DEPENDENT (2026-10-16 dataset; re-test with current agents):** how accurately a separate agent predicts files or symbols from a clean issue is unknown; no predictions were run here.

## What was frozen

A *bundle* is the issue or outcome text plus the repository's assignment-time base commit SHA. Its separate *answer key* contains the candidate commit SHA, changed files, and any explicit refused-scope paths in the launch log. The bundle contains no final diff, Allowed-file list, candidate SHA, or later repository tree. The files are [bundles](../../../spikes/v3/c3/bundles.jsonl) and [answers](../../../spikes/v3/c3/answers.jsonl). Together they are 1,113,824 bytes, below the 20 MB cap. Their SHA-256 values at freeze are:

```text
70b0c717687e84bca15e74f7e49e6d985d630a033a7956a0982bde10f3da60fb  spikes/v3/c3/bundles.jsonl
6dbafe7bdf87796f3c51d0aa989e6296fd1f787f6be7756a0272a009c11fbf2e  spikes/v3/c3/answers.jsonl
```

The audit's source cutoff is **2026-10-16 00:42:28 UTC** (2026-10-15 in the owner's time zone). It scanned read-only launcher run directories under `agent-runs` with an Allowed-file marker, status and spec/prompt, then used matching read-only local clone history. There were **9,678** such timestamped runs, including **8,518** without an issue number. Among **935** issue families, the first attempt was undiffable for **161**, had no extractable Goal/Outcome for **61**, and had an empty diff for **one**. This left **712** first attempts with an assignment-time base and a locally diffable candidate. Choosing the first attempt prevents successful retries from replacing a failed original; the attrition also means the answer sample is success biased.

**Tier A** means a substantive first issue-body revision recovered from GitHub's read-only `userContentEdits(last:1).diff`, or the creation-time body of an unedited issue. Its GitHub creation timestamp must precede assignment. A marker for a delegation spec or Allowed-file list, a path or file:line hint, an actual changed-file basename, or a placeholder body excludes it. **Tier B** means only the local spec's Goal/Outcome text, with code spans containing paths, paths, file:line hints and changed-file names redacted; it is labelled **LEAKY** in every bundle. Ten Tier B texts still failed the post-redaction path audit and were excluded.

| Repository | First attempts audited | Tier A | A: spec/list | A: revealing path | A: thin body | Tier B | B: redaction failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| agent-review-evals | 2 | 0 | 1 | 1 | 0 | 2 | 0 |
| agent-run-analytics | 1 | 0 | 1 | 0 | 0 | 1 | 0 |
| agent-workflows | 20 | 0 | 20 | 0 | 0 | 20 | 0 |
| azeron-macos | 31 | 0 | 9 | 4 | 18 | 31 | 0 |
| decomp-learning | 1 | 0 | 1 | 0 | 0 | 1 | 0 |
| gen-v-decomp | 222 | 0 | 206 | 16 | 0 | 222 | 0 |
| gen-v-map-studio | 13 | 0 | 9 | 3 | 1 | 13 | 0 |
| gen-v-research-tools | 203 | 2 | 184 | 17 | 0 | 203 | 0 |
| gen-v-workshop | 2 | 0 | 2 | 0 | 0 | 2 | 0 |
| mother-base | 41 | 0 | 41 | 0 | 0 | 41 | 0 |
| mwcc-rs | 108 | 0 | 108 | 0 | 0 | 98 | 10 |
| sft-course | 13 | 0 | 13 | 0 | 0 | 13 | 0 |
| swiftui-rewine | 55 | 2 | 39 | 14 | 0 | 55 | 0 |
| **Total** | **712** | **4** | **634** | **55** | **19** | **702** | **10** |

The antechamber issue family had no diffable first attempt. Runs without issue numbers cannot supply Tier A and were excluded from both issue-family datasets. The repository holdouts are **gen-v-decomp** and **swiftui-rewine**; all other repositories are train. Thus Tier A has **2 train / 2 held-out**, and Tier B **425 train / 277 held-out**. Every attempt in a repository and issue family stays in one split. This split does not prove that related cross-repository issue families are independent; a later predictor run must quarantine explicit cross-links before using train labels.

### Leak and label audit

**STRUCTURAL (GitHub issue revisions and local specs, 2026-09-17–2026-10-15; audit 2026-10-16):** 634 of 712 first revisions exposed a spec or Allowed list, 55 exposed a revealing path/location, and 19 were placeholder or very short bodies. Tier A's four surviving bodies have no literal changed path in their bundle text. The automated answer-path check found **0** literal answer paths in all 706 bundles. This is a mechanical leak check: conceptual clues and explicit symbol names can still occur naturally in an original issue. One Tier A body refers to a parent spike without supplying it, so even this small tier contains a context-poor task.

**STRUCTURAL (launcher and local git, 2026-09-17–2026-10-15):** the 702 Tier B bundles inherit author knowledge despite redaction; file classes, API names and scope may still hint at answers. The first-attempt answer key has ten explicit refused-scope diagnostics with paths. Other absent refused paths mean “not reported,” not “none needed.” The old launcher's Allowed-file gate censors successful diffs: no precision/recall estimate from these labels alone can establish a safe initial lease set. A separate symbol answer key was not defensible from single final commits and was not fabricated. This freeze supports **file** scoring only; symbol prediction awaits independently reviewed labels.

**STRUCTURAL (read-only source retrieval, 2026-10-16):** creation-time `UserContentEdit.diff` was treated as a full historical body only when its `editedAt` equalled `createdAt`; if unavailable, the task would be excluded. Assignment time comes from the run directory name, not a signed spec creation event. A pre-assignment issue revision without a spec is the best available proxy for “pre-spec,” but cannot prove that no private draft spec existed. Local clone object retention and GitHub edit-history availability also limit later rebuilds; the committed JSONL and hashes are the actual freeze.

## Mid-run growth scenario

The [simulation script](../../../spikes/v3/c3/growth_sim.py) is independent of the blind bundles. It reads **281** first, diffable issue-family attempts from **13** repositories, at most 40 chronological tasks per repository. All **281** selected tasks had a single candidate commit, so no log or commit history supplied a first-touch order. The baseline assumes alphabetical changed-file order; a sensitivity run reverses that assumed order for every second task. The complete raw [output](../../../spikes/v3/c3/output.txt) records inputs, skipped cases, assumptions and every metric.

The approved declare/grow/verify plan (D-LEASE-Q5-CPLUS) was not a complete shipped workflow in the supplied 2026-10-15 history. This simulation is a prospective comparison of mechanics, with no claim that its wait line or deadlock recovery existed in the historical runs.

**STRUCTURAL (simulation on local run history through 2026-10-15, run 2026-10-16):** an all-up-front policy requests every declared Allowed file atomically; gradual growth requests each actually changed file just before its first touch, holding claims until completion; no declaration does not claim. Each first file touch costs one arbitrary unit. Same-repository tasks start together in nonoverlapping windows of 2, 5 or 10, and lower agent index wins same-tick claims. A denied request is counted once per continuous wait. A cycle makes the youngest task release, lose its completed file work, pause one tick and restart. With no declaration, every pair that changes a common file incurs an **assumed**, not measured, two-unit repair cost. The table gives total simulated agent wait units / denials / deadlocks / restart work, followed by total window makespan. The no-declaration repair estimate is separate.

| Agents | Order | All upfront: wait / denial / deadlock / makespan | Grow: wait / denial / deadlock / lost work / makespan | No declaration: assumed repair events / units / makespan |
|---:|---|---|---|---|
| 2 | alphabetical | 122 / 35 / 0 / 845 | 81 / 30 / 0 / 0 / 833 | 34 / 68 / 827 |
| 2 | alternating reverse | 122 / 35 / 0 / 845 | 33 / 23 / 9 / 32 / 808 | 34 / 68 / 827 |
| 5 | alphabetical | 553 / 77 / 0 / 614 | 350 / 72 / 0 / 0 / 588 | 127 / 254 / 675 |
| 5 | alternating reverse | 553 / 77 / 0 / 614 | 261 / 93 / 18 / 61 / 573 | 127 / 254 / 675 |
| 10 | alphabetical | 1,256 / 106 / 0 / 515 | 810 / 103 / 0 / 0 / 491 | 279 / 558 / 842 |
| 10 | alternating reverse | 1,256 / 106 / 0 / 515 | 637 / 143 / 27 / 89 / 468 | 279 / 558 / 842 |

All-up-front's wait rises with agent count in these windows. Growth lowers modeled waiting but can add denials, deadlocks and lost work. Alphabetical order forces a common acquisition order and therefore hides cycles; the reverse sensitivity demonstrates that this zero is not evidence of safety. Gradual growth also receives a perfect trace of required files, which real agents lack. The simulation omits actual claim latency, renewal, expiry, queue phase, inspection, review, publish/land, merged-tree checks, symbol units, staggered arrivals and adaptation. Its no-declaration makespan depends strongly on the assumed repair cost. It cannot rank policies for real throughput or correctness.

## Protocol for a later prediction run

1. Freeze these JSONL hashes and preregister the file-prediction metric, top-k rule, time and model budget, and handling of missing labels. A separate operator checks cross-repository issue/parent links and quarantines related families across splits before any held-out prediction. Keep failures and refused-scope cases in denominators.
2. Give a separate prediction agent **only** one bundle at a time: tier label, repository, frozen issue text, assignment-time base SHA and split. Permit read-only checkout of that repository **at exactly the base SHA**. Block GitHub, current branches, run directories, specs, Allowed files, answers, later commits and final diffs. Do not provide this report's answer discussion during prediction. Never let the original spec author serve as the blind predictor.
3. Record the agent's ordered initial file set, uncertainty, rationale, discovery/grow requests if a live run is later approved, elapsed time and cost, before revealing any answer. Commit or hash the predictions. The research operator alone then joins `task_id` and `tier` to the answer key; train and held-out repository groups are reported separately.
4. Report per-task precision, recall, over-declaration and exact-set accuracy with clustered intervals by issue family and repository. Treat explicit refused-scope paths as positives. Report censored, undiffable and missing-path cases separately; do not score unknown unmet paths as true negatives. Report Tier A and LEAKY Tier B separately, with no pooled “blind” number. Symbols require a new independent answer audit. No prediction was run in this spike.

Four Tier A examples, with only two held out, are too few for a useful general test. A **50-family, three-repository** substantive blind pilot would at least expose gross failures and repository variation; even a simple proportion at 50 has a worst-case approximate 95% half-width of **14 percentage points** before clustering. Around **200** independent families would narrow that simple bound to about **7 points**; a real policy comparison needs a pilot variance and the owner's minimum useful improvement first. These are planning estimates, not gates.

The owner can (1) collect new issues with text frozen **before** any delegation spec is written, including first-touch and scope-growth events; (2) use a public issue-to-change corpus whose issue revisions and assignment-time trees can be audited; or (3) use Tier B for a limited diagnostic while explicitly accepting its author-knowledge bias. **CAPABILITY-DEPENDENT (2026-10-16; re-test with current agents):** whether a predictor can infer enough of the first write set remains unanswered by all three options until an independent run occurs.

## Reproduction and decision check

```sh
PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c3/build_dataset.py
PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c3/growth_sim.py
PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c3/growth_sim.py > /dev/null
wc -w docs/spikes/v3/c3-blind-footprints.md
```

The first command reads only local runs/clones and read-only `gh api graphql` issue revisions; its stdout is the repository and exclusion counts tabulated above. The second command writes the raw output file. Python executions in this run set `PYTHONDONTWRITEBYTECODE=1`. The current `npm run -s decisions` check was attempted before editing and failed because local `tsx` is missing; it could not produce an `Approved but not live:` list. Raw failure:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'
Node.js v26.7.0
```

No global installation, product code change or prediction call was made.
