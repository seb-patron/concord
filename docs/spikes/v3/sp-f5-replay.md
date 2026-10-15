# SP-F5: replaying lock schemes on overlapping pull requests

## Result

The replay covers real merged pull requests from the five requested repositories. Merge results are a textual proxy for integration conflicts. They do not establish whether either PR would fail tests, require semantic coordination, or be safe to land.

| Scheme | Pairs blocked | Needless blocks | Missed textual conflicts | Pairwise serial delay (hours) |
| --- | ---: | ---: | ---: | ---: |
| No lock | 0 | 0 | 6 | 0.00 |
| File | 20 | 14 | 0 | 243.89 |
| Git funcname symbol | 20 | 14 | 0 | 243.89 |
| Tree-sitter enclosing node | 19 | 13 | 0 | 242.94 |
| Interface exclusive / body shared | 20 | 14 | 0 | 243.89 |
| Hunk line range | 8 | 2 | 0 | 203.45 |
| File plus policy-exclusive classes | 20 | 14 | 0 | 243.89 |
| Adaptive | 6 | 2 | 2 | 6.46 |

The generated [raw output](../../../spikes/v3/sp-f5/output.txt) gives the exact counts, sample sizes, representative PRs and raw merge-tree examples. The replay writes its machine-readable pair records and full per-pair merge-tree transcripts only below `$DELEGATE_SCRATCH_DIR`.

## Method

The script asks `gh api --paginate repos/OWNER/REPO/pulls?state=closed&per_page=100 --jq '[.[] | select(.merged_at != null) | {number,created_at,merged_at,head:{sha:.head.sha},base:{sha:.base.sha},title,html_url}]'` for merged PR metadata, including PR number, creation and merge timestamps, final head SHA and title. It pairs PRs whose interval from `created_at` through `merged_at` intersects. Within each repository, it ranks candidate pairs by SHA-256 of the repository and sorted PR numbers, selects the lowest ranks up to the 30-pair per-repository cap, then processes the selection in later-open-time order. This is a deterministic repository-stratified sample, not a census. Across the five repositories it evaluated 150 pairs from 7,594 overlapping candidates. Missing head commits are fetched with `git fetch` from the repository remote into a temporary bare mirror. The local clones are inputs only.

For each pair, the shared Git merge base is computed and the real textual result is calculated with:

```sh
git --git-dir=TEMP_BARE_MIRROR merge-tree --write-tree --merge-base=BASE HEAD_A HEAD_B
```

The mirror reads the local clone's object database as an alternate and receives any missing PR head objects. `--write-tree` stores merge-result objects in that temporary mirror. It does not update clone refs or objects. Exit status 0 is a clean textual merge; status 1 is a merge with conflicts. The output records each command, result tree, conflict paths, classification, SHA-256 of the raw output, and representative literal output. Full transcripts remain in scratch.

The schemes are applied to each PR's changes from that pair's shared merge base. The output recorded 4,733 tree-sitter source-side fallbacks (unsupported extension, parser error or isolated parser failure), each widened to file scope; tree-sitter results therefore reflect the supported and parseable subset of changed file sides.

* **No lock:** every pair is allowed.
* **File:** block when the PRs change at least one common path.
* **Git funcname symbol:** use `git diff --function-context` hunk headers selected by Git and repository diff drivers. For Concord TypeScript files, apply the v2 xfuncname rule `^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+[[:alnum:]_]+` from the lease policy documentation. Missing or empty headers widen to the file.
* **Tree-sitter enclosing node:** use py-tree-sitter to identify the nearest enclosing named syntax node with a body. Its identity is node type plus normalized signature. If the before and after identities differ, parsing fails, or the extension has no configured grammar, widen that edit to the file.
* **Interface exclusive / body shared:** use the same node and widening rules. An edit touching the signature lines gets an exclusive interface unit; body edits get a shared body unit. Same-node body/body pairs are allowed; a signature edit blocks a same-node body or signature edit.
* **Hunk line range:** block when changed half-open line ranges in the shared merge-base overlap. Two insertions at the same position overlap.
* **File plus policy-exclusive classes:** take file locks and also block when both PRs touch any member of the same broad class: lockfiles, migration paths, generated/vendor output, or binary files. The class patterns are fixed in `replay.py` and intentionally conservative.
* **Adaptive:** initially allow pairs. After a textual conflict names a path, treat that path as exclusive for later sampled pairs in that repository's time order.

