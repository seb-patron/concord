import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';

type Evidence = 'Replayed' | 'Charged' | 'Owner log' | 'Measured';
type Window = { startAt: string; endAt: string };
type Counts = { changes: number; replicates: number };
export type CardValue = { evidence: Evidence; value: string; range: string; median: number | null; min: number | null; max: number | null; n: Counts; window: Window | null; note?: string };
export type CardRow = { key: string; label: string; serial: CardValue; concord: CardValue; monday?: CardValue };
export type AbCard = { title: string; rows: CardRow[]; replicates: { serial: number; concord: number }; mondayLabel?: string };
type Sample = { id: string; changes: number; window: Window; values: Record<string, number>; charged: boolean; complete: boolean };
type Obj = Record<string, unknown>;
const keys = ['workerRunsNeeded', 'freshReviewsNeeded', 'conflictsHit', 'mainRedMerges', 'timeToGreenMinutes'] as const;
const labels: Record<string, string> = {
  workerRunsNeeded: 'Worker runs needed', freshReviewsNeeded: 'Fresh reviews needed', conflictsHit: 'Conflicts hit',
  mainRedMerges: 'Main red merges', timeToGreenMinutes: 'Time to green (minutes)',
  automaticRebases: 'Automatic rebases', approvalsCarriedByPatchId: 'Approvals carried by patch ID',
  combinedTreeCheckFailures: 'Combined tree check failures', bisectBlames: 'Bisect blames', mainRedTime: 'Main red time',
  publishToLand: 'Publish to land', queueWait: 'Queue wait',
};
const metricKeys = ['automaticRebases', 'approvalsCarriedByPatchId', 'combinedTreeCheckFailures', 'bisectBlames', 'mainRedTime', 'publishToLand', 'queueWait'] as const;
const sha = /^[a-f0-9]{40}$/i;

