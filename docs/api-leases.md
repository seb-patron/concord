# Semantic lease API

Leases are scoped to one `RepoCoordinator` and its trusted policy. Times are server UTC milliseconds. All mutations require a bearer identity, `Idempotency-Key`, and a JSON body. Renew and release also require the coordinator's current `expectedVersion` and the lease's current `fence`.

For a managing agent, call `concord start --repo R --intent-key K --intent TEXT --allowed-files FILE --hold 2h` before editing. Start opens the change and atomically claims whole-file units for the Allowed-files list. Work inside those units, then call `concord land` with the same intent key; land reuses live leases, or claims again after expiry, and the queue reserves their current fences. `concord release --repo R --intent-key K` releases active leases when abandoning the work. This flow needs no coordinator process to renew a two-hour hold.

## Unit identity

The installed owner policy controls all unit identities. Its `units` map registers explicit aliases with a `canonicalKey`, `file`, and `resources` footprint. Aliases with the same canonical key resolve to one unit; conflicting metadata is rejected. A `file:<path>` key is available when its path occurs in trusted metadata, a declared table, or an owner-approved new-file prefix. It covers every symbol, declaration, and TSV row in that file. Separate row resources in one TSV can be leased simultaneously. Unknown keys, including undeclared table names, return `422 UNKNOWN_UNIT`. Agents cannot add tables or claim overrides.

An owner can also declare TSV tables in trusted policy metadata:

```json
"tables": [{
  "name": "families", "file": "families.tsv",
  "header": ["family", "retry_limit", "timeout_ms"],
  "keyColumn": "family", "keySpec": { "charset": "lower", "minLength": 1, "maxLength": 256 }
}]
```

The header is an exact ordered column list. `keyColumn` names one header column. `keySpec` matches the entire key, character by character, with `minLength` at least 1 and `maxLength` at most 256. `charset` is `lower`, `alnum`, `alnum-dash-dot`, or an explicit list of unique printable nonspace ASCII characters. Regular expressions and other fields are rejected. Any matching key, including a key absent from the base table and absent from `units`, identifies `row:<table>:<key>`. Pattern rows have the narrow resource `<file>#<key>`. Explicit registered rows remain supported. A malformed or duplicate row, changed header, missing file, or mode change falls back to the whole-file unit. The checker still verifies exact declared versus inspected units and current lease fences before queue reservation. A file outside trusted policy metadata is rejected. Non-TSV changes use the file footprint.

### Owner file-unit policy generation

An owner may add `"newFilePrefixes": ["src/mother_base/", "tests/"]` to the template or pass a repeatable `--allow-new-under DIR/` flag. Prefixes are normalized relative directories ending in `/`, sorted in the generated policy, and covered by its digest. The generator does not list future files as units. At claim and inspection time, an unregistered `file:<path>` under an approved prefix resolves to a whole-file unit for that exact path. Registered units keep their identity. Claims for the same new path conflict; distinct paths can be leased separately. Paths outside approved prefixes return `UNKNOWN_UNIT`. Use the same flags for generation and read-back comparison. A policy without prefixes retains its existing shape and digest.

The owner runs `runner/generate-units.ts` against an owner checkout and an explicit canonical commit OID. Supply a trusted policy template and the union of planned new paths from **all** runs in the cohort. Each `--allow-path-file` is a plain text list with one exact repository-relative path per line; repeat the flag for multiple launcher specs and use `--allow-path` for individual paths. The template and path lists must come from owner-approved inputs, never a candidate checkout or candidate-authored data. For example:

```sh
./node_modules/.bin/tsx runner/generate-units.ts --repo /owner/checkout --oid 0123456789abcdef0123456789abcdef01234567 \
  --template /owner/policy-template.json --allow-path-file /owner/run-a-paths.txt \
  --allow-path-file /owner/run-b-paths.txt --allow-path future/report.py > /owner/policy-envelope.json
```

The JSON envelope contains `sourceOid`, `generatorVersion`, `policy`, and `policyDigest`. Install its `policy` through the owner's trusted configuration process after reviewing it. `policy.digest` and `policyDigest` are SHA-256 of canonical JSON of the policy **without** its `digest` field. `sourceOid` stays outside the policy, so a later canonical commit with the same tracked path set and approved future paths retains the policy pin. The generator never installs a policy, runs a checker or source file, accesses the network, or mutates Git. It preserves declared TSV row entries, dependencies, and table metadata in the template; it adds whole-file entries for all tracked regular files and approved future paths, including non-TypeScript files.

Paths must be exact, relative, and at most 512 characters, with a `file:` key also at most 512 characters. The generator strictly decodes UTF-8 in the template, path lists, comparison envelope, and Git path output; invalid bytes are rejected before paths or keys are matched. Whitespace, backslashes, empty, `.` or `..` components, `.git` components, and non-NFC names are rejected with the offending path. Tracked symlinks, submodules, other unsupported tree modes, missing dependencies, conflicting unit metadata, and template entries for paths outside the tracked and approved set are errors. A future path is authority to create that exact file only; it does not authorize sibling paths.

After reading back the canonical OID, compare a fresh generation with the previously approved envelope using the same owner template and planned-path union:

```sh
./node_modules/.bin/tsx runner/generate-units.ts --repo /owner/checkout --template /owner/policy-template.json \
  --compare /owner/policy-envelope.json --read-back-oid 0123456789abcdef0123456789abcdef01234567 \
  --allow-path-file /owner/run-a-paths.txt --allow-path-file /owner/run-b-paths.txt \
  --allow-path future/report.py
```

