# Source-reading notes: agent swarms, issue dependencies, and backends

Extracted text was produced from the fetched HTML by removing script, style, SVG, template, and noscript elements, then joining visible strings from the main/article/body element. Extracted word counts below are `wc -w` counts on those text files; SHA-256 is over the original fetched bytes. The GitHub README and Docker pages include visible page navigation in extraction; notes cover the source content headings in page order. All fetches were made 2026-10-15 20:04 UTC.

# Gas Town README.md
URL: https://github.com/gastownhall/gastown/blob/main/README.md
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://github.com/gastownhall/gastown/blob/main/README.md' -o "$DELEGATE_SCRATCH_DIR/raw/01.html"`
Raw SHA-256: 3a3fb7c303e5ff553fe223a5b0cfadd6c89e846f54dce613a03a2f12f0b523d3
Extracted words: 4192 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/01.txt"`)
Read status: read in full
## Sections
1. **Gas Town** — The README describes a multi-agent workspace manager with persistent work tracking in git-backed hooks and Beads. It presents agent orchestration as a product with roles, work tracking, and operational services.
2. **Overview** — A Mayor coordinates several runtimes and projects while state survives agent restarts. This is a concrete integrated system rather than evidence for a general performance claim.
3. **What Problem Does This Solve?** — The page frames context loss, manual coordination, scaling beyond a handful of agents, and memory-based work state as problems. Its stated 20–30 agent scale is a project claim, not an independently measured result here.
4. **Architecture** — The diagram places a Mayor, Town, project Rigs, Crew, Hooks, and Polecats around git worktrees. Durable workspaces and role boundaries are central to the described design.
5. **Core Concepts** — Terms define a hierarchy of coordinator, workspace, project, workers, persistent storage, and work groups. Concord can borrow terminology only with care because Gas Town’s model and merge workflow differ.
6. **The Mayor 🎩** — The Mayor is a Claude Code coordinator with broad workspace context and a natural-language interface. That is a concrete orchestration pattern, not proof that every swarm needs a central agent.
7. **Town 🏘️** — A Town is the top-level local workspace containing projects, agents, and configuration. It is not a server-side multi-tenant forge.
8. **Rigs 🏗️** — A Rig wraps one repository and manages its associated agents. The project boundary is repository-oriented.
9. **Crew Members 👤** — Crew is the human’s personal hands-on workspace within a Rig. It separates interactive human edits from worker activity.
10. **Polecats 🦨** — Polecats have stable identities and histories but ephemeral sessions. Persistent identity is distinct from persistent process execution.
11. **Hooks 🪝** — Hooks are git-worktree based persistent storage intended to survive crashes and restarts. This supports durable task state, not a claim that source-file locks should be used.
12. **Convoys 🚚** — Convoys group Beads assigned to agents; a `mountain` label adds stall detection and smart skipping. The grouping resembles milestone-scale runs but uses Gas Town-specific machinery.
13. **Beads Integration 📿** — Beads are structured, git-backed work records with prefixed identifiers, and the page uses “bead” and “issue” interchangeably. That is an implementation choice, not an issue-dependency standard.
14. **Molecules 🧬** — TOML formulas instantiate tracked multi-step workflows, with lightweight root-only or materialized sub-wisp modes. This shows repeatable task workflows can coexist with issue tracking.
15. **Monitoring: Witness, Deacon, Dogs 🐕** — A per-Rig Witness, cross-Rig Deacon, and dispatched Dogs form layered health supervision. The design uses supervisors to recover stuck agents and perform maintenance.
16. **Refinery 🏭** — A per-Rig processor batches completed work, runs verification, and uses a Bors-style bisecting merge queue. The README explicitly describes queue-based serialized integration.
17. **Escalation 🚨** — Agents can create severity-routed blocker records that flow through Deacon, Mayor, and potentially Overseer. Blocker escalation is a tracked workflow, not the same as dependency edges.
18. **Scheduler ⏱️** — A configurable capacity governor can defer dispatch to avoid rate limits; direct dispatch is the default. This supports limiting parallel work when resources require it.
19. **Seance 👻** — Session discovery reads event logs so an agent can query predecessors for context. It is a continuity mechanism rather than shared mutable task coordination.
20. **Wasteland 🏜️** — Separate Gas Towns federate work through a shared wanted board and completion evidence. This external federation is outside Concord’s described single-forge scope.
21. **Installation** — The project supports native and Docker installation paths. The required runtime and support tooling are substantial and environment-specific.
22. **Prerequisites** — Git, Go on some paths, Beads, SQLite, ICU, tmux, and a default Claude CLI are listed, with platform caveats. Alternative agents are supported but orchestration still assumes the Gas Town environment.
23. **Local setup** — Users install prerequisites and then the `gt` binary. The steps are practical setup guidance rather than product architecture evidence.
24. **Install gt on macOS** — Homebrew bundles `gt`, Beads, and Dolt; source builds require separate dependencies and PATH care. Platform-specific installation details do not support Concord backend capability claims.
25. **Install gt on Linux** — Dolt, `gt`, and `bd` are installed separately with Go. PATH ordering avoids stale binaries.
26. **Install gt on Windows** — Dolt and Go tools are installed separately; native source builds need MSYS2, while full tmux workflows favor WSL. This qualifies portability claims.
27. **Create your workspace** — `gt install` initializes HQ and `gt up` starts persistent services. Git identity setup is required for the documented initialization path.
28. **Add a project** — `gt rig add` clones a repository and allows a custom Beads prefix. Project onboarding is explicit rather than an automatic repository import.
29. **Create your crew workspace** — A Crew workspace is a personal clone for hands-on work. It gives the human a distinct work area.
30. **Start the Mayor** — `gt mayor attach` starts the coordinator session. It demonstrates a persistent interactive control point.
31. **Docker Compose setup** — Compose runs a sandbox container with an HQ bind mount, bootstrap, optional GitHub auth, and dashboard. The dashboard is explicitly a trusted local-network surface.
32. **Quick Start Guide** — The quick start chains install, startup, doctor, agent configuration, and Mayor attachment. It is intended to produce a functioning local system quickly.
33. **Getting Started** — The proposed first interaction is telling the Mayor what to build. This is the human-facing workflow.
34. **Basic Workflow** — The diagram moves from a request to convoy creation, worker assignment, hook persistence, completion, and summary. It illustrates centralized planning plus specialized execution.
35. **Example: Feature Development** — A multi-issue feature is placed in a convoy, assigned, tracked, and monitored through commands. This shows task grouping and visibility.
36. **Common Workflows** — The README offers multiple orchestration styles for different task shapes. The system is configurable rather than locked to one task flow.
37. **Mayor Workflow (Recommended)** — For complex multi-issue work, the Mayor creates agents and convoys, monitors, and hands work back for review. It remains a coordinator-led model.
38. **Minimal Mode (No Tmux)** — Users can run runtimes manually while Gas Town tracks state. The documented workflow still relies on durable tracking and explicit assignment.
39. **Beads Formula Workflow** — TOML formulas express ordered steps with dependencies and variables. This is an executable workflow graph separate from issue-level blockers.
40. **Manual Convoy Workflow** — Users can create a convoy, add issue IDs, and assign agents themselves. The coordinator can therefore be partly manual.
41. **Runtime Configuration** — Per-Rig config selects a provider, command, arguments, and prompt mode; runtime-specific hooks or startup fallback are described. This supports adapter-style runtime selection, with provider-specific integration differences.
42. **Key Commands** — Command families cover setup, dispatch, tracking, escalation, monitoring, formulas, and federation. The breadth emphasizes CLI operation.
43. **Workspace Management** — Commands install HQ, add Rigs, list projects, and create Crew. They manage the environment, not issue dependency semantics.
44. **Agent Operations** — Commands list agents, sling work, select runtimes, start the Mayor, and recover context. Built-in presets span several agent tools.
45. **Convoy (Work Tracking)** — Convoy commands create, list, inspect, and add issues to work groups. Grouping is distinct from a parent/sub-issue hierarchy.
46. **Configuration** — Users can define custom runtime commands and a default agent. The adapter is configured by data rather than a fixed provider.
47. **Monitoring & Health** — Escalation, scheduling, and session discovery commands expose operations. Monitoring is part of the product workflow.
48. **Beads Integration** — Formula and molecule commands create and inspect reusable workflows. They reinforce Beads as both tracker and workflow substrate.
49. **Wasteland Federation** — Commands join, browse, claim, and complete externally offered work. This is federation across Towns, with evidence and reputation.
50. **Cooking Formulas** — Built-in formula recipes are available in the binary. Reusable work templates can be productized.
51. **Activity Feed** — A terminal dashboard joins agent, Beads, and merge-queue activity in panels. It is refreshed activity visibility, not a documented WebSocket architecture.
52. **Problems View** — Health states identify stalled, zombie, working, and idle agents, with nudge and handoff actions. The page’s 20–50+ scale statement motivates filtering but gives no experiment details.
53. **Dashboard** — The web dashboard presents agents, convoys, hooks, queues, issues, and escalations, auto-refreshing with htmx. Its command palette can run `gt` actions from the browser.
54. **Monitoring & Health** — A daemon, Boot, Deacon, Witnesses, and Refineries form a watchdog chain. This is layered process supervision, with AI agents involved in triage.
55. **Witness (Per-Rig)** — Witnesses detect stuck agents, recover by nudge or handoff, clean sessions, and track completion. They are designed to delegate rather than implement.
56. **Deacon (Cross-Rig)** — Deacon patrols all Rigs, dispatches maintenance Dogs, and escalates unresolved problems. It owns cross-project health supervision.
57. **Escalation** — Commands create, list, and acknowledge blockers that route by severity. Blockers become Beads for resolution.
58. **Merge Queue (Refinery)** — Polecats submit work; the Refinery batches and verifies it, then merges green batches or bisects red ones. This is queue and batch integration, contrary to a direct inference that all agent systems avoid integration queues.
59. **Scheduler** — A configured polecat ceiling enables incremental daemon dispatch; the default immediately dispatches. Capacity control is explicit and configurable.
60. **Seance** — Commands find and query earlier sessions through event logs. This supports continuity across ephemeral runtime sessions.
61. **Wasteland Federation** — A federation network shares wanted work and awards multidimensional completion stamps. The details depend on DoltHub and are unrelated to local dependency graph behavior.
62. **Telemetry (OpenTelemetry)** — Structured logs and metrics cover lifecycle, state changes, operations, and durations through OTLP. Operational observability is an explicit system feature.
63. **Advanced Concepts** — The README introduces design principles, lifecycle, and recommended orchestration patterns. These are descriptive design claims from the project’s own docs.
64. **The Propulsion Principle** — Git hooks serve as durable, versioned, rollback-capable multi-agent coordination state. Persistence is the key mechanism described.
65. **Hook Lifecycle** — A hook moves through created, active, suspended, completed, and archived states. Lifecycle recovery is modeled explicitly.
66. **MEOW (Mayor-Enhanced Orchestration Workflow)** — The pattern asks the Mayor to decompose work, create a convoy, spawn agents, distribute Beads, monitor, and summarize. It favors a planner/coordinator role.
67. **Shell Completions** — Bash, Zsh, and Fish completion commands are included. This is CLI usability material.
68. **Project Roles** — Mayor, human, Polecat, Witness, Deacon, Refinery, Hook, and Convoy have distinct interfaces and responsibilities. Role specialization is a central architectural feature.
69. **Tips** — Guidance recommends Mayor-first use, convoys, persistent hooks, formulas, feed, and dashboard. It is prescriptive operating advice.
70. **Design Documentation** — The README links architecture, lifecycle, scheduler, telemetry, and integration documents. The linked docs are outside this fetched source and were not substituted for it.
71. **Troubleshooting** — The section offers recovery actions for disconnected agents, stuck convoys, and a nonresponsive Mayor. Operational recovery is explicit.
72. **Agents lose connection** — The suggested fix is inspect and repair hooks. It relies on the persistence mechanism described earlier.
73. **Convoy stuck** — A convoy refresh command is suggested. It is a narrow manual recovery procedure.
74. **Mayor not responding** — Detach and reattach the Mayor session. The coordinator is restartable.
75. **License** — The README identifies the project license. This administrative section adds no evidence about Concord’s dependency or backend design.
## What it means for Concord v3
The role pattern supports separating planner, worker, and health supervision in sections 11 and 21 P4, but Gas Town’s Mayor is a coordinator and its Refinery is a batch merge queue. Do not use it as support for “no orchestrator” or for removing integration queues. Persistent task state, configurable concurrency, multi-runtime commands, and issue grouping are useful analogies; they do not establish Concord’s proposed ready-set semantics.

