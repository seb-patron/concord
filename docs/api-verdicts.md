# Review verdicts and carry

Verdicts bind an independent reviewer to the exact bytes and trusted dependency scope inspected for one change revision. The commit OID is audit identity; it is not the approval key. All mutation bodies use `Idempotency-Key` and `expectedVersion`. The authenticated principal supplies reviewer identity. The author cannot list, create, or request carry even if that principal also has a reviewer role.

## Evidence and pins

The verdict service reads the current change through `readChange`, the finding snapshot through `findings.gate`, and a trusted inspection record from its own state. An API caller supplies only the inspection's `reviewManifestDigest`; it cannot submit a manifest or choose a dependency scope. The trusted inspector must register an `InspectedRevision` for the current revision and head in the verdict namespace. Until that integration exists, approval and carry fail with `REVIEW_REQUIRED` or `MODULE_UNAVAILABLE`. The runner is responsible for authenticating the live job claim and verifying referenced Git objects before calling `verdicts.evaluateCarry`.

`ReviewManifest` is hashed as UTF-8 SHA-256 of canonical JSON: object keys sorted, changed units sorted by `unitKey`, and dependency entries sorted by `unitKey`. Every changed unit includes its before and after path, Git mode, and SHA-256 digest of its bytes. Complete coverage includes the full transitive dependency closure from the owner-controlled `TrustedPolicy`; undeclared, duplicate, or missing entries are invalid. Policy version/digest and checker, oracle, and toolchain digests are part of the hash. Whitespace and mode changes therefore change approval identity. Policy resources without representable unit digests require unknown whole-tree coverage. Unknown coverage can be directly reviewed but never authorizes automatic carry.

## Endpoints

`GET /v1/repos/:repoId/changes/:changeId/verdicts?cursor=...` returns chronological verdict history in pages of at most 100. Old verdicts remain visible after a revision, finding, or pin change. `POST` on the same path creates `approve` or `reject` for the current trusted inspection and exact finding-set version:

```json
{
  "expectedVersion": 12,
  "revision": 1,
  "reviewManifestDigest": "sha256:<64 lowercase hex digits>",
  "findingSetVersion": 0,
  "decision": "approve",
  "evidenceDigest": "sha256:<64 lowercase hex digits>"
}
```

Missing inspection, a forged digest, unresolved findings, a pending repair, changed pins, or self-review cannot create an eligible approval. `verdicts.gate(changeId, revision)` checks active head/revision, its inspected manifest and trusted pins, and the live finding-set version each time queue admission or promotion freeze calls it. A later finding invalidates an earlier approval even if already resolved. The gate does not waive full composed-stack validation.

`POST /v1/repos/:repoId/changes/:changeId/carry` requests a new checker job:

```json
{
  "expectedVersion": 18,
  "parentVerdictId": "original-verdict-id",
  "revision": 2,
  "newBaseOid": "1111111111111111111111111111111111111111"
}
```

The server requires the parent approval to be the active verdict and a current inspected candidate whose base equals `newBaseOid`, and verifies that OID against canonical `main`. The `202` response contains `jobId`, `parentVerdictId`, and `status: "pending"`. The immutable `delta-check` job includes candidate base/head/ref/storage, old verdict and manifest, finding-set version, expected refs, full trusted policy, and profile/checker/oracle/toolchain/environment pins. The checker must recompute bytes and dependencies against the new base and run the pinned affected-unit check. The runner validates job ID, input digest, live attempt/fence, result digest, pins, and Git objects before dispatch. The verdict hook independently compares result evidence to the stored request, current inspection, finding snapshot, and active verdict. If a reviewer issues another verdict while the job is pending, the result requires fresh review and cannot replace that verdict.

### Exact carry example

Trusted policy declares `row:alpha` in `families.tsv` with no dependency on `row:beta`. The reviewer approves revision 1 with alpha before/after byte hashes, path `families.tsv`, mode `100644`, and an empty dependency scope. Another change advances `main` by editing beta. A rebuilt alpha candidate at revision 2 has a new commit OID and base OID, but the same alpha before/after bytes and mode. A fenced delta result has the same manifest digest, empty dependency-scope digest, no new findings, and `PASS` from the affected-unit checker. The service creates a new approval with `parentVerdictId` set to the revision-1 verdict and `deltaResultId` set to the delta job ID. The original verdict stays in the list. Queue admission and promotion still require their normal full-stack check.

### Exact invalidation example

Trusted policy declares `row:gamma` dependent on `row:beta`. A reviewer approves gamma at revision 1 while beta's dependency digest is `sha256:<old-beta-bytes>`. Beta then advances on `main`. Even if gamma's own patch text and after bytes are identical, the delta manifest contains `sha256:<new-beta-bytes>` for beta. The manifest digest differs, so the result is `REVIEW_REQUIRED` with a dependency/content explanation. The old verdict remains history. The same outcome applies to changed whitespace, path or mode, a checker/oracle/toolchain pin, unknown coverage, semantic conflict resolution reported by a non-green check, or a new finding. No patch ID or commit equality shortcut is used.
