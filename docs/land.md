# Land a finished agent run

`concord land` takes one existing, single-parent Git commit and drives a Concord change through leases, publication, checker inspection, independent review, queue admission, and confirmed canonical landing. Start a separate `npm run runner` checker and promoter service for the repository; `land` only waits for their results. The source checkout is never rebased or edited. If its commit parent differs from the current canonical base, `land` cherry-picks the commit in a temporary checkout and publishes that new head. A conflict exits as `MERGE_CONFLICT` and removes the temporary checkout.

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

`allowed-files.txt` has one exact repository-relative path per line. The command checks every path changed by the commit against this list before making an API write. Renames count as both deleted and added paths. A trusted policy from the repository snapshot determines declared TSV row keys where possible; otherwise it claims whole-file units. `--depends-on CHANGE_ID` may be repeated. `--wait-seconds N` bounds lease, inspection, and queue waits; the default is 600 seconds. A lease conflict emits the holder and intent, then retries with bounded backoff while renewing held leases. Failed or incomplete runs can be restarted with the same intent key. Repeating a publication or verdict for the same head does not create another revision or approval.

The review evidence file must contain an `APPROVED for merge` line and exactly one distinct full SHA, equal to the published head. The reviewer token must differ from the author token, and Concord checks the reviewer principal and trusted inspection manifest. If the command rebases the source commit, the reviewer must approve the rebased published SHA. Without `--review-evidence`, `land` stops after inspection, prints `awaiting-review` with the change ID and URL, and releases unused leases. Rerun with the same intent key and evidence to continue.

`--json` emits one JSON object per state transition. States include `created`, `leased`, `LEASE_CONFLICT`, `lease-renewed`, `published`, `change` (inspection status), `awaiting-review`, `reviewed`, `enqueued`, `queue` (queue status and diagnostic reason), `landed` (ticket and canonical SHA), and `mirrored`. Output is redacted before serialization. A queue failure exits nonzero with its diagnostic reason. Landing succeeds only after ticket application and a canonical main readback equal to the queue's confirmed SHA.

`--mirror-to https://github.com/OWNER/REPO.git` mirrors confirmed canonical main through the existing mirror implementation. Set `CONCORD_MIRROR_TOKEN` for a private destination. The mirror checks that destination main is absent or an ancestor and uses a normal push; it never force pushes.

## AW launcher adapter

A coordinator can use a finished delegate run directly:

```sh
npm run concord -- land --repo my-repo --aw-run /path/to/run \
  --review-evidence /path/to/independent-review.txt --json
```

The adapter reads `status.json`'s `validated_sha` and worktree, `allowed-files.txt`, and the first `Goal: Outcome:` line of `work-spec.md`. The run's stable `job_id` becomes the intent key. The generic command above works with any agent or orchestrator and does not depend on AW files.
