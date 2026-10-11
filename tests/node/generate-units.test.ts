import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/verdicts/manifest';

const script = resolve('runner/generate-units.ts');
const zero = `sha256:${'0'.repeat(64)}`;
const row = { canonicalKey: 'row:families:alpha', file: 'families.tsv',
  resources: ['families.tsv#alpha'], dependencyKeys: ['file:README.md'] };
const baseTemplate = { id: 'owner', version: 1, checkerId: 'checker', checkerDigest: zero,
  acceptance: { kind: 'hard-gates', gates: [{ id: 'required', requiredOutcome: 'PASS' }] },
  units: { 'row:families:alpha': row }, tables: { 'families.tsv': { idColumn: 'family' } } };

let directory: string;
let repo: string;
let template: string;
let oid: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, '--repo', repo, '--template', template, ...args],
    { cwd: resolve('.'), encoding: 'utf8' });
}

function generated(args: string[]) {
  const result = run(args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'concord-generate-units-'));
  repo = join(directory, 'repo');
  mkdirSync(repo);
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), 'owner\n');
  writeFileSync(join(repo, 'families.tsv'), 'family\tvalue\nalpha\t1\n');
  git('add', '.');
  git('-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', 'commit', '-qm', 'canonical');
  oid = git('rev-parse', 'HEAD');
  template = join(directory, 'policy-template.json');
  writeFileSync(template, JSON.stringify(baseTemplate));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('owner file-unit generator', () => {
  it('is deterministic, hashes policy alone and preserves declared rows and tables', () => {
    const a = run(['--oid', oid, '--allow-path', 'new/one.txt', '--allow-path', 'new/two.rs']);
    const b = run(['--oid', oid, '--allow-path', 'new/two.rs', '--allow-path', 'new/one.txt']);
    expect(a.status, a.stderr).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    const envelope = JSON.parse(a.stdout);
    expect(envelope.sourceOid).toBe(oid);
    expect(envelope.generatorVersion).toBe(1);
    expect(envelope.policy.units['row:families:alpha']).toEqual(row);
    expect(envelope.policy.tables).toEqual(baseTemplate.tables);
    for (const path of ['README.md', 'families.tsv', 'new/one.txt', 'new/two.rs']) {
      expect(envelope.policy.units[`file:${path}`]).toEqual({ canonicalKey: `file:${path}`, file: path,
        resources: [], dependencyKeys: [] });
    }
    const { digest, ...preimage } = envelope.policy;
    expect(digest).toBe(`sha256:${createHash('sha256').update(canonicalJson(preimage)).digest('hex')}`);
    expect(envelope.policyDigest).toBe(digest);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('owner\n');
  });

  it('reads a union of path files and repeated direct paths', () => {
    const listA = join(directory, 'a.txt');
    const listB = join(directory, 'b.txt');
    writeFileSync(listA, 'future/new.py\nfuture/next.go\n');
    writeFileSync(listB, 'future/new.py\r\nfuture/third.c\r\n');
    const envelope = generated(['--oid', oid, '--allow-path-file', listA, '--allow-path-file', listB,
      '--allow-path', 'future/next.go']);
    expect(Object.keys(envelope.policy.units).filter(key => key.startsWith('file:future/')).sort()).toEqual([
      'file:future/new.py', 'file:future/next.go', 'file:future/third.c',
    ]);
  });

  it('rejects unsafe and unsupported paths with the offending name', () => {
    for (const path of ['../escape', 'white space.txt', 'x'.repeat(508), 'bad\\name', '.git/config']) {
      const result = run(['--oid', oid, '--allow-path', path]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(JSON.stringify(path));
    }
    symlinkSync('README.md', join(repo, 'shortcut'));
    git('add', 'shortcut');
    git('-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', 'commit', '-qm', 'symlink');
    const result = run(['--oid', git('rev-parse', 'HEAD')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('shortcut');
  });

  it('rejects tracked whitespace names and planned file/directory conflicts', () => {
    writeFileSync(join(repo, 'bad name.txt'), 'bad');
    git('add', 'bad name.txt');
    git('-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', 'commit', '-qm', 'bad path');
    const badOid = git('rev-parse', 'HEAD');
    expect(run(['--oid', badOid]).stderr).toContain('bad name.txt');
    expect(run(['--oid', oid, '--allow-path', 'future', '--allow-path', 'future/file.c']).stderr)
      .toContain('PATH_CONFLICT');
  });

  it('rejects missing dependencies and conflicting file metadata', () => {
    writeFileSync(template, JSON.stringify({ ...baseTemplate, units: {
      'row:families:alpha': { ...row, dependencyKeys: ['file:missing.txt'] },
    } }));
    expect(run(['--oid', oid]).stderr).toContain('MISSING_DEPENDENCY: row:families:alpha -> file:missing.txt');
    writeFileSync(template, JSON.stringify({ ...baseTemplate, units: {
      ...baseTemplate.units, 'file:README.md': { canonicalKey: 'file:other.md', file: 'README.md', resources: [], dependencyKeys: [] },
    } }));
    expect(run(['--oid', oid]).stderr).toMatch(/AMBIGUOUS_TEMPLATE_METADATA|AMBIGUOUS_FILE_UNIT/);
    writeFileSync(template, JSON.stringify({ ...baseTemplate, units: {
      ...baseTemplate.units, 'row:unapproved': { canonicalKey: 'row:unapproved', file: 'not-approved.tsv',
        resources: ['row'], dependencyKeys: [] },
    } }));
    expect(run(['--oid', oid]).stderr).toContain('UNAPPROVED_TEMPLATE_PATH');
  });

  it('compares against a read-back canonical OID without changing the pin for an equivalent tree', () => {
    const initial = generated(['--oid', oid, '--allow-path', 'future/one.txt']);
    const priorFile = join(directory, 'generated.json');
    writeFileSync(priorFile, JSON.stringify(initial));
    git('-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', 'commit', '--allow-empty', '-qm', 'read-back');
    const readBack = git('rev-parse', 'HEAD');
    const unchanged = run(['--compare', priorFile, '--read-back-oid', readBack, '--allow-path', 'future/one.txt']);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ status: 'unchanged', sourceOid: readBack,
      policyDigest: initial.policyDigest });
    const changed = run(['--compare', priorFile, '--read-back-oid', readBack,
      '--allow-path', 'future/one.txt', '--allow-path', 'future/two.txt']);
    expect(changed.status).toBe(1);
    expect(JSON.parse(changed.stdout)).toMatchObject({ status: 'changed', sourceOid: readBack });
  });
});
