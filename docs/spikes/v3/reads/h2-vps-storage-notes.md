# Hetzner Cloud
URL: https://www.hetzner.com/cloud/
Fetched: 2026-10-16 00:06:45 UTC; method: `curl -L --fail --silent --show-error https://www.hetzner.com/cloud/ -o "$DELEGATE_SCRATCH_DIR/hetzner-cloud.html"`
Raw SHA-256: dd9a724e5333bcd80e279476f8a6a85af62b4f1b9323cf120e1bbb0b85d68562
Extracted words: 1433 (`wc -w "$DELEGATE_SCRATCH_DIR/hetzner-cloud.txt"`; visible HTML text after stripping script/style/svg tags and markup and collapsing whitespace)
Read status: read in full
## Sections
1. **Cloud / Affordable Cloud Hosting Services.** Hetzner presents a simple, flexible cloud aimed at demanding projects. The captured page includes general product marketing and points to the console and cost calculator.
2. **Benefits of the Hetzner Cloud.** The page advertises cost calculation, German hosting, GDPR compliance, network/API features, and one-click apps. These are service claims, not measured performance guarantees.
3. **Which Hetzner Cloud Server is right for you?** It describes cost-optimized shared resources for low CPU use and medium-traffic applications, regular shared performance for low-to-medium CPU use, and general-purpose dedicated vCPUs for sustained high CPU and high traffic. The fetched HTML exposes no actual vCPU, memory, or price values: each tier's price is rendered only as “starting from max/mo.”
4. **Shared vs. Dedicated Cloud: Which resources are suitable for your setup?** Shared plans are characterized for variable, low-to-moderate workloads; dedicated plans promise unshared, predictable CPU for production and higher traffic. A forge with concurrent fetches, pack generation, SQLite and WebSockets needs capacity monitoring before choosing shared resources.
5. **The cost check for your cloud server.** The page introduces a cost calculator but provides no calculated amount or itemized rate in the captured text.
6. **Everything you need, included.** The page groups the cloud's included management and network capabilities; it does not list quantitative caps here.
7. **API.** Cloud infrastructure can be managed through a REST API and CLI, supporting automated provisioning. This can make separate instances or backups easier to operate, but does not define git traffic limits.
8. **Integrations.** It names Python, Go, Ansible, Terraform, and Kubernetes integrations for automation. These are relevant to deployment and scaling workflows, not a substitute for storage and egress planning.
9. **Networks.** Private networks connect servers and can isolate a database from public access. A Concord server plus a separately managed database or worker could use this boundary.
10. **Firewalls.** Stateful firewalls block unwanted inbound and outbound traffic by rules and are described as having no additional cost. Egress allow/deny rules can constrain services but do not reduce legitimate clone traffic.
11. **Images.** Linux distributions including Ubuntu, Debian, and Fedora are available. The page does not specify image sizes or storage billing in this section.
12. **It's so easy to get started / Your own cloud server in just a few steps.** Instances are ordered and configured through the console and become usable quickly. This supports a simple self-hosted install path but says nothing about migration or backups.
13. **Save time with one-click apps.** Hetzner says cloud servers include free one-click applications and lists Docker, GitLab CE, Grafana, and others. This suggests a low-friction self-hosting baseline; Concord would still need its own safe upgrade and persistent-data procedure.
14. **Data traffic in price comparison: how to save on traffic / With Hetzner, you benefit from high inclusive traffic.** The page claims generous included transfer and low additional-transfer prices, but the fetched text contains no GB allowance or overage rate. Git clone/fetch egress therefore cannot be budgeted from this page's captured content.
15. **Locations worldwide.** Cloud servers are offered in Germany, Finland, Singapore, and the USA, with named sites in Germany, Finland, Oregon, and Virginia. Regional placement can reduce latency for users and keep a hosted service nearer its repository operators.
16. **Maximum data security.** The page cites GDPR compliance and ISO/IEC 27001 certification for German and Finnish data-center parks. This is useful context for hosted customer metadata but is not a claim about Concord's application security.
17. **Our performance promise: 99.9% uptime and 24/7 support.** Hetzner advertises a 99.9% SLA, service credits, 24/7 email support, and C5 certification. Availability commitments do not replace application-level replication and tested recovery.
## What it means for Concord v3
The page supports a single Bun/git/SQLite VPS as a low-cost self-hosted starting shape, with shared plans aimed at variable loads and dedicated vCPUs aimed at sustained production. Its pricing widgets render as “starting from max/mo.” with no numeric values, vCPU/RAM sizes, included traffic quantity, or overage rate. The separately listed Hetzner price-adjustment source in these notes gives current Germany/Finland examples: shared CX23 €5.49/month (€0.0088/hour) and dedicated-vCPU CCX13 €42.99/month (€0.0689/hour), both excluding VAT and IPv4; that page also lacks bandwidth allowance and egress rates. Therefore git clone/fetch egress cannot be budgeted from these sources. The cloud page describes no object-storage offering; use the separate Object Storage source for history-growing archives and backups. WebSocket limits and static-asset delivery limits/prices are also absent. One-click apps and API/CLI support ease hosting, while private networks can isolate SQLite if services are later separated.

