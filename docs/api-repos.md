# Repository and change API

This slice implements repository provisioning, owned candidate forks, branch registration, and publication requests. Routes require `Authorization: Bearer <Concord credential>` except credentialless GET reads under a public repository, as described below. Every mutation needs an `Idempotency-Key`; mutations of existing objects also need `expectedVersion` from the latest response envelope. Success responses are `{ "data": ..., "version": number, "eventSeq": number }`; failures are `{ "error": { "code", "message" }, "requestId" }`. A replay of one successful key and body returns the original response. Provider failures return `503`, keep their intent visible, and can be retried with the same key and body.

An `AUTH_TOKENS` principal may have an optional `model` label of 1–64 characters from `A–Z`, `a–z`, `0–9`, `.`, `_`, `:`, `/`, or `-`. A new change records that label once as `authorModel`, or `null` when absent; change creation, detail, list, and repository snapshot responses include `authorModel`. Later credential changes do not rewrite an existing change.

After verified canonical readback, a landed change becomes `merged` and records `canonicalOid` in change detail, list, and snapshot responses. Merged changes are terminal and no longer count toward the 32 active-change limit. Owners can run the additive repair route below for older landings; it requires both a landed queue entry and a promotion commit reachable from canonical `main`.

| Method and path | Role | Request / result |
| --- | --- | --- |
| `GET /v1/repos` | Any authorized principal | Page of tenant repos; `?cursor=` advances. |
| `POST /v1/repos` | Owner | `{name,policyId,profileId,public?}` reserves a logical name and canonical storage intent before contacting the provider. Returns `201 ready`, `202 provisioning`, or `503` with visible `blocked` state. Repost the same name/config to reconcile a failed call or change `public` (see below). |
| `GET /v1/repos/:r` | Repo reader | Repo status, the effective `activeChangeLimit`, and observed canonical `main` OID; `202` while provisioning. |
| `GET /v1/repos/:r/tree?path=&oid=` | Repo reader | Immediate directory entries from canonical storage. Empty or absent `path` selects the root; omitted `oid` resolves current `main`. A present `oid` is validated first (including empty: 400 `INVALID_OID`), then looked up as a commit (404 `COMMIT_NOT_FOUND`); supplied OIDs never fall back to `main`. No main returns 404 `MAIN_NOT_FOUND`. Paths are at most 4096 UTF-8 bytes, have no leading slash or NUL, and contain no empty, `.` or `..` segments; newline, colon, backslash and `a..b` are valid. Invalid paths return 400 `INVALID_PATH`. Entries carry `name`, `type`, and real 40-hex `oid`; at most 1000 are returned with `truncated: true` when more exist. `unitFiles` and `rowTables` map trusted policy units to paths for live claim badges. Missing directory returns 404 `TREE_NOT_FOUND`. |
| `GET /v1/repos/:r/file?path=…&oid=` | Repo reader | UTF-8 text and byte size from canonical storage, subject to the same OID and path rules. The 64 KiB cap is checked before bytes are materialized. Larger files return 413 `FILE_TOO_LARGE`; invalid UTF-8 or control bytes outside tab/LF/CR return 415 `BINARY_FILE`. Missing file returns 404 `FILE_NOT_FOUND`. |
| `GET /v1/repos/:r/readme?oid=` | Repo reader | Same bounded text response and OID rules as `file` for root `README.md`. Missing README returns 404 `FILE_NOT_FOUND`. |
| `GET /v1/repos/:r/branches` | Repo reader | Registered candidate refs only. |
| `POST /v1/repos/:r/branches` | Candidate author | `{expectedVersion,storageName,ref,observedHead,ownerId}`. `ref` is a full `refs/heads/...` name. The server resolves the exact fork ref and commit before registration. |
| `POST /v1/repos/:r/git-token` | Owner/agent/reviewer | `{expectedVersion,storageName,scope,ttlSeconds}`. TTL is 60–600 seconds. A non-terminal candidate fork is readable by its author, a repo reviewer, or an owner; write access remains author-only. Other agents and terminal or unknown candidate forks receive `403 FORK_NOT_OWNED`. Canonical accepts read scope only. During promotion freeze, canonical read-token requests are allowed; write-scope and candidate-fork token requests remain frozen with `409 PROMOTION_IN_PROGRESS`. Returns the provider's exact remote and a short-lived token. |
| `GET /v1/repos/:r/changes` | Repo reader | Page of changes. |
| `POST /v1/repos/:r/changes` | Owner/agent | `{intentKey,intentText,baseOid,branch,unitKeys,dependencyChangeIds,attempt?}`. An empty repo permits an owner seed draft with `baseOid:null`. Every draft gets one candidate fork. Repeated active task content returns the same change even if the submitted base differs. New work after a terminal task needs `attempt` incremented by one. Creation stops at the repo's active-change limit with `429 CHANGE_LIMIT`; `error.details` carries the effective `limit` and the current `active` count. |
| `GET /v1/repos/:r/changes/:c` | Repo reader | Change and its fork provisioning intent. |
| `POST /v1/repos/:r/changes/:c/publish` | Author/owner | `{expectedVersion,baseOid,headOid,branch,unitKeys,leaseFences}`. Requires registered current fork ref and existing head/base commits. Records an immutable revision and requests `inspect-candidate`. The integrated runner validates job pins; an invalid job returns `409 INVALID_JOB` and the revision stays draft. Identical repeat publication returns the same revision. |
| `POST /v1/repos/:r/changes/:c/close` | Author/owner | `{expectedVersion,reason?}`. `reason` may be null or omitted; otherwise it must be a non-whitespace string of 1–2000 UTF-8 bytes (`422 INVALID_REASON`). Only unfrozen draft or ready changes can close. A terminal intent requires an explicit next attempt. |
| `POST /v1/repos/:r/changes/repair-landed` | Owner | `{expectedVersion}`. Idempotently repairs older landed queue entries whose promotion commit remains in canonical `main` history. Returns `{repairedChangeIds}`. A change becoming merged also releases all its active and reserved leases in the same transaction with reason `change-merged`. |
| `POST /v1/repos/:r/bootstrap` | Owner | `{expectedVersion,seedStorageName,seedRef,headOid,policyId,profileId,withHistory?}`. Requires an open owner seed draft, its registered ref and readable head commit, and absent canonical `main`. By default the seed must be a root commit (`SEED_NOT_ROOT` otherwise). Explicit `withHistory: true` permits a non-root seed and preserves its OID and ancestors. Reserves one job ID and scratch repository before provider creation; returns `202` with `state: provisioning` while scratch storage is pending. Retry with a new idempotency key and the current version to reconcile the same scratch name. Once ready, records one owner request for head-tree validation. If the pinned trusted policy or profile changes, or scheduling rejects the job as `INVALID_JOB`, the owner may repeat the same seed request with a new idempotency key and current version. This re-pins the trusted digests, cancels the old job, reserves a new job ID, reuses scratch storage, and emits `repo.bootstrap.repinned` with old and new digests. A live runner claim or existing canonical `main` prevents re-pinning. `GET /v1/repos/:r` includes `bootstrap.state` and `bootstrap.blockedReason` while pending. No canonical write token is returned. |

