# Symbol claims on overlapping pull requests

## Answer in plain language

**STRUCTURAL (source date: 2026-10-16).** On 1,304 pairs of pull requests whose work periods overlapped, whole-file claims block 241 pairs. The repaired symbol finder allows 21 of those pairs (8.7% of file-blocked pairs) to proceed, and all 21 merge cleanly in Git. It blocks 220 pairs, including all 40 pairs with textual merge conflicts. The measured answer is **21 false waits removed and zero observed textual conflicts let through**. This is a measurement of final changes, not a promise of future safety: no tests were run on the combined code after a clean merge. A **structural** finding follows from the recorded rules and Git outcomes; a **capability-dependent** finding concerns how agents behaved and must be retested with current agents.

A **code unit** here is a function, method, class, top-level declaration, or Markdown section that two agents could claim separately. A **claim** is the exclusive unit an agent reserves; a **file fallback** means the finder cannot safely select one named unit and reserves the whole file. A **false wait** is a pair that a whole-file claim would block even though their final edits are in different units and Git merges them without a textual conflict. A **let-through conflict** is a pair allowed by symbol claims whose Git merge reports a textual conflict. Neither count observes real waiting agents. The owner asked to test symbols (symbol-test decision, D-TEST-SYMBOLS, 2026-10-16), and defines code units as files **or** symbols (issue-claim redesign, D-ISSUE-CLAIM-REDESIGN, 2026-10-16).

## What the earlier syntax-tree replay established

**STRUCTURAL (source dates: 2026-10-15 replay and 2026-10-16 repair).** The earlier lock-scheme replay (`sp-f5-replay.md`; supplied input) measured 1,304 pairs. Whole-file claims blocked 241 pairs; its syntax-tree scheme blocked 234. The supplied earlier raw results (`spikes_v3_sp-f5_output.txt`), with [their fallback counts reproduced in the current output](../../../../spikes/v3/round2/c4/output.txt), recorded 155,253 code-side fallback events: 148,346 called parse or query errors and 6,907 called missing file sides. These labels overlap and are not percentages of distinct changed regions. The old code caught exceptions without saving their text.

The newer language pack (0.13.0) lacks the `PackConfig` and `configure` names imported by the old extractor, so that exact old import fails before parsing. This is a **demonstrated incompatibility with the newer package**, not the historical explanation. A surviving historical environment used language pack 1.22.1. In a fresh temporary environment with language pack 1.22.1 and its resolved tree-sitter 0.26.0, the old Python extractor ran on a simple assignment and returned `[[null], [null]]` without an exception. Giving Python source to its C parser raised `ValueError: syntax tree contains errors`, as expected for that deliberately mismatched input. Neither probe reproduces the historical file population. The historical cause of 148,346 recorded errors remains **unresolved**. The 1,431 missing-side events for C and only 372 C parse errors also rule out a universal import failure in that run.

The old finder also required both the content before and after a change to contain the same declaration text before the unit's body. Added or deleted files lack one side; classes, headings, and data keys may have no body field at all. A changed declaration could be widened to a file even when both the old and new names could be claimed. The old comparison could also treat a whole-file claim as separate from a symbol in that file, although the whole-file claim covers it. The earlier function-name study (`sp-e-symbols.md`; supplied input) used different rules and cannot stand in for this replay.

| Historical fallback label | Code-side events |
|---|---:|
| Parse/query error | 148,346 |
| Missing file side | 6,907 |
| Grammar unavailable | 0 |

**STRUCTURAL (source date: 2026-10-16).** The new finder uses tree-sitter 0.25.2 and language pack 0.13.0 in a temporary Python environment. Its [script](../../../../spikes/v3/round2/c4/symbols.py), [raw output](../../../../spikes/v3/round2/c4/output.txt), and [clean-pair list](../../../../spikes/v3/round2/c4/clean-pairs.tsv) give reproducible evidence. The old extractor was not executed on every matched file with its original classification rules. Old matched-cohort fallback percentages and its purported 4,618 attempts are therefore withdrawn, rather than presented as observed failures.

## How the replay works

