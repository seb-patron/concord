# Delegated principals API

An authenticated `owner` or `agent` may create runtime principals in its own tenant. All requests use `Authorization: Bearer TOKEN`. Tenant identity comes from that credential. The catalog stores only a SHA-256 token digest; it never stores or lists plaintext tokens. A token starts with `cct_` and contains 32 random bytes encoded as hexadecimal.

## Mint

`POST /v1/principals` accepts JSON:

```json
{"roles":["agent"],"repoIds":["repo-1"],"ttlSeconds":7200,"name":"worker-1","agent":{"model":"m-1","effort":"high","harness":"harness-1","host":"host-1","launchedFrom":"parent-1"}}
```

`roles` is required and nonempty. `agent`, `reviewer`, and `viewer` follow the strict subset rule: every requested role must also be in the caller's roles, an `agent` without `owner` may mint only `agent` and `viewer`, and an owner credential holding only `owner` must be provisioned with additional delegable roles to mint them. `checker` is the single exception: an `owner` may mint `checker` principals without holding that role, so a runner machine can be added at runtime with no redeploy and no `AUTH_TOKENS` change. `owner` and `promoter` are never mintable; promoter credentials are always supplied through `AUTH_TOKENS`. Minted checkers poll and submit jobs exactly like `AUTH_TOKENS` checkers, limited to their `repoIds`.

`repoIds` defaults to the caller's scope and must be its subset. `"*"` is accepted only when the caller also has `"*"`. An explicit repository list may contain at most 100 IDs. `ttlSeconds` defaults to the smaller of 86400 and the trusted maximum, rounded down to seconds; it must be positive, must not exceed that maximum, and the resulting `expiresAt` must be no later than the caller's. A `checker` mint is further bounded at 30 days: its effective maximum is the smaller of the trusted maximum and 2,592,000 seconds, so set `delegatedPrincipals.maxTtlMs` to `2592000000` to allow full 30-day runner tokens. `name` is optional, 1–128 characters. The default maximum TTL is 24 hours. The tenant caps are 100 active and 1000 total minted principals, including revoked and expired rows. The optional integer overrides are `TRUSTED_CONFIG.delegatedPrincipals.maxTtlMs` (at least 1000), `activeLimit` (positive), and `totalLimit` (1–1000). Reaching either cap returns 409 `PRINCIPAL_CAP`. Revocation does not release total capacity; an operator must use a fresh tenant if the lifetime cap is reached.

`agent` is optional self-reported metadata supplied by the minting parent. Concord does not verify it, and it is never used for authorization. The descriptor may include `model` (up to 64 characters), `effort` (16), `harness` (32), `host` (64), and `launchedFrom` (128). Each supplied value must be a nonempty printable string after trimming; control characters are rejected. Values are trimmed before storage. Existing principals without a descriptor continue to have no `agent` field.

The 201 response uses the standard `{data, version, eventSeq}` envelope. `data` contains `id`, `roles`, `repoIds`, `expiresAt`, `parentId`, `createdAt`, `revokedAt`, optional `name`, optional `agent`, and `token`. The plaintext token appears only in this first response. If an `Idempotency-Key` is supplied, repeating it for the same parent returns 409 rather than revealing the token again. Minting records a `principal.minted` catalog event without the token or digest.

## List and revoke

`GET /v1/principals` returns `{data:{items:[...],nextCursor},version,eventSeq}` for the caller's tenant. An owner with `repoIds: "*"` sees all records. Every other caller sees only its own record and descendants it minted whose repository scopes fit within the caller's `repoIds`. Filtering happens before pagination. The response contains at most 25 items per page, in mint order. Pass the opaque `nextCursor` as `?cursor=...` to fetch the next page; `null` means the list is complete. Each item has `id`, `roles`, `repoIds`, `expiresAt`, `parentId`, `createdAt`, `revokedAt`, and optional `name`. Neither tokens nor digests appear. `GET /v1/principals/:id` returns the same public record in the standard envelope when visible; an unknown or hidden ID returns 404 `NOT_FOUND`.

`DELETE /v1/principals/:id` revokes the principal and every descendant; it returns `{data:{revokedIds:[...]},version,eventSeq}`. Owners with `repoIds: "*"` can revoke any principal in their tenant. Repository-scoped owners can revoke only principals visible under the same scope rule as `GET /v1/principals/:id`; a hidden ID returns 404 `NOT_FOUND`. Agents can revoke themselves or a direct child when visible. Revocation records a `principal.revoked` catalog event with affected IDs and no secrets. A revoked or expired token receives 401 on its next request, including existing repository routes. Tokens are never renewable; mint a replacement before expiry.

When a delegated principal with an `agent` descriptor creates a change, the change records `authorModel` from `agent.model` (or `null`) and `authorAgent` with the descriptor fields, `startedAt` from the principal's `createdAt`, and its optional `name`. This metadata appears in change create, get, and list responses and in the repository snapshot projection. Principals without a descriptor produce no `authorAgent` field.

## Tenant events

`GET /v1/events` reads the tenant catalog event log, including `principal.minted` and `principal.revoked`. An authenticated principal needs the `owner` or `viewer` role. This is a separate log from `GET /v1/repos/:id/events`, which reads a repository coordinator. The response uses the same `{data:{items,nextCursor},version,eventSeq}` envelope as repository events. Events are ordered by increasing `sequence`; each item has `sequence`, `kind`, `actorId`, `timestamp`, `version`, `relatedIds`, and `payload`. Mint payloads contain `parentId`, `roles`, `repoIds`, and `expiresAt`; revoke payloads contain `rootId`. Neither event includes plaintext tokens or token digests. An owner with `repoIds: "*"` sees all tenant events. Every other caller sees repository events only within its `repoIds` and principal events only for itself and visible descendants it minted, even if its repository scope is `"*"`. Filtering happens before pagination, so cursors continue across hidden events. Non-owners do not receive storage names in event payloads.

Pass `?cursor=...` using the opaque `nextCursor` to continue; `null` means no more events were present in that page. The optional `limit` is an integer from 1 to 100 and defaults to 100. A malformed cursor returns 400 `INVALID_CURSOR`; an invalid limit returns 400 `INVALID_LIMIT`. To poll from the last event after reaching the end, encode its decimal `sequence` as a URL-safe base64 cursor. The `eventSeq` envelope field is the latest catalog sequence.

Status: validated against main 5b558e0 (the docs-test port-8788 fix).
