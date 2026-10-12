# Fleet desk

For a local preview, run `npm ci --no-audit --no-fund`, then `npm run dev -- --persist-to .wrangler/state/local-ui`. Open `http://127.0.0.1:8787/`.

Open the deployed `web/` page. With no token, Concord explains leases, exact-head checks, and bisection, then offers a password-type token field. The token stays in this tab's JavaScript memory. Sign out clears it. A read-only demo button appears only if the host explicitly sets `window.CONCORD_DEMO_VIEWER_TOKEN` (and optionally `window.CONCORD_DEMO_REPO_ID`) before `app.js` loads; there is no bundled demo token.

After sign-in, choose a repository in the header. The desk shows live counts, a work board, agents, leases, and the merge queue. Select a change for its head, units, actions, and approval history. The Inbox groups isolated bisection culprits, lease refusals, and published changes awaiting a verdict. Other diagnoses keep their honest labels: interaction set, dependency group, red baseline, or inconclusive. The UI never assigns a model unless the API provides `authorModel`.

At phone widths below 768 px, use Work, Fleet, Leases, and Queue tabs. The summary strip scrolls sideways; the page itself does not. The Inbox opens from the alert row.

The page polls `events?after=` each second and refreshes the snapshot when the repository version moves. Verdict history comes from `GET /v1/repos/:repo/changes/:change/verdicts`, including direct and carried approvals with parent review and delta evidence. Until the identity route ships, a `/v1/me` 404 shows “Signed in” with viewer-safe controls. A verdict 403 reads “Approval history is visible to reviewers.” A 401 returns to sign-in; a 403 on a repository says the token cannot see it.

Actions only appear for roles reported by `/v1/me`. The server authorizes every action. Verdict, enqueue, and withdraw requests use a fresh Idempotency-Key and the current snapshot's expectedVersion; enqueue also needs an approved verdict and current lease fences. A stale response refreshes the snapshot before another attempt.
