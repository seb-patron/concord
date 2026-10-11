# Concord demo: nine minutes from intent to checked history

This is the implementation and filming contract, not a claim that the commands already exist. Slice 12 reconciles it with the finished build. Target video length: 9:00, with a 30-second margin below the competition's ten-minute ceiling. Use a 1280x720 browser plus a readable terminal; record the application and real checker output.

The public demonstration repository is **dispatch-lab**, a tiny original MIT retry-policy registry inspired by an agent launcher. It contains no private AW code. Three scripted agent identities make actual API requests and Git commits concurrently; label them scripted agents, not live model sessions. The owner can reproduce it without a paid model, ROM, proprietary toolchain, or decompiled C.

## Exact public fixture

Slice 12 owns `demo/dispatch-lab/families.tsv` with literal tab separators:

```text
family	retry_limit	timeout_ms
alpha	1	1000
beta	2	1000
gamma	3	1000
delta	4	1000
epsilon	1	500
```

`demo/checker.mjs` is a trusted Node checker kept outside candidate worktrees. `node demo/checker.mjs --repo PATH --unit all` reads only that table and checks exact schema, unique required rows, integer retry limits 1–5, and integer timeouts 250–2000 ms. It runs golden cases for the public dispatch calculation `attemptBudget = retry_limit * timeout_ms`, including alpha's seed result 1000 and gamma's seed result 3000 when those rows retain seed content; expected values for edited rows are computed from an independent reference routine, not hard-coded per change ID. Malformed, duplicate, missing, or out-of-range rows fail. Candidate edits cannot modify the checker, goldens, or policy used for that run.

For the optional contest, hard safety checks still apply. Epsilon's quality score counts which four public simulated task durations `[250,500,750,1000]` fit its timeout. A 500-ms candidate scores 2/4 and a 1000-ms candidate 4/4. No task actually sleeps; this is a deterministic synthetic quality measure, not a decomp byte-match measurement. Ordinary projects use pass/fail first-green. The runner measures actual checker wall time; no duration is scripted.

`demo/units.json` registers `row:families:<family>` footprints in `families.tsv`, plus a file-wide fallback. The trusted review policy gives alpha a dependency on beta and each other row no cross-row dependency. It records table schema and checker/profile digests for every manifest. This deliberately small declared domain makes independent-row carry demonstrable; it is not automatic semantic inference.

The AW fixture is schemaVersion=1, project=`public-aw`, taskId=`task-17`, explicitAttempt=1, intent=`Increase gamma retry budget safely`, unitKeys=`["row:families:gamma"]`, workerLabel=`scripted-aw`, and worktree equal to the manifest's absolute AW-task checkout path. The driver materializes that path in its temporary runtime copy of the public fixture. Retry inputs may refresh observedBaseOid from actual observed history, but never alter the stable intent. `demo/profile.json` pins the public checker, policy, golden durations, and Node version digest; those digests are computed from the delivered files at seed time and recorded in the manifest, not supplied as invented constants here.

| Alias in run manifest | Principal / intent | Exact delta from scene's captured base | Purpose |
| --- | --- | --- | --- |
| A | agent-a / tune-alpha | alpha retry_limit 1 → 2 | Good change on a shared file |
| X | agent-b / alpha-alternative | No edit; attempts alpha while A holds it | Separate draft receives the expected lease conflict, then closes |
| B | agent-b / tune-gamma | gamma retry_limit 3 → 0; timeout_ms 1000 → 0 | One candidate with two real validation failures |
| C | agent-c / tune-delta | delta retry_limit 4 → 5 | Independent good change on that same file |
| B-repair | agent-b / same change and intent | gamma retry_limit → 4; timeout_ms → 1250 | One repair clears two findings |
| D | agent-a / alpha-carry | alpha retry_limit 2 → 3 | Approval carried after independent base movement |
| E | agent-c / delta-base | delta retry_limit 5 → 4; timeout_ms 1000 → 1500 | Advances main without changing D's scope |
| H | agent-a / alpha-invalidate | alpha retry_limit 3 → 4 | Approval that must be invalidated |
| I | agent-b / beta-dependency | beta retry_limit 2 → 3 | Changes H's declared dependency |
| J-low | contest-agent-low / epsilon-contest | epsilon retry_limit 1 → 2; timeout_ms stays 500 | Valid candidate, synthetic score 2/4 |
| J-high | contest-agent-high / same contest | epsilon retry_limit 1 → 2; timeout_ms 500 → 1000 | Valid candidate, synthetic score 4/4 |
| AW-task | mock-aw / public-aw/task-17/attempt-1 | gamma retry_limit 4 → 5 | Same task retried seven times; remains awaiting review |

