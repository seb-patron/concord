# Concord agent CLI

For the managing agent, claim before work begins, then land the same intent after review. See [Land a finished agent run](land.md).

```sh
npm run concord -- start --repo REPO_ID --intent-key task-17 --intent 'Tune gamma safely' --allowed-files allowed-files.txt --hold 2h --json
# Work only in the returned leases' units; keep the intent key for land.
npm run concord -- land --repo REPO_ID --source . --commit FULL_OID --intent-key task-17 --intent 'Tune gamma safely' --allowed-files allowed-files.txt
# If abandoning instead:
npm run concord -- release --repo REPO_ID --intent-key task-17
```

The Allowed-files list has one exact repository-relative path per line. Start takes the current observed canonical head unless `--base FULL_OID` is supplied, creates or reuses the change, and atomically claims one whole-file unit per path. It returns the change ID, base, current lease fences, and earliest expiry. A conflict exits 3 with holder, intent, keys, and expiry; no units from that claim are granted. Repeating start reuses the change and live leases through an ownership-checked change request. After a change is published, its units reflect the actual diff. Start validates that those units are within the Allowed-files list and renews or reacquires only leases covering them. `--hold` accepts positive `s`, `m`, or `h` durations; the server caps it through trusted `costLimits.maxLeaseHoldSeconds` (default four hours). Start renews a lease after the smaller of 60 seconds and half the requested hold has elapsed. An expired lease can be reacquired. Release abandons all live leases on the change and requires the same author token. While a queue promotion is pending, Concord refuses mutations with `409 PROMOTION_IN_PROGRESS`; start and release retry that refusal for about ten seconds before exiting 3.

The CLI speaks the Concord HTTP API. It does not require Cloudflare credentials or GitHub pull request conventions. Start with Node 22+, configure `CONCORD_URL` and `CONCORD_TOKEN`, then run commands through the npm script:

```sh
export CONCORD_URL=https://concord.example
export CONCORD_TOKEN='operator-provided-scoped-token'
npm run concord -- repo list --json
```

To avoid putting the API token in an environment file, pipe it to `--token-stdin`. The option consumes stdin, so a JSON body file cannot also be piped on that invocation.

```sh
printf '%s' "$CONCORD_TOKEN" | npm run concord -- repo list --token-stdin --json
```

The CLI never invents a local server or fixture identity. For an explicitly configured local rehearsal, point `CONCORD_URL` at the local Concord API and use the fixture token provisioned by that local configuration. Fixture identities are rejected by deployed services.

## Common options and output

`CONCORD_URL` and `CONCORD_TOKEN` are required for requests. `--token-stdin` reads the token from stdin and takes precedence over `CONCORD_TOKEN`. `--repo ID` selects a repository for commands that operate on one. Command responses and help (`help` or `--help`) are JSON on stdout. Errors are JSON on stderr.

Mutations accept `--idempotency-key KEY`; when omitted, the CLI creates one for that invocation. Reuse the same key and body when retrying a request whose response was lost. Mutations to existing resources require `--expected-version N`. `change publish` and internal Git-token requests use the version returned by their preceding repository/change reads unless the option overrides it. Create repo and create change do not require an existing-resource version. `--body-file PATH` supplies a complete JSON object for commands with a body. Arrays and objects supplied directly as options must be valid JSON.

Exit codes are `0` success, `2` usage, `3` conflict or stale version, `4` authentication/authorization, and `5` transport or server failure. A 409 response retains the server's conflict details, including lease holder and intent when supplied, and gives a retry/renew next step. The CLI never steals an active lease. `MODULE_UNAVAILABLE` is shown as an explicit server error; the CLI does not substitute sample data.

CLI stdout and stderr are redacted as structured values before JSON serialization, so even tokens containing quotes leave valid JSON. Credentials are registered from the environment, stdin, Git-token responses, and string, number, or boolean values in credential-named fields in JSON body files. The redactor masks whole strings containing a registered value in raw, percent-encoded (either escape case), base64, or Bearer form, plus common token patterns; matching numeric and boolean values are masked too. Untrusted response members whose keys contain a credential are omitted. Members whose keys or string values still contain percent escapes after ten decoding passes are also omitted and counted; standalone strings are masked. When that happens, object responses and error diagnostics include an `omittedMembers` count; for array responses the count is emitted as a separate JSON line on stderr. Fixed CLI error envelope fields retain their names and error kind. Free-text transport diagnostics use the same string redactor. Git failures report a fixed category and exit code; Git stderr is never included in CLI diagnostics.

Safe GET requests and keyed mutations retry transient transport failures, HTTP 429, and server errors for at most three attempts. A retry reuses the same request body and idempotency key and honors `Retry-After` (bounded to 30 seconds). Other requests are not retried.

## Delegated principals

