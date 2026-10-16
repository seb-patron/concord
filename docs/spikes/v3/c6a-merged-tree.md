# What happened when the forty replay conflicts were merged

**Answer.** None of the forty sampled textual conflicts merged with ordinary Git. A narrowly applied union rule for the repository’s two append-only trail logs cleared thirty-two pairs; eight still had unresolved source, test, instruction, or add/add conflicts. Mergiraf was not installed, so it could not be evaluated. The log conflicts look mechanically mergeable under that rule, but the replay did not establish that the resulting logs were correctly ordered or that the merged trees were semantically sound. This evidence can inform unit and merge-order question 6; it does not justify changing the current exclusive-lease decision.

This is an offline replay of final pull-request heads from one repository. A **textual conflict** means Git could not combine the same path automatically. A **successful merge** here means Git produced a tree without unresolved index entries; it does not mean the tree passed tests, was correct, or was accepted by an owner. **Append-only log union** keeps both sides’ conflicting text with Git’s union merge driver. Output order can be arbitrary, so the rule is safe only for a path whose format and consumer tolerate that order.

## Evidence and method

The input was the forty conflict records from the earlier SP-F5 replay, all from `gen-v-research-tools`. The replay’s text summary names only representative conflicts; the full base and two head revisions came from its referenced `pair-results.json` artifact. The source checkout at `/Users/sebastianpatronsoto/agent-runs/clones/gen-v-research-tools` was read-only. The spike cloned it beneath the system temporary directory and used the earlier local replay mirror as a read-only object reference for two pull-request commits absent from the source clone. It did not fetch from a network or alter either source repository.

For each pair, the script checked out the recorded merge base in that temporary clone and tried an ordinary two-head Git merge. It then reset and retried, applying `git merge-file --union` only to conflicts in `LAB_READING_TRAIL.md` or `trail/INDEX.md`. Other conflicting paths were left unresolved. If Mergiraf is installed, the script also tries its three-way resolver on conflicted paths; it was absent in this environment and was not installed. Every merge that completed cleanly was checked with the repository’s documented test command, `PYTHONPATH=src python3 -m unittest discover -s tests -v`. Each invocation had a five-minute timeout. The script records commands, merge output, unresolved paths, check status and output tail in `spikes/v3/c6a/output.txt`.

The merge commands, from the temporary clone, were `git merge --no-commit --no-ff HEAD_A HEAD_B` and, for allowlisted log conflicts, `git merge-file --union -p OURS BASE THEIRS`. The transcript preserves the actual revisions, per-pair raw Git merge output, check command, duration and captured test-output tail.

