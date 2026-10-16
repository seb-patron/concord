# Where Concord should run

## Your questions, short answers

| Owner question | Research answer |
| --- | --- |
| Cheapest now? | For a quiet pilot, an existing owner machine has no new rental but unpriced power, internet, replacement and outage costs. Hetzner EU CX23 starts at €5.49/month, with unproved capacity and transfer bill. A $18 DigitalOcean 2-vCPU/2-GB server has a published 2,000-GiB transfer allowance. Cloudflare's $5 component floor is cheaper on paper, but its Git server path is unproved. |
| Most scalable and sustainable? | Start with portable local Git and SQLite on a rented server, isolated runners and a separate-provider backup; move whole repositories to more servers as measured disk and pack CPU demand grows. Sustainable means money, support effort, recovery and provider dependence together. No 1,000-repository single-server price below is a capacity quote. Prepared packs in object storage may later reduce clone traffic cost. |
| Keep Cloudflare? | Yes for hosted static UI and possibly API/event ingress. Route Git pushes directly to the server. Do not make Durable Objects and Artifacts the live v3 Git store on current evidence. |
| Self-hosted plus hosted for other users' repositories? | Yes: one server/UI codebase, customer-run installs and an invite-only hosted pilot. A public service needs isolation, moderation, billing, quotas and selective restore/export/delete. |
| A UI? | Yes. Build one client-rendered browser app; bundle it for self-hosters and optionally serve the hosted copy as Cloudflare static assets. Keep the marketing/docs site separate. |

The earlier platform study's 8-vCPU/16-GB Hetzner CPX42 is a **priced comparison point**, not a measured minimum. A smaller rented server is an untested pilot hypothesis. Europe is cheaper on quoted Hetzner rates; a US location may lower Chicago round trips for claim, land and event calls. The owner must choose region and recovery objectives. This is research only (D-RESEARCH-PHASE); no experiment or deployment is proposed here. The already-decided own-forge/GitHub-mirror direction remains (D-FORGE-ISSUES, D-NO-GITHUB-WORK).

## Terms, dates and evidence

| Term | Meaning here |
| --- | --- |
| Virtual private server (VPS); shared/dedicated vCPU | A rented virtual machine; shared CPU speed can vary with neighbors, while dedicated CPU is more predictable for Git pack generation. |
| Bun; SQLite | Proposed JavaScript server runtime; file-based SQL database for Concord metadata. Neither has a measured hosted capacity in these inputs. |
| Git smart HTTP; pack/bundle | Git clone, fetch and push over HTTPS; compressed Git objects transferred or exported as a file. Prepared packs still need private authorization and current refs. |
| Object storage; GB-month | Files addressed by name; one GB held for a month. Useful for backups and immutable packs, not a direct live Git-ref or SQLite replacement. |
| Egress; CDN | Outbound bytes; a content delivery network caching files near readers. Runner clones, backup uploads and mirror pushes create egress too. |
| Durable Object; hibernation; GB-second | Cloudflare's stateful compute unit; eligible idle WebSockets can sleep. One GB-second is one GB of allocated memory for one second of active duration. |
| WebSocket; drain; alarm | Persistent event connection; runtime shutdown requiring reconnection; scheduled wake-up. |
| Isolate; NVMe; IPv4 | Worker execution container; fast solid-state disk; an Internet address that may add a fee. |
| Tenant; runner | A customer needing isolated data and quotas; a separate machine running untrusted checks or agent work. |

**STRUCTURAL** labels below identify source-backed architecture or tariff terms. **CAPABILITY-DEPENDENT** labels identify assumptions about implementation or load. Vendor notes were captured October 15, 2026 Chicago time (October 16 UTC); the earlier platform review's CPX42 quote was captured that afternoon. Hetzner's price adjustment took effect June 15, 2026. Dollar and euro quotes are published list currencies; no exchange rate is assumed. Tax, Hetzner IPv4, labor, support, runner/model spend and domain/email are excluded unless stated.