A/B/C originate from the same seed commit. Later scenes start from the current observed canonical tip. The manifest stores actual repo IDs, candidate forks, change IDs, lease fences, request versions, full OIDs, job IDs, and result digests. Friendly aliases are not server IDs or fabricated SHAs. Scene steps read current versions and wait for explicit state predicates with a 60-second maximum. On timeout, print the actual blocked state and stop; do not force progress.

## Rehearsal setup

Prerequisites after implementation: Node 22+, npm, native Git, four terminals, and the published repository. `npm ci` installs the pinned toolchain. No Cloudflare account is needed for the local path. The final competition capture additionally needs the provisioned deployment described below.

Terminal 1, API Worker (keep foreground):

```sh
npm ci
sh scripts/validate.sh
npm run dev -- --var STORAGE_BACKEND:bridge --var LOCAL_GIT_URL:http://127.0.0.1:8788 --var LOCAL_GIT_TOKEN:local-bridge
```

Terminal 2, local fake Git backend (keep foreground; choose an empty directory):

```sh
export CONCORD_GIT_DIR="$(mktemp -d)"
CONCORD_BRIDGE_TOKEN=local-bridge npm run git-bridge -- --host 127.0.0.1 --port 8788 --data-dir "$CONCORD_GIT_DIR"
```

Terminal 3, scenario driver:

```sh
export CONCORD_URL=http://127.0.0.1:8787
export CONCORD_TOKEN=local-owner
export CONCORD_SHOW_DECOMPILED_C=0
export CONCORD_RUN_DIR="$(mktemp -d)"
npm run demo -- preflight --local
npm run demo -- seed --run demo-01 --state-dir "$CONCORD_RUN_DIR"
```

`seed` creates a new logical repo and seed draft fork, pushes the public seed there, requests owner-only bootstrap validation and conditional initial promotion, and captures the checked seed OID. It pumps the local checker/promoter for bootstrap in local mode, then allocates draft changes A/B/C/X, prepares A/B/C worktrees, and prints the repo URL. Bootstrap is allowed only for empty main; all main writes, including initialization, use stored promoter tickets. `seed` repeated with the same run ID returns the same manifest; it never deletes existing history. A fresh rehearsal uses `demo-02` plus a fresh state directory.

Local mode has explicitly named fixture tokens: `local-owner`, `local-agent-a`, `local-agent-b`, `local-agent-c`, `local-reviewer`, `local-checker`, `local-promoter`, `local-viewer`, `local-contest-low`, `local-contest-high`, and `local-mock-aw`. They are accepted only with local configuration. The scenario driver switches between fixture principals for scripted actions and prints each actor. Production requires operator-supplied scoped tokens and rejects all `local-*` tokens.

Terminal 4 executes bounded runner commands printed by each scene, or use the driver's `--pump-local` option, which spawns the same commands, waits, and stops them. Conceptual invocation (REPO_ID is printed by seed):

```sh
CONCORD_URL=http://127.0.0.1:8787 CONCORD_TOKEN=local-checker npm run runner -- --repo REPO_ID --role checker --profile demo/profile.json --once
CONCORD_URL=http://127.0.0.1:8787 CONCORD_TOKEN=local-promoter npm run runner -- --repo REPO_ID --role promoter --once
```

`--pump-local` passes the actual manifest repo ID and starts a `--once` process per job, checking the scene barrier after each returned result (maximum 16 checker jobs and four promoter jobs per scene). It waits for children and does not use background busy loops. For bisection scenes it captures the failure tree before starting promotion, preserving the screenshot opportunity. No continuously running runner should race past the scene's inspection barrier.

Open the printed repo URL in the browser, select the local viewer identity, and keep the environment badge visible. Type mutation commands in the terminal or switch to the appropriate independent reviewer identity for review actions. Before recording, run every scene once and inspect the event log.

