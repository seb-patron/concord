import { execFile as callback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseManifest, type ReplayManifest } from '../../replay/manifest.ts';
import { replaySerial } from '../../replay/serial.ts';

const execFile = promisify(callback);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, timeout: 30_000 });
  return stdout.trim();
}
async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=Replay Test', '-c', 'user.email=replay@test.invalid', 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function fixture(): Promise<{ dir: string; repo: string; manifest: ReplayManifest }> {
  const dir = await mkdtemp(join(tmpdir(), 'replay-serial-test-'));
  temporary.push(dir);
  const repo = join(dir, 'source');
  await git(dir, 'init', '-q', repo);
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await writeFile(join(repo, 'check.txt'), 'ok\n');
  const base = await commit(repo, 'base');

  await git(repo, 'switch', '-q', '-c', 'x1');
  await writeFile(join(repo, 'shared.txt'), 'one\n');
  const x1 = await commit(repo, 'x1');
  await git(repo, 'switch', '-q', '-c', 'x2', base);
  await writeFile(join(repo, 'second.txt'), 'two\n');
  const x2 = await commit(repo, 'x2');
  await git(repo, 'switch', '-q', '-c', 'x3', base);
  await writeFile(join(repo, 'shared.txt'), 'three\n');
  const x3 = await commit(repo, 'x3');

  await git(repo, 'switch', '-q', '-c', 'resolved', x1);
  await git(repo, '-c', 'user.name=Replay Test', '-c', 'user.email=replay@test.invalid', 'merge', '-q', '-s', 'ours', '--no-ff', '-m', 'integrate x3', x3);
  await writeFile(join(repo, 'shared.txt'), 'one and three\n');
  const resolvedHead = await commit(repo, 'resolve x3');

  await git(repo, 'switch', '-q', '-c', 'x4', base);
  await writeFile(join(repo, 'check.txt'), 'broken\n');
  const x4 = await commit(repo, 'x4');
  const manifest = parseManifest(JSON.stringify({
    schemaVersion: 1, batch: 'P', startCommit: base, validationCommand: 'test "$(cat check.txt)" = ok',
    changes: [
      { id: 'X1', label: 'First', order: 1, base, head: x1, dependsOn: [], charge: null },
      { id: 'X2', label: 'Second', order: 2, base, head: x2, dependsOn: [], charge: null },
      { id: 'X3', label: 'Conflict', order: 3, base, head: x3, dependsOn: ['X1'], charge: { resolvedHead, rebaseRunMinutes: 12.5, reviewMinutes: 9 } },
      { id: 'X4', label: 'Red', order: 4, base, head: x4, dependsOn: ['X2'], charge: null },
    ],
  }));
  return { dir, repo, manifest };
}

describe('serial PR replay', () => {
  it('merges in order, charges a resolved conflict, records red main, and leaves source refs untouched', async () => {
    const { dir, repo, manifest } = await fixture();
    const refsBefore = await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    const headBefore = await git(repo, 'rev-parse', 'HEAD');
    const manifestPath = join(dir, 'manifest.json');
    const outputPath = join(dir, 'result.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await execFile(process.execPath, ['--import', 'tsx', resolve('replay/main.ts'), 'serial', '--manifest', manifestPath,
      '--repo', repo, '--out', outputPath], { cwd: process.cwd(), timeout: 30_000 });
    const result = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(Object.keys(result).sort()).toEqual(['arm', 'batch', 'changes', 'finishedAt', 'schemaVersion', 'startCommit', 'startedAt', 'totals', 'validationCommand'].sort());
    expect(result).toMatchObject({ schemaVersion: 1, arm: 'pr', batch: 'P', startCommit: manifest.startCommit,
      validationCommand: manifest.validationCommand });
    expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.parse(result.finishedAt));
    expect(result.changes).toHaveLength(4);
    expect(result.changes.map((change: { id: string }) => change.id)).toEqual(['X1', 'X2', 'X3', 'X4']);
    for (const [index, change] of result.changes.entries()) {
      expect(Object.keys(change).sort()).toEqual(['id', 'label', 'order', 'mergedAt', 'conflict', 'conflictFiles',
        'usedResolvedHead', 'chargedMinutes', 'validation', 'mainRed'].sort());
      expect(change.order).toBe(index + 1);
      expect(change.label).toBe(manifest.changes[index].label);
      expect(Date.parse(change.mergedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
      expect(change.validation.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.changes[0]).toMatchObject({ conflict: false, conflictFiles: [], usedResolvedHead: false, chargedMinutes: 0,
      mainRed: false, validation: { exitCode: 0 } });
    expect(result.changes[1]).toMatchObject({ conflict: false, conflictFiles: [], usedResolvedHead: false, chargedMinutes: 0,
      mainRed: false, validation: { exitCode: 0 } });
    expect(result.changes[2]).toMatchObject({ conflict: true, conflictFiles: ['shared.txt'], usedResolvedHead: true,
      chargedMinutes: 21.5, mainRed: false, validation: { exitCode: 0 } });
    expect(result.changes[3]).toMatchObject({ conflict: false, conflictFiles: [], usedResolvedHead: false,
      chargedMinutes: 0, mainRed: true, validation: { exitCode: 1 } });
    expect(result.totals).toEqual({ conflicts: 1, mainRedMerges: 1, workerRunsCharged: 1, freshReviewsCharged: 1,
      chargedMinutes: 21.5, timeToGreenMs: null });
    expect(await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  }, 30_000);

  it('reports green only after every change merges and validation passes', async () => {
    const { repo, manifest } = await fixture();
    const result = await replaySerial({ ...manifest, changes: manifest.changes.slice(0, 3) }, repo);
    expect(result.totals.timeToGreenMs).toBeTypeOf('number');
    expect(result.totals.timeToGreenMs).toBeGreaterThanOrEqual(0);
    expect(result.totals.mainRedMerges).toBe(0);
    const unresolved = await replaySerial({ ...manifest, changes: manifest.changes.map(change => change.id === 'X3' ? { ...change, charge: null } : change) }, repo);
    expect(unresolved.changes[2]).toMatchObject({ conflict: true, mergedAt: null, usedResolvedHead: false,
      chargedMinutes: 0, validation: null, mainRed: false });
    expect(unresolved.changes[3].validation?.exitCode).toBe(1);
    expect(unresolved.totals.timeToGreenMs).toBeNull();
  }, 30_000);

  it('rejects bad SHAs, unknown dependencies, and cycles with CLI exit 2', async () => {
    const { dir, repo, manifest } = await fixture();
    const malformed = [
      { ...manifest, startCommit: 'bad' },
      { ...manifest, changes: manifest.changes.map((change, index) => index === 0 ? { ...change, dependsOn: ['missing'] } : change) },
      { ...manifest, changes: manifest.changes.map((change, index) => index === 0 ? { ...change, dependsOn: ['X3'] } : change) },
    ];
    for (const [index, bad] of malformed.entries()) {
      expect(() => parseManifest(JSON.stringify(bad))).toThrow([/startCommit/, /unknown id/, /cycle/][index]);
      const path = join(dir, `invalid-${index}.json`);
      await writeFile(path, JSON.stringify(bad));
      await expect(execFile(process.execPath, ['--import', 'tsx', resolve('replay/main.ts'), 'serial', '--manifest', path,
        '--repo', repo, '--out', join(dir, 'invalid-result.json')], { cwd: process.cwd(), timeout: 30_000 }))
        .rejects.toMatchObject({ code: 2 });
    }
  }, 30_000);
});
