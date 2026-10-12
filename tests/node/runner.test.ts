import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Digest, Job, TrustedPolicy } from '../../src/contracts';
import { digest } from '../../src/http';
import { normalizeManifest } from '../../src/verdicts/manifest';
import { childEnvironment, command, conditionalPush, git, refOid, temporaryWork } from '../../runner/git';
import { executeJob, type CredentialProvider } from '../../runner/execute';
import { dispatchArgv, loadProfile, localEnvironment, pinnedCheck, verifyLocalProfile, type LocalProfile } from '../../runner/profiles';
import { inspectUnits, mergeTsv } from '../../runner/units';
import { parseArgs, runLoop, type Transport } from '../../runner/main';

const pin = ('sha256:' + '0'.repeat(64)) as Digest;
const policy: TrustedPolicy = { id: 'local-demo', digest: pin, version: 1, checkerId: 'local-demo', checkerDigest: pin,
  units: {}, acceptance: { kind: 'hard-gates', gates: [{ id: 'default', requiredOutcome: 'PASS' }] } };
const commitEnv = childEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

async function gitFixture(run: (state: { dir: string; repo: string; canonical: string; candidate: string; scratch: string; base: string }) => Promise<void>) {
  await temporaryWork(async dir => {
    const repo = join(dir, 'work');
    const canonical = join(dir, 'canonical.git');
    const candidate = join(dir, 'candidate.git');
    const scratch = join(dir, 'scratch.git');
    await mkdir(repo);
    for (const bare of [canonical, candidate, scratch]) await git(dir, ['init', '--bare', '--quiet', bare]);
    await git(repo, ['init', '--quiet']);
    await writeFile(join(repo, 'example.txt'), 'base\n');
    await git(repo, ['add', 'example.txt']);
    await git(repo, ['commit', '--quiet', '-m', 'base'], 30_000, commitEnv);
    const base = await git(repo, ['rev-parse', 'HEAD']);
    for (const remote of [canonical, candidate]) await git(repo, ['push', '--quiet', remote, 'HEAD:refs/heads/main']);
    await run({ dir, repo, canonical, candidate, scratch, base });
  });
}

function jobBase(storageRemotes: Record<string, string>) {
  return {
    jobId: 'job', repoId: 'demo', inputDigest: pin, generation: 1, profileDigest: pin,
    policyId: 'local-demo', policyDigest: pin, unitPolicy: policy, expectedRefs: {},
    storageRemotes, checkerId: 'local-demo', checkerDigest: pin, oracleDigest: pin,
    toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
    state: 'claimed' as const, attempt: 1, runnerId: 'runner', fence: 1, expiresAt: Date.now() + 60_000, version: 1,
  };
}

function credentials(remotes: Record<string, string>): CredentialProvider {
  return async operation => Object.entries(remotes).filter(([name]) =>
    operation === 'fetch' || operation === 'scratch-push' && name === 'scratch' ||
    operation === 'canonical-push' && name === 'canonical').map(([storageName, remote]) =>
    ({ storageName, remote, secret: 'unused', expiresAt: Date.now() + 60_000 }));
}