```sh
npm run concord -- principals mint --role agent --repo REPO_ID --ttl 2h --name worker-1
npm run concord -- principals list [--cursor CURSOR]
npm run concord -- principals revoke PRINCIPAL_ID
```

Mint writes only the newly issued plaintext token followed by a newline to stdout, once. Store it securely at creation; list and revoke never show it. `--ttl` accepts positive seconds (`s`), minutes (`m`), or hours (`h`); the default is 24 hours. Omit `--repo` to inherit the caller's full repository scope. The server enforces role and repository subsets, parent expiry, the trusted TTL maximum, 100 repository IDs per stored scope, and active and total tenant caps. `principals list` returns up to 25 items and a `nextCursor`; pass it with `--cursor` to continue. See [the principals API](api-principals.md) for authorization and response details.

## Repository commands

To adopt a committed source tree as one provenance-stamped root commit, or
preserve its exact Git history with `--with-history`, see
[Import an existing repository](import.md). Use `npm run concord -- import
--source PATH --ref REF --repo NAME --policy-id ID --profile-id ID` with
optional repeated `--exclude GLOB`, `--exclude-file FILE`, `--require-match`, `--print-tree`,
and `--verbose`. History mode cannot be combined with exclusions.

```sh
npm run concord -- repo create --name public-aw --policy-id policy-v1 --profile-id profile-v1
npm run concord -- repo list --json
npm run concord -- repo clone --repo REPO_ID --path './canonical read-only'
```

`repo create` requires `name`, `policyId`, and `profileId`. `repo clone` requires `--repo` and `--path`; it obtains read-scoped access for the canonical storage repository and clones it read-only. Git-token requests retry a `STALE_VERSION` conflict up to five attempts, re-reading the repository version and using a fresh idempotency key each time. Supplying `--expected-version` pins the version and disables these retries. A `409 PROMOTION_IN_PROGRESS` response waits and retries with 1, 2, 4, 8, and increasing-second backoff up to 120 seconds total; each wait prints `waiting for landing in progress (Ns)`. After the deadline, the request fails with the Concord error code. Other Git-token errors include the Concord error code in the printed message (for example, `Git token request failed with HTTP 409 LEASE_CONFLICT`).

## Changes

```sh
npm run concord -- change create --repo REPO_ID --intent-key task-17 --intent-text 'Tune gamma safely' --base-oid FULL_OID --branch agent/task-17 --unit-keys '["row:families:gamma"]' --dependency-change-ids '[]'
npm run concord -- change get --repo REPO_ID --id CHANGE_ID
npm run concord -- change checkout --repo REPO_ID --id CHANGE_ID --worktree './agent worktree'
npm run concord -- change publish --repo REPO_ID --id CHANGE_ID --worktree './agent worktree' --lease-fences '{"row:families:gamma":12}'
npm run concord -- change close --repo REPO_ID --id CHANGE_ID --expected-version 4 --reason 'superseded'
```

Creation requires `intentKey`, stable `intentText`, `baseOid` (literal JSON `null` only for seed drafts), `branch`, `unitKeys`, and `dependencyChangeIds` (defaults to `[]`). A changed observed base never changes the task's `intentKey`.

Checkout gets the server-assigned candidate fork and fetches the change branch into the local `concord/<branch>` remote-tracking ref. Publish reads the server change and local `HEAD`, verifies the exact base OID is present and is an ancestor of `HEAD`, and validates the complete body and lease fences before requesting write access. The body base, head, branch, and unit set must match the server change and local `HEAD`; the push names that verified head OID explicitly, and the same identity is sent to the publish API. Supply current fences for claims that cover every declared unit; a whole-file claim can cover TSV rows in that file. It refuses a canonical storage name or canonical remote. Authentication is supplied to the Git child process through process-local Git configuration environment variables; no token is added to a remote URL or persistent Git configuration. A seed draft with no base must use the server's owner-only bootstrap flow through `api`.

## Leases

```sh
npm run concord -- lease claim --repo REPO_ID --change-id CHANGE_ID --unit-keys '["row:families:gamma"]' --intent-text 'Tune gamma safely' --ttl-seconds 120 --expected-version 4
npm run concord -- lease list --repo REPO_ID
npm run concord -- lease renew --repo REPO_ID --id LEASE_ID --fence 12 --ttl-seconds 120 --expected-version 4
npm run concord -- lease release --repo REPO_ID --id LEASE_ID --fence 12 --expected-version 4
npm run concord -- renew --repo REPO_ID --intent-key task-17 --hold 5m
npm run concord -- renew --repo REPO_ID --intent-key task-17 --every 100 &
```

Claim requires `changeId`, `unitKeys`, and `intentText`; `ttlSeconds` defaults to 120. Renew and release require the current `fence`. On a 409 lease refusal, inspect the reported holder, intent, conflicting units, and expiry. Retry after that work is complete, or renew your own current lease; the CLI never takes ownership automatically.

