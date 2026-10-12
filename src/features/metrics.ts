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
  combinedTreeCheckFailures: Count; bisectBlames: Count;
  mainRedTime: { totalMs: number; n: number; eventKinds: string[] };
  issuesClosedByLand: Count;
}

const DAY = 86_400_000;
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

/** Compute from event history only. The window selects terminal/count events; origins may predate it. */
export function measureEvents(events: Event[], since: number, until: number): RepoMetrics {
  const ordered = [...events].filter(event => event.timestamp < until).sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
  const window = ordered.filter(event => event.timestamp >= since);
  const byKind = (kind: string) => window.filter(event => event.kind === kind);
  const landed = byKind('queue.promotion_applied').flatMap(event => event.relatedIds.map(id => ({ id, event })));
  const changes = new Map<string, Event[]>();
  for (const event of ordered) {
    if (['queue.promotion_applied', 'queue.enqueued', 'change.published', 'lease.claimed', 'lease.refused', 'verdict.created', 'verdict.carried'].includes(event.kind)) {
      const ids = event.kind === 'queue.promotion_applied' ? event.relatedIds : [changeId(event)];
      for (const id of ids) if (id) { const history = changes.get(id) ?? []; history.push(event); changes.set(id, history); }
    }
  }
  const origins = (kind: string, latest = false): number[] => landed.flatMap(({ id, event }) => {
    const candidates = (changes.get(id) ?? []).filter(item => item.kind === kind && item.timestamp <= event.timestamp);
    const origin = latest ? candidates.at(-1) : candidates[0];
    return origin ? [event.timestamp - origin.timestamp] : [];
  });
  const reviewWait: number[] = [];
  const revisions: number[] = [];
  for (const { id, event } of landed) {
    const history = (changes.get(id) ?? []).filter(item => item.timestamp <= event.timestamp);
    const published = history.filter(item => item.kind === 'change.published');
    if (published.length) revisions.push(new Set(published.map(item => item.payload.revision).filter(value => typeof value === 'number')).size);
    const approval = history.find(item => item.kind === 'verdict.created' && item.payload.decision === 'approve');
    const firstPublish = published[0];
    if (approval && firstPublish && approval.timestamp >= firstPublish.timestamp) reviewWait.push(approval.timestamp - firstPublish.timestamp);
  }
  const refused = byKind('lease.refused');
  const issues = new Set(refused.map(event => event.payload.issueNumber).filter(value => typeof value === 'number'));
  const waits = refused.flatMap(event => {
    const id = changeId(event);
    const granted = id && (changes.get(id) ?? []).find(item => item.kind === 'lease.claimed' && item.timestamp >= event.timestamp);
    return granted ? [granted.timestamp - event.timestamp] : [];
  });
  const rebases = window.filter(event => ['queue.auto_rebased', 'queue.rebased', 'change.auto_rebased'].includes(event.kind));
  const carried = window.filter(event => event.kind === 'verdict.created' &&
    (event.payload.carriedFrom as { method?: unknown } | null)?.method === 'patch-id');
  const failures = window.filter(event => event.kind === 'queue.result_received' && event.payload.purpose === 'stack' &&
    !['PASS', 'MATCH'].includes(String(event.payload.outcome)));
  const blames = byKind('queue.diagnosis').flatMap(event => Array.isArray(event.payload.blame) ? event.payload.blame : []);
  const issueCloses = byKind('issue.closed').filter(event => event.payload.closedBy && typeof event.payload.closedBy === 'object');
  const redStarts = ordered.filter(event => event.kind === 'queue.diagnosis' && event.payload.reason === 'BASE_RED');
  const redEnds = ordered.filter(event => event.kind === 'queue.main_green');
  const redIntervals = redStarts.flatMap(start => {
    const end = redEnds.find(item => item.timestamp > start.timestamp && item.timestamp < until);
    if (!end || end.timestamp <= since) return [];
    return [Math.max(0, end.timestamp - Math.max(start.timestamp, since))];
  });
  const revisionValues = revisions.sort((a, b) => a - b);
  return {
    since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    changesLanded: count(landed.length, ['queue.promotion_applied']),
    publishToLand: duration(origins('change.published'), ['change.published', 'queue.promotion_applied']),
    claimToLand: duration(origins('lease.claimed'), ['lease.claimed', 'queue.promotion_applied']),
    reviewWait: duration(reviewWait, ['change.published', 'verdict.created', 'queue.promotion_applied']),
    queueWait: duration(origins('queue.enqueued', true), ['queue.enqueued', 'queue.promotion_applied']),
    leaseClaimsRefused: count(refused.length, ['lease.refused']),
    distinctIssuesWithRefusedClaims: count(issues.size, ['lease.refused']),
    refusalWait: duration(waits, ['lease.refused', 'lease.claimed']),
    automaticRebases: count(rebases.length, ['queue.auto_rebased', 'queue.rebased', 'change.auto_rebased']),
    approvalsCarriedByPatchId: count(carried.length, ['verdict.created']),
    revisionsPerLandedChange: { median: quantile(revisionValues, .5), mean: revisionValues.length ? revisionValues.reduce((a, b) => a + b, 0) / revisionValues.length : 0,
      n: revisionValues.length, eventKinds: ['change.published', 'queue.promotion_applied'] },
    reworkRevisions: count(revisionValues.reduce((sum, value) => sum + Math.max(0, value - 1), 0), ['change.published', 'queue.promotion_applied'], revisionValues.length),
    combinedTreeCheckFailures: count(failures.length, ['queue.result_received']),
    bisectBlames: count(blames.length, ['queue.diagnosis']),
    mainRedTime: { totalMs: redIntervals.reduce((a, b) => a + b, 0), n: redIntervals.length, eventKinds: ['queue.diagnosis', 'queue.main_green'] },
    issuesClosedByLand: count(issueCloses.length, ['issue.closed']),
  };
}
