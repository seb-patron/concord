import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildAbCard, renderAbHtml } from '../../replay/ab-report.ts';

const oid = 'a'.repeat(40);
const start = '2026-10-12T00:00:00Z';
const at = (minutes: number) => new Date(Date.parse(start) + minutes * 60000).toISOString();
const manifest = { schemaVersion: 1, batch: 'P', startCommit: oid, validationCommand: 'sh scripts/validate.sh', changes: [
  { id: 'X1', label: 'X1', order: 1, base: oid, head: oid, dependsOn: [], charge: { resolvedHead: oid, rebaseRunMinutes: 2, reviewMinutes: 3 } },
] };
function serial(conflicts: number, duration: number) {
  return { schemaVersion: 1, arm: 'pr', batch: 'P', startCommit: oid, validationCommand: 'sh scripts/validate.sh',
    startedAt: start, finishedAt: at(duration), changes: ['X1', 'X2'].map((id, i) => ({
      id, label: id, order: i + 1, mergedAt: at(duration), conflict: i < conflicts, conflictFiles: [],
      usedResolvedHead: false, chargedMinutes: 0, validation: { exitCode: 0, durationMs: 1 }, mainRed: false,
    })), totals: { conflicts, mainRedMerges: 0, workerRunsCharged: conflicts, freshReviewsCharged: 0,
      chargedMinutes: 0, timeToGreenMs: duration * 60000 } };
}
function swarm(replicate: number, conflicts: number, duration: number) {
  const lines: unknown[] = [];
  for (let i = 0; i < 4 + replicate; i++) lines.push({ at: at(1), agent: 'a1', changeId: i % 2 ? 'X2' : 'X1', transition: { state: 'published' } });
  for (let i = 0; i < 2; i++) lines.push({ at: at(2), agent: 'a1', changeId: i ? 'X2' : 'X1', transition: { state: 'reviewed' } });
  for (let i = 0; i < conflicts; i++) lines.push({ at: at(3), agent: 'a1', changeId: 'X1', transition: { state: 'failed', code: 'MERGE_CONFLICT' } });
  lines.push({ at: at(duration), summary: { replicate: `r${replicate}`, repo: 'repo-1', firstCreatedAt: start, lastLandedAt: at(duration), landed: 2, failed: 0 } });
  return lines;
}
const serials = [serial(0, 30), serial(2, 40)];
const swarms = [swarm(0, 0, 15), swarm(1, 1, 20), swarm(2, 2, 25)];
const metrics = [
  { since: start, until: at(15), automaticRebases: { value: 2, n: 2, eventKinds: ['rebase'] } },
  {},
  { since: at(1), until: at(25), automaticRebases: { value: 4, n: 2, eventKinds: ['rebase'] } },
];

