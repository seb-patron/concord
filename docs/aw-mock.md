# AW concept mock adapter

This is a **mock boundary**, not an integration with the private AW launcher. The fixture below is an assumed public shape for one synthetic task. No launcher installation, GitHub command, paid worker, or model is read or invoked. The `worktree` field names the launcher's conceptual destination for display; the adapter never writes there. Slice 12 owns the public `demo/aw-task.json` fixture and integrated scenario driver.

## Fixture and invocation

```json
{
  "schemaVersion": 1,
  "project": "dispatch-lab",
  "taskId": "task-a",
  "explicitAttempt": 1,
  "intent": "Change alpha retry policy",
  "unitKeys": ["row:families:alpha"],
  "workerLabel": "scripted-agent-a",
  "worktree": "./demo/scripted-agent-a",
  "observedBaseOid": "0123456789abcdef0123456789abcdef01234567"
}
```

`observedBaseOid` is optional and only records what the caller last saw. It is never used to reserve an intent or select the publish base. The adapter reads Concord's current canonical OID and uses the server's accepted change base. The OID shown above illustrates JSON shape; it is **not** a candidate or publication OID. In a real run, the canonical repository must already contain a real Git commit.

`project` is an existing Concord repository ID. `taskId` is a stable caller task identifier. Both are simple 1–64 character identifiers. `explicitAttempt` starts at 1 and increases by exactly one after the previous change becomes terminal. `intent` is stable text; `unitKeys` is a nonempty, unique set from the trusted policy. `workerLabel` is only a label. `worktree` is a display path, never an output path. Unknown fields and malformed values are rejected. This is the entire assumed fixture contract; no claim of drop-in AW schema compatibility is made.

Point the CLI client at a **local** Concord Worker configured with the local Git bridge, using the local `mock-aw` fixture identity. The Worker repository must be ready, have a real `main` commit, and use units present in its trusted policy. The bridge returns local `file:` remotes. The adapter intentionally rejects nonlocal Worker URLs and non-bridge remotes. Its temporary clone and Git objects are removed after the run.

```sh
CONCORD_URL=http://127.0.0.1:8787 CONCORD_TOKEN=local-mock-aw \
  npm run aw-mock -- --fixture demo/aw-task.json --run-state demo/aw-run-state.json
```

The run-state path must be a separate file in the fixture's directory. It is atomically replaced after each phase. It stores the task-to-change mapping, lease fences, real head OID, and any structured refusal. Keep that directory outside any AW installation. The adapter does not create the directory. If the file is lost, the adapter posts the same stable intent to Concord and retrieves its active mapping; it does not infer identity from a base or head OID. It then reads the server change, live leases, registered branch, verdicts, and queue entry to resume the next action. A draft without live leases claims them; a leased draft publishes its registered branch or prepares a new candidate; a published change waits for an approval or enqueues, reclaiming expired leases before enqueue when possible; an admitted change stays queued. Terminal and checker-blocked changes remain blocked.

## Mapping and outputs

| Launcher concept | Mock operation |
| --- | --- |
| Prepare worktree | Clone the bridge-backed canonical repository to an OS temporary directory; commit a fixed, pre-authored `aw-mock-change.txt` edit as a real descendant. The fixture `worktree` remains untouched. |
| Open change | `POST /repos/:project/changes` through the shared `ConcordClient`, with a stable intent key derived from `project/taskId` and the explicit attempt. Store the returned change ID and URL. |
| Claim work | `POST /leases` with the change ID, intent, units, and expected version. Preserve returned fences. A holder conflict becomes a structured blocked result. |
| Publish candidate | Push the real commit only to the bridge-assigned candidate fork, register its branch, then `POST /changes/:id/publish` through the shared client. No synthetic OID is sent. |
| Review status | Poll the change and verdict list. A checker-blocked change remains blocked. A published change without an independent approval is `awaiting_review`; the adapter never creates a verdict. |
| Request landing | Only after an approved verdict for the active revision, `POST /queue/enqueue` with that verdict and current lease fences. `MODULE_UNAVAILABLE` and other refusals are stored as structured blocked run state. |

The JSON output includes `mock: true`, `identity`, `changeId`, `phase`, real `headOid` when available, and URLs for the change, verdicts, and queue request. It names all four launcher concepts. A `blocked` object carries the Concord code, reason, HTTP status, and conflict details when supplied. No refusal is represented as a successful launch. A blocked run is sticky on retry; an operator must inspect the refusal and use an explicit new task attempt after the server change becomes terminal. The shared client may retry a keyed transient server response up to three times within one invocation.

The server's intent reservation is the durable source of truth. The local key is `project/taskId/explicitAttempt`; the server intent key is a stable digest of `project/taskId` and its `attempt` field carries `explicitAttempt`. The digest and branch are independent of base and head OIDs. On an active retry, the adapter reads the server phase before acting, so a published change does not create another commit and a draft can continue after an interrupted run. A different intent or unit set under the same task key is a conflict. A terminal change requires the next explicit attempt, as checked by Concord.

Mutation keys identify an attempt within that task. Create uses `explicitAttempt`; publish and enqueue use the current revision and lease fences. Before a claim, the adapter reads live leases and Concord's event stream. A recorded `lease.refused` or `lease.claimed` event for the change advances the claim key only when no lease for that change remains live. This lets a draft retry after a refusal or expired lease even if the local run-state file is lost, without replaying the old keyed response. The event stream must be readable for a new claim; otherwise the adapter returns a structured block instead of guessing an attempt.

## Slice 12 handoff

The current fixed text edit proves that a real commit can cross the local bridge and be published. It is **not** the dispatch-lab candidate edit, and it is not expected to satisfy dispatch-lab's trusted checker. Slice 12 should supply its pre-authored fixture candidate and use this sequence:

1. Create and register a candidate derived from the seeded dispatch-lab canonical commit, with the policy-matched row edit and real head OID.
2. Claim the declared units, publish that candidate via the shared CLI client, and wait for trusted inspection to produce a ready revision and review manifest.
3. Have a separate fixture reviewer submit a verdict tied to that revision and manifest. The mock adapter only observes that verdict.
4. Enqueue with the verdict ID and live lease fences; preserve `MODULE_UNAVAILABLE` or any refusal as a blocked state until the queue module is available.

Future real-launcher integration needs an owner-approved public contract for task identity, attempt rollover, intent and unit mapping, source worktree location, credential handoff, candidate edit ownership, and review triggers. None of those are inferred from private AW files here. The local bridge uses `file:` remotes, while the current convenience `change publish` command accepts HTTP(S) remotes; this mock uses the same CLI client and Git helper with the public branch and publish API to exercise the bridge without changing that CLI or its transport policy.