## Minute-by-minute capture

All commands below run in Terminal 3 using the setup environment. Every `scene` command is an idempotent sequence of documented HTTP/CLI actions, logs the actual requests and evidence IDs with secrets redacted, and pauses on its stated end condition. It must not seed DO rows or fabricate checker outcomes. The scenario implementation belongs to 12; the underlying CLI and API belong to 02–09.

| Video time | Exact action / command | On-screen evidence and narration |
| --- | --- | --- |
| 0:00–1:00 | `npm run demo -- scene context --run demo-01 --state-dir "$CONCORD_RUN_DIR"` | Title and three supplied aggregates: 111/122 shared-header PRs, 726 land-blocked functions, 3/9 approvals becoming conflicted. Label “owner-reported aggregates, 2026-10-10; not a replay result.” Show public table and three agent intents. Say the thesis, then point to the live backend badge. |
| 1:00–2:00 | `npm run demo -- scene leases --run demo-01 --state-dir "$CONCORD_RUN_DIR"` | Concurrent A/X alpha claims produce exactly one grant and one 409 with holder/intent. Driver accepts either winner: if X wins, close/release X and let A reacquire; never fake the race outcome. X closes, B claims gamma, C claims delta. Three distinct rows of the same file are active together. Subsequent scenes renew unexpired claims before work, or reacquire with new fences after expiry; the stack scene maintains heartbeats while publishing. |
| 2:00–3:00 | `npm run demo -- scene stack --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local` | Publish A/B/C and inspect exact heads; independent scripted reviewer approves all three. Narrate that review missed B's invalid policy values. Enqueue them in one coalescing window. Real checker fails the composed stack. Stop before diagnostic jobs and show pinned base, ordered candidates, runner profile, and actual failure output. |
| 3:00–4:00 | `npm run demo -- scene isolate --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local` | Resume diagnostics. Show same-base splits, B failing alone, A+C recomposed green, conditional promotion, and canonical readback. B is blocked; A/C are merged. Shared-file row composition is visible. Do not claim bisection finds every interaction. |
| 4:00–5:00 | `npm run demo -- scene repair --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local` | Withdraw blocked B and reacquire gamma to replace its queue reservation with an editable lease. Reviewer creates F-1 (gamma retry limit) and F-2 (gamma timeout). Submit an intentionally incomplete repair disposition covering only F-1: one 409, both stay open. Publish the complete B-repair revision and both dispositions; reviewer delta review resolves the round, new verdict plus full check lands it. Show stable finding IDs across heads. |
| 5:00–6:00 | `npm run demo -- scene carry --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local` | Approve D, then land E ahead of it. Mechanically rebuild D against current main, request carry, run real delta check. Show different commit IDs, equal review manifests, parent verdict, and green full-stack check before landing D. Display measured delta duration without a promised speedup. |
| 6:00–7:00 | `npm run demo -- scene invalidate --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local` then `npm run demo -- scene contest --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local` | H is approved; I advances its dependency beta; H's carry is refused. Close H and release its claims. Owner opens the explicit epsilon contest; independent reviewer approves both child manifests, checker selects J-high at 4/4 over J-low at 2/4, both hard-safe, and normal full-stack validation gates landing. State this is a synthetic quality score; real decomp would use byte-match pins. |
| 7:00–8:00 | `npm run demo -- scene aw --run demo-01 --state-dir "$CONCORD_RUN_DIR"` then the replay command below | Show seven AW mock retries mapping to one task/change ID, including a changed observed base value in retry input. Stop at awaiting_review. Show approved historical replay if available, otherwise the unavailable-data panel. Narrate that a mock adapter does not migrate the real launcher. |
| 8:00–9:00 | `npm run demo -- inspect --run demo-01 --state-dir "$CONCORD_RUN_DIR" --json` and `npm run deploy:check -- --local` | Browser walkthrough: all landed SHAs, B's findings history, original/derived verdicts, lease intents, and account/Artifacts evidence. Show clean-clone run commands and MIT LICENSE. Close with the three demonstrated behaviors and an honest list of cuts. Include live deployment URL and repo link only once they exist. |

For a ten-minute finalist presentation, retain this script and use the extra minute for one audience-chosen failed carry or collision case. Do not add a live private-project dependency.

