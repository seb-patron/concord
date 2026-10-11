# Semantic lease API

Leases are scoped to one `RepoCoordinator` and its trusted policy. Times are server UTC milliseconds. All mutations require a bearer identity, `Idempotency-Key`, and a JSON body. Renew and release also require the coordinator's current `expectedVersion` and the lease's current `fence`.

## Unit identity

The installed policy's `units` map is the only registry. Each alias has a `canonicalKey`, `file`, and `resources` footprint. Aliases with the same canonical key resolve to one unit; conflicting metadata is rejected. A `file:<path>` key is available only when that exact path occurs in trusted metadata. It covers every registered symbol, declaration, and TSV row in the file. Separate row resources in one TSV can be leased simultaneously. An unknown key, including an unregistered file key, returns `422 UNKNOWN_UNIT`. There is no free-form unit or claim override.

The helper `changedUnitsForFile` compares complete TSV rows by the first tab-separated field. It returns registered row identities for changed rows. New, duplicate, malformed, ambiguous, or otherwise unmapped row changes use the trusted file footprint. A file absent from the policy cannot be mapped and is rejected. Non-TSV changes use the file footprint. General language parsing is outside this policy.

## Claim and inspect

`POST /v1/repos/:repoId/leases` accepts:

```json
{
  "changeId": "change-1",
  "unitKeys": ["row:families:alpha"],
  "intentText": "Replace alpha's implementation",
  "ttlSeconds": 120
}
```

`ttlSeconds` defaults to 120 and must be an integer from 1 through 300. Aliases are canonicalized, duplicates removed, and the final set sorted. At most 16 normalized, pairwise nonoverlapping keys are accepted. The response is `201` with `data.leases` and `data.renewAfterSeconds: 40`. Every lease carries `leaseId`, canonical `unitKey`, `holderId`, `changeId`, `intentText`, `fence`, `expiresAt`, `state`, and `version`. Keep the returned fence; it changes on renewal and reacquisition.

A claim requires a ready repository record and a draft or ready change owned by the caller, as reported by the repos change view. A missing repository returns `404 REPO_NOT_FOUND`; a missing change or one the caller cannot claim returns `403 CHANGE_NOT_OWNED`. Until the repos module registers its change view, claims return `501 MODULE_UNAVAILABLE`.

If any requested footprint is occupied, **none** of the request's keys are granted. `409 LEASE_CONFLICT` includes the holder ID, holder intent, expiry, conflicting keys, all conflict records, and a next action. The refusal and its intent remain in event history and in the snapshot's recent refusals. `GET /v1/repos/:repoId/leases` returns at most 100 rows per page, with live leases first, followed by historical rows. Follow `data.nextCursor` with `?cursor=<value>` until it is `null` to reach every live lease and older history. Each row includes `remainingSeconds`; the page also includes `serverTime` and renewal guidance. `GET /v1/repos/:repoId/snapshot` includes the first lease page and its cursor. `GET /v1/repos/:repoId/events` retains claim, refusal, renewal, expiry, release, and reservation events.

## Renew and release

`POST /v1/repos/:repoId/leases/:leaseId/renew` takes `{ "expectedVersion": 3, "fence": 7, "ttlSeconds": 120 }`. The current holder receives a new fence and expiry computed from server time. Renew near the 40-second guidance; the old fence becomes stale immediately.

`POST /v1/repos/:repoId/leases/:leaseId/release` takes `{ "expectedVersion": 4, "fence": 8 }`. Only the current holder with the current fence can release an active, unexpired lease. An expired, released, or reserved lease, or a stale fence, returns `409 LEASE_STALE`. Expiry is checked during requests, so a delayed alarm cannot extend exclusivity. Alarm replay does not duplicate expiry events. Released and expired rows remain readable.

## Queue admission handoff

The internal `leases.reserve(context, changeId, leaseFences)` hook runs in the coordinator's synchronous transaction. It fails closed unless the repos module has stored a ready or already queued change under `module:repos:change:<changeId>` and checker evidence under `module:repos:verified:<changeId>`. Evidence must contain `{ changeId, revision, headOid, policyDigest, unitKeys, verifiedBy: "checker" }`, matching that change's exact revision, head, declared units, and the installed policy. Every verified write must be covered by a current lease held by the change author at the supplied fence. Extra fenced claims and undeclared writes are refused. Success converts the selected leases into 30-minute queue reservations and returns `reservationFences`; retrying the same verified reservation returns the same fences without extending its timeout.

The hook `leases.releaseReservation(context, changeId)` accepts only a queue record `module:queue:entry:<changeId>` in `merged` or `withdrawn` state. Queue code must write that terminal state in the same coordinator transaction before calling the hook. Agents cannot release a reservation through the lease route. A reservation also expires after 30 minutes, with or without a timely alarm.

An owner-created contest can share a parent reservation with exactly its recorded children. Queue code records matching `module:queue:contest:<contestId>` and `module:queue:contest-child:<childChangeId>` objects containing `contestId`, `parentChangeId`, `childChangeIds`, `selectedChangeId`, and `ownerCreated: true`. The child still needs its own verified write footprint, and the supplied fences must match the live parent reservation. Once selection is recorded, only the selected child can inherit it. The selected child's terminal queue transition releases the parent reservation. A request body cannot create this exception.

The repos and queue modules are placeholders in this slice. The admission records above are an internal integration seam, exercised by fake records in the lease tests. Missing, stale, or ambiguous evidence returns a blocked gate; it never grants admission by default.
