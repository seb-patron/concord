# Concord implementation slices

The twelve specs implement a small agent-native git platform, not production GitHub parity. Each has one user-observable behavior, a 45–90 minute implementation budget, literal file ownership, acceptance cases, and a commit message. Read [architecture contract v1](../ARCHITECTURE.md), [the demo](../DEMO.md), and [the judging map](../JUDGING.md) before dispatch. This documentation run implements none of the slices.

## Scope and deadline interpretation

The supplied weekday/date labels conflict with the 2026 calendar: October 11 is Sunday and October 14 is Wednesday. Keep the supplied final submission instant, **10-14 at 11:59 pm PDT** (Thursday October 15 at 1:59 am CT / 06:59 UTC), often labelled “Tue 10-14 11:59 pm PDT” in the brief; the owner verifies the competition form before uploading. The working integration deadline is **Monday October 12, 2026 at 6:00 pm CT**. Tuesday October 13 is reserved for rehearsal, recording, and bounded fixes, with October 14 contingency before the submission instant. The finalist date is October 21.

With six implementation workers plus one independent reviewer and one integrator/owner slot, the scoped build is approximately 15 worker-hours plus integration, review, repair, and filming across three days. Budgets are estimates, not a promise about agent throughput. Keep leases + queue + UI even when applying cuts. Missing Cloudflare access blocks deployed evidence, not local development; the owner begins provisioning alongside 01 and supplies account access by Sunday noon CT at the latest.

## Slice index

| Slice | One behavior / acceptance result | Worker | Budget | Code dependencies | Integrated acceptance dependencies |
| --- | --- | --- | --- | --- | --- |
| [01 Platform](01-platform-skeleton.md) | Authenticated local request reaches durable state; real typecheck/test gate | Codex gpt-6-sol | 90m | None | None |
| [02 Repos and changes](02-repos-and-changes.md) | Publish an immutable candidate in an owned fork | Codex gpt-6-sol | 90m | 01 | 05 inspection hook |
| [03 Semantic leases](03-semantic-leases.md) | Atomic overlap refusal with fenced lifetime | Codex gpt-6-sol | 75m | 01 | 02, 04 |
| [04 Merge queue](04-merge-queue.md) | Checked stack becomes canonical, with bounded isolation | Codex gpt-6-sol | 90m | 01 | 02, 03, 05, 06, 07 |
| [05 Checker runners](05-checker-runners.md) | Fenced local job returns exact-input evidence | Codex gpt-6-sol | 90m | 01 | 02, 04, 07 |
| [06 Findings ledger](06-findings-ledger.md) | One reviewed repair clears the entire findings round | Codex gpt-6-luna | 60m | 01 | 02, 07 |
| [07 Verdict carry](07-verdict-carry.md) | Carry only an unchanged, delta-checked review scope | Codex gpt-6-sol | 75m | 01 | 02, 05, 06 |
| [08 Web UI](08-web-ui.md) | Show fleet state, blockers, and next actions | Codex gpt-6-luna or Muse | 90m | 01 | 02–07 |
| [09 Agent CLI](09-agent-cli.md) | Drive the lifecycle with stable machine-readable output | Codex gpt-6-luna | 75m | 01 | 02–07 |
| [10 AW mock](10-aw-mock-adapter.md) | One launcher task maps to one change across retries | Codex gpt-6-luna or Muse | 45m | 01, 09 | 02–07 |
| [11 Replay](11-replay-harness.md) | Produce only provenance-supported comparisons | Codex gpt-6-luna | 60m | 01 | 04 when reusing pure planning logic; owner export for real baseline |
| [12 Demo/deploy](12-demo-and-deploy.md) | Reproduce the submission through one scenario driver | Codex gpt-6-sol | 90m | 01–11 | Owner account for cloud; owner remote/grant for mirror |

Worker names are caller-requested placement preferences. They are not claims about model availability or authority to spend. Use only a launcher-authorized worker/profile; if unavailable, report it rather than silently switching models or providers. Muse is optional for the two bounded presentation/adapter tasks, not for policy, review, or acceptance.

## Dependency graph and parallel dispatch

Solid arrows below mean code must land before the dependent worker starts. Dashed edges mean final integration needs the real behavior, but unit work proceeds against 01's frozen typed hooks. Cycles in the dashed subgraph are service interactions, not an impossible launch order.

