# Concord v3 platform and hosting spike (SP-A)

**Research date:** 2026-10-15. **Scale used:** 10 repositories, 20 concurrent agents, 300 changes/day, peak ~2,000 agent API calls/hour. **Scope:** platform and hosting recommendation; no product changes.

## Recommendation

Extend **Forgejo** and build the agent coordination service beside it. Do not build a forge from scratch. Forgejo supplies Git hosting, issue/milestone UI and APIs, Actions, webhooks, a server-side PR merge API, and its AGit `refs/for/...` push flow; the missing semantics are specifically Concord’s agent claims, leases, changesets, review/verdict policy, human controls, swarm scheduling, and live state. Keep those in an agent-neutral service with HTTP API, CLI and MCP. Do not make a private Forgejo fork the integration point: call its documented API and Git protocol.

Host the forge and coordination database on a **small always-on VPS**, sized initially at Hetzner CPX42 (8 vCPU, 16 GB RAM, 320 GB NVMe; $81.99/month in EU locations before VAT, IPv4 extra/unspecified in this estimate); keep untrusted CI runners isolated and separately scalable, initially on existing owner-controlled machines or short-lived workers. Put encrypted, versioned backups off-node and exercise restores. Add Cloudflare Tunnel/edge only where useful for ingress. This is a pragmatic launch baseline, not a claim that one node is highly available. At this size the idle compute is affordable, but not zero. Revisit a hybrid/cloud-native storage design only after measuring actual repository storage, Artifacts operation counts, and agent latency.

Maintain **Forgejo as source of truth**. Configure a one-way Forgejo push mirror to each existing GitHub repo (explicitly filter to `main`, tags and release branches if those are intended; do not use unfiltered `git push --mirror`, which can force-overwrite destination refs). Restrict the GitHub token to the selected repositories’ contents and workflow permissions only when mirroring `.github/workflows`. Import Git history and, separately, migrate issues, milestones, labels, releases, LFS objects and secrets; a Git push mirror does not migrate tracker data or Actions run history. Validate a read-only comparison, freeze GitHub writes at cutover, perform final import/push, and leave GitHub read-only as a public mirror/rollback reference. GitHub writes, mirror setup and migration are future owner-approved operations, not performed in this spike.

This recommendation follows existing owner direction to use Concord as the agent-facing forge and keep GitHub as a mirror/backup (D-FORGE-ISSUES, D-NO-GITHUB-WORK, D-NO-COORDINATOR, D-LAND-VIA-CONCORD, D-HOSTING-SPIKE-LATER). It follows the research-and-compare intent in D-SPIKE-MEANS-RESEARCH; the requested v3 platform choice here is a recommendation for owner review, not a recorded owner decision.

**Top three risks:** (1) a single VPS and its operator are a single failure domain; tested offsite recovery and a documented restore/failover path are mandatory; (2) Forgejo’s feature fit is not proof that 20 concurrent, high-frequency AGit submissions and merges meet latency/correctness goals—prototype the custom coordination/merge service against real workflows; (3) CI runners execute untrusted repository code and must be isolated from forge credentials, database and host, even when they are idle or privately operated.

## Forge choice against v3 needs

“Native” means documented upstream feature/API, not that it implements Concord’s agent policy. Forgejo is preferred because of AGit flow, project governance and feature openness. Gitea is an entirely plausible MIT-licensed base if preserving a permissive upstream license outweighs Forgejo-specific fit. Both need a separately built coordination service.