The supplied **Our measured usage** record gives account-wide UTC-day counters, not a v3 forecast or invoice:

| Observation | Limit on interpretation |
| --- | --- |
| 997,407 Worker requests, 1,175,856 Durable Object requests, about 1.12 million Worker CPU-ms and 2.66 billion rows read during October 12–15 UTC plus three early October 16 requests | Durable Object requests exceed the one-million monthly inclusion by 175,856, about $0.15 at the quoted rate before rounding; none of these totals is per repository. |
| Five hours at eight Durable Object requests and eight Artifacts events/hour after the idle-alarm fix, 1–6 p.m. Chicago time October 15 | The former roughly 1,133-read/hour leak implied about $121/month. The observed fix does not prove future operations remain low. |
| 486 Artifacts repositories holding 3.42 GB | About 7 MB/repository; if held for a full month, storage above the included GB is about $1.21. Artifacts billable operations were absent from the data. |
| Local Git directories: 11, 38, 55, 172 and 542 MB; worker run directories: 299–636/day on October 10–14 | Mean Git size about 164 MB; the large tail matters. Runs are neither simultaneous agents nor a measured count of Git acquisitions. |

A **conditional** current Cloudflare component subtotal is about $6–$7/month: $5 Workers minimum, about $0.15 excess Durable Object requests and up to $1.21 Artifacts storage at the observed size, **plus unknown** Artifacts operations, duration, rows and other charges. Artifacts billing began October 14. The v2 Worker remains during migration and shares account allowances. The supplied **Concord platform and hosting study** assumed ten repositories, 20 concurrent agents, 300 changes/day and a peak of 2,000 API calls/hour. The supplied **Realtime events prototype** held 200 quiet sockets for 60 seconds at 46,950 bytes of *combined server-and-client* heap each: 2,000 would be about 94 MB by that arithmetic only, with Git CPU and disk possibly limiting first. It is not production capacity evidence. The supplied **Platform review** confirmed CPX42's scoped price and rejected an unsupported Fly four-core quote.

**Evidence index:** The owner-supplied research packet under the inputs folder contains *Our measured usage* (h4-our-usage.md, collected October 15 Chicago), *Concord platform and hosting study* (sp-a-platform.md, October 15), *Realtime events prototype* (sp-c-realtime-api.md, October 15), *Platform review* (f4-platform-report.md, October 15), and the Cloudflare, VPS/storage, dual-model and platform source notes (h1-cloudflare-notes.md, h2-vps-storage-notes.md, h3-dual-model-notes.md and sp-f4-platform-notes.md, captured October 15 Chicago). The vendor links below are the primary price and limit pages recorded in those notes. The local packet is supplied separately from this checkout, so these filenames are descriptive references rather than broken repository links.

## Shared light and busy scenarios

All price tables show **US dollars per 30-day month** except explicit euro quotes. These are component floors, not customer prices, complete operating costs or capacity promises. Assume 0.2 GB current Git data/repository, growing by 0.05 GB/month to **0.8 GB/repository at year one**, before forks, large files, indexes, backup versions and temporary working space. This growth is a hypothesis. UI use is 30 visits/repository/month, five static requests/visit; UI bytes are unmeasured.

**Light:** 30 changes/repository/month; four full 0.2-GB client clones; 60 incremental 0.02-GB client fetches; 3,000 dynamic API calls; one 0.02-GB *cached* check-runner fetch/change. **Busy agent swarm:** the earlier 300 changes/day across ten repositories, or 900 changes/repository/month; the same client Git baseline; one cached runner fetch/change. The earlier peak of 2,000 API calls/hour over ten repositories, held for one hour/day, means 6,000 calls/repository/month; eight such hours/day mean 48,000. The measured hundreds of daily runs motivate check/retry sensitivity, but one run is not proven to equal one change. Each extra reviewer or retry check adds a 0.02-GB cached fetch or, with a fresh workspace, a 0.2-GB clone.