describe('replay A/B report', () => {
  it('computes replicate medians, ranges, sample sizes and charge-derived time', () => {
    const card = buildAbCard(serials, swarms, metrics, undefined, manifest);
    const row = (key: string) => card.rows.find(item => item.key === key)!;
    expect(card.replicates).toEqual({ serial: 2, concord: 3 });
    expect(row('conflictsHit').serial).toMatchObject({ value: '1 of 2', range: '0–2 of 2', median: 1, n: { changes: 4, replicates: 2 } });
    expect(row('conflictsHit').concord).toMatchObject({ value: '1 of 2', range: '0–2 of 2', evidence: 'Replayed', n: { changes: 6, replicates: 3 } });
    expect(row('timeToGreenMinutes').serial).toMatchObject({ median: 35, min: 30, max: 40, evidence: 'Replayed' });
    expect(row('timeToGreenMinutes').concord).toMatchObject({ median: 25, min: 15, max: 35, evidence: 'Charged' });
    expect(row('workerRunsNeeded').concord.median).toBe(5);
    expect(row('workerRunsNeeded').serial.median).toBe(3);
    expect(row('workerRunsNeeded').concord.evidence).toBe('Replayed');
    expect(row('automaticRebases').concord).toMatchObject({ evidence: 'Measured', median: 3, min: 2, max: 4, n: { changes: 4, replicates: 2 }, window: { startAt: start, endAt: at(25) } });
    expect(row('queueWait').concord).toMatchObject({ evidence: 'Measured', value: 'n/a', range: 'n/a', median: null });
    expect(card.rows.every(item => [item.serial, item.concord].every(value => value.evidence && value.n && 'window' in value))).toBe(true);
  });

  it('reads documented count and latency metric objects, including a CLI data wrapper', () => {
    const since = '2026-10-11T23:59:59Z';
    const until = '2026-10-12T00:30:00Z';
    const card = buildAbCard([serials[0]], [swarms[0]], [{ data: {
      since, until,
      automaticRebases: { value: 2, n: 2, eventKinds: ['lease.rebased'] },
      publishToLand: { medianMs: 120000, p90Ms: 180000, n: 2 },
      queueWait: { medianMs: 1000, p90Ms: 2000, n: 2 },
    } }]);
    const row = (key: string) => card.rows.find(item => item.key === key)!.concord;
    expect(row('automaticRebases')).toMatchObject({ value: '2', range: '2–2', median: 2, n: { changes: 2, replicates: 1 }, window: { startAt: since, endAt: until } });
    expect(row('publishToLand')).toMatchObject({ value: '120000 ms', range: '120000–120000 ms', median: 120000, n: { changes: 2, replicates: 1 }, window: { startAt: since, endAt: until }, note: 'p90: 180000 ms' });
    expect(row('queueWait')).toMatchObject({ median: 1000, note: 'p90: 2000 ms' });
    expect(() => buildAbCard([serials[0]], [swarms[0], swarms[1]], [
      { since, until, queueWait: { medianMs: 1, p90Ms: 1e308, n: 2 } },
      { since, until, queueWait: { medianMs: 1, p90Ms: 1e308, n: 2 } },
    ])).toThrow(/queueWait\.p90Ms median/);
    for (const invalid of [2, { value: 2 }, { value: 2, n: 2, eventKinds: 'rebase' }]) {
      expect(() => buildAbCard([serials[0]], [swarms[0]], [{ since, until, automaticRebases: invalid }])).toThrow(/automaticRebases/);
    }
    expect(() => buildAbCard([serials[0]], [swarms[0]], [{ since, until, publishToLand: { medianMs: 120000, n: 2 } }])).toThrow(/p90Ms/);
  });

  it('combines fractional timestamp windows by instant rather than spelling', () => {
    const later = structuredClone(swarms[0]) as ReturnType<typeof swarm>;
    const earlier = structuredClone(swarms[0]) as ReturnType<typeof swarm>;
    const laterSummary = (later.at(-1) as { summary: Record<string, unknown> }).summary;
    const earlierSummary = (earlier.at(-1) as { summary: Record<string, unknown> }).summary;
    laterSummary.firstCreatedAt = '2026-10-12T00:00:00.500Z';
    laterSummary.lastLandedAt = '2026-10-12T00:00:01.500Z';
    (later.at(-1) as { at: string }).at = '2026-10-12T00:00:01.500Z';
    for (const line of later.slice(0, -1) as { at: string }[]) line.at = '2026-10-12T00:00:01Z';
    earlierSummary.firstCreatedAt = '2026-10-12T00:00:00Z';
    earlierSummary.lastLandedAt = '2026-10-12T00:00:01Z';
    (earlier.at(-1) as { at: string }).at = '2026-10-12T00:00:01Z';
    for (const line of earlier.slice(0, -1) as { at: string }[]) line.at = '2026-10-12T00:00:00.500Z';
    const card = buildAbCard([serials[0]], [earlier, later], [{}]);
    expect(card.rows.find(row => row.key === 'workerRunsNeeded')!.concord.window).toEqual({ startAt: start, endAt: '2026-10-12T00:00:01.500Z' });
  });

  it('leaves time to green unavailable when any swarm change failed', () => {
    const failed = structuredClone(swarms[0]) as ReturnType<typeof swarm>;
    (failed.at(-1) as { summary: Record<string, unknown> }).summary = {
      ...(failed.at(-1) as { summary: Record<string, unknown> }).summary, landed: 1, failed: 1,
    };
    const card = buildAbCard([serials[0]], [failed], [{}]);
    expect(card.rows.find(row => row.key === 'timeToGreenMinutes')!.concord).toMatchObject({ value: 'n/a', median: null, range: 'n/a', note: expect.stringContaining('failed') });
    expect(card.rows.find(row => row.key === 'workerRunsNeeded')!.concord.median).toBe(4);
  });

  it('renders losses equally, with labels on every value, optional Monday, and no network references', () => {
    const plain = buildAbCard(serials, swarms, metrics, undefined, manifest);
    const html = renderAbHtml(plain);
    expect(html).toContain('Worker runs needed');
    expect(html).toContain('5 of 2');
    expect(html).toContain('3 of 2');
    expect(html).not.toContain('Owner log');
    expect(html).not.toMatch(/https?:|url\(|<script|<link/i);
    const withMonday = buildAbCard(serials, swarms, metrics, { label: 'Monday (owner log)', rows: { workerRunsNeeded: { value: '6 of 2', note: 'owner count' } } }, manifest);
    expect(withMonday.rows.find(row => row.key === 'workerRunsNeeded')?.monday).toMatchObject({ evidence: 'Owner log', value: '6 of 2', note: 'owner count' });
    expect(withMonday.rows.find(row => row.key === 'queueWait')?.monday?.value).toBe('n/a');
    expect(() => buildAbCard([serials[0]], [swarms[0]], [{}], {
      label: 'Monday', rows: { workerRunsNeeded: { value: 1e999 } },
    })).toThrow(/Monday\.rows\.workerRunsNeeded\.value must be finite/);
    const mondayHtml = renderAbHtml(withMonday);
    expect(mondayHtml).toContain('Monday (owner log)');
    expect(mondayHtml.match(/class="chip"/g)).toHaveLength(withMonday.rows.length * 3);
    expect(mondayHtml).not.toMatch(/https?:|url\(|<script|<link/i);
  });

  it('labels metric sample counts and rejects invalid classes through the CLI', async () => {
    const sampled = buildAbCard([serial(0, 30)], [swarm(0, 0, 15)], [
      { since: start, until: at(15), automaticRebases: { value: 3, n: 10, eventKinds: ['rebase'] } },
    ]);
    const html = renderAbHtml(sampled);
    expect(html).toContain('n 10 samples');
    expect(html).not.toContain('n 10 changes');
    expect(html).toContain('n 2 changes, 1 replicates');

    const dir = await mkdtemp(join(process.env.DELEGATE_SCRATCH_DIR ?? tmpdir(), 'replay-ab-invalid-'));
    type Fixture = { serial: unknown; swarm: unknown[]; metrics: unknown; manifest: unknown; serialText?: string };
    const base = (): Fixture => ({ serial: serial(0, 30), swarm: swarm(0, 0, 15), metrics: {}, manifest: structuredClone(manifest) });
    const cases: { name: string; field: RegExp; mutate: (fixture: Fixture) => void }[] = [
      { name: 'cross-batch identity', field: /manifest\.batch/, mutate: f => { (f.manifest as { batch: string }).batch = 'Q'; } },
      { name: 'manifest id outside cohort', field: /manifest change id "Y" is not in the serial cohort/, mutate: f => {
        (f.manifest as { changes: unknown[] }).changes.push({ id: 'Y', label: 'Y', order: 3, base: oid, head: oid, dependsOn: [], charge: null });
      } },
      { name: 'unknown swarm cohort id', field: /changeId "Y" is not in the serial cohort/, mutate: f => { f.swarm.splice(-1, 0, { at: at(3), agent: 'a1', changeId: 'Y', transition: { state: 'failed', code: 'MERGE_CONFLICT' } }); } },
      { name: 'summary count differs from cohort', field: /summary change count 3 does not match the serial cohort size 2/, mutate: f => {
        ((f.swarm.at(-1) as { summary: { landed: number } }).summary).landed = 3;
      } },
      { name: 'overflow charge sum', field: /charge sum for X1 must be finite/, mutate: f => {
        const charge = (f.manifest as { changes: { charge: Record<string, unknown> }[] }).changes[0].charge;
        charge.rebaseRunMinutes = 1e308; charge.reviewMinutes = 1e308;
        f.swarm.splice(-1, 0, { at: at(3), agent: 'a1', changeId: 'X1', transition: { state: 'failed', code: 'MERGE_CONFLICT' } });
      } },
      { name: 'non-finite JSON number', field: /changes\[0\]\.chargedMinutes must be a nonnegative number/, mutate: f => {
        f.serialText = JSON.stringify(f.serial).replace('"chargedMinutes":0', '"chargedMinutes":1e999');
      } },
      { name: 'negative count', field: /totals\.conflicts must be a nonnegative integer/, mutate: f => { (f.serial as { totals: { conflicts: number } }).totals.conflicts = -1; } },
      { name: 'fractional metric count', field: /automaticRebases\.value must be a nonnegative integer/, mutate: f => { f.metrics = { since: start, until: at(15), automaticRebases: { value: 2.5, n: 2, eventKinds: [] } }; } },
      { name: 'calendar-invalid timestamp', field: /startedAt must be a real calendar instant/, mutate: f => { (f.serial as { startedAt: string }).startedAt = '2026-02-30T00:00:00Z'; } },
      { name: 'sub-millisecond timestamp', field: /startedAt must be an ISO UTC timestamp with at most 3 fractional digits/, mutate: f => { (f.serial as { startedAt: string }).startedAt = '2026-10-12T00:00:00.0001Z'; } },
      { name: 'distinct sub-millisecond timestamp', field: /startedAt must be an ISO UTC timestamp with at most 3 fractional digits/, mutate: f => { (f.serial as { startedAt: string }).startedAt = '2026-10-12T00:00:00.0009Z'; } },
      { name: 'event after window', field: /is after summary\.lastLandedAt/, mutate: f => { f.swarm.splice(-1, 0, { at: at(30), agent: 'a1', changeId: 'X1', transition: { state: 'published' } }); } },
    ];
    try {
      for (const [i, item] of cases.entries()) {
        const fixture = base(); item.mutate(fixture);
        const serialPath = join(dir, `serial-${i}.json`);
        await writeFile(serialPath, fixture.serialText ?? JSON.stringify(fixture.serial));
        const swarmPath = join(dir, `swarm-${i}.jsonl`);
        await writeFile(swarmPath, fixture.swarm.map(line => JSON.stringify(line)).join('\n'));
        const metricsPath = join(dir, `metrics-${i}.json`);
        await writeFile(metricsPath, JSON.stringify(fixture.metrics));
        const manifestPath = join(dir, `manifest-${i}.json`);
        await writeFile(manifestPath, JSON.stringify(fixture.manifest));
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'replay/main.ts', 'ab-report', '--serial', serialPath,
          '--swarm', swarmPath, '--metrics', metricsPath, '--manifest', manifestPath, '--out', join(dir, `card-${i}.json`)],
        { cwd: process.cwd(), encoding: 'utf8' });
        expect(result.status, `${item.name}: ${result.stderr}`).toBe(2);
        expect(result.stderr, item.name).toMatch(item.field);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('writes JSON and HTML from repeated flags, and exits 2 for invalid schema', async () => {
    const dir = await mkdtemp(join(process.env.DELEGATE_SCRATCH_DIR ?? tmpdir(), 'replay-ab-'));
    try {
      const files = { serial: [] as string[], swarm: [] as string[], metrics: [] as string[] };
      for (const [group, values] of [['serial', serials], ['swarm', swarms], ['metrics', metrics]] as const) {
        for (const [i, value] of values.entries()) {
          const path = join(dir, `${group}-${i}.${group === 'swarm' ? 'jsonl' : 'json'}`);
          await writeFile(path, group === 'swarm' ? (value as unknown[]).map(line => JSON.stringify(line)).join('\n') : JSON.stringify(value));
          files[group].push(path);
        }
      }
      const manifestPath = join(dir, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      const run = (out: string, firstSerial = files.serial[0]) => spawnSync(process.execPath,
        ['--import', 'tsx', 'replay/main.ts', 'ab-report', '--serial', firstSerial, '--serial', files.serial[1],
          ...files.swarm.flatMap(path => ['--swarm', path]), ...files.metrics.flatMap(path => ['--metrics', path]),
          '--manifest', manifestPath, '--out', out], { cwd: process.cwd(), encoding: 'utf8' });
      const jsonPath = join(dir, 'card.json');
      expect(run(jsonPath).status).toBe(0);
      expect(JSON.parse(await readFile(jsonPath, 'utf8')).replicates).toEqual({ serial: 2, concord: 3 });
      const htmlPath = join(dir, 'card.html');
      expect(run(htmlPath).status).toBe(0);
      expect(await readFile(htmlPath, 'utf8')).not.toMatch(/https?:|url\(|<script|<link/i);
      const invalid = join(dir, 'invalid.json');
      await writeFile(invalid, JSON.stringify({ ...serials[0], schemaVersion: 2 }));
      const result = run(join(dir, 'invalid-card.json'), invalid);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('schemaVersion');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
