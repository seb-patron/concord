# Delegated principals API

An authenticated `owner` or `agent` may create runtime principals in its own tenant. All requests use `Authorization: Bearer TOKEN`. Tenant identity comes from that credential. The catalog stores only a SHA-256 token digest; it never stores or lists plaintext tokens. A token starts with `cct_` and contains 32 random bytes encoded as hexadecimal.

## Mint

`POST /v1/principals` accepts JSON:

```json
{"roles":["agent"],"repoIds":["repo-1"],"ttlSeconds":7200,"name":"worker-1"}
```

`roles` is required, nonempty, and limited to `agent`, `reviewer`, and `viewer`. Every requested role must also be in the caller's roles. An `agent` without `owner` may mint only `agent` and `viewer`; `checker` and `promoter` are always supplied through `AUTH_TOKENS`. In particular, an owner credential that has only the `owner` role must be provisioned with additional delegable roles before it can mint them. This follows the strict subset rule.

`repoIds` defaults to the caller's scope and must be its subset. `"*"` is accepted only when the caller also has `"*"`. `ttlSeconds` defaults to the smaller of 86400 and the trusted maximum, rounded down to seconds; it must be positive, must not exceed that maximum, and the resulting `expiresAt` must be no later than the caller's. `name` is optional, 1–128 characters. The default maximum TTL is 24 hours and the default tenant cap is 100 active minted principals. The only overrides are `TRUSTED_CONFIG.delegatedPrincipals.maxTtlMs` (at least 1000) and `TRUSTED_CONFIG.delegatedPrincipals.activeLimit` (positive), both integers.

The 201 response uses the standard `{data, version, eventSeq}` envelope. `data` contains `id`, `roles`, `repoIds`, `expiresAt`, `parentId`, `createdAt`, `revokedAt`, optional `name`, and `token`. The plaintext token appears only in this first response. If an `Idempotency-Key` is supplied, repeating it for the same parent returns 409 rather than revealing the token again. Minting records a `principal.minted` catalog event without the token or digest.

## List and revoke

`GET /v1/principals` returns `{data:{items:[...]},version,eventSeq}` for the caller's tenant. Each item has `id`, `roles`, `repoIds`, `expiresAt`, `parentId`, `createdAt`, `revokedAt`, and optional `name`. Neither tokens nor digests appear.

`DELETE /v1/principals/:id` revokes the principal and every descendant; it returns `{data:{revokedIds:[...]},version,eventSeq}`. Owners can revoke any principal in their tenant; agents can revoke themselves or a direct child. Revocation records a `principal.revoked` catalog event with affected IDs and no secrets. A revoked or expired token receives 401 on its next request, including existing repository routes. Tokens are never renewable; mint a replacement before expiry.
