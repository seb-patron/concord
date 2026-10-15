# Declared and actual worker footprints

This local history study supports the Concord v3 question: if an issue declares
the files it expects to touch, could claiming the issue claim those leases?
It measures past worker specifications and changes; it does not run agents or
test a new claiming policy.

## Result

After excluding clone contents and deduplicating archived copies by their
recorded run directory, **10,513 runs** had an `allowed-files.txt`, a
`status.json`, and either `work-spec.md` or `prompt.md`. **5,367** had a
candidate or validated SHA that could be diffed locally after trying both the
matching clone and the run worktree. The minimum of 200 diffable committed runs
is met.

Among those 10,513 unique eligible runs, 4,752 had no candidate/validated SHA
and 394 had a SHA that could not be diffed in either local source. The scan
also skipped 1,804 duplicate archived copies and 457 directories with an
allowed-file marker before eligibility: 85 lacked `status.json`, 363 lacked
both prompt/spec files, and 9 had invalid JSON. It cannot count runs that have
no `allowed-files.txt` marker.

For diffable committed runs, declared paths that appeared in the base-to-head
diff accounted for **74.8%** of declared file entries (19,814 of 26,494), so
the remaining **25.2%** were declared but unchanged. These are file-entry
shares pooled across runs, not the fraction of runs with any over-declaration.
There were **1,403** runs with a status state containing `refused-scope` or
`refused_scope` (13.3% of analyzed runs).

Pairs of runs were compared only within the same repository. Of 3,800,963
same-repository pairs with intersecting approximate working intervals,
896,897 (25.0%) declared at least one common path; 66,728 (1.9%) had at
least one common changed path. These are pair counts, not a causal estimate of
contention or the effect of leases.

## Repository results

The generated [raw output](../../spikes/v3/s5/output.txt) contains skip
reasons and five examples each for declared overlaps, actual overlaps, and
scope refusals. The table below summarizes every repository label observed in
status files. `Skipped` gives missing SHA / no local diff / duplicate archived
copy / other. The 457 pre-eligibility exclusions are not assigned to a
repository total. Runs with a missing or unrecognized repository label are
grouped under `unknown`.

| Repository | Runs | No SHA / no local diff / duplicate / other skipped | Declared files median / p90 | Declared files changed | Refused scope | Declared / actual overlapping pairs |
|---|---:|---:|---:|---:|---:|---:|
| 3 | 12 | 4 / 0 / 0 / 0 | 1 / 2 | 100.0% | 0 | 1 / 0 |
| 4 | 5 | 3 / 0 / 0 / 0 | 2 / 2 | 100.0% | 0 | 3 / 0 |
| agent-review-evals | 138 | 41 / 0 / 0 / 0 | 3 / 3 | 96.3% | 11 | 558 / 428 |
| agent-run-analytics | 8 | 5 / 0 / 0 / 0 | 1 / 4 | 100.0% | 0 | 0 / 0 |
| agent-workflows | 989 | 459 / 18 / 1,804 / 0 | 3 / 8 | 84.7% | 10 | 51,766 / 14,761 |
| antechamber | 1 | 1 / 0 / 0 / 0 | 10 / 10 | n/a | 0 | 0 / 0 |
| azeron-macos | 184 | 36 / 1 / 0 / 0 | 2 / 5 | 89.9% | 1 | 1,047 / 683 |
| azeron-windows-protocol-lab | 4 | 2 / 0 / 0 / 0 | 3.5 / 4 | 100.0% | 2 | 6 / 1 |
| concord | 1,209 | 653 / 0 / 0 / 0 | 2 / 17 | 65.5% | 6 | 3,410 / 536 |
| decomp-learning | 13 | 8 / 0 / 0 / 0 | 1 / 3 | 100.0% | 0 | 38 / 10 |
| gen-v-decomp | 3,456 | 1,920 / 1 / 0 / 0 | 1 / 5 | 80.8% | 518 | 609,875 / 18,791 |
| gen-v-map-studio | 83 | 7 / 0 / 0 / 0 | 3 / 10 | 94.3% | 4 | 463 / 368 |
| gen-v-research-tools | 597 | 113 / 3 / 0 / 0 | 5 / 7 | 88.3% | 17 | 72,710 / 23,074 |
| gen-v-workshop | 512 | 110 / 308 / 0 / 0 | 4 / 9 | 92.3% | 8 | 7,606 / 128 |
| mother-base | 261 | 158 / 0 / 0 / 0 | 1 / 2 | 96.1% | 2 | 7,456 / 117 |
| mwcc-rs | 1,900 | 920 / 24 / 0 / 0 | 1 / 14 | 60.4% | 742 | 139,896 / 6,629 |
| probe | 3 | 1 / 0 / 0 / 0 | 1 / 1 | 100.0% | 0 | 1 / 0 |
| repo | 759 | 220 / 2 / 0 / 9 | 1 / 1 | 90.9% | 78 | 359 / 209 |
| sft-course | 65 | 33 / 0 / 0 / 0 | 1 / 7 | 95.5% | 3 | 393 / 74 |
| swiftui-rewine | 246 | 49 / 2 / 0 / 0 | 3 / 8 | 94.4% | 1 | 1,273 / 919 |
| the-big-shell | 9 | 9 / 0 / 0 / 0 | 1 / 1 | n/a | 0 | 36 / 0 |
| unknown | 59 | 0 / 59 / 0 / 0 | 2 / 2 | n/a | 0 | 0 / 0 |
| **Overall** | **10,513** | **4,752 / 394 / 1,804 / 457** | **2 / 8** | **74.8%** | **1,403** | **896,897 / 66,728** |

