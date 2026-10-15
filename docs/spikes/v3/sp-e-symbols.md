# SP-E: Git funcname keys and tree-sitter symbols

## Finding

This is a bounded comparison of function-name keys, not a ground-truth accuracy study. A Git heading that differs from the tree-sitter enclosing function name is counted as a wrong symbol **relative to the tree-sitter result**; syntax trees can also misidentify a function. The observed name-only agreement and fallback rates below support a conservative v3 rule: use a syntax-tree function identity only when both sides of a changed hunk resolve to the same enclosing symbol, and otherwise widen the claim to the whole file. That recommendation follows the one language-agnostic tree-sitter unit engine recorded in D-LEASE-LANGUAGE-AGNOSTIC; the data do not establish that a parsed name is semantic ground truth.

## Method and reproduction

The script considered the newest 300 non-merge commits per readable repository, using each commit's first-parent diff. Concord has 263 such commits in this checkout; `mwcc-rs` and `gen-v-decomp` have 300 each; `gen-v-research-tools` has 282. A hunk is counted for Rust, C++, Python, TypeScript, and TSX files. New and deleted files are read from their respective parent or commit trees; histories and worktrees were not changed.

The Git side uses `git diff --unified=0` and Git's built-in `rust`, `cpp`, and `python` diff drivers. A temporary attributes file in the delegated scratch directory activates those drivers and a `typescript` driver. The TypeScript `xfuncname` expression is the exact Concord v2 rule documented in [api-leases.md](../../api-leases.md):

```text
^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+[[:alnum:]_]+
```

The Git label is the function name extracted from the selected hunk heading. The actual Concord v2 key encodes the complete selected funcname line as `symbol:<path>#<encoded-line>`; see [units.ts](../../../src/leases/units.ts) and [symbol-keys.ts](../../../src/leases/symbol-keys.ts). This spike compares the function-name component, not exact encoded key strings. Tree-sitter parses each before/after file with the Rust, C++, Python, or TypeScript grammar; the selected label is the nearest enclosing function node's name. C++ declarations follow the grammar's declarator chain to avoid mistaking a parameter name for the function name. A hunk is stable when both changed ranges' endpoints resolve to the same name before and after. This deliberately uses a simple leaf name: same-named nested methods can collide.

Metrics use all hunks as the denominator unless marked `both`. `agreement/all` is same-name stable Git/tree-sitter agreement divided by all hunks; `agreement/both` uses hunks where both methods returned names. `wrong symbol` counts different Git and tree-sitter names when both exist. `no symbol` counts a missing Git key or a missing before/after syntax-tree symbol. `widened git` counts a missing Git key or an unstable before/after syntax-tree range; `widened tree-sitter` counts an unstable range. These are conservative whole-file fallback proxies, not measured production reservations. The Git timing amortizes one whole-commit diff across its changed target-language hunks plus per-hunk heading extraction. Tree-sitter timing amortizes before/after blob reads and parsing for each changed file across its hunks plus per-hunk lookup. Widening does not replay `symbolForEdit` against every exact line-key transition, so signature-line widening is not isolated as a separate outcome.

Reproduce with Python 3.14.7 and these packages (the first attempted tree-sitter 0.26.0 process segfaulted on this Python build; 0.25.2 completed cleanly):

```sh
python3 -m venv "$TMPDIR/sp-e-venv"
"$TMPDIR/sp-e-venv/bin/python" -m pip install tree-sitter==0.25.2 tree-sitter-rust==0.24.2 tree-sitter-cpp==0.23.4 tree-sitter-python==0.25.0 tree-sitter-typescript==0.23.2
PYTHONDONTWRITEBYTECODE=1 "$TMPDIR/sp-e-venv/bin/python" spikes/v3/sp-e/measure.py > spikes/v3/sp-e/output.txt
```

The complete raw per-repository, per-language output and the five example records are in [output.txt](../../../spikes/v3/sp-e/output.txt). It includes actual commit counts, package versions, commands' method settings, and measured milliseconds per hunk.

## Results

The per-repository table in `output.txt` is the raw result. Its non-empty language rows are summarized here; rates are weighted by observed hunks. Agreement percentages are all-hunk / both-names. `Git / TS file` is each method's widened-to-file proxy. `Wrong / no symbol` are all-hunk rates.

