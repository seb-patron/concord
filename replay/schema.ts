export type SourceType = 'dbos_export' | 'pr_history';
export type EventType =
  | 'task_started' | 'claim_attempted' | 'claim_granted' | 'review_approved'
  | 'conflict_observed' | 'recheck_requested' | 'check_started' | 'check_finished'
  | 'repair_submitted' | 'merged' | 'task_finished' | 'task_refused' | 'duration_record';
export type DurationMetric = 'wait' | 'checker' | 'work';

export interface ReplayHeader {
  schemaVersion: 1;
  exportId: string;
  sourceType: SourceType;
  sourceRef: string;
  sourceDigest: string;
  exportedAt: string;
  anonymizationVersion: string;
  ownerReleaseApprovalRef: string;
  evidenceClass?: 'historical' | 'synthetic';
  selected: {
    cohortId: string;
    taskIds: string[];
    window: { startAt: string; endAt: string };
  };
  ownerReportedAggregates?: Record<string, { value: number | null; denominator?: number | null; sourceRef: string }>;
}

export interface ReplayEvent {
  eventId: string;
  taskId: string;
  unitKeys: string[];
  occurredAt: string;
  type: EventType;
  sourceEventRef: string;
  durationMs?: number;
  durationMetric?: DurationMetric;
  durationSource?:
    | { kind: 'paired_events'; startEventId: string; endEventId: string }
    | { kind: 'source_field'; sourceEventRef: string };
  overlapTaskIds?: string[];
  dependencyTaskIds?: string[];
  outcome?: 'landed' | 'refused' | 'unknown';
}

export interface ReplayExport { header: ReplayHeader; events: ReplayEvent[] }

const eventTypes = new Set<EventType>([
  'task_started', 'claim_attempted', 'claim_granted', 'review_approved', 'conflict_observed',
  'recheck_requested', 'check_started', 'check_finished', 'repair_submitted', 'merged',
  'task_finished', 'task_refused', 'duration_record',
]);
const metrics = new Set<DurationMetric>(['wait', 'checker', 'work']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  const normalized = value.replace(/\.\d+Z$/, 'Z');
  return Number.isFinite(date.getTime()) && date.toISOString().replace('.000Z', 'Z') === normalized &&
    !/^(1970-01-01|2000-01-01|9999-12-31)T/.test(normalized);
}
function redacted(value: unknown): value is string {
  return nonempty(value) && /^(redacted:|https:\/\/[^/]+\/redacted\/)/i.test(value) && !/(token|secret|password|@)/i.test(value);
}