describe('local runner Git and checker execution', () => {
  it('requires every reviewed dispatch scene case and checks its expected tree', async () => {
    await temporaryWork(async dir => {
      const a1 = { retry_limit: 1, timeout_ms: 1000, output: 1000 };
      const a2 = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
      const a3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
      const a4 = { retry_limit: 4, timeout_ms: 1000, output: 4000 };
      const b2 = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
      const b3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
      const g3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
      const g4 = { retry_limit: 4, timeout_ms: 1250, output: 5000 };
      const g5 = { retry_limit: 5, timeout_ms: 1250, output: 6250 };
      const c4 = { retry_limit: 4, timeout_ms: 1000, output: 4000 };
      const c5 = { retry_limit: 5, timeout_ms: 1000, output: 5000 };
      const e4 = { retry_limit: 4, timeout_ms: 1500, output: 6000 };
      const j1 = { retry_limit: 1, timeout_ms: 500, output: 500 };
      const jLow = { retry_limit: 2, timeout_ms: 500, output: 1000 };
      const jHigh = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
      const rows = (alpha: typeof a1, beta: typeof b2, gamma: typeof g3, delta: typeof c4, epsilon = j1) =>
        ({ alpha, beta, gamma, delta, epsilon });
      const cases: NonNullable<LocalProfile['cases']> = {
        seed: { rows: rows(a1, b2, g3, c4) },
        'a-only': { rows: rows(a2, b2, g3, c4) },
        'b-only': { rows: rows(a1, b2, g3, c4) },
        'c-only': { rows: rows(a1, b2, g3, c5) },
        'a-b': { rows: rows(a2, b2, g3, c4) },
        'a-c-survivors': { rows: rows(a2, b2, g3, c5) },
        'b-c': { rows: rows(a1, b2, g3, c5) },
        'a-b-c': { rows: rows(a2, b2, g3, c5) },
        'b-repaired': { rows: rows(a2, b2, g4, c5) },
        'd-only': { rows: rows(a3, b2, g4, c5) },
        'e-only': { rows: rows(a2, b2, g4, e4) },
        'd-e': { rows: rows(a3, b2, g4, e4) },
        'h-only': { rows: rows(a4, b2, g4, e4) },
        'i-only': { rows: rows(a3, b3, g4, e4) },
        'j-common': { rows: rows(a3, b3, g4, e4, jLow), epsilonChoices: [jLow, jHigh] },
        'aw-only': { rows: rows(a3, b3, g5, e4, jHigh) },
        'rows-zeta': { rows: { ...rows(a3, b3, g5, e4, jHigh), zeta: { retry_limit: 2, timeout_ms: 750, output: 1500 } } },
        'rows-eta': { rows: { ...rows(a3, b3, g5, e4, jHigh), eta: { retry_limit: 3, timeout_ms: 750, output: 2250 } } },
        'rows-retire': { rows: { alpha: a3, beta: b3, gamma: g5, delta: e4 } },
        'rows-zeta-eta': { rows: { ...rows(a3, b3, g5, e4, jHigh), zeta: { retry_limit: 2, timeout_ms: 750, output: 1500 },
          eta: { retry_limit: 3, timeout_ms: 750, output: 2250 } } },
        'rows-zeta-retire': { rows: { alpha: a3, beta: b3, gamma: g5, delta: e4, zeta: { retry_limit: 2, timeout_ms: 750, output: 1500 } } },
        'rows-eta-retire': { rows: { alpha: a3, beta: b3, gamma: g5, delta: e4, eta: { retry_limit: 3, timeout_ms: 750, output: 2250 } } },
        'rows-all': { rows: { alpha: a3, beta: b3, gamma: g5, delta: e4,
          zeta: { retry_limit: 2, timeout_ms: 750, output: 1500 }, eta: { retry_limit: 3, timeout_ms: 750, output: 2250 } } },
      };
      const path = join(dir, 'dispatch-profile.json');
      const write = async (matrix: NonNullable<LocalProfile['cases']>) => {
        const content = { id: 'dispatch', checkerId: 'dispatch-lab', checkerDigest: pin, oracleDigest: await digest(matrix),
          toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
          executable: process.execPath, argv: dispatchArgv, toolchainFile: process.execPath, cases: matrix };
        await writeFile(path, JSON.stringify({ ...content, digest: await digest(content) }));
      };
      await write(cases);
      const profile = await loadProfile(path);
      await writeFile(join(dir, 'dispatch.mjs'), `import fs from 'node:fs';
export function attemptBudget(family) {
  const line = fs.readFileSync('families.tsv', 'utf8').trim().split('\\n').slice(1).find(row => row.startsWith(family + '\\t'));
  const [, retry, timeout] = line.split('\\t');
  return Number(retry) * Number(timeout);
}`);
      const bCases = new Set(['b-only', 'a-b', 'b-c', 'a-b-c']);
      for (const [caseId, config] of Object.entries(cases)) {
        const tree = structuredClone(config.rows);
        if (bCases.has(caseId)) tree.gamma = { retry_limit: 0, timeout_ms: 0, output: 0 };
        await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\ttimeout_ms\n' +
          Object.entries(tree).map(([family, row]) => `${family}\t${row.retry_limit}\t${row.timeout_ms}\n`).join(''));
        const job = { ...jobBase({}), checkerId: 'dispatch-lab', caseId, profileDigest: profile.digest,
          oracleDigest: profile.oracleDigest } as Job & { caseId: string };
        expect((await pinnedCheck(profile, job, dir)).outcome, caseId).toBe(bCases.has(caseId) ? 'FAIL' : 'PASS');
        if (caseId === 'j-common') {
          tree.epsilon = jHigh;
          await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\ttimeout_ms\n' +
            Object.entries(tree).map(([family, row]) => `${family}\t${row.retry_limit}\t${row.timeout_ms}\n`).join(''));
          expect((await pinnedCheck(profile, job, dir)).score).toEqual({ matched: 4, total: 4 });
        }
      }
      const survivorRows = cases['a-c-survivors'].rows;
      const survivorTable = 'family\tretry_limit\ttimeout_ms\n' +
        Object.entries(survivorRows).map(([family, row]) => `${family}\t${row.retry_limit}\t${row.timeout_ms}\n`).join('');
      const survivorJob = { ...jobBase({}), checkerId: 'dispatch-lab', caseId: 'a-c-survivors',
        profileDigest: profile.digest, oracleDigest: profile.oracleDigest } as Job & { caseId: string };
      for (const table of [
        survivorTable.replace('alpha\t2\t1000', 'alpha\tx\t1000'),
        survivorTable + 'alpha\t2\t1000\n',
        survivorTable.replace('gamma\t3\t1000\n', ''),
        survivorTable.replace('gamma\t3\t1000', 'gamma\t0\t0'),
        survivorTable.replace('alpha\t2\t1000', 'alpha\t3\t1000'),
      ]) {
        await writeFile(join(dir, 'families.tsv'), table);
        expect((await pinnedCheck(profile, survivorJob, dir)).outcome).toBe('FAIL');
      }
      for (const name of Object.keys(cases)) {
        const incomplete = structuredClone(cases);
        delete incomplete[name];
        await write(incomplete);
        await expect(loadProfile(path)).rejects.toThrow('INVALID_PROFILE_CASE');
        const incorrect = structuredClone(cases);
        incorrect[name].rows.alpha.output = 9999;
        await write(incorrect);
        await expect(loadProfile(path)).rejects.toThrow('INVALID_PROFILE_CASE');
      }
      const extra = structuredClone(cases);
      extra['unreviewed'] = { rows: rows(a1, b2, g3, c4) };
      await write(extra);
      await expect(loadProfile(path)).rejects.toThrow('INVALID_PROFILE_CASE');
      const jCases = structuredClone(cases);
      jCases['j-common'].rows.beta.output = 9999;
      await write(jCases);
      await expect(loadProfile(path)).rejects.toThrow('INVALID_PROFILE_CASE');
    });
  });

  it('loads a content-pinned owner profile with a 35-minute ceiling', async () => {
    await temporaryWork(async dir => {
      const checkerFile = join(dir, 'checker.js');
      const oracleFile = join(dir, 'oracle.txt');
      const toolchainFile = join(dir, 'toolchain.txt');
      await writeFile(checkerFile, 'checker');
      await writeFile(oracleFile, 'oracle');
      await writeFile(toolchainFile, 'toolchain');
      const filePin = (text: string) => ('sha256:' + createHash('sha256').update(text).digest('hex')) as Digest;
      const content = { id: 'owner', checkerId: 'owner', checkerDigest: filePin('checker'), oracleDigest: filePin('oracle'),
        toolchainDigest: filePin('toolchain'), environmentDigest: await digest(localEnvironment()), timeoutMs: 35 * 60_000,
        maxOutputBytes: 16 * 1024, executable: checkerFile, argv: [], checkerFile, oracleFile, toolchainFile };
      const path = join(dir, 'profile.json');
      await writeFile(path, JSON.stringify({ ...content, digest: await digest(content) }));
      const loaded = await loadProfile(path);
      expect(loaded.timeoutMs).toBe(35 * 60_000);
      await expect(verifyLocalProfile(loaded)).resolves.toBeUndefined();
      await writeFile(path, JSON.stringify({ ...content, timeoutMs: 35 * 60_000 + 1, digest: pin }));
      await expect(loadProfile(path)).rejects.toThrow('INVALID_PROFILE');
    });
  });
  it('merges disjoint TSV rows and refuses divergent edits to one row', () => {
    const base = 'family\tretry_limit\ttimeout_ms\nalpha\t1\t1000\nbeta\t2\t1000\n';
    const alpha = base.replace('alpha\t1', 'alpha\t2');
    const beta = base.replace('beta\t2', 'beta\t3');
    expect(mergeTsv(base, alpha, beta)).toContain('alpha\t2\t1000\nbeta\t3\t1000');
    expect(() => mergeTsv(base, alpha, base.replace('alpha\t1', 'alpha\t3'))).toThrow('TSV_COLLISION');
  });

  it('merges declared tables with nonfirst keys, additions, deletions and collisions', () => {
    const table = { name: 'jobs', file: 'data/jobs.tsv', header: ['value', 'job'], keyColumn: 'job', keySpec: { charset: 'lower' as const, minLength: 1, maxLength: 256 } };
    const base = 'value\tjob\nold\talpha\nretired\tomega\n';
    const ours = base + 'left\tzeta\n';
    const theirs = 'value\tjob\nold\talpha\nright\teta\n';
    expect(mergeTsv(base, ours, theirs, table)).toBe('value\tjob\nold\talpha\nleft\tzeta\nright\teta\n');
    expect(() => mergeTsv(base, ours, base + 'other\tzeta\n', table)).toThrow('TSV_COLLISION');
    expect(() => mergeTsv(base, ours, theirs.replace('value\tjob', 'job\tvalue'), table)).toThrow('INVALID_TSV_HEADER');
    expect(() => mergeTsv(base, ours + 'again\tzeta\n', theirs, table)).toThrow('INVALID_TSV_ROW');
  });

  it('inspects an appended pattern row from a declared non-demo table', async () => {
    await gitFixture(async ({ repo }) => {
      const baseText = 'value\tjob\nold\talpha\n';
      await writeFile(join(repo, 'jobs.tsv'), baseText);
      await git(repo, ['add', 'jobs.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'jobs base'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, 'jobs.tsv'), baseText + 'new\tzeta\n');
      await git(repo, ['add', 'jobs.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'append zeta'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const rowPolicy: TrustedPolicy = { ...policy, tables: [{ name: 'jobs', file: 'jobs.tsv', header: ['value', 'job'],
        keyColumn: 'job', keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } }], units: { 'file:jobs.tsv': {
        canonicalKey: 'file:jobs.tsv', file: 'jobs.tsv', resources: [], dependencyKeys: [],
      } } };
      const inspected = await inspectUnits(repo, base, head, { ...jobBase({}), unitPolicy: rowPolicy } as Job);
      expect(inspected.unitKeys).toEqual(['row:jobs:zeta']);
      expect(inspected.manifest.coverage).toBe('complete');
      expect(normalizeManifest(inspected.manifest, rowPolicy, inspected.unitKeys)).toEqual(inspected.manifest);
    });
  });

  it('uses whole-file scope when a Git TSV changes mode and row content', async () => {
    await gitFixture(async ({ repo }) => {
      await writeFile(join(repo, 'jobs.tsv'), 'job\tvalue\nalpha\told\n');
      await git(repo, ['add', 'jobs.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'table'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, 'jobs.tsv'), 'job\tvalue\nalpha\tnew\n');
      await git(repo, ['add', 'jobs.tsv']);
      await git(repo, ['update-index', '--chmod=+x', 'jobs.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'mode and row'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const rowPolicy: TrustedPolicy = { ...policy, tables: [{ name: 'jobs', file: 'jobs.tsv',
        header: ['job', 'value'], keyColumn: 'job', keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } }],
      units: { 'file:jobs.tsv': { canonicalKey: 'file:jobs.tsv', file: 'jobs.tsv', resources: [], dependencyKeys: [] } } };
      const inspected = await inspectUnits(repo, base, head, { ...jobBase({}), unitPolicy: rowPolicy } as Job);
      expect(inspected.unitKeys).toEqual(['file:jobs.tsv']);
      expect(inspected.manifest.changedUnits[0]).toMatchObject({ beforeMode: '100644', afterMode: '100755' });
    });
  });

  it('uses whole-file scope when a Git TSV row edit adds a final newline', async () => {
    await gitFixture(async ({ repo }) => {
      await writeFile(join(repo, 'jobs.tsv'), 'job\tvalue\nalpha\told\nbeta\told');
      await git(repo, ['add', 'jobs.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'table without final newline'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, 'jobs.tsv'), 'job\tvalue\nalpha\tnew\nbeta\told\n');
      await git(repo, ['add', 'jobs.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'row and newline'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const rowPolicy: TrustedPolicy = { ...policy, tables: [{ name: 'jobs', file: 'jobs.tsv',
        header: ['job', 'value'], keyColumn: 'job', keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } }],
      units: { 'row:jobs:alpha': { canonicalKey: 'row:jobs:alpha', file: 'jobs.tsv',
        resources: ['jobs.tsv#alpha'], dependencyKeys: [] } } };
      const inspected = await inspectUnits(repo, base, head, { ...jobBase({}), unitPolicy: rowPolicy } as Job);
      expect(inspected.unitKeys).toEqual(['file:jobs.tsv']);
      expect(inspected.manifest.coverage).toBe('complete');
      expect(() => normalizeManifest(inspected.manifest, rowPolicy, ['row:jobs:alpha'])).toThrow('MANIFEST_UNIT_SCOPE_MISMATCH');
      expect(normalizeManifest(inspected.manifest, rowPolicy, inspected.unitKeys)).toEqual(inspected.manifest);
    });
  });

  it('derives actual row writes and the trusted dependency digest from Git bytes', async () => {
    await gitFixture(async ({ repo }) => {
      const table = 'family\tretry_limit\ttimeout_ms\nalpha\t1\t1000\nbeta\t2\t1000\n';
      await writeFile(join(repo, 'families.tsv'), table);
      await git(repo, ['add', 'families.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'table'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, 'families.tsv'), table.replace('alpha\t1', 'alpha\t2'));
      await git(repo, ['add', 'families.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'alpha'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const rowPolicy: TrustedPolicy = { ...policy, units: {
        'row:families:alpha': { canonicalKey: 'row:families:alpha', file: 'families.tsv', resources: ['families.tsv#alpha'], dependencyKeys: ['row:families:beta'] },
        'row:families:beta': { canonicalKey: 'row:families:beta', file: 'families.tsv', resources: ['families.tsv#beta'], dependencyKeys: [] },
      } };
      const job = { ...jobBase({}), unitPolicy: rowPolicy } as Job;
      const inspected = await inspectUnits(repo, base, head, job);
      expect(inspected.unitKeys).toEqual(['row:families:alpha']);
      expect(inspected.manifest.coverage).toBe('complete');
      if (inspected.manifest.coverage !== 'complete') throw new Error('unknown');
      expect(inspected.manifest.dependencyScope).toMatchObject([{ unitKey: 'row:families:beta', path: 'families.tsv' }]);
      expect(inspected.manifest.dependencyScope[0].contentDigest).toBe('sha256:' + createHash('sha256').update('beta\t2\t1000').digest('hex'));
      expect(normalizeManifest(inspected.manifest, rowPolicy, inspected.unitKeys)).toEqual(inspected.manifest);
      const beforeDigest = 'sha256:' + createHash('sha256').update('alpha\t1\t1000').digest('hex');
      expect(inspected.manifest.changedUnits[0].beforeDigest).toBe(beforeDigest);
    });
  });

  it('collects transitive whole-file dependencies, cycles, and unknown scope from Git evidence', async () => {
    await gitFixture(async ({ repo }) => {
      await writeFile(join(repo, 'b.txt'), 'bee\n');
      await writeFile(join(repo, 'c.txt'), 'see\n');
      await git(repo, ['add', 'b.txt', 'c.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'dependencies'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, 'example.txt'), 'changed\n');
      await git(repo, ['add', 'example.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'change'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const units: TrustedPolicy['units'] = {
        'file:example.txt': { canonicalKey: 'file:example.txt', file: 'example.txt', resources: [], dependencyKeys: ['file:b.txt'] },
        'file:b.txt': { canonicalKey: 'file:b.txt', file: 'b.txt', resources: [], dependencyKeys: ['file:c.txt'] },
        'file:c.txt': { canonicalKey: 'file:c.txt', file: 'c.txt', resources: [], dependencyKeys: [] },
      };
      const filePolicy: TrustedPolicy = { ...policy, units };
      const inspect = (unitPolicy: TrustedPolicy) => inspectUnits(repo, base, head, { ...jobBase({}), unitPolicy } as Job);
      const chain = await inspect(filePolicy);
      expect(chain.unitKeys).toEqual(['file:example.txt']);
      expect(chain.manifest.coverage).toBe('complete');
      if (chain.manifest.coverage !== 'complete') throw new Error('unknown');
      expect(chain.manifest.dependencyScope).toEqual([
        { kind: 'unit', unitKey: 'file:b.txt', path: 'b.txt', mode: '100644', contentDigest: 'sha256:' + createHash('sha256').update('bee\n').digest('hex') },
        { kind: 'unit', unitKey: 'file:c.txt', path: 'c.txt', mode: '100644', contentDigest: 'sha256:' + createHash('sha256').update('see\n').digest('hex') },
      ]);
      expect(normalizeManifest(chain.manifest, filePolicy, chain.unitKeys)).toEqual(chain.manifest);

      const cyclePolicy: TrustedPolicy = { ...filePolicy, units: { ...units,
        'file:b.txt': { ...units['file:b.txt'], dependencyKeys: ['file:example.txt'] } } };
      const cycle = await inspect(cyclePolicy);
      expect(cycle.manifest.coverage).toBe('complete');
      if (cycle.manifest.coverage !== 'complete') throw new Error('unknown');
      expect(cycle.manifest.dependencyScope.map(entry => entry.unitKey)).toEqual(['file:b.txt', 'file:example.txt']);
      expect(cycle.manifest.dependencyScope[1].contentDigest).toBe('sha256:' + createHash('sha256').update('changed\n').digest('hex'));
      expect(normalizeManifest(cycle.manifest, cyclePolicy, cycle.unitKeys)).toEqual(cycle.manifest);

      for (const invalid of [
        { ...units, 'file:c.txt': { ...units['file:c.txt'], file: 'missing.txt' } },
        { ...units, 'file:b.txt': { ...units['file:b.txt'], resources: ['unreviewed'] } },
        { ...units, 'file:b.txt': { ...units['file:b.txt'], dependencyKeys: ['file:missing.txt'] } },
      ]) {
        const unknown = await inspect({ ...filePolicy, units: invalid });
        expect(unknown.manifest.coverage).toBe('unknown');
        expect(unknown.manifest.dependencyScope).toEqual([{ kind: 'tree', treeOid: await git(repo, ['rev-parse', head + '^{tree}']) }]);
      }
    });
  });

  it('collects chained TSV row dependencies from the committed table', async () => {
    await gitFixture(async ({ repo }) => {
      const table = 'family\tretry_limit\ttimeout_ms\nalpha\t1\t1000\nbeta\t2\t1000\ngamma\t3\t1000\n';
      await writeFile(join(repo, 'families.tsv'), table);
      await git(repo, ['add', 'families.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'table'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, 'families.tsv'), table.replace('alpha\t1', 'alpha\t2'));
      await git(repo, ['add', 'families.tsv']);
      await git(repo, ['commit', '--quiet', '-m', 'alpha'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const rowPolicy: TrustedPolicy = { ...policy, units: Object.fromEntries(['alpha', 'beta', 'gamma'].map((row, index) => [
        `row:families:${row}`, { canonicalKey: `row:families:${row}`, file: 'families.tsv', resources: [`families.tsv#${row}`],
          dependencyKeys: index < 2 ? [`row:families:${['beta', 'gamma'][index]}`] : [] },
      ])) };
      const inspected = await inspectUnits(repo, base, head, { ...jobBase({}), unitPolicy: rowPolicy } as Job);
      expect(inspected.manifest.coverage).toBe('complete');
      if (inspected.manifest.coverage !== 'complete') throw new Error('unknown');
      expect(inspected.manifest.dependencyScope).toEqual(['beta', 'gamma'].map(row => ({
        kind: 'unit', unitKey: `row:families:${row}`, path: 'families.tsv', mode: '100644',
        contentDigest: 'sha256:' + createHash('sha256').update(`${row}\t${row === 'beta' ? 2 : 3}\t1000`).digest('hex'),
      })));
      expect(normalizeManifest(inspected.manifest, rowPolicy, inspected.unitKeys)).toEqual(inspected.manifest);
    });
  });

  it('enforces an expected-old Git push and reconciles a lost success response', async () => {
    await gitFixture(async ({ repo, canonical, base }) => {
      await writeFile(join(repo, 'example.txt'), 'next\n');
      await git(repo, ['add', 'example.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'next'], 30_000, commitEnv);
      const next = await git(repo, ['rev-parse', 'HEAD']);
      expect(await conditionalPush(repo, canonical, next, 'c'.repeat(40))).toBe('OLD_REF');
      expect(await conditionalPush(repo, canonical, next, base)).toBe('APPLIED');
      expect(await conditionalPush(repo, canonical, next, base)).toBe('APPLIED');
    });
  });

  it('caps and times out a child, with no coordinator token in its environment', async () => {
    await temporaryWork(async dir => {
      const previous = { coordinator: process.env.CONCORD_TOKEN, git: process.env.CONCORD_GIT_TOKEN };
      process.env.CONCORD_TOKEN = 'coordinator-test-secret';
      process.env.CONCORD_GIT_TOKEN = 'canonical-test-secret';
      try {
        const env = childEnvironment();
        expect(env.CONCORD_TOKEN).toBeUndefined();
        expect(env.CONCORD_GIT_TOKEN).toBeUndefined();
        const result = await command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], dir, 40, env);
        expect(result.timedOut).toBe(true);
        const clean = await command(process.execPath, ['-e', 'process.stdout.write(String(process.env.CONCORD_TOKEN)+":"+String(process.env.CONCORD_GIT_TOKEN))'], dir, 1000, env);
        expect(clean.stdout).toBe('undefined:undefined');
        const capped = await command(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000))'], dir, 1000, env);
        expect(capped.stdout.length).toBe(16 * 1024);
        expect(capped.truncated).toBe(true);
      } finally {
        if (previous.coordinator === undefined) delete process.env.CONCORD_TOKEN; else process.env.CONCORD_TOKEN = previous.coordinator;
        if (previous.git === undefined) delete process.env.CONCORD_GIT_TOKEN; else process.env.CONCORD_GIT_TOKEN = previous.git;
      }
    });
  });

  it('reports ENV_ERROR when the pinned compiler is absent', async () => {
    await gitFixture(async ({ canonical, candidate, scratch, base }) => {
      const remotes = Object.fromEntries(Object.entries({ canonical, candidate, scratch }).map(([name, path]) => [name, pathToFileURL(path).href]));
      const job: Job = { ...jobBase(remotes), kind: 'validate-stack', canonicalBaseOid: base,
        candidates: [{ changeId: 'change', revision: 1, baseOid: base, headOid: base, storageName: 'candidate', ref: 'refs/heads/main' }],
        bootstrap: false, stackId: 'stack', scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
        expectedRefs: { canonical: base, scratch: null } };
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: '/missing/compiler-for-concord', argv: ['{repo}', '{unit}'] };
      const result = await executeJob(job, profile, credentials(remotes));
      expect(result).toMatchObject({ kind: 'validate-stack', outcome: 'ENV_ERROR' });
    });
  });

  it('checks an exact composed commit and pushes only that commit to scratch', async () => {
    await gitFixture(async ({ repo, canonical, candidate, scratch, base }) => {
      await writeFile(join(repo, 'example.txt'), 'candidate\n');
      await git(repo, ['add', 'example.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'candidate'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', candidate, 'HEAD:refs/heads/main']);
      const remotes = Object.fromEntries(Object.entries({ canonical, candidate, scratch }).map(([name, path]) => [name, pathToFileURL(path).href]));
      const job: Job = { ...jobBase(remotes), kind: 'validate-stack', canonicalBaseOid: base,
        candidates: [{ changeId: 'change', revision: 1, baseOid: base, headOid: head, storageName: 'candidate', ref: 'refs/heads/main' }],
        bootstrap: false, stackId: 'stack', scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
        expectedRefs: { canonical: base, scratch: null } };
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: process.execPath, argv: ['-e', "if (require('node:fs').readFileSync('example.txt', 'utf8') !== 'candidate\\n') process.exit(1)"] };
      expect(job.caseId).toBeUndefined();
      const result = await executeJob(job, profile, credentials(remotes));
      expect(result).toMatchObject({ kind: 'validate-stack', outcome: 'PASS' });
      if (result.kind !== 'validate-stack') throw new Error('wrong result');
      expect(await refOid(repo, remotes.scratch, 'refs/heads/check')).toBe(result.composedOid);
      expect(await refOid(repo, remotes.canonical)).toBe(base);
      const retry = await executeJob({ ...job, attempt: 2, fence: 2 }, profile, credentials(remotes));
      expect(retry).toMatchObject({ kind: 'validate-stack', outcome: 'PASS', composedOid: result.composedOid });
    });
  });

  it('checks the canonical commit and tree for a base-check job', async () => {
    await gitFixture(async ({ repo, canonical, scratch, base }) => {
      const remotes = { canonical: pathToFileURL(canonical).href, scratch: pathToFileURL(scratch).href };
      const job: Job = { ...jobBase(remotes), kind: 'validate-stack', canonicalBaseOid: base,
        candidates: [], baseCheck: true, bootstrap: false, stackId: 'stack', scratchStorageName: 'scratch',
        scratchRef: 'refs/heads/check', expectedRefs: { canonical: base, scratch: null } };
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: process.execPath, argv: ['-e', 'process.exit(0)'] };
      const result = await executeJob(job, profile, credentials(remotes));
      expect(result).toMatchObject({ kind: 'validate-stack', outcome: 'PASS', composedOid: base,
        composedTreeOid: await git(repo, ['rev-parse', base + '^{tree}']) });
      expect(await refOid(repo, remotes.scratch, 'refs/heads/check')).toBe(base);
    });
  });

  it('rejects a same-tree scratch descendant during base-check reconciliation', async () => {
    await gitFixture(async ({ repo, canonical, scratch, base }) => {
      await git(repo, ['commit', '--allow-empty', '--quiet', '-m', 'descendant'], 30_000, commitEnv);
      const descendant = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', scratch, 'HEAD:refs/heads/check']);
      expect(await git(repo, ['rev-parse', descendant + '^{tree}'])).toBe(await git(repo, ['rev-parse', base + '^{tree}']));
      const remotes = { canonical: pathToFileURL(canonical).href, scratch: pathToFileURL(scratch).href };
      const job: Job = { ...jobBase(remotes), kind: 'validate-stack', canonicalBaseOid: base,
        candidates: [], baseCheck: true, bootstrap: false, stackId: 'stack', scratchStorageName: 'scratch',
        scratchRef: 'refs/heads/check', expectedRefs: { canonical: base, scratch: null } };
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: process.execPath, argv: ['-e', 'process.exit(1)'] };
      const result = await executeJob(job, profile, credentials(remotes));
      expect(result).toMatchObject({ kind: 'validate-stack', outcome: 'ENV_ERROR', composedOid: null });
      expect(result.log).toContain('SCRATCH_OLD_REF');
      expect(await refOid(repo, remotes.scratch, 'refs/heads/check')).toBe(descendant);
    });
  });

  it('merges adjacent generic TSV edits only when the policy declares the table', async () => {
    await temporaryWork(async dir => {
      const canonical = join(dir, 'canonical.git');
      const first = join(dir, 'first.git');
      const second = join(dir, 'second.git');
      const collision = join(dir, 'collision.git');
      const scratch = join(dir, 'scratch.git');
      const scratchCollision = join(dir, 'scratch-collision.git');
      for (const bare of [canonical, first, second, collision, scratch, scratchCollision]) await git(dir, ['init', '--bare', '--quiet', bare]);
      const seed = join(dir, 'seed');
      await mkdir(seed);
      await git(seed, ['init', '--quiet']);
      const baseTable = 'family\tretry_limit\ttimeout_ms\nalpha\t1\t1000\nbeta\t2\t1000\n';
      await writeFile(join(seed, 'families.tsv'), baseTable);
      await git(seed, ['add', 'families.tsv']);
      await git(seed, ['commit', '--quiet', '-m', 'base'], 30_000, commitEnv);
      const base = await git(seed, ['rev-parse', 'HEAD']);
      for (const remote of [canonical, first, second, collision]) await git(seed, ['push', '--quiet', remote, 'HEAD:refs/heads/main']);
      const candidate = async (name: string, remote: string, text: string) => {
        const work = join(dir, name);
        await mkdir(work);
        await git(work, ['init', '--quiet']);
        await git(work, ['fetch', '--quiet', remote, base]);
        await git(work, ['switch', '--detach', base]);
        await writeFile(join(work, 'families.tsv'), text);
        await git(work, ['add', 'families.tsv']);
        await git(work, ['commit', '--quiet', '-m', name], 30_000, commitEnv);
        const head = await git(work, ['rev-parse', 'HEAD']);
        await git(work, ['push', '--quiet', remote, 'HEAD:refs/heads/main']);
        return head;
      };
      const firstHead = await candidate('alpha', first, baseTable.replace('alpha\t1', 'alpha\t2'));
      const secondHead = await candidate('beta', second, baseTable.replace('beta\t2', 'beta\t3'));
      const collisionHead = await candidate('alpha-collision', collision, baseTable.replace('alpha\t1', 'alpha\t3'));
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: process.execPath, argv: ['-e', 'process.exit(0)'] };
      const table = { name: 'families', file: 'families.tsv', header: ['family', 'retry_limit', 'timeout_ms'],
        keyColumn: 'family', keySpec: { charset: 'lower' as const, minLength: 1, maxLength: 256 } };
      const run = async (otherName: string, otherRemote: string, otherHead: string, scratchPath: string, declared: boolean) => {
        const remotes = Object.fromEntries(Object.entries({ canonical, first, [otherName]: otherRemote, scratch: scratchPath })
          .map(([name, path]) => [name, pathToFileURL(path).href]));
        const job: Job = { ...jobBase(remotes), unitPolicy: { ...policy, tables: declared ? [table] : [] },
          kind: 'validate-stack', canonicalBaseOid: base,
          candidates: [
            { changeId: 'alpha', revision: 1, baseOid: base, headOid: firstHead, storageName: 'first', ref: 'refs/heads/main' },
            { changeId: otherName, revision: 1, baseOid: base, headOid: otherHead, storageName: otherName, ref: 'refs/heads/main' },
          ], bootstrap: false, stackId: 'stack', scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
          expectedRefs: { canonical: base, scratch: null } };
        return executeJob(job, profile, credentials(remotes));
      };
      const undeclared = await run('second', second, secondHead, scratch, false);
      expect(undeclared).toMatchObject({ outcome: 'MERGE_CONFLICT', composedOid: null });
      expect(undeclared.log).toContain('MERGE_CONFLICT');
      expect(await refOid(seed, pathToFileURL(scratch).href, 'refs/heads/check')).toBeNull();
      const composed = await run('second', second, secondHead, scratch, true);
      expect(composed).toMatchObject({ outcome: 'PASS' });
      if (composed.kind !== 'validate-stack' || !composed.composedOid) throw new Error('Missing composed commit');
      expect(await refOid(seed, pathToFileURL(scratch).href, 'refs/heads/check')).toBe(composed.composedOid);
      await git(seed, ['fetch', '--quiet', scratch, composed.composedOid]);
      expect(await git(seed, ['show', `${composed.composedOid}:families.tsv`])).toBe(
        baseTable.replace('alpha\t1', 'alpha\t2').replace('beta\t2', 'beta\t3').trim());
      const rejected = await run('collision', collision, collisionHead, scratchCollision, true);
      expect(rejected).toMatchObject({ outcome: 'MERGE_CONFLICT' });
      expect(await refOid(seed, pathToFileURL(scratchCollision).href, 'refs/heads/check')).toBeNull();
    });
  }, 20_000); // Six bare repos, three native commits and three composed checks.

  it('delta-check reruns the affected unit with the pinned profile', async () => {
    await gitFixture(async ({ repo, canonical, candidate, base }) => {
      await writeFile(join(repo, 'example.txt'), 'candidate\n');
      await git(repo, ['add', 'example.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'candidate'], 30_000, commitEnv);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', candidate, 'HEAD:refs/heads/main']);
      const remotes = { canonical: pathToFileURL(canonical).href, candidate: pathToFileURL(candidate).href };
      const filePolicy: TrustedPolicy = { ...policy, units: { 'file:example.txt': {
        canonicalKey: 'file:example.txt', file: 'example.txt', resources: [], dependencyKeys: [] } } };
      const oldReviewManifest = { changedUnits: [], policyVersion: 1, policyDigest: pin, checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, coverage: 'complete' as const, dependencyScope: [] };
      const job: Job = { ...jobBase(remotes), unitPolicy: filePolicy, kind: 'delta-check', changeId: 'change',
        candidate: { changeId: 'change', revision: 1, baseOid: base, headOid: head, storageName: 'candidate', ref: 'refs/heads/main' },
        oldManifestDigest: pin, newBaseOid: base, parentVerdictId: 'verdict', findingSetVersion: 0,
        oldReviewManifest, expectedRefs: { canonical: base } };
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: process.execPath, argv: ['-e', "if (process.argv[1] !== 'file:example.txt') process.exit(1)", '{unit}'] };
      const result = await executeJob(job, profile, credentials(remotes));
      expect(result).toMatchObject({ kind: 'delta-check', outcome: 'PASS' });
      if (result.kind !== 'delta-check') throw new Error('wrong result');
      expect(result.reviewManifest?.changedUnits[0].unitKey).toBe('file:example.txt');
    });
  });

  it('validates an explicit seed and promotes it only while main is absent', async () => {
    await gitFixture(async ({ repo, canonical, candidate, scratch, base }) => {
      // Use an empty canonical repo to exercise the absent-main lease.
      const empty = join(repo, '..', 'empty.git');
      await git(join(repo, '..'), ['init', '--bare', '--quiet', empty]);
      const remotes = { canonical: pathToFileURL(empty).href, seed: pathToFileURL(candidate).href, scratch: pathToFileURL(scratch).href };
      const checkJob: Job = { ...jobBase(remotes), kind: 'validate-stack', canonicalBaseOid: null,
        candidates: [{ changeId: 'seed', revision: 1, baseOid: null, headOid: base, seedStorageName: 'seed', seedRef: 'refs/heads/main' }],
        bootstrap: true, ownerAuthorized: true, stackId: 'seed-stack', scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
        expectedRefs: { canonical: null, scratch: null } };
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: process.execPath, argv: ['-e', 'process.exit(0)'] };
      const checked = await executeJob(checkJob, profile, credentials(remotes));
      expect(checked).toMatchObject({ outcome: 'PASS', composedOid: base });
      const promoteJob: Job = { ...jobBase(remotes), kind: 'promote', promotionId: 'bootstrap', expectedOldOid: null,
        checkedNewOid: base, bootstrap: true, ownerAuthorized: true, scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
        expectedRefs: { canonical: null, scratch: base } };
      const promoted = await executeJob(promoteJob, null, credentials(remotes));
      expect(promoted).toMatchObject({ kind: 'promote', outcome: 'APPLIED', observedCanonicalOid: base });
      expect(await refOid(repo, remotes.canonical)).toBe(base);
      expect(await refOid(repo, pathToFileURL(canonical).href)).toBe(base);
    });
  });

  it('rejects an in-range table when candidate executable gives the wrong answer', async () => {
    await temporaryWork(async repo => {
      await writeFile(join(repo, 'families.tsv'), 'family\tretry_limit\ttimeout_ms\nalpha\t2\t1000\nbeta\t2\t1000\ngamma\t3\t1000\ndelta\t4\t1000\nepsilon\t1\t500\n');
      await writeFile(join(repo, 'dispatch.mjs'), `import fs from 'node:fs';
export function attemptBudget(family) {
  const row = fs.readFileSync('families.tsv','utf8').trim().split('\\n').slice(1).find(line => line.startsWith(family+'\\t')).split('\\t');
  return Number(row[1])*Number(row[2]) + (family === 'alpha' ? 250 : 0);
}`);
      const rows = {
        alpha: { retry_limit: 2, timeout_ms: 1000, output: 2000 },
        beta: { retry_limit: 2, timeout_ms: 1000, output: 2000 },
        gamma: { retry_limit: 3, timeout_ms: 1000, output: 3000 },
        delta: { retry_limit: 4, timeout_ms: 1000, output: 4000 },
        epsilon: { retry_limit: 1, timeout_ms: 500, output: 500 },
      };
      const profile: LocalProfile = { id: 'dispatch', digest: pin, checkerId: 'dispatch-lab', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        cases: { 'a-only': { rows } } };
      const job = { ...jobBase({}), checkerId: 'dispatch-lab', caseId: 'a-only' } as Job & { caseId: string };
      expect((await pinnedCheck(profile, job, repo)).outcome).toBe('FAIL');
      await expect(pinnedCheck(profile, { ...job, caseId: 'unknown' } as unknown as Job, repo)).rejects.toThrow('UNKNOWN_CASE_ID');
      profile.cases!['j-common'] = { rows: { ...rows, epsilon: { retry_limit: 2, timeout_ms: 500, output: 1000 } },
        epsilonChoices: [{ retry_limit: 2, timeout_ms: 500, output: 1000 }, { retry_limit: 2, timeout_ms: 1000, output: 2000 }] };
      await writeFile(join(repo, 'families.tsv'), 'family\tretry_limit\ttimeout_ms\nalpha\t2\t1000\nbeta\t2\t1000\ngamma\t3\t1000\ndelta\t4\t1000\nepsilon\t2\t500\n');
      await writeFile(join(repo, 'dispatch.mjs'), `import fs from 'node:fs';
export function attemptBudget(family) {
  const row = fs.readFileSync('families.tsv','utf8').trim().split('\\n').slice(1).find(line => line.startsWith(family+'\\t')).split('\\t');
  return Number(row[1])*Number(row[2]) + (family === 'epsilon' ? 1000 : 0);
}`);
      const jJob = { ...job, caseId: 'j-common' } as unknown as Job;
      expect((await pinnedCheck(profile, jJob, repo)).outcome).toBe('FAIL');
      await writeFile(join(repo, 'dispatch.mjs'), `import fs from 'node:fs';
export function attemptBudget(family) {
  const row = fs.readFileSync('families.tsv','utf8').trim().split('\\n').slice(1).find(line => line.startsWith(family+'\\t')).split('\\t');
  return Number(row[1])*Number(row[2]);
}`);
      expect((await pinnedCheck(profile, jJob, repo)).score).toEqual({ matched: 2, total: 4 });
      await writeFile(join(repo, 'families.tsv'), 'family\tretry_limit\ttimeout_ms\nalpha\t2\t1000\nbeta\t2\t1000\ngamma\t3\t1000\ndelta\t4\t1000\nepsilon\t2\t1000\n');
      expect((await pinnedCheck(profile, jJob, repo)).score).toEqual({ matched: 4, total: 4 });
    });
  });

  it('promoter returns OLD_REF after a concurrent canonical advance', async () => {
    await gitFixture(async ({ repo, canonical, scratch, base }) => {
      await writeFile(join(repo, 'example.txt'), 'checked\n');
      await git(repo, ['add', 'example.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'checked'], 30_000, commitEnv);
      const checked = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', scratch, 'HEAD:refs/heads/check']);
      await writeFile(join(repo, 'example.txt'), 'third\n');
      await git(repo, ['add', 'example.txt']);
      await git(repo, ['commit', '--quiet', '-m', 'third'], 30_000, commitEnv);
      await git(repo, ['push', '--quiet', canonical, 'HEAD:refs/heads/main']);
      const remotes = { canonical: pathToFileURL(canonical).href, scratch: pathToFileURL(scratch).href };
      const job: Job = { ...jobBase(remotes), kind: 'promote', promotionId: 'promotion', expectedOldOid: base,
        checkedNewOid: checked, bootstrap: false, scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
        expectedRefs: { canonical: base, scratch: checked } };
      const result = await executeJob(job, null, credentials(remotes));
      expect(result).toMatchObject({ kind: 'promote', outcome: 'OLD_REF' });
    });
  });

  it('retries a lost result response with the same body over fake API transport', async () => {
    await gitFixture(async ({ candidate, base }) => {
      const remotes = { candidate: pathToFileURL(candidate).href };
      const job: Job = { ...jobBase(remotes), kind: 'inspect-candidate', changeId: 'change', revision: 1,
        candidate: { changeId: 'change', revision: 1, baseOid: base, headOid: base, storageName: 'candidate', ref: 'refs/heads/main' } };
      const profile: LocalProfile = { id: 'local-demo', digest: pin, checkerId: 'local-demo', checkerDigest: pin,
        oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16 * 1024,
        executable: process.execPath, argv: ['-e', 'process.exit(0)'] };
      let sent: string | null = null;
      let posts = 0;
      const transport: Transport = async (path, body, key) => {
        if (path === 'runner/poll') return { status: 200, data: { job } };
        if (path.endsWith('/credentials')) return { status: 200, data: { credentials: await credentials(remotes)('fetch') } };
        if (path.endsWith('/result')) {
          posts++;
          const encoded = JSON.stringify({ body, key });
          if (sent && sent !== encoded) throw new Error('REPLAY_CHANGED');
          sent = encoded;
          if (posts === 1) throw new Error('RESPONSE_LOST_AFTER_SUCCESS');
          return { status: 200, data: { dispatch: { status: 'eligible' } } };
        }
        throw new Error('UNEXPECTED_API');
      };
      const options = parseArgs(['--repo', 'demo', '--role', 'checker', '--profile', '/owner/profile.json', '--once']);
      expect(await runLoop(options, transport, profile)).toBe(1);
      expect(posts).toBe(2);
    });
  });
});