# Welcome to Gas Town
URL: https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04' -o "$DELEGATE_SCRATCH_DIR/raw/02.html"`
Raw SHA-256: c33e70b990e7d5d1315177296cb03b58ea2e89505995b7d39d3596cbf2aaada3
Extracted words: 123 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/02.txt"`)
Read status: NOT READ (HTTP 403; Cloudflare returned “Sorry, you have been blocked.” Failed command: `curl -L --fail --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04' -o "$DELEGATE_SCRATCH_DIR/raw/02-retry.html"`; error: `curl: (56) The requested URL returned error: 403`, exit 56. Response body was a block page, not the article.)
## Sections
1. **Sorry, you have been blocked** — The fetched body is an access-denial page, not source content. No claim about the article can be established from this response.
2. **You are unable to access medium.com** — The page attributes the block to the site’s access controls. The article remains unread.
3. **Why have I been blocked?** — The response gives a generic security-block explanation without the article text. It provides no substitute evidence.
4. **What can I do to resolve this?** — The page directs the visitor to contact the site owner with diagnostic details. No alternate source was fetched, per the reading rules.
## What it means for Concord v3
No Concord claim can rely on this article in this run. Remove it from the v3 evidence list or re-read it directly in an authorized run before relying on it.

# Scaling long-running autonomous coding
URL: https://cursor.com/blog/scaling-agents
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://cursor.com/blog/scaling-agents' -o "$DELEGATE_SCRATCH_DIR/raw/03.html"`
Raw SHA-256: cdd13f17698952b094dcfbe0112a34c4748c4396e2ca314e207da6bbb69a94d7
Extracted words: 1179 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/03.txt"`)
Read status: read in full
## Sections
1. **Scaling long-running autonomous coding** — Cursor reports experiments with hundreds of concurrent agents, long-running projects, and substantial generated code. This is a company account of its experiments, not an independently audited benchmark.
2. **The limits of a single agent** — Focused agents are useful but complex projects are slow; initial division of work is ambiguous. The article says it first tried dynamic self-coordination.
3. **Learning to coordinate** — Agents claimed tasks and updated a shared coordination file, protected by agent-managed locks; locks were held too long or forgotten, and 20 agents fell to effective throughput of two or three. Optimistic concurrency improved robustness, but a flat structure still led to risk avoidance and churn.
4. **Planners and workers** — Cursor separated continuously exploring task planners from workers that do not coordinate with peers and push completed changes. A judge evaluated whether to start another cycle; this is evidence for role separation, not a blanket case against all locks.
5. **Running for weeks** — Reported experiments include a browser, a multi-week migration, and product optimization, with many workers pushing to one branch and few conflicts. The account demonstrates claimed long-duration scale but does not specify a controlled comparison.
6. **What we've learned** — Cursor says model choice and prompting matter, and removing an integrator reduced bottlenecks because workers handled conflicts. It also emphasizes a middle level of structure between chaos and fragility.
7. **What's next** — Cursor says coordination remains imperfect, planners should wake when work completes, and long runs need fresh starts. These are acknowledged open problems, not evidence that its approach is finished.
8. **Related posts** — The page lists other articles. Their content is not part of this source and is not used.
## What it means for Concord v3
Section 11’s attribution that Cursor’s locks were on TASKS in a shared coordination file is supported; the source does not describe file locks. Replace the claim that Cursor showed “locks hurt” as evidence against source-level file locks with a narrower claim about shared task-file lock contention, and preserve the reported 20-agent / 2–3 throughput figure with attribution and caveat. Planner/worker separation is supported as an approach, not as proof that Concord’s roles or land flow will succeed.

# Creating issue dependencies - GitHub Docs
URL: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies' -o "$DELEGATE_SCRATCH_DIR/raw/04.html"`
Raw SHA-256: a6069c6f7b6213704c7b03c02ead82e286047316b5247b1f47c05f73232b97dd
Extracted words: 514 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/04.txt"`)
Read status: read in full
## Sections
1. **Creating issue dependencies** — GitHub defines relationships that identify blocking and blocked work. Creation is available to users with at least triage permission on supported plans.
2. **Who can use this feature?** — The page lists repository permission and plan eligibility. It is a platform feature with access constraints.
3. **In this article** — The page indexes creation, removal, and CLI management. This index matches the substantive sections below.
4. **Marking an issue as blocked by, or blocking, another issue** — Users choose a relationship and select issues; blocked issues receive a visible indicator on project boards or repository issue pages. The UI supports either direction of the blocking relation.
5. **Removing a blocking relationship between two issues** — Users can change blocked-by or blocking relationships and deselect removed relations. The relationship is mutable.
6. **Managing issue dependencies with GitHub CLI** — `gh issue create/edit/view` supports blocked-by and blocking flags, including JSON fields. The docs establish a usable precedent for both CLI and API-oriented dependency access.
## What it means for Concord v3
Supports section 10’s explicit directed blocker edges, reversible relation management, and CLI exposure. It does not support Concord’s “ready” rule, cycle rejection, or milestone planner logic; those need to be labeled as Concord design choices rather than GitHub behavior.

# REST API endpoints for issue dependencies - GitHub Docs
URL: https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2022-11-28
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2022-11-28' -o "$DELEGATE_SCRATCH_DIR/raw/05.html"`
Raw SHA-256: 1b4e8448bf7fa925ceceec42ffe646d26ba86cb2540bf17f1f42f3066d03efc	
Extracted words: 2840 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/05.txt"`)
Read status: read in full
## Sections
1. **REST API endpoints for issue dependencies** — The REST page covers listing, creating, and removing issue dependencies. Public resources can be accessed without authentication; write endpoints require issue write access.
2. **List dependencies an issue is blocked by** — The API returns dependency issue records and supports pagination with a default of 30 and maximum of 100. It documents read permission, response codes, media types, and a full issue-shaped example.
3. **Fine-grained access tokens for "List dependencies an issue is blocked by"** — GitHub App and fine-grained personal tokens need Issues read permission. Public resources may be read without those credentials.
4. **Parameters for "List dependencies an issue is blocked by"** — Owner, repository, and issue number are required; page sizing and page number are optional. The endpoint is per issue.
5. **HTTP response status codes for "List dependencies an issue is blocked by"** — Success and moved, missing, and gone states are documented. Error semantics are part of the endpoint contract.
6. **Code samples for "List dependencies an issue is blocked by"** — Examples use cURL, JavaScript, and GitHub CLI. The API surface is not limited to the web UI.
7. **Request example** — The GET route is `/issues/{issue_number}/dependencies/blocked_by`. It takes no body.
8. **Add a dependency an issue is blocked by** — A POST adds a `blocked_by` issue by its numeric issue ID; GitHub warns that rapid content creation may trigger secondary rate limits. A successful request returns the issue representation.
9. **Fine-grained access tokens for "Add a dependency an issue is blocked by"** — Write access to Issues is required for fine-grained tokens. The API can operate unauthenticated only for public resource reads, not this mutation.
10. **Parameters for "Add a dependency an issue is blocked by"** — The target owner/repository/issue are path fields and `issue_id` is a required body field. This is a directed edge mutation.
11. **HTTP response status codes for "Add a dependency an issue is blocked by"** — The endpoint documents creation, forbidden, missing, gone, and validation/rate-spam responses. Invalid or excessive requests can fail with 422.
12. **Code samples for "Add a dependency an issue is blocked by"** — Samples show the POST route and body. Example output is a full issue object, not just an edge identifier.
13. **Request example** — The request posts `issue_id` to the `blocked_by` endpoint. The documentation uses the current API version header in its example.
14. **Remove dependency an issue is blocked by** — A DELETE removes a blocking relation and may also be subject to secondary rate limits. The example response is the issue object.
15. **Fine-grained access tokens for "Remove dependency an issue is blocked by"** — Removal needs Issues write permission for fine-grained tokens. The page also lists App token support.
16. **Parameters for "Remove dependency an issue is blocked by"** — The target issue and blocking issue ID form the route. Removal is an explicit edge operation.
17. **HTTP response status codes for "Remove dependency an issue is blocked by"** — Success and authorization, bad request, missing, gone, and moved statuses are listed. The page does not describe cycle or graph validation rules.
18. **Code samples for "Remove dependency an issue is blocked by"** — A DELETE request is provided for cURL, JavaScript, and CLI. It gives a direct public API precedent.
19. **Request example** — The route ends in `/dependencies/blocked_by/{issue_id}`. The relationship direction is explicit in the endpoint name.
20. **List dependencies an issue is blocking** — A GET lists issues blocked by the selected issue and is paginated. This provides the inverse relation view.
21. **Fine-grained access tokens for "List dependencies an issue is blocking"** — Read permission is required for private resources; public reads can be unauthenticated. App and fine-grained token types are listed.
22. **Parameters for "List dependencies an issue is blocking"** — The issue path and optional pagination parameters match the inverse list operation. Results are not described as a computed ready set.
23. **HTTP response status codes for "List dependencies an issue is blocking"** — Success, moved, missing, and gone statuses are documented. No dependency graph cycle semantics are specified.
24. **Code samples for "List dependencies an issue is blocking"** — The examples show how to query the inverse endpoint. The API exposes both edge directions.
25. **Request example** — The route ends in `/dependencies/blocking`. It returns issues for which this issue is a blocker.
## What it means for Concord v3
Section 10’s directed blocker relationship and API/CLI accessibility are supported; the inverse list and CRUD operations are established precedent. Exact readiness criteria, cycle rejection, event-driven recalculation, and edge extraction from text are not claims from this API documentation and should be framed as Concord behavior.

