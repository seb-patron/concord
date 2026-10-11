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

function commitWithRawPath(path: Buffer): string {
  const blob = git('rev-parse', 'HEAD:README.md');
  const treeInput = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), path, Buffer.from([0])]);
  const tree = spawnSync('git', ['-C', repo, 'mktree', '-z'], { input: treeInput, encoding: 'utf8' });
  expect(tree.status, tree.stderr).toBe(0);
  const commit = spawnSync('git', ['-C', repo, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.test',
    'commit-tree', tree.stdout.trim()], { input: 'raw path\n', encoding: 'utf8' });
  expect(commit.status, commit.stderr).toBe(0);
  return commit.stdout.trim();
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

  it('rejects malformed UTF-8 in a path list with its line number and rejects replacement in arguments', () => {
    const list = join(directory, 'paths.txt');
    writeFileSync(list, Buffer.concat([Buffer.from('future/ok.txt\nfo'), Buffer.from([0x80]), Buffer.from('.txt\n')]));
    const fromFile = run(['--oid', oid, '--allow-path-file', list]);
    expect(fromFile.status).toBe(2);
    expect(fromFile.stderr).toContain(`${list}:2`);
    expect(fromFile.stdout).toBe('');

    const fromArg = spawnSync('sh', ['-c',
      'bad=$(printf "\\200"); exec "$@" --allow-path "fo${bad}.txt"',
      'sh', process.execPath, '--import', 'tsx', script, '--repo', repo, '--template', template, '--oid', oid],
    { cwd: resolve('.'), encoding: 'utf8' });
    expect(fromArg.status).toBe(2);
    expect(fromArg.stderr).toContain('INVALID_ARGUMENT_ENCODING');
  });

  it('rejects invalid template bytes before they can authorize a replacement-character path', () => {
    const path = 'fo\uFFFD.txt';
    writeFileSync(join(repo, path), 'tracked');
    git('add', path);
    git('-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', 'commit', '-qm', 'replacement path');
    const unit = { canonicalKey: `file:${path}`, file: path, resources: [], dependencyKeys: [] };
    const source = JSON.stringify({ ...baseTemplate, units: { ...baseTemplate.units, [`file:${path}`]: unit } });
    writeFileSync(template, Buffer.from(source.replaceAll('\uFFFD', '\x80'), 'latin1'));

    const result = run(['--oid', git('rev-parse', 'HEAD')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('INVALID_TEMPLATE_ENCODING');
    expect(result.stdout).toBe('');
  });

  it('rejects invalid UTF-8 in a tracked Git path', () => {
    const rawPath = Buffer.concat([Buffer.from('fo'), Buffer.from([0x80]), Buffer.from('.txt')]);
    const result = run(['--oid', commitWithRawPath(rawPath)]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('UNSUPPORTED_GIT_PATH_ENCODING');
    expect(result.stdout).toBe('');
  });

  it('does not drop a UTF-8 BOM from the start of a Git path', () => {
    const result = run(['--oid', commitWithRawPath(Buffer.from('\uFEFFfoo.txt'))]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('UNSAFE_PATH');
    expect(result.stdout).toBe('');
  });

  it('rejects invalid UTF-8 in a comparison envelope', () => {
    const priorFile = join(directory, 'previous.json');
    writeFileSync(priorFile, Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0x80]), Buffer.from('"}')]));
    const result = run(['--compare', priorFile, '--read-back-oid', oid]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('INVALID_COMPARISON_ENCODING');
    expect(result.stdout).toBe('');
  });

  it('rejects duplicate template keys before a dependency can be overwritten', () => {
    const first = { canonicalKey: 'file:README.md', file: 'README.md',
      resources: [], dependencyKeys: ['file:missing.txt'] };
    const second = { ...first, dependencyKeys: [] };
    const units = `{"row:families:alpha":${JSON.stringify(row)},"file:README.md":${JSON.stringify(first)},` +
      `"file:README.md":${JSON.stringify(second)}}`;
    writeFileSync(template, JSON.stringify(baseTemplate).replace(JSON.stringify(baseTemplate.units), units));
    const result = run(['--oid', oid]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('DUPLICATE_TEMPLATE_KEY: file:README.md');
    expect(result.stdout).toBe('');
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

  it('reports unchanged when generation and comparison use the same planned-path union and OID', () => {
    const examples = [...readFileSync(resolve('docs/api-leases.md'), 'utf8').matchAll(/```sh\n([\s\S]*?)\n```/g)]
      .map(match => match[1]);
    const plannedFlags = (example: string) => [...example.matchAll(/--allow-path(?:-file)?\s+([^\s\\]+)/g)]
      .map(match => match[0]);
    expect(plannedFlags(examples[1])).toEqual(plannedFlags(examples[0]));

    const listA = join(directory, 'run-a-paths.txt');
    const listB = join(directory, 'run-b-paths.txt');
    writeFileSync(listA, 'future/one.py\n');
    writeFileSync(listB, 'future/two.py\n');
    const paths = ['--allow-path-file', listA, '--allow-path-file', listB, '--allow-path', 'future/report.py'];
    const initial = generated(['--oid', oid, ...paths]);
    const priorFile = join(directory, 'policy-envelope.json');
    writeFileSync(priorFile, JSON.stringify(initial));
    const result = run(['--compare', priorFile, '--read-back-oid', oid, ...paths]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unchanged', sourceOid: oid,
      policyDigest: initial.policyDigest });
  });
});