# Hetzner Object Storage
URL: https://www.hetzner.com/storage/object-storage/
Fetched: 2026-10-16 00:07:37 UTC; method: `curl -L --fail --silent --show-error https://www.hetzner.com/storage/object-storage/ -o "$DELEGATE_SCRATCH_DIR/hetzner-object.html"`
Raw SHA-256: 26a0382e718de3adeeb3f65cf3fa0834329f6e118e55de4a8055c1760ba48e4b
Extracted words: 1872 (`wc -w "$DELEGATE_SCRATCH_DIR/hetzner-object.txt"`; visible HTML text after stripping script/style/svg tags and markup and collapsing whitespace)
Read status: read in full
## Sections
1. **Object Storage / Object Storage that grows with your needs.** Hetzner describes S3-compatible object storage for data-intensive workloads and says accounts can create up to 100 buckets, each up to 100 TB. Objects combine payload, metadata, and an ID, making the product oriented toward large unstructured data.
2. **Benefits.** Listed features include access from anywhere, object locking, optional server-side encryption, pre-signed URLs, versioning, and automatic expiry. These support backup retention and serving artifacts, though object lock/versioning can increase retained bytes.
3. **The solution for your requirements.** Use cases include backup/restore, archiving, big-data analytics, cloud-native application storage, and digital asset management. The page stresses that S3 compatibility does not make every workload suitable for this specific implementation.
4. **Start your Project and scale as you grow.** Hetzner promotes creating a bucket and scaling storage with demand. The page's stated maximums are 100 buckets and 100 TB per bucket; its FAQ further states 50 million objects per bucket.
5. **Maximum GDPR-compliant data security.** The provider claims GDPR compliance and describes German-headquartered operations. This may matter for hosted repository backups, but the page does not describe Concord's encryption-key or tenant-isolation design.
6. **Frequently asked questions — use cases.** The S3 interface is described as compatible with modern applications and tools, with an explicit caveat that not all S3 workloads fit. Check API behavior and service limits before putting a live Git object database here.
7. **Locations.** The offered locations are Falkenstein (FSN1), Helsinki (HEL1), and Nuremberg (NBG1). Keeping backups in a separate location from the VPS can improve failure isolation, subject to restore bandwidth and data-residency needs.
8. **Storage amount.** Limits are 100 buckets, 100 TB per bucket, and 50 million objects per bucket. These are ceilings, not a guarantee of efficient operation for millions of tiny Git objects.
9. **Pricing structure.** The embedded pricing data gives a €6.49/month or $7.99/month base, including 1 TB storage (up to 744 TB-hours) and 1 TB egress. Excess storage is €6.26/TB-month or $8.86/TB-month, and excess egress is €1/TB or $1.20/TB (exclusive of VAT); actual partial-month usage is hourly.
10. **Pay-as-you-go / base price billing.** Billing is hourly whenever at least one bucket is active, even when empty, capped at the monthly base price of €6.49 or $7.99. The base includes the quotas above.
11. **Free traffic.** Ingress, traffic within the eu-central network zone, and S3 API calls such as PUT, GET, and DELETE are stated to be free. This makes uploads/backups and same-zone application reads potentially inexpensive; public downloads still consume egress quota.
12. **Quota carryover.** Unused monthly included storage and traffic expire rather than rolling over. Bursty Git backup egress therefore cannot bank allowance for a later month.
13. **Exceeding included quota.** Excess storage is €6.26/TB-month or $8.86/TB-month, and excess egress €1/TB or $1.20/TB, exclusive of VAT. Billing precision is four decimal places (example: 1.2345 TB).
14. **Quota scope.** Included allowances apply across all buckets in the account, not separately to each bucket. A shared backup bucket can therefore use one common allowance.
15. **Storage measurement.** Usage is TB-hours: 1 TB held one hour equals 1 TB-h; 10 TB for five hours equals 50 TB-h. Long-lived Git history and retained pack snapshots accumulate duration-weighted storage usage.
16. **Small objects.** Billing has a 64 KB minimum object size, so a 10 KB object is billed as 64 KB. Storing each tiny loose Git object independently could incur substantial minimum-size overhead; packed repositories or larger backup archives better match this model.
17. **Requirements poll.** The page asks expected storage, simultaneous connections, and bandwidth, offering ranges from under 10 to over 10,000 connections and under 1 Gbit/s to over 10 Gbit/s. These are survey choices, not published service connection or throughput limits.
18. **Why Hetzner?** The provider describes its scale, history, energy practices, transparency, and price-performance positioning. These are company claims rather than service-level measurements.
## What it means for Concord v3
Object Storage is a candidate for versioned repository backups or packed archival snapshots, rather than the live SQLite database or git repository unless the implementation is verified against the service's S3 limitations. Capacity is capped at 100 TB per bucket and 50 million objects; 64 KB minimum billed size makes individual loose Git objects a poor fit. The base is €6.49/month or $7.99/month and includes 1 TB storage (up to 744 TB-hours) plus 1 TB egress; excess storage costs €6.26/TB-month or $8.86/TB-month, and egress €1/TB or $1.20/TB, excluding VAT. Ingress, eu-central internal traffic, and S3 calls are free; unused quotas expire monthly. Public clone/fetch downloads from stored objects count toward egress; static UI asset delivery also consumes egress, while same-zone VPS reads may be free internal traffic. WebSocket connections belong on the Concord server; the page's connection ranges are only a survey and imply no limit or guarantee.

