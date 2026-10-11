import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Digest, Job, TrustedPolicy } from '../../src/contracts';
import { digest } from '../../src/http';
import { childEnvironment, git, temporaryWork } from '../../runner/git';
import { executeJob } from '../../runner/execute';
import { loadProfile, localEnvironment, pinnedCheck, verifyLocalProfile } from '../../runner/profiles';

const executable = '/bin/sh';
const commandSettings = { executable, argv: ['scripts/validate.sh'], cwd: 'repo' as const,
  timeoutSeconds: 2, env: ['PATH', 'TMPDIR', 'LANG'], outputCap: 128 };
const filePin = (bytes: Buffer | string) => ('sha256:' + createHash('sha256').update(bytes).digest('hex')) as Digest;
const commitEnv = childEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

async function profileIn(dir: string, changes: Record<string, unknown> = {}) {
  const binaryPin = filePin(await readFile(executable));
  const settings = { ...commandSettings, ...changes };
  const content = { id: 'command-demo', kind: 'command', checkerId: 'command-demo',
    checkerDigest: binaryPin, toolchainDigest: binaryPin, oracleDigest: await digest(settings),
    environmentDigest: await digest(localEnvironment()), timeoutMs: 5_000, maxOutputBytes: 256,
    toolchainFile: executable, ...settings };
  const path = join(dir, 'profile.json');
  await writeFile(path, JSON.stringify({ ...content, digest: await digest(content) }));
  return path;
}

function jobFor(profile: Awaited<ReturnType<typeof loadProfile>>, remotes: Record<string, string>, base: string): Job {
  const pin = profile.checkerDigest as Digest;
  const policy: TrustedPolicy = { id: 'command-demo', digest: pin, version: 1, checkerId: 'command-demo',
    checkerDigest: pin, units: {}, acceptance: { kind: 'hard-gates', gates: [{ id: 'default', requiredOutcome: 'PASS' }] } };
  return { jobId: 'job', repoId: 'demo', inputDigest: pin, generation: 1, profileDigest: profile.digest as Digest,
    policyId: policy.id, policyDigest: policy.digest, unitPolicy: policy, storageRemotes: remotes,
    checkerId: profile.checkerId, checkerDigest: pin, oracleDigest: profile.oracleDigest as Digest,
    toolchainDigest: profile.toolchainDigest as Digest, environmentDigest: profile.environmentDigest as Digest,
    timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes, state: 'claimed', attempt: 1,
    runnerId: 'runner', fence: 1, expiresAt: Date.now() + 60_000, version: 1,
    kind: 'validate-stack', canonicalBaseOid: base, candidates: [], baseCheck: true, bootstrap: false,
    stackId: 'stack', scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
    expectedRefs: { canonical: base, scratch: null } };
}

