# Concord web UI walkthrough (slice 08)

Static, framework-free operations screen: one page with a detail panel over
the frozen snapshot/events contract. No framework, no chart library, no
account settings, no OAuth.

## Run it

```sh
npm ci --no-audit --no-fund
npm run dev
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
  Every mutation sends `Idempotency-Key` plus `expectedVersion`. A stale
  409 refreshes the snapshot and asks for a retry; it never reports
  success.
- **Findings round**: open vs resolved findings and the repair-round state.
  A partial repair stays `unresolved`; only the independent reviewer moves
  it to `pending-review` and then resolved.
- **Approval provenance**: direct verdicts show reviewer, revision, and
  finding-set version. Carried verdicts link the parent review and the
  delta evidence; refused carry states the concrete reason (for example a
  changed beta dependency).
- **Queue and bisection**: membership, sequence, blocked reasons. A failed
  stack highlights only the supported outcome: the singleton culprit, the
  failing set (`INTERACTION`, never single-blamed), the dependency group,
  `BASE_RED` (nothing blamed), or `INCONCLUSIVE` (nothing named).
- **Runner health**: checker/promoter state, last seen, active job.
- **Canonical tip**: observed main OID. **History**: historical simulation
  is `unavailable` here — no replay dataset ships with this view, and no
  percentage is computed.

## Honest demo mapping (docs/DEMO.md scenes)

Feature slices 02–07 have not landed in this worktree: every module route
returns `501 MODULE_UNAVAILABLE` and every snapshot projection reports
`{ status: 'unavailable', items: [] }`. So a manual walkthrough today
observes the shell behaving correctly around absence, not the fleet scenes:

| DEMO scene | Expected UI observation today |
| --- | --- |
| X lease conflict on alpha | Lease board: `Unavailable` panel, not a faked conflict |
| B red stack, bisection to singleton B | Queue: `Unavailable`; bisection tree states unavailability |
| B-repair clears two findings | Findings: `Unavailable`; repair copy explains the exact-set rule |
| D carried approval, H invalidation | Provenance: `Unavailable`; verdict copy explains carry links |
| J epsilon contest 2/4 vs 4/4 | Queue card copy explains score arbitration; no scores shown |
| AW-task seven attempts, one change | Changes: `Unavailable`; intent-key dedupe copy in detail panel |
| Offline runner / flake | Three missed polls show `Disconnected`; mutations disable |

The state/render suite (`tests/node/ui.test.ts`) covers the display and
mutation rules above against labelled fixtures — rejected claim, stale
mutation, bisection display, unresolved repair, carried/invalidation
verdicts, network recovery, script-like intent text, and focus
preservation — so when slices 02–07 land, the panels already know how to
explain them. The walkthrough above was verified against a local fake
backend on this worktree; no live Artifacts run was available.

## Snapshot projection shape for slice integration

The coordinator keys projections by `repos`, `leases`, `queue`, `runners`,
`findings`, and `verdicts`. The UI reads `repos.items` for canonical repo data
and `repos.changes` for changes; `findings.items` for findings,
`findings.rounds` for repair rounds, and `findings.findingSetVersions[changeId]` for
review evidence. Lease fences come from `leases.items`. Missing evidence blocks
mutation with a visible message. These additive fields are the expected shape
for the feature slices when they land; the current placeholders remain
`{ status: 'unavailable', items: [] }`.
