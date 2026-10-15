npm run -s decisions: ERR_MODULE_NOT_FOUND: Cannot find package 'tsx' imported from <worktree>/ (Node.js v26.7.0). Approved but not live: unavailable because the command failed.

# v3 full-read evidence report: agents, issues, and backends

## Owner decisions command

Current `npm run -s decisions` output:

```text
node:internal/modules/package_json_reader:301
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from <worktree>/
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:784:9)
    at packageResolve (node:internal/modules/esm/resolve:784:9)
    at moduleResolve (node:internal/modules/esm/resolve:873:18)
    at defaultResolve (node:internal/modules/esm/resolve:1006:11)
    at ModuleLoader.defaultResolve (node:internal/modules/esm/resolve:784:12)
    at ModuleLoader.resolve (node:internal/modules/esm/loader:688:38)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:608:36)
    at ModuleLoader.importSyncForRequire (node:internal/modules/esm/loader:539:34)
    at loadESMFromCJS (node:internal/modules/cjs/loader:1565:24)
    at Module._compile (node:internal/modules/cjs/loader:1712:5) {
  code: 'ERR_MODULE_NOT_FOUND'
}

Node.js v26.7.0
```

The command exits before producing decision rows, so an `Approved but not live:` list is unavailable in this environment. I did not change a recorded policy or ask the owner to resolve one.

## Scope and method

I fetched and read all accessible sources in the assignment, plus the entire local v3 draft. Fetched bytes and text extracts remained under `$DELEGATE_SCRATCH_DIR`. The notes record each source URL, retrieval method, raw SHA-256, extracted `wc -w` count, read status, and heading-by-heading notes. The Medium source returned a Cloudflare 403 block page and is recorded `NOT READ`; this is 1 of 26 sources, below the specified one-third stop threshold. No other page was substituted.

The status labels below mean: **supported** = the supplied source directly states the claim; **wrong** = it conflicts with the source; **unsupported** = a Concord design/test assertion or broader statement that the supplied sources do not establish. “Unsupported” does not mean the product proposal is invalid.

## Claims in section 10: Issues and dependencies

| ID | Draft claim | Status and evidence | Exact proposed edit |
|---|---|---|---|
| 10.1 | Issues live in Concord; agents use CLI/MCP; owner edits in console. | Unsupported by the external issue docs; this is Concord’s product design. GitHub and Linear show multiple UI/CLI/API surfaces but do not describe Concord. | Keep as a proposal and prefix: “In Concord, issues will live in the repository database. Agents will create and update them through CLI and MCP; the owner will edit them in the console.” |
| 10.2 | An issue is ready iff open, has no open blocker, and no task works on it. | Unsupported by GitHub/Linear docs. They document blocker relations and issue hierarchies, not this ready predicate or task occupancy. | Replace with: “Concord proposes that an issue is ready when it is open, has no open blocking dependency, and has no active task. This is Concord dispatch policy, not GitHub or Linear behavior.” |
| 10.3 | A blocks edge means A must close before B is ready. | Supported as the ordinary meaning of a blocker relation by GitHub dependency pages and Linear’s blocking vocabulary; those sources do not mandate a particular status transition. | Replace with: “A blocking edge records that B is blocked by A; Concord will treat B as dispatch-ineligible until A closes.” |
| 10.4 | A parent edge groups issues and does not block. | Supported as a distinction between hierarchy and dependency by GitHub sub-issues/About Issues and Linear parent/sub-issues. | Keep; clarify: “Parent-child hierarchy groups work. It does not create a blocking dependency or gate readiness by itself.” |
| 10.5 | Concord stores blocked-by as a view, not as a second fact. | Unsupported as a Concord storage design by external docs. GitHub’s REST API exposes blocked-by and blocking directions, but that does not dictate Concord’s normalized schema. | Replace with: “Concord stores one directed blocking edge and derives blocked-by/blocking views from it.” |
| 10.6 | Closing an issue decrements `open_blocker_count`; zero makes it ready and emits an event. | Unsupported by cited issue platforms; these are proposed derived-state and event mechanics. | Replace with: “Proposed Concord behavior: closing an issue recomputes affected blocker counts, updates readiness, and emits an event. The count is derived state, not a behavior established by GitHub or Linear.” |
| 10.7 | Concord refuses cycle-forming edges and names the cycle. | Unsupported by all supplied GitHub/Linear pages; no cycle validation behavior is documented there. | Replace with: “Concord will reject an edge that creates a dependency cycle and return the cycle path. This is a Concord invariant to test.” |
| 10.8 | “blocked by #12” text proposes an edge; a person or policy accepts; free text never blocks dispatch alone. | Partly supported: Linear’s changelog distinguishes issue references from blocker relations, and GitHub makes dependencies explicit. The propose/accept flow is Concord-specific. | Replace with: “Issue mentions and free text are references only. A blocker edge must be explicitly created or accepted through Concord policy; text alone never changes readiness.” |
| 10.9 | A planner can propose issues, edges, and expected units with a reason. | Unsupported by issue-platform sources; Gas Town supports coordinator-created task groups, but not this exact proposal schema. | Replace with: “Concord may let a planner propose issues, dependency edges, expected units, and rationale; proposals require the configured acceptance step before they affect dispatch.” |
| 10.10 | SP-D simulation counts and rounds, including strict file exclusion taking five times more rounds. | Not assessed/unsupported by the sources in this task. Cursor reports qualitative lessons but does not reproduce these backlog simulations. | Keep only with the underlying SP-D report and reproducible inputs linked; otherwise remove the numbers and state that the supplied reading does not verify them. |