`concord renew` extends every live lease for the change matching the intent key in one request, using a five-minute hold by default. It preserves fences and never shortens a hold. Use `--every SECONDS` as a heartbeat while editing; the example keeps a five-minute start hold alive. It stops when the parent process exits; use `--while-pid PID` to watch another process. Renew before a lease's remaining time falls under about 100 seconds.

## Queue, findings, repair, review, and events

```sh
npm run concord -- queue list --repo REPO_ID
npm run concord -- queue enqueue --repo REPO_ID --change-id CHANGE_ID --verdict-id VERDICT_ID --lease-fences '{"row:families:gamma":12}' --expected-version 4
npm run concord -- queue withdraw --repo REPO_ID --change-id CHANGE_ID --reason 'rework required' --expected-version 4
npm run concord -- finding list --repo REPO_ID --change-id CHANGE_ID
npm run concord -- finding add --repo REPO_ID --change-id CHANGE_ID --revision 1 --unit-key row:families:gamma --text 'Timeout is invalid' --evidence-digest sha256:0123 --expected-version 4
npm run concord -- repair submit --repo REPO_ID --change-id CHANGE_ID --revision 2 --finding-set-version 3 --dispositions '[{"findingId":"FINDING_ID","explanation":"Corrected timeout","evidenceDigest":"sha256:0123"}]' --expected-version 4
npm run concord -- repair review --repo REPO_ID --change-id CHANGE_ID --round-id ROUND_ID --revision 2 --finding-set-version 3 --decision accept --evidence-digest sha256:0123 --expected-version 4
npm run concord -- verdict add --repo REPO_ID --change-id CHANGE_ID --revision 2 --review-manifest-digest sha256:0123 --finding-set-version 3 --decision approve --evidence-digest sha256:4567 --expected-version 4
npm run concord -- verdict carry --repo REPO_ID --change-id CHANGE_ID --parent-verdict-id VERDICT_ID --revision 3 --new-base-oid FULL_OID --expected-version 4
npm run concord -- events list --repo REPO_ID --after 0
npm run concord -- events --tenant [--cursor CURSOR]
```

Queue enqueue requires `changeId`, `verdictId`, and the unit-to-fence `leaseFences` map. Withdraw requires `changeId` and `reason`. Finding add requires `revision`, `unitKey`, `text`, and `evidenceDigest`. Repair submit requires `revision`, `findingSetVersion`, and a complete `dispositions` array; each disposition has `findingId`, `explanation`, and `evidenceDigest`. Repair review requires the round ID in the path plus `revision`, `findingSetVersion`, `decision` (`accept` or `reject`), and `evidenceDigest`. Verdict add requires `revision`, `reviewManifestDigest`, `findingSetVersion`, `decision` (`approve` or `reject`), and `evidenceDigest`. Carry requires `parentVerdictId`, `revision`, and `newBaseOid`. Repository events accept an optional monotonic `after` sequence. `events --tenant` reads the tenant catalog log with an owner or viewer token; it includes principal mint and revoke events and returns a paginated JSON envelope. Pass `nextCursor` to `--cursor` for the next page. See [the principals API](api-principals.md#tenant-events) for event fields and polling behavior.

## Advanced API

Use `api METHOD PATH` for supported API operations that have no convenience command. Paths may start with `/v1/` or be relative to `/v1/`; they must begin with `/`. Raw or encoded dot segments, backslashes, and paths that change the configured origin or escape `/v1/` are rejected before a request is sent. Mutations should use `--body-file`, `--idempotency-key`, and, when required, `--expected-version`.

```sh
npm run concord -- api POST /repos/REPO_ID/bootstrap --body-file ./bootstrap.json --idempotency-key bootstrap-seed --expected-version 1
npm run concord -- api GET /repos/REPO_ID/snapshot
```

The generic command preserves API success and failure envelopes. It does not grant authorization beyond the configured Concord token.

# Repository metrics

`concord metrics --repo ID --since ISO_UTC --until ISO_UTC` prints the repository's measured flow metrics. See [metrics API](api-metrics.md) for bounds and definitions.
# Issues and milestones

Use `concord issue create --repo ID --title TITLE --body MARKDOWN` to record a task. `issue list`, `issue get --id NUMBER`, `issue edit --id NUMBER --expected-version N`, `issue close --id NUMBER --reason TEXT --expected-version N`, and `issue reopen` cover the issue lifecycle. `--labels` and `--allowed-files` accept JSON arrays. Link a change with `concord change create ... --issue N`.

Agents and owners can use `concord milestone create --repo ID --title TITLE [--description TEXT] [--due-date YYYY-MM-DD]` by default. Owners can lock creation to owners in the Milestones screen or through the [settings API](api-issues.md#milestones). Also use `milestone list`, `milestone get --id ID`, and `milestone close --id ID --expected-version N`. See the [issues API](api-issues.md).