Run command:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c6a/merged_tree.py /Users/sebastianpatronsoto/agent-runs/concord-c1b87e70add5a86a89981a0a/work-codex-20261015T213154Z-16a5e3da61c85739b222df0cd7eaeede/scratch/sp-f5-raw-bvyn00x9/pair-results.json
```

The script writes its transcript to standard output; redirect it to the output file to retain the run record. Classification is based on the tested merge behavior: **trivially resolvable** means ordinary Git succeeded; **resolvable with a rule** means the append-only log rule cleared all conflicts; **needs a human/agent decision** means conflicts remained after those attempts. A future successful structural resolver would also count as a rule-based resolution, but no such result exists in this run.

## Results for all forty pairs

| Pull requests | Conflicting paths | Ordinary Git | Log union | Mergiraf | Classification and reason |
|---|---|---|---|---|---|
| 170 and 172 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 160 and 174 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 160 and 175 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 174 and 175 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 175 and 193 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 193 and 194 | `src/gen_v_research_tools/nds.py` | conflict | conflict | unavailable | Decision: Python source conflict remains |
| 193 and 197 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 193 and 201 | `src/gen_v_research_tools/rng_evaluator.py`; `tests/test_rng_evaluator.py` | conflict | conflict | unavailable | Decision: source and test additions conflict |
| 210 and 211 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 225 and 229 | `src/gen_v_research_tools/save5_position.py`; `tests/test_save5_position.py` | conflict | conflict | unavailable | Decision: source and test additions conflict |
| 225 and 230 | `scripts/run_npc_tile_lookup.py`; `tests/test_npc_tile_lookup.py` | conflict | conflict | unavailable | Decision: script and test additions conflict |
| 193 and 233 | `AGENTS.md`; `scripts/build_trail_index.py`; `tests/test_build_trail_index.py`; `trail/INDEX.md` | conflict | conflict | unavailable | Decision: rule cannot resolve mixed instruction, code and log changes |
| 216 and 233 | `AGENTS.md`; `scripts/build_trail_index.py`; `tests/test_build_trail_index.py`; `trail/INDEX.md` | conflict | conflict | unavailable | Decision: rule cannot resolve mixed instruction, code and log changes |
| 217 and 233 | `AGENTS.md`; `scripts/build_trail_index.py`; `tests/test_build_trail_index.py`; `trail/INDEX.md` | conflict | conflict | unavailable | Decision: rule cannot resolve mixed instruction, code and log changes |
| 227 and 233 | `trail/INDEX.md` | conflict | conflict | unavailable | Decision: add/add log conflict has no common base for union |
| 307 and 346 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 295 and 348 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |
| 300 and 348 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |
| 309 and 348 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |
| 307 and 350 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 346 and 350 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 348 and 350 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 295 and 351 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 311 and 351 | `LAB_READING_TRAIL.md` | conflict | success | unavailable | Rule: append-only trail log |
| 303 and 352 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 304 and 352 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 311 and 352 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 351 and 352 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 299 and 353 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |
| 309 and 353 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |
| 329 and 357 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |
| 330 and 368 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 299 and 369 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 300 and 369 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 303 and 369 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 320 and 369 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 330 and 369 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 368 and 369 | `trail/INDEX.md` | conflict | success | unavailable | Rule: append-only index log |
| 293 and 371 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |
| 320 and 371 | `LAB_READING_TRAIL.md`; `trail/INDEX.md` | conflict | success | unavailable | Rule: both append-only logs unioned |

## Totals and interpretation

Ordinary Git succeeded on **0 of 40**. The append-only union rule succeeded on **32 of 40**; eight remained unresolved. Mergiraf was **not available**, so there are no Mergiraf success or failure counts. The resulting classifications are **0 trivially resolvable, 32 resolvable with a rule, and 8 needing a human or agent decision**.

The repository check completed in under five minutes on all **32** successful union trees, but it did not pass in this sandbox. The recorded summaries span **919–1,535 tests**, with **11 failures, 47 errors, and 5 or 6 skipped** per run; check commands took about **96–136 seconds**. The failures include `PermissionError` while trying to create `/private/tmp/gen-v-machine-worker-governor`; this environment denied that system path, so dependent tests failed before reaching their intended assertions. The exact per-merge command, duration and captured output tail are in the transcript. Treat these check outcomes as environment-limited and inconclusive about merged-tree breakage, not as green validation.

The replay’s path-class summary counts **36 append-only index/log pairs, 7 code pairs, and 3 documentation or Markdown pairs**. These categories overlap: their 46 memberships describe 40 pairs, not 46 distinct pairs. The collisions mainly concern two centralized logs, so treating all forty as examples of source-code merge difficulty would be misleading. The mixed conflicts in the trail-index-builder changes are also a useful boundary case: a log-only rule does not resolve simultaneous changes to its generator, tests, and repository instructions.

**STRUCTURAL (source date: 2026-10-15, replay input).** Git’s ordinary merge left textual conflicts in this recorded sample, while union cleared many append-only log paths. A clean union result does not establish ordering, deduplication, format validity, or downstream behavior. Four unresolved pairs include add/add conflicts where the append-only path has no shared base version; `git merge-file` cannot apply a three-way union without that base.

**CAPABILITY-DEPENDENT (source date: 2026-10-16, this run).** The classification measures resolver behavior, not whether a person or agent can cheaply repair the remaining eight conflicts. No human repair, agent repair, review, or repair-time measurement was performed. Mergiraf capability is unmeasured in this environment because it was absent. Re-test resolver availability and current agent repair performance before using these outcomes to estimate labor.

For owner question 6, this is bounded evidence for considering append-only logs as a class with a possible land-time merge rule, with validation and canonicalization required before acceptance. It does not decide which files merit pre-edit exclusivity or whether another unit size is safe. The recorded policy remains the exclusive write claim in **decision D-UNIT-1-EXCLUSIVE**; shared or hybrid writing still waits on a land-time merge under **decision D-UNIT-4-STRUCT-MERGE**. The report is an input to that choice, not a policy change.

## Limits and open items

Only one repository supplied all forty conflicts. The sample compares final pull-request heads and their recorded merge bases, not contemporaneous branches or live agent work. It excludes abandoned changes and does not measure lease waits, overlap response, repair effort, semantic breakage, deployment safety, or lost work. The repository’s configured unit-test command was attempted on every merged tree, but the environment-denied failures mean it did not verify those trees. Even a green run would not prove merge correctness. Log classes were inherited from the replay classification and the union allowlist is specific to the two named paths. Changes to these paths’ format or generation rules invalidate that assumption.

These outcomes are not code-merge evidence for other repositories. Next useful evidence would include owner-approved checks for canonical log order and deduplication, a Mergiraf-enabled rerun if that tool is selected, and independently measured repairs for the eight unresolved pairs. No web sources were used. Supplied local inputs read in full were `claims-options.md`, `sp-f5-replay.md`, and `sp-f5-output.txt` (source date 2026-10-15); this run’s environment and check results are dated 2026-10-16.
