# Local platform development

Use Node 22 or newer. In a fresh checkout, `sh scripts/validate.sh` installs the pinned lockfile with `npm ci --no-audit --no-fund` and then runs TypeScript and every implemented local test. For interactive development:

```sh
npm ci --no-audit --no-fund
npm run dev
```

Wrangler serves the local Worker, SQLite Durable Objects, and static shell without an account. The local configuration selects the in-process fake provider. Visit `/health` to see the mode. Local fixture bearer identities are `local-owner`, `local-agent-a`, `local-agent-b`, `local-agent-c`, `local-contest-low`, `local-contest-high`, `local-mock-aw`, `local-reviewer`, `local-checker`, `local-promoter`, and `local-viewer`; they are accepted only in local mode. Example:

```sh
curl -H 'Authorization: Bearer local-owner' http://127.0.0.1:8787/v1/repos/demo/snapshot
curl -H 'Authorization: Bearer local-viewer' 'http://127.0.0.1:8787/v1/repos/demo/events?after=0'
```

The other repository routes deliberately return `501 MODULE_UNAVAILABLE`. Nothing can approve, resolve, schedule a promotion, or advance `main` in this slice. Production configuration declares an Artifacts binding and static assets but is not deployed; `src/storage/artifacts.ts` is an unavailable adapter until slice 02. The fake remote is `fake://`, an identifier only. It has no smart HTTP transport and does not emulate Artifacts. Slice 02 replaces `src/storage/bridge.ts` with an HTTP adapter to a loopback Node Git bridge over local bare repositories. The Worker must never use `fs` or `child_process` to implement that seam.

Trusted policy and profile records come from a server-controlled `TRUSTED_CONFIG` JSON secret. Local mode uses `local-demo` fixture records when that secret is absent. The fixture loader rejects production mode. Do not put fixture bearer tokens or trusted configuration in `wrangler.jsonc`.

The TenantCatalog dispatches `POST /v1/repos` to the repos module. Its `GET /v1/repos` reads the repos module state key `catalog:index` as `Repo[]`, filtered to the authenticated tenant and repo allowlist, in pages of 100. Slice 02 must update this index when it records provisioning and status. The repo coordinator stores its tenant/repo identity on first access so alarms retain the correct scope after restart.

## Add one module

Each `src/features/*.ts` module is already imported by `src/coordinator.ts`. Replace its placeholder route handlers, `migrations`, `onAlarm`, `nextDeadline`, `snapshot`, and typed `hooks` in that module file. A migration has a module-local version and SQL `CREATE TABLE`/`CREATE INDEX` statements with the module name as prefix, such as `leases_claims`. `applyMigrations` tracks versions in SQLite and rejects unprefixed schema changes. Use `context.transaction(() => { ... })` for synchronous read/check/write work; fully consume SQL cursors before awaiting an external call. Use `context.state` for module-prefixed JSON state, `context.nextVersion()` and `context.appendEvent()` for durable transitions. `nextDeadline()` returns the module's earliest pending timer; the coordinator schedules the one DO alarm and calls every `onAlarm()` handler. A module's `snapshot()` is picked up automatically, so no central projection switch needs editing. Internal cross-module calls go through `context.call()` and return an eligible or blocked gate with version and evidence IDs. Unknown and unavailable outcomes stay blocked.

Run a specific Workers test with `npm run test:target -- tests/workers/name.test.ts`; a `tests/node/` path selects the Node project. Both projects are discovered by the full `npm test` gate. The `cli/`, `runner/`, `local/`, `adapters/`, `replay/`, `demo/`, and `deploy/` TypeScript trees are already included in typechecking when later slices create them. Reserved commands in `package.json` point to their future entrypoints.

## Cross-module hooks

The coordinator asks `queue.promotionFreeze(context, request)` before dispatching each non-GET/HEAD repository route. Slice 04 registers this synchronous provider on the queue module and reads its durable promotion ticket state through the queue context. It returns `{ frozen: true }` while promotion is pending or reconciling. It may return `{ frozen: true, exempt: true }` for the trusted promoter's own `POST /v1/repos/:repoId/jobs/:jobId/result`; the coordinator also checks that exact route and the `promoter` role. When no provider is registered, the slice-01 queue placeholder reports `{ frozen: false }`. A frozen request receives `409 PROMOTION_IN_PROGRESS` before its module handler runs.

Slice 02 registers `repos.changeView(context, changeId)` on the repos module. It reads the authoritative repos-owned change state and returns an eligible gate containing `authorId`, `headOid`, `revision`, `status`, `unitKeys`, and `frozen`, or a blocked gate for a missing change. Other modules call `context.readChange(changeId)`; until registration it returns a blocked `MODULE_UNAVAILABLE` gate. The accessor is always present in repo-coordinator contexts; its contract field is optional because the catalog also constructs a `ModuleContext` and does not read changes. The accessor passes the repos context to the provider, then copies and freezes the returned value and unit-key list so callers cannot write through the view. Slice 04 uses it for queue admission and promotion checks; slice 06 uses it for finding authorship, revision, and freeze checks. Repos state changes still belong to the repos module, and all module routes remain subject to the coordinator freeze guard.

## Contract audit

This table checks the runner, queue, verdict, and finding exchanges in `docs/ARCHITECTURE.md` and `docs/specs/03`–`07` against `src/contracts.ts`. The feature modules remain unavailable in slice 01; “covered” means the wire or shared type can carry the named data, not that the later slice implements the behavior. The producer must hash canonical sorted JSON for `ReviewManifest`, `dependencyScope`, and the full result with its `resultDigest` field omitted (the canonical preimage), and `JobResultBody.resultDigest` must equal `result.resultDigest`, and the consumer must recompute those digests, compare the job input/fence/pins, verify the referenced Git objects, and reject missing or inconsistent evidence. An `unknown` review scope contains the whole relevant tree and cannot authorize automatic carry.