# Hetzner Price Adjustment 15 June 2026
URL: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
Fetched: 2026-10-16 00:07:55 UTC; method: `curl -L --fail --silent --show-error https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ -o "$DELEGATE_SCRATCH_DIR/hetzner-adjust.html"`
Raw SHA-256: f90c6af94f040676618865121902fb3ac650d64db1443b55eb7b65eab42527b2
Extracted words: 1198 (`wc -w "$DELEGATE_SCRATCH_DIR/hetzner-adjust.txt"`; visible HTML text after stripping script/style/svg tags and markup and collapsing whitespace)
Read status: read in full
## Sections
1. **Hetzner Price Adjustment 15 June 2026.** New orders and cloud resizes moved to adjusted pricing on 15 June 2026 at 08:00 CEST. Some legacy-server changes can trigger current pricing; orders placed before the date but delivered later retain previous prices. The page's last change date is 8 July 2026.
2. **Dedicated servers.** The page lists monthly and one-time setup fees excluding IPv4 and VAT, across multiple server families and regions. Representative regular Falkenstein/Helsinki choices include AX42-1 at €97.30/month plus €49 setup and EX63-1 at €147.30/month plus €74 setup; limited offers depend on supply, e.g. AX41-1-LTD at €57.30/month with no setup fee. These are physical dedicated server plans, not VPS equivalents.
3. **Limited offerings.** Limited pricing depends on available hardware and lasts only while supply remains; service/support are described as regular. Auction prices are demand-based. A hosted forge should not treat these scarce offers as a stable capacity commitment.
4. **Cloud servers — Germany/Finland (FSN/NBG/HEL).** New monthly prices excluding IPv4 and VAT include CX23 €5.49, CX33 €8.49, CX43 €15.99, CX53 €29.49; CPX22 €19.49, CPX32 €35.49, CPX42 €69.49, CPX52 €100.49, CPX62 €129.99; CAX11 €5.99, CAX21 €10.49, CAX31 €20.99, CAX41 €40.99; CCX13 €42.99, CCX23 €85.99, CCX33 €138.49, CCX43 €275.99, CCX53 €533.49, CCX63 €853.49. The table also gives hourly rates and USD prices; this page gives no vCPU/RAM mapping.
5. **Cloud servers — USA (ASH/HIL).** Prices exclude IPv4 and VAT. Examples in USD/month: CCX13 $50.99, CCX23 $102.99, CCX33 $165.99; CPX11 $20.49, CPX21 $37.49, CPX31 $73.49, CPX41 $141.49, CPX51 $279.49. The document includes hourly rates and euro prices too.
6. **Cloud servers — Singapore (SIN).** Prices exclude IPv4 and VAT. Examples in USD/month: CCX13 $63.49, CCX23 $127.99, CCX33 $205.99; CPX12 $17.99, CPX22 $30.99, CPX32 $57.99, CPX42 $109.99, CPX52 $158.49, CPX62 $202.99. The table also includes hourly rates and euro prices.
## What it means for Concord v3
The Germany/Finland list provides concrete reference prices: CX23 costs €5.49/month or €0.0088/hour; dedicated-vCPU CCX13 costs €42.99/month or €0.0689/hour, excluding VAT and IPv4. Larger CCX instances rise to €853.49/month; this source gives no memory/vCPU mapping, traffic allowance, or egress charge, so it cannot alone establish capacity or bandwidth cost. Prices vary by region (CCX13 is $50.99/month in the US and $63.49 in Singapore). Dedicated CPU may give more predictable headroom for concurrent pack generation and WebSocket/event workloads; repository history storage and clone/fetch transfer remain separate cost drivers. IPv4 and VAT exclusions must be included in budgeting. Limited dedicated-server offers are not dependable hosted-service capacity.

