# Blind footprint repair ledger

Independent review sources: `review-opus-112.md` and `review-astra-112.md` in the supplied read-only inputs. “Fixed” describes this candidate's repair, not a new independent acceptance verdict. Each item is tracked separately; the owner report omits these IDs.

| Finding | Disposition and evidence |
|---|---|
| O1 | Fixed — `c3-blind-footprints.md`, Data audit: all four Tier A bodies named; three direct base-tree clues acknowledged; `build_dataset.py` relabels them pre-spec, code-aware. |
| O2 | Fixed — `build_dataset.py:hint_flags,redact` stores stem, non-generic folder and permission flags per bundle and removes commit identifiers; report gives full-file rates and a fresh searchable-identifier sample. Literal path checks are explicitly narrow. |
| O3 | Fixed — `build_dataset.py:outcome_text,redact,PATH` keeps multiline Goal text and prose between paired code spans, matches `.json` completely; JSONL regenerated. |
| O4 | Fixed — `growth_sim.py:initial_set,run_window` adds partial recall 0/50/80/100 percent initial declaration followed by growth, with first-touch called perfect foresight. |
| O5 | Fixed — `growth_sim.py:tasks_by_repo,run_window,main` retains all 15 out-of-Allowed candidate diffs even beyond the per-repository cap, keeps partial windows, and charges refusal then growth; report explains over-declaration. |
| O6 | Fixed — `growth_sim.py:main` outputs zero/one/two repair-unit sensitivity; report cites the earlier 40/1,304 textual-conflict observation and declines a policy ranking. |
| O7 | Fixed — report's owner choices gives four options, each with writer, benefit and cost, and recommends new blind requests in Concord's planned pilot. |
| O8 | Fixed — protocol includes name-search, prior-task and informed Allowed-list baselines, repetitions, hint strata, and explicit missingness. It no longer promises failed labels from the old freeze. |
| O9 | Fixed — protocol requires only a base-tree export, fresh sandbox, no home/network/refs, strips family identifiers, separates tiers and excludes off-base branch commits. |
| O10 | Fixed — report starts with three plain answers, then glossary, worked example and Chicago-time cutoff; raw reproduction detail moved to end. |
| O11 | Fixed — report states 8,518 no-issue runs, including Concord's absence from both historical issue-linked samples, and points to Concord's own issue store for future collection. |
| O12 | Fixed — `build_dataset.py:refused_paths,main` parses actual unmatched paths, unions changed paths outside Allowed, excludes nearest suggestions, and labels scope and dirty refusals separately. |
| O13 | Fixed — `growth_sim.py` makes the sibling import explicit under isolated Python mode; report explains the redirected rerun. |
| R1 | Fixed — `build_dataset.py:outcome_text` ignores fenced examples, finds the outer Goal/Outcome and preserves multiline continuation; bundles regenerated. |
| R2 | Fixed — `build_dataset.py:refused_paths` accepts only quoted unmatched paths before “is not in Allowed files”; nearest suggestions are excluded; malformed list source is marked. |
| R3 | Fixed — `growth_sim.py:run_window` defers release until all peers have attempted the tick; output regenerated. |
| R4 | Fixed — `build_dataset.py:worker_time,base_time,main` checks the base commit against worker start after refresh and excludes unverified snapshots; both timestamps recorded. `growth_sim.py:tasks_by_repo` uses the same check. |
| R5 | Fixed — `build_dataset.py:main` audits issue creation text independently of diff and Goal availability, and adds a family audit manifest to answers JSONL with label and exclusion status. Report qualifies what is and is not present. |
| R6 | Fixed — `growth_sim.py:initial_set,run_window` compares exact changed-set up-front with first-touch acquisition, holding footprint fixed; partial arms separately vary initial recall. |
| R7 | Fixed — protocol scores known positives separately, does not call unlabeled predictions false positives, bounds censored outcomes and reserves exact-set claims for uncensored or adjudicated tasks. |
| R8 | Fixed — protocol requires isolated task/tier sessions, no shared memory, and label embargo until predictions for both tiers are frozen. |
| R9 | Fixed — `build_dataset.py:redact,leaks` handles prose line references and templated paths; report distinguishes literal answer paths from indirect hints. |
| R10 | Fixed — `output.txt` includes selected runs, declarations and derived orders; answers JSONL has per-family audit records, creation times and exclusion reasons. Report states logs did not yield edit order. |
| R11 | Fixed — report glossary defines the technical and statistical terms on first use, with an example and plain summary. |
| R12 | Fixed — report says four Tier A families overlap Tier B, and gives the September 16 start of local assignments. |

Open evidence gaps: candidate diffs under enforced Allowed lists remain censored. A creation-time issue written by someone who knows the repository is not code-blind. The repaired simulator still uses retrospective answers to manufacture initial predictions, so it cannot establish a real prediction-accuracy threshold or real throughput. The recommended new-task pilot is needed to close these gaps; the frozen history cannot. These are research limits, not untracked review findings.