```mermaid
flowchart TD
  S01[01 Platform + contracts] --> S02[02 Repos]
  S01 --> S03[03 Leases]
  S01 --> S04[04 Queue]
  S01 --> S05[05 Runners]
  S01 --> S06[06 Findings]
  S01 --> S07[07 Verdicts]
  S01 --> S08[08 UI]
  S01 --> S09[09 CLI]
  S01 --> S11[11 Replay]
  S09 --> S10[10 AW mock]
  S02 -.-> S04
  S03 -.-> S04
  S05 -.-> S04
  S06 -.-> S04
  S07 -.-> S04
  S02 -.-> S05
  S05 -.-> S07
  S06 -.-> S07
  S04 -.-> S08
  S04 -.-> S11
  S02 --> S12[12 Demo + deployment package]
  S03 --> S12
  S04 --> S12
  S05 --> S12
  S06 --> S12
  S07 --> S12
  S08 --> S12
  S09 --> S12
  S10 --> S12
  S11 --> S12
```

At most six implementation runs execute together. First run 01 alone and accept its contracts/gate. Then launch 02/03/04/05/06/11 together. Launch 07/08/09 when those slots free; 07 may use the finished findings helper while its runner seam is tested independently. Launch 10 after 09. Launch 12 only on the integrated, independently reviewed local candidate. “Unit tests pass against fakes” is not the same as integrated acceptance.

## File ownership and integration rules

Each slice's Allowed files is authoritative and literal: no globs, whole-directory grants, or implicit permission to change package/config files. The future implementation allowlists do not expand this documentation run's permissions. Feature workers may read any public contract/dependency but only write their own listed paths. Shared-file exceptions are deliberately ordered:

| Shared path(s) | Writers / order | Reason |
| --- | --- | --- |
| `src/features/repos.ts`, `src/storage/artifacts.ts`, `src/storage/bridge.ts` | 01 placeholders, then 02 | Provider/repo behavior replaces a prewired shell |
| `src/features/leases.ts` | 01, then 03 | Lease module replaces unavailable shell |
| `src/features/queue.ts` | 01, then 04 | Queue module replaces unavailable shell |
| `src/features/runners.ts` | 01, then 05 | Runner module replaces unavailable shell |
| `src/features/findings.ts` | 01, then 06 | Ledger module replaces unavailable shell |
| `src/features/verdicts.ts` | 01, then 07 | Verdict module replaces unavailable shell |
| `web/index.html`, `web/app.js`, `web/styles.css` | 01 placeholders, then 08 | Existing assets binding needs a local initial directory |
| `wrangler.jsonc` | 01, then 12 | Final deployment configuration after local integration |
| `docs/DEMO.md`, `README.md` | This design run, then 12 | Reconcile proposed commands with implemented behavior |

Everything else in the twelve implementation allowlists is single-owner. Only 01 owns package.json, package-lock.json, test config, shared types, main worker/DO shell, and scripts/validate.sh. Predeclare runtime commands, dependencies, import registration, all tests/node and tests/workers globs, and feature migrations there. Later modules must not modify those shared files merely to register themselves.

Contract freeze includes errors, role identities, revision/idempotency semantics, promotion freeze, module migrations/timers/projections, RepoStorage, job/result kinds, and these internal hooks: repos.inspectRevision; leases.reserve/releaseReservation; findings.gate; verdicts.gate/evaluateCarry; queue.onResult; runners.schedule. Placeholders fail closed. Reusable pure helpers cannot import cloudflare:workers into the CLI/runner. Slice 05 and 07 share manifest semantics through the frozen contract and compare canonical-digest golden fixtures in their own tests; if they need to share implementation, 05 may read 07's pure helper after integration without editing it.

If an interface repair requires a file outside a slice's allowlist, stop that worker and give the integrator the exact proposed change. The owner/launcher must issue a separate bounded repair spec with literal files; this index does not grant ad hoc shared edits. Serialize those repairs before dependent launch or acceptance. An implementing worker never accepts its own slice. Independent review examines exact candidate changes; owner/integrator handles integration and final acceptance.

## Hour-by-hour plan (America/Chicago)