| v3 need | Forgejo | Gitea | Evidence / gap |
|---|---|---|---|
| Issues with dependencies | Native issue tracker and issue dependencies; cross-repository dependencies configurable. | Native issue dependencies since 1.20; default and cross-repository behavior configurable. | Neither supplies Concord’s swarm planning, lease-aware ready queue or milestone orchestration. |
| Milestones | Native issue milestones, UI and API. | Native issue milestones, UI and API. | Suitable as basic grouping/progress; richer agent-run state belongs in coordinator. |
| Push mirror to GitHub | Native periodic/on-push push mirroring; branch filters; GitHub PAT workflow permission needed for workflow files. | Native push/pull mirrors. | Forgejo docs warn unfiltered mirror uses `git push --mirror` and overwrites remote changes. One-way only; never accept GitHub work back automatically. |
| AGit (`refs/for/main/...`) without forks | **Supported:** pushes such as `HEAD:refs/for/main/topic` create/update a PR; does not require a fork or feature branch. | **No documented built-in AGit flow found: UNVERIFIED.** Ordinary PR workflow is documented. | Forgejo’s documented AGit workflow is the clearest match for ref-based changesets; validate update/review semantics in a prototype. |
| Actions runners | Forgejo Actions plus separately run Forgejo Runner. | Gitea Actions plus separately run Gitea Runner. | CI is not executed by forge itself. Isolate runner pool; Actions compatibility has differences and unsafe public runners are a documented risk. |
| REST API coverage | Versioned `/api/v1`, documented OpenAPI/reference and many resource endpoints including issues, milestones, PR merge, repo and user operations. | Versioned `/api/v1`, generated OpenAPI; broad issues, milestones, PR and admin endpoints. | “Full HTTP API” is a v3 service requirement. Neither forge API covers Concord’s claims/fences, candidate inspection/review verdicts, force-land, pause/release or event model; add these in coordinator. A route-by-route completeness audit is **UNVERIFIED**. |
| Webhooks | Native repo, organization and system webhooks for Git and tracker events. | Native event webhooks. | Outbound event delivery is useful integration, but retry/delivery guarantees and a replayable durable event log must be checked for selected version. |
| Live events | No native, durable client event stream verified in reviewed docs; repository activity/feed is not an equivalent. **UNVERIFIED** for native SSE/WebSocket coverage. | No native, durable client event stream verified in reviewed docs. **UNVERIFIED** for native SSE/WebSocket coverage. | Coordinator should own resumable event cursor + SSE/WebSocket fanout; use webhook hooks internally if appropriate. |
| Server-side merge API | PR merge API exists; AGit submissions can be merged server-side as PRs. | PR merge API exists. | This is not the v3 merge engine: neither documents Concord’s immutable changeset model, conflict/semantic merge policy, or independent concurrent landing strategy. Coordinator must own and test these. |
| License for an MIT Concord project | Forgejo v9+ is GPL-3.0-or-later (older releases through v8 were MIT); interoperability via API/Git does not itself make Concord a derivative. Assess distribution/integration boundaries with counsel if embedding/modifying. | Gitea is MIT; upstream contribution policy requires copyright assignment, a governance/contribution consideration. | Forgejo source notes most current code is GPL and some remains MIT; do not infer the whole project remains MIT. No legal opinion. |

## Hosting comparison at the stated scale

### Measurements and assumptions

The requested clone-size check is below. `du -sh` measures each local checkout including working tree and `.git`, not just a GitHub repository’s packed objects. The top ten local clones total roughly 3.0 GiB in rounded `du` output; gen-v-decomp (1.1G) and mwcc-rs (772M) dominate. Repository mirror object stores, LFS, Actions caches, databases, backups and growth require additional headroom. Size, CPU and memory do not prove 20-agent throughput; the VPS sizing below is a starting hypothesis with build/test jobs offloaded.

Command: `du -sh /Users/sebastianpatronsoto/agent-runs/clones/*`

Raw output:

