import type { Event } from '../contracts';
import { HttpError } from '../http';

type Count = { value: number; n: number; eventKinds: string[] };
type Duration = { medianMs: number; p90Ms: number; totalMs: number; n: number; eventKinds: string[] };
type Revision = { median: number; mean: number; n: number; eventKinds: string[] };
export interface RepoMetrics {
  since: string; until: string; truncated: boolean;
  changesLanded: Count;
  publishToLand: Duration; claimToLand: Duration; reviewWait: Duration; queueWait: Duration;
  leaseClaimsRefused: Count; distinctIssuesWithRefusedClaims: Count; refusalWait: Duration;
  automaticRebases: Count; approvalsCarriedByPatchId: Count;
  revisionsPerLandedChange: Revision; reworkRevisions: Count;
  combinedTreeCheckFailures: Count; stackInfrastructureFailures: Count; bisectBlames: Count;
  mainRedTime: { totalMs: number; n: number; unresolved: boolean; eventKinds: string[] };
  issuesClosedByLand: Count;
}

const DAY = 86_400_000;
/** Maximum number of indexed window events examined by one metrics request. */
export const METRIC_EVENT_LIMIT = 20_000;
export const METRIC_SAMPLE_LIMIT = 2_000;
type EventRow = { sequence: number; kind: string; actor_id: string; timestamp: number; version: number; related_ids: string; payload: string };
function decodeEvent(row: EventRow): Event {
  return { sequence: row.sequence, kind: row.kind, actorId: row.actor_id, timestamp: row.timestamp,
    version: row.version, relatedIds: JSON.parse(row.related_ids) as string[], payload: JSON.parse(row.payload) as Record<string, unknown> };
}

/** Iterate the indexed SQL result without materializing the bounded window in JS. */
export function* metricWindowEvents(sql: SqlStorage, since: number, until: number): Generator<Event> {
  for (const row of sql.exec<EventRow>(`SELECT sequence, kind, actor_id, timestamp, version, related_ids, payload
    FROM concord_events WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp, sequence LIMIT ?`,
  since, until, METRIC_EVENT_LIMIT)) yield decodeEvent(row);
}

/** Fixed-size, reproducible reservoir. Totals and n always cover every observed value. */
export class MetricSample {
  private readonly values: number[] = [];
  private seed: number;
  total = 0;
  n = 0;
  constructor(seed: number) { this.seed = seed >>> 0 || 1; }
  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.n++;
    this.total += value;
    // xorshift32 gives stable sampling across processes and requests.
    this.seed ^= this.seed << 13; this.seed ^= this.seed >>> 17; this.seed ^= this.seed << 5;
    const slot = (this.seed >>> 0) % this.n;
    if (this.values.length < METRIC_SAMPLE_LIMIT) this.values.push(value);
    else if (slot < METRIC_SAMPLE_LIMIT) this.values[slot] = value;
  }
  get sampleSize(): number { return this.values.length; }
  quantile(fraction: number): number { return quantile([...this.values].sort((a, b) => a - b), fraction); }
  duration(kinds: string[]): Duration {
    return { medianMs: this.quantile(.5), p90Ms: this.quantile(.9), totalMs: this.total, n: this.n, eventKinds: kinds };
  }
}

export function metricPriorRedStart(sql: SqlStorage, since: number): number | null {
  const green = sql.exec<{ timestamp: number; sequence: number }>(`SELECT timestamp, sequence FROM concord_events
    WHERE kind = 'queue.main_green' AND timestamp < ? ORDER BY timestamp DESC, sequence DESC LIMIT 1`, since).toArray()[0];
  const red = sql.exec<{ timestamp: number }>(`SELECT timestamp FROM concord_events
    WHERE kind = 'queue.diagnosis' AND json_extract(payload, '$.reason') = 'BASE_RED'
      AND json_extract(payload, '$.baselineVerifiedFail') = 1
      AND timestamp < ? AND (timestamp, sequence) > (?, ?)
    ORDER BY timestamp, sequence LIMIT 1`, since, green?.timestamp ?? -Number.MAX_SAFE_INTEGER, green?.sequence ?? 0).toArray()[0];
  return red?.timestamp ?? null;
}

type OriginRow = { first_claim: number | null; first_publish: number | null; first_approval: number | null;
  last_enqueue: number | null; published: number; revisions: number };