**STRUCTURAL (source dates: 2026-10-15 and 2026-10-16).** The replay uses the earlier selection rule. It reads merged pull-request metadata for five repositories, forms pairs whose creation-to-merge periods overlap, ranks pairs deterministically by SHA-256 of their repository and pull-request numbers, and evaluates all Concord pairs plus the first 300 usable pairs in each other repository. It checks the historical pool sizes first. Each **head** is the final commit of a pull request; the **merge base** is the shared ancestor of the two heads. The replay compares both heads with that ancestor. It does not reconstruct their state when their work periods first overlapped.

The five local clones are read-only. Missing commits are fetched into temporary **bare mirrors**, Git repositories without working directories. The mirrors use **Git alternates** to read unchanged objects from the local clones. Git stores a file version as a **blob**; the script reads the before and after blobs without writing the clones. A pair is **file-blocked** when both heads changed at least one path in common. A **hunk** is a changed line range reported by Git. The finder maps each changed side of every shared-path hunk to a named unit, then compares the claims. A file claim covers every unit in that file; a parent class or section claim covers its children.

**STRUCTURAL (source date: 2026-10-16).** The finder uses tree-sitter, a syntax parser, for TypeScript and TSX, JavaScript, Python, Rust, C, C++, Go, Bash, CSS, HTML, SQL, Markdown, JSON, YAML, and TOML. A **grammar** describes a language's syntax; a **query** selects named structures from its parsed tree. The common engine records a unit's start and end lines, syntax type, name, and captured parent units. Python now captures top-level assignments by their left-hand names. TypeScript abstract classes, Rust traits, nested functions, and nested HTML elements retain their parents. Markdown headings written with either `#` or an underline create sections ending at the next heading of equal or higher level. JSON, YAML, and TOML use top-level keys when line positions identify one key. Sibling units on the same line fall back to the file because a line-only hunk cannot identify the edited sibling. A **shebang** is a first line naming an interpreter; it lets extensionless Bash or Python files use the matching grammar.

The finder maps each hunk side that actually has changed lines. An added file uses its new side; a deleted file uses its old side. When a name changes, both names are claimed. It widens to the whole file when parsing fails, no enclosing unit is found, a hunk crosses units, siblings share a line, the file type is unsupported or binary, a file is renamed or moved, or a non-text change has no hunk. Insertion points between different units also widen. The [raw output](../../../../spikes/v3/round2/c4/output.txt) counts these reasons.

The headline comparison is pair-level. A pair is **symbol-disjoint** only if every shared changed path is disjoint under these rules. The script runs an ordinary `git merge-tree` for every file-blocked pair, including symbol-disjoint ones, and counts a let-through conflict from its exit status. The later clean-pairs file contains only repository and pull-request numbers for symbol-disjoint pairs with a clean textual merge. It contains no paths or contents. Language rows ask the same question within that language's shared paths; a pair with multiple languages may appear in several rows, so language rows must not be summed to get the overall count. The per-language conflict entry is attributed only when Git names a conflicting shared path in that language.

## Results

**STRUCTURAL (source date: 2026-10-16).** The repository totals below sum to 1,304 evaluated pairs. “File-blocked” means both final changes touched at least one common path. “Disjoint” means every common path had nonoverlapping named units under the repaired finder. The clean-pairs list has exactly the 21 disjoint pairs with a clean textual merge.

| Repository | Evaluated pairs | File-blocked | Symbol-disjoint | Textual conflicts let through | Pairs with file fallback | New hunk fallback rate |
|---|---:|---:|---:|---:|---:|---:|
| Concord | 104 | 18 | 4 | 0 | 10 | 66/170 (38.8%) |
| agent-workflows | 300 | 118 | 12 | 0 | 81 | 1,291/2,462 (52.4%) |
| gen-v-research-tools | 300 | 61 | 0 | 0 | 25 | 99/582 (17.0%) |
| mwcc-rs | 300 | 19 | 2 | 0 | 15 | 53/328 (16.2%) |
| gen-v-decomp | 300 | 25 | 3 | 0 | 18 | 142/389 (36.5%) |
| **Total** | **1,304** | **241** | **21** | **0** | **149** | **1,651/3,931 (42.0%)** |

