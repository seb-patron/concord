# Symbol claims on overlapping pull requests

## Answer in plain language

**STRUCTURAL (source date: 2026-10-16).** On the same 1,304 overlapping pull-request pairs as the earlier large replay, whole-file claims block 241 pairs. The repaired symbol finder identifies 21 of those pairs (8.7%) as disjoint by named unit, and all 21 merge cleanly in Git. In this sample, symbol claims therefore remove 21 false waits and let through **zero observed textual conflicts**. They still block 220 pairs, including all 40 pairs that the earlier replay found to conflict textually. This is a modest gain, not a general safety guarantee: 21 clean merges are too few to establish a low future conflict rate, and no merged-tree tests were run.

A **code unit** here is a function, method, class, top-level declaration, or Markdown heading section that two agents could claim separately. A **false wait** is a pair of changes that a whole-file claim would make wait even though their final edits are in different units and Git can merge their final heads without a textual conflict. A **let-through conflict** is a symbol-disjoint pair whose ordinary Git merge still reports a conflict. These are properties of the replayed final changes, not observations of real waiting agents. The owner asked to test symbols, not remove them from consideration (owner's symbol-test decision, D-TEST-SYMBOLS, 2026-10-16). The owner's current code-unit wording covers files **or** symbols (D-ISSUE-CLAIM-REDESIGN, 2026-10-16). This report changes neither policy nor product code.

## Why the first tree-sitter replay mostly measured fallback

**STRUCTURAL (source date: 2026-10-15 replay code and output; reproduced 2026-10-16).** The earlier larger replay measured 1,304 overlapping merged-pull-request pairs. Whole-file claims blocked 241 pairs; its tree-sitter scheme blocked 234. That seven-pair difference is too small to judge symbol units. Its raw output says 155,253 code-side fallback events: 148,346 labeled `parse/query error` and 6,907 labeled `missing file side`. These labels are not mutually exclusive, and the count is not a percentage of unique hunks. The supplied code starts a fresh Python process for each code-file parse request, imports `PackConfig` and `configure` from `tree_sitter_language_pack`, and catches any exception as a parse/query error. With the pinned package used here, both imported names are absent; the exact import probe fails before it can parse a byte. The earlier run did not record the package version or exception text, so this reproduces a likely cause of its large error count rather than proving its original environment was identical.

The old finder also required a `body` field and byte-normalized signature on *both* file sides. A newly added or deleted file lacked one side. A class, declaration, Markdown heading, or data key did not necessarily provide the `body` field it sought. A changed signature widened even when an owner could have claimed both its old and new identities. The old overlap comparison treated `('file', path)` as an ordinary exact-match unit; it could compare as disjoint from a symbol in that same path, even though a file claim must cover every child. Each of these mechanisms can distort a symbol result. The separate function-name study (`sp-e-symbols.md`, 2026-10-15) found substantial widening under a different extractor; its percentages are not a substitute for rerunning the actual pull-request sample.

| Historical fallback label | Code-side events |
|---|---:|
| Parse/query error | 148,346 |
| Missing file side | 6,907 |
| Grammar unavailable | 0 |

**STRUCTURAL (source date: 2026-10-16).** This run fixes the measurement before interpreting the symbol count. It uses tree-sitter 0.25.2 and tree-sitter-language-pack 0.13.0 in a virtual environment under the temporary directory. The raw output records the exact setup, metadata, Git, and replay command forms. The installed language pack also brought tree-sitter-c-sharp 0.23.5, tree-sitter-embedded-template 0.25.0, and tree-sitter-yaml 0.7.2 as dependencies. The script pins the two packages it uses directly. No package was installed globally.

## How the replay works

**STRUCTURAL (source dates: 2026-10-15 and 2026-10-16).** The replay follows the earlier selection rule. It reads merged pull-request metadata for Concord, agent-workflows, gen-v-research-tools, mwcc-rs, and gen-v-decomp. It forms pairs whose creation-to-merge intervals overlap, ranks each repository's pairs by SHA-256 of the repository and two pull-request numbers, and evaluates all Concord pairs plus the first 300 evaluable pairs in each other repository. The historical merged-pull-request and pair-universe counts are checked before proceeding, to guard against later metadata changing the sample. For a pair it uses the two final head commits and their Git merge base, as the earlier replay did. It does not reconstruct either head at the moment the pull requests first overlapped.

The five local clones are read-only. Missing pull-request heads are fetched only into temporary bare mirrors. `git merge-tree --write-tree` writes its result objects into those mirrors, which read clone objects through Git alternates. The script neither updates a clone ref nor writes a clone worktree. It asks Git for the paths each final head changed from the shared base. A pair is **file-blocked** when those path sets intersect. On each shared path, the script gets zero-context diff hunks and the before and after blobs, then maps each available side of each hunk to a named unit. It compares all the resulting claims for the pair. A file fallback overlaps any other claim on that path, and a class or heading claim overlaps claims nested inside it.

**STRUCTURAL (source date: 2026-10-16).** The finder has explicit tree-sitter queries for TypeScript and TSX, JavaScript, Python, Rust, C, C++, Go, Bash, CSS, HTML, SQL, Markdown, JSON, YAML, and TOML. The common engine turns query matches into line extents and identities that include the path, node kind, name, and named parent chain. TypeScript and JavaScript queries include methods, classes, interfaces or type declarations where the grammar has them, and top-level variables; Python includes functions, classes, and top-level assignments. Rust includes functions and item declarations. C and C++ include functions, types, and top-level declarations. Markdown ATX and Setext headings become sections ending at the next heading of equal or higher level; nested heading claims overlap their parent. JSON, YAML, and TOML claim top-level keys when the tree gives an unambiguous line range. Multiple keys on one line cannot be split by the line-based hunk coordinates and fall back to file scope. Extensionless files with a Bash or Python shebang use the corresponding query.

The new finder maps every side of a hunk that actually contains changed lines. A newly added file can use its after side and a deleted file its before side; a zero-count side is only an insertion or deletion anchor, not an edited unit. When a name changes, the finder records both old and new unit identities. It falls back to the file for a parse error, a hunk without a named enclosing unit, an unsplittable hunk spanning units, an unsupported or binary file, a rename or move, or a non-text diff with no hunk. The raw output names and counts these reasons. Rename and move detection is only used to force a file claim; tracking a moved symbol is outside this run. An insertion that changes more than one unit still falls back. These rules avoid granting two claims to an uncertain boundary.

The headline comparison is pair-level. A pair is **symbol-disjoint** only if every shared changed path is disjoint under these rules. The script runs an ordinary `git merge-tree` for every file-blocked pair, including symbol-disjoint ones, and counts a let-through conflict from its exit status. The later clean-pairs file contains only repository and pull-request numbers for symbol-disjoint pairs with a clean textual merge. It contains no paths or contents. Language rows ask the same question within that language's shared paths; a pair with multiple languages may appear in several rows, so language rows must not be summed to get the overall count. The per-language conflict entry is attributed only when Git names a conflicting shared path in that language.

## Results

**STRUCTURAL (source date: 2026-10-16).** The repository totals below sum to 1,304 evaluated pairs. “File-blocked” means both final changes touched at least one common path. “Disjoint” means every common path had nonoverlapping named units under the repaired finder. The clean-pairs list has exactly the 21 disjoint pairs with a clean textual merge.

| Repository | Evaluated pairs | File-blocked | Symbol-disjoint | Textual conflicts let through | Pairs with file fallback | New hunk fallback rate |
|---|---:|---:|---:|---:|---:|---:|
| Concord | 104 | 18 | 4 | 0 | 10 | 66/170 (38.8%) |
| agent-workflows | 300 | 118 | 12 | 0 | 81 | 1,291/2,462 (52.4%) |
| gen-v-research-tools | 300 | 61 | 0 | 0 | 25 | 104/582 (17.9%) |
| mwcc-rs | 300 | 19 | 2 | 0 | 15 | 53/328 (16.2%) |
| gen-v-decomp | 300 | 25 | 3 | 0 | 18 | 152/389 (39.1%) |
| **Total** | **1,304** | **241** | **21** | **0** | **149** | **1,666/3,931 (42.4%)** |

The old query, as reproduced with the pinned package, falls back on all matched hunks: **100%** in every repository and language row. The repaired finder reduces that matched-cohort rate to 42.4%. That is a conditional comparison, not a claim that the historical replay itself measured a 100% unique-hunk rate. Its 155,253 fallback events used a different population and could count both file sides of a hunk. On the matched code-side cohort, the old import path failed on 4,618 of 4,618 parse attempts in this environment. The package mismatch diagnosis is strong evidence of why its symbol result barely differed from file claims, but its original package version is unknown.

| Language on a shared path | File-blocked pairs | Disjoint in that language | Let-through textual conflicts | Pairs with fallback | New hunk fallback rate |
|---|---:|---:|---:|---:|---:|
| Bash | 76 | 4 | 0 | 70 | 1,237/1,443 (85.7%) |
| C | 1 | 0 | 0 | 1 | 34/34 (100%) |
| JSON | 9 | 4 | 0 | 4 | 8/25 (32.0%) |
| Markdown | 165 | 38 | 0 | 33 | 86/1,550 (5.5%) |
| Python | 37 | 0 | 0 | 35 | 146/397 (36.8%) |
| Rust | 16 | 2 | 0 | 12 | 47/307 (15.3%) |
| TypeScript | 12 | 1 | 0 | 10 | 66/128 (51.6%) |
| Unsupported file types | 6 | 0 | 0 | 6 | 42/42 (100%) |
| YAML | 4 | 0 | 0 | 0 | 0/5 (0%) |

These are path-language views of pairs, not additive parts of the overall total. A pair can be disjoint in Markdown and still blocked by a different file. C++, JavaScript, Go, CSS, HTML, SQL, and TOML have explicit queries but no shared paths in this file-blocked cohort; these rows provide no evidence of their accuracy. JSON and YAML top-level keys are exercised, while TOML key coverage remains unexercised here.

| Repaired file fallback reason | Events | Affected pairs |
|---|---:|---:|
| No named enclosing unit | 388 | 85 |
| Parse error | 1,102 | 49 |
| Hunk spans units | 134 | 62 |
| Unsupported language | 42 | 5 |
| No text hunks | 4 | 1 |

**STRUCTURAL (source date: 2026-10-16).** Reason events can exceed unique fallback hunks because a non-text diff has no hunk; affected-pair counts overlap when a pair has more than one cause. Bash accounts for all 1,102 parse-error events. Of those, 477 hunks belong to an extensionless Bash script recognized by its shebang; its source still has parse errors under this grammar. Bash parser tolerance or syntax coverage is therefore the largest apparent opportunity to narrow claims safely. Unsupported file types account for 42 events, mainly data and configuration files. Markdown is mapped to headings well, with only 86 of 1,550 hunks falling back, but 38 Markdown-disjoint language results collapse to fewer globally disjoint pairs when other shared paths are considered. Python has no globally useful disjoint row in this sample even though many hunks map to units. These differences argue for measuring each adapter on the actual repository mix rather than assuming a parser query alone yields a concurrency gain.

The **hunk fallback rate** uses unique base/head/path diffs from shared paths in file-blocked pairs, counting a diff once if several pairs reuse it. This is the comparison cohort that can affect the pair result. The reproduced old query would send every code hunk in this matched cohort to the file after its import failure; the earlier replay also assigned non-code hunks file scope by design. Thus the reported old matched-cohort rate is conditional on the reproduced API failure. The new rate is directly counted from the repaired finder on those same hunks. The historical 155,253 event table above covers all code-file attempts in the old replay and has a different denominator. A non-text change has no hunk denominator but still contributes a file fallback event and can block a pair.

## What the measurement can and cannot decide

**STRUCTURAL (source date: 2026-10-16).** A clean textual merge is a necessary next step for two independent changes to land together, but it is not proof that the merged program builds, passes tests, or behaves correctly. This run intentionally does not run tests on merged trees; the clean-pairs list is the input for that later study after the test-runner fix. Two edits to different methods can still break a caller, shared invariant, generated output, schema, or user-visible behavior. Conversely, a textual conflict can sometimes be repaired or resolved by a structured merge. No semantic conflicts, human repair time, or actual agent waiting time are measured here.

**STRUCTURAL (source dates: 2026-10-15 and 2026-10-16).** Overlapping pull-request intervals are only a proxy for concurrent work. The sample includes merged requests only, caps four repositories at 300 pairs, and compares final heads that may include edits made after their overlap began. Repositories are strata, not a representative weighted sample of all software. Git metadata, branch tips, and available objects can change; the script checks historical population counts but does not possess the earlier run's full private pair-record file. These limits matter especially for a small number of let-through conflicts. Pair counts cannot be turned into minutes saved without observing claim acquisition, work, review, queue, and repair times.

**STRUCTURAL (source date: 2026-10-16).** Query coverage is an explicit engineering choice. A source file with parser errors widens, even if an unaffected region might have been identifiable. A line hunk cannot reliably divide two declarations on the same physical line. Identity uses textual names and ancestors, not a compiler's resolved symbol identifier: overloads and same-named constructs can collide, while a changed name can produce more than one claim. File and parent-child overlap is conservative, but independent human labels are still needed before treating narrow claims as an authorization boundary. The results therefore measure this pinned prototype, not a language-independent truth about symbols. The older source-index notes (`s3-symbol-indexes-notes.md`, read 2026-10-15) likewise distinguish navigation ranges from durable semantic identities.

**CAPABILITY-DEPENDENT (source date: 2026-10-16; re-test with current agents).** The replay says nothing about whether present-day agents would notice claims, coordinate a handoff, or repair a conflict quickly. Earlier reports of agent-managed task locks concerned a different resource and older agents (`sp-f1-locks.md`, 2026-10-15). These behaviors need a separate, approved current-agent test. They should not be inferred from Git's merge status.

For v3, the owner has decided that code units may be files or symbols and that exclusive claims remain an active policy (D-ISSUE-CLAIM-REDESIGN, 2026-10-16; D-UNIT-1-EXCLUSIVE, 2026-10-14). The owner also approved this round-two research plan (D-RESEARCH-PLAN-2-GO, 2026-10-16). **STRUCTURAL (source date: 2026-10-16):** the defensible next design question is how a single claim engine and its language queries are versioned and verified at declare, grow, publish, and land, with a safe parent/file fallback. The observed false-wait gain and let-through cost belong side by side, as the owner requested (D-GAIN-SEE-RESULTS, 2026-10-16). The later merged-tree test can supply build and check evidence, and independent scope labels can assess whether the named units match intended ownership. This report does not select a new default or supersede a recorded decision.