## Claims in section 11: Runs and swarms

| ID | Draft claim | Status and evidence | Exact proposed edit |
|---|---|---|---|
| 11.1 | A run covers one issue, issue list, milestone, or saved query and has parallel cap, dollar budget, role models, and one backend. | Unsupported as a unified feature by the third-party sources; Gas Town documents convoys and concurrency, while platform docs describe individual sessions and environments. | Prefix: “Concord proposes a run scope of one issue, issue list, milestone, or saved query, with a concurrency cap, shared budget, per-role model selection, and backend selection.” |
| 11.2 | Dispatcher reacts to events and does not poll. | Unsupported by assigned agent/issue/backend docs. It is a Concord architecture decision. | Keep as a proposal and add its validation condition: “The dispatcher is event-driven; acceptance tests must show it starts newly ready tasks without periodic polling.” |
| 11.3 | Planner/worker roles are established; workers do not coordinate and fix their own conflicts; a judge decides pass/repair/person. | Cursor directly supports planner/worker separation and says workers focus on assigned work and handle conflicts; it also reports removing an integrator. Cursor does not describe Concord’s judge or guarantee this policy. Gas Town demonstrates a Mayor-led alternative. | Replace with: “Cursor reports success with planners assigning tasks and workers focused on one task, with workers resolving conflicts; its post does not validate Concord’s judge role. Concord proposes a judge that applies policy, permits one repair, or escalates to a person.” |
| 11.4 | Bring-your-own backend starts through `concord work next`/MCP `task_take`; no provider hard cap; token expires. | Product/API behavior is unsupported by the supplied docs. The Codex and Claude docs do not establish Concord’s task token or expiration model. | Mark the row “Concord adapter design; not provider behavior.” Retain the commands only as proposed interface names and define token expiry in the Concord API spec. |
| 11.5 | Claude headless backend uses `claude --bare -p`, stream JSON, `--max-budget-usd`, and SIGINT then SIGTERM. | Supported with qualifications by Claude headless/CLI docs. `--bare`, `-p`, stream JSON, and the flag exist; max-budget is a client-side estimate and can overshoot. SIGTERM exits 143 and leaves the turn unfinished; SIGINT is the documented graceful alternative. | Replace row with: “Claude Code CLI: `claude --bare -p … --output-format stream-json`; `--max-budget-usd` is an estimated soft stop and can overshoot; interrupt with SIGINT/SDK interrupt, then SIGTERM for termination.” |
| 11.6 | Claude Agent SDK uses `query` in adapter process and `maxBudgetUsd` for each query; `interrupt()`. | Supported by SDK docs as an API shape, but the cost limit is query-local, estimated, and may exclude spend restored from a resumed session; crash totals can be incomplete. | Replace cap cell with: “`maxBudgetUsd` is query-local estimated spend, not a hard session/run cap; resumed-session spend may be excluded and totals can be incomplete after crash.” Keep `interrupt()` only with the SDK reference as its source. |
| 11.7 | Managed Agents creates task session, has a session cost limit and in-flight request can finish, interrupt/archive stops. | Supported with precision: list-cost budget is configured at session creation, stops new model requests after threshold, may overshoot by the in-flight request; interrupt makes work idle but archive/delete have distinct semantics. | Replace with: “Create a session with a public-list-cost budget; new model requests stop at the cap, but an in-flight request can finish. Send `user.interrupt` to stop generation; archive only after idle, and separately pause deployments to prevent new scheduled runs.” |
| 11.8 | Codex `codex exec --json` in worktree; cap not found, broker stops it; process stop. | Headless `codex exec`, JSONL output, sandbox flags, and local repository work are supported. Supplied docs do not show a Codex spend-reporting field or native spend cap; process termination is Concord wrapper behavior. | Replace with: “Codex CLI: `codex exec --json` in an isolated worktree/sandbox; the supplied docs do not confirm native cost reporting or a spend cap, so Concord must meter if available and enforce its own process stop.” |
| 11.9 | Existing AW launcher uses `delegate-work`, wall time only, and `delegate-cancel`. | Unsupported by the assigned sources. No backend/launcher documentation for this existing tool was included. | Mark “Not evaluated by this source set” and cite a separate direct read before using it as comparative evidence. |
| 11.10 | Broker reserves money per session, counts backend-event usage, and stops at the limit; run budget is shared. | Unsupported as a provider capability; the Claude SDK reports estimated usage, Managed Agents exposes list-cost session usage, and Codex materials supply no cost field/cap. Concord’s cross-provider reservation and enforcement are product work. | Replace with: “Concord proposes a shared run ceiling and per-session reservations. Adapters report provider usage where available; the broker must define estimation, missing-data handling, overshoot, and process termination. This is Concord behavior, not a guarantee from every backend.” |
| 11.11 | Each session principal can read/claim/write/comment but cannot land, alter policy, or read secrets. | Unsupported by the supplied vendor docs as Concord authorization semantics. Managed Agents security guidance supports least-privilege tools and credential separation generally. | Prefix “Concord authorization proposal:” and specify the permission matrix and tests; do not attribute it to backend docs. |