```text
9.4M  /Users/sebastianpatronsoto/agent-runs/clones/agent-review-evals
704K  /Users/sebastianpatronsoto/agent-runs/clones/agent-run-analytics
 13M  /Users/sebastianpatronsoto/agent-runs/clones/agent-workflows
2.4M  /Users/sebastianpatronsoto/agent-runs/clones/aw-29
2.5M  /Users/sebastianpatronsoto/agent-runs/clones/aw-a3
2.6M  /Users/sebastianpatronsoto/agent-runs/clones/aw-swe2
 25M  /Users/sebastianpatronsoto/agent-runs/clones/azeron-macos
 22M  /Users/sebastianpatronsoto/agent-runs/clones/azeron-windows-protocol-lab
 52M  /Users/sebastianpatronsoto/agent-runs/clones/concord
2.2M  /Users/sebastianpatronsoto/agent-runs/clones/decomp-learning
1.1G  /Users/sebastianpatronsoto/agent-runs/clones/gen-v-decomp
960M  /Users/sebastianpatronsoto/agent-runs/clones/gen-v-map-studio
 48M  /Users/sebastianpatronsoto/agent-runs/clones/gen-v-research-tools
 16M  /Users/sebastianpatronsoto/agent-runs/clones/gen-v-research-tools-2
 15M  /Users/sebastianpatronsoto/agent-runs/clones/mother-base
772M  /Users/sebastianpatronsoto/agent-runs/clones/mwcc-rs
5.9M  /Users/sebastianpatronsoto/agent-runs/clones/sft-course
 12M  /Users/sebastianpatronsoto/agent-runs/clones/swiftui-rewine
9.3M  /Users/sebastianpatronsoto/agent-runs/clones/the-big-shell
```

**Cost model:** USD unless marked EUR; 730-hour month, no VAT, no domain/email/operator labor, no paid support, no runner compute, and no one-time hardware purchases. VPS line is price of a published VM with enough starting memory/CPU and disk; backup storage and egress are separate and provider/retention-dependent. It is an order-of-magnitude list-price comparison, not a measured bill. Local machine cost assumes existing hardware; electricity formula is 0.72 kWh/month per continuous watt (e.g. 40 W → 28.8 kWh × local tariff). Home internet/UPS and replacement hardware excluded. Workers $5 minimum-plan charges can include request allowances; the Artifacts estimate below is explicitly separate and conditional.

| Option | Indicative monthly infrastructure cost | Backup method | Operations work | Main failure modes |
|---|---:|---|---|---|
| Build and operate a new forge on Cloudflare Workers + DO + Artifacts | Workers Paid $5 base; Durable Objects request/duration/storage usage; **Artifacts** under high-call model below adds about $214.50/month if all 2,000 peak API calls/h are Artifacts operations all month, plus storage ($0.50/GB-month after first GB). Not zero-cost at the requested sustained peak. | Independent scheduled Git bundle/export to a second provider; SQLite/metadata snapshots and restore test. Replication inside one provider is not a backup. | Build Git protocol/ref writes, auth, repo lifecycle, tracker, API, webhooks, event stream, migrations, runner bridge, monitoring, quota/cost controls, backups. | Product/API gaps; operation count or storage growth; provider limits; bad object/ref mutation; vendor outage. Highest engineering and validation risk. |
| One self-hosted home PC/Mac behind Cloudflare Tunnel | $0 incremental compute if already owned; electricity formula above; replacement/UPS/internet costs not included. No contracted uptime. | Nightly encrypted off-site Git bundles + app/database dumps; local snapshots alone fail with the machine/site. Test restore off-machine. | OS and Forgejo upgrades, firewall/Tunnel, DNS, disk health, UPS, backup, monitoring, recovery; runner isolation is harder if colocated. | Power, ISP, router, disk or owner machine outage; residential upload, sleep/reboot, theft/fire; Tunnel/account failure. Poor source-of-truth availability. |
| Small VPS (recommended): Hetzner EU CPX42 8 vCPU/16 GB/320 GB | **$81.99/month** current US-dollar EU list price, before VAT; dedicated IPv4, extra backup storage and egress not included. At 20 agents, run forge/coordinator/DB here but route untrusted Actions work to separate runners. | Nightly encrypted `git bundle --all` plus DB and app/config dumps to independent object storage; daily snapshots are convenience, not sole backup. Retain versioned copies and test a full restore quarterly. Budget backup storage separately (exact amount **UNVERIFIED**, object volume and provider not selected). | OS hardening/patching, DB and Forgejo upgrades, storage monitoring, TLS, firewall, runner registration/isolation, restore drills, alert response. | One VM/region outage, disk full/corruption, operator error or compromise; backup restore lag. Cheap to replace, but no automatic failover. |
| Fly.io with persistent volume | Starting estimate **$42.79–$51.33/month** for shared-cpu-4x/8 GB (regional published prices) + 100 GB provisioned volume ($15), snapshot actual stored data after first 10 GB at $0.08/GB-month, plus egress. This is a smaller 4-core/8GB app than CPX42; scale-up increases cost. Pricing is region-specific. | Fly volume snapshots plus independent encrypted Git bundles/DB dump off-provider. A volume is region-local persistent storage, not replicated backup. | Machine/volume lifecycle, region-aware recovery, volume capacity, snapshot and external backup monitoring, OS/Forgejo/DB upgrades. | A volume and machine share region/failure domain; volume loss, exhausted disk, image or deploy errors; snapshots do not protect against account-wide deletion. |
| Hybrid: VPS forge/coordinator + Cloudflare edge/Tunnel and remote runners or object backup | Roughly VPS $81.99 + metered Cloudflare/backup egress/storage; runners paid only if provisioned elsewhere. No second always-on forge node. | Independent versioned Git bundles and DB backup in a separate provider/location; optionally Cloudflare object store. | All VPS work plus edge routing, runner trust boundaries and cross-provider credentials. | Combined provider/config complexity; failover still manual unless a second writable/control plane is built. Edge availability does not fix a failed VPS. |