function bad(message: string): never { throw new Error(`A/B report input: ${message}`); }
function object(value: unknown, where: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(`${where} must be an object`);
  return value as Obj;
}
function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) bad(`${where} must be an array`);
  return value;
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) bad(`${where} must be a nonempty string`);
  return value as string;
}
function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) bad(`${where} must be a nonnegative integer`);
  return value as number;
}
function minutes(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) bad(`${where} must be a nonnegative number`);
  return value as number;
}
function instant(value: unknown, where: string): string {
  const s = string(value, where);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s) || !Number.isFinite(Date.parse(s))) bad(`${where} must be an ISO UTC timestamp`);
  return s;
}
function window(start: unknown, end: unknown, where: string): Window {
  const startAt = instant(start, `${where}.start`);
  const endAt = instant(end, `${where}.end`);
  if (Date.parse(endAt) < Date.parse(startAt)) bad(`${where} ends before it starts`);
  return { startAt, endAt };
}
function format(value: number): string { return String(Number(value.toFixed(3))); }
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function joinedWindow(samples: { window: Window }[]): Window | null {
  if (!samples.length) return null;
  return {
    startAt: samples.reduce((first, sample) => Date.parse(sample.window.startAt) < Date.parse(first) ? sample.window.startAt : first, samples[0].window.startAt),
    endAt: samples.reduce((last, sample) => Date.parse(sample.window.endAt) > Date.parse(last) ? sample.window.endAt : last, samples[0].window.endAt),
  };
}
function aggregate(samples: Sample[], key: string, evidence: Evidence): CardValue {
  const nums = samples.map(s => s.values[key]);
  const mid = median(nums), min = Math.min(...nums), max = Math.max(...nums);
  const isCount = key !== 'timeToGreenMinutes';
  const denominators = samples.map(s => s.changes);
  const denominator = median(denominators);
  const commonDenominator = denominators.every(n => n === denominator);
  const suffix = isCount && commonDenominator ? ` of ${format(denominator)}` : '';
  return {
    evidence, value: `${format(mid)}${suffix}`,
    range: `${format(min)}–${format(max)}${suffix}`,
    median: mid, min, max, n: { changes: denominators.reduce((a, b) => a + b, 0), replicates: samples.length },
    window: joinedWindow(samples),
    ...(!commonDenominator && isCount ? { note: `Replicate denominators: ${denominators.join(', ')}` } : {}),
  };
}
function unavailable(evidence: Evidence, n: Counts, windowValue: Window | null, note?: string): CardValue {
  return { evidence, value: 'n/a', range: 'n/a', median: null, min: null, max: null, n, window: windowValue, ...(note ? { note } : {}) };
}
function serialSample(raw: unknown, index: number): Sample {
  const root = object(raw, `serial ${index}`);
  if (root.schemaVersion !== 1 || root.arm !== 'pr') bad(`serial ${index} must have schemaVersion 1 and arm pr`);
  string(root.batch, `serial ${index}.batch`);
  if (!sha.test(string(root.startCommit, `serial ${index}.startCommit`))) bad(`serial ${index}.startCommit must be 40 hex`);
  string(root.validationCommand, `serial ${index}.validationCommand`);
  const changes = array(root.changes, `serial ${index}.changes`);
  if (!changes.length) bad(`serial ${index}.changes is empty`);
  const ids = new Set<string>();
  for (const [i, rawChange] of changes.entries()) {
    const change = object(rawChange, `serial ${index}.changes[${i}]`);
    const id = string(change.id, `serial ${index}.changes[${i}].id`);
    if (ids.has(id)) bad(`serial ${index} has duplicate change id`);
    ids.add(id);
    string(change.label, `serial ${index}.changes[${i}].label`);
    count(change.order, `serial ${index}.changes[${i}].order`);
    instant(change.mergedAt, `serial ${index}.changes[${i}].mergedAt`);
    if (typeof change.conflict !== 'boolean' || typeof change.usedResolvedHead !== 'boolean' || typeof change.mainRed !== 'boolean') bad(`serial ${index}.changes[${i}] has invalid booleans`);
    array(change.conflictFiles, `serial ${index}.changes[${i}].conflictFiles`).forEach(file => string(file, 'conflictFiles item'));
    minutes(change.chargedMinutes, `serial ${index}.changes[${i}].chargedMinutes`);
    const validation = object(change.validation, `serial ${index}.changes[${i}].validation`);
    count(validation.exitCode, 'validation.exitCode');
    count(validation.durationMs, 'validation.durationMs');
  }
  const totals = object(root.totals, `serial ${index}.totals`);
  for (const key of ['conflicts', 'mainRedMerges', 'workerRunsCharged', 'freshReviewsCharged'] as const) count(totals[key], `serial ${index}.totals.${key}`);
  minutes(totals.chargedMinutes, `serial ${index}.totals.chargedMinutes`);
  minutes(totals.timeToGreenMs, `serial ${index}.totals.timeToGreenMs`);
  return {
    id: `${index}`, changes: changes.length, window: window(root.startedAt, root.finishedAt, `serial ${index}`),
    charged: (totals.chargedMinutes as number) > 0, complete: true,
    values: { workerRunsNeeded: changes.length + (totals.workerRunsCharged as number), freshReviewsNeeded: changes.length + (totals.freshReviewsCharged as number),
      conflictsHit: totals.conflicts as number, mainRedMerges: totals.mainRedMerges as number, timeToGreenMinutes: (totals.timeToGreenMs as number) / 60000 },
  };
}
type Charge = { rebaseRunMinutes: number; reviewMinutes: number };
function manifestCharges(raw: unknown): Map<string, Charge> {
  const root = object(raw, 'manifest');
  if (root.schemaVersion !== 1) bad('manifest.schemaVersion must be 1');
  string(root.batch, 'manifest.batch');
  if (!sha.test(string(root.startCommit, 'manifest.startCommit'))) bad('manifest.startCommit must be 40 hex');
  string(root.validationCommand, 'manifest.validationCommand');
  const charges = new Map<string, Charge>();
  for (const [i, item] of array(root.changes, 'manifest.changes').entries()) {
    const change = object(item, `manifest.changes[${i}]`);
    const id = string(change.id, `manifest.changes[${i}].id`);
    if (charges.has(id)) bad('manifest has duplicate change id');
    string(change.label, 'manifest change label');
    count(change.order, 'manifest change order');
    for (const key of ['base', 'head'] as const) if (!sha.test(string(change[key], `manifest change ${key}`))) bad(`manifest change ${key} must be 40 hex`);
    array(change.dependsOn, 'manifest change dependsOn').forEach(dep => string(dep, 'dependency id'));
    if (change.charge === null) { charges.set(id, { rebaseRunMinutes: 0, reviewMinutes: 0 }); continue; }
    const charge = object(change.charge, 'manifest change charge');
    if (!sha.test(string(charge.resolvedHead, 'manifest charge resolvedHead'))) bad('manifest charge resolvedHead must be 40 hex');
    charges.set(id, { rebaseRunMinutes: minutes(charge.rebaseRunMinutes, 'manifest charge rebaseRunMinutes'), reviewMinutes: minutes(charge.reviewMinutes, 'manifest charge reviewMinutes') });
  }
  return charges;
}
function swarmSample(raw: unknown[], index: number, charges: Map<string, Charge>): Sample {
  if (raw.length < 2) bad(`swarm ${index} needs transitions and a final summary`);
  const summaryLine = object(raw.at(-1), `swarm ${index} final line`);
  instant(summaryLine.at, `swarm ${index} final line.at`);
  const summary = object(summaryLine.summary, `swarm ${index} summary`);
  string(summary.replicate, 'swarm summary.replicate');
  string(summary.repo, 'swarm summary.repo');
  const n = count(summary.landed, 'swarm summary.landed') + count(summary.failed, 'swarm summary.failed');
  if (!n) bad(`swarm ${index} has no changes`);
  const span = window(summary.firstCreatedAt, summary.lastLandedAt, `swarm ${index} summary`);
  const seen = new Set<string>();
  let runs = 0, reviews = 0, conflicts = 0, mainRed = 0, charged = 0;
  for (const [i, line] of raw.slice(0, -1).entries()) {
    const event = object(line, `swarm ${index} line ${i + 1}`);
    const at = instant(event.at, 'swarm transition.at');
    if (Date.parse(at) < Date.parse(span.startAt)) bad(`swarm ${index} transition precedes first creation`);
    string(event.agent, 'swarm transition.agent');
    const changeId = string(event.changeId, 'swarm transition.changeId');
    seen.add(changeId);
    const transition = object(event.transition, 'swarm transition.transition');
    const state = string(transition.state, 'swarm transition.state');
    if (state === 'published') runs++;
    if (state === 'reviewed') reviews++;
    if (state === 'main-red' || transition.code === 'MAIN_RED') mainRed++;
    if (transition.code === 'MERGE_CONFLICT') {
      conflicts++;
      const charge = charges.get(changeId);
      if (charge) charged += charge.rebaseRunMinutes + charge.reviewMinutes;
    }
  }
  if (seen.size > n) bad(`swarm ${index} has more change ids than summary changes`);
  return { id: string(summary.replicate, 'swarm summary.replicate'), changes: n, window: span, charged: charged > 0, complete: summary.failed === 0,
    values: { workerRunsNeeded: runs, freshReviewsNeeded: reviews, conflictsHit: conflicts, mainRedMerges: mainRed,
      timeToGreenMinutes: (Date.parse(span.endAt) - Date.parse(span.startAt)) / 60000 + charged } };
}
function measuredValue(key: string, metrics: Obj[]): CardValue {
  const present = metrics.filter(metric => Object.hasOwn(metric, key));
  if (!present.length) return unavailable('Measured', { changes: 0, replicates: 0 }, null);
  const durations = key === 'publishToLand' || key === 'queueWait';
  const values: number[] = [];
  const p90s: number[] = [];
  let changes = 0;
  const windows: { window: Window }[] = [];
  for (const [i, metric] of present.entries()) {
    const where = `metrics ${i + 1}.${key}`;
    const field = object(metric[key], where);
    const size = count(field.n, `${where}.n`);
    if (!size) bad(`${where}.n must be positive when the metric is present`);
    changes += size;
    windows.push({ window: window(metric.since, metric.until, `metrics ${i + 1}`) });
    if (durations) {
      values.push(minutes(field.medianMs, `${where}.medianMs`));
      p90s.push(minutes(field.p90Ms, `${where}.p90Ms`));
    } else {
      values.push(minutes(field.value, `${where}.value`));
      array(field.eventKinds, `${where}.eventKinds`).forEach(kind => string(kind, `${where}.eventKinds item`));
    }
  }
  const mid = median(values), min = Math.min(...values), max = Math.max(...values);
  const unit = durations || key === 'mainRedTime' ? ' ms' : '';
  return { evidence: 'Measured', value: `${format(mid)}${unit}`, range: `${format(min)}–${format(max)}${unit}`,
    median: mid, min, max, n: { changes, replicates: present.length }, window: joinedWindow(windows),
    ...(durations ? { note: `p90: ${format(median(p90s))} ms${p90s.length > 1 ? ' (median across metric windows)' : ''}` } : {}),
  };
}
export function buildAbCard(serial: unknown[], swarm: unknown[][], metricsRaw: unknown[], mondayRaw?: unknown, manifestRaw?: unknown): AbCard {
  if (!serial.length || !swarm.length || !metricsRaw.length) bad('at least one --serial, --swarm, and --metrics is required');
  if (metricsRaw.length !== 1 && metricsRaw.length !== swarm.length) bad('provide one metrics file or one per swarm replicate');
  const charges = manifestRaw === undefined ? new Map<string, Charge>() : manifestCharges(manifestRaw);
  const serialSamples = serial.map(serialSample);
  const swarmSamples = swarm.map((lines, i) => swarmSample(lines, i + 1, charges));
  const metrics = metricsRaw.map((item, i) => {
    const root = object(item, `metrics ${i + 1}`);
    return Object.hasOwn(root, 'data') ? object(root.data, `metrics ${i + 1}.data`) : root;
  });
  const monday = mondayRaw === undefined ? undefined : object(mondayRaw, 'Monday');
  const mondayRows = monday ? object(monday.rows, 'Monday.rows') : undefined;
  const mondayLabel = monday ? string(monday.label, 'Monday.label') : undefined;
  const rows: CardRow[] = keys.map(key => {
    const serialEvidence = key === 'timeToGreenMinutes' && serialSamples.some(s => s.charged) ? 'Charged' : 'Replayed';
    const concordEvidence = key === 'timeToGreenMinutes' && swarmSamples.some(s => s.charged) ? 'Charged' : 'Replayed';
    const concord = key === 'timeToGreenMinutes' && swarmSamples.some(s => !s.complete)
      ? unavailable(concordEvidence, { changes: swarmSamples.reduce((sum, s) => sum + s.changes, 0), replicates: swarmSamples.length }, joinedWindow(swarmSamples), 'Time to green unavailable: one or more changes failed')
      : aggregate(swarmSamples, key, concordEvidence);
    return { key, label: labels[key], serial: aggregate(serialSamples, key, serialEvidence), concord };
  });
  for (const key of metricKeys) rows.push({ key, label: labels[key], serial: unavailable('Measured', { changes: 0, replicates: 0 }, null),
    concord: measuredValue(key, metrics) });
  if (mondayRows) for (const row of rows) {
    const entry = mondayRows[row.key];
    if (entry === undefined) { row.monday = unavailable('Owner log', { changes: 0, replicates: 0 }, null); continue; }
    const item = object(entry, `Monday.rows.${row.key}`);
    if (!Object.hasOwn(item, 'value')) bad(`Monday.rows.${row.key}.value is required`);
    const value = typeof item.value === 'string' || typeof item.value === 'number' ? String(item.value) : bad(`Monday.rows.${row.key}.value must be string or number`);
    const note = item.note === undefined ? undefined : string(item.note, `Monday.rows.${row.key}.note`);
    row.monday = { evidence: 'Owner log', value, range: 'n/a', median: null, min: null, max: null,
      n: { changes: 0, replicates: 1 }, window: null, ...(note ? { note } : {}) };
  }
  return { title: 'Replay A/B report', rows, replicates: { serial: serial.length, concord: swarm.length }, ...(mondayLabel ? { mondayLabel } : {}) };
}
function escape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function cell(value: CardValue): string {
  const span = value.window ? `${value.window.startAt} → ${value.window.endAt}` : 'n/a';
  return `<td><span class="chip">${escape(value.evidence)}</span><strong>${escape(value.value)}</strong><small>range ${escape(value.range)} · n ${value.n.changes} changes, ${value.n.replicates} replicates · window ${escape(span)}</small>${value.note ? `<small>${escape(value.note)}</small>` : ''}</td>`;
}
export function renderAbHtml(card: AbCard): string {
  const rows = card.rows.map(row => `<tr><th scope="row">${escape(row.label)}</th>${cell(row.serial)}${cell(row.concord)}${row.monday ? cell(row.monday) : ''}</tr>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(card.title)}</title><style>
:root{color-scheme:light dark;font:16px system-ui,sans-serif}body{max-width:1100px;margin:2rem auto;padding:0 1rem;color:CanvasText;background:Canvas}h1{margin-bottom:.3rem}p{color:GrayText}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{border-bottom:1px solid GrayText;padding:1rem;text-align:left;vertical-align:top}thead th{font-weight:700}tbody th{width:19%}td{width:27%}strong{display:block;font-size:1.25rem;margin:.3rem 0}small{display:block;line-height:1.5;color:GrayText}.chip{display:inline-block;border:1px solid currentColor;border-radius:1rem;padding:.1rem .55rem;font-size:.75rem;font-weight:700}
</style><h1>${escape(card.title)}</h1><p>Median and min–max across replicates. Counts are shown as x of N. Each cell names its evidence, sample size, and window.</p><div class="scroll"><table><thead><tr><th scope="col">Measure</th><th scope="col">Serial PR</th><th scope="col">Concord</th>${card.mondayLabel ? `<th scope="col">${escape(card.mondayLabel)}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table></div></html>\n`;
}
function parseArgs(argv: string[]): { serial: string[]; swarm: string[]; metrics: string[]; out: string; monday?: string; manifest?: string } {
  const result: { serial: string[]; swarm: string[]; metrics: string[]; out: string; monday?: string; manifest?: string } = { serial: [], swarm: [], metrics: [], out: '' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i];
    if (!value || value.startsWith('--')) bad(`missing path for ${flag}`);
    if (flag === '--serial') result.serial.push(value);
    else if (flag === '--swarm') result.swarm.push(value);
    else if (flag === '--metrics') result.metrics.push(value);
    else if (flag === '--out' || flag === '--monday' || flag === '--manifest') {
      const key = flag.slice(2) as 'out' | 'monday' | 'manifest';
      if (result[key]) bad(`duplicate ${flag}`);
      result[key] = value;
    } else bad(`unknown option ${flag}`);
  }
  if (!result.out || !['.html', '.json'].includes(extname(result.out).toLowerCase())) bad('--out must end in .html or .json');
  if (!result.serial.length || !result.swarm.length || !result.metrics.length) bad('at least one --serial, --swarm, and --metrics is required');
  return result;
}
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
async function jsonl(path: string): Promise<unknown[]> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(line => line.trim());
  return lines.map((line, i) => { try { return JSON.parse(line) as unknown; } catch { return bad(`${path}:${i + 1} is invalid JSON`); } });
}
export async function runAbReport(argv: string[]): Promise<void> {
  try {
    const args = parseArgs(argv);
    const [serial, swarm, metrics, monday, manifest] = await Promise.all([
      Promise.all(args.serial.map(json)), Promise.all(args.swarm.map(jsonl)), Promise.all(args.metrics.map(json)),
      args.monday ? json(args.monday) : undefined, args.manifest ? json(args.manifest) : undefined,
    ]);
    const card = buildAbCard(serial, swarm, metrics, monday, manifest);
    await writeFile(args.out, extname(args.out).toLowerCase() === '.html' ? renderAbHtml(card) : `${JSON.stringify(card, null, 2)}\n`, 'utf8');
    console.log(`A/B report written to ${args.out}`);
  } catch (error) {
    console.error(`replay: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