| Per repository per month | Light, cached runner | Busy, cached runner | Busy, fresh clone/check |
| --- | ---: | ---: | ---: |
| Changes; assumed check acquisitions | 30; 30 | 900; 900 | 900; 900 |
| Client Git egress | 2 GB | 2 GB | 2 GB |
| Runner Git egress | 0.6 GB | 18 GB | 180 GB |
| **Total Git egress** | **2.6 GB** | **20 GB** | **182 GB** |
| Assumed Artifacts operations, if used | 214 | 4,564 | 4,564 |
| API calls, one peak hour/day | 3,000 | 6,000 | 6,000 |

Artifacts arithmetic assumes four operations/change plus one per client clone/fetch and runner acquisition. This mapping is **CAPABILITY-DEPENDENT**, not measured and potentially overlapping with API calls. At 1,000 repositories cached light/busy Git traffic is 2,600/20,000 GB monthly; fresh busy clones are 182,000 GB. Extrapolating the ten-repository study is a cost sensitivity, not a throughput claim.

## Cloudflare as a stateful Git server

**STRUCTURAL, pages captured October 15 Chicago:** [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) gives a $5 Paid minimum, 10 million dynamic requests and 30 million CPU-ms included, no Worker egress charge and free matching [static assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) include one million requests and 400,000 GB-seconds, then $0.15/million requests and $12.50/million GB-seconds. [Artifacts](https://developers.cloudflare.com/artifacts/platform/pricing/) includes 10,000 operations and one GB-month, then $0.15/1,000 operations and $0.50/GB-month; its page gives **no egress tariff**. [R2](https://developers.cloudflare.com/r2/pricing/) includes ten GB-month, then $0.015/GB-month, with free direct egress. The model holds live Git in Artifacts, one R2 copy and an independent Backblaze B2 copy; Artifacts plus R2 alone share a provider failure domain. Worker CPU, Durable Object rows/duration, incoming WebSocket message request equivalents, backup operations and unquoted Artifacts transfer are excluded from the table floor.

| Repositories | Scenario | Git egress: Workers free; Artifacts term unknown | Current monthly floor | Year-one monthly floor; Git retained |
| ---: | --- | --- | ---: | --- |
| 1 | Light / busy | 2.6 / 20 GB | ~$5 / ~$5 | ~$5 / ~$5; 0.8 GB |
| 10 | Light / busy | 26 / 200 GB | ~$5.50 / ~$11 | ~$8.50 / ~$14; 8 GB |
| 100 | Light / busy | 260 / 2,000 GB | ~$16 / ~$82 | ~$47 / ~$113; 80 GB |
| 1,000 | Light / busy | 2,600 / 20,000 GB | ~$140 / ~$793 | ~$453 / ~$1,106; 800 GB |

For busy 1,000 current storage, about $5 Workers + $683.10 Artifacts operations + $99.50 Artifacts storage + $2.85 R2 storage + $0.75 Durable Object excess requests + $1.32 Backblaze storage = **$792.52** before rounding. At eight peak hours/day, 1,000 repositories add roughly $11.40 Worker requests and $6.30 further Durable Object requests, before CPU/duration. Fresh runner clones greatly increase bytes but no Artifacts egress price can be inferred. The Git write path and Artifacts binding's commit-write capability remain unverified; absence is not asserted.

**CAPABILITY-DEPENDENT duration sensitivity:** Assume two event sockets/repository, eight work hours/day, one incoming message/socket/minute during that window and 0.1 second processing/message. At 1,000 repositories this is 28.8 million messages/month, billed at a 20:1 incoming-message request ratio (about 1.44 million billable request equivalents). At 128 MB allocated/object, processing adds about **360,000 GB-seconds/month** if objects hibernate between messages, within the 400,000 inclusion *before other account use*. If all 1,000 objects stay resident for eight hours/day, they accrue **108 million GB-seconds**, about **$1,345** excess duration; 24-hour residency accrues **324 million**, about **$4,045** excess. Thus the preceding table is a component floor, not a plausible nonhibernating total. These figures exclude alarms, unfinished I/O, reconnect storms and other account usage. Hibernation avoids eligible idle duration, not setup or incoming-message charges. [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/) include 10 GB/SQLite object and a soft 1,000 requests/second/object. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) include a 128-MB isolate, five-minute paid HTTP CPU ceiling, six simultaneous outbound connections awaiting headers and a 100-MB Free/Pro zone request-body cap. Runtime replacement can drain WebSockets within 20 minutes.

