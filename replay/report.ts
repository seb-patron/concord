import { safeAggregateName, type ReplayExport, type DurationMetric } from './schema.ts';
import { simulateReplay, type SimulationOptions, type SimulationResult } from './simulate.ts';

export interface ReplayReport {
  status: 'available' | 'unavailable';
  message?: string;
  provenance?: { exportId: string; sourceType: string; sourceRef: string; sourceDigest: string; ownerReleaseApprovalRef: string; cohortId: string; taskIds: string[]; window: { startAt: string; endAt: string }; releaseReferenceIsAttestationOnly: true };
  ownerReportedAggregateContext: unknown;
  measuredHistoricalBaseline: null | {
    label: 'measured historical';
    eventCounts: Record<string, number>;
    durations: Record<DurationMetric, { valueMs: number | null; measuredCount: number; selectedTaskDenominator: number; missingTaskIds: string[]; sourceEventIds: string[] }>;
    repairs: { count: number; taskDenominator: number; sourceEventIds: string[] };
    reviews: { count: number; taskDenominator: number; sourceEventIds: string[] };
    landedWork: { count: number; taskDenominator: number; sourceEventIds: string[] };
    censoredTaskIds: string[];
  };
  simulation: SimulationResult | null;
  syntheticLiveDemoTelemetry: { status: 'separate dataset not supplied'; eventCount: null };
  claims: { causalSpeedup: 'not established'; fleetWideSavings: 'not estimated' };
}

export function buildReplayReport(data: ReplayExport, options?: SimulationOptions): ReplayReport {
  const taskIds = data.header.selected.taskIds;
  const events = data.events;
  const metrics: DurationMetric[] = ['wait', 'checker', 'work'];
  const durations = Object.fromEntries(metrics.map(metric => {
    const samples = events.filter(e => e.durationMetric === metric && e.durationMs !== undefined);
    const covered = new Set(samples.map(e => e.taskId));
    return [metric, {
      valueMs: samples.length ? samples.reduce((sum, e) => sum + e.durationMs!, 0) : null,
      measuredCount: samples.length,
      selectedTaskDenominator: taskIds.length,
      missingTaskIds: taskIds.filter(id => !covered.has(id)),
      sourceEventIds: samples.map(e => e.eventId),
    }];
  })) as ReplayReport['measuredHistoricalBaseline'] extends infer T ? T extends { durations: infer D } ? D : never : never;
  const countEvents = (type: string) => events.filter(e => e.type === type);
  const eventCounts: Record<string, number> = {};
  for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
  const terminal = new Set(events.filter(e => ['merged', 'task_finished', 'task_refused'].includes(e.type) && (e.outcome === 'landed' || e.outcome === 'refused')).map(e => e.taskId));
  const header = data.header;
  const ownerReportedAggregateContext = header.ownerReportedAggregates === undefined ? null : Object.fromEntries(
    Object.entries(header.ownerReportedAggregates).filter(([name]) => safeAggregateName(name)).map(([name, aggregate]) => [name, {
      value: aggregate.value, ...(aggregate.denominator !== undefined ? { denominator: aggregate.denominator } : {}), sourceRef: aggregate.sourceRef,
    }]),
  );
  return {
    status: 'available',
    provenance: {
      exportId: header.exportId, sourceType: header.sourceType, sourceRef: header.sourceRef, sourceDigest: header.sourceDigest,
      ownerReleaseApprovalRef: header.ownerReleaseApprovalRef, cohortId: header.selected.cohortId,
      taskIds: [...taskIds], window: { startAt: header.selected.window.startAt, endAt: header.selected.window.endAt }, releaseReferenceIsAttestationOnly: true,
    },
    ownerReportedAggregateContext,
    measuredHistoricalBaseline: header.evidenceClass === 'synthetic' ? null : {
      label: 'measured historical', eventCounts, durations,
      repairs: { count: countEvents('repair_submitted').length, taskDenominator: taskIds.length, sourceEventIds: countEvents('repair_submitted').map(e => e.eventId) },
      reviews: { count: countEvents('review_approved').length, taskDenominator: taskIds.length, sourceEventIds: countEvents('review_approved').map(e => e.eventId) },
      landedWork: { count: countEvents('merged').length, taskDenominator: taskIds.length, sourceEventIds: countEvents('merged').map(e => e.eventId) },
      censoredTaskIds: taskIds.filter(id => !terminal.has(id)),
    },
    simulation: header.evidenceClass === 'synthetic' ? null : simulateReplay(data, options),
    syntheticLiveDemoTelemetry: { status: 'separate dataset not supplied', eventCount: null },
    claims: { causalSpeedup: 'not established', fleetWideSavings: 'not estimated' },
  };
}

