# SP-D: dependency-aware swarms and dispatch

**Date:** 2026-10-15  
**Scope:** design spike and read-only simulation; no agent, container, model API, or paid service was started.  
**Owner context:** the repo-replacement and human-control goals in the supplied v3 brief; human controls also cite [D-AGENT-FIRST-HUMAN-CONTROLS](../../decisions.md#d-agent-first-human-controls). This spike proposes no change to that decision.

## Recommendation

Make issues, dependency edges, milestones, runs, tasks, and agent sessions first-class records. Let a run subscribe to a saved issue query, then repeatedly claim the smallest eligible task under both run-wide caps. Keep the planner, workers, and judge as replaceable agents behind a backend contract. Store state and append-only events in Concord; deliver events to clients over streaming HTTP/MCP subscriptions, with cursor-based recovery. The API and CLI should expose the same state transitions.

Start with explicit dependency edges and manually declared file/resource intents. Parse dependency phrases only for import and suggest structured edges for human confirmation. A free-form issue body is not a durable dependency API. For parallel writes, favor isolated changesets and optimistic merge/rebase with bounded repair; path overlap can inform scheduling but a long-lived exclusive file lease recreates the bottleneck described by Cursor. Keep human pause, cancel/release, bump, lock-for-review, force-land, and review actions audited and separate from agent permissions.

The available backlog is too small to validate throughput: it has one open issue, no edges, and no explicit file paths. The simulation validates the mechanics and reports that limitation; it is not evidence of swarm-scale performance.

## Proposed data model

All IDs are stable opaque IDs. Repository issue numbers remain human-readable local identifiers. Writes increment a repository sequence and append an immutable event in the same transaction. Derived ready state is updated on each relevant write, not recomputed by scanning the full event history.

| Record | Fields and invariants |
| --- | --- |
| `Issue` | `id`, repo-local `number`, title/body, open/closed state, workflow state, priority, labels, estimate, declared `paths`, milestone ID, parent issue ID, timestamps, close reason. Unique `(repo_id, number)`. |
| `IssueEdge` | `from_issue_id`, `to_issue_id`, `kind`: `blocks` or `parent`; author/source, created/removed sequence. A directed `blocks` edge means completion of `from` is required before `to` can be ready. The inverse “blocked by” is a view, never a second stored fact. A parent-child edge is hierarchical metadata and does not itself block a child. Enforce one parent per child, same repo, and acyclic parent and blocking graphs. |
| `Milestone` | `id`, repo, title, description, due date, state, query/filter, timestamps. Issues may have at most one active milestone; a milestone run snapshots its selected issue IDs and query revision. |
| `Run` | `id`, repo, selection kind (`issue`, explicit issue set, milestone, saved query), selected IDs/revision, `max_concurrency`, `budget_limit`, currency, `spent_estimate`, policy snapshot, creator, state, timestamps, stop reason. Require positive concurrency and nonnegative budget; the cap is shared by every task/session in this run. |
| `Task` | `id`, run, issue, attempt, state, dependency snapshot/version, declared and observed paths, worker role/backend, retry policy, cost ceiling/reservation/actual estimate, result changeset, validation and judge records, error and human-needed reason. Enforce one active task per issue per run and idempotent attempt creation. |
| `AgentSession` | `id`, task, role (`planner`, `worker`, `judge`), backend + pinned model/runtime version, backend session handle, scoped credential references (never secret bytes), worktree/sandbox ID, status, cost/usage counters, start/heartbeat/end times, stop request and exit result. A task may own multiple sequential sessions; each session belongs to exactly one task and role. |
| `ChangeSet` | `id`, task, immutable base commit, patch/tree, declared paths, validation result, merge result, landed commit, timestamps. Agent sessions can write only to their task workspace; only the landing service writes canonical refs. |
| `RunEvent` | sequence, run/task/session IDs, event kind, minimal typed payload, event time. Append-only; stream cursors resume by sequence and compacted snapshots provide recovery. |

### Incremental ready set and cycle checks

For an open issue `i`, `ready(i)` is true exactly when it is not already owned by an active task, every incoming `blocks` predecessor is closed/landed, its milestone/run policy permits dispatch, and both concurrency and reserved-budget capacity are available. `parent` edges organize and select work but never block readiness unless a future explicitly configured parent policy says otherwise.

Maintain `open_blocker_count` per issue and reverse adjacency by predecessor. On an edge insert, transactionally reject self-edges, cross-repository edges, and any `blocks` insertion for which a path already exists from the dependent back to the proposed predecessor. Reject a parent edge that would make a parent cycle or create a second parent. On issue close/land, decrement the counter of each dependent once; when it reaches zero, evaluate the other predicates and insert the issue into the ready index. On reopen, increment dependent counters before reevaluation. Edge changes and the ready-index update share one serializable transaction or compare-and-swap against the repository sequence. A periodic full graph check is a repair/integrity check, not the normal dispatch path.

No edge is inferred from issue numbers alone. During GitHub import, recognize only explicit phrases like `depends on #N`, `blocked by #N`, and `after #N`; show the proposed direction and require confirmation. Preserve source text/provenance. Unknown/malformed references remain warnings and cannot silently block dispatch.

## Run selection, planner, worker, judge

- `run issue #N`, `run issues #N,#M`, `run milestone M`, and `run query <saved-filter>` create the same `Run` shape. A selection snapshot makes later issue edits explicit: add/remove selection through audited run events, or create a new run.
- A planner is optional. For direct issue runs, deterministic dispatch can begin immediately. A planner may split an issue into child issues/tasks, add dependency suggestions, estimate cost and path intents, then yield the graph for validation. Planner writes are proposals until accepted under the caller's policy; no hidden orchestrator is required.
- A worker handles one task in an isolated worktree/sandbox and returns a changeset plus declared/observed paths, logs, tests, usage and a completion summary. The backend adapter maps the common start/stream/stop API to its provider. The worker cannot land to the canonical branch or close an issue.
- A judge validates the task outcome against policy: tests, path scope, dependency completion, changeset conflict, required review, and merge checks. It can pass, request a bounded repair, or set `needs-human`; a separate human reviewer may be mandatory by repository policy. A judge result is evidence, not permission to merge if policy says a human must decide.
- A budget broker atomically reserves the task/session ceiling before launch and accounts provider usage as events arrive. Run budget is the shared ceiling, not `budget × concurrency`. If a provider cannot hard-enforce the requested cap, dispatch only a bounded allocation to that provider and stop/cancel on the broker threshold, while reporting possible in-flight overshoot.

## Task and issue state machine

```text
blocked ──dependencies satisfied──> ready ──claim──> queued ──backend start──> running
   ^                                                        │                    │
   │                                              transient failure              │ result
   │                                                        v                    v
   └──────────────────────────────────────────────────── retry_wait <── changeset_ready
                                                              │                    │
                                                     retry due │                    v
                                                              └──> queued      validating
                                                                                   │
                                                fail/retryable ───────────────────┤
                                                                                   v
                                                         judge/review required -> judging
                                                                                   │ pass
                                                                                   v
                                                                                landing
                                                                                   │ canonical merge
                                                                                   v
                                                                                 landed
                                                                                   │ run post-merge checks
                                                                                   v
                                                                            post_land_check
                                                                                   │ policy/side effect succeeds
                                                                                   v
                                                                          issue closed

Any nonterminal state ──policy/ambiguity/permission/budget/merge conflict──> needs_human
needs_human ──owner resumes with a recorded disposition──> ready | retry_wait | validating | cancelled
Any cancellable pre-land state ──cancel──> cancelled (release claims/reservations, stop sessions)
```

`landed` records the canonical commit and remains distinct from `issue closed`. Post-merge checks run after landing; issue close waits for the configured checks and can be retried idempotently if the issue service is unavailable. A post-merge failure is not silently marked successful: record it, open repair/revert work, and move the run to `needs_human` when policy cannot safely recover. `retry_wait` records the failure class, attempt count, capped exponential delay and new budget reservation; permanent errors and exhausted retry limits go to `needs_human` or `failed_permanent`. A partial model response, worker crash, lost stream, judge disagreement, budget stop, dependency reopening, or merge conflict is an event with an explicit transition, not a silent reset. Never automatically retry non-idempotent external side effects without an idempotency key.

Run states: `planning`, `running`, `paused`, `budget_exhausted`, `completed`, `cancelled`, `needs_human`, `failed`. Pause prevents new claims and lets the owner choose whether active sessions drain or are interrupted. Cancel interrupts active sessions and releases task claims after process termination is confirmed; it cannot undo an already landed changeset.

## Backend comparison

The adapter contract is `start(task, workspace, credential_refs, budget, config)`, `events(cursor)`, `interrupt(reason)`, `terminate()`, and `usage()`. For Git operations, issue a short-lived token scoped to exactly one repository and only the required read/write operations; separate model-provider credentials from Git credentials. Prefer to keep the Git token in Concord's checkout/publish broker and expose a narrowly scoped credential helper only while needed. Never put token values in command arguments, agent prompts, logs, or durable session metadata. These are Concord design recommendations; provider-native token isolation varies.

| Backend | Start a task | Scoped token | Cost cap | Stream status | Stop |
| --- | --- | --- | --- | --- | --- |
| Claude Agent SDK | Run `query` in the adapter's Python/TypeScript process with task prompt, isolated cwd, tools and permissions. It uses the Claude Code agent loop. | Set `ANTHROPIC_API_KEY` only in the worker process; pass Git token through a broker/helper with repository scope. API key comes from Claude Console. | SDK reports token/model usage and estimated `total_cost_usd`; `max_budget_usd` / `maxBudgetUsd` is a per-query limit. Treat it as provider estimate, reserve headroom, and broker the aggregate run budget. | Consume async message iterator; persist assistant/tool/result messages as task events. | SDK `interrupt()`/close query; terminate worker process after bounded grace. **UNVERIFIED:** exact process-tree guarantees for every SDK/runtime version. |
| Claude Managed Agents API | Provision an agent + environment, create a session with `initial_events` or create then send `user.message`. | Use a workspace API key for control plane; use vault references for MCP credentials. Session-scoped git access still needs a narrow MCP/tool or self-hosted environment integration; do not assume workspace key scopes git. | Session creation accepts hard `max_list_cost` in USD. It stops new model requests at the ceiling, but an in-flight request/tool can finish and slightly exceed it. Add a run-level broker cap. | Session event stream and webhooks expose status, messages and usage. Persist event IDs and resume from the event list. | Send `user.interrupt`; archive/delete the session or stop its environment. Running tool calls may finish before interruption takes effect. |
| Claude Code headless | Run `claude --bare -p ...` in an isolated workspace; bare mode avoids loading host/project hooks, plugins and credentials. | `ANTHROPIC_API_KEY` in invocation-only environment; use separate scoped Git helper. | `--max-budget-usd` is print-mode estimated spend, includes subagents, and can overshoot; use provider estimate plus broker ceiling. | `--output-format stream-json --verbose --include-partial-messages`; result includes session and cost metadata. | Interrupt with SIGINT for orderly turn ending, or SIGTERM from supervisor; provider docs describe process-tree shutdown on SIGTERM. |
| OpenAI Codex CLI `exec` | `codex exec --json --sandbox workspace-write '<task>'` inside a task worktree; default sandbox is read-only, so set only the minimum write mode needed. | Provide `CODEX_API_KEY` only to that invocation, or trusted saved auth. Scope the separate Git credential to one repo. Never expose model keys to untrusted project scripts in the same environment. | JSONL `turn.completed` reports token usage; **UNVERIFIED:** a hard per-run dollar ceiling in `codex exec`. Enforce centrally with a small task allocation, usage monitoring and process termination; quote API pricing separately. | `--json` emits JSON Lines events (`thread.started`, `turn.*`, `item.*`, `error`) on stdout; progress also goes to stderr. | Send process interrupt/terminate through supervisor. **UNVERIFIED:** provider-specific graceful-stop semantics beyond normal process control. |
| Cloudflare Sandbox SDK / Containers | Worker gets a task-named sandbox/DO; start a configured image and `exec` the CLI in it. SDK helpers operate on a container already started by the Durable Object; they do not start or monitor it. | Put secrets in Worker secrets/bindings; supply only per-task scoped values through a protected exec/env channel. Disable Internet by default and allowlist only required endpoints. | Container resource billing is usage-based (CPU, provisioned memory/disk, egress); Workers Paid plan is required. **UNVERIFIED:** no native agent-token dollar ceiling; enforce a run budget in the coordinator and hard timeout/resource caps. | Capture process stdout/stderr and emit task events from the Worker; DO state and event log provide recovery. | Interrupt/terminate process and stop/destroy container; configure inactivity timeout. Verify lifecycle callbacks and persisted workspace before relying on shutdown behavior. |
| Docker on local host | Start one disposable container per task (`docker run` with pinned image, worktree mount, limits and network policy); call the configured CLI inside. | Mount a short-lived read-only secret file or use a credential helper; separate Git/model secrets; do not bake into image or environment inherited by arbitrary build scripts. | Docker limits CPU/memory/disk, not model-provider spend. **UNVERIFIED:** no generic provider-dollar cap; broker provider usage and stop at allocated spend. Local compute has no per-task Docker bill, but host/power/provider costs remain. | Capture container stdout/stderr and Docker events/logs; publish them as task events. | `docker stop` then `docker rm`; kill remaining process/container after grace. A host shutdown loses local process state unless workspace is persisted externally. |
| Existing AW launcher (`aw-launcher-cbe6596`) | `delegate-issue owner/repo#N` or `delegate-work --repo owner/repo --spec-file ...`; selected adapter runs bounded detached work in a separate worktree/run directory. Supported/opt-in callers and workers vary; inspect README for current allowlists. | It has repo/app publisher credential handling and worker-specific auth. GitHub App publisher tokens are kept out of worker env/argv and revoked after use. This is a launcher behavior, not a generic plug-in contract. | `--max-wall-seconds` caps elapsed wall time. Usage accounting/status files and model-specific controls exist; **UNVERIFIED:** a generic run-wide dollar ceiling across all workers/backends. | `status.json`, `run.log`, `usage.json`, and `delegate-status`; detached worker status is local-file based. | `delegate-cancel <run-dir> --job-id ... --attempt-id ...` cancels a verified admitted run; orphan finalization is separate. |

### Backend takeaways

Managed Agents is the most complete provider-hosted lifecycle (events, sessions, budget, interrupt), but creates vendor/runtime coupling and may require an Anthropic account. Claude SDK/headless and Codex are portable local-process backends with useful structured streams and some per-run metering; coordinator enforcement is needed for an aggregate dollar budget. Sandbox products isolate compute but do not by themselves cap model spend. Docker is the simplest local backend when Concord already trusts the host, but imposes host operations and recovery responsibility. The existing launcher is a mature bounded-run/publish pipeline and useful implementation reference, but does not supply issue dependency planning or a demonstrated backend-neutral dollar cap.

## Prior art

- **GitHub sub-issues and dependencies:** sub-issues are explicit parent/child hierarchy; dependency UI/API represents blocked-by and blocking, and `gh issue view --json blockedBy,blocking` can read typed edges. This is a useful import target, but hierarchy is not the same as blocking semantics. GitHub's REST dependency endpoints are distinct from prose parsing.
- **Linear:** issue relations provide blocked-by/blocking/related/duplicate semantics, while parent/sub-issues support multi-level hierarchy and optional parent/child status automation. Project dependencies have their own timeline-level end-to-start semantics. Keep issue-level and project/milestone-level edges distinct.
- **Forgejo:** official issue-tracking guidance says issue dependencies can prevent closure; the config reference exposes `ALLOW_CROSS_REPOSITORY_DEPENDENCIES`. **UNVERIFIED:** the reviewed Forgejo documentation did not establish a current end-user dependency editor/API schema or its cycle/edge semantics, so do not claim parity with GitHub or Linear.
- **Cursor, “Scaling long-running autonomous coding”:** their post reports lock failure (20 agents yielding effective throughput of 2–3), then planner/worker separation and a judge at cycle end. This supports planner/worker roles and non-exclusive coordination; it is Cursor's report, not an independent benchmark.
- **Steve Yegge, Gas Town:** the post and project README describe a Mayor coordinator, worker agents, durable work tracking, workspaces, convoys, and a Refinery merge queue. Adopt durable task identity and supervised merge stages; avoid assuming a human-facing coordinator must drive each transition.
- **Anthropic Scion, “Redesigning source control”:** the post describes server-side changesets and merges, derived indexes, content-addressed immutable reads, few refs, and post-merge testing instead of a global merge-queue lock. This supports the proposed server-side changeset path as a design direction, though Scion's scale and private implementation are not evidence that Concord should copy its entire architecture.

## Backlog simulation

### Reproduce the read-only export and simulation

```sh
gh issue list -R seb-patron/concord --state all --limit 500 --json number,title,body,state,labels,milestone > spikes/v3/sp-d/issues.json
PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/sp-d/ready_set_sim.py > spikes/v3/sp-d/output.txt
```

The export intentionally uses the requested fields only. It does not include typed dependency or sub-issue fields; the script parses dependency phrases in title/body and reports missing references and cycles. It treats closed exported issues as already complete, sorts eligible open issues by number, runs each simulated issue for one unit tick, caps concurrency at 10, and will not put two tasks naming a detected path in the same tick. File matching is deliberately conservative and lexical (path-like tokens and code-formatted filenames), not semantic ownership analysis. No duration or dollar cost estimate is inferred from issue text.

### Measured backlog

Raw export command:

```text
$ gh issue list -R seb-patron/concord --state all --limit 500 --json number,title,body,state,labels,milestone
[{"body":"Owner standing approval for AW workers on this private repo, like seb-patron/agent-workflows#434. The owner's comment below is the Authorization link the launcher checks.","labels":[],"milestone":null,"number":53,"state":"OPEN","title":"Standing worker approvals (Muse, SWE-2, Codex)"}]
```

Raw simulator output (also saved in `spikes/v3/sp-d/output.txt`):

```text
Concord v3 ready-set backlog simulation
source=spikes/v3/sp-d/issues.json
issues=1 open=1 closed=0
dependency_edges=0 missing_references=none
cycles=none
dispatch_cap=10 scheduling_model=unit-duration deterministic issue-number order
file_paths=explicit path-like/code-formatted names in title/body; no inferred ownership
schedule:
  tick 1: agent-1 START #53 files=(no explicit file path)
  tick 1: DONE #53
```

**Interpretation:** one candidate starts and completes in one tick; nine concurrency slots remain unused. With zero edges and no named files, this export cannot demonstrate dependency unlocking, cycle detection on a real cycle, path conflict avoidance under parallel load, realistic durations, or cost/budget behavior. It is evidence only for the observed input and simulator's explicit rules.

## Research sources

Primary sources were opened and read directly; statuses below say how much of each source informed the claims. “Relevant section” means the relevant official documentation/page section was read, not that the entire site was audited. The launcher source is local (the exact path supplied by the task), so it has no web URL.

| Source | Read |
| --- | --- |
| [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | relevant section |
| [Claude Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) | relevant section |
| [Claude Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) | relevant section |
| [Claude Code headless/programmatic use](https://code.claude.com/docs/en/headless) | relevant section |
| [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) | relevant section |
| [Claude Managed Agents session creation and budgets](https://platform.claude.com/docs/en/managed-agents/sessions) | relevant section |
| [Claude Managed Agents reference](https://platform.claude.com/docs/en/managed-agents/reference) | relevant section |
| [Claude Managed Agents secure deployment](https://platform.claude.com/docs/en/managed-agents/secure-deployment) | relevant section |
| [OpenAI Codex CLI](https://developers.openai.com/codex/cli) | relevant section |
| [OpenAI Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) | relevant section |
| [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth) | relevant section |
| [Cloudflare Sandboxes overview](https://developers.cloudflare.com/sandbox/) | relevant section |
| [Cloudflare Sandbox SDK reference](https://developers.cloudflare.com/sandbox/reference/) | relevant section |
| [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) | relevant section |
| [Docker `run` reference](https://docs.docker.com/engine/containers/run/) | relevant section |
| Existing AW launcher repository at `/Users/sebastianpatronsoto/agent-runs/_manual/aw-launcher-cbe6596/README.md` and its `bin/delegate-work`, `bin/delegate-issue`, `bin/delegate-cancel` entrypoints | relevant sections |
| [GitHub sub-issues overview](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues) | relevant section |
| [GitHub sub-issues guide](https://docs.github.com/en/enterprise-cloud%40latest/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues?apiVersion=2022-11-28) | relevant section |
| [GitHub issue dependency guide](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies) | read in full |
| [GitHub issue dependency REST API](https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2022-11-28) | relevant section |
| [Linear parent and sub-issues](https://linear.app/docs/parent-and-sub-issues) | read in full |
| [Linear issue relations](https://linear.app/changelog/2020-03-04) | relevant section (the current documentation URL redirected to issue properties home) |
| [Linear project dependencies](https://linear.app/docs/project-dependencies) | relevant section |
| [Forgejo issue tracking basics](https://forgejo.org/docs/v15.0/user/getting-started/issue-tracking-basics/) | relevant section |
| [Forgejo configuration cheat sheet](https://forgejo.org/docs/latest/admin/config-cheat-sheet/) | relevant section |
| [Cursor, “Scaling long-running autonomous coding”](https://cursor.com/blog/scaling-agents) | read in full |
| [Steve Yegge, “Welcome to Gas Town”](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04) | relevant sections |
| [Gas Town project README](https://github.com/gastownhall/gastown/blob/main/README.md) | relevant section |
| [Anthropic, “Redesigning source control”](https://www.anthropic.com/engineering/redesigning-source-control) | read in full |

Claims beyond those sources, including exact Concord provider integration, end-to-end security of token delivery, managed-agent pricing/availability for Seb's account, generic Codex spend enforcement, and real throughput improvement are **UNVERIFIED**. No paid account or backend was tested; the comparisons are documentation-based.
