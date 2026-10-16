# Review ledger: merged-tree conflict check

Each supplied Astra finding is listed with its disposition and the evidence that changed the candidate. “Fixed” means the defect in the check or report is addressed; it does not turn an incomplete test run into evidence of semantic correctness.

| Finding | Status | Disposition |
| --- | --- | --- |
| Astra R1 | Fixed | `spikes/v3/c6a/merged_tree.py`: union is limited to `LAB_READING_TRAIL.md` only when the recorded base bytes prefix both sides. Generated `trail/INDEX.md` is excluded from union; rewritten files fail the same content test. The report distinguishes union from index regeneration. |
| Astra R2 | Fixed | The script runs `scripts/build_trail_index.py --check` for generated-index conflict candidates, rebuilds when the generator is clean, and checks the rebuilt output. The transcript records twenty-four current checks, three generator conflicts that make the validator un-runnable, and four historical revisions without the validator. |
| Astra R3 | Fixed | Baseline result trees come from `git merge-tree --write-tree --merge-base=BASE LEFT RIGHT`. The two-head working-tree comparison uses the `ort` strategy from the left revision and verifies the recorded merge base. |
| Astra R4 | Fixed | Merge command status, index inspection, recorded base, and tree writing are checked. A merge with inconsistent exit and index state, or a failed inspection, is an operational failure and cannot count as a clean result. The run recorded zero operational failures. |
| Astra R5 | Fixed | `spikes/v3/c6a/output.txt` records all forty pair names, bases, two head revisions, merge-tree result identities, the input digest, per-pair outcomes, and unresolved paths. The script accepts source and mirror paths as arguments. |
| Astra R6 | Fixed | Missing stage-one content remains unresolved by the byte-prefix union. The report says a separately selected empty ancestor was not tested and does not claim Git cannot resolve an add/add conflict. |
| Astra R7 | Fixed | The report corrects the prior overgeneralization: retained runs show ten or eleven failures, forty-seven errors, five or six skips, and one run with seven expected failures. The new suite attempt timed out and is not given a test count. |
| Astra R8 | Fixed | The report defines replay and merge terms, names the earlier replay with a descriptive link, links every pull-request pair with available commit-subject descriptions, and explains the merge and validation results in plain language. |
| Astra R9 | Fixed | A two-minute suite timeout is recorded for the affected tree and its process group is terminated. The script continues subsequent freshness checks; each later clean tree records that the full suite was not repeated, and the totals report one suite attempt and nineteen clean trees without a suite attempt. |

## Validation limits

The test suite was run with `TMPDIR` set to the delegated scratch directory and the repository’s `tests/ci_support` fixture on `PYTHONPATH`. It timed out while still running and produced no complete summary. No test failure from that incomplete run is treated as merge evidence. The index validator did run: it confirmed rebuilt indexes as current, while identifying generator conflicts and revisions predating the validator.