All times are in CDT (UTC−05:00). The supplied “Sat 10-11 12:45 am CT” start means Saturday night into Sunday, October 11 at 00:45 CDT on the 2026 calendar; slice 01 has already started then. The workers run overnight. The first wave starts as soon as 01 merges, and later waves start when dependencies and slots clear. Owner-only account and publication gates remain explicit; the integrator/reviewer can work alongside the six worker slots. Each implementation run gets its listed 45–90 minute budget; repairs use explicit bounded scopes.

| Date / hour | Six-worker lane / integrator | Owner/reviewer evidence or gate |
| --- | --- | --- |
| Sun 10-11 00:45–02:15 | 01 already running; finish contracts, fake, and fresh-worktree gate | Review 01's offline startup and fail-closed seams immediately on candidate |
| Sun 10-11 02:15–03:15 | On 01 merge, launch 02/03/04/05/06/11 in all six slots | Independently confirm 01's contract and real validation gate; do not dispatch against a failing base |
| Sun 10-11 03:15–04:15 | First wave continues; integrate completed 06/11 as slots clear | Review lease atomicity, repo bootstrap and runner protocol evidence |
| Sun 10-11 04:15–05:15 | Launch 07/08/09 immediately into free slots; integrate first wave | Exercise fake-backed admission and local Git bridge; register bounded repairs |
| Sun 10-11 05:15–06:15 | Continue 07/08/09; launch 10 once 09 lands | Review carry manifest/dependency cases and real API UI/CLI flow |
| Sun 10-11 06:15–07:15 | Finish 10; begin 12 as soon as 01–11 integration is accepted | Check seven-retry dedupe and evidence provenance |
| Sun 10-11 07:15–08:15 | 12 packages local scenario, checker cases, and deployment runbook | Run fixture through actual processes and reject fabricated greens |
| Sun 10-11 08:15–09:15 | Bounded integration repairs in owning files | Fresh review of repaired candidates and local full gate |
| Sun 10-11 09:15–10:15 | First full local rehearsal; list demonstrated failures | Verify lease refusal, checker queue, UI, and safe negative case |
| Sun 10-11 10:15–11:15 | Repair highest-priority local failures | Owner completes account/Artifacts access; prepare disposable namespace |
| Sun 10-11 11:15–12:00 | Run early live create/empty-fork/first-push gate immediately when account exists | **Owner account by noon CT latest**; if empty fork fails, seed a separate repo, push first commit, then fork it |
| Sun 10-11 12:00–13:00 | Adapt only the documented bootstrap fallback if smoke requires it | Record live responses/OIDs; escalate failure of seeded fork or first push |
| Sun 10-11 13:00–14:00 | Resume local/cloud integration and bounded repairs | Confirm token scopes and conditional stale-push behavior |
| Sun 10-11 14:00–15:00 | Deploy accepted candidate if separately authorized | Verify actual backend badge, checked landing SHA, and rollback path |
| Sun 10-11 15:00–16:00 | Real API UI/CLI rehearsal and restart/retry cases | Confirm no self-approval, stale carry, or unresolved-finding landing |
| Sun 10-11 16:00–17:00 | Optional mirror dry run and local resilience checks | Verify one-way source SHA equality; cut mirror execution if grant absent |
| Sun 10-11 17:00–18:00 | Full nine-minute local/cloud rehearsal; capture defects | Reduce narration/extras if over ten minutes |
| Mon 10-12 09:00–10:00 | Repair only demonstrated failures; rerun affected checks | Independent review of repair diff and integration state |
| Mon 10-12 10:00–11:00 | Repeat remote smoke on deploy and verify checked promotion | Record provider URL, immutable SHA, token isolation and stale rejection |
| Mon 10-12 11:00–12:00 | Clean-clone runbook rehearsal | Check fresh `scripts/validate.sh` install and real scenario commands |
| Mon 10-12 12:00–13:00 | Replay validator and optional report wiring | Owner supplies sanitized timeline export if approved; missing provenance remains unavailable |
| Mon 10-12 13:00–14:00 | Full local/cloud timed rehearsal | Confirm real failure and survivor landing appear on screen |
| Mon 10-12 14:00–15:00 | Last bounded seam repairs | Reviewer checks exact candidate and reruns final local gate |
| Mon 10-12 15:00–16:00 | Freeze feature scope, inspect redacted manifest | Confirm known limitations and account/deployment evidence |
| Mon 10-12 16:00–17:00 | Backup run and independent end-to-end runbook check | Resolve evidence gaps before freeze |
| Mon 10-12 17:00–18:00 | **Finish integration by 6 pm CT** and hand off recording candidate | Preserve immutable candidate SHA and review results |
| Mon 10-12 18:00–21:00 | Optional first recording pass on frozen candidate | Owner may defer capture to Tuesday; no feature work |
| Tue 10-13 09:00–10:00 | Reconfirm frozen deployment and clean-clone instructions | Final timeline decision: approved export or explicit unavailable panel |
| Tue 10-13 10:00–12:00 | Capture scenes 0–9 and deployed Artifacts proof | Keep backend mode, job input hashes, and canonical SHA visible |
| Tue 10-13 12:00–14:00 | Assemble and trim nine-minute video | Rights/redaction check; default decomp-only numbers and anonymized names |
| Tue 10-13 14:00–16:00 | Independent recording review; bounded re-record if needed | Match video, deployment, and reviewed commit; no new features |
| Tue 10-13 16:00–18:00 | Owner prepares submission bundle and verifies form | Tuesday remains rehearsal/recording reserve; supplied 10-14 11:59 pm PDT deadline is unchanged |

