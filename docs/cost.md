# Cost guards before public deployment

Workers Paid has no hard account spending cap. These limits reduce exposure; an owner must still monitor usage and can stop traffic by deleting the Worker.

| Guard | Default and scope | Response |
| --- | --- | --- |
| Worker CPU | Production: `limits.cpu_ms: 30000` ms (Cloudflare's default); local: `limits.cpu_ms: 100` ms | Platform CPU limit |
| Auth failures | 20 failed or missing bearer requests per `cf-connecting-ip` per 60 seconds, using the Cloudflare Rate Limiting binding before any Durable Object call. Valid principals do not consume this quota. | `429 RATE_LIMITED` |
| Request body | 256 KiB for `/v1/*`, checked from `Content-Length` and the bounded stream before forwarding to a Durable Object. | `413 BODY_TOO_LARGE` |
| Repos | 100 created repos per tenant, including provisioning and blocked repos. Existing repo retries remain available. | `429 TENANT_REPO_LIMIT` |
| Artifacts forks | 1,000 fork creation reservations per tenant, retained for the tenant lifetime, including closed or failed changes. The tenant catalog reserves before creating each new fork. Existing change retries do not reserve again. | `429 TENANT_FORK_LIMIT` |
| Artifacts token mints | 1,000 authorized `/git-token` and runner credential mint attempts per tenant per UTC day, reserved in the tenant catalog before the provider call. Failed provider attempts consume quota. | `429 TENANT_TOKEN_LIMIT` |
| Repo reads | Repo detail, canonical tree/file/README, branch, change list and change detail reads reuse the repo's tenant catalog record for up to 60 seconds. Delegated principal revocation is checked on every request through a digest-indexed catalog lookup. | No API change |
| Metrics | Event appends maintain daily metric rollups in shards of 256 events. A metrics request reads the rollup rows of the days in its window (about one row per 256 events) instead of scanning the event table repeatedly. | No API change |
| Alarms | At least 1000 ms after a successful alarm run; failures back off exponentially from 1000 ms to 60 seconds. No pending deadline means no alarm. The floor survives intervening requests. | No API change |

Production uses Cloudflare's default 30-second CPU limit because the 100 ms limit reset `concord-v2` snapshot and runner poll requests (#76). Issue #69 shrinks job records that currently carry full policy copies, reducing the work in each scan.

Only the operator-owned `TRUSTED_CONFIG` secret may override the tenant defaults, with positive safe integers no greater than 10,000:

```json
{ "costLimits": { "maxReposPerTenant": 100, "maxForksPerTenant": 1000, "maxTokenMintsPerTenantPerDay": 1000 } }
```

Add `costLimits` alongside the existing `policies` and `profiles` fields. Client request bodies cannot set these values. Failed fork provisioning attempts consume a reservation, because the provider may have retained the fork. The cap is lifetime based, so the owner must provision a new tenant or add verified provider cleanup after exhausting it. Provider tokens issued implicitly during repository creation or forking are not counted in the mint quota. The rate limit is per client IP, so many IPs can still generate billable Worker invocations. `/health` remains a cheap unauthenticated check, and assets use the `ASSETS` binding without Worker invocation because `run_worker_first` remains limited to `/v1/*` and `/health`.

## CPU selection evidence

On 2026-10-11, a fresh local run completed the documented `preflight`, `seed`, `scene context`, `scene leases`, `scene stack`, and `inspect` commands with `cpu_ms: 100` in `wrangler.local.jsonc`. The Worker log recorded 134 API requests, with a maximum of 1,067 ms elapsed on bootstrap; that duration includes provider I/O and is not CPU time. A bounded Workers test sampled 21 individual repo create/list/detail and change create/close requests with `performance.now()`; the maximum elapsed time was 29 ms. The local test runtime's `process.cpuUsage()` throws `The process.cpuUsage method is not implemented`, and local observability spans expose elapsed duration only. Thus direct per-invocation CPU measurement was unavailable. We chose 100 ms, a 71 ms (3.4×) margin over the measured test-request elapsed maximum, and confirmed that the entire documented flow passes at that configured limit. This is the lowest limit evaluated for the full flow, not a measured CPU minimum. Before public traffic, inspect production per-invocation CPU and lower the limit if a smaller value passes the same flow.

## Owner dashboard actions

1. In the Cloudflare account dashboard, use **Notifications → Add → Billable Usage** for a Workers usage notification and **Notifications → Add → Budget Alert** for a small account dollar threshold. Confirm the billing email receives alerts, then review **Manage Account → Billing → Billable Usage** after the demo. Alerts inform; they do not stop billing. [Cloudflare usage notification guide](https://developers.cloudflare.com/billing/understand/usage-based-billing/) and [budget alert guide](https://developers.cloudflare.com/billing/manage/budget-alerts/).
2. Create the Wrangler Workers Admin token with only the required account permissions and an explicit short TTL or expiration date. In the dashboard, use **My Profile → API Tokens** for a user token or **Manage Account → Account API tokens** for an account token; set the TTL/expiration during creation. Let the token expire after the demo, or revoke it earlier. [Cloudflare API token guide](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).
3. On teardown, run `npx wrangler delete --config wrangler.jsonc` with owner authorization, then verify the Worker is gone and the Admin token has expired or been revoked. Review Artifacts repositories and active Git tokens separately; deleting the Worker does not by itself erase those resources.

Status: Validated against main `5b558e0` (the docs-test port-8788 fix).

Delegated `cct_` principals are resolved from the tenant catalog by token digest on every request, so revocation takes effect on the next request.
