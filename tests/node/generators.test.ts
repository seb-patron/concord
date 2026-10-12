import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Digest, Job, TrustedPolicy } from '../../src/contracts';
import { digest } from '../../src/http';
import { overlaps, resolveUnit, unitRegistry } from '../../src/leases/units';
import { manifestDigest, normalizeManifest } from '../../src/verdicts/manifest';
import { childEnvironment, git, temporaryWork } from '../../runner/git';
import { executeJob, type CredentialProvider } from '../../runner/execute';
import { loadProfile, localEnvironment, type LocalProfile } from '../../runner/profiles';

const pin = (`sha256:${'0'.repeat(64)}`) as Digest;
const commitEnv = childEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
const policy: TrustedPolicy = { id: 'counts', digest: pin, version: 1, checkerId: 'counts', checkerDigest: pin,
  units: {}, tables: [{ name: 'rows', file: 'rows.tsv', header: ['row', 'value'], keyColumn: 'row',
    keySpec: { charset: 'lower', minLength: 1, maxLength: 64 } }],
  generators: [{ id: 'counts', outputs: ['count.txt'], command: 'count' }],
  acceptance: { kind: 'hard-gates', gates: [{ id: 'count', requiredOutcome: 'PASS' }] } };
const countCommand = ['-c', 'tail -n +2 rows.tsv | wc -l | tr -d " " > count.txt'];
const profile: LocalProfile = { id: 'counts', kind: 'command', digest: pin, checkerId: 'counts', checkerDigest: pin,
  oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16_384,
  executable: '/bin/sh', argv: ['-c', 'test "$(cat count.txt)" -eq "$(tail -n +2 rows.tsv | wc -l)"'],
  toolchainFile: '/bin/sh', cwd: 'repo', timeoutSeconds: 5, env: ['PATH'], outputCap: 4096,
  generatorCommands: { count: countCommand } };