### Cloudflare Artifacts arithmetic at the same load

Artifacts bills repository operations, not generic HTTP/API calls; `2,000 agent API calls/hour` does not establish how many Artifacts operations the service will issue. Treat one Artifacts operation per agent call as a deliberately conservative upper-bound scenario (actual mapping is **UNVERIFIED**) and use the required posted $0.15 per 1,000 operations after 10,000/month:

```text
2,000 operations/hour × 24 hours/day × 30 days = 1,440,000 operations/month
(1,440,000 − 10,000 included) / 1,000 × $0.15 = $214.50/month
```

If “peak” means only one peak hour/day: `2,000 × 1 × 30 = 60,000 ops`; `(60,000−10,000)/1,000 × $0.15 = $7.50/month`. 300 changes/day is another 9,000 changes/month, but a change is not necessarily one Artifacts operation; do not add it again if those pushes are already represented in call volume. Storage at the measured ~3 GiB top-ten checkout footprint is only a rough lower bound: if stored size were 3 GB-mo, charge would be about $1.00 (`first 1 GB included, 2 × $0.50`); actual Git object storage, full 10-repo population, forks and retained unreachable objects are **UNVERIFIED**. Add Workers Paid base and Durable Objects usage; current DO pricing gives $0.15 per extra million requests after 1M/mo and $12.50 per extra million GB-seconds after 400k, with storage/rows separately billed. This model demonstrates why mapping actual Artifacts ops per API action is a go/no-go measurement before retaining it as the primary Git store.

## GitHub inventory, mirror and migration

`gh repo list seb-patron --limit 100 --json name,diskUsage,issues` returned **94** repositories as visible to the authenticated read-only `gh` identity. `diskUsage` below is the API value in KB (approximately KiB, as GitHub reports it); issue count below is the **open** issue count from `gh issue list --state open` (pull requests excluded). Twelve repositories have Issues disabled and are shown `N/A`. Workflows are paths in `.github/workflows/` at `HEAD`; `(none)` means no workflow file was listed. This exhaustive inventory includes old/archived and empty repos; decide the 10 initial migration targets separately. `du` local sizes above are the physical local-clone measure requested and are not substituted with GitHub `diskUsage`.

Read-only inventory commands (repo list for sizes, Issues endpoint for open issue count, and Git Trees API for workflows):
`gh repo list seb-patron --limit 100 --json name,diskUsage`
`gh issue list --repo seb-patron/REPO --state open --limit 1000 --json number --jq 'length'`
`gh api 'repos/seb-patron/REPO/git/trees/HEAD?recursive=1' --jq '[.tree[].path | select(startswith(".github/workflows/"))] | join(",")'`

Collected output (`repo | diskUsage KB | open issues | workflow paths`; TSV values are presented as columns here):