# Adding sub-issues - GitHub Enterprise Cloud Docs
URL: https://docs.github.com/en/enterprise-cloud%40latest/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues?apiVersion=2022-11-28
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://docs.github.com/en/enterprise-cloud%40latest/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues?apiVersion=2022-11-28' -o "$DELEGATE_SCRATCH_DIR/raw/06.html"`
Raw SHA-256: 4519f82b4e2f1261dfa04bbe3603eb3303627845d9f745442c436e13816e0440
Extracted words: 480 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/06.txt"`)
Read status: read in full
## Sections
1. **Adding sub-issues** — GitHub sub-issues break larger work into tasks, expose parent-child relationships in projects, and support up to 100 children and eight nested levels. Parentage is a hierarchy, distinct from blocker status.
2. **Who can use this feature?** — At least triage permission is required. The page is scoped to GitHub Enterprise Cloud.
3. **In this article** — The index lists creating, adding existing, and CLI operations. These cover both new and pre-existing child issues.
4. **Creating a sub-issue** — The UI creates a child and optionally sets type, assignees, labels, projects, and milestones. A parent can therefore organize work without implying that every child blocks it.
5. **Adding an existing issue as a sub-issue** — Existing issues can be selected from the same or another repository. The operation attaches hierarchy to existing issue records.
6. **Working with sub-issues using GitHub CLI** — CLI supports `--parent`, `--add-sub-issue`, `--remove-sub-issue`, and `--remove-parent`. This confirms parent/child operations are distinct from blocker edge operations.
## What it means for Concord v3
Section 10’s statement “A parent edge groups issues and does not block” is well-grounded as an explicit semantic distinction; the cited source documents a hierarchy rather than scheduling semantics. Concord’s limits and behavior should be specified independently.

# About issues - GitHub Docs
URL: https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues' -o "$DELEGATE_SCRATCH_DIR/raw/07.html"`
Raw SHA-256: f2d82427fbd203688407e2839660435dbf5298811b08b7bc5d3f983e4f39a33d
Extracted words: 856 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/07.txt"`)
Read status: read in full
## Sections
1. **About issues** — Issues track ideas, feedback, tasks, and bugs and can be discussed and planned in Projects. GitHub supports multiple creation channels.
2. **In this article** — The page indexes hierarchy, dependencies, metadata, integrations, planning, notifications, community, communication, and discussions. Its sections give the feature boundaries below.
3. **About sub-issues** — Nested issue hierarchy supports varying levels of task decomposition. Parentage is not described as a blocker relation.
4. **About issue dependencies** — Dependencies explicitly represent blocked-by and blocking relationships. This confirms dependency semantics can coexist with parent/child hierarchy.
5. **Metadata on issues** — Issue types, labels, and milestones organize work. These are metadata dimensions rather than dependency edges.
6. **About integration with GitHub** — References and pull-request closing keywords connect issues to code review and landing. This describes GitHub’s integration model.
7. **Using Projects to plan and track your work** — Projects expose issue metadata through views and filters. The page establishes planning and tracking use, not automatic dispatch.
8. **Staying up to date** — Subscription notifications and assignees support awareness and responsibility. Assignment is a separate feature from issue dependency.
9. **Community management** — Templates and issue forms help collect useful reports, and abuse reports support moderation. These are issue lifecycle features.
10. **Efficient communication** — Mentions, links, assignments, and saved replies support team coordination. Related issue references do not by themselves state that one issue blocks another.
11. **Comparing issues and discussions** — Discussions suit questions and broader conversation; issues suit trackable work, with conversion available. This delineates work records from open-ended discussion.
12. **Next steps** — The page links to issue and project planning guides. It adds pointers, not new semantics.
## What it means for Concord v3
Supports issue records, metadata, hierarchy, explicit dependencies, and planning views in section 10. It does not establish ready-set evaluation, task occupancy, auto-dispatch, or cycle handling; those are Concord-specific proposals.

# Parent and sub-issues – Linear Docs
URL: https://linear.app/docs/parent-and-sub-issues
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://linear.app/docs/parent-and-sub-issues' -o "$DELEGATE_SCRATCH_DIR/raw/08.html"`
Raw SHA-256: 2ab8f8e0f87cf5c66742edd27c8380a419cc5c10ae573424a6764c1fa41e7fff
Extracted words: 856 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/08.txt"`)
Read status: read in full
## Sections
1. **Parent and sub-issues** — Linear uses sub-issues to break work too large for one issue but too small for a project into smaller tasks. It also presents shared team work as a use case.
2. **Overview** — Adding children makes the other issue their parent. This is a work hierarchy rather than a dependency claim.
3. **Create a sub-issue** — Users can create one or many children from an issue, command menu, comment, or selected checklist text. Templates and keyboard commands support rapid decomposition.
4. **Copy properties** — Team, priority, and project are inherited; cycle may be inherited under a condition, labels are not, and assignee inheritance is conditional. Inheritance is therefore explicit and field-specific.
5. **Status automation** — Teams may configure parent auto-close when all children finish and child auto-close when the parent finishes. Such status propagation is optional.
6. **Converting issues** — Existing issues can become children or parents, and a child can be detached. The hierarchy is mutable.
7. **Turn issues into sub-issues** — Selected existing issues can be assigned a parent through the command menu. This does not say that their status gates the parent.
8. **Turn issues into parent issues** — A child can have a parent relationship set using contextual or command menus. The relation can be manipulated from either view.
9. **Turn sub-issues into issues** — Removing the parent returns an issue to a regular issue. Hierarchy is reversible.
10. **Turn issues into projects** — Converting a parent to a project removes parent-child edges and makes the issues standalone within the project. This distinguishes project grouping from issue hierarchy.
11. **Filter sub-issues** — Users can filter top-level, parent, and child issues, hide completed children, and reorder them personally. Hierarchy supports views and sorting.
12. **Display options** — Users customize child ordering and visible properties in the parent context. Display settings do not affect the underlying relation.
## What it means for Concord v3
Supports treating parent grouping separately from blocking, as section 10 does. Do not imply parent completion rules follow Linear automatically; the draft should specify whether any hierarchy status propagation exists.

# Project dependencies – Linear Docs
URL: https://linear.app/docs/project-dependencies
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://linear.app/docs/project-dependencies' -o "$DELEGATE_SCRATCH_DIR/raw/09.html"`
Raw SHA-256: b3ff19a9b6b2c5cef2b2b54e2385bc6ce70c1573aaa868cf515f9a562908acf9
Extracted words: 447 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/09.txt"`)
Read status: read in full
## Sections
1. **Project dependencies** — Linear visualizes blocking relationships among projects, and currently supports end-to-start dependencies. The scope is project timeline planning.
2. **Overview** — The relation is visual and temporal. It should not be assumed to have issue-level dispatch semantics.
3. **Create a project dependency** — Users create blocked-by or blocking links from project menus or timeline bars. Relationship creation is explicit.
4. **Working with dependencies on the timeline** — Lines navigate or remove links; moving projects can bump dependency chains, with modifiers controlling movement. Timeline operations can change dates and positions.
5. **View project dependencies** — Project overview and properties display blockers, while timeline lines visualize the graph. Both directions are represented.
6. **Dependency line color** — Blue means unviolated and red means violated. The visual state is date-based.
7. **Dates used for dependency start/end** — The link uses target or predicted dates from blocking and blocked projects. It is a schedule visualization rule, not issue-ready logic.
8. **Filtering for project dependencies** — Filters include any dependency, blocking, blocked-by, and violated dependencies. These are queryable views.
## What it means for Concord v3
Supports a recognizable blocking vocabulary and views, but the page concerns project-level end-to-start schedule links. It cannot validate section 10’s issue-level ready-set predicate or event-driven unlock behavior.

# 2020-03-04 – Changelog
URL: https://linear.app/changelog/2020-03-04
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://linear.app/changelog/2020-03-04' -o "$DELEGATE_SCRATCH_DIR/raw/10.html"`
Raw SHA-256: 1bb283dd22c33692b6b3d920de69b56b31f09a346fb8785266f7cdfab94d1624
Extracted words: 385 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/10.txt"`)
Read status: read in full
## Sections
1. **2020-03-04** — The entry announces issue relations. It records a historical product feature announcement.
2. **Issue relations** — The launch includes blocked-by, blocking, and referencing relations, with UI and keyboard ways to manage them. References are a separate relation from blockers.
3. **Issue mentions** — Identifiers and search syntax turn references in descriptions and comments into issue links. Link creation does not imply a blocker.
4. **Other improvements and fixes** — The entry lists unrelated UI, validation, timezone, and infrastructure improvements. These do not bear on Concord’s dependency semantics.
## What it means for Concord v3
Supports naming three distinct relation kinds (blocking, blocked-by, reference) in section 10 and argues for keeping free-text references distinct from accepted blocker edges. It does not support the draft’s cycle or ready-set rules.

