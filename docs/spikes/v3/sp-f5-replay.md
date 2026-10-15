# SP-F5: larger lock-scheme replay

## Result

The replay evaluated 1,304 overlapping merged-PR pairs from a universe of 7,594. It covered every one of Concord's 104 pairs and 300 pairs from each of the other four repositories. The deterministic SHA-256 ranking selected candidates; none of the selected pairs lacked a merge base, so no replacements were needed. Git reported 40 textual-conflict pairs. Thirty-six conflict pairs involved append-only index/log files, seven involved code, and three involved docs/Markdown; a pair can appear in more than one file-class view.

| Scheme | Blocked | Needless blocks | Missed conflicts | Pairwise serial delay (hours) | Residual conflict rate (95% Wilson) |
| --- | ---: | ---: | ---: | ---: | ---: |
| No lock | 0 | 0 | 40 | 0.00 | 3.07% [2.26%, 4.15%] |
| File | 241 | 201 | 0 | 1,865.89 | 0.00% [0.00%, 0.36%] |
| Git funcname | 241 | 201 | 0 | 1,865.89 | 0.00% [0.00%, 0.36%] |
| Tree-sitter node | 234 | 194 | 0 | 1,855.04 | 0.00% [0.00%, 0.36%] |
| Interface exclusive / body shared | 241 | 201 | 0 | 1,865.89 | 0.00% [0.00%, 0.36%] |
| Hunk line range | 59 | 19 | 0 | 1,039.74 | 0.00% [0.00%, 0.31%] |
| File + policy-exclusive | 241 | 201 | 0 | 1,865.89 | 0.00% [0.00%, 0.36%] |
| Adaptive | 45 | 10 | 5 | 518.91 | 0.40% [0.17%, 0.93%] |
| Union merge for append-only index files | 0 | 0 | 8 | 0.00 | 0.61% [0.31%, 1.21%] |
| Mergiraf at land | 0 | 0 | 37 | 0.00 | 2.84% [2.07%, 3.89%] |

The union scheme removes 32 of the 40 observed textual conflicts by applying `git merge-file --union` to append-only index/log conflicts; all other conflict paths retain the `merge-tree` result. Mergiraf resolved 3 of 44 conflicted content files it was given, leaving 37 conflict pairs. These are merge-at-land comparisons, not lock decisions. The full output includes separate overall, per-repository, and per-file-class tables for every scheme, with Wilson intervals, plus pair examples and raw merge output: [replay output](../../../spikes/v3/sp-f5/output.txt).

## Method

The script retrieves merged pull-request metadata with `gh api --paginate repos/OWNER/REPO/pulls?state=closed&per_page=100`, then pairs PRs whose `created_at`–`merged_at` intervals overlap. It ranks each repository's pairs by SHA-256 of the repository and PR numbers, selects the first `min(all overlapping pairs, 300)` evaluable pairs, and processes the selected set in later-open-time order. If a ranked pair cannot be evaluated, it records the pair and reason and advances to the next rank. No pair was unevaluable in this run. The complete candidate attempts and repository counts are in the output.

For every pair, the script finds its shared merge base and runs:

```sh
git --git-dir=TEMP_BARE_MIRROR merge-tree --write-tree --merge-base=BASE HEAD_A HEAD_B
```

Actual per-pair commands, raw conflict snippets, and transcript hashes are in the output; full transcripts and machine-readable pair records remain under task scratch. Missing PR-head objects and merge-result objects are written only to temporary bare mirrors. The five local clones are read-only inputs.

The tree-sitter language pack was installed in scratch. A package check confirmed grammars for the requested TypeScript, TSX, JavaScript, Python, Rust, C, C++, Bash, and Swift languages; the output lists grammars actually invoked by changed code (Bash, C, C++, CSS, HTML, JavaScript, Python, Rust, SQL, and TypeScript). No grammar-unavailable fallback rows occurred. Tree-sitter fallback cases are reported by extension, language, and reason. The 155,253 code-side fallback cases were missing file sides or parser/query errors and widen the corresponding lock unit to file scope. JSON, YAML, TOML, plain-text, Markdown, and append-only index/log files are classified separately and do not enter parser-fallback counts. The output reports `non-code data` as its own class in addition to code, docs/Markdown, append-only index/log, lockfiles/generated/binary, and other.