The repaired finder falls back on 1,651 of 3,931 distinct changed regions on shared paths, or 42.0%. This is the **matched cohort** that can affect whether a pair is blocked: a base/head/path diff is counted once even when reused by several pairs. The old extractor was not run across this cohort with its original rules; its fallback percentage here is **unknown**. The historical 155,253 fallback events covered a different population and could count both sides of a changed region, so dividing those events by this cohort would be invalid. The earlier 4,618-attempt figure was calculated from hunk counts, included extensionless Bash files the old code classified as non-code, and is withdrawn.

| Language on a shared path | File-blocked pairs | Disjoint in that language | Let-through textual conflicts | Pairs with fallback | New hunk fallback rate |
|---|---:|---:|---:|---:|---:|
| Bash | 76 | 4 | 0 | 70 | 1,237/1,443 (85.7%) |
| C | 1 | 0 | 0 | 1 | 34/34 (100%) |
| JSON | 9 | 4 | 0 | 4 | 8/25 (32.0%) |
| Markdown | 165 | 38 | 0 | 33 | 86/1,550 (5.5%) |
| Python | 37 | 0 | 0 | 34 | 131/397 (33.0%) |
| Rust | 16 | 2 | 0 | 12 | 47/307 (15.3%) |
| TypeScript | 12 | 1 | 0 | 10 | 66/128 (51.6%) |
| Unsupported file types | 6 | 0 | 0 | 6 | 42/42 (100%) |
| YAML | 4 | 0 | 0 | 0 | 0/5 (0%) |

These are path-language views of pairs, not additive parts of the overall total. A pair can be disjoint in Markdown and still blocked by a different file. C++, JavaScript, Go, CSS, HTML, SQL, and TOML have explicit queries but no shared paths in this file-blocked cohort; these rows provide no evidence of their accuracy. JSON and YAML top-level keys are exercised, while TOML key coverage remains unexercised here.

| Repaired file fallback reason | Events | Affected pairs |
|---|---:|---:|
| No named enclosing unit | 372 | 85 |
| Parse error | 1,102 | 49 |
| Hunk spans units | 135 | 62 |
| Unsupported language | 42 | 5 |
| No text hunks | 4 | 1 |

**STRUCTURAL (source date: 2026-10-16).** Reason events can exceed unique fallback hunks because a non-text diff has no hunk; affected-pair counts overlap when a pair has more than one cause. Bash accounts for all 1,102 parse-error events. Of those, 477 hunks belong to an extensionless Bash script recognized by its shebang; its source still has parse errors under this grammar. Bash parser tolerance or syntax coverage is therefore the largest apparent opportunity to narrow claims safely. Unsupported file types account for 42 events, mainly data and configuration files. Markdown is mapped to headings well, with only 86 of 1,550 hunks falling back, but 38 Markdown-disjoint language results collapse to fewer globally disjoint pairs when other shared paths are considered. Python has no globally useful disjoint row in this sample even though many hunks map to units. These differences argue for measuring each adapter on the actual repository mix rather than assuming a parser query alone yields a concurrency gain.

The **hunk fallback rate** divides changed regions that widened to a whole-file claim by all distinct changed regions on shared paths. The new rate is counted directly by the fixed finder. A non-text change has no line region in this denominator but still contributes a file fallback event and can block a pair. The old matched-cohort rate is not reported because it was not executed with the old classifier and parser version.

## Reproduction details

**STRUCTURAL (source date: 2026-10-16).** These exact package probes ran in temporary virtual environments. The first used language pack 1.22.1; the second used 0.13.0. Their raw standard output follows each command. The full old query also returned `[[null], [null]]` with exit code zero for the assignment on both sides; parsing the same Python text as C raised `ValueError: syntax tree contains errors`. Neither is a replay of the historical file population.

