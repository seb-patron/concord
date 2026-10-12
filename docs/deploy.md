# Concord deployment and one-way demo mirror

The local bridge is a development fake. A public deployment uses the `concord-demo` Artifacts namespace and `wrangler.jsonc`; it never uses `wrangler.local.jsonc` or `BRIDGE_URL`. No Cloudflare account or GitHub destination is provisioned by this repository. The owner must authorize account creation, deployment, and any mirror push. Keep `CONCORD_SHOW_DECOMPILED_C=0`; this release contains only the original public synthetic fixture.

## Local acceptance and release inputs

From a clean clone with Node 22+, npm, and Git:

```sh
npm ci
npm run typecheck
npm run test:target -- tests/node/mirror.test.ts tests/node/deploy.test.ts
npm run deploy:check -- --local
sh scripts/validate.sh
```

`--local` checks the production and local Wrangler configurations, safe content and credential settings, Node/Git, and local program availability. It reports `remote deployment unavailable: owner credentials required` without failing the local check. The production Worker accepts no `local-*` bearer tokens and selects Artifacts only. The [repo API guide](api-repos.md) documents the local bridge; its `file://` repositories are not deployed evidence.

With the [README local bridge and Worker](../README.md#five-minute-local-start) running, these commands recheck the seeded fixture and its first barriers. They use the README's absolute `CONCORD_RUN_DIR` and local URL, and do not constitute deployed smoke evidence.

<!-- verified-by: 12c -->
```sh
export CONCORD_RUN_DIR="$(node -p 'require("node:path").resolve(process.env.TMPDIR || "/tmp")')/concord-demo-01"
export CONCORD_URL=http://127.0.0.1:8787
export CONCORD_TOKEN=local-owner
export CONCORD_SHOW_DECOMPILED_C=0
npm run demo -- seed --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene leases --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene stack --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- inspect --run demo-01 --state-dir "$CONCORD_RUN_DIR" --json
```

The owner supplies `CLOUDFLARE_ACCOUNT_ID` (32 hex characters), `CLOUDFLARE_API_TOKEN` with Workers and Artifacts permissions, and an existing `concord-demo` namespace. Keep credentials in the operator environment or a secret manager. Never commit them or pass them in URLs. Set `AUTH_TOKENS_FILE` and `TRUSTED_CONFIG_FILE` to operator-owned files **outside this clone**. `AUTH_TOKENS` is the production JSON map from SHA-256 bearer token digests to scoped principal records; `TRUSTED_CONFIG` contains only owner-approved policy and profile records. Do not put local fixture identities in either file. See [auth and trust](ARCHITECTURE.md#auth-and-trust).

```sh
export CLOUDFLARE_ACCOUNT_ID='<owner account ID>'
export CLOUDFLARE_API_TOKEN='<owner provisioned API token>'
export AUTH_TOKENS_FILE='<absolute private path>'
export TRUSTED_CONFIG_FILE='<absolute private path>'
npm run deploy:check -- --remote
npx wrangler deploy --dry-run --config wrangler.jsonc
```

`--remote` makes a read-only authenticated request for the configured Artifacts namespace. If credentials or namespace access are absent, it reports unavailable and exits nonzero; it does not affect local acceptance. A dry run builds the Worker without publishing it. Record the pinned Git commit, Wrangler version (`npx wrangler --version`), and dry-run output in the operator's release record.

## Early Artifacts bootstrap gate, repeated before release

The [slice 02 gate](api-repos.md#early-live-artifacts-gate-skipped-by-default) and [architecture contract](ARCHITECTURE.md#durable-object-layout-and-consistency) require an actual provider experiment. The owner first creates an **empty disposable** Artifacts repo, tries to fork it, pushes a first commit to the fork's returned Git remote, and reads back the SHA. If the empty fork fails, create a **separate** disposable seed repo, push/read back its first commit, then fork that seeded repo and read back the same SHA on the fork. Do not treat a success response without a ready fork and SHA readback as success. Record redacted API responses, remote URLs, fork status, provider version, and OIDs. The exact REST routes are in the [Artifacts API](https://developers.cloudflare.com/artifacts/api/rest-api/) and Git bearer-token transport is in the [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/).

The following POSIX shell commands run only after owner authorization. They use disposable names, a temporary work directory, and environment-delivered Git headers. `jq` and `curl` are required. Output contains no token. Run in an operator shell with history/log capture disabled for secret input.

```sh
set -eu
: "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}"
ARTIFACTS_BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces/concord-demo"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
EMPTY="concord-gate-empty-$RUN_ID"
SEED="concord-gate-seed-$RUN_ID"
FORK="concord-gate-fork-$RUN_ID"
GATE_DIR="$(mktemp -d)"
api() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
create() { api -X POST "$ARTIFACTS_BASE/repos" --data "$(jq -nc --arg name "$1" '{name:$name,default_branch:"main",read_only:false}')"; }
fork() { api -X POST "$ARTIFACTS_BASE/repos/$1/fork" --data "$(jq -nc --arg name "$2" '{name:$name,read_only:false,default_branch_only:false}')"; }
head() { api "$ARTIFACTS_BASE/repos/$1/log?ref=main&limit=1" | jq -r '.result[0].hash // empty'; }
ready() {
  n=0
  while [ "$n" -lt 30 ]; do
    if api "$ARTIFACTS_BASE/repos/$1" | jq -e '.success == true and (.result.remote | startswith("https://"))' >/dev/null; then return 0; fi
    n=$((n + 1)); sleep 1
  done
  return 1
}
mint() { api -X POST "$ARTIFACTS_BASE/tokens" --data "$(jq -nc --arg repo "$1" --arg scope "$2" '{repo:$repo,scope:$scope,ttl:600}')"; }
git_artifacts() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
    GIT_CONFIG_VALUE_0="Authorization: Bearer $GIT_TOKEN" GIT_TERMINAL_PROMPT=0 git "$@"
}
create "$EMPTY" | jq 'del(.result.token)'
ready "$EMPTY"
if EMPTY_FORK_RESPONSE="$(fork "$EMPTY" "$FORK")" && printf '%s' "$EMPTY_FORK_RESPONSE" | jq -e '.success == true' >/dev/null; then
  printf '%s' "$EMPTY_FORK_RESPONSE" | jq 'del(.result.token)'
  ready "$FORK"
  SOURCE="$FORK"
  GATE_PATH=empty-fork
else
  create "$SEED" | jq 'del(.result.token)'
  ready "$SEED"
  SOURCE="$SEED"
  GATE_PATH=seeded-repo-fallback
fi
SOURCE_REMOTE="$(api "$ARTIFACTS_BASE/repos/$SOURCE" | jq -r '.result.remote')"
GIT_TOKEN="$(mint "$SOURCE" write | jq -r '.result.plaintext')"
git init -q -b main "$GATE_DIR/work"
printf 'public disposable Artifacts gate\n' > "$GATE_DIR/work/README.md"
git -C "$GATE_DIR/work" add README.md
GIT_AUTHOR_NAME=Concord GIT_AUTHOR_EMAIL=gate@example.test \
GIT_COMMITTER_NAME=Concord GIT_COMMITTER_EMAIL=gate@example.test \
  git -C "$GATE_DIR/work" -c core.hooksPath=/dev/null commit -q -m 'seed Artifacts gate'
SEED_OID="$(git -C "$GATE_DIR/work" rev-parse HEAD)"
git_artifacts -C "$GATE_DIR/work" push "$SOURCE_REMOTE" HEAD:refs/heads/main
test "$(head "$SOURCE")" = "$SEED_OID"
if [ "$GATE_PATH" = seeded-repo-fallback ]; then
  fork "$SEED" "$FORK" | jq 'del(.result.token)'
  ready "$FORK"
  test "$(head "$FORK")" = "$SEED_OID"
fi
printf 'gate=%s source=%s fork=%s sha=%s\n' "$GATE_PATH" "$SOURCE" "$FORK" "$SEED_OID"
```

Keep the disposable resources until the following tests finish. Revoke their initial and minted tokens using `GET /repos/:name/tokens?state=active` and `DELETE /tokens/:id` after recording results; then remove `"$GATE_DIR"` on the operator machine. A failed create, first push, seeded fork, or readback is a stop for Artifacts-dependent deployment. The fallback is specifically a new seed repository that receives its first commit **before** forking.

### Stale expected-old and token isolation on disposable repos

The first push above establishes `SEED_OID`. Make two different descendants of it in the temporary checkout. The first conditional push succeeds; the second uses the now stale expected-old SHA and must fail. Never perform this test on Concord's canonical repo.

```sh
git -C "$GATE_DIR/work" checkout -q -b first "$SEED_OID"
printf 'first\n' > "$GATE_DIR/work/first.txt"
git -C "$GATE_DIR/work" add first.txt
GIT_AUTHOR_NAME=Concord GIT_AUTHOR_EMAIL=gate@example.test GIT_COMMITTER_NAME=Concord GIT_COMMITTER_EMAIL=gate@example.test \
  git -C "$GATE_DIR/work" -c core.hooksPath=/dev/null commit -q -m first
FIRST_OID="$(git -C "$GATE_DIR/work" rev-parse HEAD)"
git_artifacts -C "$GATE_DIR/work" push "--force-with-lease=refs/heads/main:$SEED_OID" "$SOURCE_REMOTE" HEAD:refs/heads/main
test "$(head "$SOURCE")" = "$FIRST_OID"
git -C "$GATE_DIR/work" checkout -q -b stale "$SEED_OID"
printf 'stale\n' > "$GATE_DIR/work/stale.txt"
git -C "$GATE_DIR/work" add stale.txt
GIT_AUTHOR_NAME=Concord GIT_AUTHOR_EMAIL=gate@example.test GIT_COMMITTER_NAME=Concord GIT_COMMITTER_EMAIL=gate@example.test \
  git -C "$GATE_DIR/work" -c core.hooksPath=/dev/null commit -q -m stale
if git_artifacts -C "$GATE_DIR/work" push "--force-with-lease=refs/heads/main:$SEED_OID" "$SOURCE_REMOTE" HEAD:refs/heads/main; then
  echo 'FAIL: stale expected-old push unexpectedly succeeded' >&2; exit 1
fi
test "$(head "$SOURCE")" = "$FIRST_OID"
```

For token isolation, use the fork-scoped token to try a write to the **different** empty repo. The Git server must reject it, and `EMPTY` must remain without `main`. If `SOURCE` is the fork, `GIT_TOKEN` is already fork scoped; otherwise mint a new token for `FORK` and assign it to `GIT_TOKEN` before this check.

```sh
if [ "$SOURCE" != "$FORK" ]; then GIT_TOKEN="$(mint "$FORK" write | jq -r '.result.plaintext')"; fi
EMPTY_REMOTE="$(api "$ARTIFACTS_BASE/repos/$EMPTY" | jq -r '.result.remote')"
if git_artifacts -C "$GATE_DIR/work" push "$EMPTY_REMOTE" HEAD:refs/heads/main; then
  echo 'FAIL: fork token wrote to another repo' >&2; exit 1
fi
test -z "$(head "$EMPTY")"
```

The `--force-with-lease` commands above are **only** for the disposable stale-ref experiment. Concord promotion uses its own frozen checked ticket and expected-old readback. The optional GitHub mirror uses a normal fast-forward push and never forces a ref.

## Provision secrets and deploy

Review the [cost guards and owner billing steps](cost.md) before deployment. Its limits come from the configured Worker and trusted tenant caps; actual billable usage and dollar totals come from the Cloudflare account's Billing → Billable Usage dashboard, not from the Fleet desk (`docs/cost.md`, `wrangler.jsonc`, `src/state.ts`).

On a fresh account, register a `workers.dev` subdomain in Cloudflare before deploying. Wrangler could not automatically register the name `concord` for this deployment. The **first** deployment must create the Worker and its secrets together; `versions upload` and `versions secret put` fail beforehand with code 10007 (`Worker does not exist`). From the repository root, with the two private input files above and `jq` installed, create a mode-0600 secrets JSON file outside the clone and deploy it:

```sh
umask 077
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/concord-secrets.XXXXXX")"
jq -n --rawfile auth "$AUTH_TOKENS_FILE" --rawfile trusted "$TRUSTED_CONFIG_FILE" \
  '{AUTH_TOKENS:$auth,TRUSTED_CONFIG:$trusted}' > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
test -s "$SECRETS_FILE" && npx wrangler deploy --config wrangler.jsonc --secrets-file "$SECRETS_FILE"
```

Remove the temporary file from the operator machine after recording the deployed URL. The two JSON values are Worker secret strings containing the contents of the private files; `jq --rawfile` preserves that shape. See `src/state.ts` and `src/auth.ts` for how the Worker reads them.

For later releases, use the versioned flow below when changing secrets, or run `npx wrangler deploy --config wrangler.jsonc` for a code-only release; existing secrets persist. The versioned flow first uploads an undeployed version, then attaches secrets with `versions secret put`; ordinary `secret put` immediately deploys a version and is unsuitable for this controlled sequence. The owner then explicitly deploys. Wrangler may prompt; record the emitted version ID and URL. The required production secrets are `AUTH_TOKENS` and either `TRUSTED_CONFIG` or `TRUSTED_CONFIG_PARTS` with its numbered parts (see [Large trusted configurations](#large-trusted-configurations)). None belongs in `wrangler.jsonc` or an `.env` file in the clone. [Wrangler versioned secrets and rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/) are documented by Cloudflare.

```sh
test -s "$AUTH_TOKENS_FILE" && test -s "$TRUSTED_CONFIG_FILE"
npx wrangler versions upload --config wrangler.jsonc
npx wrangler versions secret put AUTH_TOKENS --config wrangler.jsonc < "$AUTH_TOKENS_FILE"
npx wrangler versions secret put TRUSTED_CONFIG --config wrangler.jsonc < "$TRUSTED_CONFIG_FILE"
npx wrangler deploy --config wrangler.jsonc
```

If versioned secret provisioning reports that no Worker/version exists, use the first-deploy path above after confirming the account state with the owner; do not publish a fixture-authenticated substitute. A production secret change is a release action too. Do not run these commands during an account-free local rehearsal.

### Refresh trusted digests before creating repositories

For the demo policy, `demo/scenarios.ts` preflight reads `demo/profile.json` and hashes the bytes of `demo/checker.mjs` for `checkerDigest`; it does **not** hash `runner/profiles.ts` for that field. It builds `profileDigest` from the profile template, that checker hash, `dispatchArgv` from `runner/profiles.ts`, the local Node executable's byte hash, and the runtime's platform/architecture/Node version. It builds the demo `policyDigest` from `demo/units.json` plus the checker hash. The committed case matrix in `runner/profiles.ts` validates the profile cases, so a matrix change also requires a matching `demo/profile.json` update. For non-demo generated policies, `runner/generate-units.ts` instead hashes the policy template plus file units derived from the pinned repository tree and approved planned paths. These inputs and digest checks are implemented in `demo/scenarios.ts`, `runner/profiles.ts`, `runner/generate-units.ts`, and `src/features/leases.ts`.

After a change to `demo/profile.json`, `demo/checker.mjs`, `demo/units.json`, the `dispatchArgv` or required case matrix in `runner/profiles.ts`, or the pinned Node executable/runtime, rerun `npm run demo -- preflight --local --state-dir <dir>` and `npx wrangler secret put TRUSTED_CONFIG < <dir>/trusted-config.json`, or runners stay idle on a digest mismatch. Use an absolute `<dir>` outside the clone, then run the health check below. A generated policy likewise needs regeneration and installation whenever its template or pinned path set changes.

After changing `TRUSTED_CONFIG`, existing Durable Object instances, especially `TenantCatalog`, can continue using the previous binding until restart or idle eviction; the observed delay was roughly 2–3 minutes. Allow about 90 seconds with no traffic before creating repositories, and retry only after the new config is active. A repo created against the old policy digest can fail with `UNIT_POLICY_UNAVAILABLE` (`src/catalog.ts`, `src/features/leases.ts`).

### Large trusted configurations

For a trusted configuration too large for one Worker secret, set `TRUSTED_PARTS_FILE` to a new absolute path outside the clone, then create a private bulk file and upload its numbered secrets:

```sh
npm run deploy:trusted-parts -- --in "$TRUSTED_CONFIG_FILE" --out "$TRUSTED_PARTS_FILE"
  npx wrangler secret bulk "$TRUSTED_PARTS_FILE" --config wrangler.jsonc
```

The helper creates a mode-0600 file and refuses to overwrite one. `wrangler secret bulk` uploads the parts and count in one call. When switching from the single secret, run `npx wrangler secret delete TRUSTED_CONFIG --config wrangler.jsonc` so both formats are never present together. When switching back to `TRUSTED_CONFIG`, delete `TRUSTED_CONFIG_PARTS` with `npx wrangler secret delete TRUSTED_CONFIG_PARTS --config wrangler.jsonc`; the Worker then ignores leftover numbered parts. Keep the bulk file private and outside the clone.

## Deployed smoke and evidence

Set `CONCORD_URL` to the **deployed** URL printed by Wrangler. `GET /health` must report `mode=production` and `storageBackend=artifacts`; these are necessary, not sufficient. Repeat the disposable create/fork/push/read and stale/token tests above after the deploy, recording actual provider responses and version. The live scenario driver uses fresh bearer credentials and mints short-lived repo-scoped Git tokens through the Worker. Keep all generated files outside the clone. The provisioned principals have distinct roles and a 24-hour expiry; provision again for another recording day. The provision command resolves its output directory with `realpath` and requires it to be outside the physical clone.

The Artifacts binding resolves branch names in `log({ ref })` by short name (for example, `demo`), even when the Worker API receives `refs/heads/demo`.

```sh
export CONCORD_URL='<Wrangler deployed HTTPS URL>'
export CONCORD_SHOW_DECOMPILED_C=0
export CONCORD_RUN_DIR="$(mktemp -d)"
chmod 700 "$CONCORD_RUN_DIR"
npm run demo -- preflight --local --state-dir "$CONCORD_RUN_DIR"
npm run demo -- provision --out-dir "$CONCORD_RUN_DIR/creds"
export AUTH_TOKENS_FILE="$CONCORD_RUN_DIR/creds/auth-tokens.json"
export DEMO_TOKENS_FILE="$CONCORD_RUN_DIR/creds/demo-tokens.json"
export TRUSTED_CONFIG_FILE="$CONCORD_RUN_DIR/trusted-config.json"
node -e 'const fs = require("node:fs"); for (const file of [process.env.AUTH_TOKENS_FILE, process.env.DEMO_TOKENS_FILE]) if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(1)'
test -s "$TRUSTED_CONFIG_FILE"
export CONCORD_TOKEN="$(jq -r '.owner' "$DEMO_TOKENS_FILE")"
```

Upload the newly generated `AUTH_TOKENS` with the command in [Provision secrets and deploy](#provision-secrets-and-deploy). Upload `TRUSTED_CONFIG` with the single-secret command there if it fits; otherwise use [Large trusted configurations](#large-trusted-configurations). Do not reuse a deployment with an old token mapping. The commands in this section are remote-only and intentionally outside the `verified-by: 12c` local command blocks. Run the health check and seed after Wrangler prints the deployed URL.

```sh
curl -fsS "$CONCORD_URL/health" | jq -e '.status == "ok" and .mode == "production" and .storageBackend == "artifacts"'
npm run deploy:check -- --remote
npm run demo -- seed --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene context --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene leases --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene stack --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene isolate --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene repair --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene carry --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene invalidate --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene contest --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- scene aw --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR"
npm run demo -- inspect --target remote --url "$CONCORD_URL" --tokens-file "$DEMO_TOKENS_FILE" --run demo-01 --state-dir "$CONCORD_RUN_DIR" --json
```

The driver launches bounded `npm run runner` checker and promoter processes as jobs appear. To inspect a barrier manually, use the repo ID and profile digest printed by seed and preflight. Run the processes with their distinct bearer tokens in the environment, and let the driver resume after inspection:

```sh
export CONCORD_REPO_ID='<seed output repoId>'
export CONCORD_PROFILE_DIGEST='<preflight output profileDigest>'
RUNNER_SCRIPT=runner
CONCORD_TOKEN="$(jq -r '.checker' "$DEMO_TOKENS_FILE")" npm run "$RUNNER_SCRIPT" -- --repo "$CONCORD_REPO_ID" --role checker --profile "$CONCORD_RUN_DIR/dispatch-profile.json" --once
CONCORD_TOKEN="$(jq -r '.promoter' "$DEMO_TOKENS_FILE")" npm run "$RUNNER_SCRIPT" -- --repo "$CONCORD_REPO_ID" --role promoter --profile-digest "$CONCORD_PROFILE_DIGEST" --once
```

For checked-landing evidence, observe a checker `PASS` for the exact pinned job, a promotion ticket with expected-old, canonical `main` readback equal to the ticket's checked new SHA, and the same immutable SHA in repo detail and a fresh Artifacts Git fetch. Record Worker URL/version, Artifacts namespace and repo remote, job/result/promotion IDs, OIDs, and timestamps. The local bridge and a screenshot badge are insufficient evidence.

Set `CONCORD_REPO_ID` to the runtime repo ID and `CHECKED_SHA` to the promoted SHA shown by the ticket. Run bounded jobs as the flow requests, then verify the API and a fresh read-only Git clone:

Set `CONCORD_HOME` to an absolute, owner-provisioned directory outside this clone containing the production checker profile at `checker-profile.json`. The profile must pin the deployed job's checker, oracle, toolchain, and environment; the demo fixture profile is not production evidence.

```sh
export CONCORD_HOME='<absolute owner-provisioned directory outside this clone>'
export CONCORD_REPO_ID='<runtime repo ID>'
export CHECKED_SHA='<promoted full Git SHA>'
export CHECKER_TOKEN='<production checker bearer token>'
export PROMOTER_TOKEN='<production promoter bearer token>'
PROFILE_ID="$(curl -fsS -H "Authorization: Bearer $CONCORD_TOKEN" "$CONCORD_URL/v1/repos/$CONCORD_REPO_ID" | jq -er '.data.profileId')"
PROFILE_DIGEST="$(jq -er --arg id "$PROFILE_ID" '.profiles[$id].digest | select(test("^sha256:[0-9a-f]{64}$"))' "$TRUSTED_CONFIG_FILE")"
CONCORD_TOKEN="$CHECKER_TOKEN" npm run runner -- --repo "$CONCORD_REPO_ID" --role checker --profile "$CONCORD_HOME/checker-profile.json" --once
CONCORD_TOKEN="$PROMOTER_TOKEN" npm run runner -- --repo "$CONCORD_REPO_ID" --role promoter --profile-digest "$PROFILE_DIGEST" --once
npm run concord -- api GET "/repos/$CONCORD_REPO_ID" --json | jq -e --arg sha "$CHECKED_SHA" '.data.observedCanonicalOid == $sha'
npm run concord -- repo clone --repo "$CONCORD_REPO_ID" --path "$CONCORD_RUN_DIR/canonical" --json
test "$(git -C "$CONCORD_RUN_DIR/canonical" rev-parse HEAD)" = "$CHECKED_SHA"
```

## Optional GitHub human mirror

For a repository adopted with [import](import.md), the owner-authorized
destination must be a **new empty GitHub repository**. Import creates a new
root commit, so its history differs from the source repository. The mirror
remains one-way and retains its absent-or-ancestor check and no-force-push rule.

Only after a confirmed canonical landing, the owner may supply a **new demo-only** `https://github.com/OWNER/REPO.git` destination. `CONCORD_MIRROR_TOKEN` is an optional GitHub token passed through the environment; the URL must contain no credential. The mirror requests a read-only canonical Git token, verifies the API's observed SHA against remote `main`, checks that destination `main` is absent or its ancestor, and prints the planned SHA update. It has no reverse sync, PR API, tags, force push, or Concord rollback path.

```sh
export CONCORD_MIRROR_REMOTE='https://github.com/OWNER/REPO.git'
export CONCORD_MIRROR_TOKEN='<owner GitHub token for that demo repo>'
npm run mirror -- --repo '<CONCORD_REPO_ID>' --remote "$CONCORD_MIRROR_REMOTE" --dry-run
# Only with separate owner authorization:
npm run mirror -- --repo '<CONCORD_REPO_ID>' --remote "$CONCORD_MIRROR_REMOTE" --execute
```

Omitting `--dry-run` also stays in dry-run mode. Divergence, a moved canonical ref, a moved destination ref, or readback mismatch stops the mirror. A mirror error cannot undo the already confirmed Concord merge.

## Rollback

Record the prior Worker version ID before deployment. For an authorized Worker rollback, use that exact ID, then repeat `/health` and the read-only canonical SHA check. This rolls back Worker code; it does **not** rewrite Artifacts Git history or a GitHub mirror. If schema or API compatibility prevents rollback, stop traffic and have the owner decide the recovery version; do not force Git refs.

```sh
npx wrangler deployments list --config wrangler.jsonc
npx wrangler rollback '<PRIOR_WORKER_VERSION_ID>' --config wrangler.jsonc --message 'rollback Concord Worker'
curl -fsS "$CONCORD_URL/health" | jq -e '.status == "ok" and .storageBackend == "artifacts"'
npm run concord -- api GET "/repos/$CONCORD_REPO_ID" --json | jq -e --arg sha "$CHECKED_SHA" '.data.observedCanonicalOid == $sha'
```
