import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReplayJsonl, type ReplayExport, type ReplayEvent, type ReplayHeader } from '../../replay/schema.ts';
import { simulateReplay } from '../../replay/simulate.ts';
import { buildReplayReport, unavailableReport } from '../../replay/report.ts';

const fixturePath = resolve(process.cwd(), 'tests/fixtures/replay-synthetic.jsonl');
async function synthetic(): Promise<ReplayExport> {
  return parseReplayJsonl(await readFile(fixturePath, 'utf8'), { allowSynthetic: true });
}
function historicalData(events: ReplayEvent[]): string {
  const header: ReplayHeader = {
    schemaVersion: 1, exportId: 'owner-export', sourceType: 'pr_history', sourceRef: 'redacted:owner-export',
    sourceDigest: `sha256:${'b'.repeat(64)}`, exportedAt: '2026-01-02T00:00:00Z', anonymizationVersion: 'v1',
    ownerReleaseApprovalRef: 'approval:release-17', selected: {
      cohortId: 'cohort-1', taskIds: ['task-a'], window: { startAt: '2026-01-01T00:00:00Z', endAt: '2026-01-01T00:10:00Z' },
    },
  };
  return [header, ...events].map(item => JSON.stringify(item)).join('\n');
}
const event = (eventId: string, type: ReplayEvent['type'], occurredAt: string, more: Partial<ReplayEvent> = {}): ReplayEvent => ({
  eventId, taskId: 'task-a', unitKeys: ['unit:alpha'], occurredAt, type,
  sourceEventRef: `redacted:${eventId}`, ...more,
});