# Agent SDK overview - Claude Code Docs
URL: https://code.claude.com/docs/en/agent-sdk/overview
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://code.claude.com/docs/en/agent-sdk/overview' -o "$DELEGATE_SCRATCH_DIR/raw/11.html"`
Raw SHA-256: 152e205396101b1c15cd236c894498978face93e99d9ee20efc2b2e69c81e29d
Extracted words: 840 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/11.txt"`)
Read status: read in full
## Sections
1. **Agent SDK overview** — The SDK embeds Claude Code’s agent loop in Python or TypeScript and runs a Claude Code binary. It includes built-in tools, permissions, sessions, hooks, and context management.
2. **Compare the Agent SDK to other Claude tools** — The SDK is a library run by the developer; CLI is a terminal tool, Client SDK exposes model APIs, and Managed Agents hosts the harness. A subprocess CLI is an option for other languages.
3. **Capabilities** — Listed features include tools, hooks, subagents, MCP, permission controls, resumable sessions, skills, and plugins. Capability availability is documented, but deployment and cost behavior vary by surface.
4. **Get started** — The quickstart uses API key authentication unless previously approved. Third-party products cannot offer claude.ai login or subscription rate limits by default.
5. **Changelog** — Separate TypeScript and Python changelogs are linked. Version-specific features must be checked against the installed version.
6. **Report bugs** — The page routes TypeScript and Python issues to GitHub. It gives no reliability guarantee.
7. **Branding guidelines** — Claude branding is optional, while presenting a product as Claude Code is prohibited. This concerns product naming.
8. **License and terms** — Commercial terms govern SDK use except components with a distinct license. This is a deployment/business constraint, not a backend capability.
9. **Next steps** — Links cover quickstart, agent loop, examples, references, and harness design. These are separate materials and were not substituted for the page.
## What it means for Concord v3
Supports section 11’s claim that Claude SDK is an embeddable backend and that it offers a programmatic agent loop. This overview alone does not prove exact interruption, headless, or budgeting semantics; cite the specific SDK, CLI, and Managed Agents pages for those.

# Quickstart - Claude Code Docs
URL: https://code.claude.com/docs/en/agent-sdk/quickstart
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://code.claude.com/docs/en/agent-sdk/quickstart' -o "$DELEGATE_SCRATCH_DIR/raw/12.html"`
Raw SHA-256: 265313b1c77367ca879d51ab27d9dfdca68350c62bc119620b2ae68fc64e5755
Extracted words: 2010 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/12.txt"`)
Read status: read in full
## Sections
1. **Quickstart** — The guide builds an autonomous code-reading and editing agent using Python or TypeScript. It presents an SDK as executable tooling, not merely a prompt wrapper.
2. **Prerequisites** — Node.js 18+ or Python 3.10+ and an Anthropic account are required. The bundled native binary has platform and package-install caveats.
3. **Setup** — The guide installs the SDK, configures an API key in the process environment, and describes supported third-party cloud providers. `.env` files are not loaded automatically.
4. **Create a buggy file** — A toy file contains two edge-case bugs. This is sample setup, not validation of backend costs.
5. **Build an agent that finds and fixes bugs** — `query` streams an agent loop, while allowed tools and permission mode determine automatic actions. The SDK handles orchestration and tool execution; callers consume messages.
6. **Run your agent** — Commands run the TypeScript or Python example and report result messages. Authentication errors require environment configuration.
7. **Try other prompts** — Examples alter documentation and type annotations. They illustrate prompt reuse only.
8. **Customize your agent** — Options can add web search, system instructions, or Bash. Granting a tool expands what the agent can do.
9. **Key concepts** — Tool sets distinguish read-only, edit, and full automation; permission modes control oversight. Modes work with allow/deny rules.
10. **Next steps** — Links cover configuration, permission controls, hooks, sessions, MCP, hosting, and troubleshooting. No automatic cost cap is asserted here.
## What it means for Concord v3
Supports that SDK calls can run a tool-using agent and stream results, and that explicit tool/permission configuration is available. Do not cite the quickstart for a hard spend limit; cost controls are documented elsewhere.

# Track cost and usage - Claude Code Docs
URL: https://code.claude.com/docs/en/agent-sdk/cost-tracking
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://code.claude.com/docs/en/agent-sdk/cost-tracking' -o "$DELEGATE_SCRATCH_DIR/raw/13.html"`
Raw SHA-256: d2dcdf1f7687c7421cf64296f9c56d0f2a548970749776c26ae11aac8260a745
Extracted words: 3808 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/13.txt"`)
Read status: read in full
## Sections
1. **Track cost and usage** — SDK messages expose per-step tokens, per-model usage, and cumulative estimated cost. Cost fields are client-side estimates, not authoritative billing.
2. **Understand token usage** — TypeScript and Python expose corresponding fields with different names; calls, steps, and sessions have distinct scopes. Resumed sessions can include earlier spend.
3. **Track costs in streaming input mode** — Results can represent per-turn usage plus running call totals; `/clear`, `/reset`, and `/new` change accumulation boundaries. `maxBudgetUsd`/`max_budget_usd` counts call-local spend, and may exclude restored session usage.
4. **Get the total cost of a query** — Result messages provide cumulative `total_cost_usd`, with caveats for missing results and crashes. Whole-tree accounting must use model usage or total cost because top-level `usage` excludes subagents.
5. **Track per-step and per-model usage** — The guide separates step counts from model breakdowns. Field names differ between SDK languages.
6. **Track per-step usage** — Parallel tool messages can duplicate IDs and should be deduplicated; per-step output token values are placeholders. Final result usage has the accumulated output tokens.
7. **Break down usage per model** — Result `modelUsage`/`model_usage` contains token and cost breakdown per model. `costBasis` indicates list, managed pricing, or unknown pricing.
8. **Accumulate costs across multiple calls** — Independent calls can be summed; resumed-session totals already include earlier spend and must not be summed twice. These remain estimates.
9. **Handle errors, caching, and output token counts** — Accurate tracking must handle failed conversations, cache tokens, and result-level output data. Error status alone does not erase incurred spend.
10. **Read output tokens from the result message** — Assistant message output counts are placeholders until the API response completes. Use final result or stream delta data.
11. **Track costs on failed conversations** — Success and error results can carry cost, but crashes may zero fields and max-budget errors may omit usage while total cost includes the crossing response. Prefer total cost/model usage when available.
12. **Recover totals after a session crash** — Use the prior result where possible; otherwise per-step recovery is incomplete and cannot recover subagent usage or USD cost. A crash may leave costs unrecoverable from the terminal result.
13. **Track cache tokens** — Cache-creation and cache-read tokens have different pricing and should be tracked separately. Automatic prompt caching is enabled.
14. **Extend the prompt cache TTL to one hour** — Environment variables/settings control cache TTL, with a higher write rate for one-hour entries. This changes cost tradeoffs, not the authority of estimates.
15. **Related documentation** — Links point to references, overview, and permissions. These links are not treated as additional fetched sources.
## What it means for Concord v3
The Claude SDK supports usage reporting and a per-query `maxBudgetUsd`, but its cost is estimated, query-local, and may not include restored spend; it can be exceeded and is not a platform hard cap. Replace section 11’s unqualified SDK “hard dollar cap” implication and section 19’s generic controls language with this scope, and keep Concord’s shared budget broker explicitly responsible for aggregate hard-stop policy.

# CLI reference - Claude Code Docs
URL: https://code.claude.com/docs/en/cli-reference
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://code.claude.com/docs/en/cli-reference' -o "$DELEGATE_SCRATCH_DIR/raw/14.html"`
Raw SHA-256: 2c8125e025dc513d7fcb7ce6fac5f410d44587bb891318fc377dfd2106974093
Extracted words: 5709 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/14.txt"`)
Read status: read in full
## Sections
1. **CLI reference** — The page is a complete command and flag reference. It includes interactive and noninteractive modes.
2. **CLI commands** — `claude -p` runs a query and exits; CLI commands also manage sessions, background agents, authentication, plugins, and diagnostics. This confirms a headless invocation path.
3. **CLI flags** — Flags configure permissions, tools, sessions, worktrees, structured/streamed output, and budgets. Many flags have version constraints and do not combine freely.
4. **System prompt flags** — Replacement, append, file, and snapshot flags control system prompts in both interactive and noninteractive mode. Replacement removes default guidance and shifts responsibility to the caller.
5. **System prompt flags in resumed conversations** — Prompt text is normally recorded at session start and changes may wait until compaction; bare mode changes recording behavior. A resumed run’s effective configuration is not simply the latest command line.
6. **See also** — Links point to related CLI, SDK, workflows, and settings. They add no additional asserted behavior here.
## What it means for Concord v3
Supports the `claude -p`/`--print` headless command and JSON/stream output, plus `--max-budget-usd` as an estimated API-spend stop with subagent inclusion and possible overshoot. The flag is not a strict invoice cap; section 11 must say “estimated limit, can overshoot,” and section 19 must distinguish provider estimates from Concord’s own run ceiling.