describe('declared generated files', () => {
  it('resolves each declared generator as a unit over its exact outputs', () => {
    const registry = unitRegistry(policy);
    expect(resolveUnit(registry, 'gen:counts').generatedFiles).toEqual(['count.txt']);
    expect(overlaps(resolveUnit(registry, 'gen:counts'), resolveUnit(registry, 'file:count.txt'))).toBe(true);
  });

  it('accepts only owner-pinned generator argv in a command profile', async () => {
    await temporaryWork(async dir => {
      const executable = '/bin/sh';
      const binaryDigest = (`sha256:${createHash('sha256').update(await readFile(executable)).digest('hex')}`) as Digest;
      const commandConfig = { executable, argv: ['-c', 'exit 0'], cwd: 'repo' as const,
        timeoutSeconds: 5, env: ['PATH'], outputCap: 4096, generatorCommands: { count: countCommand } };
      const content = { id: 'counts', kind: 'command' as const, checkerId: 'counts', checkerDigest: binaryDigest,
        toolchainDigest: binaryDigest, toolchainFile: executable, oracleDigest: await digest(commandConfig),
        environmentDigest: await digest(localEnvironment()), timeoutMs: 120_000, maxOutputBytes: 16_384,
        ...commandConfig };
      const path = join(dir, 'profile.json');
      await writeFile(path, JSON.stringify({ ...content, digest: await digest(content) }));
      expect((await loadProfile(path)).generatorCommands?.count).toEqual(countCommand);
      await writeFile(path, JSON.stringify({ ...content, generatorCommands: { count: ['-c', 'exit 7'] }, digest: await digest(content) }));
      await expect(loadProfile(path)).rejects.toThrow('INVALID_COMMAND_PROFILE');
    });
  });

  it('regenerates both candidate orders, ignores candidate output edits, and pins review evidence', async () => {
    await temporaryWork(async dir => {
      const work = join(dir, 'work');
      await mkdir(work);
      const bare = Object.fromEntries(['canonical', 'alpha', 'beta', 'scratchA', 'scratchB'].map(name => [name, join(dir, `${name}.git`)]));
      for (const path of Object.values(bare)) await git(dir, ['init', '--bare', '--quiet', path]);
      await git(work, ['init', '--quiet']);
      await writeFile(join(work, 'rows.tsv'), 'row\tvalue\nbase\t0\n');
      await writeFile(join(work, 'count.txt'), '1\n');
      await git(work, ['add', '.']);
      await git(work, ['commit', '-m', 'base'], 30_000, commitEnv);
      const base = await git(work, ['rev-parse', 'HEAD']);
      for (const name of ['canonical', 'alpha', 'beta']) await git(work, ['push', bare[name], 'HEAD:refs/heads/main']);
      const candidate = async (name: 'alpha' | 'beta', output: string) => {
        await git(work, ['switch', '--detach', base]);
        await writeFile(join(work, 'rows.tsv'), `row\tvalue\nbase\t0\n${name}\t1\n`);
        await writeFile(join(work, 'count.txt'), output);
        await git(work, ['add', '.']);
        await git(work, ['commit', '-m', name], 30_000, commitEnv);
        const headOid = await git(work, ['rev-parse', 'HEAD']);
        await git(work, ['push', '-f', bare[name], 'HEAD:refs/heads/main']);
        return { changeId: name, revision: 1, baseOid: base, headOid, storageName: name, ref: 'refs/heads/main' };
      };
      const alpha = await candidate('alpha', '2\n');
      const beta = await candidate('beta', '999\n');
      const remotes = Object.fromEntries(Object.entries(bare).map(([name, path]) => [name, pathToFileURL(path).href]));
      const credentials: CredentialProvider = async () => Object.entries(remotes).map(([storageName, remote]) =>
        ({ storageName, remote, secret: 'unused', expiresAt: Date.now() + 60_000 }));
      const common = { jobId: 'job', repoId: 'demo', inputDigest: pin, generation: 1, profileDigest: pin,
        policyId: 'counts', policyDigest: pin, unitPolicy: policy, storageRemotes: remotes,
        checkerId: 'counts', checkerDigest: pin, oracleDigest: pin, toolchainDigest: pin,
        environmentDigest: pin, timeoutMs: 120_000, maxOutputBytes: 16_384,
        state: 'claimed' as const, attempt: 1, runnerId: 'runner', fence: 1, expiresAt: Date.now() + 60_000, version: 1 };
      const inspection: Job = { ...common, kind: 'inspect-candidate', changeId: 'beta', revision: 1, candidate: beta,
        expectedRefs: { beta: beta.headOid } };
      const inspected = await executeJob(inspection, profile, credentials);
      expect(inspected).toMatchObject({ outcome: 'PASS', unitKeys: ['row:rows:beta'] });
      if (inspected.kind !== 'inspect-candidate' || !inspected.reviewManifest) throw new Error('inspection absent');
      expect(inspected.reviewManifest.changedUnits.map(unit => unit.afterPath)).toEqual(['rows.tsv']);
      expect(inspected.reviewManifest.generatedOutputs?.map(item => item.id)).toEqual(['counts']);
      expect(normalizeManifest(inspected.reviewManifest, policy, inspected.unitKeys)).toEqual(inspected.reviewManifest);
      expect(manifestDigest(inspected.reviewManifest, policy, inspected.unitKeys)).toBe(inspected.reviewManifestDigest);
      const runStack = async (ordered: typeof alpha[], scratch: 'scratchA' | 'scratchB', activeProfile = profile) => {
        const job: Job = { ...common, kind: 'validate-stack', canonicalBaseOid: base, candidates: ordered,
          bootstrap: false, stackId: scratch, scratchStorageName: scratch, scratchRef: 'refs/heads/check',
          expectedRefs: { canonical: base, [scratch]: null } };
        return executeJob(job, activeProfile, credentials);
      };
      for (const [ordered, scratch] of [[[alpha, beta], 'scratchA'], [[beta, alpha], 'scratchB']] as const) {
        const result = await runStack([...ordered], scratch);
        expect(result.outcome, result.log).toBe('PASS');
        if (result.kind !== 'validate-stack' || !result.composedOid) throw new Error('stack absent');
        await git(work, ['fetch', bare[scratch], result.composedOid]);
        expect(await git(work, ['show', `${result.composedOid}:count.txt`])).toBe('3');
      }
      const failing = { ...profile, generatorCommands: { count: ['-c', 'echo generated-error >&2; exit 7'] } };
      const failed = await runStack([alpha, beta], 'scratchA', failing);
      expect(failed.outcome).toBe('GENERATOR_FAILED');
      expect(failed.log).toContain('generated-error');
      const unstable = { ...profile, generatorCommands: { count: ['-c', 'expr $(cat count.txt) + 1 > count.txt'] } };
      const nondeterministic = await runStack([alpha, beta], 'scratchA', unstable);
      expect(nondeterministic.outcome).toBe('GENERATOR_NONDETERMINISTIC');
      await git(work, ['push', '-f', bare.canonical, `${alpha.headOid}:refs/heads/main`]);
      const delta: Job = { ...common, kind: 'delta-check', changeId: 'beta', candidate: beta,
        newBaseOid: alpha.headOid, oldManifestDigest: inspected.reviewManifestDigest!,
        oldReviewManifest: inspected.reviewManifest, parentVerdictId: 'approval', findingSetVersion: 0,
        expectedRefs: { canonical: alpha.headOid } };
      const carried = await executeJob(delta, profile, credentials);
      expect(carried.outcome, carried.log).toBe('PASS');
      if (carried.kind !== 'delta-check') throw new Error('delta absent');
      expect(carried.reviewManifestDigest).toBe(inspected.reviewManifestDigest);
      expect(normalizeManifest(carried.reviewManifest!, policy, ['row:rows:beta'])).toEqual(inspected.reviewManifest);
    });
  }, 30_000);
});