describe('replay export provenance and report', () => {
  it('rejects synthetic evidence as a real historical baseline', async () => {
    await expect(readFile(fixturePath, 'utf8').then(text => parseReplayJsonl(text))).rejects.toThrow(/Synthetic evidence/);
    expect((await synthetic()).header.evidenceClass).toBe('synthetic');
    expect(unavailableReport().measuredHistoricalBaseline).toBeNull();
    expect(unavailableReport().claims.causalSpeedup).toBe('not established');
  });

  it('rejects missing release provenance, duplicate IDs, placeholder times, and inconsistent units', () => {
    const valid = event('start', 'task_started', '2026-01-01T00:00:00Z');
    expect(() => parseReplayJsonl(historicalData([{ ...valid, sourceEventRef: '' }]))).toThrow(/sourceEventRef/);
    expect(() => parseReplayJsonl(historicalData([valid, valid]))).toThrow(/duplicate eventId/);
    expect(() => parseReplayJsonl(historicalData([event('bad-time', 'task_started', '1970-01-01T00:00:00Z')]))).toThrow(/timestamp/);
    expect(() => parseReplayJsonl(historicalData([event('bad-unit', 'task_started', '2026-01-01T00:00:00Z', { unitKeys: ['private/path'] })]))).toThrow(/unitKeys/);
  });

  it('checks paired duration intervals and explicit duration provenance', () => {
    const start = event('check-start', 'check_started', '2026-01-01T00:00:00Z');
    const end = event('check-end', 'check_finished', '2026-01-01T00:00:01Z');
    const duration = event('check-duration', 'duration_record', '2026-01-01T00:00:02Z', {
      durationMs: 1000, durationMetric: 'checker', durationSource: { kind: 'paired_events', startEventId: 'check-start', endEventId: 'check-end' },
    });
    expect(() => parseReplayJsonl(historicalData([start, end, duration]))).not.toThrow();
    expect(() => parseReplayJsonl(historicalData([end, start, { ...duration, durationMs: 1 }]))).toThrow(/disagrees/);
    expect(() => parseReplayJsonl(historicalData([
      event('late-start', 'check_started', '2026-01-01T00:00:02Z'),
      event('early-end', 'check_finished', '2026-01-01T00:00:01Z'),
      event('negative-interval', 'duration_record', '2026-01-01T00:00:03Z', {
        durationMs: 1000, durationMetric: 'checker', durationSource: { kind: 'paired_events', startEventId: 'late-start', endEventId: 'early-end' },
      }),
    ]))).toThrow(/negative interval/);
    expect(() => parseReplayJsonl(historicalData([event('negative', 'duration_record', '2026-01-01T00:00:02Z', {
      durationMs: -1, durationMetric: 'work', durationSource: { kind: 'source_field', sourceEventRef: 'redacted:duration' },
    })]))).toThrow(/negative/);
  });

  it('accepts nonzero millisecond timestamps and checks paired milliseconds exactly', () => {
    const start = event('millis-start', 'check_started', '2026-01-01T00:00:00.123Z');
    const end = event('millis-end', 'check_finished', '2026-01-01T00:00:00.247Z');
    const duration = event('millis-duration', 'duration_record', '2026-01-01T00:00:00.247Z', {
      durationMs: 124, durationMetric: 'checker', durationSource: { kind: 'paired_events', startEventId: 'millis-start', endEventId: 'millis-end' },
    });
    expect(() => parseReplayJsonl(historicalData([start, end, duration]))).not.toThrow();
    expect(() => parseReplayJsonl(historicalData([start, end, { ...duration, durationMs: 123 }]))).toThrow(/disagrees/);
  });

  it('rejects unchecked owner aggregate fields and omits them from a report', () => {
    const privateAggregate = { value: 2, sourceRef: 'redacted:aggregate', rawChat: 'PRIVATE CHAT CONTENT' };
    const data = parseReplayJsonl(historicalData([event('start', 'task_started', '2026-01-01T00:00:00Z')]));
    data.header.ownerReportedAggregates = { throughput: privateAggregate };
    const [header, ...events] = historicalData(data.events).split('\n');
    expect(() => parseReplayJsonl([JSON.stringify({ ...JSON.parse(header), ownerReportedAggregates: data.header.ownerReportedAggregates }), ...events].join('\n'))).toThrow(/aggregate.*field|unknown.*field/i);
    expect(JSON.stringify(buildReplayReport(data))).not.toContain('PRIVATE CHAT CONTENT');
    const privateWindow = { ...data.header.selected.window, rawChat: 'PRIVATE WINDOW CONTENT' };
    data.header.selected.window = privateWindow;
    expect(JSON.stringify(buildReplayReport(data))).not.toContain('PRIVATE WINDOW CONTENT');
  });

  it('models every recorded checker duration including a recheck', () => {
    const events = [
      event('work', 'duration_record', '2026-01-01T00:00:00.010Z', { durationMs: 10, durationMetric: 'work', durationSource: { kind: 'source_field', sourceEventRef: 'redacted:work' } }),
      event('check-1', 'duration_record', '2026-01-01T00:00:00.060Z', { durationMs: 50, durationMetric: 'checker', durationSource: { kind: 'source_field', sourceEventRef: 'redacted:check-1' } }),
      event('recheck', 'recheck_requested', '2026-01-01T00:00:00.070Z'),
      event('check-2', 'duration_record', '2026-01-01T00:00:00.190Z', { durationMs: 120, durationMetric: 'checker', durationSource: { kind: 'source_field', sourceEventRef: 'redacted:check-2' } }),
    ];
    const data = parseReplayJsonl(historicalData(events));
    expect(buildReplayReport(data).measuredHistoricalBaseline?.durations.checker.valueMs).toBe(170);
    expect(simulateReplay(data, { workerCapacity: 1, checkerCapacity: 1 }).tasks[0]).toMatchObject({
      status: 'simulated', checkerStartMs: 10, checkerFinishMs: 180,
    });
  });

  it('marks recheck timing unknown when its duration is missing', () => {
    const data = parseReplayJsonl(historicalData([
      event('work', 'duration_record', '2026-01-01T00:00:00Z', { durationMs: 10, durationMetric: 'work', durationSource: { kind: 'source_field', sourceEventRef: 'redacted:work' } }),
      event('check', 'duration_record', '2026-01-01T00:00:01Z', { durationMs: 50, durationMetric: 'checker', durationSource: { kind: 'source_field', sourceEventRef: 'redacted:check' } }),
      event('recheck', 'recheck_requested', '2026-01-01T00:00:02Z'),
    ]));
    const result = simulateReplay(data);
    expect(result.tasks[0]).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/recheck/) });
    expect(result.makespanMs).toBeNull();
  });

  it('censors a finished task without an explicit known outcome', () => {
    const data = parseReplayJsonl(historicalData([
      event('finished', 'task_finished', '2026-01-01T00:00:01Z'),
    ]));
    expect(buildReplayReport(data).measuredHistoricalBaseline?.censoredTaskIds).toEqual(['task-a']);
  });

  it('reproduces a hand-computable bounded schedule and preserves unknown outcomes', async () => {
    const result = simulateReplay(await synthetic(), { workerCapacity: 2, checkerCapacity: 1 });
    expect(result.label).toBe('simulated');
    expect(result.tasks.map(t => [t.taskId, t.workStartMs, t.workFinishMs, t.checkerStartMs, t.checkerFinishMs, t.outcome])).toEqual([
      ['task-a', 0, 100, 100, 150, 'landed'], ['task-b', 0, 100, 150, 200, 'unknown'],
    ]);
    expect(result.makespanMs).toBe(200);
  });

  it('censors incomplete tasks, retains source IDs and distinguishes unavailable from zero', async () => {
    const data = await synthetic();
    const historical = { ...data, header: { ...data.header, evidenceClass: 'historical' as const } };
    const report = buildReplayReport(historical);
    expect(report.measuredHistoricalBaseline?.durations.checker).toMatchObject({ valueMs: 100, measuredCount: 2, selectedTaskDenominator: 2 });
    expect(report.measuredHistoricalBaseline?.landedWork).toEqual({ count: 1, taskDenominator: 2, sourceEventIds: ['a-landed'] });
    expect(report.measuredHistoricalBaseline?.censoredTaskIds).toEqual(['task-b']);
    expect(report.simulation?.tasks[1]).toMatchObject({ status: 'simulated', outcome: 'unknown' });
    const incomplete = { ...historical, events: historical.events.filter(e => e.taskId === 'task-a') };
    const incompleteReport = buildReplayReport(incomplete);
    expect(incompleteReport.measuredHistoricalBaseline?.durations.work.missingTaskIds).toEqual(['task-b']);
    expect(incompleteReport.measuredHistoricalBaseline?.censoredTaskIds).toEqual(['task-b']);
    expect(unavailableReport().measuredHistoricalBaseline).toBeNull();
    expect(unavailableReport().status).toBe('unavailable');
  });
});