# Run Claude Code programmatically - Claude Code Docs
URL: https://code.claude.com/docs/en/headless
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://code.claude.com/docs/en/headless' -o "$DELEGATE_SCRATCH_DIR/raw/15.html"`
Raw SHA-256: 71e426261f52548c58a6ca4da0629e419a0e574fa35cfc98668a4b381e7ecdf4
Extracted words: 4779 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/15.txt"`)
Read status: read in full
## Sections
1. **Run Claude Code programmatically** — `claude -p` exposes the Agent SDK loop through the CLI; Python and TypeScript packages provide richer control. CLI behavior is not identical to the SDK package.
2. **Basic usage** — Noninteractive runs support selected CLI options, return process status, and can stream or return structured output. Some options conflict with print mode.
3. **Start faster with bare mode** — `--bare` skips discovery and uses API credentials rather than subscription OAuth; it changes configuration and background behavior. It is recommended for scripted/SDK runs but has version-sensitive semantics.
4. **Background tasks at exit** — Print mode can wait for background work, with a default idle wait cap and special exceptions. Reaching max budget stops remaining work.
5. **Stop a run with SIGTERM** — SIGTERM exits 143, leaves the turn unfinished, terminates command processes, and runs SessionEnd hooks. SIGINT/SDK interrupt have distinct semantics.
6. **If the working directory is deleted** — A running session continues but commands fail while the directory is absent. This is an operational edge case.
7. **Examples** — The page demonstrates piping, build scripts, output formats, streaming, retries, metadata, tool approvals, commits, and session continuation. The examples are adaptable patterns, not guarantees for Concord’s wrapper.
8. **Pipe data through Claude** — Stdin can supply context, with a 10 MB limit; JSON carries session and estimated cost data. Resumed cost totals include earlier runs.
9. **Add Claude to a build script** — A shell script can pipe a diff into a typo-lint prompt. It illustrates CLI automation.
10. **Get structured output** — Text, JSON, and stream-JSON modes are documented; JSON Schema can validate structured output. Schema `format` is annotation-only.
11. **Stream responses** — Stream JSON includes event objects and a final result; slow consumers can delay exit. SDK callbacks are another streaming route.
12. **Follow subagent messages** — Parent tool IDs and opt-in flags can expose nested subagent transcripts; version requirements apply. This provides observability into agent trees.
13. **Handle API retries** — Retry events report attempt, delay, status, and error type, with some quiet authentication retries. They can support progress reporting.
14. **Read session metadata** — The init event identifies model, tools, MCP servers, and plugins. Capability fields support feature detection.
15. **Fail CI when a plugin or MCP server doesn’t load** — Structured init errors let scripts fail on skipped integrations; stderr warnings may be absent when captured. A successful process exit alone does not prove all plugins connected.
16. **Track plugin installs** — Optional events report plugin installation progress. This is integration telemetry.
17. **Auto-approve tools** — Allowed tools and permission modes control prompts; broad Bash approval has caveats. Automatic approval is distinct from secure isolation.
18. **Turn off permission prompts in unattended runs** — `--permission-prompts none` denies unresolved prompts, suppresses waiting, and is version-gated. It does not itself grant approvals.
19. **Create a commit** — A scripted run can be granted narrowly scoped git commands. The example illustrates a controlled tool allowlist.
20. **Customize the system prompt** — Append or replace prompt text, with replacement removing default behavior. Dynamic-boundary support and cache behavior are version dependent.
21. **Continue conversations** — Continue/resume can target sessions across directories and reuse session identity. Cost totals may include prior activity.
22. **Next steps** — Links lead to SDK, CLI, and CI documentation. The links are not additional evidence.
## What it means for Concord v3
Confirms Claude headless operation (`-p`), machine-readable/stream output, interruption and tool-control primitives, and estimated spend reporting. Cost estimates and `--max-budget-usd` can overshoot; SIGTERM does not mean a graceful completed turn. Proposed exact correction: describe Claude CLI’s spend control as a soft estimated stop, and have Concord’s broker enforce its independent aggregate run cap.

# Reference - Claude Platform Docs (Managed Agents)
URL: https://platform.claude.com/docs/en/managed-agents/reference
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://platform.claude.com/docs/en/managed-agents/reference' -o "$DELEGATE_SCRATCH_DIR/raw/16.html"`
Raw SHA-256: ab105845a768b1d434c2f1ad6dd9eeeab776c62ce8823265c29355b5a9202de3
Extracted words: 1516 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/16.txt"`)
Read status: read in full
## Sections
1. **Reference** — Managed Agents is a beta API surface with versioned feature documentation. It includes event types, worker flags, MCP support, and limits.
2. **Event types** — Persisted events use domain/action names, while stream deltas are transient. Webhook names can differ from session stream names.
3. **Self-hosted worker** — The page points to worker CLI and SDK details for self-hosted environments. It does not itself specify all runtime flags.
4. **Supported MCP server types** — Remote MCP supports streamable HTTP and tunnels; deprecated SSE works by fallback. Integration protocol choices are documented.
5. **Rate limits** — Per-organization create and read limits are 300 and 1,200 requests per minute, with spend limits and usage tiers also applying. Rate limits are not a per-session spend cap.
6. **Branding guidelines** — Product branding must not impersonate Anthropic or Claude Code. The page gives approved and prohibited naming patterns.
## What it means for Concord v3
Supports that Managed Agents has structured session/usage events, but the specified limits are request rates, not cost controls. Cite the session budget page for the documented hard list-cost ceiling rather than confusing API rate limits with spend caps.

# Start a session - Claude Platform Docs (Managed Agents)
URL: https://platform.claude.com/docs/en/managed-agents/sessions
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://platform.claude.com/docs/en/managed-agents/sessions' -o "$DELEGATE_SCRATCH_DIR/raw/17.html"`
Raw SHA-256: aea32e470e28f650d5eb72abade14409d5f85ecebe39bc0ff54146c9d603d71a
Extracted words: 1979 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/17.txt"`)
Read status: read in full
## Sections
1. **Start a session** — A session binds an agent version and environment, retains history, and is started by sending user events. Creation and execution are separate unless initial events are supplied.
2. **Creating a session** — A session requires agent and environment IDs; a pinned agent version can make rollout reproducible. Configuration identity is traceable.
3. **Seed the session with initial events** — Up to 50 supported initial events can begin work at create time, with all-or-nothing validation. Some response events are invalid before a turn exists.
4. **Override agent configuration for a session** — Session-level overrides replace fields rather than merging; omitted values inherit and explicit null clears where allowed. Overrides do not mutate the underlying agent.
5. **Pin the inference geo for a session** — A model override may set or clear the inference geo and is validated against workspace policy. The model object replacement requires restating desired options.
6. **Set a session budget** — A creation-time budget caps public list cost; when reached, new model requests stop and the session pauses. The crossing request completes, so final cost can exceed the cap by a fraction; only USD is supported and a cap cannot be added at creation time retroactively.
7. **MCP authentication through vaults** — Session creation can reference vault IDs and the platform manages OAuth refresh. Credentials are separated from task text.
8. **Starting the session** — A session without initial events provisions an environment but does no work until an event is sent. The session is a state machine driven by events.
9. **Next steps** — Links cover event streaming, operations, and scheduled deployments. Related pages are not substituted for this source.
## What it means for Concord v3
Managed Agents headless/session execution and event-driven work are confirmed. A session budget is a genuine platform-enforced list-cost ceiling between model requests, but a running request can finish beyond it; revise section 11 from “Session cost limit” to “hard list-cost cap between requests; crossing request may overshoot,” and keep section 19’s broker cap separately defined.

# Secure your Managed Agents deployment - Claude Platform Docs
URL: https://platform.claude.com/docs/en/managed-agents/secure-deployment
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://platform.claude.com/docs/en/managed-agents/secure-deployment' -o "$DELEGATE_SCRATCH_DIR/raw/18.html"`
Raw SHA-256: f854adf66af700e877e86ac4e3c8d6a1c7d7a2f1ce68362e41f2bb0ed1bd0474
Extracted words: 4677 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/18.txt"`)
Read status: read in full
## Sections
1. **Secure your Managed Agents deployment** — The guide prioritizes environment, network, credentials, domains, approvals, tool minimization, untrusted input, budgets, and session monitoring. It is an opinionated security checklist for the hosted platform.
2. **Choose where the agent runs** — Cloud and self-hosted environments shift who owns sandbox security; self-hosted requires customer firewall and isolation. Web tools remain hosted and need their own domain limits.
3. **Limit the network** — Set limited networking and explicit hosts; omitted settings may yield unrestricted access. Allowed hosts grant broad operations to those hosts, including uploads.
4. **Keep credentials in vaults** — Vault injection can restrict secrets to request headers and approved destinations, but the agent can still use credentials within their scope. Never put broad API keys in prompts.
5. **Restrict web search and web fetch** — Per-tool domain allowlists constrain returned/fetched content, while query text still reaches search providers. Domain controls do not constrain Bash networking.
6. **Approve risky actions** — Per-tool policies include always-allow, automatic evaluation, and always-ask; `auto` is not human approval. Unattended paused calls need a client that can respond or interrupt.
7. **Give the agent the smallest tool set** — Built-in tools can be disabled by default and selectively enabled; MCP and custom tools need separate limits. Tool arrays are replaced, not merged, during updates.
8. **Keep untrusted input away from powerful tools** — Web, repository, ticket, and user text can influence tool use; isolate read and write roles or use narrow tools and approvals. A mounted repository can supply agent instructions.
9. **Set limits and a way to stop** — Session/deployment budgets use public list prices, stop new model requests at cap, and may overshoot for in-flight work; interruption and archival are separate lifecycle operations. A budget does not bound actions taken before the cap.
10. **Next steps** — Links point to networking, permissions, vaults, and budget documentation. The page provides concise routes to deeper controls.
## What it means for Concord v3
Supports limiting tools/credentials, per-session budget configuration, and explicit stopping semantics for the Managed Agents backend. It also confirms a provider spend cap is not a substitute for task policy or sandbox containment; add this caveat to section 11 if describing this backend as unattended.

