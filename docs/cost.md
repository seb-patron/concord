# Cost guards before public deployment

Workers Paid has no hard account spending cap. These limits reduce exposure; an owner must still monitor usage and can stop traffic by deleting the Worker.

| Guard | Default and scope | Response |
| --- | --- | --- |
| Worker CPU | `limits.cpu_ms: 5000` per invocation in `wrangler.jsonc` | Platform CPU limit |
| Auth failures | 20 failed or missing bearer requests per `cf-connecting-ip` per 60 seconds, using the Cloudflare Rate Limiting binding before any Durable Object call. Valid principals do not consume this quota. | `429 RATE_LIMITED` |
| Request body | 256 KiB for `/v1/*`, checked from `Content-Length` and the bounded stream before forwarding to a Durable Object. | `413 BODY_TOO_LARGE` |
| Repos | 100 created repos per tenant, including provisioning and blocked repos. Existing repo retries remain available. | `429 TENANT_REPO_LIMIT` |
| Artifacts token mints | 1,000 authorized `/git-token` and runner credential mint attempts per tenant per UTC day, reserved in the tenant catalog before the provider call. Failed provider attempts consume quota. | `429 TENANT_TOKEN_LIMIT` |
| Alarms | At least 1000 ms after a successful alarm run; failures back off exponentially from 1000 ms to 60 seconds. No pending deadline means no alarm. The floor survives intervening requests. | No API change |

Only the operator-owned `TRUSTED_CONFIG` secret may override the tenant defaults, with positive safe integers no greater than 10,000:

```json
{ "costLimits": { "maxReposPerTenant": 100, "maxTokenMintsPerTenantPerDay": 1000 } }
```

Add `costLimits` alongside the existing `policies` and `profiles` fields. Client request bodies cannot set these values. Provider tokens issued implicitly during repository creation or forking are controlled by the repo and active change limits and are not counted in the mint quota. The rate limit is per client IP, so many IPs can still generate billable Worker invocations. `/health` remains a cheap unauthenticated check, and assets use the `ASSETS` binding without Worker invocation because `run_worker_first` remains limited to `/v1/*` and `/health`.

## CPU selection evidence

The local Workers target completed 181 tests in 4.46 seconds of suite wall time with the production CPU setting at 5000 ms; the five cost guard tests completed in 0.71 seconds when run alone. The documented demo's first full-suite run exercised Worker requests up to 916 ms of logged wall time, but stopped at the original 100-token quota. Local wall time is only a proxy for invocation CPU. The 5000 ms setting is a provisional ceiling at the task's maximum, not a measured minimum. Before public traffic, the owner should inspect per-invocation CPU in Workers observability during the documented demo and reduce `cpu_ms` if its maximum supports a lower ceiling. Do not raise it above 5000 for this demo.

## Owner dashboard actions

1. In the Cloudflare account dashboard, use **Notifications → Add → Billable Usage** for a Workers usage notification and **Notifications → Add → Budget Alert** for a small account dollar threshold. Confirm the billing email receives alerts, then review **Manage Account → Billing → Billable Usage** after the demo. Alerts inform; they do not stop billing. [Cloudflare usage notification guide](https://developers.cloudflare.com/billing/understand/usage-based-billing/) and [budget alert guide](https://developers.cloudflare.com/billing/manage/budget-alerts/).
2. Create the Wrangler Workers Admin token with only the required account permissions and an explicit short TTL or expiration date. In the dashboard, use **My Profile → API Tokens** for a user token or **Manage Account → Account API tokens** for an account token; set the TTL/expiration during creation. Let the token expire after the demo, or revoke it earlier. [Cloudflare API token guide](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).
3. On teardown, run `npx wrangler delete --config wrangler.jsonc` with owner authorization, then verify the Worker is gone and the Admin token has expired or been revoked. Review Artifacts repositories and active Git tokens separately; deleting the Worker does not by itself erase those resources.

Status: Validated against main `5b558e0` (the docs-test port-8788 fix).
