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
const metrics = [{ automaticRebases: 2 }, {}, { automaticRebases: 4 }];

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
    expect(row('automaticRebases').concord).toMatchObject({ evidence: 'Measured', median: 3, min: 2, max: 4, n: { replicates: 2 } });
    expect(row('queueWait').concord).toMatchObject({ evidence: 'Measured', value: 'n/a', range: 'n/a', median: null });
    expect(card.rows.every(item => [item.serial, item.concord].every(value => value.evidence && value.n && 'window' in value))).toBe(true);
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
    const mondayHtml = renderAbHtml(withMonday);
    expect(mondayHtml).toContain('Monday (owner log)');
    expect(mondayHtml.match(/class="chip"/g)).toHaveLength(withMonday.rows.length * 3);
    expect(mondayHtml).not.toMatch(/https?:|url\(|<script|<link/i);
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
