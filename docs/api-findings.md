# Findings and repair rounds

Findings belong to a change, not to a commit. Each finding receives a server-generated stable `findingId`, its `originRevision`, a semantic `unitKey` and `semanticAnchor`, and a SHA-256 evidence digest. `semanticAnchor.kind: "unit"` names the same key as `unitKey`; `"unknown"` keeps an unattributable concern visible and blocking. Optional `path` and positive `line` are display hints. Moving text, renaming a path, or publishing a new head does not delete or resolve a finding.

All routes are under `/v1/repos/:repoId/changes/:changeId`. Mutations use JSON, `Idempotency-Key`, and the current repository `expectedVersion`. The authenticated principal supplies author and reviewer identity. The repos `readChange` view supplies authoritative author, head, revision, status, and freeze state; request bodies cannot override them. A pending queue promotion also rejects mutations at the coordinator with `409 PROMOTION_IN_PROGRESS`.

## List and create

`GET .../findings?cursor=...` returns `{items, findingSetVersion, nextCursor}` with at most 100 chronological findings per page. Resolved and reopened findings retain their original ID and `originRevision`. `GET .../snapshot` includes `projections.findings.items`, `rounds`, and a `findingSetVersions` map for the UI. An uninitialized repository snapshot reports findings as unavailable until its first versioned mutation. The repository event endpoint retains the append-only evidence history.

An independent reviewer creates a finding on the current ready revision:

```json
{
  "expectedVersion": 12,
  "revision": 2,
  "unitKey": "row:alpha",
  "text": "The alpha row loses its required value",
  "evidenceDigest": "sha256:<64 lowercase hex digits>",
  "semanticAnchor": { "kind": "unit", "key": "row:alpha", "path": "families.tsv", "line": 18 }
}
```

When `semanticAnchor` is omitted, the server stores `{ "kind": "unit", "key": "<unitKey>" }`. To record a concern whose semantic location is unknown, supply `{ "kind": "unknown", "key": "<reviewer label>" }`; it remains open and gates approval until reviewed resolution. A reviewer reopens a resolved finding with `POST .../findings`, the same fields plus `reopenFindingId`. The unit key and semantic anchor kind/key must match the original; path and line hints, text, and evidence digest may change. Reopening increments `findingSetVersion` and appends `finding.reopened` with both prior and new evidence digests. The original creation and resolution events remain intact.

## Submit one complete repair

Only the change author may submit `POST .../repairs`. The body must name the current revision, current finding set version, and **exactly one** disposition for every open finding:

```json
{
  "expectedVersion": 17,
  "revision": 2,
  "findingSetVersion": 3,
  "dispositions": [
    { "findingId": "<finding-id-1>", "explanation": "Restored the required value", "evidenceDigest": "sha256:<64 lowercase hex digits>" },
    { "findingId": "<finding-id-2>", "explanation": "Updated the dependent check", "evidenceDigest": "sha256:<64 lowercase hex digits>" }
  ]
}
```

The `201` response contains the pending round with its numbered `number`, `roundId`, head OID, revision, finding set version, exact finding IDs, and all dispositions. Findings remain open. Omitted, extra, or duplicate IDs return `409 FINDINGS_MISMATCH`; stale revision or finding set version returns `409`. These failures create no round or finding state change. A second complete submission while an active round is pending returns `409 REPAIR_PENDING`.

## Review the whole round

An independent reviewer calls `POST .../repairs/:number/review` with `expectedVersion`, `revision`, `findingSetVersion`, `decision: "accept" | "reject"`, and `evidenceDigest`. The reviewer cannot be the change author, even if that identity holds both roles. The route compares the stored submission's head OID, revision, finding set version, and full open ID set to current state before deciding.

Acceptance resolves all findings in one transaction and increments the finding set version once. Rejection resolves none; the author can submit the next numbered round. A new finding or a changed head invalidates pending resolution and returns `409 ROUND_STALE` on review. The gate no longer reports that stale round as pending. A subsequent complete submission receives the next number and records `repair.invalidated` for the old round. Historical rounds remain in the repository snapshot; stale pending rounds are projected there as `invalidated`. A second review with a new idempotency key returns `409 ROUND_CLOSED` (or stale version); replaying the exact key and body returns the original response without another event.

`findings.gate(changeId, revision)` returns the current `findingSetVersion`, all `unresolvedIds`, and the active `pendingRound` number or `null`. It blocks a missing or stale change view. Queue and verdict modules use this live snapshot; verdict approval requires no unresolved IDs and no active pending round. Resolved findings survive later revisions, but a later reopening creates a new evidence event, increments the finding set version, and blocks the previous verdict.