export interface GithubBaseline {
  taskCount: number;
  mergedCount: number;
  refusedCount: number;
  censoredCount: number;
  openToMerge: { medianMs: number | null; p90Ms: number | null; count: number };
  staleApprovalCount: number;
  supersededCount: number;
  medianReviewRounds: number | null;
  overlapPairCount: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function nearestRank(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

export function buildGithubBaseline(data: ReplayExport): GithubBaseline {
  const taskIds = data.header.selected.taskIds;
  const mergeDurations: number[] = [];
  const roundCounts: number[] = [];
  const supersededTargets = new Set<string>();
  const overlapPairs = new Set<string>();
  let mergedCount = 0;
  let refusedCount = 0;
  let staleApprovalCount = 0;
  for (const taskId of taskIds) {
    const events = data.events.filter(e => e.taskId === taskId);
    const opened = events.find(e => e.type === 'task_started');
    const merged = events.find(e => e.type === 'merged' && e.outcome === 'landed') ?? events.find(e => e.type === 'merged');
    const refused = events.find(e => (e.type === 'task_finished' || e.type === 'task_refused') && e.outcome === 'refused');
    if (merged) mergedCount++;
    else if (refused) refusedCount++;
    if (opened && merged) mergeDurations.push(Date.parse(merged.occurredAt) - Date.parse(opened.occurredAt));
    const reviewTimes = events.filter(e => e.type === 'check_finished').map(e => Date.parse(e.occurredAt));
    roundCounts.push(reviewTimes.length);
    const firstReview = Math.min(...reviewTimes);
    if (Number.isFinite(firstReview) && events.some(e => e.type === 'repair_submitted' && Date.parse(e.occurredAt) > firstReview)) staleApprovalCount++;
    for (const event of events) {
      for (const dep of event.dependencyTaskIds ?? []) supersededTargets.add(dep);
      for (const peer of event.overlapTaskIds ?? []) if (peer !== taskId) overlapPairs.add([taskId, peer].sort().join('|'));
    }
  }
  return {
    taskCount: taskIds.length,
    mergedCount,
    refusedCount,
    censoredCount: taskIds.length - mergedCount - refusedCount,
    openToMerge: { medianMs: median(mergeDurations), p90Ms: nearestRank(mergeDurations, 0.9), count: mergeDurations.length },
    staleApprovalCount,
    supersededCount: supersededTargets.size,
    medianReviewRounds: median(roundCounts),
    overlapPairCount: overlapPairs.size,
  };
}

function formatDurationMs(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 172_800_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function renderGithubBaselineTable(baseline: GithubBaseline, context: { cohortId?: string; window?: { startAt: string; endAt: string } } = {}): string {
  const share = baseline.taskCount === 0 ? 'n/a' : `${baseline.supersededCount}/${baseline.taskCount} (${(baseline.supersededCount / baseline.taskCount * 100).toFixed(1)}%)`;
  const rows: [string, string, number][] = [
    ['pull requests', String(baseline.taskCount), baseline.taskCount],
    ['merged', String(baseline.mergedCount), baseline.taskCount],
    ['closed unmerged', String(baseline.refusedCount), baseline.taskCount],
    ['open at window end (censored)', String(baseline.censoredCount), baseline.taskCount],
    ['median open->merge', formatDurationMs(baseline.openToMerge.medianMs), baseline.openToMerge.count],
    ['p90 open->merge', formatDurationMs(baseline.openToMerge.p90Ms), baseline.openToMerge.count],
    ['head change after first review', String(baseline.staleApprovalCount), baseline.taskCount],
    ['superseded share', share, baseline.taskCount],
    ['median review rounds', baseline.medianReviewRounds === null ? 'n/a' : String(baseline.medianReviewRounds), baseline.taskCount],
    ['overlapping PR pairs', String(baseline.overlapPairCount), baseline.taskCount],
  ];
  const width = Math.max(...rows.map(row => row[0].length));
  const lines = ['GitHub PR-history baseline'];
  if (context.window) lines.push(`window ${context.window.startAt} -> ${context.window.endAt}`);
  if (context.cohortId) lines.push(`cohort ${context.cohortId}`);
  for (const [label, value, denominator] of rows) lines.push(`${label.padEnd(width)}  ${value.padStart(12)}  n=${denominator}`);
  return lines.join('\n');
}

export function unavailableReport(): ReplayReport {
  return {
    status: 'unavailable',
    message: 'Historical comparison unavailable: owner export pending.',
    ownerReportedAggregateContext: 'Owner-reported aggregate context is not an event timeline and is not expanded into metrics.',
    measuredHistoricalBaseline: null,
    simulation: null,
    syntheticLiveDemoTelemetry: { status: 'separate dataset not supplied', eventCount: null },
    claims: { causalSpeedup: 'not established', fleetWideSavings: 'not estimated' },
  };
}

export function renderHtml(report: ReplayReport): string {
  const json = JSON.stringify(report, null, 2).replace(/</g, '\\u003c');
  const title = report.status === 'unavailable' ? report.message : 'Replay comparison report';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;max-width:960px;margin:3rem auto;padding:0 1rem;color:#18212b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:1rem;border-radius:.5rem}.state{font-weight:700}</style><h1>${title}</h1><p class="state">${report.status === 'unavailable' ? 'Unavailable' : 'Historical measurements and simulation are separate datasets.'}</p><p>No causal speedup claim is established.</p><pre>${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></html>`;
}