describe('pinned command checker', () => {
  it('checks a composed checkout, then records a script failure with an authenticated result', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'repo');
      const canonical = join(dir, 'canonical.git');
      const scratch = join(dir, 'scratch.git');
      await git(dir, ['init', '--quiet', repo]);
      await git(dir, ['init', '--bare', '--quiet', canonical]);
      await git(dir, ['init', '--bare', '--quiet', scratch]);
      await mkdir(join(repo, 'scripts'));
      await writeFile(join(repo, 'scripts/validate.sh'), 'echo passed\n');
      await git(repo, ['add', 'scripts/validate.sh']);
      await git(repo, ['commit', '--quiet', '-m', 'passing'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', canonical, 'HEAD:refs/heads/main']);
      const profile = await loadProfile(await profileIn(dir));
      await verifyLocalProfile(profile);
      const remotes = { canonical: pathToFileURL(canonical).href, scratch: pathToFileURL(scratch).href };
      const job = jobFor(profile, remotes, base);
      const credentials = async () => Object.entries(remotes).map(([storageName, remote]) =>
        ({ storageName, remote, secret: 'unused', expiresAt: Date.now() + 60_000 }));
      const passing = await executeJob(job, profile, credentials);
      expect(passing).toMatchObject({ kind: 'validate-stack', outcome: 'PASS', composedOid: base });
      expect(passing.log).toContain('exit=0');
      expect(passing.resultDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      const inspect = (headOid: string, baseOid: string): Job => ({ ...job, kind: 'inspect-candidate',
        changeId: 'change', revision: 1, candidate: { changeId: 'change', revision: 1, baseOid,
          headOid, storageName: 'canonical', ref: 'refs/heads/main' },
        expectedRefs: { canonical: headOid } }) as Job;
      expect(await executeJob(inspect(base, base), profile, credentials)).toMatchObject({
        kind: 'inspect-candidate', outcome: 'PASS', observedHeadOid: base });

      await writeFile(join(repo, 'scripts/validate.sh'), 'echo failed\nexit 7\n');
      await git(repo, ['add', 'scripts/validate.sh']);
      await git(repo, ['commit', '--quiet', '-m', 'failing'], 30_000, commitEnv);
      const failedBase = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', canonical, 'HEAD:refs/heads/main']);
      const failing = await executeJob({ ...job, canonicalBaseOid: failedBase,
        expectedRefs: { canonical: failedBase, scratch: base } } as Job, profile, credentials);
      expect(failing).toMatchObject({ kind: 'validate-stack', outcome: 'FAIL', composedOid: failedBase });
      expect(failing.log).toContain('exit=7');
      expect(failing.log).toContain('failed');
      expect(failing.resultDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      const failedInspection = await executeJob(inspect(failedBase, base), profile, credentials);
      expect(failedInspection).toMatchObject({ kind: 'inspect-candidate', outcome: 'FAIL', observedHeadOid: failedBase });
      expect(failedInspection.log).toContain('exit=7');
    });
  });

  it('fails on timeout and keeps only the capped output tail', async () => {
    await temporaryWork(async dir => {
      const script = join(dir, 'scripts');
      await mkdir(script);
      const profile = await loadProfile(await profileIn(dir, { timeoutSeconds: 1, outputCap: 48 }));
      const pin = profile.checkerDigest as Digest;
      const job = { profileDigest: profile.digest, checkerId: profile.checkerId, checkerDigest: pin,
        oracleDigest: profile.oracleDigest, toolchainDigest: profile.toolchainDigest,
        environmentDigest: profile.environmentDigest, timeoutMs: profile.timeoutMs,
        maxOutputBytes: profile.maxOutputBytes } as Job;
      await writeFile(join(script, 'validate.sh'), "printf 'DISCARDED-START-abcdefghijklmnopqrstuvwxyz-0123456789END'\nexit 3\n");
      const failed = await pinnedCheck(profile, job, dir);
      expect(failed.outcome).toBe('FAIL');
      expect(failed.log).toContain('exit=3');
      expect(failed.log).toContain('END');
      expect(failed.log).not.toContain('DISCARDED-START');
      expect(failed.log.length).toBeLessThanOrEqual(48);
      const previousLang = process.env.LANG;
      try {
        process.env.LANG = 'private-runner-value';
        await writeFile(join(script, 'validate.sh'), 'printf "%s" "$LANG"\n');
        const redacted = await pinnedCheck(profile, job, dir);
        expect(redacted.log).toContain('[redacted]');
        expect(redacted.log).not.toContain('private-runner-value');
      } finally {
        if (previousLang === undefined) delete process.env.LANG;
        else process.env.LANG = previousLang;
      }
      await writeFile(join(script, 'validate.sh'), 'sleep 2\n');
      const timeout = await pinnedCheck(profile, job, dir);
      expect(timeout.outcome).toBe('FAIL');
      expect(timeout.log).toContain('timeout');
    });
  }, 10_000);

  it('rejects relative or unpinned executables, job placeholders, and unsafe environment names', async () => {
    await temporaryWork(async dir => {
      for (const changes of [
        { executable: 'sh' },
        { executable: '/bin/false' },
        { argv: ['{unit}'] },
        { env: ['PATH', 'CONCORD_TOKEN'] },
      ]) await expect(loadProfile(await profileIn(dir, changes))).rejects.toThrow('INVALID_COMMAND_PROFILE');
      const path = await profileIn(dir);
      const content = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      delete content.digest;
      content.checkerDigest = content.toolchainDigest = filePin('wrong binary');
      await writeFile(path, JSON.stringify({ ...content, digest: await digest(content) }));
      await expect(loadProfile(path)).rejects.toThrow('UNPINNED_EXECUTABLE');
    });
  });
});