export function parseReplayJsonl(text: string, options: { allowSynthetic?: boolean } = {}): ReplayExport {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) throw new Error('JSONL must contain one header and at least one event');
  let parsed: unknown[];
  try { parsed = lines.map(line => JSON.parse(line) as unknown); }
  catch { throw new Error('JSONL contains invalid JSON'); }
  const first = parsed[0];
  if (!record(first)) throw new Error('First JSONL record must be the export header');
  const h = first as unknown as ReplayHeader;
  if (h.schemaVersion !== 1 || !nonempty(h.exportId)) throw new Error('Header requires schemaVersion 1 and exportId');
  if (h.sourceType !== 'dbos_export' && h.sourceType !== 'pr_history') throw new Error('sourceType must be dbos_export or pr_history');
  if (!redacted(h.sourceRef)) throw new Error('sourceRef must be an explicitly redacted reference');
  if (!/^sha256:[a-f0-9]{64}$/i.test(h.sourceDigest)) throw new Error('sourceDigest must be a SHA-256 digest');
  if (!utc(h.exportedAt)) throw new Error('exportedAt must be a real UTC timestamp');
  if (!nonempty(h.anonymizationVersion) || !nonempty(h.ownerReleaseApprovalRef)) throw new Error('anonymizationVersion and ownerReleaseApprovalRef are required');
  if (h.evidenceClass !== undefined && h.evidenceClass !== 'historical' && h.evidenceClass !== 'synthetic') throw new Error('evidenceClass must be historical or synthetic');
  if (h.evidenceClass === 'synthetic' && !options.allowSynthetic) throw new Error('Synthetic evidence cannot be used as a historical baseline');
  if (!record(h.selected) || !nonempty(h.selected.cohortId) || !Array.isArray(h.selected.taskIds) || h.selected.taskIds.length === 0 ||
      !record(h.selected.window) || !utc(h.selected.window.startAt) || !utc(h.selected.window.endAt) ||
      Date.parse(h.selected.window.endAt) <= Date.parse(h.selected.window.startAt)) throw new Error('selected cohort and non-empty UTC window are required');
  if (new Set(h.selected.taskIds).size !== h.selected.taskIds.length || h.selected.taskIds.some(id => !nonempty(id))) throw new Error('selected task IDs must be nonempty and unique');
  if (h.ownerReportedAggregates !== undefined) {
    if (!record(h.ownerReportedAggregates)) throw new Error('ownerReportedAggregates must be an object');
    for (const [name, raw] of Object.entries(h.ownerReportedAggregates)) {
      if (!nonempty(name) || !record(raw) || !(raw.value === null || (typeof raw.value === 'number' && Number.isFinite(raw.value))) ||
          (raw.denominator !== undefined && !(raw.denominator === null || (typeof raw.denominator === 'number' && Number.isFinite(raw.denominator) && raw.denominator >= 0))) ||
          !redacted(raw.sourceRef)) throw new Error(`Owner aggregate ${name} requires value, valid denominator, and redacted sourceRef`);
    }
  }

  const events = parsed.slice(1) as ReplayEvent[];
  const ids = new Map<string, ReplayEvent>();
  const selected = new Set(h.selected.taskIds);
  for (const raw of events as unknown[]) {
    if (!record(raw)) throw new Error('Each event must be a JSON object');
    const e = raw as unknown as ReplayEvent;
    if (!nonempty(e.eventId) || ids.has(e.eventId)) throw new Error(`Missing or duplicate eventId: ${String(e.eventId)}`);
    if (!nonempty(e.taskId) || !selected.has(e.taskId)) throw new Error(`Event ${e.eventId} taskId is outside the selected cohort`);
    if (!Array.isArray(e.unitKeys) || e.unitKeys.length === 0 || e.unitKeys.some(k => !nonempty(k) || !/^unit:[A-Za-z0-9_.:-]+$/.test(k))) throw new Error(`Event ${e.eventId} requires anonymized unitKeys`);
    if (!utc(e.occurredAt) || Date.parse(e.occurredAt) < Date.parse(h.selected.window.startAt) || Date.parse(e.occurredAt) > Date.parse(h.selected.window.endAt)) throw new Error(`Event ${e.eventId} has an invalid or out-of-window timestamp`);
    if (!eventTypes.has(e.type)) throw new Error(`Event ${e.eventId} has an unsupported type`);
    if (!redacted(e.sourceEventRef)) throw new Error(`Event ${e.eventId} requires a redacted sourceEventRef`);
    if (e.outcome !== undefined && !['landed', 'refused', 'unknown'].includes(e.outcome)) throw new Error(`Event ${e.eventId} has an invalid outcome`);
    if (e.overlapTaskIds?.some(id => !selected.has(id)) || e.dependencyTaskIds?.some(id => !selected.has(id))) throw new Error(`Event ${e.eventId} semantic evidence references a task outside the cohort`);
    if (e.durationMs !== undefined) {
      if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0) throw new Error(`Event ${e.eventId} has a negative or invalid duration`);
      if (!e.durationMetric || !metrics.has(e.durationMetric) || !record(e.durationSource)) throw new Error(`Event ${e.eventId} duration requires metric and provenance`);
      if (e.durationSource.kind === 'source_field') {
        if (!redacted(e.durationSource.sourceEventRef)) throw new Error(`Event ${e.eventId} duration source is missing`);
      } else if (e.durationSource.kind !== 'paired_events' || !nonempty(e.durationSource.startEventId) || !nonempty(e.durationSource.endEventId)) {
        throw new Error(`Event ${e.eventId} duration requires paired events or an explicit source field`);
      }
    } else if (e.durationMetric !== undefined || e.durationSource !== undefined) throw new Error(`Event ${e.eventId} has incomplete duration provenance`);
    ids.set(e.eventId, e);
  }
  for (const e of events) if (e.durationMs !== undefined && e.durationSource?.kind === 'paired_events') {
    const start = ids.get(e.durationSource.startEventId);
    const end = ids.get(e.durationSource.endEventId);
    if (!start || !end || start.taskId !== e.taskId || end.taskId !== e.taskId || start.type === 'duration_record' || end.type === 'duration_record') throw new Error(`Event ${e.eventId} duration pair is missing or belongs to another task`);
    const actual = Date.parse(end.occurredAt) - Date.parse(start.occurredAt);
    if (actual < 0) throw new Error(`Event ${e.eventId} duration has a negative interval`);
    const expectedTypes = e.durationMetric === 'checker' ? ['check_started', 'check_finished'] : e.durationMetric === 'wait' ? ['claim_attempted', 'claim_granted'] : ['task_started', 'task_finished'];
    if (start.type !== expectedTypes[0] || end.type !== expectedTypes[1]) throw new Error(`Event ${e.eventId} duration pair has inconsistent metric event types`);
    if (JSON.stringify([...start.unitKeys].sort()) !== JSON.stringify([...end.unitKeys].sort())) throw new Error(`Event ${e.eventId} duration pair has inconsistent unit keys`);
    if (actual !== e.durationMs) throw new Error(`Event ${e.eventId} duration disagrees with its paired event times`);
  }
  return { header: h, events };
}