# Codex CLI - ChatGPT Learn
URL: https://developers.openai.com/codex/cli
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://developers.openai.com/codex/cli' -o "$DELEGATE_SCRATCH_DIR/raw/19.html"`
Raw SHA-256: b781dd532248a97ece8455ded6eff359cfa2b7d9a5442144b46d805229163dd1
Extracted words: 1017 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/19.txt"`)
Read status: read in full
## Sections
1. **Inspect, edit, and run code from your terminal** — The page describes Codex CLI as a terminal tool for repository work. It is the broad product introduction.
2. **Work against your local repository** — The CLI works in a local checkout and uses installed tools. This is the local-machine execution model.
3. **Stay in control** — Model, effort, permissions, and commands can be selected. The docs do not promise a provider spend cap here.
4. **Compose with scripts and CI** — The CLI can be used interactively or scripted for repeatable workflows. This is a capability summary.
5. **Get started with Codex CLI** — The page directs users to install, authenticate, and submit a prompt. Auth options are covered separately.
6. **Install Codex** — macOS/Linux standalone and Homebrew/npm options are shown. Installation detail is not a capability guarantee for all operating systems.
7. **Run Codex and sign in** — Initial use can sign in with ChatGPT or another available method. Authentication determines product access.
8. **Start your first task** — A user can ask for explanation, a focused change, or debugging. The flow starts with a prompt in a project directory.
9. **See what Codex CLI can do** — The page groups terminal work, plugins, reviews, and workflow composition. These are product capability summaries.
10. **Keep the coding loop in your terminal** — Interactive sessions support exploration, edits, commands, and in-session steering. This is not headless-mode evidence by itself.
11. **Use skills and plugins** — Skills and plugins add repeatable instructions and tool integrations. Installed plugin behavior depends on configuration.
12. **Review changes before they ship** — Dedicated review modes inspect uncommitted work, commits, or branches and report findings without editing. Review is distinct from acceptance/merge.
13. **Build a terminal workflow around Codex** — The page lists resumption, visual context, subagents, search, cloud handoff, MCP, permission controls, and completions. It describes multiple workflow surfaces.
14. **Return to a saved chat** — `codex resume` reopens recent or older local chats. This supports continuity in the interactive CLI.
15. **Bring visual context into the prompt** — Images can be supplied with `--image` or pasted into the composer. This is an input capability.
16. **Split up a larger investigation** — Subagents can take focused investigation tasks. The page does not promise a specific swarm coordination protocol.
17. **Search for current context** — `codex --search` can use live web search. Search activity appears in the transcript.
18. **Move work to Codex cloud** — A cloud chat can be launched and later applied locally. This is a separate execution surface.
19. **Connect external tools with MCP** — The CLI can add and inspect MCP servers. Authentication may be required.
20. **Set the boundaries for each run** — Permissions and sandbox/writable roots can be inspected and selected. This is the relevant safety control for automation.
21. **Fit Codex to your terminal** — Completion and editor configuration customize the terminal experience. These are usability features.
22. **Use Codex CLI when…** — Suggested use cases include local terminal work, CI, review, and cloud delegation. It distinguishes local execution from cloud sessions.
23. **You work from the terminal** — The interactive local loop is a suitable case. This recommendation does not describe `codex exec` flags.
24. **You need scripting or CI** — Noninteractive CLI invocation is recommended for repeatable workflows. Detailed behavior is in the supplied noninteractive-mode source.
25. **You want a local code review** — The CLI can review local changes before shipping. Review output is not a merge verdict.
26. **You want to hand work to the cloud** — Cloud handoff can continue work outside the local terminal. It is not local headless execution.
27. **Other ChatGPT and Codex surfaces** — Desktop, web, IDE, and Codex Cloud are separately available. Their runtime and auth behavior should not be conflated.
28. **Desktop app** — The desktop app is a distinct Codex surface. This page provides no additional run-budget fact for it.
29. **ChatGPT web** — The browser is another product surface. It is separate from CLI automation.
30. **IDE extension** — The extension integrates Codex into an IDE. It is not the `codex exec` interface.
31. **Codex Cloud** — Cloud runs are a distinct hosted surface. The page does not establish local CLI cost caps.
## What it means for Concord v3
This page confirms Codex CLI as an agent backend and describes local automation at a high level, but the specific noninteractive flags and sandbox defaults are better supported by the supplied `codex exec` page. It does not confirm a CLI spend cap; keep section 11’s `Not found (UNVERIFIED)` wording, and explicitly say the supplied docs establish no native spend-cap flag.

# Non-interactive mode - ChatGPT Learn
URL: https://learn.chatgpt.com/docs/non-interactive-mode
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://learn.chatgpt.com/docs/non-interactive-mode' -o "$DELEGATE_SCRATCH_DIR/raw/20.html"`
Raw SHA-256: 631cae6eae744f21df05f24c29d79481060229abde0e9222f5d268967362c1a5
Extracted words: 2076 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/20.txt"`)
Read status: read in full
## Sections
1. **Non-interactive mode** — `codex exec` runs without the interactive TUI and is designed for automation. It streams progress to stderr and the final message to stdout.
2. **When to use codex exec** — CI pipelines, piped output, and explicit sandbox/approval settings are named use cases. This is the strongest supplied source for Codex headless use.
3. **Basic usage** — A prompt argument runs a task; piped stdin can be supplied as additional context. `--ephemeral` avoids persisting rollout files.
4. **Permissions and safety** — The default sandbox is read-only; `workspace-write` enables edits and `danger-full-access` gives broader access. `--full-auto` is unsupported and should not appear in current recommendations.
5. **Make output machine-readable** — JSON Lines exposes thread, turn, item, command, and failure events. Output files and schemas support machine consumption.
6. **Create structured outputs with a schema** — `--output-schema` constrains the final response shape. This applies to output structure rather than work correctness.
7. **Authenticate in automation** — Saved auth can be reused; API credentials should be scoped to the invocation and not exposed to untrusted code. The GitHub Action uses a proxy to reduce secret exposure.
8. **Use API key auth** — `CODEX_API_KEY` is supported for scripted runs, with warning not to share process environment with untrusted code. It is usage-based authentication.
9. **Resume a non-interactive session** — A later invocation can resume the last or a named session. Session continuity is available across stages.
10. **Git repository required** — Codex checks that the current directory is a Git repository, with an override for trusted environments. The guard is a safety check, not sandbox isolation.
11. **Common automation patterns** — The page describes a CI auto-fix workflow with read-only source access and a separate PR-opening job. It recommends artifacting a patch between privilege-separated jobs.
12. **Example: Autofix CI failures in GitHub Actions** — The example uses `openai/codex-action`, read permissions, and a separate privileged PR job. The API key does not enter the PR-opening job.
13. **Advanced stdin piping** — Prompt-plus-stdin passes data as context, while `codex exec -` uses stdin as the whole prompt. This is a command-line interface distinction.
14. **Use prompt-plus-stdin** — Known instructions can be kept separate from piped logs or command output. It is useful for deterministic automation.
15. **Summarize logs** — A shell command can pipe a bounded log tail as context and ask for a summary. This demonstrates prompt-plus-stdin.
16. **Inspect TLS or HTTP issues** — Curl output can be piped to Codex for diagnosis. It is an example pattern, not a network-control feature.
17. **Prepare a Slack-ready update** — CLI output can be transformed into a concise update and copied onward. The page’s example is a workflow recipe.
18. **Draft a pull request comment from CI logs** — CI output can be turned into a draft comment through a pipe. This example does not itself authorize publication.
19. **Use `codex exec -` when stdin is the prompt** — The dash sentinel reads the full prompt from stdin. Dynamic scripts can generate that prompt.
## What it means for Concord v3
Confirms `codex exec --json` as a headless backend, default read-only sandbox, and explicit workspace-write option. It documents no cost-reporting field or spend cap in this page; section 11 should say broker-enforced process stop is Concord behavior and native Codex spend cap is unverified/not documented in the sources read.

# Authentication - ChatGPT Learn
URL: https://learn.chatgpt.com/docs/auth
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://learn.chatgpt.com/docs/auth' -o "$DELEGATE_SCRATCH_DIR/raw/21.html"`
Raw SHA-256: fb23a0224c3dc4e92b6f73d34137a1e4e7c3449a2823986daddb98ddb1f145e0
Extracted words: 2015 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/21.txt"`)
Read status: read in full
## Sections
1. **Authentication** — Codex clients support user or API-based authentication, with behavior varying by surface. Workspace policy and billing follow the selected identity.
2. **OpenAI authentication** — ChatGPT login and API key are the two local Codex paths; Codex Cloud requires ChatGPT login. Auth also selects governance and data policies.
3. **Sign in with ChatGPT** — Work Cloud and managed workspace access require eligible settings. This is not equivalent to API-key automation.
4. **ChatGPT web** — The browser keeps an authenticated session in the browser. This is not a headless CLI flow.
5. **ChatGPT desktop app** — Desktop sign-in uses browser handoff and may use either ChatGPT or API credentials. It is a local client surface.
6. **Codex CLI** — `codex login` launches the browser flow by default. The CLI also supports API key and device-code alternatives.
7. **IDE extension** — The extension supports both ChatGPT and API key sign-in. It shares the local credential cache with CLI.
8. **Sign in with an API key** — API-key use is billed at standard API rates and may lack ChatGPT workspace/cloud capabilities. It is recommended for programmatic CLI workflows, with public/untrusted execution cautions.
9. **ChatGPT desktop app** — The app accepts an API key through its alternate sign-in path. This is separate from subscription auth.
10. **Codex CLI** — The API key can be piped into `codex login --with-api-key`. The workflow is suitable for trusted automation.
11. **IDE extension** — API key entry is supported in the extension. The page does not describe run cost caps.
12. **Check authentication or sign out** — Client surfaces expose status and logout; CLI offers `codex login status`. Workload identity can restrict login/logout commands.
13. **Use Codex access tokens for enterprise automation** — Enterprise-issued access tokens support trusted noninteractive user-account workflows. They are distinct from general Platform API keys.
14. **Secure your Codex cloud account** — MFA requirements apply to Codex Cloud, with rules for social, SSO, and password logins. This is account security guidance.
15. **Login caching** — Credentials are cached and refreshed, with a local plaintext auth file possible. Treat that file as a secret.
16. **Credential storage** — Configuration chooses keyring, file, automatic, or ephemeral storage. Admin policy can enforce storage options.
17. **Enforce a login method or workspace** — Managed config can restrict ChatGPT or API auth and workspace. A mismatch logs the user out and exits.
18. **Login diagnostics** — A dedicated log assists browser/device login troubleshooting. It contains operational auth diagnostics.
19. **Custom CA bundles** — A PEM bundle can configure corporate TLS trust for login and WebSocket/API traffic. This is a networking integration detail.
20. **Login on headless devices** — Remote/headless CLI login may fail with browser callback; device code is preferred, with cache-copy and SSH-forward fallbacks. Headless auth is documented, not headless execution semantics.
21. **Preferred: Device code authentication (beta)** — Users enable device-code login and complete a browser code flow. It is beta and workspace-controlled.
22. **Fallback: Authenticate locally and copy your auth cache** — A local auth cache may be copied to a remote host, but it contains access tokens and must be protected. The method may not work with OS credential storage.
23. **Fallback: Forward the localhost callback over SSH** — Port forwarding can preserve browser authentication for a remote CLI. It uses the local callback port.
24. **Alternative model providers** — Custom providers can require OpenAI authentication, use an environment key, or require none. Provider configuration determines auth behavior.
## What it means for Concord v3
Supports Codex headless-device authentication methods and confirms API-key runs are usage-priced, while ChatGPT auth carries workspace controls. It does not establish a backend cost-reporting interface or a spend cap; section 11 should avoid implying that Codex itself enforces one.