## Method

Run `PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/s5/footprints.py` from the
Concord checkout. The script reads under
`/Users/sebastianpatronsoto/agent-runs/` and writes only
`spikes/v3/s5/output.txt` in this checkout. It finds directories containing
`allowed-files.txt`, then requires a readable `status.json` and either
`work-spec.md` or `prompt.md`. It excludes the `clones/` subtree, deduplicates
archived copies by the `run_dir` recorded in status (falling back to `worktree`
or the directory path), and ignores nested worktrees. Blank lines and comment
lines in the allowed file are ignored; other lines are treated as exact,
repository-relative paths.

For a run with `candidate_sha`, `validated_sha`, or `commit_sha`, the script
compares `base_sha` (or `base`) to that SHA using `git diff-tree` in the
matching local clone under `agent-runs/clones/`, falling back to the run's
worktree when the clone cannot resolve the commits. A diffable run must have
both endpoints locally available. No run directory or clone is modified.
The declared-file distribution uses every analyzed run; change-share and
actual-overlap denominators use only diffable runs. Missing SHA and
non-diffable commits are reported separately in the output.

The run interval uses status start/create timestamps and finish/update
timestamps where present, with directory birth/creation time and modification
time as fallbacks. A pair overlaps when these intervals intersect. File overlap
requires an exact path match within the same repository. The five examples in
each category are the first matching pairs/runs in filesystem traversal order;
the output includes paths relative to the history root so they can be located.

## Limits

- The launcher enforces each declared list. Actual committed changes therefore
  cannot exceed the declared set; refused-scope states represent attempts the
  launcher reports as refused, before a candidate could be accepted.
- Orchestrators wrote these specs with knowledge of the code. Declared paths
  are informed estimates rather than independent predictions.
- This is file-level evidence. It does not compare symbols, semantic changes,
  the necessity of a declared file, or lease contention.
- The history scan starts from directories containing `allowed-files.txt`; it
  cannot identify runs that have no such marker. Invalid/missing status or
  prompt files, missing SHAs, and unavailable local objects are excluded where
  applicable and counted in the output.
- Directory metadata can be changed by copying or later filesystem activity;
  fallback time bounds are approximate. Only exact file path intersections
  are counted.
- Scope refusal counts use state names containing `refused-scope` or
  `refused_scope`; other spellings may not be recognized.
- The shares and overlaps describe this collected history. They do not show
  that declaring files or claiming an issue caused better coordination.

## Reproduction and validation

Analysis command:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/s5/footprints.py
```

Targeted validation commands:

```sh
head -80 spikes/v3/s5/output.txt
wc -w docs/spikes/v3/s5-declared-footprints.md
```

Their exact output is recorded in the run handoff; the complete analysis
output is `spikes/v3/s5/output.txt`.