## Claims in section 19: Cost and budgets

| ID | Draft claim | Status and evidence | Exact proposed edit |
|---|---|---|---|
| 19.1 | VPS money cost is fixed. | Unsupported by supplied sources, which contain no VPS provider pricing. This may be true for a selected fixed-price plan, but not established here. | Replace with: “A fixed-price VPS plan has a largely fixed base charge within its included limits; verify provider, VAT, backups, bandwidth, and overage pricing before budgeting.” |
| 19.2 | Route row limits and one-hour zero request/timer budgets. | Unsupported by external source docs; these are Concord performance targets. | Label the table “Proposed Concord route budgets and acceptance targets”; retain the values as testable requirements, not researched product facts. |
| 19.3 | Tree/file reads use zero DB rows and are cached indefinitely by commit ID; land cost scales with change size. | Unsupported by the assigned sources; these are Concord implementation claims. | Keep as design targets and add tests/measurement criteria; phrase indefinite cache as immutable-object cache policy, not source-backed fact. |
| 19.4 | Model spend is the large variable cost; broker/run budgets control it; board shows costs. | Partly supported that agent costs vary with usage, but backend cost observability differs. Claude SDK values are client-side estimates; Managed Agents exposes public list-cost usage; the supplied Codex pages show no cost report or cap. | Replace with: “Model spend is a variable run cost. Claude SDK estimates can differ from bills, Managed Agents reports list cost, and the supplied Codex docs establish neither cost reporting nor a native cap. Concord proposes to aggregate usage in its broker and show provenance/uncertainty for each amount.” |

## Claims in section 21: Delivery plan

