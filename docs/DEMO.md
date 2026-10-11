# Concord demo: nine minutes from intent to checked history

This is the local rehearsal and filming guide. Target video length: 9:00, with a 30-second margin below the competition's ten-minute ceiling. Use a 1280x720 browser plus a readable terminal; record the application and real checker output. Scene durations are editing targets for the video, not measured command runtimes.

The public demonstration repository is **dispatch-lab**, a tiny original MIT retry-policy registry inspired by an agent launcher. It contains no private AW code. Three scripted agent identities make actual API requests and Git commits concurrently; label them scripted agents, not live model sessions. The owner can reproduce it without a paid model, ROM, proprietary toolchain, or decompiled C.

## Exact public fixture

The delivered `demo/dispatch-lab/families.tsv` has literal tab separators:

```text
family	retry_limit	timeout_ms
alpha	1	1000
beta	2	1000
gamma	3	1000
delta	4	1000
epsilon	1	500
```

`demo/dispatch-lab/dispatch.mjs` is the public executable under test. It reads the candidate's `families.tsv` and exposes `attemptBudget(family)`: the number of milliseconds available for that family's attempts, calculated as `retry_limit * timeout_ms`. `demo/checker.mjs` is a trusted Node checker kept outside candidate worktrees. `node demo/checker.mjs --repo PATH --unit all --case CASE_ID` invokes the candidate executable for each required family and checks its numeric output, as well as exact table schema, unique required rows, integer retry limits 1–5, and integer timeouts 250–2000 ms. A missing executable, exception, noninteger output, or mismatch fails.

The checker/profile contains a fixed, versioned acceptance matrix outside candidate forks. `CASE_ID` comes from the trusted scenario plan and pinned job profile, never from candidate files or a caller-controlled result. Ordinary cases list one literal expected output and row value for each of the five families; the checker rejects an unknown case ID. At minimum the matrix includes `seed` (`alpha=1000`, `beta=2000`, `gamma=3000`, `delta=4000`, `epsilon=500`), `a-only` (`alpha=2000`, `beta=2000`, `gamma=3000`, `delta=4000`, `epsilon=500`), `c-only` (`alpha=1000`, `beta=2000`, `gamma=3000`, `delta=5000`, `epsilon=500`), `a-c-survivors` (`alpha=2000`, `beta=2000`, `gamma=3000`, `delta=5000`, `epsilon=500`), and `b-repaired` (`alpha=2000`, `beta=2000`, `gamma=5000`, `delta=5000`, `epsilon=500`). Include literal cases for every reachable bisection subset and later D/E/I scene state before the driver can queue them; an incomplete matrix fails closed. The J contest uses one common, fixed case under the same observed canonical base and profile for both children: non-epsilon rows have the same exact expected row values and outputs from that base, while epsilon must match one complete `(retry_limit, timeout_ms, output)` tuple in the pinned admissible set `{(2, 500, 1000), (2, 1000, 2000)}`. Do not accept independent combinations of tuple fields. Run the hard gate on both J-low and J-high with this same case and require both to pass before comparing their scores. Select each case from the trusted planned transition and observed canonical base, never by inspecting the candidate-edited table. Expected outputs, row values, and contest tuples are committed fixture constants, not calculated from candidate content. A legitimate new owner policy requires a separately reviewed profile and case matrix revision.

Negative acceptance: starting from a passing `a-c-survivors` tree, claim the registered file-wide fallback unit `file:dispatch.mjs`, which the trusted unit policy in `demo/units.json` maps to the candidate-repository-relative path `dispatch.mjs`, and send that unit through the existing `unitKeys` of the create, claim and publish bodies with its lease fence (no extra request field). The evidence must show successful inspection and enqueue admission with the declared unit and its current fence, then the pinned checker failure, and no promotion ticket. Change the candidate executable to return `Math.min(5000, retry_limit * timeout_ms + 250)` for alpha while leaving every TSV value in range; admission must accept the declared write, then the pinned `a-c-survivors` checker case must fail on alpha (2250 versus 2000) and no promotion ticket may issue. Separately, with `row:families:alpha` claimed and declared, prove that changing alpha's in-range retry limit from 2 to 3 without a trusted case update fails. Malformed, duplicate, missing, and out-of-range rows fail independently. Candidate edits cannot modify the trusted checker, matrix, or policy used for that run.

For the optional contest, hard safety checks still apply. Epsilon's quality score counts which four public simulated task durations `[250,500,750,1000]` fit its timeout. A 500-ms candidate scores 2/4 and a 1000-ms candidate 4/4. No task actually sleeps; this is a deterministic synthetic quality measure, not a decomp byte-match measurement. Ordinary projects use pass/fail first-green. The runner measures actual checker wall time; no duration is scripted.

`demo/units.json` registers `row:families:<family>` footprints in `families.tsv`, plus a file-wide fallback. The trusted review policy gives alpha a dependency on beta and each other row no cross-row dependency. It records table schema and checker/profile digests for every manifest. This deliberately small declared domain makes independent-row carry demonstrable; it is not automatic semantic inference.