The active-change limit caps non-terminal changes per repo. It is owner trusted configuration only — there is no API or CLI for an agent to set it. `costLimits.maxActiveChangesPerRepo` sets the install-wide default (integer 1–1000, default 32) and `costLimits.activeChangeLimits` maps a repoId to a per-repo override in the same range. `GET /v1/repos/:r` reports the effective number as `activeChangeLimit` so agents and the UI can show it. Both keys are optional; Mother Base and every repo keep 32.

Closing a change stores the optional reason as `closeReason` (null when omitted) and in the `change.closed` event payload as `{reason}`. The reason is returned by change reads and remains on idempotent replays. Closing also releases its active and reserved leases in the same transaction. Each released lease is recorded in the lease event history as `lease.released` with reason `change-closed`; the close response shape is otherwise unchanged.

When a change becomes merged through queue landing or landed-change repair, all its remaining active and reserved leases are released in the same transaction. Each `lease.released` event uses reason `change-merged`.

```json
{ "costLimits": { "maxActiveChangesPerRepo": 32, "activeChangeLimits": { "swarm_repo": 128 } } }
```

The candidate branch is made with a native Git push to its assigned fork remote, then registered through Concord. A `202` fork has no usable remote yet; poll change detail until `provisioning.state` is `observed`. A failed fork remains in change detail and the repo snapshot and can be retried with the same intent content and a new request key. A registered branch must be refreshed when its head changes. Publication replaces the pending inspection revision and clears the repos module's review pointer. A checker result can mark it ready only when the pending job, fetched head/tree, trusted pins, unit set, and both the result and review manifest digests match. Queue admission, checker result authentication/digest validation, promotion freeze, and canonical advancement belong to slices 04/05/07.