“Needless” means blocked while `merge-tree` is clean. “Missed” means allowed while `merge-tree` reports conflict. Pairwise serial delay is the later-opening PR's wait until the earlier-opening PR's actual merge time, floored at zero, for each blocked overlapping pair. The sum is pairwise and can count the same PR's waiting time more than once when it overlaps multiple blocked PRs.

Mergiraf is installed under the task scratch directory. For each `merge-tree` content-conflict file, the script runs Mergiraf on the pair's base and two heads, passes the real path for language detection, and checks whether its output has conflict markers. Results count tested files and files reported resolved; they do not alter the Git result or scheme scores.

## Examples

Each listed pair is a real sampled pair. “Needless” examples are blocked pairs with a clean merge-tree result; “missed” examples are allowed pairs with a textual conflict. Paths and pairwise delay are included.

### No lock

Needless blocks: none. Missed conflicts (5):

* [gen-v-research-tools #193 + #197](https://github.com/seb-patron/gen-v-research-tools/pull/193) — `LAB_READING_TRAIL.md`, `research/2026-09-17-n06-rng-state-control-spike.md`; 125.56 h.
* [gen-v-research-tools #225 + #230](https://github.com/seb-patron/gen-v-research-tools/pull/225) — `scripts/run_npc_tile_lookup.py`, `src/gen_v_research_tools/npc_tile_lookup.py`, `tests/test_npc_tile_lookup.py`; 71.92 h.
* [gen-v-research-tools #346 + #350](https://github.com/seb-patron/gen-v-research-tools/pull/346) — `LAB_READING_TRAIL.md`, `trail/INDEX.md`; 0.04 h.
* [gen-v-research-tools #295 + #351](https://github.com/seb-patron/gen-v-research-tools/pull/295) — `LAB_READING_TRAIL.md`, `trail/INDEX.md`; 0.84 h.
* [gen-v-research-tools #299 + #353](https://github.com/seb-patron/gen-v-research-tools/pull/299) — `LAB_READING_TRAIL.md`, `trail/INDEX.md`; 0.46 h.

### File

Needless blocks (5):

* [concord #28 + #35](https://github.com/seb-patron/concord/pull/28) — `tests/node/docs.test.ts`; 0.95 h.
* [concord #25 + #36](https://github.com/seb-patron/concord/pull/25) — `cli/main.ts`, `docs/cli.md`; 0.00 h.
* [agent-workflows #40 + #41](https://github.com/seb-patron/agent-workflows/pull/40) — `README.md`, `lib/_worker.sh`, `tests/run-tests.sh`; 0.55 h.
* [agent-workflows #118 + #130](https://github.com/seb-patron/agent-workflows/pull/118) — `README.md`, `bin/delegate-issue`, `skills/delegate/SKILL.md`, `tests/run-tests.sh`; 9.38 h.
* [agent-workflows #171 + #172](https://github.com/seb-patron/agent-workflows/pull/171) — `README.md`, `bin/delegate-issue`; 1.49 h.

Missed conflicts: none.

### Git funcname symbol

Needless blocks (5):

* [concord #28 + #35](https://github.com/seb-patron/concord/pull/28) — `tests/node/docs.test.ts`; 0.95 h.
* [concord #25 + #36](https://github.com/seb-patron/concord/pull/25) — `cli/main.ts`, `docs/cli.md`; 0.00 h.
* [agent-workflows #40 + #41](https://github.com/seb-patron/agent-workflows/pull/40) — `README.md`, `lib/_worker.sh`, `tests/run-tests.sh`; 0.55 h.
* [agent-workflows #118 + #130](https://github.com/seb-patron/agent-workflows/pull/118) — `README.md`, `bin/delegate-issue`, `skills/delegate/SKILL.md`, `tests/run-tests.sh`; 9.38 h.
* [agent-workflows #171 + #172](https://github.com/seb-patron/agent-workflows/pull/171) — `README.md`, `bin/delegate-issue`; 1.49 h.

The function-key scheme produced the same pair classifications as file locks in this sample. Missed conflicts: none.

### Tree-sitter enclosing node

Needless blocks (5):

* [concord #25 + #36](https://github.com/seb-patron/concord/pull/25) — `cli/main.ts`, `docs/cli.md`; 0.00 h.
* [agent-workflows #40 + #41](https://github.com/seb-patron/agent-workflows/pull/40) — `README.md`, `lib/_worker.sh`, `tests/run-tests.sh`; 0.55 h.
* [agent-workflows #118 + #130](https://github.com/seb-patron/agent-workflows/pull/118) — `README.md`, `bin/delegate-issue`, `skills/delegate/SKILL.md`, `tests/run-tests.sh`; 9.38 h.
* [agent-workflows #171 + #172](https://github.com/seb-patron/agent-workflows/pull/171) — `README.md`, `bin/delegate-issue`; 1.49 h.
* [agent-workflows #214 + #217](https://github.com/seb-patron/agent-workflows/pull/214) — `README.md`, `skills/delegate/SKILL.md`; 18.22 h.

Missed conflicts: none.

### Interface exclusive / body shared

Needless blocks (5):

* [concord #28 + #35](https://github.com/seb-patron/concord/pull/28) — `tests/node/docs.test.ts`; 0.95 h.
* [concord #25 + #36](https://github.com/seb-patron/concord/pull/25) — `cli/main.ts`, `docs/cli.md`; 0.00 h.
* [agent-workflows #40 + #41](https://github.com/seb-patron/agent-workflows/pull/40) — `README.md`, `lib/_worker.sh`, `tests/run-tests.sh`; 0.55 h.
* [agent-workflows #118 + #130](https://github.com/seb-patron/agent-workflows/pull/118) — `README.md`, `bin/delegate-issue`, `skills/delegate/SKILL.md`, `tests/run-tests.sh`; 9.38 h.
* [agent-workflows #171 + #172](https://github.com/seb-patron/agent-workflows/pull/171) — `README.md`, `bin/delegate-issue`; 1.49 h.

Missed conflicts: none.

### Hunk line range

Needless blocks (2):

* [concord #25 + #36](https://github.com/seb-patron/concord/pull/25) — `cli/main.ts`, `docs/cli.md`; 0.00 h.
* [gen-v-research-tools #175 + #194](https://github.com/seb-patron/gen-v-research-tools/pull/175) — `src/gen_v_research_tools/narc.py`, `src/gen_v_research_tools/nds.py`, `src/gen_v_research_tools/q1_static_verification.py`, `tests/test_parser_fuzz.py`; 0.76 h.

Missed conflicts: none.

### File plus policy-exclusive classes

Needless blocks (5):

* [concord #28 + #35](https://github.com/seb-patron/concord/pull/28) — `tests/node/docs.test.ts`; 0.95 h.
* [concord #25 + #36](https://github.com/seb-patron/concord/pull/25) — `cli/main.ts`, `docs/cli.md`; 0.00 h.
* [agent-workflows #40 + #41](https://github.com/seb-patron/agent-workflows/pull/40) — `README.md`, `lib/_worker.sh`, `tests/run-tests.sh`; 0.55 h.
* [agent-workflows #118 + #130](https://github.com/seb-patron/agent-workflows/pull/118) — `README.md`, `bin/delegate-issue`, `skills/delegate/SKILL.md`, `tests/run-tests.sh`; 9.38 h.
* [agent-workflows #171 + #172](https://github.com/seb-patron/agent-workflows/pull/171) — `README.md`, `bin/delegate-issue`; 1.49 h.

The sampled policy classes added no classifications beyond file locks. Missed conflicts: none.

### Adaptive

Needless blocks (2):

* [gen-v-research-tools #347 + #348](https://github.com/seb-patron/gen-v-research-tools/pull/347) — `LAB_READING_TRAIL.md`, `trail/INDEX.md`; 0.06 h.
* [gen-v-research-tools #807 + #808](https://github.com/seb-patron/gen-v-research-tools/pull/807) — `trail/INDEX.md`; 1.20 h.

Missed conflicts (2):

* [gen-v-research-tools #193 + #197](https://github.com/seb-patron/gen-v-research-tools/pull/193) — `LAB_READING_TRAIL.md`, `research/2026-09-17-n06-rng-state-control-spike.md`; 125.56 h.
* [gen-v-research-tools #225 + #230](https://github.com/seb-patron/gen-v-research-tools/pull/225) — `scripts/run_npc_tile_lookup.py`, `src/gen_v_research_tools/npc_tile_lookup.py`, `tests/test_npc_tile_lookup.py`; 71.92 h.

## Limits

1. Only merged PRs are included. Abandoned, still-open, draft-only and unmerged work is absent.
2. `created_at` to `merged_at` treats a PR as continuously open. It does not reconstruct close/reopen episodes, draft state, review queues, or exact times when a PR was ready to merge.
3. The sample is deterministic and capped per repository. It is not weighted to represent the full pair universe, and the capped repositories contribute equally to sample count despite different populations.
4. A PR's final head SHA is compared with the other PR's final head. It may contain updates or branch changes that occurred after their open intervals overlapped. This is not a checkout of each PR at every concurrent point in history.
5. `merge-tree` measures Git's textual merge behavior from the shared head merge base. It is only a proxy for simultaneous integration; it says nothing about test failures, semantic conflicts, build breakage, review rework, or whether a conflict would be resolved by a human.
6. Merge-base-relative changes and policy units approximate claims. Repository-wide dependencies, generated effects, runtime behavior, build inputs and untracked files are not inferred.
7. Git funcname results depend on the repository's diff attributes and drivers. The Concord TypeScript pattern recognizes function declarations; it does not model all TypeScript classes, methods, overloads, declarations, or semantic dependencies. Empty and ambiguous headers widen to file.
8. Tree-sitter uses grammars selected by filename extension and enclosing nodes with a `body` field. Unsupported grammars, parser errors, syntax errors, macros, decorators, anonymous or cross-file constructs can widen to file or identify a node differently from a developer. Interface/body is a line-based proxy for API versus implementation.
9. Hunk ranges do not capture semantic dependence, context-only assumptions, rename intent, or edit-order effects. The replay disables rename detection and treats additions/deletions conservatively as paths.
10. Policy-exclusive classes are hand-selected path/name heuristics. They can classify ordinary files as sensitive, miss project-specific lockfiles or generated artifacts, and do not encode migration ordering or binary merge drivers.
11. Adaptive learns only from conflicts observed earlier in the sampled order. It is order-dependent, ignores conflicts outside the sample, and does not model expiration, release timing, or multiple units within a file.
12. Delay is an accounting estimate from observed PR timestamps, not measured waiting time. Pairwise sums double-count PRs; real lease acquisition order, agent arrival, parallel work, retries and resolution time are unknown.
13. Mergiraf is run only on textual content-conflict files. A clean Mergiraf output is not proof of semantic correctness; unsupported formats or parser fallback can leave a conflict. Its results are independent observations, not edits to the PR trees.
14. API metadata and PR refs can change or disappear, and GitHub's final head may not be fetchable. Any pair that cannot be evaluated is excluded and counted separately in the output.
15. This replay reads local clones and writes result objects, fetched objects and raw records only to a temporary bare mirror and the task scratch area. It does not make the five clones fully self-contained snapshots of GitHub at PR-open time.