## Rented servers, Git transfer and independent backup

Run the proposed Bun/Git/SQLite server with local bare repositories and separate untrusted runners. **No quoted server has a measured Concord capacity.** [Hetzner's June 2026 price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) gives Germany/Finland shared CX23 €5.49, CPX22 €19.49 and CPX42 **$81.99 or €69.49** monthly, and dedicated-CPU CCX13 €42.99. US CPX41 is $141.49 and CCX13 $50.99. The CPX42 is 8 shared vCPU, 16 GB and 320 GB NVMe according to the supplied **Platform source notes**. Tables use the **USD EU list quote** before VAT and IPv4. Shared CPU may vary during Git pack generation; dedicated CPU may pay off for sustained concurrent packs. The supplied [Hetzner Cloud page](https://www.hetzner.com/cloud/) does not provide a numeric transfer allowance or overage rate.

[DigitalOcean Basic](https://www.digitalocean.com/pricing/droplets/) lists $18 for 2 shared vCPU/2 GiB/50 GiB with 2,000 GiB included transfer and $96 for 8 shared vCPU/16 GiB with 6,000 GiB included. Its overage rate is absent from the supplied capture. Dedicated-CPU lines begin at $42 for 2-vCPU/4-GiB and $63 for 2-vCPU/8-GiB; neither matches 8/16. [Fly](https://fly.io/docs/about/pricing/) quotes $13.39 for 2 shared vCPU/2 GB in its Ashburn example; its 8-vCPU/16-GB quote is not supplied. The old $43–$51 four-core quote was unsupported. Fly and DigitalOcean small quotes match CPU/RAM, but **not region**; Hetzner and DigitalOcean 8/16 match CPU/RAM, but **not region or disk**. Obtain same-region quotes and latency before vendor ranking. Small-server capacity remains unproved.

The backup model uses one encrypted full seed followed by **0.05 GB/repository/month incremental upload** plus **0.05 GB/repository/month GitHub mirror upload**. Together these add 0.1 GB/repository/month outbound to the origin beyond Git downloads. An independent [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) current-size copy is free for the first ten GB, then $6.95/TB-month: about $1.32 for 200 GB and $5.49 for 800 GB, excluding versions. B2's ordinary restore egress is free up to 3× average stored bytes then $0.01/GB; listed CDN/compute partners have separate free-egress terms. Thirty full copies/month of 200 GB would instead upload 6,000 GB/month before database bytes. The GitHub mirror, if configured and current, covers only selected Git refs such as main and tags; it cannot restore claims, issues, events, users, secrets, SQLite or unmirrored refs. Same-provider snapshots help routine recovery but are not the independent copy.

| Server; quoted region | Scenario | Git egress at 10 / 100 / 1,000 repos | Current floor at 10 / 100 / 1,000 | Year-one at 1,000 | Limit |
| --- | --- | --- | --- | --- | --- |
| Hetzner EU CX23, €5.49 shared | Light / busy | 26 / 260 / 2,600 GB; 200 / 2,000 / 20,000 GB | €5.49 + backup / same, plus growth | €5.49 + ~$5.49 backup **minimum** | CPU/RAM/disk fit and transfer tariff unproved. |
| Hetzner EU CPX42, $81.99 shared 8/16/320 | Light / busy | same light / busy | ~$82 / ~$82 / ~$83, both | **800 GB cannot fit** 320 GB disk | Transfer and expansion unpriced. |
| DigitalOcean US $18 shared 2/2/50 | Light / busy | same light / busy | ~$18 / ~$18 / ~$19, both | **800 GB cannot fit** 50 GiB disk | 2,000 GiB included; busy 1,000 exceeds, overage unknown. |
| DigitalOcean US $96 shared 8/16 | Light / busy | same light / busy | ~$96 / ~$96 / ~$97, both | Disk expansion needs a quote | 6,000 GiB included; busy 1,000 exceeds, overage unknown. |

Every row uses the same Git workload and backup model. Euro and dollar components are **not summed or converted**. “Floor” excludes missing transfer and expansion; capacity is untested. A fixed VM list price does not make a hosted service bill fixed. At year one, 0.8 GB/repository excludes SQLite, working packs, backups and versions. Chicago-to-Europe latency for chatty agent actions is an unmeasured risk and an owner region decision.

### Fly.io, with itemized outbound traffic

Fly's Ashburn 2-vCPU/2-GB machine is $13.39/30 days; a volume is $0.15/GB-month, snapshots $0.08/GB-month after ten GB and North America/Europe public outbound $0.02/GB. Provision **10 GB + twice current Git data**, rounded up: 11/14/50/410 GB at 1/10/100/1,000 repositories. Charge one current-size Fly snapshot, an independent Backblaze copy, Git downloads and 0.1 GB/repository/month backup/mirror outbound. Same-provider snapshots remain a convenience. These are lower bounds even when the 2-GB machine cannot host the workload.

| Repositories | Scenario | Git egress; Fly Git charge | Current monthly floor | Year-one monthly floor | Capacity |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | Light / busy | 2.6 / 20 GB; $0.05 / $0.40 | ~$15 / ~$15 | ~$15 / ~$15 | Small pilot hypothesis. |
| 10 | Light / busy | 26 / 200 GB; $0.52 / $4 | ~$16 / ~$20 | ~$18 / ~$21 | 14-GB current volume. |
| 100 | Light / busy | 260 / 2,000 GB; $5.20 / $40 | ~$27 / ~$62 | ~$50 / ~$85 | CPU/RAM unproved. |
| 1,000 | Light / busy | 2,600 / 20,000 GB; $52 / $400 | at least ~$145 / ~$493 | at least ~$378 / ~$726 | Machine upgrade required; no scale quote. |

The ten-repository light arithmetic is $13.39 machine + $2.10 volume + $0 snapshot + $0 B2 + $0.54 *total* outbound = **$16.03**. Under the old $7.99 same-provider backup assumption and 2-GB/client-only egress, the corrected old formula was **$23.88, about $24**, not $23. The new floor replaces that backup with independent B2 and includes runner transfer. Year-one 1,000 requires a 1,610-GB provisioned volume and about 790 GB billable snapshot bytes; its 2-GB machine floor is not feasible capacity. Daily full backup of current 1,000-repository Git would add 6,000 GB, or **$120/month** at Fly's egress rate, before database and mirror transfer. Incremental backup behavior is an assumption to verify.

## Hosted hybrid routing and UI

Cloudflare static assets and optional edge API/event ingress can be added to any server row. The Workers $5 minimum may already be paid on the shared account. At 1,000 busy repositories and eight peak hours/day, 48 million dynamic calls add about $11.40 above ten million before the live v2 Worker. **Git egress follows the origin-server table**, plus backup/mirror bytes; Workers' free egress does not erase VPS/Fly transfer charges. Year-one storage and CPX42 disk limits also carry through. A CPX42 hybrid starts near $87/month at ten light or busy repositories and at least $88/month at 1,000, before unquoted transfer/expansion. These are shared-account component floors, not all-in prices.

| Hybrid: CPX42 plus Workers Paid | Light scenario | Busy scenario | Git egress and year-one constraint |
| --- | ---: | ---: | --- |
| 10 repositories, current | about $87/month | about $87/month | 26 / 200 GB monthly; Hetzner tariff unknown. |
| 100 repositories, current | about $87/month | about $87/month | 260 / 2,000 GB monthly; CPU unproved. |
| 1,000 repositories, current | at least $88/month | at least $88/month | 2,600 / 20,000 GB monthly; expansion unpriced. |
| 1,000 repositories, year one | cannot fit on one CPX42 | cannot fit on one CPX42 | 800 GB Git exceeds 320 GB local disk before working space. |

The hybrid table includes one Backblaze current-size copy and the Workers $5 minimum as an incremental charge. At 1,000 busy repositories with eight peak hours/day, the roughly $11.40 Worker request excess and existing v2 use are additional. Git transfer pricing remains open on Hetzner.

Put Git smart HTTP on a **DNS-only direct server hostname** with server TLS and repository authentication. A proxied UI/API/event hostname can remain on Cloudflare. Workers Paid does not raise a Free/Pro **zone's 100-MB request-body cap**; a large initial Git push can fail before reaching the server despite streaming. The local 542-MB Git directory is a warning, not a measured push body. Before a route change, test a >100-MB push and verify event reconnect/replay after a WebSocket drain. A direct Git hostname exposes the origin and requires its own rate limits and DDoS plan; the server must not trust edge headers alone. Cross-origin browser credentials need a policy. A Cloudflare outage may interrupt UI/API while direct Git survives.

The browser app is assumed to be a client-rendered single-page app. Public pages for logged-out visitors/search engines may later need server rendering, which uses dynamic compute. The marketing/docs site is separately static. Self-hosters serve the compiled app from the server. Hosted deployment can publish those files as Cloudflare static assets, or serve them from the server behind a caching CDN for one deployment path, with shared origin bandwidth and cache invalidation. Pin app/API compatibility. A CDN does not give Git high availability.

## Considered and rejected or deferred

| Alternative | Price from October 15 Chicago captures | Git egress | Deciding limit now | Revisit when |
| --- | --- | --- | --- | --- |
| [Cloudflare Containers](https://developers.cloudflare.com/containers/platform/pricing/) as server | $5 Workers minimum plus metered active CPU/memory/disk, Worker and Durable Object charges | North America/Europe 1 TB included then $0.025/GB | Largest listed container has 20 GB disk and no demonstrated durable live Git store; always-awake service is metered. | Durable store and measured sleep/wake/pack workload exist. |
| Prepared clone packs in [R2](https://developers.cloudflare.com/r2/pricing/) or [B2](https://www.backblaze.com/cloud-storage/pricing) | R2 ten GB free then $0.015/GB-month; B2 ten GB free then $6.95/TB-month | R2 direct free; B2 ordinary allowance 3× stored bytes, partner CDN routes free | Private authorization, current refs, pack generation, object operations and cache invalidation unresolved. Local Git/SQLite writes remain. | Origin clone traffic makes egress material. Likely path: VPS writes plus object/CDN clone bundles. |
| Managed [D1](https://developers.cloudflare.com/d1/platform/pricing/) or [Fly Postgres](https://fly.io/docs/about/pricing/) | D1 rows/storage under Workers plan; Fly Basic $38/month plus $0.28/GB-month | Database tariff does not price Git bytes | Neither solves Git object storage; adds an operational dependency to a pilot. | Cross-host metadata or availability warrants it. |
| [Hetzner AX42-1 bare metal](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) | €97.30/month plus €49 setup before VAT/IPv4 | Unquoted in supplied packet | Hardware, recovery and traffic unmeasured; setup/replacement work. | Sustained pack CPU/disk demand outgrows VPS value. |
| [DigitalOcean Droplet](https://www.digitalocean.com/pricing/droplets/) | $18 small shared; $96 shared 8/16 | 2,000/6,000 GiB included, excess unquoted | Included transfer known, overage and disk expansion still need quotes. | Same-region comparison or US pilot. |
| Owner's existing machine in the supplied platform study | No new rental; 40 continuous watts = 28.8 kWh/month times local electricity tariff, before UPS/internet/replacement | ISP upload/cap unknown | Power, ISP, reboot, theft, residential upload, backup and owner time; no contracted uptime. | Private self-hosting or outage-tolerant evaluation. |

Large files, uploads, runner logs and backups belong in object storage if offered. [GitLab's installation requirements](https://docs.gitlab.com/install/requirements/) use that split while requiring local repository capacity; its own server minimum is not a Concord minimum.

## One codebase, two operating models

A self-hosted release includes the same Git behavior, HTTP/CLI/event interfaces and compiled UI, with versioned data directory, export, backup and upgrade instructions. Operators pay for compute, runners, backup and updates. Hosted mode adds accounts, metering/billing, quotas, monitoring, security response and support. [Forgejo and Codeberg](https://docs.codeberg.org/getting-started/what-is-codeberg/) show self-hosted software plus a hosted service; [Plausible](https://plausible.io/self-hosted-web-analytics) says Cloud subscriptions fund development; [PostHog's retrospective](https://posthog.com/blog/sunsetting-helm-support-posthog) shows extra deployment variants' support burden; [Sentry](https://develop.sentry.dev/self-hosted/) has a restrictive competing-service license; and [GitLab](https://about.gitlab.com/pricing/) distinguishes shared SaaS, self-managed and managed single-tenant service. None is a Concord cost or license quote. Forgejo's volunteers/grants/donations, Plausible's subscriptions and GitLab's paid tiers illustrate funding choices; Concord's license and funding model remain owner decisions.

**Shared host** is the model behind server price floors. Every API, Git, event, cache and backup path must authorize tenant and repository. Separate Git directories and one database per repository or tenant support selective export, deletion and restore; restoring one customer from one shared SQLite file risks rolling back others. Quotas and admission must cover Git bytes and transfer, pack CPU time, memory, concurrent pack jobs, sockets, metadata requests, backup versions and runner minutes. These safeguards are required, **not implemented** by this report.

**Managed instance per customer** reuses the self-hosted image with stronger isolation and simpler selective restore, but each customer has a compute floor plus monitoring and upgrade work. Public shared hosting also needs signup/spam controls, malware/illegal-content reports, takedown response, runner abuse such as crypto-mining, suspension, retention and verified deletion. Invite-only access limits the first pilot. Keep customer secrets off runner machines. Who funds runners and model accounts may dominate server costs and needs an owner decision. Self-hosters need pinned releases, security updates and schema rollback; hosted migrations can be staged by tenant. Supporting one initial Linux footprint limits maintenance burden.

## Recovery and owner decisions

Back up encrypted Git **and consistent SQLite snapshots** to another provider, retain versions, and test restoration to a fresh server including refs, issues, claims, events, identities and access rules. Hourly or continuous metadata shipping reduces loss relative to nightly-only copies; price it after the desired loss window is set. Same-provider snapshots help accidental deletion but not provider/account failure. GitHub's selected-ref mirror is only a supplementary partial copy.

These owner questions remain open; suggested pilot defaults are **recommendations**, not recorded answers:

1. **Region and budget:** EU lower list price or US proximity/data location? What monthly infrastructure ceiling is acceptable? Suggested: US if active agents are mainly in Chicago, after same-region transfer quotes.
2. **Recovery:** How many hours of changes, claims and events may be lost, and how soon must service restore? Suggested target to validate: at most one hour loss and four-hour restore.
3. **Tenancy and runners:** Shared hosting or one managed instance/customer? Do customers bring runner/model accounts, or do we fund them? Suggested: invite-only shared pilot with customer-funded runners.
4. **Self-hosting and funding:** Which OS/architecture/update cadence is supported, and what license and hosted subscription/support model pays for maintenance? Suggested: one pinned Linux release and no public free tier until metering and recovery are tested.

## Review ledger

Finding IDs appear only here. “Fixed” points to the repair section. “Open” means the supplied evidence cannot close the numeric question without a quote or measurement; the uncertainty is exposed in the body.

| Finding | Disposition |
| --- | --- |
| F1 | Fixed — Shared light and busy scenarios, cached/fresh runner traffic and every price table. |
| F2 | Open in part — Rented servers compare small and 8/16 classes and shared/dedicated CPU, but a same-region 8/16 Fly price and Hetzner small-shape mapping are absent from the allowed source packet. The table refuses a false matched quote. |
| F3 | Fixed — Your questions; Rented servers; Recovery: region and Chicago latency choice. |
| F4 | Open — Hetzner included transfer/overage absent from supplied pages. Hetzner FAQ URLs [cloud-server](https://docs.hetzner.com/cloud/servers/faq/#how-much-traffic-is-included) and [cloud-general](https://docs.hetzner.com/cloud/general/faq/#how-much-traffic-is-included) were fetched and inspected October 15, 2026 Chicago time as traffic-source attempts; neither yielded a numeric tariff. Source note for docs/spikes/v3/sources-note is these URLs/date in the ledger; no page is committed. Every table names Git egress. |
| F5 | Fixed — Considered and rejected or deferred alternatives. |
| F6 | Fixed — Hosted hybrid: direct Git, 100-MB zone cap, WebSocket drains. |
| F7 | Fixed — Rented servers/Recovery: separate-provider backup, mirror scope and recovery questions. |
| F8 | Fixed — One codebase, two operating models: abuse, data layout, CPU, runners and dedicated instances. |
| F9 | Fixed — Your questions/Recovery: cheapest, scalable, sustainable, UI, license and funding. |
| F10 | Fixed — Fly: 14-GB volume and exact ten-repository arithmetic. |
| F11 | Fixed — Terms/dates and measurements: Chicago capture versus UTC usage. |
| F12 | Fixed — Rented servers: CPX42 confirmed, USD EU quote and exclusions. |
| F13 | Fixed — Measurements: bounded current component subtotal and missing invoice. |
| F14 | Fixed — Shared scenario and price tables: year-one retained bytes and capacity. |
| F15 | Fixed — Evidence: socket prototype and caveated 94-MB extrapolation. |
| F16 | Fixed — Your questions/Hosted hybrid: app/site/rendering/CDN distinctions. |
| F17 | Fixed — Measurements/Hosted hybrid: allowances shared with v2. |
| F18 | Fixed — Terms table, short answers and tabulated counters. |
| H01 | Fixed — Considered alternatives, shared with F5. |
| H02 | Open in part — Rented server comparison gives smaller, dedicated and bare-metal choices; same-region matched shape quote remains absent, shared with F2. |
| H03 | Fixed — Shared scenarios, runner traffic and growth, shared with F1. |
| H04 | Fixed — Cloudflare hibernating versus resident duration assumptions. |
| H05 | Fixed — Independent Backblaze backup, shared with F7. |
| H06 | Fixed — Rented server/Fly incremental backup and mirror outbound plus full-copy sensitivity. |
| H07 | Fixed — Fly volume formula and corrected arithmetic. |
| H08 | Fixed — Hosted hybrid Git route, shared with F6. |
| H09 | Fixed — One codebase, two operating models, shared with F8. |
| H10 | Fixed — Recovery: budget, region, loss, restore and self-hosted footprint. |
| H11 | Fixed — Terms and Cloudflare billing explanation. |
| H12 | Fixed — Descriptive evidence links and Chicago/UTC dates. |

**Inputs read in full:** this report; both independent hosting-report reviews; supplied Cloudflare, VPS/storage, dual-model and measured-usage notes; earlier platform study, realtime prototype, platform review and cited platform source notes, from the supplied research packet. Only the Hetzner FAQ traffic-source attempts above were made. No experiments were run.