Provisioning persists `intent → creating → token-held → revoking → observed` (or `failed`) in the coordinator. A provider response without an initial token skips `token-held`. Pending or empty status observations count toward one 30-poll limit across API retries and one-second alarms; the 30th pending observation fails provisioning. An explicit API retry after failure starts a new attempt with the same deterministic storage name and resets that attempt's poll count. A held initial token survives failure and is retried for revocation before the repository can become observed. Scratch provisioning is visible in the repo snapshot alongside the bootstrap job ID, and retries keep both IDs. An already observed repository that later disappears is blocked for operator reconciliation and is never silently recreated empty. A publication whose inspection scheduler rejects the job keeps its revision and job intent and can retry scheduling with a new request key and the current version without incrementing the revision. Local fake storage uses `fake://` identifiers without Git transport; the integrated runner rejects these as `INVALID_JOB`.

Job `expectedRefs` keys are storage names. The candidate and canonical repository each have a distinct name. `inputDigest` hashes canonical sorted JSON of the immutable job input, excluding `inputDigest`, `state`, `attempt`, `runnerId`, `fence`, `expiresAt`, and `version`.

## Public repositories and anonymous reads

Each repository carries a `public` boolean, default `false`. Only the owner can change it, through `POST /v1/repos`: pass `"public": true` or `"public": false` together with the same `name`, `policyId`, and `profileId` as the existing repository (a repost with no `public` field leaves the flag unchanged). Setting the flag is additive; every other repository field and default is unchanged. A change is recorded as a `repo.updated` event and bumps the repository version.

When `public` is `true`, a request with **no** `Authorization` header to a `GET` route under `/v1/repos/:r/` is served as an anonymous principal with `roles: ['viewer']` and `repoIds: [r]` scoped to the repository's tenant. Anonymous readers can therefore fetch repository status, branches, changes and change detail, snapshots, per-repo events, issues, leases, findings, verdict summaries, and merge-queue state — the same read routes a repo-scoped viewer token reaches. They cannot see anything else:

- Credentialless requests to private or unknown repositories, to any non-GET method, and to tenant-wide routes (`/v1/events`, `/v1/principals`, `/v1/repos` list) get the same `401 UNAUTHORIZED` as before; private and unknown repositories are indistinguishable.
- A request that presents a credential is authenticated exactly as before — an invalid credential is `401` and is never downgraded to anonymous.
- Anonymous responses omit secret-bearing fields: tokens, credential material, storage names and remotes, and runner/checker configuration (`jobs`, `runners`, `unitPolicy`, `expectedRefs`, checker and environment digests, and every `*storageName`/`sourceName`/`remote`-shaped field). Fields that are removed are omitted rather than nulled.
- Anonymous reads pass through the same credential rate limit as failed authentication attempts; there is no unmetered path.