# Fly.io Resource Pricing
URL: https://fly.io/docs/about/pricing/
Fetched: 2026-10-16 00:08:24 UTC; method: `curl -L --fail --silent --show-error https://fly.io/docs/about/pricing/ -o "$DELEGATE_SCRATCH_DIR/fly-pricing.html"`
Raw SHA-256: c5c808e1616d6d0e2ac71bae6f331d6a74c6894c55aa0cd27b4def0e643ff325
Extracted words: 2991 (`wc -w "$DELEGATE_SCRATCH_DIR/fly-pricing.txt"`; visible HTML text after stripping script/style/svg tags and markup and collapsing whitespace)
Read status: read in full
## Sections
1. **Fly.io Resource Pricing / Everything we bill for.** Prices are USD and regional; the table uses Ashburn/Secaucus as low-cost examples. No monthly platform charge; a 256 MB shared-cpu-1x Machine costs $2.19 per 30 days running continuously, a 512 MB version $3.69, 1 GB $6.70, shared-cpu-2x/2 GB $13.39, performance-1x/2 GB $33, and performance-2x/4 GB $66. Billing is by the second, so 31-day months cost more; additional RAM is $6/GB-month.
2. **What does a typical app cost?** Examples model continuous Machines, volumes, managed database, and assumed traffic, not bundled quotas. A small web app plus Managed Postgres totals $43.67/month. Auto-stop can reduce runtime cost, but stopped rootfs remains billed.
3. **A small web app with Managed Postgres.** Example line items: $3.69 Machine, 10 GB volume at $1.50, $38 Basic Managed Postgres, 1 GB database storage at $0.28, and 10 GB outbound at $0.20. Same-region app/database transfer and shared IPv4 are free.
4. **A Discord bot or background worker running 24/7.** A 256 MB Machine costs $2.19 and 1 GB outbound adds $0.02, totaling $2.21. This demonstrates that clone/fetch traffic is an extra bill.
5. **An app running in three regions.** Example 1 GB Machines cost $6.70 in Ashburn, $7.73 Frankfurt, and $8.50 Singapore. Public egress is $0.02/GB in North America/Europe and $0.04/GB in Singapore's region group; cross-region private transfer is charged in both directions at the source-region rate.
6. **Is there a free tier?** New organizations have no free tier or monthly allowance; trial is up to two hours of Machine runtime or seven days. Inbound traffic, shared IPv4/IPv6, first 10 GB monthly volume snapshots, and first ten single-host certificates are free. Cheapest always-on app is $2.19 per 30 days plus egress.
7. **How it works.** Billing is per organization and based on provisioned resources prorated by time. Automated scaling limits may apply; organizations generally need a credit card.
8. **Compute.** Started and stopped Machine billing differs; stopped Machines still incur root filesystem charges. Shared and performance CPU are separate classes.
9. **Started Fly Machines / Stopped Fly Machines.** Stopped rootfs is $0.15/GB/month. Image root filesystem size therefore costs money even when compute is stopped.
10. **Machine reservation blocks.** Annual prepayment buys credits equivalent to a 40% compute discount for eligible shared or performance usage in one region. Credits cover CPU/additional RAM and do not roll over.
11. **Managed Postgres.** Basic starts at $38/month; Performance reaches $1,922/month; storage is $0.28/GB-month by usage. The database persists outside its app, so deleting an app does not delete the database.
12. **Persistent Storage Volumes / Volumes.** Volumes cost $0.15/GB-month of provisioned capacity, prorated hourly, whether attached, detached, or attached to stopped Machines. A repository volume is charged for reserved capacity as history grows.
13. **Volume Snapshots.** Since 1 January 2026, snapshots cost $0.08/GB-month with 10 GB free monthly, prorated hourly. New volumes default to daily snapshots with five-day retention; billing uses actual incrementally stored bytes.
14. **Network prices / Anycast IP addresses.** Apps receive shared IPv4 and unlimited Anycast IPv6; dedicated IPv4 costs $2/month.
15. **Managed SSL certificates.** Single-host certificates cost $0.10/month, wildcard $1/month, with first ten single-host certificates per organization free. This matters if hosted tenants use custom domains.
16. **Data transfer pricing.** Inbound and same-region transfer are free (same-region rule for granular-rate organizations). Internet egress/inter-region private transfer rates are North America/Europe $0.02/GB and $0.006/GB; Asia Pacific/Oceania/South America $0.04/GB and $0.015/GB; Africa/India $0.12/GB and $0.050/GB. Organizations created after 18 July 2024 use granular rates; older organizations may differ, and opting in is irreversible.
17. **Static Egress IPs for Machines.** Static IPv4+IPv6 pair costs $0.005/hour (~$3.60/month); Machines lack one by default. Useful for outbound allowlists to a GitHub mirror.
18. **Support.** Community support is included; Standard is $29/month, Premium $199/month, Enterprise starts at $2,500/month.
19. **Fly Kubernetes.** Managed Kubernetes costs $75/month per cluster, with compute and volumes billed separately.
20. **Extensions.** Third parties such as Tigris and Upstash set list prices billed through Fly; transfer to them is billed separately.
21. **Unsupported Products / Unmanaged Fly Postgres (Unsupported).** Self-managed Postgres uses normal Machine and volume rates; examples are about $2/month for a single-node dev setup and $82–$164/month for a three-node always-on production setup.
22. **Legacy plans / Related reading.** Legacy plans retain discontinued terms; linked pages explain those plans and billing but details are not inline here.
## What it means for Concord v3
Fly offers regional deployment with no platform fee, but metered local storage and egress make a growing Git forge's history and clone/fetch traffic explicit costs. A 256 MB always-on Machine starts at $2.19/30 days; 1 GB is $6.70. Volumes are $0.15/GB-month, snapshots $0.08/GB-month after 10 GB free, and outbound data $0.02/GB in North America/Europe or $0.04/GB in Asia Pacific; inbound pushes are free. No WebSocket connection limit or Git performance guarantee is stated. Static UI assets and repeated clones also consume public egress. Same-region app transfer is free, while cross-region replicas add transfer charges. Single VPS storage may be simpler for bundled git+SQLite; regional replicas can improve latency but add cost.

