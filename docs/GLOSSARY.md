# Concord glossary

One page mapping Concord terms to their closest GitHub equivalent and a one-line definition. Unmarked terms exist on `main`; terms marked **(in progress)** are still in flight on other branches. Each term links to its doc section where one exists.

| Concord term | GitHub equivalent | What it is |
| --- | --- | --- |
| [repo](api-repos.md#repository-and-change-api) | repository | One tenant-scoped project with its own coordinator, policy, and event log. |
| [canonical main](ARCHITECTURE.md#data-model) | default branch (`main`) | The single protected history; only the promoter advances it, never agents. |
| [change](api-repos.md#repository-and-change-api) | pull request | The collaboration record: one intent plus its evidence, revisions, and reviews. |
| [revision](api-repos.md#repository-and-change-api) | PR head commit | One immutable published head of a change; a new head increments the revision. |
| [intent key](ARCHITECTURE.md#data-model) | branch name + linked issue | Stable task identity; repeats return the same active change. |
| [claim / lease](api-leases.md#claim-and-inspect) | assignee lock (no exact equivalent) | Exclusive semantic reservation of units, granted all-or-nothing. |
| [unit](api-leases.md#unit-identity) | changed file / hunk | One claimable piece of work named by a `unitKey`. |
| [unit: file](api-leases.md#unit-identity) | changed file | Whole-file unit `file:<path>`; covers every row and symbol inside. |
| [unit: TSV row](api-leases.md#unit-identity) | cell range in a data file | Independent row `row:<table>:<key>`; distinct rows can land together. |
| unit: markdown section **(in progress)** | heading section | Section-level unit with section-level merge; not on `main` yet, so no doc section. |
| [unit: new file under an approved folder](api-leases.md#owner-file-unit-policy-generation) | new file in a PR | `file:<path>` under owner-approved `newFilePrefixes`; same path claims conflict. |
| unit: generated file **(in progress)** | generated artifact | Runner-regenerated declared derived file; not on `main` yet, so no doc section. |
| [sequence](ARCHITECTURE.md#data-model) | commit order / event id | Monotonic repo number ordering queue entries and events; not itself claimable. |
| [fence](api-leases.md#renew-and-release) | ETag / `If-Match` | Per-lease token proving current ownership; renew, release, and publish need it. |
| [hold](api-leases.md#claim-and-inspect) | assignment | A live lease an agent currently holds (see `leases.heldItems` in snapshots). |
| [inspection / check](ARCHITECTURE.md#local-checker-runner-protocol) | CI check run | Trusted verification of a published revision before it can be reviewed or queued. |
| [runner](runner.md#local-runner) | self-hosted CI runner | Polls jobs and posts evidence; one job at a time, never writes canonical history. |
| [runner: checker](ARCHITECTURE.md#local-checker-runner-protocol) | CI job | Validates a candidate or composed stack against pinned inputs. |
| [runner: promoter](ARCHITECTURE.md#local-checker-runner-protocol) | merge bot | Pushes only the already-checked commit to canonical `main`. |
| [profile](runner.md#configuration) | CI workflow config | Pinned checker, toolchain, oracle, and environment a runner must match. |
| [policy](api-leases.md#unit-identity) | CODEOWNERS + branch rules | Owner-installed unit registry and trust pins; candidates reference, never edit. |
| [verdict](api-verdicts.md#review-verdicts-and-carry) | approving review | Independent reviewer's approval bound to a manifest and finding-set version. |
| [carry (patch-id)](api-verdicts.md#exact-carry-example) | retained approval after rebase | Derived verdict across a clean cherry-pick with equal patch-id and paths. |
| [finding](api-findings.md#list-and-create) | blocking review comment | Stable objection tied to a change revision; renames and rebases never drop it. |
| [queue](api-queue.md#routes-and-limits) | merge queue | Ordered landing line; admission converts lease claims into reservations. |
| [stack](ARCHITECTURE.md#checker-arbitrated-speculative-queue) | stacked PRs | Candidates composed with native Git onto one base and checked as a whole. |
| [bisect / blame](api-queue.md#failure-isolation-and-arbitration) | `git bisect` / `git blame` | Bounded re-checking of stack halves to attribute a failure to a minimal set. |
| [landing](api-queue.md#promotion-and-reconciliation) | merge | Checked stack frozen into a ticket the promoter pushes to canonical `main`. |
| [issue](api-issues.md#issues) | issue | Repo-scoped task spec that changes and leases link to. |
| [milestone](api-issues.md#milestones) | milestone | Progress group with derived open/closed/landed counts. |
| [tracker](api-issues.md#issues-and-milestones-api) | Issues / Projects | The issues-plus-milestones system that specs, links, and closes work. |
| [principal](ARCHITECTURE.md#auth-and-trust) | user / app / token | Authenticated identity with tenant, roles, repo scope, and expiry. |
| [principal: owner](ARCHITECTURE.md#auth-and-trust) | org owner / admin | Provisions repos, installs policy, bootstraps, and creates contests. |
| [principal: agent](ARCHITECTURE.md#auth-and-trust) | contributor / bot | Claims units, edits, and publishes revisions to its own fork. |
| [principal: reviewer](ARCHITECTURE.md#auth-and-trust) | reviewer | Independent approver; never the change author. |
| [principal: viewer](ARCHITECTURE.md#auth-and-trust) | read-only collaborator | Reads state and history; cannot mutate. |
| [delegated principal](api-principals.md#mint) | fine-grained PAT | Runtime-minted, scoped, expiring subagent token with descendant revocation. |
| [protected path levels](land.md#land-a-finished-agent-run) | CODEOWNERS / protected branches | Issue allowlists and the policy registry decide which paths work may touch. |
| [backup mirror](deploy.md#optional-github-human-mirror) | upstream mirror | Optional one-way GitHub copy pushed only after a confirmed canonical landing. |

Checker and promoter are also roles in the auth model, but they belong to trusted runner processes, not people; see [auth and trust](ARCHITECTURE.md#auth-and-trust).

## Branches

Each change gets a candidate fork with its own branch, and revisions are pushed there — never to `main`. [`concord change checkout`](cli.md#changes) fetches that branch into a local `concord/<branch>` ref for editing. There are no long-lived feature branches and nobody pushes to `main`: the promoter alone advances it after checking. Stacked work is expressed as [change dependencies](api-queue.md#routes-and-limits), not branches on branches.
