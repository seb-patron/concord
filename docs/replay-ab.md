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

`charge` may be `null`. IDs and orders must be unique, every dependency must name a change, and dependency cycles are invalid. All commit fields use 40 hexadecimal characters. The runner sorts by `order` and starts at `startCommit`. For each change it checks the merge with `git merge-tree --write-tree`, then merges `head` with `git merge --no-ff --no-edit`. A conflict is recorded with its file names. If a `charge.resolvedHead` is present and merges cleanly, it is used instead and its rebase and review minutes are charged. An unresolved conflict is skipped; later changes are still attempted. The runner executes `validationCommand` in the clone after every successful merge. A nonzero exit, including timeout exit code 124, marks that merge as main red.

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

All timestamps are UTC ISO strings. For an unresolved conflict, `mergedAt` and `validation` are `null`, and `mainRed` is `false`. `conflict` remains `true` when a charged resolution succeeds; `conflictFiles` names the original conflicting files. Each used resolved head charges one worker run and one fresh review. `timeToGreenMs` measures from the first merge attempt to the end of validation after the final change, provided every change merged and the final validation passed; otherwise it is `null`.

## Swarm log JSONL

The swarm arm writes one JSON object per line for each land transition, followed by a final summary line. The `transition` value is the full `concord land --json` object, including `state` and `code`.

```jsonl
{"at":"2026-01-01T00:00:10.000Z","agent":"a1","changeId":"X1","transition":{"state":"landed","code":"landed"}}
{"at":"2026-01-01T00:01:00.000Z","summary":{"replicate":"mb-ab-wed-1","repo":"<repo id>","firstCreatedAt":"2026-01-01T00:00:00.000Z","lastLandedAt":"2026-01-01T00:00:10.000Z","landed":1,"failed":0}}
```
