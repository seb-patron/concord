# Concord deployment and one-way demo mirror

The local bridge is a development fake. A public deployment uses the `concord-demo` Artifacts namespace and `wrangler.jsonc`; it never uses `wrangler.local.jsonc` or `BRIDGE_URL`. No Cloudflare account or GitHub destination is provisioned by this repository. The owner must authorize account creation, deployment, and any mirror push. Keep `CONCORD_SHOW_DECOMPILED_C=0`; this release contains only the original public synthetic fixture.

## Phone and remote sign-in with Cloudflare Access

1. In **Workers & Pages > concord > Settings > Domains & Routes > workers.dev**, enable Cloudflare Access and choose **Manage Cloudflare Access**. Record the application's AUD tag and team domain (`<team>.cloudflareaccess.com`).
2. Edit that Access application and protect only the path `v1/session/signin`. Add an Allow policy with **Include > Emails >** your login email and One-time PIN. Confirm `curl -s -o /dev/null -w '%{http_code}' https://concord.sebastian-patrones.workers.dev/health` prints `200` and `/v1/session/signin` prints `302`. If `/health` returns `302`, turn Access off and tell the orchestrator; the edge is redirecting agents and health checks.
3. In the Worker's **Settings > Variables and Secrets**, add `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as type **Secret**. `wrangler.jsonc` declares plain `vars`, which are replaced on deploy.
4. Add the owner mapping to the private trusted configuration and reinstall it: `"humans":[{"email":"<your Access email>","tenantId":"<from concord api GET /v1/me with your owner token>","principalId":"seb","roles":["owner"],"repoIds":"*"}]`.
5. On the phone, open the Worker URL, tap **Sign in with Cloudflare Access**, and enter the emailed code. The app stores a short-lived HttpOnly cookie scoped to `/v1`; bearer API calls for agents continue to work on the same hostname.

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

