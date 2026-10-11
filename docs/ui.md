# Concord web UI walkthrough (slice 08)

Static, framework-free operations screen: one page with a detail panel over
the frozen snapshot/events contract. No framework, no chart library, no
account settings, no OAuth.

## Run it

```sh
npm ci --no-audit --no-fund
npm run dev -- --persist-to .wrangler/state/local-ui
```

Open `http://127.0.0.1:8787/` (1280x720 is the presentation layout). The
Worker serves `web/` directly; `/health` reports the backend badge.

1. The badge reads **local fake** (local Worker + in-process fake storage).
   With the loopback bridge it reads **local bridge**; against deployment it
   reads **live Artifacts**. Anything else reads **unknown backend**.
2. Enter a session token once (for example `local-viewer` to browse, or
   `local-agent-a` / `local-reviewer` for mutation buttons). The token lives
   in page memory only: never the URL, never localStorage. Use Forget to drop
   it.
3. Pick a requested role. This choice is unverified because v1 has no identity
   endpoint; the server authorizes each action using the token's actual roles.
   Viewer mode hides mutation controls. A refused mutation names the missing role.
4. Pick a repo (or type its ID). Panels poll `GET events?after=` every
   second and refresh the snapshot when the repo version moves. Selection,
   focus, and scroll survive each re-render.

## What each panel means

- **Lease board**: unit key, holder, intent text, fence, countdown. A
  conflict names the holder, their intent, and the expiry; the blocked
  change links to it.
- **Changes**: intent/agent, semantic units, state, and one next action.
  Keyboard: Tab to the list, arrows to move, Enter to open details.
- **Change details**: base/head OIDs, revision, next action, and the
  claim / enqueue-withdraw / verdict forms allowed for the acting role.
  Every mutation sends `Idempotency-Key`; versioned actions also send
  `expectedVersion` (the claim creation route has no version field). A stale
  409 refreshes the snapshot and asks for a retry; it never reports
  success.
- **Findings round**: open vs resolved findings and the repair-round state.
  A partial repair stays `unresolved`; only the independent reviewer moves
  it to `pending-review` and then resolved.
- **Approval provenance**: no verdict records are available in this panel
  today. The snapshot's verdict projection returns `items: []`, and the UI
  renders verdicts from that snapshot only. A per-change verdict GET route
  exists, but the UI does not call it yet. Wiring that route into the panel
  is a separate slice; until then, the panel cannot show direct or carried
  verdicts, parent reviews, or delta evidence.
- **Queue and bisection**: membership, sequence, blocked reasons. A failed
  stack highlights only the supported outcome: the singleton culprit, the
  failing set (`INTERACTION`, never single-blamed), the dependency group,
  `BASE_RED` (nothing blamed), or `INCONCLUSIVE` (nothing named).
- **Runner health**: checker/promoter state, last seen, active job.
- **Canonical tip**: observed main OID. **History**: historical simulation
  is `unavailable` here — no replay dataset ships with this view, and no
  percentage is computed.

## Data routes and demo mapping (docs/DEMO.md scenes)

The panels read projections from `GET /v1/repos/:repoId/snapshot`. The table
names that route, the source module, and any module route used by that panel;
event details also come from `GET /v1/repos/:repoId/events?after=`.

| Panel | Route and module read |
| --- | --- |
| Lease board | Snapshot `leases` projection from `src/features/leases.ts`; mutations use `POST /v1/repos/:repoId/leases`. |
| Changes and change details | Snapshot `repos` projection from `src/features/repos.ts`; claim uses the leases route, enqueue/withdraw use `src/features/queue.ts`, and verdict submission uses `src/features/verdicts.ts`. |
| Queue and bisection | Snapshot `queue` projection from `src/features/queue.ts`; its read route is `GET /v1/repos/:repoId/queue`. |
| Runner health | Snapshot `runners` projection from `src/features/runners.ts`; job polling and results use that module's runner/job routes. |
| Findings round | Snapshot `findings` projection from `src/features/findings.ts`; detail reads use `GET /v1/repos/:repoId/changes/:changeId/findings` and `/repairs`. |
| Approval provenance | Snapshot `verdicts` projection from `src/features/verdicts.ts` currently returns `items: []`; the per-change `GET /v1/repos/:repoId/changes/:changeId/verdicts` route exists but the UI does not call it. Verdict writes use `POST /v1/repos/:repoId/changes/:changeId/verdicts`. |
| Canonical tip | Snapshot `repos` projection from `src/features/repos.ts`. |
| History and events | History has no replay data route in this screen; the event log reads `GET /v1/repos/:repoId/events?after=`. |