```sh
TMPDIR="$DELEGATE_SCRATCH_DIR/tmp" PYTHONDONTWRITEBYTECODE=1 "$DELEGATE_SCRATCH_DIR/c4-historical-venv/bin/python" -c 'from tree_sitter_language_pack import PackConfig,configure,get_parser; import os; configure(PackConfig(cache_dir=os.environ["DELEGATE_SCRATCH_DIR"]+"/old-cache")); print("python_has_error",get_parser("python").parse(b"x = 1\n").root_node.has_error)'
# python_has_error False
TMPDIR="$DELEGATE_SCRATCH_DIR/tmp" PYTHONDONTWRITEBYTECODE=1 "$DELEGATE_SCRATCH_DIR/c4-symbol-venv/bin/python" -c 'import tree_sitter_language_pack as p; print("PackConfig", hasattr(p,"PackConfig"), "configure", hasattr(p,"configure"))'
# PackConfig False configure False
```

The full replay command was `TMPDIR="$DELEGATE_SCRATCH_DIR/tmp" PYTHONDONTWRITEBYTECODE=1 "$DELEGATE_SCRATCH_DIR/c4-symbol-venv/bin/python" spikes/v3/round2/c4/symbols.py`. Its final raw line was `wrote spikes/v3/round2/c4/output.txt and spikes/v3/round2/c4/clean-pairs.tsv; 1304 pairs`; the [raw output file](../../../../spikes/v3/round2/c4/output.txt) holds every result table. Focused finder probes and their exact returned identities are in the [repair ledger](reviews/c4-repair-ledger.md).

## What the measurement can and cannot decide

**STRUCTURAL (source date: 2026-10-16).** A clean textual merge is a necessary next step for two independent changes to land together, but it is not proof that the merged program builds, passes tests, or behaves correctly. This run intentionally does not run tests on merged trees; the clean-pairs list is the input for that later study after the test-runner fix. Two edits to different methods can still break a caller, shared invariant, generated output, schema, or user-visible behavior. Conversely, a textual conflict can sometimes be repaired or resolved by a structured merge. No semantic conflicts, human repair time, or actual agent waiting time are measured here.

**STRUCTURAL (source dates: 2026-10-15 and 2026-10-16).** Overlapping pull-request periods are only a proxy for concurrent work. The sample includes merged requests only, caps four repositories at 300 pairs, and compares final commits that may include edits made after the overlap began. Each repository is a separate sample group, not a representative weighted sample of all software. Git metadata and available commits can change; the script checks historical pool sizes but does not have the earlier run's complete private pair records. Pair counts cannot be converted into minutes saved without observing actual claim acquisition, work, review, queue, and repair times.

**STRUCTURAL (source date: 2026-10-16).** The finder is a pinned prototype. Any parser error widens a claim, even when an unaffected region might be identifiable. A line hunk cannot divide two declarations on the same physical line. Identities use textual names and parent chains, not compiler-resolved identities: functions with the same name but different parameter lists can collide, while a changed name can produce two claims. File and parent-child overlap is conservative, but human review is still needed before these inferred units could control access. The older supplied source-index notes (`s3-symbol-indexes-notes.md`, dated 2026-10-15) likewise distinguish a navigation range from a stable code identity.

**CAPABILITY-DEPENDENT (source date: 2026-10-16; re-test with current agents).** The replay says nothing about whether present-day agents would notice claims, coordinate a handoff, or repair a conflict quickly. Earlier reports of agent-managed task locks concerned a different resource and older agents (`sp-f1-locks.md`, 2026-10-15). These behaviors need a separate, approved current-agent test. They should not be inferred from Git's merge status.

For the next Concord version, the owner decided that code units may be files or symbols and claims remain exclusive (issue-claim redesign, D-ISSUE-CLAIM-REDESIGN, 2026-10-16; exclusive-unit decision, D-UNIT-1-EXCLUSIVE, 2026-10-14). The approved research plan includes this symbol test (round-two plan approval, D-RESEARCH-PLAN-2-GO, 2026-10-16). **STRUCTURAL (source date: 2026-10-16):** the next design question is how one claim engine and its language rules are versioned and checked when a unit is first reserved, a claim expands, a change is submitted, and it merges, with safe parent and file fallbacks. The owner asked to see gain next to penalties (gain-and-penalty decision, D-GAIN-SEE-RESULTS, 2026-10-16). A later test of the combined trees can supply build and check evidence; human labels can assess whether inferred units match intended ownership. This report selects no new default.