function landOrigins(sql: SqlStorage, id: string, land: Event): OriginRow {
  return sql.exec<OriginRow>(`SELECT
    MIN(CASE WHEN kind = 'lease.claimed' THEN timestamp END) AS first_claim,
    MIN(CASE WHEN kind = 'change.published' THEN timestamp END) AS first_publish,
    MIN(CASE WHEN kind = 'verdict.created' AND json_extract(payload, '$.decision') = 'approve' THEN timestamp END) AS first_approval,
    MAX(CASE WHEN kind = 'queue.enqueued' THEN timestamp END) AS last_enqueue,
    SUM(CASE WHEN kind = 'change.published' THEN 1 ELSE 0 END) AS published,
    COALESCE(MAX(CASE WHEN kind = 'change.published' AND json_type(payload, '$.revision') IN ('integer', 'real')
      THEN json_extract(payload, '$.revision') END), 0) AS revisions
    FROM concord_events WHERE (timestamp, sequence) < (?, ?) AND (
      (kind IN ('change.published', 'queue.enqueued') AND json_extract(related_ids, '$[0]') = ?) OR
      (kind = 'verdict.created' AND json_extract(related_ids, '$[1]') = ?) OR
      (kind = 'lease.claimed' AND (json_extract(related_ids, '$[1]') = ? OR json_extract(payload, '$.changeId') = ?)))`,
  land.timestamp, land.sequence, id, id, id, id).toArray()[0];
}

function firstGrantAfterRefusal(sql: SqlStorage, event: Event, until: number,
  cutoff: { timestamp: number; sequence: number } | undefined): number | null {
  const id = changeId(event);
  const keys = Array.isArray(event.payload.keys) ? event.payload.keys.filter((key): key is string => typeof key === 'string') : [];
  if (!id || !keys.length) return null;
  const row = sql.exec<{ timestamp: number }>(`SELECT timestamp FROM concord_events
    WHERE kind = 'lease.claimed' AND (json_extract(payload, '$.changeId') = ? OR json_extract(related_ids, '$[1]') = ?)
      AND (timestamp, sequence) > (?, ?) AND timestamp < ? AND (timestamp, sequence) <= (?, ?)
      AND EXISTS (SELECT 1 FROM json_each(?) WHERE value = json_extract(concord_events.payload, '$.unitKey'))
    ORDER BY timestamp, sequence LIMIT 1`, id, id, event.timestamp, event.sequence, until,
  cutoff?.timestamp ?? until, cutoff?.sequence ?? Number.MAX_SAFE_INTEGER, JSON.stringify(keys)).toArray()[0];
  return row?.timestamp ?? null;
}