| Language | Repositories with hunks | Hunks | Agreement (all / both) | Git / TS file | Wrong / no symbol | Git / tree-sitter ms per hunk |
|---|---:|---:|---:|---:|---:|---:|
| Rust | 1 | 6,033 | 54.96% / 83.40% | 42.63% / 41.36% | 9.78% / 34.10% | 0.8898 / 5.5787 |
| C++ | 2 | 66 | 46.97% / 88.57% | 48.48% / 48.48% | 6.06% / 46.97% | 0.6996 / 8.9718 |
| Python | 3 | 6,283 | 54.59% / 80.92% | 39.25% / 39.07% | 12.13% / 32.53% | 1.2262 / 7.6223 |
| TypeScript | 1 | 3,669 | 6.76% / 30.36% | 79.23% / 59.96% | 15.37% / 77.73% | 1.1385 / 9.3073 |

### Five observed disagreements

Each row is from an actual changed hunk; names are the Git heading and the tree-sitter enclosing function name, respectively. Full commit prefixes and paths are in the raw output.

1. Rust, `mwcc-rs` `c27af3a8f01a`, `crates/mwcc-driver/tests/init_r1_checks.rs`: Git `expected_rejection_profile`; tree-sitter `expected_rejection_diagnostics`.
2. C++, `gen-v-research-tools` `eef3e9ddafe1`, `adapter/main.cpp`: Git `readProbe`; tree-sitter `emitRamDigestPage`.
3. Python, `mwcc-rs` `b6df12d8d63a`, `tests/test_corpus_pipeline.py`: Git `fake_scorer`; tree-sitter `test_score_only_writes_full_tu_budget_list`.
4. TypeScript, `concord` `07832bb5577f`, `src/features/repos.ts`: Git `changeInput`; tree-sitter `changeCreate`.
5. TypeScript, `concord` `b02d3ae99eb3`, `cli/git-token.ts`: Git `currentVersion`; tree-sitter `mintGitToken`.

## Recommendation by language

- **Rust:** use tree-sitter function claims with file fallback. Across 6,033 hunks, 83.40% of cases where both methods found a name agree; about 41% widen under either proxy. This gives sub-file coverage while retaining a substantial fallback.
- **C++:** use tree-sitter with file fallback, behind conservative rollout. Only 66 hunks were observed; 88.57% agree when both names exist, while 46.97% have no symbol. Treat this recommendation as low-confidence until more C++ history is sampled.
- **Python:** use tree-sitter function claims with file fallback. It has 6,283 hunks, 80.92% agreement when both resolve, and nearly equal widening proxies (39.25% Git, 39.07% tree-sitter). This follows the language-agnostic engine without adding a per-language Git adapter.
- **TypeScript:** use tree-sitter function claims with file fallback. At least one method has no symbol on 77.73% of hunks, and Git agrees with tree-sitter on 30.36% where both names exist. The custom Git rule targets `function` declarations, so it misses many methods and arrow functions.

These recommendations are inferences from this sample and D-LEASE-LANGUAGE-AGNOSTIC, not a result validated against human-labeled semantic ownership. C++ has only a small observed sample. **UNVERIFIED:** whether name-only symbol identities reflect the scope an agent or owner intends to protect, particularly for overloaded and same-named nested functions.

## Prior art read

- Concord history, [seb-patron/concord](https://github.com/seb-patron/concord) — read the relevant sections across 263 non-merge commits and the local v2 key rule in `api-leases.md`, `units.ts`, and `symbol-keys.ts`.
- Rust history, [seb-patron/mwcc-rs](https://github.com/seb-patron/mwcc-rs) — read the relevant sections in the newest 300 non-merge commits.
- Python/C++ history, [seb-patron/gen-v-decomp](https://github.com/seb-patron/gen-v-decomp) — read the relevant sections in the newest 300 non-merge commits.
- Python/C++ history, [seb-patron/gen-v-research-tools](https://github.com/seb-patron/gen-v-research-tools) — read the relevant sections in the newest 282 non-merge commits.
- Mergiraf, [Usage](https://mergiraf.org/usage.html) — read the relevant sections. It uses syntax-aware conflict resolution alongside Git's line-based merge behavior, supports per-language merge-driver selection, and can retain conflict markers when uncertain. It is prior art for syntax-aware conflict handling, not for lease-key accuracy.
- Difftastic, [Introduction](https://difftastic.wilfred.me.uk/introduction.html) — read the relevant section. It detects language, parses syntax trees, and structurally compares them, with line-oriented fallback for unsupported or extremely large inputs. It is prior art for syntax-aware diffs, not for claim identity.

## Evidence limits

This sample measures output-name agreement, missing names, conservative file fallback, and local processing time. It does not establish semantic correctness or collision safety for same-name functions. `UNVERIFIED`: behavior on every grammar construct, end-to-end service latency, and whether the returned name is the ownership boundary an agent or owner intends. No independent human annotation of changed hunks was collected, so “wrong symbol” means disagreement with the tree-sitter name, not a confirmed ownership error.