## Cut list

These are already scoped cuts, not hidden acceptance exceptions. If the build slips, apply the optional cuts in order and state them in the UI/video. Do not weaken safety invariants to preserve a feature count.

| Order / status | Cut | Keep |
| --- | --- | --- |
| Already cut | Full GitHub parity: issues/projects/search/notifications, public signup, OAuth, organizations, multiple protected canonical branches | Repo/branch Git hosting, changes, independent review, merge, basic web UI, CLI |
| Already cut | General C/TypeScript semantic extraction and arbitrary shared-header rewriting | Explicit registered units, declaration identities, coarse file fallback, one trusted TSV row merger |
| Already cut | Automatic lease waiting/priorities and large speculative search | Immediate informative refusal, fencing, width-4 stack, diagnostic budget, safe interaction block |
| Already cut | Statistical flake model, flaky-test auto-waivers, production runner sandbox orchestration | Distinct environment failures, one diagnostic retry, disagreement blocks landing |
| Already cut | Production AW migration and live private-project source | Public fixture shim with stable intent dedupe; no modification of launcher |
| Optional cut 1 | Historical before/after segment if export/provenance is late | Harness validates input; unavailable-data output; owner-reported context correctly labelled |
| Optional cut 2 | GitHub mirror execution if credentials/destination are late | Dry-run tool and runbook; Artifacts remains authoritative |
| Optional cut 3 | Contest in the filmed narrative if time is tight | Queue hard acceptance and first-green policy; score arbitration still covered by local tests |
| Optional cut 4 | Extra animation/polish, WebSockets, graphs beyond simple HTML/SVG | Accessible UI, blocker reasons, lease/queue/findings/verdict evidence |
| Mandatory escalation | Cloud account or essential Artifacts Git capability still unavailable | Local build and recordings remain useful; owner must resolve platform/submission gate. Never claim fake storage meets it. |

The immutable core is semantic overlap refusal, real checker-backed speculative queue with safe failure handling, and a usable UI. Findings and conservative carry stay small, with unknown cases requiring review. If even this core cannot be delivered with the scheduled repair reserves, stop feature work and report a reduced demo proposal to the owner rather than improvising weaker correctness.

## Validation and handoff

The current documentation gate is `sh scripts/validate.sh`; it only checks the design-phase repository and cannot prove an implementation. Slice 01 replaces it with a fresh-checkout `npm ci --no-audit --no-fund` bootstrap when node_modules is absent, then typecheck plus tests; every later slice lists that real gate alongside its targeted test command. Targeted tests are run during work; run the full configured gate once on the final candidate. No cloud credential is required for that gate. The early account-time Artifacts create/first-push/fork smoke and slice 12's deployed smoke are separate prerequisites, never silently skipped green tests.

Each worker leaves a report with changed files, concrete acceptance evidence, actual command output, separate-review availability, and unimplemented/deferred paths. The launcher creates/publishes candidates under its own rules. The integrator reviews exact candidates and the owner merges. A green worker report alone does not establish acceptance or competition readiness.
