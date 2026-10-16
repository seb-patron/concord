# Hosting options review ledger

This ledger tracks the findings in the independent Opus and Astra reviews and the subsequent delta review of [Where Concord should run](../hosting-options.md). “Fixed” identifies the report section with the repair. “Open” identifies evidence or a decision still needed. The delta review classified the original F11, F14, F18 and H03 repairs as incomplete; their rows below describe the final repair. New delta findings are N1–N4.

| Finding | Topic | Disposition and location or reason |
| --- | --- | --- |
| F1 | Busy agent workload | Fixed — **Shared light and busy scenarios** models 900 changes per repository monthly, cached and fresh runner acquisition, and both scenarios in the cost tables. |
| F2 | Comparable machines | Open in part — **Rented servers** compares small and larger hosts and shared versus dedicated CPU. A same-region Fly 8-vCPU/16-GB quote and confirmed small Hetzner shape remain absent from the supplied packet; capacity is unmeasured. |
| F3 | Region and latency | Open in part — **Your questions** and **Recovery and owner decisions** expose the EU-price versus Chicago-latency choice; same-region prices and measured latency are still needed. The earlier report ledger incorrectly called this fully fixed. |
| F4 | Transfer pricing | Open in part — **Cloudflare**, **Rented servers**, **Fly.io** and **Hosted hybrid routing** name Git egress and price known terms. Hetzner's included transfer and overage, and Artifacts transfer terms, are absent from the supplied evidence; no free-transfer claim is made. |
| F5 | Missing architectures | Fixed — **Considered and rejected or deferred** includes Containers, prepared packs, managed databases, bare metal, DigitalOcean and owner hardware. |
| F6 | Cloudflare upload limit | Fixed — **Hosted hybrid routing and UI** gives Git a direct hostname and explains the zone body cap, authentication and reconnect checks. |
| F7 | Independent recovery | Fixed — **Rented servers** and **Recovery and owner decisions** price a separate-provider copy and distinguish the limited GitHub mirror. |
| F8 | Hosted tenancy | Fixed — **One codebase, two operating models** covers selective restore, resource controls, abuse, runner costs and managed instances. |
| F9 | Owner questions | Fixed — **Your questions, short answers** and **Recovery and owner decisions** address cost, sustainability, Cloudflare, hosted/self-hosted models, UI and funding. |
| F10 | Fly volume arithmetic | Fixed — **Fly.io** provisions 14 GB for ten repositories and identifies the former $23.88 result as approximately $24. |
| F11 | Chicago times | Fixed in final repair — **Terms, dates and evidence** now attributes the 38-request hour to 1 p.m. and the five eight-request hours to hours beginning 2–6 p.m. Chicago time. The delta review marked the earlier 1–6 p.m. wording not fixed. |
| F12 | CPX42 quote | Fixed — **Rented servers** states the supported USD EU list price, euro quote, region and exclusions. |
| F13 | Current Cloudflare subtotal | Fixed — **Terms, dates and evidence** gives a conditional subtotal and identifies the $0.15 request charge as after billing-unit rounding. |
| F14 | Year-one growth | Fixed in final repair — **Shared light and busy scenarios** and every year-one Git-traffic table now use 0.8-GB full clones and show 5/22.4 GB cached light/busy traffic per repository. The delta review marked frozen transfer not fixed. |
| F15 | Socket prototype | Fixed — **Terms, dates and evidence** gives the bounded 94-MB extrapolation and its limitation. |
| F16 | UI choices | Fixed — **Hosted hybrid routing and UI** distinguishes the browser app, marketing/docs site, server rendering and CDN delivery. |
| F17 | Shared account allowances | Fixed — **Terms, dates and evidence** and **Hosted hybrid routing and UI** account for the existing Worker during migration. |
| F18 | Owner readability | Fixed in final repair — the report opens with plain answers, defines technical terms and carries no review, issue, pull-request or decision IDs. This ledger holds the finding IDs separately. The delta review marked the previous in-report ledger and missing definitions not fixed. |
| H01 | Missing architectures | Fixed — **Considered and rejected or deferred** separates Git persistence from database hosting and prices the supplied alternatives. |
| H02 | VPS selection | Open in part — **Rented servers** compares small, larger, dedicated and bare-metal choices, but a matched same-region capacity and cost comparison still needs quotes and measurements. |
| H03 | Git workload | Fixed in final repair — **Shared light and busy scenarios** includes runner acquisitions and year-one clone growth, carried into **Fly.io** and the other transfer tables. The delta review marked year-one transfer not fixed. |
| H04 | Durable Object duration | Fixed — **Cloudflare as a stateful Git server** states work hours, messages, processing, hibernation and residency; final repair corrects decimal memory and million-unit rounding. |
| H05 | Backup independence | Fixed — **Rented servers** uses a separate-provider copy and identifies the narrower same-provider protection. |
| H06 | Fly backup outbound | Fixed — **Rented servers** and **Fly.io** count incremental backup and mirror uploads, and price the conditional daily full-copy example. |
| H07 | Fly provisioned volume | Fixed — **Fly.io** reconciles provisioned sizes, snapshots and the old ten-repository calculation. |
| H08 | Hybrid push route | Fixed — **Hosted hybrid routing and UI** bypasses the Cloudflare proxy for Git and states the authentication and origin implications. |
| H09 | Hosted tenant isolation | Fixed — **One codebase, two operating models** compares shared hosting with per-customer managed instances and names unimplemented controls. |
| H10 | Recovery and footprint questions | Fixed — **Recovery and owner decisions** asks about budget, region, data loss, restoration, tenancy and supported installs. |
| H11 | Technical definitions | Fixed — **Terms, dates and evidence** defines the runtime, database, CDN, packs, hibernation, billing units, Artifacts, static assets, clone and fetch. |
| H12 | Evidence traceability | Fixed — **Terms, dates and evidence** has a descriptive source index and distinguishes Chicago capture dates from UTC usage counters. |
| N1 | Year-one clone transfer | Fixed — **Shared light and busy scenarios** gives 5/22.4 GB cached and 724.4 GB fresh busy per repository at year one; every affected egress table uses those values. **Fly.io** shows about $426/$774 at 1,000 repositories. |
| N2 | Duration conversion | Fixed — **Cloudflare as a stateful Git server** states 128 MB = 0.128 decimal GB, 368,640/110,592,000/331,776,000 GB-seconds, and billed excess of $1,387.50/$4,150 after million-unit rounding. |
| N3 | Rounding errors | Fixed — **Terms, dates and evidence** labels $0.15 as a rounded request charge; **Cloudflare** gives ~$48 for 100 light year-one repositories; **Fly.io** gives ~$16 for one busy year-one repository. |
| N4 | Report readability | Fixed — finding IDs and the ledger moved here; **Terms, dates and evidence** restores missing definitions, and the report uses words for owner decisions. |

Open rows require new quotes, measurements or an owner choice; the report labels those uncertainties and makes no capacity promise. No web research or deployment was part of this repair.