/** Exact issue cardinality over the same bounded prefix, computed inside SQLite. */
function refusedIssueCount(sql: SqlStorage, since: number, until: number): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(DISTINCT json_extract(payload, '$.issueNumber')) AS n FROM (
    SELECT kind, payload FROM concord_events WHERE timestamp >= ? AND timestamp < ?
    ORDER BY timestamp, sequence LIMIT ?
  ) WHERE kind = 'lease.refused' AND json_type(payload, '$.issueNumber') IN ('integer', 'real')`,
  since, until, METRIC_EVENT_LIMIT).toArray()[0].n;
}

/** One pass over at most 20,000 indexed window events; no per-event history is retained. */
export function measureSqlMetrics(sql: SqlStorage, since: number, until: number): RepoMetrics {
  // The cutoff also keeps forward-looking refusal waits inside the reported prefix.
  const cutoff = sql.exec<{ timestamp: number; sequence: number }>(`SELECT timestamp, sequence FROM concord_events
    WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp, sequence LIMIT 1 OFFSET ?`,
  since, until, METRIC_EVENT_LIMIT - 1).toArray()[0];
  const publish = new MetricSample(1); const claim = new MetricSample(2); const review = new MetricSample(3);
  const queued = new MetricSample(4); const refusedWait = new MetricSample(5); const revisions = new MetricSample(6);
  let seen = 0; let landed = 0; let refused = 0; let rebases = 0; let carried = 0;
  let rework = 0; let failures = 0; let infrastructureFailures = 0; let blames = 0; let issueCloses = 0;
  let redStart = metricPriorRedStart(sql, since); let redTotal = 0; let redCount = 0;
  for (const event of metricWindowEvents(sql, since, until)) {
    seen++;
    if (event.kind === 'queue.promotion_applied') {
      for (const id of event.relatedIds) {
        landed++;
        const origin = landOrigins(sql, id, event);
        if (origin.first_publish !== null) publish.add(event.timestamp - origin.first_publish);
        if (origin.first_claim !== null) claim.add(event.timestamp - origin.first_claim);
        if (origin.last_enqueue !== null) queued.add(event.timestamp - origin.last_enqueue);
        if (origin.published) {
          revisions.add(origin.revisions);
          rework += Math.max(0, origin.revisions - 1);
        }
        if (origin.first_approval !== null && origin.first_publish !== null && origin.first_approval >= origin.first_publish)
          review.add(origin.first_approval - origin.first_publish);
      }
    }
    if (event.kind === 'lease.refused') {
      refused++;
      const grant = firstGrantAfterRefusal(sql, event, until, cutoff);
      if (grant !== null) refusedWait.add(grant - event.timestamp);
    }
    if (['queue.auto_rebased', 'queue.rebased', 'change.auto_rebased'].includes(event.kind)) rebases++;
    if (event.kind === 'verdict.created' && (event.payload.carriedFrom as { method?: unknown } | null)?.method === 'patch-id') carried++;
    if (event.kind === 'queue.result_received' && event.payload.purpose === 'stack') {
      if (['ENV_ERROR', 'TIMEOUT'].includes(String(event.payload.outcome))) infrastructureFailures++;
      if (['FAIL', 'MISMATCH', 'COMPILE_ERROR', 'UNVERIFIED_TARGET'].includes(String(event.payload.outcome))
        && event.payload.bootstrap === false && typeof event.payload.candidateCount === 'number' && event.payload.candidateCount > 0
        && typeof event.payload.composedTreeOid === 'string' && event.payload.composedTreeOid.length > 0
        && event.payload.sourceTreeOid === event.payload.composedTreeOid) failures++;
    }
    if (event.kind === 'queue.diagnosis') {
      if (Array.isArray(event.payload.blame)) blames += event.payload.blame.length;
      if (event.payload.reason === 'BASE_RED' && event.payload.baselineVerifiedFail === true && redStart === null)
        redStart = event.timestamp;
    }
    if (event.kind === 'queue.main_green' && redStart !== null) {
      redTotal += event.timestamp - Math.max(redStart, since);
      redCount++;
      redStart = null;
    }
    if (event.kind === 'issue.closed' && event.payload.closedBy && typeof event.payload.closedBy === 'object') issueCloses++;
  }
  const issues = refused ? refusedIssueCount(sql, since, until) : 0;
  return {
    since: new Date(since).toISOString(), until: new Date(until).toISOString(), truncated: seen === METRIC_EVENT_LIMIT,
    changesLanded: count(landed, ['queue.promotion_applied']),
    publishToLand: publish.duration(['change.published', 'queue.promotion_applied']),
    claimToLand: claim.duration(['lease.claimed', 'queue.promotion_applied']),
    reviewWait: review.duration(['change.published', 'verdict.created', 'queue.promotion_applied']),
    queueWait: queued.duration(['queue.enqueued', 'queue.promotion_applied']),
    leaseClaimsRefused: count(refused, ['lease.refused']),
    distinctIssuesWithRefusedClaims: count(issues, ['lease.refused']),
    refusalWait: refusedWait.duration(['lease.refused', 'lease.claimed']),
    automaticRebases: count(rebases, ['queue.auto_rebased', 'queue.rebased', 'change.auto_rebased']),
    approvalsCarriedByPatchId: count(carried, ['verdict.created']),
    revisionsPerLandedChange: { median: revisions.quantile(.5), mean: revisions.n ? revisions.total / revisions.n : 0,
      n: revisions.n, eventKinds: ['change.published', 'queue.promotion_applied'] },
    reworkRevisions: count(rework, ['change.published', 'queue.promotion_applied'], revisions.n),
    combinedTreeCheckFailures: count(failures, ['queue.result_received']),
    stackInfrastructureFailures: count(infrastructureFailures, ['queue.result_received']),
    bisectBlames: count(blames, ['queue.diagnosis']),
    mainRedTime: { totalMs: redTotal, n: redCount, unresolved: redStart !== null,
      eventKinds: ['queue.diagnosis', 'queue.main_green'] },
    issuesClosedByLand: count(issueCloses, ['issue.closed']),
  };
}
export function metricsWindow(search: URLSearchParams): { since: number; until: number; sinceIso: string; untilIso: string } {
  const from = search.get('since'); const to = search.get('until');
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!from || !to || !iso.test(from) || !iso.test(to)) throw new HttpError(400, 'INVALID_METRICS_WINDOW', 'since and until must be UTC ISO timestamps');
  const since = Date.parse(from); const until = Date.parse(to);
  if (!Number.isFinite(since) || !Number.isFinite(until) || new Date(since).toISOString() !== new Date(from).toISOString() ||
    new Date(until).toISOString() !== new Date(to).toISOString() || until <= since || until - since > 31 * DAY) {
    throw new HttpError(400, 'INVALID_METRICS_WINDOW', 'Window must be positive and at most 31 days');
  }
  return { since, until, sinceIso: new Date(since).toISOString(), untilIso: new Date(until).toISOString() };
}

function count(value: number, kinds: string[], n = value): Count { return { value, n, eventKinds: kinds }; }
function quantile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const rank = (sorted.length - 1) * fraction;
  const lower = Math.floor(rank); const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}
const changeId = (event: Event): string | undefined => event.kind.startsWith('lease.') ?
  (typeof event.payload.changeId === 'string' ? event.payload.changeId : event.kind === 'lease.refused' ? event.relatedIds[0] : event.relatedIds[1]) :
  event.kind.startsWith('verdict.') ? event.relatedIds[1] : event.relatedIds[0];
