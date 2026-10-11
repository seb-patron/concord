# Delegated principals API

An authenticated `owner` or `agent` may create runtime principals in its own tenant. All requests use `Authorization: Bearer TOKEN`. Tenant identity comes from that credential. The catalog stores only a SHA-256 token digest; it never stores or lists plaintext tokens. A token starts with `cct_` and contains 32 random bytes encoded as hexadecimal.

## Mint

`POST /v1/principals` accepts JSON:

```json
{"roles":["agent"],"repoIds":["repo-1"],"ttlSeconds":7200,"name":"worker-1"}
```

`roles` is required, nonempty, and limited to `agent`, `reviewer`, and `viewer`. Every requested role must also be in the caller's roles. An `agent` without `owner` may mint only `agent` and `viewer`; `checker` and `promoter` are always supplied through `AUTH_TOKENS`. In particular, an owner credential that has only the `owner` role must be provisioned with additional delegable roles before it can mint them. This follows the strict subset rule.

`repoIds` defaults to the caller's scope and must be its subset. `"*"` is accepted only when the caller also has `"*"`. An explicit repository list may contain at most 100 IDs. `ttlSeconds` defaults to the smaller of 86400 and the trusted maximum, rounded down to seconds; it must be positive, must not exceed that maximum, and the resulting `expiresAt` must be no later than the caller's. `name` is optional, 1–128 characters. The default maximum TTL is 24 hours. The tenant caps are 100 active and 1000 total minted principals, including revoked and expired rows. The optional integer overrides are `TRUSTED_CONFIG.delegatedPrincipals.maxTtlMs` (at least 1000), `activeLimit` (positive), and `totalLimit` (1–1000). Reaching either cap returns 409 `PRINCIPAL_CAP`. Revocation does not release total capacity; an operator must use a fresh tenant if the lifetime cap is reached.

The 201 response uses the standard `{data, version, eventSeq}` envelope. `data` contains `id`, `roles`, `repoIds`, `expiresAt`, `parentId`, `createdAt`, `revokedAt`, optional `name`, and `token`. The plaintext token appears only in this first response. If an `Idempotency-Key` is supplied, repeating it for the same parent returns 409 rather than revealing the token again. Minting records a `principal.minted` catalog event without the token or digest.

## List and revoke

`GET /v1/principals` returns `{data:{items:[...],nextCursor},version,eventSeq}` for the caller's tenant. It returns at most 25 items per page, in mint order. Pass the opaque `nextCursor` as `?cursor=...` to fetch the next page; `null` means the list is complete. Each item has `id`, `roles`, `repoIds`, `expiresAt`, `parentId`, `createdAt`, `revokedAt`, and optional `name`. Neither tokens nor digests appear.

`DELETE /v1/principals/:id` revokes the principal and every descendant; it returns `{data:{revokedIds:[...]},version,eventSeq}`. Owners can revoke any principal in their tenant; agents can revoke themselves or a direct child. Revocation records a `principal.revoked` catalog event with affected IDs and no secrets. A revoked or expired token receives 401 on its next request, including existing repository routes. Tokens are never renewable; mint a replacement before expiry.

## Tenant events

`GET /v1/events` reads the tenant catalog event log, including `principal.minted` and `principal.revoked`. An authenticated principal needs the `owner` or `viewer` role. This is a separate log from `GET /v1/repos/:id/events`, which reads a repository coordinator. The response uses the same `{data:{items,nextCursor},version,eventSeq}` envelope as repository events. Events are ordered by increasing `sequence`; each item has `sequence`, `kind`, `actorId`, `timestamp`, `version`, `relatedIds`, and `payload`. Mint payloads contain `parentId`, `roles`, `repoIds`, and `expiresAt`; revoke payloads contain `rootId`. Neither event includes plaintext tokens or token digests. A principal with a restricted `repoIds` scope sees catalog repository events only for those repositories, plus principal events for itself and principals it minted. Filtering happens before pagination, so cursors continue across hidden events. Non-owners do not receive storage names in event payloads.

Pass `?cursor=...` using the opaque `nextCursor` to continue; `null` means no more events were present in that page. The optional `limit` is an integer from 1 to 100 and defaults to 100. A malformed cursor returns 400 `INVALID_CURSOR`; an invalid limit returns 400 `INVALID_LIMIT`. To poll from the last event after reaching the end, encode its decimal `sequence` as a URL-safe base64 cursor. The `eventSeq` envelope field is the latest catalog sequence.

Status: validated against main 5b558e0 (the docs-test port-8788 fix).