| ID | Draft claim | Status and evidence | Exact proposed edit |
|---|---|---|---|
| 21.1 | P1: ten agents work with no orchestrator; disjoint changes land, overlap queues with ETA, routes stay in budget. | Unsupported as a proven result by Gas Town or Cursor. Cursor reports hundreds with a planner hierarchy, not an orchestrator-free Concord system; Gas Town has a Mayor and Refinery. | Replace “Done when” with: “Done when the Concord swarm test demonstrates ten agents under the documented dispatch policy, disjoint changes land, conflicting work queues with a measured ETA, each route meets its declared budget, and idle request/timer counts are zero. This is an acceptance test, not a result established by the cited swarm reports.” |
| 21.2 | P2: a bad batch is found and reverted with no person in the loop. | Docker documents containers and exit statuses, not Concord’s batch bisect/revert or successful unattended recovery. | Replace with: “Done when an automated integration test injects a known bad change, identifies it by batch bisect, reverts it, and verifies the resulting main; document the exact failure modes that still require a person.” |
| 21.3 | P3: imported backlogs have correct ready sets and mirror main on GitHub. | GitHub docs support issue dependencies, sub-issues, and APIs; Linear supports hierarchy and project dependency views. None validates Concord import mapping, cycle handling, or ready-set correctness. | Replace with: “Done when fixture-backed imports preserve issue numbers, metadata, hierarchy, and blocker edges; Concord’s ready set matches a manually verified oracle for both repositories; and the mirror’s main ref matches Concord.” |
| 21.4 | P4: milestone run completes without chat using dispatcher, budget broker, BYO and container backends. | Backend docs confirm individual headless/session/container capabilities, not this integrated Concord workflow or shared cap. | Replace with: “Done when an end-to-end milestone run completes under a recorded no-chat test for each enabled backend; adapter events, usage gaps, cap overshoot, cancellation, and recovery are recorded. Treat shared budget enforcement as a Concord acceptance criterion.” |
| 21.5 | P5: idle console makes no requests and two repositories run only on Concord for a week. | Unsupported by assigned source docs; it is a prospective product/operations test. | Keep as a measurable acceptance test and define telemetry source, test interval, and what counts as a request. |
| 21.6 | P6: new user starts a server from guide in 15 minutes. | Docker docs show container runtime options but do not validate Concord setup time. | Keep as a usability target and define the clean-machine baseline and timing procedure. |

## Required Cursor correction in section 9

The draft’s “This is one more reason why claims do not lock by default” conflates Concord claims on source units with Cursor’s locks. Cursor’s article says agents locked tasks in a shared coordination file; it reports lock contention and abandoned locks there. It does not report locks on source files. Replace the relevant sentence with: “Cursor’s shared TASKS-file locks caused contention and abandoned claims; that experiment does not test file or symbol locks. Concord’s shared-by-default claim policy is a separate design choice, informed here by our own edit-overlap measurements.”

## Backend facts confirmed by these docs

- **Headless flags:** Claude CLI documents `-p`/`--print`, `--bare`, JSON, and stream JSON. Claude SDK provides programmatic `query()`. Codex documents `codex exec`, JSONL output, sandbox selection, and device-code authentication for headless devices. Docker documents detached `docker run -d`; Cloudflare documents task sandboxes for coding agents.
- **Cost reporting:** Claude Agent SDK exposes token counts, per-model usage, and `total_cost_usd`/`costUSD`; the dollar values are local estimates and can differ from billing. Managed Agents documents cumulative session usage and list cost. The supplied Codex docs do not establish a run-cost reporting field. Cloudflare/Docker docs describe infrastructure charges, not model-token metering.
- **Spend caps:** Claude CLI `--max-budget-usd` is based on client-side estimated cost, can overshoot, and includes subagent spend; SDK `maxBudgetUsd` is query-scoped and may exclude restored session usage. Managed Agents supports a session list-cost budget that stops new requests at the cap, while an in-flight request can finish and exceed it; the budget is attached at creation. The supplied Codex docs do not confirm a native spend cap. Concord’s shared broker/run ceiling is proposed Concord behavior and must handle backend reporting differences.

## Source notes

Full source-by-source notes, raw hashes, word counts, statuses, and heading entries are in [sp-f3-agents-notes.md](reads/sp-f3-agents-notes.md).

## Deviations

`npm run -s decisions` could not run because the checkout does not have the `tsx` package installed; the output and unavailable `Approved but not live:` list are recorded at the start of this report. The assigned Medium article was blocked by HTTP 403; it is marked `NOT READ`, with the exact failing curl command and error in the notes. No other substitutions were made. Internal review was unavailable in this detached run because native child agents were not enabled in the harness.
