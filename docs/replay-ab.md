## A/B report

Run `npm run replay -- ab-report --serial S1.json --serial S2.json --swarm L1.jsonl --swarm L2.jsonl --metrics M.json --out card.html`. Repeat `--serial`, `--swarm`, and `--metrics` for more replicates. Use `--out card.json` for machine-readable output. The HTML is a self-contained static page with light and dark color schemes. `--monday monday.json` adds an owner-log column. `--manifest manifest.json` supplies charges for refused Concord conflicts. One metrics file can cover the Concord arm, or supply one per swarm replicate. Invalid input exits with code 2.

The manifest format is `{"schemaVersion":1,"batch":"P","startCommit":"<40-hex>","validationCommand":"sh scripts/validate.sh","changes":[{"id":"X1","label":"X1","order":1,"base":"<40-hex>","head":"<40-hex>","dependsOn":[],"charge":{"resolvedHead":"<40-hex>","rebaseRunMinutes":12.5,"reviewMinutes":9}}]}`. A change may have `"charge":null`. A serial file has `schemaVersion:1`, `arm:"pr"`, `batch`, `startCommit`, `validationCommand`, `startedAt`, `finishedAt`, a `changes` array and `totals`. Each change supplies `id`, `label`, `order`, `mergedAt`, `conflict`, `conflictFiles`, `usedResolvedHead`, `chargedMinutes`, `validation:{exitCode,durationMs}`, and `mainRed`. Totals supply `conflicts`, `mainRedMerges`, `workerRunsCharged`, `freshReviewsCharged`, `chargedMinutes`, and `timeToGreenMs`.

A swarm file is JSONL: one line per land transition with `{"at":"<ISO UTC>","agent":"a1","changeId":"X1","transition":{...concord land --json object...}}`, followed by `{"at":"<ISO UTC>","summary":{"replicate":"mb-ab-wed-1","repo":"<repo id>","firstCreatedAt":"<ISO UTC>","lastLandedAt":"<ISO UTC>","landed":2,"failed":0}}`. The report counts `published` transitions as worker runs, `reviewed` transitions as fresh reviews, and `MERGE_CONFLICT` codes as conflicts. Concord time to green is the summary window plus each conflict's manifest `rebaseRunMinutes` and `reviewMinutes` when a charge exists. Serial runs and reviews equal the number of changes plus the corresponding charged totals; serial time uses `totals.timeToGreenMs`. Counts may exceed the number of changes when a change needs multiple attempts.

Metrics JSON is the body of `GET /v1/repos/:r/metrics` as printed by `concord metrics --json`; a CLI response wrapped in `data` is also accepted. The report reads only `automaticRebases`, `approvalsCarriedByPatchId`, `combinedTreeCheckFailures`, `bisectBlames`, `mainRedTime`, `publishToLand`, and `queueWait`. Present count fields have `{ "value": 2, "n": 2, "eventKinds": ["..."] }`; `publishToLand` and `queueWait` have `{ "medianMs": 120000, "p90Ms": 180000, "n": 2 }`. Measured rows use the metrics response's `since` and `until`, display `n` as the sample size, and show latency values in milliseconds with p90 in a note. A range across multiple metrics files is the range of their reported values or medians. Unsupported present field shapes are rejected. Absent fields show `n/a`, never zero. Monday JSON is `{"label":"Monday (owner log)","rows":{"workerRunsNeeded":{"value":"2 of 2","note":"owner count"}}}`. Row keys include `workerRunsNeeded`, `freshReviewsNeeded`, `conflictsHit`, `mainRedMerges`, `timeToGreenMinutes`, and the metrics names above.

Each cell has an evidence label, median, min–max range, number of changes and replicates, and a time window. The labels are **Replayed** for replay counts and uncharged durations, **Charged** when the time row includes charge-derived minutes, **Measured** for metrics, and **Owner log** for Monday entries. Missing values retain their evidence label and show `n/a`. Concord time to green is unavailable with a reason if any swarm change failed. The card uses counts such as `2 of 3`, without percentages or speedup ratios. No row is styled differently according to which arm is lower.