Public repository names are reserved across tenants. A second tenant cannot publish the same repo ID or delete the first tenant's entry; publication returns `409 PUBLIC_REPO_NAME_CONFLICT`. Private repositories may still share names. Revocation takes effect in the tenant catalog before directory removal, and anonymous reads verify both records. If directory removal fails, the owner receives `503 DIRECTORY_UNAVAILABLE`, but the revoked repository is already inaccessible without a credential. Retrying the same update is safe.

## Local Git bridge

The bridge is an **account-free local fake**, bound to `127.0.0.1` and backed by bare Git repositories under one supplied directory. It uses fixed native Git argv and accepts only an authenticated `/rpc` request. Repo remotes are `file://` paths and are suitable only for local fixtures below 10 MB. They do not enforce token scope as Artifacts HTTPS does.

```sh
export CONCORD_RUN_DIR="$(node -p 'require("node:path").resolve(process.env.TMPDIR || "/tmp")')/concord-repos-01"
export CONCORD_BRIDGE_DATA_DIR="$CONCORD_RUN_DIR/bridge"
export CONCORD_BRIDGE_TOKEN="$(node -p 'require("node:crypto").createHash("sha256").update(process.env.CONCORD_RUN_DIR + ":bridge").digest("hex")')"
export CONCORD_BRIDGE_PORT=8788
npm run git-bridge
```