Refresh writes a JSON envelope with `status: "unchanged"` and exits zero when the policy digest matches. It writes `status: "changed"` and exits 1 when it differs; input errors exit 2. It does not hot-install either result. On `changed`, stop admissions and have the owner review and reprovision the trusted policy and its pin before admitting more runs.

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

`ttlSeconds` defaults to 120 and must be an integer from 1 through trusted `costLimits.maxLeaseHoldSeconds` (default 14400 seconds). Ordinary short claims and renewals can continue using 300 seconds. Aliases are canonicalized, duplicates removed, and the final set sorted. At most 64 normalized, pairwise nonoverlapping keys are accepted per claim or change. An over-cap error reports the count and cap and suggests declaring coarser prefix or section units in policy. The repository-wide limit remains 128 live leases. The response is `201` with `data.leases` and `data.renewAfterSeconds: 40`. Every lease carries `leaseId`, canonical `unitKey`, `holderId`, `changeId`, `intentText`, `fence`, `expiresAt`, `state`, and `version`. Keep the returned fence; it changes on renewal and reacquisition. A crashed agent's hold expires without a babysitting process.

A claim requires a ready repository record and a draft or ready change owned by the caller, as reported by the repos change view. A missing repository returns `404 REPO_NOT_FOUND`; a missing change or one the caller cannot claim returns `403 CHANGE_NOT_OWNED`.

If any requested footprint is occupied, **none** of the request's keys are granted. `409 LEASE_CONFLICT` includes the holder ID, holder intent, expiry, conflicting keys, all conflict records, and a next action. The refusal and its intent remain in event history and in the snapshot's recent refusals. `GET /v1/repos/:repoId/leases` returns at most 100 rows per page, with live leases first, followed by historical rows. Follow the opaque `data.nextCursor` with `?cursor=<value>` until it is `null` to reach every lease that remains live until its page is read, then older history. Pages use the immutable creation time and lease ID as a keyset, so releasing a lease already returned does not skip a later live lease or repeat that released row. Historical rows changed after the first page are omitted from that traversal; start a new traversal for the latest history. Each row includes `remainingSeconds`; the page also includes `serverTime` and renewal guidance. `GET /v1/repos/:repoId/snapshot` includes the first lease page and its cursor. `GET /v1/repos/:repoId/events` retains claim, refusal, renewal, expiry, release, and reservation events.

## Renew and release

`POST /v1/repos/:repoId/leases/:leaseId/renew` takes `{ "expectedVersion": 3, "fence": 7, "ttlSeconds": 120 }`. The current holder receives a new fence and expiry computed from server time. Renew near the 40-second guidance; the old fence becomes stale immediately.

`POST /v1/repos/:repoId/leases/:leaseId/release` takes `{ "expectedVersion": 4, "fence": 8 }`. Only the current holder with the current fence can release an active, unexpired lease. An expired, released, or reserved lease, or a stale fence, returns `409 LEASE_STALE`. Expiry is checked during requests, so a delayed alarm cannot extend exclusivity. Alarm replay does not duplicate expiry events. Released and expired rows remain readable.

Closing an unfrozen draft or ready change releases every active or reserved lease whose `changeId` matches that change. Each row is versioned and emits `lease.released` with reason `change-closed`; the close response remains the ordinary change response. Other changes' leases are unaffected.

An owner can recover a lease when its holder cannot release it:

`POST /v1/repos/:repoId/leases/:leaseId/force-release` takes `{ "expectedVersion": 5, "reason": "Holder credential was revoked" }`. `reason` is required and must contain 1 to 500 characters. Only a principal with the `owner` role may call this route; other roles receive `403 FORBIDDEN`. The route releases active and reserved leases regardless of holder or fence. An already released or expired lease returns `409 LEASE_NOT_ACTIVE`. Success increments the lease version and advances the unit's monotonic fence, making operations that use the prior fence stale. It emits `lease.forceReleased` with the actor principal ID, previous holder ID, unit key, change ID, and reason. A force-released queue reservation remains in the queue; its next reservation liveness check fails with `LEASE_STALE`.

## Queue admission handoff

The internal `leases.reserve(context, changeId, leaseFences)` hook runs in the coordinator's synchronous transaction. It fails closed unless the repos module has stored a ready or already queued change under `module:repos:change:<changeId>` and checker evidence under `module:repos:verified:<changeId>`. Evidence must contain `{ changeId, revision, headOid, policyDigest, unitKeys, verifiedBy: "checker" }`, matching that change's exact revision, head, declared units, and the installed policy. Every verified write must be covered by a current lease held by the change author at the supplied fence. A whole-file claim covers all narrower TSV row writes in its file, and the reservation retains that whole-file scope. Undeclared writes are refused. Success converts the selected leases into 30-minute queue reservations and returns `reservationFences`; retrying the same verified reservation returns the same fences without extending its timeout.

The hook `leases.releaseReservation(context, changeId)` accepts only a queue record `module:queue:entry:<changeId>` in `merged` or `withdrawn` state. Queue code must write that terminal state in the same coordinator transaction before calling the hook. Agents cannot release a reservation through the lease route. A reservation also expires after 30 minutes, with or without a timely alarm.

An owner-created contest can share a parent reservation with exactly its recorded children. Queue code records matching `module:queue:contest:<contestId>` and `module:queue:contest-child:<childChangeId>` objects containing `contestId`, `parentChangeId`, `childChangeIds`, `selectedChangeId`, and `ownerCreated: true`. The child still needs its own verified write footprint, and the supplied fences must match the live parent reservation. Once selection is recorded, only the selected child can inherit it. The selected child's terminal queue transition releases the parent reservation. A request body cannot create this exception.

Missing, stale, or ambiguous admission evidence returns a blocked gate; it never grants admission by default.