# B2 Cloud Storage Pricing | Backblaze
URL: https://www.backblaze.com/cloud-storage/pricing
Fetched: 2026-10-16 00:08:58 UTC; method: `curl -L --fail --silent --show-error https://www.backblaze.com/cloud-storage/pricing -o "$DELEGATE_SCRATCH_DIR/backblaze.html"`
Raw SHA-256: 505d7c78604cb899dff7ca75e9385b326f41a0572d0eb0a43c1c2a2814bd9696
Extracted words: 1295 (`wc -w "$DELEGATE_SCRATCH_DIR/backblaze.txt"`; visible HTML text after stripping script/style/svg tags and markup and collapsing whitespace)
Read status: read in full
## Sections
1. **B2 Cloud Storage Pricing / Always-Hot Cloud Storage, Predictably Priced.** B2 standard storage starts at $6.95/TB per 30 days, billed monthly by byte-hours or annually for 1–5-year capacity commitments. First 10 GB storage is free; the page says there are no minimum file-size or storage-duration fees.
2. **Backblaze B2.** The product targets active archive, backup/recovery, compliance, media, and app storage. It offers free egress up to 3× average monthly stored data, then $0.01/GB; many named CDN/compute partners allow unlimited free egress. API calls are free except Class D at $0.004 per 10,000 calls after first 2,500/day free.
3. **Backblaze B2 Overdrive.** Starts at $15/TB/month and targets high-throughput workloads. It includes unlimited egress to any destination and dedicated vaults/private-network integration; a multi-petabyte commitment is required.
4. **Workload calculator / comparison.** The calculator compares stored TB/PB and monthly egress against providers and labels egress as free up to 3× stored volume. The sample comparison is for the US West region and assumptions vary, so it is not a universal quote.
5. **Pricing models / Fundamentals.** Monthly and annual terms are shown. Monthly includes first 10 GB storage free, free 3× egress, no minimum file-size/duration fees, and no-cost Class A/B/C calls; Class D is $0.004 per 10,000 with 2,500 calls/day free. Support, implementation, and migration are add-ons or commitment-dependent; annual terms require 1–5 years and invoice billing.
6. **How Backblaze built high performance for low cost.** The page attributes costs to specialized focus, commodity hardware and software design, and scale. These are provider explanations, not independent benchmarks.
7. **FAQs — Overdrive.** Overdrive is described as an option for throughput-intensive AI/ML, HPC, analytics, media, and research workloads; the FAQ repeats its $15/TB/month starting price and unlimited egress.
8. **How B2 is billed.** Standard B2 is billed monthly by bytes stored per hour at $6.95/TB/30 days; annual commitment prepays the selected term and locks the rate.
9. **Unlimited free egress.** Standard B2 can use named CDN/compute partners including Fastly, Cloudflare, bunny.net, CacheFly, CoreWeave, Equinix Metal, Vultr, and phoenixNAP for unlimited free egress; Overdrive has unlimited egress to any destination.
10. **3x free egress.** The allowance is three times average monthly storage, calculated from byte-hours. Additional standard egress costs $0.01/GB; Overdrive is unlimited to any destination.
11. **Rate comparisons / affordability.** The page advises matching comparisons to actual data and workloads, and attributes lower pricing to its service focus, commodity systems, and exabyte scale. No latency, object-count, or connection limits are given on the page.
## What it means for Concord v3
B2 is a concrete object-store option for growing history archives and packed repository backups: $6.95/TB per 30 days, with 10 GB free and no small-object minimum or minimum duration. Standard free egress equals 3× average stored TB; above that it is $0.01/GB, while CDN/compute partner routes such as Cloudflare permit unlimited free egress. Git clone/fetch delivery through a supported CDN could therefore control bandwidth cost, though cache invalidation and authorization for private repositories need design. Static UI assets also suit a CDN route. Class A/B/C API calls are free; Class D is $0.004/10,000 after 2,500 daily free. The page gives no cap on WebSocket connections; keep live event sockets on the application server rather than object storage. Overdrive at $15/TB/month with unlimited egress targets multi-petabyte throughput and is excessive absent that scale.