## Historical replay: optional evidence, never invented numbers

No timelines were supplied to this design run. The available facts also include decomp progress from 2,309 matches on 09-29 to 5,768 on 10-10 out of about 18,390, and 515 merges on 10-10; nine batches/3+ hours with zero commits; 44 declaration conflicts; 7–8 minute rechecks; mwcc-rs six review rounds; AW four repairs/five reviews; Mother Base three rounds; and seven duplicate tasks. They may be labelled owner-reported context, not converted into fake event timestamps or a percentage saved by Concord.

Before filming, the owner may provide a sanitized JSONL export from DBOS and PR history. Required provenance header: schemaVersion=1, exportId, sourceType, redacted sourceRef, SHA-256 sourceDigest, exportedAt UTC, anonymizationVersion, selected time window/cohort, and owner release approval reference. Events need eventId, taskId, anonymized unitKeys, event type, UTC occurredAt, and sourceEventRef; durations must cite paired events or the source duration field. Types include task_started, claim_attempted, review_approved, conflict_observed, check_started, check_finished, repair_submitted, and merged. Missing data stays missing. Export no raw code, proprietary paths, compiler bytes, credentials, or chat text.

With an approved file, run:

```sh
npm run replay -- validate --input "$CONCORD_TIMELINE"
npm run replay -- compare --input "$CONCORD_TIMELINE" --output "$CONCORD_RUN_DIR/replay.html"
```

The owner sets `CONCORD_TIMELINE` to that local export path. The report labels the baseline measured, the Concord result simulated, the cohort/window and capacities, and all missing/unknown fields. Open the generated report separately; the UI may link it locally but must not publish the export automatically. Simulation cannot establish a causal real-world speedup. Live synthetic elapsed times are a third, separately labelled dataset.

Without an approved file (the default), use:

```sh
npm run replay -- compare --explain-missing --output "$CONCORD_RUN_DIR/replay.html"
```

Show “Historical comparison unavailable: owner export pending.” Continue the demonstration using the already observed live synthetic events. Never relabel the synthetic test fixture as historical data.

## Live Cloudflare evidence and mirror

Local fake mode is sufficient for development and rehearsals, but cannot prove the competition's Workers + Artifacts requirement. The owner must create the account and authorize slice 12's operator run. `docs/deploy.md` will contain exact configured deployment and secret commands; the planned commands are `npm run deploy:check -- --remote`, `npx wrangler deploy --dry-run --config wrangler.jsonc`, and then the separately authorized `npx wrangler deploy --config wrangler.jsonc`.

Record the deployed Worker URL, `storageBackend=artifacts`, namespace/repo metadata, a normal Git fetch of the canonical ref, and one real checked promotion whose SHA equals the UI. A metadata badge alone is insufficient. Before filming, run the disposable-repo stale-push/token-isolation smoke gate in the runbook. If that gate fails, stop the deployed segment and report the actual limitation; no fake-to-live relabelling.

An optional human mirror is one-way canonical-main publication to a new owner-supplied GitHub demo repo. The future command `npm run mirror -- --repo REPO_ID --remote "$CONCORD_MIRROR_REMOTE" --dry-run` prints exact source/destination SHA and expected update. Only an explicitly authorized operator may rerun with `--execute`. A diverged destination blocks; never force it or push tags/private forks. The mirror is outside the landing critical path and is not the source of truth.

## Recording defaults and fallback

Keep `CONCORD_SHOW_DECOMPILED_C=0`. Only owner-supplied aggregate numbers and anonymized names such as `sub_02000100` appear in decomp context cards. Enabling a flag does not authorize publishing code; any future C sample needs an explicit owner rights decision and separate input. No such sample is needed for this demo.

Before capture, verify the exact production/fake badge, public fixture contents, token redaction, current demo test pass, and a fresh manifest. If a runner stalls, show its timed-out/offline state and use a previously recorded, clearly dated run of the same public fixture for that scene. Never manufacture a green result. If account access is missing, record a local rehearsal and mark the cloud-evidence/submission gate incomplete; the owner decides submission readiness.

At the end of rehearsal stop foreground servers with Ctrl-C and verify runner children have exited. Keep the manifest and redacted logs as evidence outside the source tree. Do not delete a failed run to conceal its outcome.
