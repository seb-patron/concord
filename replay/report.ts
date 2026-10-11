import type { ReplayExport, DurationMetric } from './schema.ts';
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
    Object.entries(header.ownerReportedAggregates).map(([name, aggregate]) => [name, {
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