# Overview - Cloudflare Sandboxes docs
URL: https://developers.cloudflare.com/sandbox/
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://developers.cloudflare.com/sandbox/' -o "$DELEGATE_SCRATCH_DIR/raw/22.html"`
Raw SHA-256: 6668849f11ce017cd11fd0af8a2a2c13cedc04ac64a1985bf53f096839e01fe0
Extracted words: 664 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/22.txt"`)
Read status: read in full
## Sections
1. **Sandboxes on Cloudflare** — Cloudflare describes an isolated environment for generated or untrusted code, available through a Worker. The Worker controls what application data and public Internet access the sandbox receives.
2. **Containers** — Containers run a supplied Linux image and can keep processes alive; each instance is a microVM with its own kernel and network. Durable Object scheduling is marked public beta.
3. **Dynamic Workers** — Runtime Workers execute JavaScript, Python, or WebAssembly apart from the host Worker. Access is limited to methods and data passed by the host.
4. **Concepts** — The docs separate environment choice, lifetime, and security. These concepts matter to a backend design.
5. **Choose a sandbox environment** — The choice depends on whether work needs Linux or only host-provided methods. It is a task capability decision.
6. **Sandbox lifetime** — Lifecycle depends on what keeps a Linux sandbox active and on snapshot behavior. It is not a guarantee that all instances are always warm.
7. **Sandbox security** — The sandbox can use everything placed inside it. Isolation does not remove credential/data exposure introduced by the host.
8. **Guides** — Guides cover command execution, files, previews, credentials, management, and coding agents. These are navigation pointers.
9. **Run commands** — A sandbox can execute code/tests, stream output, keep processes running, and open terminals. This supports agent execution needs.
10. **Work with files** — Files can be moved and persisted between instances or backed by R2. Persistence is configurable.
11. **Preview applications** — A browser can reach a sandbox-hosted server through a preview mechanism. The sandbox is not directly exposed by default.
12. **Credentials and network** — Credentials remain in the Worker and the sandbox’s network access is configurable. The host mediates capabilities.
13. **Manage sandboxes** — Applications can list sandboxes and record why they stop. Lifecycle tracking is application responsibility.
14. **Coding agents** — Docs explicitly cover Claude Code, Codex, and Devin inside task sandboxes. This confirms a containerized coding-agent pattern.
15. **Related products** — Workers, Durable Objects, and Workers AI are adjacent Cloudflare products. Their capabilities should not be conflated.
16. **More resources** — Links point to deployment, local dev, limits, pricing, and API references. These remain separate sources.
## What it means for Concord v3
Supports the general container-backend concept in sections 11 and 21 P4 and confirms that code/network/credentials are controlled by the host Worker. It does not establish Concord-compatible git isolation, costs, or hard spend caps; Cloudflare pricing is separately usage-based.

# @cloudflare/sandbox - Cloudflare Sandboxes docs
URL: https://developers.cloudflare.com/sandbox/reference/
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://developers.cloudflare.com/sandbox/reference/' -o "$DELEGATE_SCRATCH_DIR/raw/23.html"`
Raw SHA-256: b39e20165f9ea9663f039bf83703261ef991b0e1a674eec6c362397d141189de
Extracted words: 786 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/23.txt"`)
Read status: read in full
## Sections
1. **@cloudflare/sandbox** — The package supplies helpers for a running Durable Object container. It does not start, stop, or monitor the container itself.
2. **Install** — The package is available through npm, yarn, pnpm, and Bun. Version coordination matters for the shim.
3. **Requirements** — Images must include the matching static Linux/amd64 shim, Workers need `nodejs_compat`, and a container must be running for calls. The helper library is not the container scheduler.
4. **Example configuration** — An image, compatibility flag, Durable Object binding, and persistent `sleep infinity` process are demonstrated. Startup/timeout behavior is explicit in the example.
5. **Classes** — The reference links file, S3 mount, and backup helper APIs. These helpers do not replace the underlying container API.
## What it means for Concord v3
Confirms integration requirements and that lifecycle orchestration must be implemented around the helper package. It does not confirm a complete agent backend or pricing; section 11 should call this a sandbox substrate, not a ready-made managed agent service.

# Pricing - Cloudflare Containers docs
URL: https://developers.cloudflare.com/containers/platform/pricing/
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://developers.cloudflare.com/containers/platform/pricing/' -o "$DELEGATE_SCRATCH_DIR/raw/24.html"`
Raw SHA-256: 4cab6122dd25b1a80e71f1e2a52388defaa765517b9e375db6ecb37b3db6554d
Extracted words: 432 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/24.txt"`)
Read status: read in full
## Sections
1. **Pricing** — Containers are usage-billed for active runtime, with included monthly Workers Paid usage. Charges are not a fixed monthly VPS fee.
2. **vCPU, Memory and Disk** — Billing rates distinguish provisioned memory/disk and active CPU, with included quotas and per-unit overage. Instance lifecycle affects total spend.
3. **Instance Types** — Several sizes trade CPU, memory, and disk capacity. The chosen type changes both available resources and costs.
4. **Network Egress** — Egress has region-dependent per-GB prices and included allowances. Network use can add a variable cost.
5. **Workers and Durable Objects Pricing** — Worker and Durable Object use is billed in addition to container resources. The listed container rates are not the entire service bill.
6. **Logs and Observability** — Container logs use Workers Logs pricing. Observability settings can expose the same logs in multiple dashboard views.
## What it means for Concord v3
Corrects any implication that a container backend has fixed cost or zero idle cost without qualifications. Cite the current price table and include Worker, Durable Object, egress, and logs; this page gives no agent-model spend cap.

# Running containers | Docker Docs
URL: https://docs.docker.com/engine/containers/run/
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --max-time 45 -sS -w 'HTTP %{http_code} bytes %{size_download}\n' 'https://docs.docker.com/engine/containers/run/' -o "$DELEGATE_SCRATCH_DIR/raw/25.html"`
Raw SHA-256: bc98ea94aaf8910328626d32fb5c44cf8d8fe948a81afd0253d570aa62fe1670
Extracted words: 9018 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/25.txt"`)
Read status: read in full
## Sections
1. **Running containers** — `docker run` starts an isolated process with its own filesystem, network, and process tree. Isolation properties depend on runtime configuration.
2. **General form** — The command supplies options, an image, and optional command/arguments. The image reference is required.
3. **Image references** — A tag selects a version, defaulting to `latest` when absent. Version selection is available at start.
4. **Image digests** — Content-addressable digests identify image content. Digest pinning can make image choice reproducible.
5. **Options** — Options configure identity, detach mode, resources, and networking. Runtime controls are explicit.
6. **Commands and arguments** — Positional command/arguments override or supplement the image process. Interactive shells use `-i` and `-t` where needed.
7. **Foreground and background** — Containers run foreground by default; `-d` detaches them, and logs/attach can inspect them later. This confirms detached container operation.
8. **Container identification** — Containers have IDs or names distinct from image references. Names can support network addressing.
9. **Container networking** — Containers have outbound networking by default and can join custom networks. Network restrictions are not automatic.
10. **Filesystem mounts** — Container layers are ephemeral; mounts enable persistence and host sharing. Mount types have different security implications.
11. **Volume mounts** — Named volumes persist after container removal and can be reused. Targets are absolute paths.
12. **Bind mounts** — Bind mounts expose daemon-host paths, are read-write by default, and reflect edits on the host. They therefore create a direct host-file boundary.
13. **Exit status** — Exit codes distinguish Docker/command launch failures from process exit results. The caller can inspect the process outcome.
14. **125** — Code 125 indicates a Docker daemon/CLI-side error. The example is an invalid option.
15. **126** — Code 126 indicates the selected container command could not be invoked. The example command exists but is not executable as invoked.
16. **127** — Code 127 indicates the container command could not be found. The example uses a nonexistent command.
17. **Other exit codes** — Other codes are the invoked command’s exit code. A wrapper can propagate task status.
18. **Runtime constraints on resources** — Docker exposes memory, CPU, I/O, and related limits. Many defaults are unlimited or relative rather than strict ceilings.
19. **User memory constraints** — Hard memory and swap combinations have distinct semantics, while reservation is soft. Disabling OOM kill without a hard cap can endanger the host.
20. **Swappiness constraint** — Per-container swappiness controls anonymous-page swapping. It is a kernel behavior setting.
21. **CPU share constraint** — CPU shares are relative weights under contention, not a fixed CPU quota. Idle capacity can be used by other containers.
22. **CPU period constraint** — CPU period and quota can limit a container’s CPU time. Fractional `--cpus` can express a similar limit.
23. **Cpuset constraint** — CPU and NUMA memory-node sets constrain where processes execute. These are placement restrictions.
24. **CPU quota constraint** — CPU quota limits a container to a specified share of CPU resources. Zero means no limit in the described default.
25. **Block IO bandwidth (Blkio) constraint** — Weight-based I/O is relative; device rate and IOPS flags provide per-device limits. Buffered I/O is not covered by the weight setting.
26. **Additional groups** — `--group-add` adds supplementary groups to the container process. Group membership affects access.
27. **Runtime privilege and Linux capabilities** — Containers are unprivileged by default, but `--privileged` grants broad host-like capabilities and device access. Specific devices/capabilities can be granted more narrowly.
28. **Overriding image defaults** — Runtime flags can override image defaults. The following subsections cover command, entrypoint, ports, environment, health, user, and workdir.
29. **Default command and options** — The runtime command can override Dockerfile `CMD` or become arguments to `ENTRYPOINT`. Command composition depends on the image.
30. **Default entrypoint** — `--entrypoint` replaces the configured executable and clears the default command. It should be treated as an explicit process override.
31. **Exposed ports** — Ports are not host-accessible unless published with `-P` or `-p`. Internal and external port numbers can differ.
32. **Environment variables** — Docker sets platform variables and passes explicit `-e` values; omitted values may be inherited from the host. Environment injection can expose credentials.
33. **Healthchecks** — Health flags configure command, intervals, retries, timeout, and startup grace. Health status is observable through container inspection.
34. **User** — Root is the default process user unless image/runtime settings change it. `-u` can select a user or numeric identity.
35. **Working directory** — `-w` overrides image workdir and creates a missing directory. This provides predictable task placement.
## What it means for Concord v3
Confirms detached containers, resource-limit mechanisms, and process exit reporting, but also shows defaults can be permissive: outbound networking is on, bind mounts are writable, and root is the default. Section 11 should say Docker is an execution substrate whose isolation, network, filesystem, and resource limits Concord must configure; Docker documentation supplies no agent-model cost cap.