# Droplet Pricing | DigitalOcean
URL: https://www.digitalocean.com/pricing/droplets
Fetched: 2026-10-16 00:09:12 UTC; method: `curl -L --fail --silent --show-error https://www.digitalocean.com/pricing/droplets -o "$DELEGATE_SCRATCH_DIR/do-droplets.html"`
Raw SHA-256: 00c03f3f0c80ad73237771b0974b4336035b856ed8dc3bb005c33d7693ff318c
Extracted words: 3361 (`wc -w "$DELEGATE_SCRATCH_DIR/do-droplets.txt"`; visible HTML text after stripping script/style/svg tags and markup and collapsing whitespace)
Read status: read in full
## Sections
1. **Droplet Pricing / Droplets.** Per-second Droplet billing began 1 January 2026, with a 60-second or $0.01 minimum. Bundled plans have monthly caps; configurable v5 plans bill resources by time used.
2. **Choose the right Droplet type / Basic Droplets.** Shared CPU suits bursty work. Starting 512 MiB/1 vCPU/10 GiB SSD/500 GiB transfer costs $4/month ($0.00595/hour); plans include 1 GiB/$6, 2 GiB/1 vCPU/$12, 2 GiB/2 vCPU/$18, and up to 16 GiB/8 vCPU/$96. Included transfer rises from 500 to 6,000 GiB.
3. **CPU-Optimized Droplets.** Dedicated CPU with 2:1 RAM-to-vCPU ratio; Premium offers NVMe and up to 10 Gbps outbound. Plans range from 2 vCPU/4 GiB/25 GiB disk/$42/month to 48 vCPU/96 GiB/600 GiB/$1,008, with 4,000–11,000 GiB transfer.
4. **General Purpose Droplets.** Dedicated CPU with balanced memory for production; Premium adds NVMe and up to 10 Gbps outbound. Plans range from 2 vCPU/8 GiB/25 GiB disk/$63/month with 4,000 GiB transfer to 40 vCPU/160 GiB/500 GiB/$1,260 with 9,000 GiB.
5. **Memory-Optimized Droplets.** Eight GiB RAM per vCPU and NVMe target memory- and transaction-heavy workloads. Plans start at 2 vCPU/16 GiB/$84/month and reach 32 vCPU/256 GiB/$1,344, with 4,000–10,000 GiB transfer.
6. **Storage-Optimized Droplets.** NVMe plans target disk performance; e.g. 2 vCPU/16 GiB/300 GiB disk/$131/month and 32 vCPU/256 GiB/4,690 GiB/$2,096, with transfer from 4,000–10,000 GiB.
7. **v5 Droplets.** Fifth-generation AMD EPYC machines allow independent CPU, RAM, and boot disk configuration with hourly billing. Shared v5 supports bursty work; General Purpose v5 offers dedicated CPU and 2×–8× RAM per vCPU. Example starts: $0.181/hour for high-traffic APIs (4 vCPU/16 GB dedicated), $0.052/hour pipelines, $0.024/hour agent tooling, and $0.36/hour high-throughput services (8 vCPU/32 GB dedicated, scale to 64 vCPU/512 GB).
8. **Additional product pricing.** Percentage backups cost 20% of Droplet price weekly or 30% daily; usage backup starts at $0.01/GiB-month with up-to-four-hour frequency and 3-day to 6-month retention. Snapshots cost $0.06/GB-month.
9. **Droplets specific questions — What is a DigitalOcean Droplet? / difference between Droplet and VPS / IaaS or PaaS?** Droplets are Linux virtual machines and are the provider's VPS/IaaS; customers manage OS, applications, and data.
10. **Operating systems / IP address FAQs.** Linux choices include Ubuntu, CentOS, Debian, Fedora, and CoreOS. Droplets get public IPv4; Floating IPs support availability. Bundled IPv4 is included; v5 IPv4 is separately listed at a current $0/hour introductory rate subject to change; private Droplets can omit public IPv4.
11. **Storage / bandwidth FAQs.** Droplets use SSD and can add Block Storage. Outbound transfer starts at 500 GiB/month depending on plan; inbound is free. The fetched page gives no overage price.
12. **Cost, billing, and free trial FAQs.** Bundled plans start at $4/month and have a monthly cap; both plan types use per-second billing with 60-second minimum, while v5 is usage-based without a 672-hour cap. Promotional credits may be offered, but no permanent free tier is specified.
13. **Use cases / e-commerce / provider comparisons.** Suggested workloads include web apps, databases, CI/CD, VPNs, games, and AI. The page describes Droplets as suitable for e-commerce and simpler than hyperscalers, without independent comparison data.
14. **Creation, connection, management, locations FAQs.** Creation is through the control panel; SSH is used to connect. Core Droplets are unmanaged; managed Kubernetes is offered separately. Locations span North America, Europe and Asia, including London and Bangalore.
15. **v5 vs bundled plans / billing statement.** v5 uses 5th Gen AMD EPYC with a claimed up-to-30% per-core improvement based on internal testing and independent resource configuration. Bundled plans have fixed ratios; v5 resource rates are itemized in the control panel and combined on the invoice.
16. **Frequently asked questions — payments, tax, resource destruction, alerts, credits, marketplace, prepayment, refunds.** Monthly invoices are generally charged on the first; threshold billing, taxes, alerts, and deletion documentation are described. Example $5 promotional credit lasts 90 days and unused amount expires; Marketplace apps incur underlying compute; prepayment requires sales contact and refunds are generally unavailable.
## What it means for Concord v3
Basic offers a $4/month VPS with 1 vCPU, 512 MiB RAM, 10 GiB SSD and 500 GiB monthly transfer; 2 GiB/2 vCPU, 50 GiB SSD and 2,000 GiB transfer is $18/month. Dedicated CPU production starts at $42/month (2 vCPU/4 GiB) CPU-Optimized or $63/month (2 vCPU/8 GiB) General Purpose; Premium network speed reaches 10 Gbps. Included transfer scales by plan and inbound is free, but this page gives no overage price. Growing Git history consumes finite boot SSD or separately purchased Block Storage; backup is 20–30% of Droplet cost or from $0.01/GiB-month and snapshots are $0.06/GB-month. Aggregate Git clone/fetch and static UI egress must fit included transfer. No WebSocket limit is stated. One unmanaged Droplet suits self-hosting; hosted service requires backup automation and likely dedicated CPU for pack generation and event fanout.