The AW fixture is schemaVersion=1, project=`public-aw`, taskId=`task-17`, explicitAttempt=1, intent=`Increase gamma retry budget safely`, unitKeys=`["row:families:gamma"]`, workerLabel=`scripted-aw`, and worktree equal to the manifest's absolute AW-task checkout path. The driver materializes that path in its temporary runtime copy of the public fixture. Retry inputs may refresh observedBaseOid from actual observed history, but never alter the stable intent. `demo/profile.json` pins the public checker, acceptance matrix, policy, golden durations, and Node version digest; those digests are computed from the delivered files at seed time and recorded in the manifest, not supplied as invented constants here.

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
| AW-task | mock-aw / public-aw/task-17/attempt-1 | gamma retry_limit 4 → 5 | Same task retried seven times; verdict and queue state read from the Worker |

A/B/C originate from the same seed commit. Later scenes start from the current observed canonical tip. The manifest stores actual repo IDs, candidate forks, change IDs, lease fences, request versions, full OIDs, job IDs, and result digests. Friendly aliases are not server IDs or fabricated SHAs. Scene steps read current versions and wait for explicit state predicates with a 60-second maximum. On timeout, print the actual blocked state and stop; do not force progress.

## Rehearsal setup

Follow the four-terminal [README quickstart](../README.md#five-minute-local-start) for exact preflight, bridge, Worker, seed, and first-scene commands. The bridge must use `CONCORD_BRIDGE_DATA_DIR="$CONCORD_RUN_DIR/bridge"`; preflight alone does not start it. Keep Wrangler persistence under the clone's ignored `.wrangler/state/`, even when `TMPDIR` and `CONCORD_RUN_DIR` point outside the clone. The README derives a separate persistence directory from each absolute run path. Prerequisites are Node 22+, installed lockfile dependencies, and native Git. No Cloudflare account is needed for the local path. A new rehearsal uses a fresh run ID and state directory. The final competition capture additionally needs the provisioned deployment described below.

`seed` creates a new logical repo and seed draft fork, pushes the public seed there, requests owner-only bootstrap validation and conditional initial promotion, and captures the checked seed OID. It pumps the local checker/promoter for bootstrap in local mode, then allocates draft changes A/B/C/X, prepares A/B/C worktrees, and prints the repo URL. Bootstrap is allowed only for empty main; all main writes, including initialization, use stored promoter tickets. `seed` repeated with the same run ID returns the same manifest; it never deletes existing history.

Local mode has explicitly named fixture tokens: `local-owner`, `local-agent-a`, `local-agent-b`, `local-agent-c`, `local-reviewer`, `local-checker`, `local-promoter`, `local-viewer`, `local-contest-low`, `local-contest-high`, and `local-mock-aw`. They are accepted only with local configuration. The scenario driver switches between fixture principals for scripted actions and prints each actor. Production requires operator-supplied scoped tokens and rejects all `local-*` tokens.

The driver runs bounded checker/promoter jobs with `--pump-local`. To run them manually, use the values printed by seed in place of the placeholders below:

```sh
CONCORD_URL=http://127.0.0.1:8787 CONCORD_TOKEN=local-checker npm run runner -- --repo REPO_ID --role checker --profile "$CONCORD_RUN_DIR/dispatch-profile.json" --once
CONCORD_URL=http://127.0.0.1:8787 CONCORD_TOKEN=local-promoter npm run runner -- --repo REPO_ID --role promoter --profile-digest PROFILE_DIGEST_FROM_PREFLIGHT --once
```

`--pump-local` passes the actual manifest repo ID and starts a `--once` process per job, checking the scene barrier after each returned result (maximum 16 checker jobs and four promoter jobs per scene). It waits for children and does not use background busy loops. For bisection scenes it captures the failure tree before starting promotion, preserving the screenshot opportunity. No continuously running runner should race past the scene's inspection barrier.

Open the printed repo URL in the browser, select the local viewer identity, and keep the environment badge visible. Type mutation commands in the terminal or switch to the appropriate independent reviewer identity for review actions. Before recording, run every scene once and inspect the event log.

## Minute-by-minute capture

Run the commands after the README quickstart in its driver terminal. Every `scene` command resumes from its recorded end condition, logs actual requests and evidence IDs with secrets redacted, and waits for its stated barrier. The local driver must not seed Durable Object rows or fabricate checker outcomes.

| Video time | Scene | On-screen evidence and narration |
| --- | --- | --- |
| 0:00–1:00 | context | Title and three supplied aggregates: 111/122 shared-header PRs, 726 land-blocked functions, 3/9 approvals becoming conflicted. Label “owner-reported aggregates, 2026-10-10; not a replay result.” Show public table and three agent intents. |
| 1:00–2:00 | leases | Concurrent A/X alpha claims produce one grant and one 409; gamma and delta remain independently claimable in the same file. |
| 2:00–3:00 | stack | Publish A/B/C and inspect exact heads and independent scripted verdicts. The real checker fails their composed stack before diagnostics. |
| 3:00–4:00 | isolate | Show same-base splits, B failing alone, A+C recomposed green, conditional promotion, and canonical readback. B is blocked; A/C land. |
| 4:00–5:00 | repair | Reviewer records two gamma findings. An incomplete disposition gets 409; a complete B revision, disposition, verdict, and full check land. |
| 5:00–6:00 | carry | Land E before approved D, rebuild D, run the real delta check, and show its derived verdict and full-stack check. Do not promise a speedup. |
| 6:00–7:00 | invalidate, contest | A changed beta dependency refuses H's carry. Both J children pass the same hard gate; the synthetic 4/4 option beats 2/4 and lands after validation. |
| 7:00–8:00 | aw, replay | Show seven public AW mock retries mapping to one task/change ID, a real published commit and verdict, and the queue's observed state. Show approved historical replay if available, otherwise the unavailable-data panel. |
| 8:00–9:00 | inspect | Walk through landed SHAs, finding history, verdicts, lease intents, queue state, and the account evidence. A local run alone does not prove Artifacts hosting. |

The driver also implements **negative** (declared bad row and executable edits rejected by the checker) and **dedupe** (the low-level seven-request intent reservation) as optional local checks. Run them in the order below when rehearsing all implemented scenes. The AW scene uses the same absolute `CONCORD_RUN_DIR` as the other scenes.

<!-- verified-by: 12c -->
```sh
export CONCORD_RUN_DIR="$(node -p 'require("node:path").resolve(process.env.TMPDIR || "/tmp")')/concord-demo-01"
export CONCORD_URL=http://127.0.0.1:8787
export CONCORD_TOKEN=local-owner
export CONCORD_SHOW_DECOMPILED_C=0
npm run demo -- scene isolate --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene negative --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene repair --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene carry --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene invalidate --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene contest --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene dedupe --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
npm run demo -- scene aw --run demo-01 --state-dir "$CONCORD_RUN_DIR" --pump-local
```

Inspect the final state with the README command. The nine-minute capture uses selected evidence from this rehearsal; the optional checks can run before recording.

For a ten-minute finalist presentation, retain this script and use the extra minute for one audience-chosen failed carry or collision case. Do not add a live private-project dependency.

## Historical replay: optional evidence, never invented numbers

No approved historical timeline is bundled. The available facts also include decomp progress from 2,309 matches on 09-29 to 5,768 on 10-10 out of about 18,390, and 515 merges on 10-10; nine batches/3+ hours with zero commits; 44 declaration conflicts; 7–8 minute rechecks; mwcc-rs six review rounds; AW four repairs/five reviews; Mother Base three rounds; and seven duplicate tasks. They may be labelled owner-reported context, not converted into fake event timestamps or a percentage saved by Concord.

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

Local fake mode is sufficient for development and rehearsals, but cannot prove the competition's Workers + Artifacts requirement. The owner must create the account and authorize the early Artifacts gate. The operator creates an empty disposable repo through the live API, attempts its empty-source fork, pushes the first commit to that fork and reads it back, and records actual responses and OIDs. If an empty-source fork fails, create a separate seed repo, push/read back its first commit, then fork the seeded repo and verify the seed. Use the seeded fork for checked absent-ref bootstrap once integrated. See [the Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) and [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/). The [deployment runbook](deploy.md) has the configured deployment and secret commands. Its checked-landing gate remains missing because the current scenario driver accepts only local bridge remotes and fixture principals.

Record the deployed Worker URL, `storageBackend=artifacts`, namespace/repo metadata, a normal Git fetch of the canonical ref, and one real checked promotion whose SHA equals the UI. A metadata badge alone is insufficient. The early create/first-push/fork gate is a prerequisite; before filming, repeat it alongside the disposable-repo stale-push/token-isolation smoke in the runbook. If either gate fails, stop the deployed segment and report the actual limitation; no fake-to-live relabelling.

An optional human mirror is one-way canonical-main publication to a new owner-supplied GitHub demo repo. The command `npm run mirror -- --repo REPO_ID --remote "$CONCORD_MIRROR_REMOTE" --dry-run` prints exact source/destination SHA and expected update. Only an explicitly authorized operator may rerun with `--execute`. A diverged destination blocks; never force it or push tags/private forks. The mirror is outside the landing critical path and is not the source of truth.

## Recording defaults and fallback

Keep `CONCORD_SHOW_DECOMPILED_C=0`. Only owner-supplied aggregate numbers and anonymized names such as `sub_02000100` appear in decomp context cards. Enabling a flag does not authorize publishing code; any future C sample needs an explicit owner rights decision and separate input. No such sample is needed for this demo.

Before capture, verify the exact production/fake badge, public fixture contents, token redaction, current demo test pass, and a fresh manifest. If a runner stalls, show its timed-out/offline state and use a previously recorded, clearly dated run of the same public fixture for that scene. Never manufacture a green result. If account access is missing, record a local rehearsal and mark the cloud-evidence/submission gate incomplete; the owner decides submission readiness.

At the end of rehearsal stop foreground servers with Ctrl-C and verify runner children have exited. Keep the manifest and redacted logs as evidence outside the source tree. Do not delete a failed run to conceal its outcome.
