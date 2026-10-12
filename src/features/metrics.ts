import type { Event } from '../contracts';
import { HttpError } from '../http';

type Count = { value: number; n: number; eventKinds: string[] };
type Duration = { medianMs: number; p90Ms: number; totalMs: number; n: number; eventKinds: string[] };
type Revision = { median: number; mean: number; n: number; eventKinds: string[] };
export interface RepoMetrics {
  since: string; until: string;
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
const METRIC_PAGE_SIZE = 128;
type EventRow = { sequence: number; kind: string; actor_id: string; timestamp: number; version: number; related_ids: string; payload: string };
function decodeEvent(row: EventRow): Event {
  return { sequence: row.sequence, kind: row.kind, actorId: row.actor_id, timestamp: row.timestamp,
    version: row.version, relatedIds: JSON.parse(row.related_ids) as string[], payload: JSON.parse(row.payload) as Record<string, unknown> };
}

/** Keyset pages keep both SQLite's result and the JS working set bounded. */
export function* metricWindowEvents(sql: SqlStorage, since: number, until: number): Generator<Event> {
  let timestamp = since; let sequence = 0;
  for (;;) {
    const rows = sql.exec<EventRow>(`SELECT sequence, kind, actor_id, timestamp, version, related_ids, payload
      FROM concord_events WHERE timestamp >= ? AND timestamp < ? AND (timestamp, sequence) > (?, ?)
      ORDER BY timestamp, sequence LIMIT ?`, since, until, timestamp, sequence, METRIC_PAGE_SIZE).toArray();
    for (const row of rows) yield decodeEvent(row);
    if (rows.length < METRIC_PAGE_SIZE) return;
    timestamp = rows[rows.length - 1].timestamp;
    sequence = rows[rows.length - 1].sequence;
  }
}

export function* metricLandingIds(sql: SqlStorage, since: number, until: number): Generator<string> {
  let timestamp = since; let sequence = 0;
  for (;;) {
    const rows = sql.exec<{ timestamp: number; sequence: number; related_ids: string }>(`SELECT timestamp, sequence, related_ids
      FROM concord_events WHERE kind = 'queue.promotion_applied' AND timestamp >= ? AND timestamp < ?
        AND (timestamp, sequence) > (?, ?) ORDER BY timestamp, sequence LIMIT ?`,
    since, until, timestamp, sequence, METRIC_PAGE_SIZE).toArray();
    for (const row of rows) yield* JSON.parse(row.related_ids) as string[];
    if (rows.length < METRIC_PAGE_SIZE) return;
    timestamp = rows[rows.length - 1].timestamp;
    sequence = rows[rows.length - 1].sequence;
  }
}

/** Only a change landing in the window needs its earlier origin events. */
export function* metricPriorEvents(sql: SqlStorage, id: string, since: number): Generator<Event> {
  let timestamp = -Number.MAX_SAFE_INTEGER; let sequence = 0;
  for (;;) {
    const rows = sql.exec<EventRow>(`SELECT sequence, kind, actor_id, timestamp, version, related_ids, payload
      FROM concord_events WHERE timestamp < ? AND (timestamp, sequence) > (?, ?) AND (
        (kind IN ('change.published', 'queue.enqueued') AND json_extract(related_ids, '$[0]') = ?) OR
        (kind IN ('lease.claimed', 'verdict.created') AND json_extract(related_ids, '$[1]') = ?) OR
        (kind = 'lease.claimed' AND json_extract(payload, '$.changeId') = ?))
      ORDER BY timestamp, sequence LIMIT ?`, since, timestamp, sequence, id, id, id, METRIC_PAGE_SIZE).toArray();
    for (const row of rows) yield decodeEvent(row);
    if (rows.length < METRIC_PAGE_SIZE) return;
    timestamp = rows[rows.length - 1].timestamp;
    sequence = rows[rows.length - 1].sequence;
  }
}

export function metricPriorRedStart(sql: SqlStorage, since: number): number | null {
  const green = sql.exec<{ timestamp: number; sequence: number }>(`SELECT timestamp, sequence FROM concord_events
    WHERE kind = 'queue.main_green' AND timestamp < ? ORDER BY timestamp DESC, sequence DESC LIMIT 1`, since).toArray()[0];
  const red = sql.exec<{ timestamp: number }>(`SELECT timestamp FROM concord_events
    WHERE kind = 'queue.diagnosis' AND json_extract(payload, '$.reason') = 'BASE_RED'
      AND timestamp < ? AND (timestamp, sequence) > (?, ?)
    ORDER BY timestamp, sequence LIMIT 1`, since, green?.timestamp ?? -Number.MAX_SAFE_INTEGER, green?.sequence ?? 0).toArray()[0];
  return red?.timestamp ?? null;
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
function duration(values: number[], kinds: string[]): Duration {
  const ordered = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return { medianMs: quantile(ordered, .5), p90Ms: quantile(ordered, .9), totalMs: ordered.reduce((a, b) => a + b, 0), n: ordered.length, eventKinds: kinds };
}
const changeId = (event: Event): string | undefined => event.kind.startsWith('lease.') ?
  (typeof event.payload.changeId === 'string' ? event.payload.changeId : event.kind === 'lease.refused' ? event.relatedIds[0] : event.relatedIds[1]) :
  event.kind.startsWith('verdict.') ? event.relatedIds[1] : event.relatedIds[0];

/** Consume ordered history without retaining unrelated events. Prior origins may precede since. */
export function measureEventStream(events: Iterable<Event>, since: number, until: number,
  landedIds: ReadonlySet<string>, initialRedStart: number | null = null): RepoMetrics {
  type ChangeSummary = { firstClaim?: number; firstPublish?: number; firstApproval?: number; lastEnqueue?: number;
    published: boolean; revisions: Set<number> };
  const changes = new Map<string, ChangeSummary>();
  const publishToLand: number[] = []; const claimToLand: number[] = []; const queueWait: number[] = [];
  const reviewWait: number[] = []; const revisions: number[] = [];
  let changesLanded = 0;
  let pendingLandAt: number | null = null;
  const pendingLands: string[] = [];
  const finishLands = () => {
    if (pendingLandAt === null) return;
    for (const id of pendingLands) {
      const history = changes.get(id);
      if (!history) continue;
      if (history.firstPublish !== undefined) publishToLand.push(pendingLandAt - history.firstPublish);
      if (history.firstClaim !== undefined) claimToLand.push(pendingLandAt - history.firstClaim);
      if (history.lastEnqueue !== undefined) queueWait.push(pendingLandAt - history.lastEnqueue);
      if (history.published) revisions.push(history.revisions.size);
      if (history.firstApproval !== undefined && history.firstPublish !== undefined && history.firstApproval >= history.firstPublish) {
        reviewWait.push(history.firstApproval - history.firstPublish);
      }
    }
    pendingLands.length = 0;
    pendingLandAt = null;
  };
  const refused: Event[] = [];
  const grants = new Map<string, Event[]>();
  const issues = new Set<number>();
  let rebases = 0; let carried = 0; let failures = 0; let infrastructureFailures = 0;
  let blames = 0; let issueCloses = 0;
  let redStart = initialRedStart; let redTotal = 0; let redCount = 0;
  for (const event of events) {
    if (event.timestamp >= until) continue;
    if (pendingLandAt !== null && event.timestamp !== pendingLandAt) finishLands();
    if (landedIds.has(changeId(event) ?? '') && ['queue.enqueued', 'change.published', 'lease.claimed', 'verdict.created'].includes(event.kind)) {
      const id = changeId(event)!;
      const history = changes.get(id) ?? { published: false, revisions: new Set<number>() };
      if (event.kind === 'lease.claimed') history.firstClaim ??= event.timestamp;
      if (event.kind === 'change.published') {
        history.firstPublish ??= event.timestamp;
        history.published = true;
        if (typeof event.payload.revision === 'number') history.revisions.add(event.payload.revision);
      }
      if (event.kind === 'verdict.created' && event.payload.decision === 'approve') history.firstApproval ??= event.timestamp;
      if (event.kind === 'queue.enqueued') history.lastEnqueue = event.timestamp;
      changes.set(id, history);
    }
    if (event.timestamp < since) {
      if (event.kind === 'queue.diagnosis' && event.payload.reason === 'BASE_RED' && redStart === null) redStart = event.timestamp;
      if (event.kind === 'queue.main_green') redStart = null;
      continue;
    }
    if (event.kind === 'queue.promotion_applied') {
      pendingLandAt = event.timestamp;
      for (const id of event.relatedIds) { pendingLands.push(id); changesLanded++; }
    }
    if (event.kind === 'lease.refused') {
      refused.push(event);
      if (typeof event.payload.issueNumber === 'number') issues.add(event.payload.issueNumber);
    }
    if (event.kind === 'lease.claimed') {
      const id = changeId(event);
      if (id) { const history = grants.get(id) ?? []; history.push(event); grants.set(id, history); }
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
      if (event.payload.reason === 'BASE_RED' && redStart === null) redStart = event.timestamp;
    }
    if (event.kind === 'queue.main_green' && redStart !== null) {
      redTotal += event.timestamp - Math.max(redStart, since);
      redCount++;
      redStart = null;
    }
    if (event.kind === 'issue.closed' && event.payload.closedBy && typeof event.payload.closedBy === 'object') issueCloses++;
  }
  finishLands();
  const waits = refused.flatMap(event => {
    const id = changeId(event);
    const keys = Array.isArray(event.payload.keys) ? event.payload.keys.filter((key): key is string => typeof key === 'string') : [];
    const granted = id && keys.length && (grants.get(id) ?? []).find(item =>
      (item.timestamp > event.timestamp || item.timestamp === event.timestamp && item.sequence > event.sequence)
      && keys.includes(item.payload.unitKey as string));
    return granted ? [granted.timestamp - event.timestamp] : [];
  });
  const revisionValues = revisions.sort((a, b) => a - b);
  return {
    since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    changesLanded: count(changesLanded, ['queue.promotion_applied']),
    publishToLand: duration(publishToLand, ['change.published', 'queue.promotion_applied']),
    claimToLand: duration(claimToLand, ['lease.claimed', 'queue.promotion_applied']),
    reviewWait: duration(reviewWait, ['change.published', 'verdict.created', 'queue.promotion_applied']),
    queueWait: duration(queueWait, ['queue.enqueued', 'queue.promotion_applied']),
    leaseClaimsRefused: count(refused.length, ['lease.refused']),
    distinctIssuesWithRefusedClaims: count(issues.size, ['lease.refused']),
    refusalWait: duration(waits, ['lease.refused', 'lease.claimed']),
    automaticRebases: count(rebases, ['queue.auto_rebased', 'queue.rebased', 'change.auto_rebased']),
    approvalsCarriedByPatchId: count(carried, ['verdict.created']),
    revisionsPerLandedChange: { median: quantile(revisionValues, .5), mean: revisionValues.length ? revisionValues.reduce((a, b) => a + b, 0) / revisionValues.length : 0,
      n: revisionValues.length, eventKinds: ['change.published', 'queue.promotion_applied'] },
    reworkRevisions: count(revisionValues.reduce((sum, value) => sum + Math.max(0, value - 1), 0), ['change.published', 'queue.promotion_applied'], revisionValues.length),
    combinedTreeCheckFailures: count(failures, ['queue.result_received']),
    stackInfrastructureFailures: count(infrastructureFailures, ['queue.result_received']),
    bisectBlames: count(blames, ['queue.diagnosis']),
    mainRedTime: { totalMs: redTotal, n: redCount,
      unresolved: redStart !== null, eventKinds: ['queue.diagnosis', 'queue.main_green'] },
    issuesClosedByLand: count(issueCloses, ['issue.closed']),
  };
}

/** Compute from event history only. The window selects terminal/count events; origins may predate it. */
export function measureEvents(events: Event[], since: number, until: number): RepoMetrics {
  const ordered = [...events].filter(event => event.timestamp < until).sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
  const landedIds = new Set(ordered.filter(event => event.timestamp >= since && event.kind === 'queue.promotion_applied')
    .flatMap(event => event.relatedIds));
  return measureEventStream(ordered, since, until, landedIds);
}