Input validation checks the complete serial cohort and batch identity before accepting manifest charges or swarm transitions. Every manifest change must belong to that cohort, and every swarm change ID and summary change count must match it. Timestamps must be real UTC calendar instants with no more than three fractional digits; serial merge times and swarm transitions must lie within their declared windows. Counts are nonnegative integers, numeric totals must remain finite, and invalid input exits with code 2 naming the field.
# A/B replay formats

The serial arm replays a batch as local pull-request merges. It reads commits from a local Git repository and works in a disposable scratch clone. It does not push or move refs in the source repository. Use actual commit IDs in a manifest; `tests/fixtures/ab-manifest.json` is a shape-only example with synthetic IDs.

```sh
npm run replay -- serial --manifest M.json --repo PATH --out result.json
```

`--validation-timeout SECONDS` sets a positive integer timeout per validation run (default 3600). `--keep` retains the scratch clone and prints its path. Without it, the clone is removed. Invalid manifest JSON or fields exit with status 2.

## Manifest JSON

```json
{
  "schemaVersion": 1,
  "batch": "P",
  "startCommit": "<40-hex>",
  "validationCommand": "sh scripts/validate.sh",
  "changes": [
    {
      "id": "X1", "label": "X1", "order": 1,
      "base": "<40-hex>", "head": "<40-hex>",
      "dependsOn": [],
      "charge": { "resolvedHead": "<40-hex>", "rebaseRunMinutes": 12.5, "reviewMinutes": 9 }
    }
  ]
}
```

`charge` may be `null`. IDs and orders must be unique, every dependency must name a change, and dependency cycles are invalid. All commit fields use 40 hexadecimal characters. The runner sorts by `order` and starts at `startCommit`. For each change it checks the merge with `git merge-tree --write-tree`, then merges `head` with `git merge --no-ff --no-edit`. A conflict is recorded with its file names. A `charge.resolvedHead` is used only when it descends from the change's base, differs from current main in the change's files, merges cleanly, and the change's complete patch reverse-applies to both the resolved head and prospective merge tree. Otherwise the conflict is unresolved and is skipped; later changes are still attempted. Each accepted resolution charges its rebase and review minutes. The runner executes `validationCommand` in the clone after every successful merge. A nonzero exit, including timeout exit code 124, marks that merge as main red.

## Serial result JSON

```json
{
  "schemaVersion": 1, "arm": "pr", "batch": "P",
  "startCommit": "<40-hex>", "validationCommand": "sh scripts/validate.sh",
  "startedAt": "2026-01-01T00:00:00.000Z", "finishedAt": "2026-01-01T00:01:00.000Z",
  "changes": [
    {
      "id": "X1", "label": "X1", "order": 1,
      "mergedAt": "2026-01-01T00:00:10.000Z", "conflict": false,
      "conflictFiles": [], "usedResolvedHead": false, "chargedMinutes": 0,
      "validation": { "exitCode": 0, "durationMs": 500 }, "mainRed": false
    }
  ],
  "totals": {
    "conflicts": 0, "mainRedMerges": 0,
    "workerRunsCharged": 0, "freshReviewsCharged": 0,
    "chargedMinutes": 0, "timeToGreenMs": 500
  }
}
```

All timestamps are UTC ISO strings. For an unresolved conflict, `mergedAt` and `validation` are `null`, and `mainRed` is `false`. `conflict` remains `true` when a charged resolution succeeds; `conflictFiles` names the original conflicting files. Each used resolved head charges one worker run and one fresh review. `timeToGreenMs` measures from the first merge attempt to the end of validation after the final change, provided every change merged, all original patches still reverse-apply to the final tree, and the final validation passed; otherwise it is `null`.

## Swarm log JSONL

The swarm arm writes one JSON object per line for each land transition, followed by a final summary line. The `transition` value is the full `concord land --json` object, including `state` and `code`.

```jsonl
{"at":"2026-01-01T00:00:10.000Z","agent":"a1","changeId":"X1","transition":{"state":"landed","code":"landed"}}
{"at":"2026-01-01T00:01:00.000Z","summary":{"replicate":"mb-ab-wed-1","repo":"<repo id>","firstCreatedAt":"2026-01-01T00:00:00.000Z","lastLandedAt":"2026-01-01T00:00:10.000Z","landed":1,"failed":0}}
```