| Exchange | Type | Fields carried | Verdict |
| --- | --- | --- | --- |
| Owner policy/profile to runner | `TrustedPolicy`, `TrustedProfile`, `JobBase` | Full policy, including units, checker and acceptance; profile/checker/oracle/toolchain/environment pins, timeout, output limit, remotes and expected refs | Covered; full policy repaired. Trusted profile output is capped at 16 KB. |
| Runner poll and claim | `RunnerPollBody`, `Job`, `Runner` | Runner identity, role, supported profiles, maxJobs; job kind, generation, attempt, fence, expiry and input digest | Covered; claim lifetime and retry rules belong to slice 05. |
| Runner heartbeat | `JobHeartbeatBody`, `JobBase` | Attempt, fence, input digest and expiry | Covered. |
| Runner credentials | `JobCredentialsBody`, `JobBase` | Attempt, fence, requested operation, role and storage remotes | Covered; token issuance and redaction belong to slice 05. |
| Runner result delivery | `JobResultBody`, `ResultBase` | Attempt, fence, input/result digests, source tree, pinned digests, duration and bounded log | Covered; result validation and idempotence belong to slice 05. |
| Candidate inspection scheduling | `InspectCandidateJob`, `CandidateInput`, `SeedInput` | Change/revision, exact base/head, storage name/ref, policy and pins; explicit seed input | Covered; ordinary candidate fetch identity repaired. |
| Inspection to repo/leases/review | `InspectionResult`, `ReviewManifest`, `ChangedUnitEvidence`, `DependencyScopeEntry`, `repos.inspectRevision` | Observed head, actual changed units with before/after paths, modes and byte digests; reviewed dependencies or whole-tree fallback; manifest digest | Covered; typed evidence repaired. Unit footprints are checked against trusted policy and lease fences by later slices. |
| Lease reservation and release | `ClaimBody`, `PublishBody`, `leases.reserve`, `leases.releaseReservation`, `Lease` | Unit keys, intent, TTL, current fences, reservation fences and lease holder/expiry | Covered; admission must compare verified writes and footprints before reservation. |
| Queue admission and findings/review gates | `EnqueueBody`, `findings.gate`, `verdicts.gate`, `QueueEntry` | Revision, verdict, lease fences, finding-set version, unresolved IDs, dependencies, sequence and generation | Covered; atomic gate checks belong to slice 04. |
| Stack composition and diagnostics | `ValidateStackJob`, `CandidateInput`, `Stack`, `StackResult` | Canonical base, ordered candidates, scratch name/ref, bootstrap authorization, composed commit/tree, outcome and score | Covered; scratch ref and tree evidence repaired. Subset and baseline checks use the same job with selected candidates and a new input digest. |
| Acceptance and contest arbitration | `TrustedPolicy.acceptance`, `StackResult.gateResults`, `StackResult.score`, `Contest` | Named MATCH/PASS hard gates; optional score with fixed denominator; two child IDs and selected winner | Covered for v1; score comparison follows successful hard gates and identical profile/oracle pins. |
| Promotion freeze and ticket | `Promotion`, `FrozenAdmission`, `PromoteJob` | Expected old/new OIDs, queue generation, frozen revisions/verdict IDs/finding versions/fences, scratch ref and bootstrap flag | Covered; scratch fetch identity repaired. |
| Promotion response/reconcile | `PromotionResult`, `queue.onResult`, `Promotion` | Applied/old/third/environment outcome and observed canonical OID | Covered; canonical readback before merge belongs to slice 04. |
| Finding creation and repair round | `AddFindingBody`, `Finding`, `SubmitRepairBody`, `RepairRound` | Stable finding ID, unit anchor, origin revision, evidence, all dispositions, revision and finding-set version | Covered; exact-set and independent review checks belong to slice 06. |
| Repair review and finding gate | `ReviewRepairBody`, `RepairRound`, `findings.gate` | Whole-round accept/reject, evidence, reviewer ID, unresolved IDs and pending round | Covered; atomic resolution belongs to slice 06. |
| Verdict submission and gate | `AddVerdictBody`, `Verdict`, `verdicts.gate` | Reviewer, inspected revision, complete manifest/digest, policy/checker/oracle/toolchain pins, finding-set version and decision | Covered; persisted manifest and pins repaired. Independence and manifest verification belong to slice 07. |
| Carry request and delta scheduling | `CarryBody`, `DeltaCheckJob`, `Verdict` | Parent verdict, new base, candidate revision, old manifest and digest, finding-set snapshot and current trusted pins | Covered; old evidence and version snapshot repaired. |
| Delta evidence and derived verdict | `DeltaResult`, `ReviewManifest`, `verdicts.evaluateCarry`, `Verdict` | Recomputed changed units with paths/modes/byte digests, dependency entries and digest, affected-unit outcome, parent verdict and delta result link | Covered; typed delta evidence and derived-verdict link repaired. Fresh findings or unknown scope require review. |

Later slices may add optional fields or new union members to `src/contracts.ts`. They may not rename, remove, or change existing fields; an incompatible change requires a serialized integration decision.

V1 acceptance has exactly two policy kinds: named MATCH/PASS hard gates, and a fixed-denominator score maximized only after every hard gate passes. A no-regression score policy is deferred. A later slice may add it as a new union member under the evolution rule; v1 must not infer it from a partial score.

### Open contract questions

None.