```text
concord | 2113 | 1 | (none)
gen-v-decomp | 108254 | 110 | (none)
mwcc-rs | 26804 | 67 | (none)
agent-workflows | 8280 | 214 | (none)
mother-base | 3350 | 2 | (none)
gen-v-workshop | 7332 | 67 | .github/workflows/native.yml
agent-run-analytics | 34 | 0 | (none)
sft-course | 735 | 1 | (none)
concord-dogfood | 0 | 0 | (none)
claude-skills | 136 | 1 | (none)
decomp-learning | 387 | 13 | .github/workflows/guardrails.yml
agent-review-evals | 2270 | 15 | (none)
gen-v-research-tools | 14305 | 115 | .github/workflows/fel.yml, .github/workflows/pr-guard.yml, .github/workflows/pr-tests.yml, .github/workflows/release.yml
azeron-macos | 12423 | 27 | .github/workflows/ci.yml, .github/workflows/credential-hygiene.yml, .github/workflows/evidence-ledger.yml, .github/workflows/fel-pilot.yml, .github/workflows/portable-ci.yml, .github/workflows/release-packaging.yml, .github/workflows/ui-change-readiness.yml
swiftui-rewine | 1645 | 72 | .github/workflows/linux-swift.yml, .github/workflows/repo-checks.yml
genv-vault | 0 | 1 | (none)
azeron-windows-protocol-lab | 3962 | 18 | .github/workflows/evidence-ledger.yml, .github/workflows/fel-pilot.yml, .github/workflows/pr-base-main.yml
SamplePort | 4770 | 7 | .github/workflows/ci.yml, .github/workflows/full-platform-build.yml, .github/workflows/release.yml
review-eval-fixtures | 32492 | 1 | (none)
developer-activity-observatory | 0 | 1 | (none)
mwcc-rs-cleanroom | 2 | 12 | (none)
antechamber | 7305 | 24 | (none)
muse-skills | 926 | 11 | .github/workflows/skills-lint.yml
waypost | 97 | 6 | (none)
federated-evidence-ledger | 1865 | 41 | .github/workflows/conformance.yml, .github/workflows/release.yml
goldeneye-native | 10313 | 41 | .github/workflows/collision-hull.yml, .github/workflows/controls-binding-regression.yml, .github/workflows/cuff-switch-regression.yml, .github/workflows/joy-poll-handshake.yml, .github/workflows/launcher-policy-regression.yml, .github/workflows/macos-renderer-app.yml, .github/workflows/mouse-capture-regression.yml, .github/workflows/multi-ammo-regression.yml, .github/workflows/pages.yml, .github/workflows/prop-allocator-telemetry.yml, .github/workflows/public-artifact-safety.yml, .github/workflows/rgba16-byte-order-regression.yml, .github/workflows/windows-setup-package.yml
codex-skills | 294 | 9 | .github/workflows/skill-evals.yml
claude-workers | 3126 | 17 | .github/workflows/ci.yml
agent-flow | 1121 | 1 | (none)
career-compiler | 818 | 13 | (none)
goldeneye-mission-editor | 1306 | 7 | .github/workflows/public-artifact-safety.yml
github-actions-observatory-deployment | 37 | 1 | .github/workflows/observatory.yml
review-workbench | 2077 | 37 | .github/workflows/ci.yml
goldeneye-rust-reference | 454 | 11 | .github/workflows/reference-metadata.yml
goldeneye-rust | 486 | 15 | .github/workflows/ci.yml
github-actions-observatory | 112 | 1 | .github/workflows/ci.yml
goldeneye-web | 50 | 1 | (none)
RepReady | 2375 | 1 | (none)
the-big-shell | 1983 | 1 | .github/workflows/ci.yml
chord-practice-tool | 1375 | 1 | (none)
CrateReady | 4567 | 1 | .github/workflows/ci.yml, .github/workflows/macos-validation.yml
typed-graph-compiler | 18 | 1 | (none)
FoxKit-Forge | 119288 | 1 | (none)
deno-dag-poc | 991 | 2 | .github/workflows/library-boundary.yml
seb-patron.github.io | 33052 | 1 | (none)
SP404mk2-wav-converter | 15 | 1 | (none)
my-hardware-studio | 7576 | 1 | (none)
prompt-cast-backend-poc | 57 | 1 | (none)
data-science-portfolio | 17 | 1 | (none)
Pokemon-Showdown-Airflow-ETL | 881 | 1 | (none)
spark-project-starter | 11 | 1 | (none)
arxiv-spark | 813 | 1 | (none)
Seaborn-Visualizations | 948 | 1 | (none)
tempe-crime-analysis | 675 | 1 | (none)
VGC-Analysis | 621 | 1 | (none)
Algorithms | 1409 | 1 | (none)
dashlytic | 595 | 1 | .github/workflows/main.yml
ScrumdingerTutorial | 103 | 1 | (none)
PoseFinderIos | 2594 | 1 | (none)
archived-seb-patron.github.io | 76072 | 1 | (none)
k-means-most-common-color | 4389 | 1 | (none)
purchase_order_app | 34 | 1 | (none)
projects | 5541 | 1 | (none)
gatsby-intro | 7146 | N/A (Issues disabled) | (none)
Algorithms-and-Data-Structures | 347 | 1 | (none)
LPL-solutions | 6977 | N/A (Issues disabled) | (none)
snasu.github.io | 25075 | 1 | (none)
jumpstart | 174 | N/A (Issues disabled) | (none)
easy-application | 287 | N/A (Issues disabled) | (none)
finstagram | 469 | 1 | (none)
machine-learning-python | 28 | 1 | (none)
machine-learning-stanford | 21246 | 1 | (none)
interview_cake_sql | 69 | 1 | (none)
jitbit-sql-practice | 503 | 1 | (none)
kanye-sounds | 2011 | 1 | (none)
ROR-Twitter-Clone | 170 | 1 | (none)
Tachyons-Simple_Form-Wrapper | 1 | 1 | (none)
amplify | 729 | N/A (Issues disabled) | (none)
ML-Template | 167 | 1 | (none)
AIND-Sudoku | 214 | 1 | (none)
algorithms-stanford | 28292 | 1 | (none)
sudoku-ai | 476 | 1 | (none)
mygovusa-static | 1 | 1 | (none)
mygovusa-jekyll | 3459 | N/A (Issues disabled) | (none)
hoodAPIv2 | 40 | N/A (Issues disabled) | (none)
local-library | 12 | 1 | (none)
mariadb-test | 8 | 1 | (none)
OpenTempeNPM | 21 | N/A (Issues disabled) | (none)
hoodAPI | 2209 | N/A (Issues disabled) | (none)
hoodfrontendMVP | 0 | N/A (Issues disabled) | (none)
lispy-C | 149 | 1 | (none)
AsteroidsJS | 10 | 1 | (none)
TweetRecruiterJS | 4655 | 1 | (none)
Vulfify | 3047 | N/A (Issues disabled) | (none)
MaskSlicerJS | 4488 | 1 | (none)
YeezyEfx | 1300 | 1 | (none)
Selfie-App | 80 | 1 | (none)
PacDude-JS | 17 | 1 | (none)
cs106-Assignment-4 | 2628 | 1 | (none)
macfonts | 17890 | N/A (Issues disabled) | (none)
```