In a second terminal, derive the same local bridge token from the same run directory and start the Worker with [Wrangler `--var` overrides](https://developers.cloudflare.com/workers/wrangler/commands/workers/):

```sh
export CONCORD_RUN_DIR="$(node -p 'require("node:path").resolve(process.env.TMPDIR || "/tmp")')/concord-repos-01"
export CONCORD_BRIDGE_TOKEN="$(node -p 'require("node:crypto").createHash("sha256").update(process.env.CONCORD_RUN_DIR + ":bridge").digest("hex")')"
: "${CONCORD_BRIDGE_TOKEN:?bridge token required}"
export CONCORD_WRANGLER_STATE=".wrangler/state/$(node -p 'require("node:crypto").createHash("sha256").update(process.env.CONCORD_BRIDGE_TOKEN).digest("hex").slice(0,12)')"
npm run dev -- --persist-to "$CONCORD_WRANGLER_STATE" --var 'STORAGE_BACKEND:bridge' \
  --var "BRIDGE_URL:http://127.0.0.1:8788/?token=$CONCORD_BRIDGE_TOKEN"
```

The checked-in local Wrangler configuration defaults to `fake`. Keep the bridge data directory and the matching `.wrangler/state/` directory to persist repos and issued fake-token revocation state across restarts. Change `concord-repos-01` in both blocks for a fresh run and separate Worker state. The Worker adapter uses HTTP only; Node Git and filesystem APIs stay in `local/git-bridge.ts`. Do not deploy the bridge URL: production storage selection accepts only Artifacts.

## Early live Artifacts gate (skipped by default)

The owner's Cloudflare account and disposable namespace are not available in this run, so no live result or OID is claimed. The authorized operator runs the following **opt-in** script as soon as access exists, before slice 12. It uses the documented [REST create/fork routes](https://developers.cloudflare.com/artifacts/api/rest-api/), the corresponding [Workers binding methods](https://developers.cloudflare.com/artifacts/api/workers-binding/), and the [Git protocol push](https://developers.cloudflare.com/artifacts/api/git-protocol/). The script records redacted API responses and OIDs in a temporary directory; copy that output into the integration evidence after the run. It does not run as part of validation.

```sh
if [ "${RUN_ARTIFACTS_LIVE_SMOKE:-0}" != 1 ]; then
  echo 'SKIP: set RUN_ARTIFACTS_LIVE_SMOKE=1 after the owner grants disposable Artifacts access'
  exit 0
fi
set -eu
: "${ACCOUNT_ID:?}" "${ARTIFACTS_NAMESPACE:?}" "${CLOUDFLARE_API_TOKEN:?}"
command -v jq >/dev/null
base="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces/$ARTIFACTS_NAMESPACE"
run="$(date -u +%Y%m%d%H%M%S)-$$"
canonical="concord-smoke-empty-$run"
seed_repo="concord-smoke-seed-$run"
seed_fork="concord-smoke-fork-$run"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
api() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
record() { jq 'del(.result.token, .result.plaintext)' >> "$tmp/api-responses.jsonl"; }
create() { api -X POST "$base/repos" --data "$(jq -nc --arg n "$1" '{name:$n,default_branch:"main",read_only:false}')"; }
fork() { api -X POST "$base/repos/$1/fork" --data "$(jq -nc --arg n "$2" '{name:$n,read_only:false,default_branch_only:false}')"; }
read_head() { api "$base/repos/$1/log?ref=main&limit=1" | jq -r '.result[0].hash // empty'; }
wait_ready() {
  i=0
  while [ "$i" -lt 30 ]; do
    if api "$base/repos/$1" | jq -e '.success == true and .result.remote != null' >/dev/null; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  echo "repository $1 did not become ready in 30 seconds" >&2
  return 1
}
wait_head() {
  i=0
  while [ "$i" -lt 30 ]; do
    if [ "$(read_head "$1")" = "$2" ]; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  echo "repository $1 did not expose expected OID $2" >&2
  return 1
}
revoke_tokens() {
  api "$base/repos/$1/tokens?state=active&per_page=100&page=1" |
    jq -r '.result[]?.id' | while IFS= read -r token_id; do
      api -X DELETE "$base/tokens/$token_id" | jq -e '.success == true' >/dev/null
    done
}
canonical_response="$(create "$canonical")"
printf '%s\n' "$canonical_response" | record
printf '%s\n' "$canonical_response" | jq -e '.success == true' >/dev/null
wait_ready "$canonical"
revoke_tokens "$canonical"
fork_response="$(fork "$canonical" "$seed_fork")"
printf '%s\n' "$fork_response" | record
if printf '%s\n' "$fork_response" | jq -e '.success == true' >/dev/null; then
  wait_ready "$seed_fork"
  source_name="$seed_fork"
  source_response="$fork_response"
  path='empty-source-fork'
else
  # The separate seed repo receives its first commit before being forked.
  seed_response="$(create "$seed_repo")"
  printf '%s\n' "$seed_response" | record
  printf '%s\n' "$seed_response" | jq -e '.success == true' >/dev/null
  wait_ready "$seed_repo"
  source_name="$seed_repo"
  source_response="$seed_response"
  path='seeded-source-fork'
fi
work="$tmp/work"
git init -q "$work"
printf 'Concord Artifacts bootstrap gate\n' > "$work/README.md"
git -C "$work" add README.md
GIT_AUTHOR_NAME=Concord GIT_AUTHOR_EMAIL=smoke@example.test \
GIT_COMMITTER_NAME=Concord GIT_COMMITTER_EMAIL=smoke@example.test \
  git -C "$work" commit -q -m 'first seed commit'
oid="$(git -C "$work" rev-parse HEAD)"
remote="$(printf '%s\n' "$source_response" | jq -r '.result.remote')"
repo_token="$(printf '%s\n' "$source_response" | jq -r '.result.token')"
git -C "$work" -c "http.extraHeader=Authorization: Bearer $repo_token" push "$remote" HEAD:refs/heads/main
wait_head "$source_name" "$oid"
observed="$(read_head "$source_name")"
test "$observed" = "$oid"
if [ "$path" = seeded-source-fork ]; then
  fork_response="$(fork "$seed_repo" "$seed_fork")"
  printf '%s\n' "$fork_response" | record
  printf '%s\n' "$fork_response" | jq -e '.success == true' >/dev/null
  wait_ready "$seed_fork"
  wait_head "$seed_fork" "$oid"
  observed_fork="$(read_head "$seed_fork")"
  test "$observed_fork" = "$oid"
fi
revoke_tokens "$source_name"
revoke_tokens "$seed_fork"
printf 'path=%s canonical=%s seed_source=%s seed_fork=%s oid=%s readback=%s\n' \
  "$path" "$canonical" "$source_name" "$seed_fork" "$oid" "$observed"
cat "$tmp/api-responses.jsonl"
```

After that operation gate, the operator uses the verified fork as the owner seed source and, once slices 04/05 are integrated, verifies checked root-tree validation and a single absent-ref promotion to canonical `main`. Record the before/after ref OIDs, checker evidence, promotion result, and a second initializer's failed absent-ref check. If create, first push, seeded fork, or conditional Git push fails, stop Artifacts-dependent integration and give the integrator the redacted response and failing command. The script's fork response may be asynchronous; wait for ready via the documented repo status before pushing or reading back.

The repos module registers its change-view provider through the cross-module hook. The coordinator returns a detached view, including the queue fields, to other modules.

## Path protection settings

`GET /v1/repos/:repoId/settings` is available to every repository reader and returns `{version, protectedPaths}`. A repository without settings returns `{version:0,protectedPaths:[]}`; its paths default to `agents`. An owner replaces the array with `PUT /v1/repos/:repoId/settings`, supplying `expectedVersion` from the latest API envelope and an idempotency key. Each entry is `{pattern,level,note?}`. The server increments the repository version and emits `settings.updated`.

Levels are `agents` (normal lease and queue flow), `human-approval` (agents can lease and edit; queue admission requires a separate owner approval for the current inspected revision), and `human-only` (agent lease claims return `PATH_PROTECTED` with pattern, note and owner holder). The owner can claim normally. Patterns use import globs: `*` and `?` stay within one path segment, `**` spans segments, and a trailing `/` covers a directory. An exact path always wins over any wildcard match; otherwise more literal characters win, and fewer wildcards and then a longer pattern break ties. Exact patterns can therefore override broad directory rules. Normalized relative Git paths, including `AGENTS.md`, are accepted. New files can be claimed only where the trusted unit policy already permits file units; a matching protection applies to those claims too.

`POST /v1/repos/:repoId/changes/:changeId/human-approval` is owner-only. Its body contains `expectedVersion`, `revision`, `reviewManifestDigest`, `evidenceDigest` (sha256), and `decision` (`approve` or `reject`). The inspected change view shows `awaitingHumanApproval`, `protectedFiles`, `protectedDiffSummary` (before/after paths, modes and byte digests), and `reviewManifestDigest`. Owner-only `GET /v1/repos/:repoId/changes/:changeId/human-approval` returns every decision with its evidence digest in submission order. Owner-only `GET /v1/repos/:repoId/changes/:changeId/human-approval/diff` reads the inspected base and head and returns each protected file's before/after modes with a bounded text preview; binary, large, missing, or digest-mismatched content is labelled, and equal bytes name the changed path or mode explicitly. The approval is separate from the independent reviewer verdict; both are required for admission. A clean patch-id carry also carries the owner approval after the existing digest and dependency checks pass. A new revision, changed manifest, or newly matching protection requires a new owner decision. The queue projection includes pending patterns for admitted entries.

Bootstrap records the validation request and provisions a scratch repository before scheduling. The queue remains responsible for issuing an owner-authorized absent-ref promotion ticket only after a trusted pass. Local fake storage cannot run a real checker because its `fake://` remote has no Git transport.
Queue admission must also recheck the candidate's current registered ref and revision, consult the repos module's queue generation after a head change, and mark admitted/promoting changes frozen so `close` cannot bypass that state.
# Related task records

`change create` accepts optional `issueNumber` to link the candidate to an open Concord issue. The change response and subsequent change views expose that number. See the [issues and milestones API](api-issues.md) for task specs, progress, and automatic closure on land.
