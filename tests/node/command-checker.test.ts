import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Digest, Job, TrustedPolicy } from '../../src/contracts';
import { digest } from '../../src/http';
import { childEnvironment, command, git, temporaryWork } from '../../runner/git';
import { cappedChecks, executeJob } from '../../runner/execute';
import { createCommandProfile, loadProfile, pinnedCheck, verifyLocalProfile } from '../../runner/profiles';

const executable = '/bin/sh';
const commandSettings = { executable, argv: ['scripts/validate.sh'], cwd: 'repo' as const,
  timeoutSeconds: 2, env: ['PATH', 'TMPDIR', 'LANG'], outputCap: 4096 };
const filePin = (bytes: Buffer | string) => ('sha256:' + createHash('sha256').update(bytes).digest('hex')) as Digest;
const hostPrefix = `host=${process.platform}/${process.arch} node=${process.version} exe_sha256=sha256:`;
const commitEnv = childEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

async function profileIn(dir: string, changes: Record<string, unknown> = {}, maxOutputBytes = 4096) {
  const settings = { ...commandSettings, ...changes };
  const pin = await digest(settings);
  const content = { id: 'command-demo', kind: 'command', checkerId: 'command-demo',
    checkerDigest: pin, toolchainDigest: pin, oracleDigest: pin,
    environmentDigest: pin, timeoutMs: 5_000, maxOutputBytes,
    toolchainFile: settings.executable, ...settings };
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
  it('preserves distinct host evidence from two checks within the cap', () => {
    const log = cappedChecks(4096, true);
    const first = 'host=darwin/arm64 node=v22 exe_sha256=sha256:' + 'a'.repeat(64) + '\n';
    const second = 'host=linux/x64 node=v24 exe_sha256=sha256:' + 'b'.repeat(64) + '\n';
    log.append(first + 'exit=0\nfirst');
    log.append(second + 'exit=0\nsecond');
    expect(log.value().startsWith(first)).toBe(true);
    expect(log.value()).toContain(second);
    expect(log.value().match(/exit=0\n/g)).toHaveLength(2);
    expect(Buffer.byteLength(log.value())).toBeLessThanOrEqual(4096);
  });
  it('rejects caps below 4096 bytes and accepts the minimum', async () => {
    await temporaryWork(async dir => {
      await expect(loadProfile(await profileIn(dir, { outputCap: 4095 }))).rejects.toThrow('INVALID_COMMAND_PROFILE');
      expect((await loadProfile(await profileIn(dir, { outputCap: 4096 }))).outputCap).toBe(4096);
      const path = await profileIn(dir);
      const content = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      content.timeoutMs = 35 * 60_000 + 1;
      delete content.digest;
      await writeFile(path, JSON.stringify({ ...content, digest: await digest(content) }));
      await expect(loadProfile(path)).rejects.toThrow('INVALID_PROFILE: timeoutMs');
    });
  });

  it('keeps five exit markers at the minimum cap and rejects excessive gates before execution', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'repo');
      const canonical = join(dir, 'canonical.git');
      const scratch = join(dir, 'scratch.git');
      await git(dir, ['init', '--quiet', repo]);
      await git(dir, ['init', '--bare', '--quiet', canonical]);
      await git(dir, ['init', '--bare', '--quiet', scratch]);
      await mkdir(join(repo, 'scripts'));
      await writeFile(join(repo, 'scripts/validate.sh'), "printf '%s' '" + 'x'.repeat(4096) + "'\n");
      await git(repo, ['add', 'scripts/validate.sh']);
      await git(repo, ['commit', '--quiet', '-m', 'gates'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', canonical, 'HEAD:refs/heads/main']);
      const profile = await loadProfile(await profileIn(dir));
      const remotes = { canonical: pathToFileURL(canonical).href, scratch: pathToFileURL(scratch).href };
      const job = jobFor(profile, remotes, base);
      const credentials = async () => Object.entries(remotes).map(([storageName, remote]) =>
        ({ storageName, remote, secret: 'unused', expiresAt: Date.now() + 60_000 }));
      job.unitPolicy.acceptance.gates = Array.from({ length: 5 }, (_, index) =>
        ({ id: `gate-${index}`, requiredOutcome: 'PASS' }));
      const passing = await executeJob(job, profile, credentials);
      expect(passing.log.startsWith(hostPrefix)).toBe(true);
      expect(passing).toMatchObject({ kind: 'validate-stack', outcome: 'PASS' });
      expect(passing.log.match(/exit=0\n/g)).toHaveLength(5);
      expect(Buffer.byteLength(passing.log)).toBeLessThanOrEqual(4096);
      job.unitPolicy.acceptance.gates = Array.from({ length: 129 }, (_, index) =>
        ({ id: `gate-${index}`, requiredOutcome: 'PASS' }));
      const rejected = await executeJob(job, profile, credentials);
      expect(rejected).toMatchObject({ kind: 'validate-stack', outcome: 'ENV_ERROR', gateResults: [] });
      expect(rejected.log).toContain('TOO_MANY_COMMAND_GATES');
    });
  });

  it('keeps a later failing gate and its exit marker when combined output reaches the cap', async () => {
    for (const laterBytes of [16_383, 16_384, 16_385]) await temporaryWork(async dir => {
      const repo = join(dir, 'repo');
      const canonical = join(dir, 'canonical.git');
      const scratch = join(dir, 'scratch.git');
      await git(dir, ['init', '--quiet', repo]);
      await git(dir, ['init', '--bare', '--quiet', canonical]);
      await git(dir, ['init', '--bare', '--quiet', scratch]);
      await mkdir(join(repo, 'scripts'));
      await writeFile(join(repo, 'scripts/validate.sh'),
        `if [ -f .first-gate-ran ]; then printf '%s' '${'y'.repeat(laterBytes)}'; exit 7; fi\n` +
        `touch .first-gate-ran\nprintf '%s' '${'x'.repeat(16_384)}'\n`);
      await git(repo, ['add', 'scripts/validate.sh']);
      await git(repo, ['commit', '--quiet', '-m', 'gates'], 30_000, commitEnv);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', '--quiet', canonical, 'HEAD:refs/heads/main']);
      const profile = await loadProfile(await profileIn(dir, { outputCap: 16_384 }, 16_384));
      const remotes = { canonical: pathToFileURL(canonical).href, scratch: pathToFileURL(scratch).href };
      const job = jobFor(profile, remotes, base);
      job.unitPolicy.acceptance.gates = [
        { id: 'first', requiredOutcome: 'PASS' }, { id: 'later', requiredOutcome: 'PASS' }];
      const credentials = async () => Object.entries(remotes).map(([storageName, remote]) =>
        ({ storageName, remote, secret: 'unused', expiresAt: Date.now() + 60_000 }));
      const result = await executeJob(job, profile, credentials);
      expect(result).toMatchObject({ kind: 'validate-stack', outcome: 'FAIL', gateResults: [
        { gateId: 'first', outcome: 'PASS' }, { gateId: 'later', outcome: 'FAIL' }] });
      expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(16_384);
      expect(result.log).toContain('exit=7');
      expect(result.log).toContain('exit=0');
      expect(result.log).toContain('yyyyyyyy');
      expect(result.log.endsWith('exit=7\n')).toBe(true);
    });
  }, 30_000); // Three Git fixture runs with composed checks.

  it('omits a supervisor variable outside the command profile environment', async () => {
    await temporaryWork(async dir => {
      await mkdir(join(dir, 'scripts'));
      await writeFile(join(dir, 'scripts/validate.sh'), 'printf "%s" "$SystemRoot"\n');
      const profile = await loadProfile(await profileIn(dir));
      const job = { profileDigest: profile.digest, checkerId: profile.checkerId,
        checkerDigest: profile.checkerDigest, oracleDigest: profile.oracleDigest,
        toolchainDigest: profile.toolchainDigest, environmentDigest: profile.environmentDigest,
        timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes } as Job;
      const previous = process.env.SystemRoot;
      try {
        process.env.SystemRoot = 'synthetic-supervisor-secret';
        const checked = await pinnedCheck(profile, job, dir);
        expect(checked.outcome).toBe('PASS');
        expect(checked.log).toMatch(/^host=[^\n]+ exe_sha256=sha256:[a-f0-9]{64}\nexit=0\n$/);
        expect(checked.log).not.toContain('synthetic-supervisor-secret');
      } finally {
        if (previous === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = previous;
      }
    });
  });

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
  }, 15_000);

  it('fails on timeout and keeps only the capped output tail', async () => {
    await temporaryWork(async dir => {
      const script = join(dir, 'scripts');
      await mkdir(script);
      const profile = await loadProfile(await profileIn(dir, { timeoutSeconds: 1 }));
      const pin = profile.checkerDigest as Digest;
      const job = { profileDigest: profile.digest, checkerId: profile.checkerId, checkerDigest: pin,
        oracleDigest: profile.oracleDigest, toolchainDigest: profile.toolchainDigest,
        environmentDigest: profile.environmentDigest, timeoutMs: profile.timeoutMs,
        maxOutputBytes: profile.maxOutputBytes } as Job;
      await writeFile(join(script, 'validate.sh'), "printf 'DISCARDED-START-" + 'x'.repeat(5000) + "END'\nexit 3\n");
      const failed = await pinnedCheck(profile, job, dir);
      expect(failed.outcome).toBe('FAIL');
      expect(failed.log).toContain('exit=3');
      expect(failed.log).toContain('END');
      expect(failed.log).not.toContain('DISCARDED-START');
      expect(Buffer.byteLength(failed.log)).toBeLessThanOrEqual(4096);
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

  it('redacts repeated environment values before the output tail is cut', async () => {
    await temporaryWork(async dir => {
      await mkdir(join(dir, 'scripts'));
      const profile = await loadProfile(await profileIn(dir,
        { env: [...commandSettings.env, 'UV_CACHE_DIR'] }));
      const job = { profileDigest: profile.digest, checkerId: profile.checkerId,
        checkerDigest: profile.checkerDigest, oracleDigest: profile.oracleDigest,
        toolchainDigest: profile.toolchainDigest, environmentDigest: profile.environmentDigest,
        timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes } as Job;
      const secret = 'cache-' + 'Q'.repeat(88) + '-value'; // 100 bytes
      const previous = process.env.UV_CACHE_DIR;
      try {
        process.env.UV_CACHE_DIR = secret;
        await writeFile(join(dir, 'scripts/validate.sh'),
          'i=0; while [ "$i" -lt 100 ]; do printf "%s" "$UV_CACHE_DIR"; i=$((i+1)); done\n');
        const checked = await pinnedCheck(profile, job, dir);
        expect(checked.outcome).toBe('PASS');
        expect(checked.log).toContain('[redacted]');
        expect(Buffer.byteLength(checked.log)).toBeLessThanOrEqual(4096);
        for (let start = 0; start <= secret.length - 4; start++)
          expect(checked.log).not.toContain(secret.slice(start, start + 4));
      } finally {
        if (previous === undefined) delete process.env.UV_CACHE_DIR;
        else process.env.UV_CACHE_DIR = previous;
      }
    });
  });

  it('redacts a value split across output chunks before capture', async () => {
    await temporaryWork(async dir => {
      const secret = 'split-' + 'R'.repeat(80) + '-value';
      const script = `process.stdout.write(${JSON.stringify(secret.slice(0, 50))});\n` +
        `setTimeout(() => process.stdout.write(${JSON.stringify(secret.slice(50))}), 30);`;
      const result = await command(process.execPath, ['-e', script], dir, 2000, childEnvironment(),
        { outputCap: 4096, tail: true, redact: [secret] });
      expect(result.code).toBe(0);
      expect(result.outputTail).toBe('[redacted]');
    });
  });

  it('redacts a split value when the other stream writes between its chunks', async () => {
    for (const stream of ['stdout', 'stderr'] as const) await temporaryWork(async dir => {
      const other = stream === 'stdout' ? 'stderr' : 'stdout';
      const secret = 'cache-' + 'Q'.repeat(88) + '-value'; // 100 bytes
      const script = `process.${stream}.write(${JSON.stringify(secret.repeat(100))});\n` +
        `setTimeout(() => process.${stream}.write(${JSON.stringify(secret.slice(0, 50))}), 30);\n` +
        `setTimeout(() => process.${other}.write('!'), 60);\n` +
        `setTimeout(() => process.${stream}.write(${JSON.stringify(secret.slice(50))}), 90);`;
      const result = await command(process.execPath, ['-e', script], dir, 2000, childEnvironment(),
        { outputCap: 4096, tail: true, redact: [secret] });
      expect(result.code).toBe(0);
      expect(result.outputTail?.match(/\[redacted\]/g)).toHaveLength(101);
      expect(result.outputTail).toBe('[redacted]'.repeat(101) + '!');
      for (let start = 0; start <= secret.length - 4; start++)
        expect(result.outputTail).not.toContain(secret.slice(start, start + 4));
    });
  });

  it('keeps earlier stderr before later stdout at the capped redacted tail boundary', async () => {
    await temporaryWork(async dir => {
      const secret = 'private-' + 'Q'.repeat(84) + '-value';
      const plainScript = "process.stderr.write('B'.repeat(50));\n" +
        "setTimeout(() => process.stdout.write('A'.repeat(4090)), 30);";
      const plain = await command(process.execPath, ['-e', plainScript], dir, 2000, childEnvironment(),
        { outputCap: 4096, tail: true, redact: [secret] });
      expect(plain.code).toBe(0);
      expect(plain.outputTail).toBe('B'.repeat(6) + 'A'.repeat(4090));

      const script = `process.stderr.write('B'.repeat(50));\n` +
        `setTimeout(() => process.stdout.write('A'.repeat(4080) + ${JSON.stringify(secret.slice(0, 50))}), 30);\n` +
        `setTimeout(() => process.stdout.write(${JSON.stringify(secret.slice(50))} + 'Z'), 60);`;
      const result = await command(process.execPath, ['-e', script], dir, 2000, childEnvironment(),
        { outputCap: 4096, tail: true, redact: [secret] });
      expect(result.code).toBe(0);
      expect(result.outputTail).toBe('B'.repeat(5) + 'A'.repeat(4080) + '[redacted]Z');
      expect(Buffer.byteLength(result.outputTail ?? '')).toBe(4096);
      for (let start = 0; start <= secret.length - 4; start++)
        expect(result.outputTail).not.toContain(secret.slice(start, start + 4));
    });
  });

  it('rejects relative or unpinned executables, job placeholders, and unsafe environment names', async () => {
    await temporaryWork(async dir => {
      for (const changes of [
        { executable: 'sh' },
        { argv: ['{unit}'] },
        { env: ['PATH', 'CONCORD_TOKEN'] },
      ]) await expect(loadProfile(await profileIn(dir, changes))).rejects.toThrow('INVALID_COMMAND_PROFILE');
      const missing = join(dir, 'missing');
      await expect(loadProfile(await profileIn(dir, { executable: missing }))).rejects.toThrow('ENV_ERROR');
      const nonExecutable = join(dir, 'not-executable');
      await writeFile(nonExecutable, 'echo no');
      await chmod(nonExecutable, 0o644);
      await expect(loadProfile(await profileIn(dir, { executable: nonExecutable }))).rejects.toThrow('ENV_ERROR');
      const path = await profileIn(dir);
      const content = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const tampered: Record<string, unknown> = { ...content, argv: ['different.sh'] };
      delete tampered.digest;
      await writeFile(path, JSON.stringify({ ...tampered, digest: await digest(tampered) }));
      await expect(loadProfile(path)).rejects.toThrow('INVALID_COMMAND_PROFILE: checkerDigest');
      const changedEnv: Record<string, unknown> = { ...content, env: ['PATH', 'LANG'] };
      delete changedEnv.digest;
      await writeFile(path, JSON.stringify({ ...changedEnv, digest: await digest(changedEnv) }));
      await expect(loadProfile(path)).rejects.toThrow('INVALID_COMMAND_PROFILE: checkerDigest');
      delete content.digest;
      content.checkerDigest = content.toolchainDigest = filePin('wrong binary');
      await writeFile(path, JSON.stringify({ ...content, digest: await digest(content) }));
      await expect(loadProfile(path)).rejects.toThrow('INVALID_COMMAND_PROFILE: checkerDigest');
    });
  });

  it('rejects an outside symlink to a candidate checker even after the script changes', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const checker = join(repo, 'checker.sh');
      await writeFile(checker, '#!/bin/sh\nexit 0\n');
      await chmod(checker, 0o755);
      const outside = join(dir, 'outside-checker');
      await symlink(checker, outside);
      const profile = await createCommandProfile({ id: 'linked', checkerId: 'linked', timeoutMs: 5000,
        maxOutputBytes: 4096, ...commandSettings, executable: outside, argv: [] });
      const path = join(dir, 'profile.json');
      await writeFile(path, JSON.stringify(profile));
      const loaded = await loadProfile(path);
      await writeFile(checker, '#!/bin/sh\nprintf replaced\nexit 0\n');
      expect((await loadProfile(path)).digest).toBe(profile.digest);
      await expect(pinnedCheck(loaded, jobFor(loaded, {}, 'a'.repeat(40)), repo))
        .rejects.toThrow('CHECKER_IN_CANDIDATE');
    });
  });

  it('rejects a symlink hop through the candidate even when its final target is on the host', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const bridge = join(repo, 'bridge');
      const outside = join(dir, 'outside-checker');
      await symlink(executable, bridge);
      await symlink(bridge, outside);
      const profile = await loadProfile(await profileIn(dir, { executable: outside }));
      await expect(pinnedCheck(profile, jobFor(profile, {}, 'a'.repeat(40)), repo))
        .rejects.toThrow('CHECKER_IN_CANDIDATE');
    });
  });

  it('fails closed when the executable is atomically replaced while it runs', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const binary = join(dir, 'shell');
      const replacement = join(dir, 'replacement');
      const marker = join(repo, 'started');
      await writeFile(binary, `#!/bin/sh\nprintf ready > "${marker}"\nsleep 1\n`);
      await writeFile(replacement, `#!/bin/sh\nprintf ready > "${marker}"\nsleep 1\n# version B\n`);
      await chmod(binary, 0o755);
      await chmod(replacement, 0o755);
      const profile = await loadProfile(await profileIn(dir, { executable: binary,
        argv: [] }));
      const checking = pinnedCheck(profile, jobFor(profile, {}, 'a'.repeat(40)), repo);
      const observed = checking.then(value => ({ value }), error => ({ error: String(error) }));
      let started = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { started = (await readFile(marker, 'utf8')) === 'ready'; } catch { /* child has not started */ }
        if (started) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(started, JSON.stringify(started ? {} : await observed)).toBe(true);
      await rename(replacement, binary);
      await expect(checking).rejects.toThrow('ENV_ERROR: executable');
    });
  }, 5000);

  it('rechecks source mode, bytes, and existence before every gate', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const binary = join(dir, 'checker');
      await writeFile(binary, '#!/bin/sh\nexit 0\n');
      await chmod(binary, 0o755);
      const profile = await loadProfile(await profileIn(dir, { executable: binary, argv: [] }));
      const job = jobFor(profile, {}, 'a'.repeat(40));
      expect((await pinnedCheck(profile, job, repo)).outcome).toBe('PASS');
      const checked = await pinnedCheck(profile, job, repo);
      expect(checked.log.startsWith(`host=${process.platform}/${process.arch} node=${process.version} exe_sha256=${filePin(await readFile(binary))}\n`)).toBe(true);
      await chmod(binary, 0o644);
      await expect(pinnedCheck(profile, job, repo)).rejects.toThrow('ENV_ERROR: executable');
      await chmod(binary, 0o700);
      await expect(pinnedCheck(profile, job, repo)).rejects.toThrow('ENV_ERROR: executable mode');
      await chmod(binary, 0o755);
      await writeFile(binary, '#!/bin/sh\nexit 1\n');
      await expect(pinnedCheck(profile, job, repo)).rejects.toThrow('ENV_ERROR: executable sha256');
      await rename(binary, join(dir, 'removed'));
      await expect(pinnedCheck(profile, job, repo)).rejects.toThrow('ENV_ERROR');
      await mkdir(binary);
      await expect(pinnedCheck(profile, job, repo)).rejects.toThrow('ENV_ERROR: executable type');
    });
  });

  it('rejects source metadata drift even when the bytes are unchanged', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const binary = join(dir, 'checker');
      await writeFile(binary, '#!/bin/sh\nexit 0\n');
      await chmod(binary, 0o755);
      const profile = await loadProfile(await profileIn(dir, { executable: binary, argv: [] }));
      await utimes(binary, new Date(0), new Date(0));
      await expect(pinnedCheck(profile, jobFor(profile, {}, 'a'.repeat(40)), repo))
        .rejects.toThrow('ENV_ERROR: executable mtimeNs');
    });
  });

  it('keeps the initially loaded executable snapshot across the executeJob profile reload', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const binary = join(dir, 'checker');
      await writeFile(binary, '#!/bin/sh\nexit 0\n');
      await chmod(binary, 0o755);
      const profile = await loadProfile(await profileIn(dir, { executable: binary, argv: [] }));
      const job = jobFor(profile, {}, 'a'.repeat(40));
      const result = await executeJob(job, profile, async () => [], async filename => {
        await writeFile(binary, '#!/bin/sh\nexit 7\n');
        return loadProfile(filename);
      });
      expect(result).toMatchObject({ kind: 'validate-stack', outcome: 'ENV_ERROR' });
      expect(result.log).toContain('ENV_ERROR: executable sha256');
    });
  });

  it('detects modification of the private executable copy after launch', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const binary = join(dir, 'checker');
      await writeFile(binary, '#!/bin/sh\nchmod 700 "$0"\nprintf altered >> "$0"\nexit 0\n');
      await chmod(binary, 0o755);
      const profile = await loadProfile(await profileIn(dir, { executable: binary, argv: [] }));
      await expect(pinnedCheck(profile, jobFor(profile, {}, 'a'.repeat(40)), repo))
        .rejects.toThrow('ENV_ERROR: COMMAND_SWAPPED');
    });
  });

  it('rejects a copy swapped after its hash but before spawn', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const binary = join(dir, 'checker');
      const marker = join(repo, 'executed');
      await writeFile(binary, '#!/bin/sh\nexit 0\n');
      await chmod(binary, 0o755);
      const profile = await loadProfile(await profileIn(dir, { executable: binary, argv: [] }));
      await expect(pinnedCheck(profile, jobFor(profile, {}, 'a'.repeat(40)), repo, 'all', async copy => {
        await chmod(copy, 0o700);
        await writeFile(copy, `#!/bin/sh\nprintf altered > ${JSON.stringify(marker)}\nexit 0\n`);
        await chmod(copy, 0o500);
      })).rejects.toThrow('ENV_ERROR: COMMAND_SWAPPED');
      expect(await readFile(marker, 'utf8')).toBe('altered');
    });
  });

  it('runs the private bytes whose hash is logged if the host source is swapped and restored before spawn', async () => {
    await temporaryWork(async dir => {
      const repo = join(dir, 'candidate');
      await mkdir(repo);
      const binary = join(dir, 'checker');
      const replacement = join(dir, 'replacement');
      const originalBytes = '#!/bin/sh\nprintf original\n';
      await writeFile(binary, originalBytes);
      await writeFile(replacement, '#!/bin/sh\nprintf altered\n');
      await chmod(binary, 0o755);
      await chmod(replacement, 0o755);
      const profile = await loadProfile(await profileIn(dir, { executable: binary, argv: [] }));
      const checked = await pinnedCheck(profile, jobFor(profile, {}, 'a'.repeat(40)), repo, 'all', async () => {
        const displaced = join(dir, 'displaced');
        await rename(binary, displaced);
        await rename(replacement, binary);
        await rename(binary, replacement);
        await rename(displaced, binary);
      });
      expect(checked.outcome).toBe('PASS');
      expect(checked.log).toContain(`exe_sha256=${filePin(originalBytes)}`);
      expect(checked.log).toContain('original');
      expect(checked.log).not.toContain('altered');
    });
  });

  it('generates a loadable command profile from a config file', async () => {
    await temporaryWork(async dir => {
      const config = join(dir, 'config.json');
      const output = join(dir, 'generated.json');
      await writeFile(config, JSON.stringify({ id: 'command-demo', checkerId: 'command-demo',
        timeoutMs: 5000, maxOutputBytes: 4096, ...commandSettings }));
      const result = await command(process.execPath, ['--import', 'tsx', 'runner/main.ts', 'profile',
        '--command-config', config, '--out', output], process.cwd(), 10_000, childEnvironment());
      expect(result.code).toBe(0);
      const profile = await loadProfile(output);
      expect(result.stdout.trim()).toBe(profile.digest);
      expect(profile.checkerDigest).toBe(await digest(commandSettings));
    });
  });

  it('keeps config and job pins across different executable bytes and simulated hosts', async () => {
    await temporaryWork(async dir => {
      const binary = join(dir, 'shell');
      const original = await readFile(executable);
      await writeFile(binary, Buffer.concat([original, Buffer.from('host-one')]));
      await chmod(binary, 0o755);
      const path = await profileIn(dir, { executable: binary });
      const first = await loadProfile(path);
      const firstJob = jobFor(first, {}, 'a'.repeat(40));
      await writeFile(binary, Buffer.concat([original, Buffer.from('host-two')]));
      await chmod(binary, 0o755);
      const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
      const version = Object.getOwnPropertyDescriptor(process, 'version')!;
      try {
        Object.defineProperty(process, 'arch', { configurable: true, value: 'simulated-arch' });
        Object.defineProperty(process, 'version', { configurable: true, value: 'v99.0.0' });
        const second = await loadProfile(path);
        await verifyLocalProfile(second);
        const secondJob = jobFor(second, {}, 'a'.repeat(40));
        expect(second.digest).toBe(first.digest);
        expect(secondJob.profileDigest).toBe(firstJob.profileDigest);
        expect(secondJob.inputDigest).toBe(firstJob.inputDigest);
        expect(secondJob.checkerDigest).toBe(firstJob.checkerDigest);
        expect(secondJob.environmentDigest).toBe(firstJob.environmentDigest);
      } finally {
        Object.defineProperty(process, 'arch', arch);
        Object.defineProperty(process, 'version', version);
      }
    });
  });
});
