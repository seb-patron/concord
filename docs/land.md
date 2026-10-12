# Land a finished agent run

`concord land` takes one existing, single-parent Git commit and drives a Concord change through leases, publication, checker inspection, independent review, queue admission, and confirmed canonical landing. Start a separate `npm run runner` checker and promoter service for the repository; `land` only waits for their results. The source checkout is never rebased or edited. If its commit parent differs from the current canonical base, `land` cherry-picks the commit in a temporary checkout and publishes that new head. A conflict exits as `MERGE_CONFLICT` and removes the temporary checkout.

Use `--base <40-hex oid>` with `--commit <reviewed head>` to land a multi-commit run. The base must be an ancestor of the head, and the range must contain no merge commits or have an empty diff. Land creates one deterministic temporary squash commit with the base as parent and the reviewed head's tree, then carries approval of the reviewed head to the squash or its clean cherry-pick when their stable patch IDs match. `--json` emits `squashed` with the base, reviewed head, and squash OIDs before publication.

```sh
export CONCORD_URL=https://concord.example
export CONCORD_TOKEN='<author token>'
export CONCORD_REVIEWER_TOKEN='<different reviewer token>'
npm run concord -- land --repo my-repo --source /path/to/worktree \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --intent-key task-123 --intent 'Update the scheduler' \
  --allowed-files /path/to/allowed-files.txt \
  --review-evidence /path/to/independent-review.txt --json
```

`allowed-files.txt` has one exact repository-relative path per line. The command checks every path changed by the commit against this list before making an API write. Git paths with invalid UTF-8 bytes are refused before any API write. Renames count as both deleted and added paths. A trusted policy from the repository snapshot determines declared TSV row keys where possible; otherwise it claims whole-file units, including new paths under owner-approved `newFilePrefixes`. One land invocation supports at most 64 normalized units. More than 64 exits before any API write with `LAND_TOO_MANY_UNITS`, reporting the count and suggesting coarser prefix or section units in policy. `--depends-on CHANGE_ID` may be repeated. `--wait-seconds N` bounds lease, inspection, and queue waits; the default is 600 seconds. A lease conflict emits the holder and intent, then retries with bounded backoff while renewing held leases. Failed or incomplete runs can be restarted with the same intent key after a content repair; the repaired commit is published as a new revision and inspected, even when canonical main has advanced. Replacing a published head updates the candidate branch only if it still points to the recorded head. Repeating a publication or verdict for the same head does not create another revision or approval.

The review evidence file is the reviewer's raw report, not a GitHub comment wrapper. It is an approval only when its first non-empty line is exactly `# ✅ APPROVED FOR MERGE — head <full 40-hex SHA>`, that SHA matches the published head, and it ends with one of two exact footers: the last non-empty line is `APPROVED for merge`, or the last non-empty lines are `VERDICT: APPROVED` optionally followed by `DELEGATE_OUTCOME=completed`. Nothing may follow either footer, and no line may contain `CHANGES REQUIRED`, `REQUEST CHANGES`, or `NOT APPROVED` (case-insensitive). Quoted or fenced approval text cannot satisfy the required first line. Any other format is not an approval, so no approve verdict is submitted and `land` exits non-zero. The reviewer token must differ from the author token, and Concord checks the reviewer principal and trusted inspection manifest. Without `--review-evidence`, `land` stops after inspection, prints `awaiting-review` with the change ID and URL, and releases unused leases. Rerun with the same intent key and evidence to continue.

When land cleanly cherry-picks a source commit onto canonical main, evidence may instead name the full source SHA. Land carries that approval only if the source and published commits have equal stable Git patch IDs and exactly the same changed paths, all within `allowed-files.txt`. It records the source SHA on the verdict and emits `review-carried` before `reviewed`; checker inspection of the published head and queue validation still run normally.

`--json` emits one JSON object per state transition. States include `created`, `leased`, `LEASE_CONFLICT`, `lease-renewed`, `published`, `change` (inspection status), `awaiting-review`, `reviewed`, `enqueued`, `queue` (queue status and diagnostic reason), `landed` (ticket and canonical SHA), and `mirrored`. Output is redacted before serialization. A queue failure exits nonzero with its diagnostic reason. Landing succeeds only after ticket application and a canonical main readback equal to the queue's confirmed SHA.

With owner or reviewer credentials (set `CONCORD_REVIEWER_TOKEN` for an agent run), the inspection wait reports a terminal non-PASS outcome for the current revision immediately as `INSPECTION_FAILED: <outcome>`; the `--json` error details include the redacted checker log tail. An unchanged head reaches this wait and reports its prior failure without re-inspection. After `ENV_ERROR` or `TIMEOUT`, fix the environment and rerun with a new `--intent-key`. `FAIL` and `MERGE_CONFLICT` remain content verdicts.

`--mirror-to https://github.com/OWNER/REPO.git` mirrors confirmed canonical main through the existing mirror implementation. Set `CONCORD_MIRROR_TOKEN` for a private destination. The mirror checks that destination main is absent or an ancestor and uses a normal push; it never force pushes.

## AW launcher adapter

A coordinator can use a finished delegate run directly:

```sh
npm run concord -- land --repo my-repo --aw-run /path/to/run --base RUN_START_OID \
  --review-evidence /path/to/independent-review.txt --json
```

The adapter reads `status.json`'s `validated_sha` and worktree, `allowed-files.txt`, and the first `Goal: Outcome:` line of `work-spec.md`. The run's stable `job_id` becomes the intent key. Supply `--base` with the run-start commit for every AW run, including a single-commit run; metadata such as `parent_sha` never supplies this base. Explicit `--commit` or `--allowed-files` values that conflict with the run are rejected. Without `--aw-run`, omitting `--base` retains the single-commit contract: the caller asserts that `--commit` is the whole reviewed change. The generic command above works with any agent or orchestrator and does not depend on AW files.
