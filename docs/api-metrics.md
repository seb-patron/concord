# Repository flow metrics

`GET /v1/repos/:repoId/metrics?since=<ISO>&until=<ISO>` returns measured flow from the repository event log. A repository-scoped reader token, including owner and viewer tokens, can read it. Both bounds are required UTC timestamps such as `2026-10-12T00:00:00.000Z`. The interval is `[since, until)` and must be positive and at most 31 days; invalid bounds return `400 INVALID_METRICS_WINDOW`. The coordinator streams the indexed window with SQL `LIMIT 20000`. It reads earlier origins for each landed change without retaining landed IDs. Results for the same normalized window are cached for 60 seconds; each repository coordinator keeps at most 16 windows cached.

The standard API envelope contains `data`, `version`, and `eventSeq`. `data.truncated` is `true` when the 20,000-event limit is reached; counts and totals then describe only that first ordered prefix. Each number in `data` has `n` and `eventKinds`. Count fields have `value`; durations have `medianMs`, `p90Ms`, and `totalMs`; `revisionsPerLandedChange` has `median` and `mean`; `mainRedTime` has `totalMs`. Medians and p90 values use linear interpolation between ordered samples. At most 2,000 duration or revision values per metric are retained in a deterministically seeded reservoir; totals and `n` cover all observed values. Empty samples have zero values and `n: 0`.

| Field | Event evidence and population |
| --- | --- |
| `changesLanded` | Change IDs in `queue.promotion_applied` inside the window. |
| `publishToLand`, `claimToLand` | First `change.published` or `lease.claimed` for each landed change to its land event. Origins can precede the window. |
| `reviewWait` | First publish to first approving `verdict.created` for each landed change. |
| `queueWait` | Latest `queue.enqueued` to land for each landed change. |
| `leaseClaimsRefused`, `distinctIssuesWithRefusedClaims`, `refusalWait` | `lease.refused` in the window, its recorded `issueNumber`, and each refusal to the next `lease.claimed` for the same change and one of its refused unit keys. Unresolved refusals have no wait sample. |
| `automaticRebases` | Explicit `queue.auto_rebased`, `queue.rebased`, or `change.auto_rebased` events only. The current queue does not emit these, so the count remains zero with `n: 0` until automatic rebase work adds an event. No clean or conflict breakdown is inferred. |
| `approvalsCarriedByPatchId` | `verdict.created` with recorded `carriedFrom.method: "patch-id"`. |
| `revisionsPerLandedChange`, `reworkRevisions` | Distinct `change.published` revisions per landed change; rework sums revisions beyond the first. |
| `combinedTreeCheckFailures`, `stackInfrastructureFailures`, `bisectBlames` | Failing stack results with a candidate and matching nonempty `sourceTreeOid` and `composedTreeOid` evidence; stack `ENV_ERROR` or `TIMEOUT` results; entries in `queue.diagnosis.payload.blame`. Baseline and diagnostic subset failures are excluded from the first count. |
| `mainRedTime` | Complete `queue.diagnosis` `BASE_RED` events with `baselineVerifiedFail: true` to `queue.main_green` intervals overlapping the window. Only a verified `FAIL` from the baseline check starts red time; infrastructure and other nonpassing outcomes do not. The queue emits `queue.main_green` after a verified passing baseline check. `unresolved: true` means a red interval remains open at `until`; its unmeasured time is excluded from `totalMs` and `n`. |
| `issuesClosedByLand` | `issue.closed` with `closedBy` evidence in the window. |

This endpoint does not estimate a GitHub baseline or a speedup ratio. Comparisons need separately measured GitHub events. For a CLI read, run `concord metrics --repo ID --since 2026-10-01T00:00:00.000Z --until 2026-10-02T00:00:00.000Z`. MCP exposes the same data as `repo_metrics` with `repoId`, `since`, and `until` arguments. Tracker uses today's UTC window when this endpoint is available.