The demo scenes seed backend state through the documented commands. The UI
renders the corresponding returned projections and event records:

| DEMO scene | Expected UI observation today |
| --- | --- |
| X lease conflict on alpha | Lease board reads the lease projection; a refused claim's conflict evidence identifies the live holder. |
| B red stack, bisection to singleton B | Queue panel reads queue entries and diagnostic outcomes from the queue projection. |
| B-repair clears two findings | Findings panel reads finding and repair-round records from the findings projection. |
| D carried approval, H invalidation | Backend state includes carried approval and invalidation evidence, but the provenance panel shows no verdict records today: it renders only the empty snapshot verdict projection and does not call the per-change verdict GET route. |
| J epsilon contest 2/4 vs 4/4 | Queue panel displays the arbitration outcome recorded by the queue module. |
| AW-task seven attempts, one change | Changes panel displays repo change records; attempt and task evidence is shown only when present in returned records. |
| Offline runner / flake | Runner state comes from the runner projection; missed health polls show `Disconnected` and disable mutations. |

The state/render suite (`tests/node/ui.test.ts`) covers the display and
mutation rules above against labelled fixtures — rejected claim, stale
mutation, bisection display, unresolved repair, carried/invalidation
verdicts, network recovery, script-like intent text, and focus
preservation. The walkthrough above was verified against a local fake
backend on this worktree; no live Artifacts run was available.

## Snapshot projection shape

The coordinator keys projections by `repos`, `leases`, `queue`, `runners`,
`findings`, and `verdicts`. The UI reads `repos.items` for canonical repo data
and `repos.changes` for changes; `findings.items` for findings,
`findings.rounds` for repair rounds, and `findings.findingSetVersions[changeId]` for
review evidence. Lease fences come from `leases.items`. Missing evidence blocks
mutation with a visible message. The verdict snapshot currently returns
`verdicts.items: []`; the UI renders only this snapshot projection and does
not call the available per-change verdict GET route. As a result, verdict
records, parent links, and delta evidence are not displayed today. A separate
slice must wire that route into the UI before the panel can display them. A
projection's availability is reported by its owning module; the UI does not
infer records absent from the response.

## UI evidence and response audit

Every asynchronous UI path captures the current session and repository
generation. Changing tokens, forgetting a token, or switching repositories
advances a generation; an older completion is ignored. The UI tracks the
highest version seen in any snapshot, event response, or successful mutation
response. A snapshot below that version is ignored; mutation controls stay
disabled until a snapshot reaches it. An older snapshot cannot replace a
newer one, including when a mutation response arrives after the newer snapshot.

| Call site | Protection | Test in `tests/node/ui.test.ts` |
| --- | --- | --- |
| `refreshBadge` health request | Generation guard before updating the badge; repo switches request a new badge | Delayed health response after Forget |
| `refreshRepos` catalog request and token form continuation | Generation guard before catalog/error rendering; false result stops the form continuation | Delayed catalog response after Forget |
| `refreshSnapshot` from repo switch, periodic tick, and mutation refresh | Generation and high-water version guards before storing or rendering; a missing current snapshot disables mutations | Delayed snapshot after Forget; delayed old repo response after switch; stale 409 refresh failure; event and mutation versions ahead of snapshot |
| `pollOnce` event pages and `tick` recovery/error paths | Generation guard on every page and after awaits; nonadvancing pages stop pagination | Delayed poll after Forget; 101 event pages |
| `runMutation` success, failure, and refresh paths | Generation guard after mutation and refresh; successful response versions advance the required snapshot version; a previously received newer snapshot remains valid | Delayed mutation response after Forget; stale 409 and lease conflict fixtures; mutation-before-snapshot and snapshot-before-mutation assertions |
| Lease holder links in change details and conflict status | Link only when a matching lease card is rendered | DOM lease conflict links |
| Parent verdict links | Referenced parent is included in the rendered verdict set | DOM carried verdict parent link |
| Delta evidence links | Events are indexed by related ID across pages; referenced events evicted from the 100-row visible log get an archive anchor; the index clears on repo/session change | DOM 101-event boundary and Forget assertions |
| Claim body | Selected change and requested registered unit keys must be present; input count and intent are checked | DOM missing selection and unknown unit key assertions |
| Enqueue body | Current snapshot version, matching approved verdict/revision/finding set, complete change unit keys, and live finite lease expiries/fences are required | DOM current enqueue and missing verdict/unit tests; helper missing/invalid expiry tests |
| Withdraw body | Current snapshot, selected change, and valid version are required | DOM withdraw request assertion |
| Verdict body | Current snapshot, revision, finding set, decision, and both digests are required | DOM verdict request and missing digest assertions |
