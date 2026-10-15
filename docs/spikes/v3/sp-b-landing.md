# SP-B: server-side changes and landing on plain Git

**Result:** The Git plumbing prototype works on disposable bare copies of Concord and `gen-v-decomp`. It creates changes without a working tree, merges against the latest `main`, detects textual conflicts, lands with compare-and-swap (CAS), and performs server-side batch diagnosis and revert. This is a local prototype measurement, not a production capacity estimate.

The research framing follows D-SPIKE-MEANS-RESEARCH (evaluate options against Concord's agent-scale, GitHub-replacement goal) and D-LANDING-SPIKE (investigate parallel landing). The requested policy below is a recommendation for owner review, not an owner decision.

## Measurement

The recorded runs used Git 2.54.0 (Apple Git-157), Darwin arm64, and Python 3.14.7. Each run cloned a real local repository into a temporary bare repository. It used that copy's existing `main` as the base, then added disposable fixture files and commits there. No source repository ref or working tree was modified.

| Measurement | Concord | gen-v-decomp |
| --- | ---: | ---: |
| 20 change objects created from one base | 1,788.863 ms | 1,905.895 ms |
| Concurrent landing result | 11 landed, 9 textual conflicts | 11 landed, 9 textual conflicts |
| CAS retries | 118 | 73 |
| Landing latency p50 / p95 | 1,528.655 / 1,761.458 ms | 626.651 / 1,370.634 ms |
| Server-side batch bisection | bad item 4 found in 3 probes | bad item 4 found in 3 probes |
| Full clone via `git http-backend` | 295.038 ms | 2,343.065 ms |
| Incremental fetch via `git http-backend` | 237.125 ms | 306.597 ms |
| Pack bytes reported by Git | 5,029,888 | 123,296,768 |

For each concurrency run, ten candidate commits changed ten distinct fixture paths. Ten others each changed the same base file to different contents. Every worker repeatedly read `refs/heads/main`, called `git merge-tree --write-tree` with that tip and its candidate, created the resulting commit with `git commit-tree`, then attempted `git update-ref refs/heads/main NEW OLD`. A failed CAS retries from the new tip. The expected result is ten disjoint changes plus one of the ten overlapping changes landing, with the other nine rejected as textual conflicts; both runs produced that count. p50 and p95 use nearest-rank percentiles over the 20 per-change wall times. The captured output lists every change and retry count.

The bad-batch demonstration constructs seven landed commits, with a test predicate that becomes bad at item 4. Binary search identifies it in three probes. Revert reads the bad commit's parent blob into a temporary index, writes a tree, creates a revert commit, and compare-and-swaps `main`; no checkout or worktree is used.

The HTTP timings are local loopback elapsed time, with the server already running. A small Python standard-library HTTP wrapper invokes Git's `http-backend`; the full-clone and incremental-fetch Git clients speak smart HTTP to it. The captured byte count is the repository's packed-object size from `git count-objects -v`, not a network bill or a disk benchmark. Full raw command output for both repositories, including the Git version and per-change latencies, is in [output.txt](../../../spikes/v3/sp-b/output.txt). Reproduce with:

```sh
bash spikes/v3/sp-b/land-proto.sh
bash spikes/v3/sp-b/land-proto.sh /Users/sebastianpatronsoto/agent-runs/clones/gen-v-decomp
```

## What this establishes, and what it does not

The Git object model supports server-side commits built with `hash-object -w`, a temporary `GIT_INDEX_FILE`, `read-tree`, `update-index --index-info`, `write-tree`, and `commit-tree`. `merge-tree --write-tree` can calculate a merge tree and signal textual conflicts without a checkout. `update-ref <ref> NEW OLD` supplies the atomic ref compare-and-swap needed to publish that result. Disjoint changes can win independent CAS attempts after retry; concurrent writers still contend on the one `main` ref, and overlapping textual edits conflict.

This experiment does not establish production service throughput, object-store costs, or end-to-end agent productivity. It is one small, synthetic 20-change batch on one local host per repository, with no network RTT, TLS, concurrent CI, repository-service contention, or semantic conflict detector. Its latency includes local process scheduling and repeated merge computation; these numbers should not be extrapolated to Cloudflare, a database ref service, a larger swarm, or another Git version. The HTTP timings are loopback only. A clean `merge-tree` result does not prove behavioral compatibility.

## Prior art

| System | Model and tradeoff relevant to Concord |
| --- | --- |
| Zuul gating | A dependent queue speculatively tests successive queue prefixes in parallel, then merges the exact tested sequence. If an earlier change fails, dependent builds are discarded or repeated. This preserves a tested mainline while using parallel CI; repeated failures spend work and delay later changes. |
| Uber SubmitQueue | The EuroSys paper describes a distributed queue, a conflict graph, and probabilistic speculation to select parallel builds; it commits patches only when safe, aiming for an always-green mainline and high throughput. Its planner, build system integration, learned models, and monorepo scale are a substantial system to reproduce. |
| bors-ng | Review-approved pull requests are grouped on a `staging` branch and tested as a batch. Passing batches fast-forward main; failing batches are split and bisected. This is a useful simple model for batch CI and diagnosis, but the archived project points new adopters to GitHub's native queue and relies on GitHub and external CI. |
| GitHub merge queue | FIFO merge groups include the latest base and changes ahead in the queue; required checks run on the merge-group commit, and successful groups land. Build concurrency is configurable. This gives pre-merge integration checks without building the queue engine, but couples Concord's own GitHub replacement to GitHub's workflow and check events. |

These are not interchangeable implementations: Zuul and GitHub emphasize a tested ordered integration sequence; bors batches and bisects; SubmitQueue predicts useful speculative builds at much greater system complexity. The prototype's CAS loop only arbitrates a Git ref. It does not implement those systems' CI semantics.

## Recommendation: both, with different jobs

Use **both pre-merge checks and post-merge tests** for v3, while keeping the ordinary landing path optimistic and parallel:

1. Before CAS, always calculate the candidate against current `main`, reject textual conflicts, and run fast required checks against that exact merged tree. Checks should be selected by change impact where sound, with a small repository-wide baseline. Speculate checks for likely compatible changes and allow independent candidates to land after CAS retries; avoid holding a repository-wide lock while agents edit or while builds run.
2. After landing, run broader integration, full-suite, and deployment-safety tests asynchronously. Attribute a failure to the landed range with server-side bisection, then revert or pause promotion under an explicit owner control. Keep high-impact invariants in the pre-merge set so post-merge diagnosis is a recovery path rather than the sole safety boundary.

This balances a green-enough base for agents with throughput: a mandatory full suite for every candidate risks making test duration the serialization point, while post-merge-only testing can leave later agents building on a bad tip. The exact pre-merge test tiers, risk policy, and rollback authority need an owner decision informed by real Concord CI costs; this spike did not measure those costs.

## Sources

Primary sources were read directly; no search-result snippets were used as evidence.

- [Zuul project gating documentation](https://zuul-ci.org/docs/zuul/latest/gating.html) — read the relevant sections on dependent pipelines, speculative builds, failure recovery, and window sizing.
- [Keeping Master Green at Scale, EuroSys 2019](https://www.masoud.io/docs/eurosys19.pdf) — downloaded the author-hosted paper and read the relevant sections on architecture, probabilistic speculation, implementation, evaluation, throughput, and limitations.
- [bors-ng README](https://github.com/bors-ng/bors-ng) — read the relevant sections on staging batches, merge behavior, bisection, and project status.
- [bors-ng flow example](https://github.com/bors-ng/bors-ng/blob/master/FLOW_EXAMPLE.md) — read the relevant section on staging, CI status reporting, and merge completion.
- [GitHub: Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) — read the relevant sections on merge groups, checks, build concurrency, merge limits, and failure handling.
- [GitHub: Merging a pull request with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue) — read the relevant sections on queue use and removal.
- [Anthropic: Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control) — read the relevant sections on server-side changesets, CAS refs, immutable data, and post-merge testing.
- [Cursor: Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents) — read the relevant sections on lock bottlenecks, optimistic concurrency, and planner/worker roles.
- [Git `http-backend` documentation](https://git-scm.com/docs/git-http-backend) — read the relevant section on smart HTTP service and CGI operation.

## UNVERIFIED

- The benchmark does not verify how production storage, distributed ref CAS, or real CI load will affect these results.
- The task's supplied Cloudflare Artifacts binding and pricing details were treated as context and were not independently checked in this spike.