The two merge-at-land commands are:

```sh
git merge-file --union OURS BASE THEIRS
mergiraf merge --path-name PATH --output TEMP_OUTPUT BASE LEFT RIGHT
```

They operate on temporary copies of the conflicting file contents. Union merging is attempted only for append-only index/log paths; merge-tree conflict results remain for all other paths. Mergiraf is evaluated on conflicted content files and a path is counted resolved only when it exits successfully and its output contains no conflict markers.

“Needless” means a lock scheme blocks a pair whose ordinary merge-tree result is clean. “Missed” means it permits a pair with a conflict under that scheme's observed merge-at-land result. The residual rate is missed conflicts divided by pairs permitted by the scheme; its interval is the 95% Wilson score interval. For merge-at-land schemes that permit all pairs, the denominator is the full evaluated sample.

**Pairwise serial delay** is computed per blocked pair as `max(0, earlier_created_PR.merged_at - later_created_PR.created_at)` in hours, where earlier/later refer to PR creation time. The reported delay is the sum across blocked pairs, so a PR's interval can be counted once for each blocked overlapping PR. It is a timestamp-based accounting estimate, not measured agent wait time.

The schemes model the lock units as follows: file locks compare changed paths; Git funcname locks use Git's function-context hunk headers; tree-sitter node locks use the enclosing named node and normalized signature; interface/body locks make signature edits exclusive and body edits shared; hunk locks compare changed line ranges; file + policy adds shared exclusive classes for lockfiles, migrations, generated output and binary files; adaptive locks paths after a textual conflict is seen earlier in the sampled chronological order. Empty or unsupported symbol information widens to file scope. The merge-at-land schemes use the residual conflict sets described above.

## Limits

1. This measures textual Git merge conflicts only. It did not run tests and cannot determine test breakage, semantic conflicts, build failures, runtime effects, or whether a human could resolve a conflict.
2. Overlapping PR-open intervals are only a proxy for concurrent agents. The data does not reveal agent start/stop times, claim acquisition, review waits, retries, or actual merge scheduling.
3. Only merged PRs are included. Abandoned, open, draft-only, and unmerged work is absent. The interval from creation through merge ignores close/reopen periods and draft state.
4. Each repository is sampled independently, with a cap of 300. The sample is not weighted to represent repository populations; Concord's smaller universe is a census.
5. A PR's final head SHA is compared with the other PR's final head, even when that SHA reflects updates made after their overlap began. This does not reconstruct contemporaneous branch contents.
6. Merge-base-relative changed paths and lock units are approximations. Rename detection is disabled; repository-wide dependencies, generated effects, untracked files, and semantic dependencies are not inferred.
7. Git funcname results depend on each repository's attributes and diff drivers. The Concord TypeScript rule recognizes function declarations and misses some TypeScript declarations, methods, overloads, and class structures; empty headers widen to file.
8. Tree-sitter uses extension-selected grammars and enclosing nodes with a `body` field. Parser errors, syntax errors, macros, decorators, anonymous or cross-file constructs, and line-based interface detection can widen or misidentify lock units.
9. Hunk ranges do not capture semantic dependencies, context-only assumptions, rename intent, or edit-order effects. Insertions at the same position count as overlapping.
10. Policy classes use fixed path/name heuristics. They can miss project-specific lockfiles/generated artifacts or classify ordinary files as sensitive; they do not encode migration ordering or merge drivers.
11. Adaptive locking is order-dependent and learns only from conflicts seen earlier in this sample. It does not model expiration, release timing, or multiple units in a file.
12. Pairwise delay is estimated from PR timestamps and double-counts intervals across pairs; it is not observed waiting time.
13. Mergiraf's clean output is not proof of semantic correctness. The replay considers only textual content-conflict files and does not modify the PR trees.
14. GitHub metadata and PR refs can change or disappear. A pair that cannot be evaluated is excluded with its reason and replaced by the next deterministic rank; a repository that cannot reach its target stops the replay.
15. The replay reads local clones and writes fetched objects, merge results, and raw records only to temporary mirrors and task scratch; it does not reconstruct PR state at open time.