# Concord v3 Architecture
URL: file:///Users/sebastianpatronsoto/Documents/Claude/for-seb/concord-v3-architecture.html
Fetched: 2026-10-15 20:04 UTC; method: `cp '/Users/sebastianpatronsoto/Documents/Claude/for-seb/concord-v3-architecture.html' "$DELEGATE_SCRATCH_DIR/raw/26-v3-draft.html"`
Raw SHA-256: 02fe429cebfe4be735aa7b1ecf4034bf25b078bf2a8765ee7134151ec36fc0a0
Extracted words: 6576 (`wc -w "$DELEGATE_SCRATCH_DIR/raw/26-v3-draft.txt"`)
Read status: read in full
## Sections
1. **Concord v3 Architecture** — Draft 4 describes Concord as an agent-first forge where server-side changes replace pull requests. It says five spikes are finished, a claim needing separate verification.
2. **1 Summary** — The summary proposes changes, claims, issue readiness, runs, event delivery, and a one-server VPS. Its assertions depend on multiple spikes and platform sources.
3. **2 Requirements** — Requirements enumerate simultaneous agents, zero idle cost, bounded reads, server-only main writes, swarms, dependencies, uniform interfaces, owner control, and portability. These are owner/product requirements, not proven source findings.
4. **3 What v3 fixes** — The table reports measured v2 polling, state, queue, and concurrency problems. It is separate empirical evidence and does not derive from the present source set.
5. **4 System context** — Agents, humans, runners, backends, and a GitHub mirror surround a central server. This is proposed architecture.
6. **5 Components** — A repo actor, operations, issues, dispatcher, runners, and mirror divide responsibilities. This is a design diagram and component table.
7. **6 Data model** — Tables represent changes, claims, issues, runs, jobs, reviews, and events with retention. Derived blocker counts are updated at write time.
8. **7 Changes** — A change is a server object whose commit is made by the server, with reviews tied to revisions. This is framed as following Scion.
9. **8 Land process SP-B** — The flow merges onto main, checks, compare-and-swaps, and later batches full-suite results. Prototype figures are explicitly local and synthetic.
10. **Default policy** — Fast checks precede land; full suite follows in a batch. The claim is attributed to SP-B, outside this task’s source set.
11. **Policy "strict"** — A repository can opt to run full tests on a speculative stack before land. The throughput tradeoff is a design option.
12. **9 Claims** — Claims show presence by default and exclusive paths by policy; function units may widen. The Cursor evidence is cited nearby but concerns a different lock subject.
13. **10 Issues and dependencies SP-D** — The draft proposes blockers, parent grouping, open-blocker counts, cycle rejection, text-to-edge proposals, and a ready set. GitHub/Linear docs support relation concepts, but not all dispatch or graph rules.
14. **11 Runs and swarms SP-D** — Runs scope tasks and impose concurrency and dollar budgets, with planner/worker/judge roles and backend adapters. This section includes provider capability and cap claims requiring precise qualification.
15. **12 Checks and runners** — A pushed runner protocol executes check profiles in containers. Docker and Cloudflare sources support substrate capabilities, not Concord’s full protocol.
16. **13 Review** — Review policy distinguishes docs, tests, ordinary code, and protected paths. Its cited source is not in this assigned set.
17. **14 API, CLI and MCP** — One operation table generates interfaces, and MCP events use streaming. Its prototype evidence is outside this run’s source set.
18. **Script tasks that become product features** — A table maps scripts to product features and removes an external launcher. This is an implementation plan.
19. **15 Events and zero idle cost SP-C** — The design uses event sequence numbers and resumable connections, and cites an idle test. This source set does not cover its benchmark.
20. **16 Security** — Tokens, principals, protected paths, secrets, and audit events are proposed controls. These are architecture claims.
21. **17 GitHub import and mirror SP-A** — Import/mirror scope includes history, issues, labels, milestones, and dependency text. GitHub issue docs support some data concepts, not this full migration process.
22. **18 Deployment SP-A** — The draft compares VPS, Fly, and local machines and proposes Bun/SQLite. These cost and runtime comparisons are outside the assigned evidence except Cloudflare container pricing.
23. **Options we rejected** — Forgejo and Cloudflare Artifacts are rejected based on separate research. The present readings do not verify the full alternatives analysis.
24. **19 Cost and budgets** — A VPS is characterized as fixed-cost, route budgets are specified, and model spending is controlled by the section 11 broker. Cloudflare’s container bill is usage-based; provider docs show differing estimates and caps.
25. **20 What we keep from v2** — The section lists reuse, rework, rebuild, and removal. These repository claims are outside the fetched source set.
26. **21 Delivery plan** — Seven phases set measurable milestones for server, checks, issue import, runs, console, and open source. Several acceptance claims depend on the disputed architecture and backend evidence.
27. **Stop the leak** — P0 deploys a fix and syncs/removes old resources, with an Artifacts-read threshold. This operational claim is outside source readings.
28. **Core server** — P1 requires ten agents, disjoint landing, queued overlaps, per-route budgets, and zero idle requests. This is an acceptance test, not demonstrated by the supplied third-party docs.
29. **Checks** — P2 promises automatic detection and revert of a bad batch without a person. Docker’s exit codes and resource limits do not validate the entire check/bisect path.
30. **Issues, dependencies and import** — P3 requires correct ready sets after importing two backlogs and a mirror. GitHub docs support dependency and hierarchy primitives, not this end-to-end import result.
31. **Runs** — P4 requires a milestone run to finish without chat, using a dispatcher, roles, broker, and BYO/container backends. Backend docs establish pieces, not this integrated behavior.
32. **Console and first move** — P5 requires no idle console requests and a week of two repos on Concord. This is a future operational test.
33. **Open source** — P6 targets a self-hosted install in 15 minutes. No supplied source measures that outcome.
34. **22 Decisions** — The decision table lists hosting, land policy, claims, backends, runtime, and first repos as open or decided. The present source review informs the backend row but does not change owner decisions.
35. **23 Glossary** — Terms define change, claim, run, ready set, backend-related session, and other domain language. Definitions are internal to the proposal.
36. **24 Sources** — The draft lists prior spikes and sources with asserted read status. The Cursor description must be corrected, and this reading run adds precise backend facts and one unread Medium source.
## What it means for Concord v3
Sections 10 and 11 need the concrete evidence-based replacements in the accompanying report. Section 19 must distinguish a fixed VPS invoice from usage-billed containers and from estimated/provider list-cost controls; section 21 P3/P4 should state that end-to-end ready-set import and no-chat milestone completion remain acceptance tests, not facts proven by the source docs.

## Backend facts confirmed by the supplied docs
- Headless: Claude CLI `-p`/`--print` supports noninteractive runs, with JSON and stream JSON; Claude SDK `query()` is programmatic. Codex supports `codex exec`, JSONL, explicit sandbox flags, and headless-device authentication. Docker `docker run -d` detaches a container. Cloudflare documents coding agents in task sandboxes.
- Cost reporting: Claude Agent SDK exposes token use, per-model usage, and `total_cost_usd`/`costUSD`, but its dollar totals are client-side estimates; Codex pages supplied here do not document a run-cost reporting field. Managed Agents emits cumulative session usage/list-cost events. Cloudflare and Docker pages describe infrastructure/runtime billing, not model token costs.
- Spend caps: Claude CLI `--max-budget-usd` is based on client-side estimates and can overshoot; SDK `maxBudgetUsd` is query-local and may omit restored spend. Managed Agents session budgets hard-stop new model requests at public list cost, while an in-flight request may finish past the cap; budgets are creation-time. The supplied Codex docs do not confirm a native spend cap. Concord’s shared broker and run cap are proposed product behavior, not a provider fact.

## Complete source inventory
| URL | Extracted words (`wc -w` on extracted text) | Read status |
|---|---:|---|
| https://github.com/gastownhall/gastown/blob/main/README.md | 4192 | read in full |
| https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04 | 123 | NOT READ (403 block page; article unavailable) |
| https://cursor.com/blog/scaling-agents | 1179 | read in full |
| https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies | 514 | read in full |
| https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2022-11-28 | 2840 | read in full |
| https://docs.github.com/en/enterprise-cloud%40latest/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues?apiVersion=2022-11-28 | 480 | read in full |
| https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues | 856 | read in full |
| https://linear.app/docs/parent-and-sub-issues | 856 | read in full |
| https://linear.app/docs/project-dependencies | 447 | read in full |
| https://linear.app/changelog/2020-03-04 | 385 | read in full |
| https://code.claude.com/docs/en/agent-sdk/overview | 840 | read in full |
| https://code.claude.com/docs/en/agent-sdk/quickstart | 2010 | read in full |
| https://code.claude.com/docs/en/agent-sdk/cost-tracking | 3808 | read in full |
| https://code.claude.com/docs/en/cli-reference | 5709 | read in full |
| https://code.claude.com/docs/en/headless | 4779 | read in full |
| https://platform.claude.com/docs/en/managed-agents/reference | 1516 | read in full |
| https://platform.claude.com/docs/en/managed-agents/sessions | 1979 | read in full |
| https://platform.claude.com/docs/en/managed-agents/secure-deployment | 4677 | read in full |
| https://developers.openai.com/codex/cli | 1017 | read in full |
| https://learn.chatgpt.com/docs/non-interactive-mode | 2076 | read in full |
| https://learn.chatgpt.com/docs/auth | 2015 | read in full |
| https://developers.cloudflare.com/sandbox/ | 664 | read in full |
| https://developers.cloudflare.com/sandbox/reference/ | 786 | read in full |
| https://developers.cloudflare.com/containers/platform/pricing/ | 432 | read in full |
| https://docs.docker.com/engine/containers/run/ | 9018 | read in full |
| file:///Users/sebastianpatronsoto/Documents/Claude/for-seb/concord-v3-architecture.html | 6576 | read in full |



