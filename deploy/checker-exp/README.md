# Concord checker experiment Worker

This is the separate `concord-checker-exp` Worker, authorized by owner decision **D-CF-CHECKER-GO**. It does not modify or deploy the production Concord Worker. The API accepts one exact commit SHA from the `concord-v2` repository, runs `sh scripts/validate.sh` in a standard-4 Cloudflare Container, and reports its result and measured phase/wall times.

## Cost and caps

The estimate is **wall-clock minutes × $0.007 per minute**, the spike's worst-case standard-4 rate dated **2026-10-13**. A 15-minute check is at most **$0.105**; all three permitted checks are at most **$0.315**. This is an estimate, not an invoice, and excludes any account-level fees. To halve the estimated container rate, change the runtime instance from `standard-4` to `standard-3` in `src/experiments/checker-exp-worker.ts` and update this README's cost figures.

The Worker has one Durable Object ID (`exp`) and always starts that object's container at `standard-4`, so only one instance can run. Runs are serialized: a concurrent run receives `409 BUSY`. It persists the accepted run count, including failed runs, and rejects later runs with `429 EXPERIMENT_CAP_REACHED`; `/status` cannot reset it. `EXP_RUN_LIMIT` defaults to 3 and accepts only values 1–3; a fresh deployment with a new value is needed to change the limit. Request bodies are read as a stream and capped at 16 KiB; oversized bodies, including chunked requests, receive `400 INVALID_REQUEST`. Each individual step has a coreutils `timeout`, the request timeout defaults to 900 seconds and cannot exceed 900, and the Durable Object alarm destroys an overlong container at 15 minutes. The container sleeps after one minute idle and is also destroyed at run completion. Wrangler 4.149 rejects `max_instances` and `instance_type` config fields for Durable Object managed containers, so the one instance is guaranteed by the fixed single Durable Object ID and the runtime-selected container instance size. `phaseMs.coldStart` ends when the first `container.exec()` call is ready; clone time after readiness is charged to `fetch`. If the overall alarm fires, `timedOutPhase` identifies the active phase and `phaseMs` includes elapsed time through the alarm.

The request repository is pinned to the exact `EXP_REPO_URL` configured in `wrangler.jsonc`. The script always sends that URL and offers no repository override; the Worker rejects any other host or path before reserving a run or invoking the container. Container stdout is consumed as a stream, retaining at most 16 KiB per step and 16 KiB overall.

Git credentials are minted by the owner script with Concord's existing read-token route, `POST /v1/repos/:id/git-token`, used by `npm run concord -- repo clone`. The token is sent only in the request body and passed to `git` through the container exec environment; it is redacted from captured output. No credentials are baked into the image.

## Owner setup

1. Confirm the Cloudflare account is on Workers Paid and Docker is running.
2. From the Concord repository root, deploy this separate Worker:

   ```sh
   npx wrangler deploy --config deploy/checker-exp/wrangler.jsonc
   ```

3. Set a unique high-entropy experiment bearer secret:

   ```sh
   npx wrangler secret put EXP_TOKEN --config deploy/checker-exp/wrangler.jsonc
   ```

   Export the same value locally as `EXP_TOKEN`, and set `CHECKER_EXP_URL` to this Worker's `workers.dev` URL. Set `CONCORD_URL` and `CONCORD_TOKEN` to the owner CLI credentials that can mint a read token for `concord-v2`.
4. Run at most three exact commit checks:

   ```sh
   ./scripts/checker-exp.sh <40-or-64-hex-sha>
   ./scripts/checker-exp.sh --status
   ```

   Each check mints a 300-second read-only Git token, prints the result without printing credentials, and shows the persisted estimated cost total. Do not run the check script more than three times.
5. Remove the experiment Worker and container application when the demo is complete:

   ```sh
   npx wrangler delete --config deploy/checker-exp/wrangler.jsonc
   ```

## Dry-run configuration check

`npx wrangler deploy --dry-run --config deploy/checker-exp/wrangler.jsonc` parsed the configuration and reported: `The Docker CLI is needed to build the configured image before deploying (even in dry-run mode) but could not be launched.` Docker is not available in this sandbox, so the image build portion is deferred to owner setup. Wrangler also reported an `EPERM` while writing its debug log under the user Preferences directory; this did not prevent config parsing.
