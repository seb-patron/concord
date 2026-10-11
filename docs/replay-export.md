# Replay timeline export

The replay harness reads a sanitized JSONL file supplied locally by the owner. It has no database, chat, or GitHub fetch integration. Keep exports outside version control and do not include source code, private paths, credentials, raw chat, or proprietary identifiers.

## JSONL v1

The first line is one header object; each following line is one event object. The header requires `schemaVersion: 1`, `exportId`, `sourceType` (`dbos_export` or `pr_history`), a `sourceRef` beginning `redacted:`, a `sourceDigest` in `sha256:<64 lowercase hex>` form, UTC `exportedAt`, `anonymizationVersion`, `ownerReleaseApprovalRef`, and `selected`. `selected` contains a `cohortId`, explicit `taskIds`, and a nonempty UTC `window` (`startAt`, `endAt`). Every event must identify its `eventId`, selected `taskId`, anonymized `unitKeys` (`unit:<opaque-id>`), UTC `occurredAt`, supported `type`, and redacted `sourceEventRef`.

Measured event durations use `durationMs`, `durationMetric` (`wait`, `checker`, or `work`), and `durationSource`. A source field is recorded as `{ "kind": "source_field", "sourceEventRef": "redacted:..." }`. A duration derived from two events is `{ "kind": "paired_events", "startEventId": "...", "endEventId": "..." }`; the event timestamps must reproduce the duration exactly. Durations are milliseconds. Units and timestamps are never inferred. Optional `overlapTaskIds` and `dependencyTaskIds` record only observed semantic evidence inside this selected cohort. Optional terminal `outcome` is `landed`, `refused`, or `unknown`; unknown remains unknown.

The header may include `ownerReportedAggregates`, with an explicitly reported value (or `null`), denominator when available, and redacted source reference. Aggregate names must be lowercase identifiers: an ASCII letter followed by up to 63 lowercase letters, digits, or underscores. Each aggregate accepts only `value`, `denominator`, and `sourceRef`; extra fields are rejected to keep unchecked content out of reports. Validation errors do not echo aggregate names, and report generation excludes invalid names. These owner numbers remain separate context and never become per-task events. `ownerReleaseApprovalRef` attests that the owner approved release; the harness cannot verify the underlying private source or the approval itself.

Synthetic fixtures set `evidenceClass: "synthetic"`. They are accepted by tests with an explicit opt-in but rejected by the CLI's historical validate and compare modes. Do not change this field to make synthetic evidence appear historical.

## Commands

```sh
npm run replay -- validate --input "$CONCORD_TIMELINE"
npm run replay -- compare --input "$CONCORD_TIMELINE" --output "$CONCORD_RUN_DIR/replay.html" --workers 2 --checkers 1
npm run replay -- compare --explain-missing --output "$CONCORD_RUN_DIR/replay.html"
```

Capacities are positive integers (defaults: two workers and one checker). The simulation uses recorded work/checker durations and the selected task cohort. It schedules every recorded checker duration for a task in observed order. A recheck requires a distinct observed checker duration after the request and before the next request; an initial check must precede the first recheck. Paired checker durations use the paired `check_started` time for this association; source-field durations use the duration record time. Equal timestamps cannot establish order. If association cannot be established, that task's timing is unknown. Missing duration also makes that simulated task unknown. Only explicit dependency evidence constrains task start; unknown outcomes stay unknown. A task is uncensored only when a terminal event has an explicit `landed` or `refused` outcome. The report preserves denominators, missing task IDs, censoring, and event IDs, and keeps owner aggregates, measured historical facts, simulation assumptions/output, and synthetic live-demo telemetry separate. A simulation is not an observed result and the report emits no causal speedup or fleet-wide savings estimate.

The unavailable report says the historical comparison is unavailable. It contains no zero-valued baseline or speedup. Supply an owner-approved sanitized export before making a historical comparison claim.