**Operational mirror/migration sketch (future work):** (1) freeze inventory and choose the initial repos; verify license, LFS, GitHub Actions secret/environment, release and branch-protection dependencies per repo; (2) provision Forgejo repo and import Git history (mirror clone/bare push preserving all intended refs and LFS separately); import issues, comments, labels, milestones and releases using an idempotent read/export + write/import converter preserving original GitHub issue numbers/references where possible; (3) translate `.github/workflows` to Forgejo-supported workflow locations/semantics, configure isolated runners and secrets manually; (4) verify refs, LFS object checksums, issue counts and workflow dry runs; (5) announce cutover, set GitHub repos read-only, make Forgejo the only writable canonical, enable filtered one-way push mirrors, monitor failed pushes and reconcile only by owner-approved process. GitHub branch protection, Actions history/secrets, PR reviews and some issue metadata have no guaranteed mirror equivalent; per-repo conversion gap is **UNVERIFIED** until audited. Do not configure the mirror using a token with broader account scope than needed.

## Research sources

Primary sources were opened and read for the cited relevant sections unless marked otherwise. Capability claims above intentionally distinguish built-in documented behavior from gaps not proven by a negative search.

| Source | Read status / relevant section |
|---|---|
| https://forgejo.org/docs/latest/user/git-cli/agit-support/ | Read relevant section: AGit refs/push options and PR creation/update. |
| https://forgejo.org/docs/v16.0/user/repo-mirror/ | Read relevant section: GitHub push mirror, filters, token scope and force-mirror behavior. |
| https://forgejo.org/docs/latest/admin/config-cheat-sheet/ | Read relevant section: issue dependency defaults/cross-repository setting, mirror and API config. |
| https://forgejo.org/docs/latest/user/repository/webhooks/ | Read relevant section: event types, webhook setup and payload. |
| https://forgejo.org/docs/latest/user/api/usage/ | Read relevant section: REST API usage/reference. |
| https://forgejo.org/docs/latest/user/actions/overview/ | Read relevant section: Forgejo Actions architecture and runner. |
| https://forgejo.org/docs/latest/admin/actions/configuration/ | Read relevant section: runner configuration/security and caches. |
| https://forgejo.org/faq/ | Read relevant section: current Forgejo license history. |
| https://forgejo.org/2024-08-monthly-update/ | Read relevant section: GPL-3.0-or-later switch and rationale. |
| https://forgejo.org/compare-to-gitea/ | Read relevant section: project governance/comparison; treat project-authored claims as such. |
| https://docs.gitea.com/usage/actions/quickstart/ | Read relevant section: runner separation/setup and workflow compatibility. |
| https://docs.gitea.com/1.26/usage/actions/overview/ | Read relevant section: standalone runner architecture/status. |
| https://docs.gitea.com/runner/2/ | Read relevant section: runner deployment/execution. |
| https://docs.gitea.com/usage/repository/webhooks/ | Read relevant section: webhook events. |
| https://docs.gitea.com/development/api-usage/ | Read relevant section: API and OpenAPI docs. |
| https://docs.gitea.com/enterprise/api/21/operations/issue-list-issue-dependencies/ | Read relevant section: issue dependency API; compare with community release docs. |
| https://blog.gitea.com/release-of-1.20.0/ | Read relevant section: upstream 1.20 release introduced issue dependencies. |
| https://www.anthropic.com/engineering/redesigning-source-control | Read relevant sections: server-side changesets/merges, refs, immutable cached reads and test strategy. |
| https://cursor.com/blog/scaling-agents | Read relevant sections: reported lock/agent throughput observations and planner/worker setup. |
| https://developers.cloudflare.com/artifacts/platform/pricing/ | Read relevant section: Artifacts operation and storage rates (pricing page last updated 2026-09-17). |
| https://developers.cloudflare.com/durable-objects/platform/pricing/ | Read relevant section: requests, duration, storage rates and included usage. |
| https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ | Read relevant section: post-2026-06-15 CPX42 prices by location. |
| https://www.hetzner.com/cloud/regular-performance/ | Read relevant section: CPX42 vCPU, RAM, NVMe and traffic specifications. |
| https://fly.io/docs/about/pricing/ | Read relevant section: shared-cpu-4x/8GB, volume, snapshot and egress prices; region caveat. |
| https://cli.github.com/manual/gh_repo_list | Read relevant section: `gh repo list` and JSON field support. |
| GitHub read-only inventory: `gh repo list seb-patron --limit 100 --json name,diskUsage,issues` plus per-repo Git Trees API query shown above. | Direct output read; 94 visible account repositories. |
| Local clone measurement: `du -sh /Users/sebastianpatronsoto/agent-runs/clones/*` | Direct command output read; summarized verbatim above. |

## Validation and limitations

The task’s only validation command is `wc -c docs/spikes/v3/sp-a-platform.md`; record its final output in the handoff. The account/repo metadata was queried read-only. No paid account, resource or GitHub write was used. **UNVERIFIED:** actual Artifact ops per API call, real peak duration profile, full ten-target repo object sizes/LFS volumes, Forgejo/Gitea performance at 20 concurrent writers, webhooks retry/replay guarantees, exact backup storage price, full migration fidelity, and several negative capability claims noted in the matrix. These are the spike’s proposed prototype/measurement gates, not assumed facts.