The owner supplies `CLOUDFLARE_ACCOUNT_ID` (32 hex characters), `CLOUDFLARE_API_TOKEN` with Workers and Artifacts permissions, and an existing `concord-demo` namespace. Keep credentials in the operator environment or a secret manager. Never commit them or pass them in URLs. Set `AUTH_TOKENS_FILE` and `TRUSTED_CONFIG_FILE` to operator-owned files **outside this clone**. For a configuration too large for one secret, also set `TRUSTED_PARTS_FILE` to a new path outside the clone where `deploy:trusted-parts` writes its bulk file (it refuses to overwrite an existing file, so remove the previous one or pick a new path before each regeneration); see [Large trusted configurations](#large-trusted-configurations). `AUTH_TOKENS` is the production JSON map from SHA-256 bearer token digests to scoped principal records; `TRUSTED_CONFIG` contains only owner-approved policy, profile, and cost-limit records. Do not put local fixture identities in either file. See [auth and trust](ARCHITECTURE.md#auth-and-trust).

`TRUSTED_CONFIG` may carry an owner-installed `costLimits` object. `maxActiveChangesPerRepo` is the install-wide ceiling on non-terminal changes per repo (integer 1–1000, default 32); `activeChangeLimits` maps individual repoIds to overrides in the same range for swarm repositories. Unknown keys and out-of-range or non-integer values fail closed as `TRUSTED_CONFIG_INVALID`, and there is no API or CLI path for agents to set either key. Mother Base and every repo keep the default of 32:

```json
{ "policies": {}, "profiles": {}, "costLimits": { "maxActiveChangesPerRepo": 32, "activeChangeLimits": { "swarm_repo": 128 } } }
```

```sh
export CLOUDFLARE_ACCOUNT_ID='<owner account ID>'
export CLOUDFLARE_API_TOKEN='<owner provisioned API token>'
export AUTH_TOKENS_FILE='<absolute private path>'
export TRUSTED_CONFIG_FILE='<absolute private path>'
export TRUSTED_PARTS_FILE='<new absolute private path; parts format only>'
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

On a fresh account, register a `workers.dev` subdomain in Cloudflare before deploying. Wrangler could not automatically register the name `concord` for this deployment. The **first** deployment must create the Worker and its secrets together; `versions upload` and `versions secret put` fail beforehand with code 10007 (`Worker does not exist`). Choose the single-secret or parts format for that first deployment. Keep all input and generated files private and outside the clone.

For a first deployment with a configuration that fits one secret, create a mode-0600 secrets JSON file containing `AUTH_TOKENS` and `TRUSTED_CONFIG`, then deploy it:

```sh
umask 077
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/concord-secrets.XXXXXX")"
jq -n --rawfile auth "$AUTH_TOKENS_FILE" --rawfile trusted "$TRUSTED_CONFIG_FILE" \
  '{AUTH_TOKENS:$auth,TRUSTED_CONFIG:$trusted}' > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
test -s "$SECRETS_FILE" && npx wrangler deploy --config wrangler.jsonc --secrets-file "$SECRETS_FILE"
```

Remove the temporary file from the operator machine after recording the deployed URL. The two JSON values are Worker secret strings containing the contents of the private files; `jq --rawfile` preserves that shape. See `src/state.ts` and `src/auth.ts` for how the Worker reads them.

For a **first deployment with parts**, build the bulk file, then create a secrets JSON file containing `AUTH_TOKENS` and every key from that bulk file. The bulk file contains `TRUSTED_CONFIG_PARTS` and all `TRUSTED_CONFIG_PART_*` values. Do not include `TRUSTED_CONFIG`:

```sh
npm run deploy:trusted-parts -- --in "$TRUSTED_CONFIG_FILE" --out "$TRUSTED_PARTS_FILE"
umask 077
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/concord-secrets.XXXXXX")"
jq -n --rawfile auth "$AUTH_TOKENS_FILE" --slurpfile parts "$TRUSTED_PARTS_FILE" \
  '$parts[0] + {AUTH_TOKENS:$auth}' > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
test -s "$SECRETS_FILE" && npx wrangler deploy --config wrangler.jsonc --secrets-file "$SECRETS_FILE"
```

For later code-only releases, run `npx wrangler deploy --config wrangler.jsonc`; existing secrets persist. For a parts-config refresh, regenerate the bulk file and run `npx wrangler secret bulk "$TRUSTED_PARTS_FILE" --config wrangler.jsonc` while the latest Worker version is deployed. Bulk secret upload deploys the updated secrets. The versioned release flow below, using `versions upload` and `versions secret put`, is for the single-secret format only; versioned releases are not supported for parts in this version. None of these secret values belongs in `wrangler.jsonc` or an `.env` file in the clone. [Wrangler versioned secrets and rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/) are documented by Cloudflare.

For a parts-based Worker, use this sequence for code-only releases or config refreshes:

```sh
# Code-only release; current secrets persist.
npx wrangler deploy --config wrangler.jsonc

# Config refresh; the current version must be deployed before bulk upload.
npm run deploy:trusted-parts -- --in "$TRUSTED_CONFIG_FILE" --out "$TRUSTED_PARTS_FILE"
npx wrangler secret bulk "$TRUSTED_PARTS_FILE" --config wrangler.jsonc
```

```sh
test -s "$AUTH_TOKENS_FILE" && test -s "$TRUSTED_CONFIG_FILE"
npx wrangler versions upload --config wrangler.jsonc
npx wrangler versions secret put AUTH_TOKENS --config wrangler.jsonc < "$AUTH_TOKENS_FILE"
npx wrangler versions secret put TRUSTED_CONFIG --config wrangler.jsonc < "$TRUSTED_CONFIG_FILE"
npx wrangler deploy --config wrangler.jsonc
```

This versioned secret-release sequence supports `TRUSTED_CONFIG` only. Do not use it for `TRUSTED_CONFIG_PARTS` or numbered parts.

If versioned secret provisioning reports that no Worker/version exists, use the first-deploy path above after confirming the account state with the owner; do not publish a fixture-authenticated substitute. A production secret change is a release action too. Do not run these commands during an account-free local rehearsal.

### Refresh trusted digests before creating repositories

For the demo policy, `demo/scenarios.ts` preflight reads `demo/profile.json` and hashes the bytes of `demo/checker.mjs` for `checkerDigest`; it does **not** hash `runner/profiles.ts` for that field. It builds `profileDigest` from the profile template, that checker hash, `dispatchArgv` from `runner/profiles.ts`, the local Node executable's byte hash, and the runtime's platform/architecture/Node version. It builds the demo `policyDigest` from `demo/units.json` plus the checker hash. The committed case matrix in `runner/profiles.ts` validates the profile cases, so a matrix change also requires a matching `demo/profile.json` update. For non-demo generated policies, `runner/generate-units.ts` instead hashes the policy template plus file units derived from the pinned repository tree and approved planned paths. These inputs and digest checks are implemented in `demo/scenarios.ts`, `runner/profiles.ts`, `runner/generate-units.ts`, and `src/features/leases.ts`.

After a change to `demo/profile.json`, `demo/checker.mjs`, `demo/units.json`, the `dispatchArgv` or required case matrix in `runner/profiles.ts`, or the pinned Node executable/runtime, rerun `npm run demo -- preflight --local --state-dir <dir>`. If the Worker uses the single-secret format, install the regenerated config with `npx wrangler secret put TRUSTED_CONFIG < <dir>/trusted-config.json`. If it uses `TRUSTED_CONFIG_PARTS`, regenerate the bulk file and run `npx wrangler secret bulk "$TRUSTED_PARTS_FILE" --config wrangler.jsonc` while the latest version is deployed; do not put `TRUSTED_CONFIG`. Otherwise runners stay idle on a digest mismatch. Use an absolute `<dir>` outside the clone, then run the health check below. A generated policy likewise needs regeneration and installation whenever its template or pinned path set changes.

After changing `TRUSTED_CONFIG`, existing Durable Object instances, especially `TenantCatalog`, can continue using the previous binding until restart or idle eviction; the observed delay was roughly 2–3 minutes. Allow about 90 seconds with no traffic before creating repositories, and retry only after the new config is active. Each Worker isolate parses the trusted config once per distinct config text and reuses it for every repo and request. A request that sees new config text parses it again, so this cache adds no delay beyond the binding refresh described here. A repo created against the old policy digest can fail with `UNIT_POLICY_UNAVAILABLE` (`src/catalog.ts`, `src/features/leases.ts`).

### Large trusted configurations

For a trusted configuration too large for one Worker secret, set `TRUSTED_PARTS_FILE` to a new absolute path outside the clone and create a private bulk file. For a first deployment, use the first-deploy secrets-file recipe above. For later releases, use code-only deploys or refresh secrets with `secret bulk` while the latest version is deployed. The versioned release flow is not supported for parts in this version. The parts format supports exactly `TRUSTED_CONFIG_PARTS` and the numbered `TRUSTED_CONFIG_PART_*` keys emitted by this helper:

```sh
npm run deploy:trusted-parts -- --in "$TRUSTED_CONFIG_FILE" --out "$TRUSTED_PARTS_FILE"
```

The helper creates a mode-0600 file and refuses to overwrite one. To switch an existing Worker from the single secret, delete `TRUSTED_CONFIG` **first**, then upload the numbered parts and count:

```sh
npx wrangler secret delete TRUSTED_CONFIG --config wrangler.jsonc
npx wrangler secret bulk "$TRUSTED_PARTS_FILE" --config wrangler.jsonc
```

Between the two commands, requests fail closed because the trusted config is unavailable for about a minute. Bulk upload adds or updates only the named secrets; `AUTH_TOKENS` and other existing secrets stay in place. Never activate both trusted-config formats at once. Durable Objects may keep the previous config for a few minutes; wait about 150 seconds with no traffic after the upload before creating repositories. Keep the bulk file private and outside the clone.

To switch back to the single secret, delete `TRUSTED_CONFIG_PARTS` **before** putting `TRUSTED_CONFIG`. The Worker ignores leftover numbered parts:

```sh
npx wrangler secret delete TRUSTED_CONFIG_PARTS --config wrangler.jsonc
npx wrangler secret put TRUSTED_CONFIG --config wrangler.jsonc < "$TRUSTED_CONFIG_FILE"
```

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

For a Worker using the single-secret format, upload the newly generated `AUTH_TOKENS` and `TRUSTED_CONFIG` with the versioned commands in [Provision secrets and deploy](#provision-secrets-and-deploy). For a Worker using `TRUSTED_CONFIG_PARTS`, do not use the versioned flow: run `npx wrangler secret put AUTH_TOKENS --config wrangler.jsonc < "$AUTH_TOKENS_FILE"` (it deploys immediately), then regenerate the bulk file and run `npx wrangler secret bulk "$TRUSTED_PARTS_FILE" --config wrangler.jsonc`, and never put `TRUSTED_CONFIG`. Do not reuse a deployment with an old token mapping. The commands in this section are remote-only and intentionally outside the `verified-by: 12c` local command blocks. Run the health check and seed after Wrangler prints the deployed URL.

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