# Spaces Object Storage Pricing | DigitalOcean
URL: https://www.digitalocean.com/pricing/spaces-object-storage
Fetched: 2026-10-16 00:09:57 UTC; method: `curl -L --fail --silent --show-error https://www.digitalocean.com/pricing/spaces-object-storage -o "$DELEGATE_SCRATCH_DIR/do-spaces.html"`
Raw SHA-256: 5fb3f1a1eb153e59b38c7d8c006a5d0dac3137f8955928e31e021515b2de7cd4
Extracted words: 1153 (`wc -w "$DELEGATE_SCRATCH_DIR/do-spaces.txt"`; visible HTML text after stripping script/style/svg tags and markup and collapsing whitespace)
Read status: read in full
## Sections
1. **Spaces Object Storage Pricing / Spaces Object Storage.** Spaces is S3-compatible object storage with integrated CDN for web content, images, media, backups, archives, and static files. The included plan is $5/month for one bucket; up to 100 buckets are available.
2. **Included and additional usage.** The $5 plan includes 250 GiB storage and 1 TiB outbound transfer. Additional standard storage is $0.02/GiB, outbound transfer $0.01/GiB, and cold storage $0.007/GiB. There is no free tier beyond the included paid-plan allowance.
3. **Frequently asked questions — payment, billing and taxes.** Payment options are listed; billing is monthly, generally invoiced on the first, with possible threshold charges and jurisdiction-dependent taxes. Card preauthorization may occur but is released.
4. **Resource deletion / billing alerts.** Documentation covers destroying Spaces and other resources; users can set emailed spending thresholds. Storage cleanup and bill monitoring remain operator responsibilities.
5. **$5 free credit.** The example promotional credit is valid for 90 days and expires unused; it is not an ongoing free service tier.
6. **Marketplace apps / payment methods / prepayment / refunds.** Marketplace apps charge underlying compute. Removing the default payment method is not permitted through the described flow; prepayment requires sales contact and refunds are generally unavailable.
## What it means for Concord v3
Spaces could hold public static UI assets and downloadable packed repository archives behind its built-in CDN: $5/month includes 250 GiB and 1 TiB outbound, then storage is $0.02/GiB and transfer $0.01/GiB; cold storage is $0.007/GiB. Public clone/fetch downloads can consume the transfer pool, so private repository authorization and cache behavior need careful design before serving Git packs from the CDN. The CDN suits static assets and can reduce Bun server load. WebSocket events still need the application server. The 100-bucket maximum is ample for partitioning, but no object-count, WebSocket, or request-rate limit is stated. There is no special free tier; the included allowance requires the $5/month plan.

## Source index
| URL | Extracted words | Read status | Page date or retrieval date |
|---|---:|---|---|
| https://www.hetzner.com/cloud/ | 1433 | read in full | Retrieved 2026-10-16 |
| https://www.hetzner.com/storage/object-storage/ | 1872 | read in full | Retrieved 2026-10-16 |
| https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ | 1198 | read in full | Page last changed 2026-07-08; retrieved 2026-10-16 |
| https://fly.io/docs/about/pricing/ | 2991 | read in full | Retrieved 2026-10-16 |
| https://www.backblaze.com/cloud-storage/pricing | 1295 | read in full | Retrieved 2026-10-16 |
| https://www.digitalocean.com/pricing/droplets | 3361 | read in full | Retrieved 2026-10-16 |
| https://www.digitalocean.com/pricing/spaces-object-storage | 1153 | read in full | Retrieved 2026-10-16 |
