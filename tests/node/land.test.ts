import { execFile as callback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvedHead, filesChanged, land, parseAllowed, unitKeys } from '../../cli/land.ts';
import { readAwRun } from '../../cli/aw-run.ts';

const execFile = promisify(callback);
const dirs: string[] = [];
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'land-test-')); dirs.push(dir); return dir; }
async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
  return stdout.trim();
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function source(): Promise<{ dir: string; commit: string; parent: string }> {
  const dir = await temp();
  await git(dir, 'init', '-q');
  await writeFile(join(dir, 'first.txt'), 'original\n');
  await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\talpha\t\n');
  await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
  const parent = await git(dir, 'rev-parse', 'HEAD');
  await writeFile(join(dir, 'first.txt'), 'changed\n');
  await git(dir, 'mv', 'families.tsv', 'renamed.tsv');
  await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'candidate');
  return { dir, parent, commit: await git(dir, 'rev-parse', 'HEAD') };
}

describe('land input and evidence gates', () => {
  it('treats a rename as a deleted and an added path', async () => {
    const { dir, commit, parent } = await source();
    expect(await filesChanged(dir, commit)).toEqual({ parent, files: expect.arrayContaining(['first.txt', 'families.tsv', 'renamed.tsv']) });
  });
  it('rejects an out-of-scope file before any API request', async () => {
    const { dir, commit } = await source();
    const allow = join(dir, 'allowed-files.txt'); await writeFile(allow, 'first.txt\n');
    const request = vi.fn();
    await expect(land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'test', allowedFiles: allow,
      client: { request } as never })).rejects.toThrow('OUTSIDE_ALLOWED_FILES: families.tsv, renamed.tsv');
    expect(request).not.toHaveBeenCalled();
  });
  it('requires one exact reviewed SHA and an approval line', () => {
    const head = 'a'.repeat(40);
    expect(approvedHead(`reviewed ${head}\nAPPROVED for merge`, head)).toBe(true);
    expect(approvedHead(`reviewed ${'b'.repeat(40)}\nAPPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`reviewed ${head} and ${'b'.repeat(40)}\nAPPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`reviewed ${head}`, head)).toBe(false);
  });
  it('reads the validated AW SHA and stable intent key', async () => {
    const dir = await temp(); const sha = 'a'.repeat(40);
    await writeFile(join(dir, 'status.json'), JSON.stringify({ validated_sha: sha, worktree: '/tmp/work', job_id: 'run_123' }));
    await writeFile(join(dir, 'work-spec.md'), 'Goal:\n  Outcome: Ship the command\n  Done when: checked\n');
    await writeFile(join(dir, 'allowed-files.txt'), 'first.txt\n');
    expect(await readAwRun(dir)).toEqual({ source: '/tmp/work', commit: sha, intentKey: 'run_123', intent: 'Ship the command', allowedFiles: join(dir, 'allowed-files.txt') });
    expect(await readFile(join(dir, 'allowed-files.txt'), 'utf8')).toBe('first.txt\n');
  });
  it('validates allowed path syntax', () => {
    expect([...parseAllowed('a.txt\nb/c.txt\n')]).toEqual(['a.txt', 'b/c.txt']);
    expect(() => parseAllowed('../secret\n')).toThrow('invalid path');
  });
  it('maps changed rows through a declared TSV policy', async () => {
    const dir = await temp(); await git(dir, 'init', '-q');
    await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\nalpha\t1\nbeta\t2\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const parent = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\nalpha\t3\nbeta\t2\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'update');
    const head = await git(dir, 'rev-parse', 'HEAD');
    const policy = { tables: [{ name: 'families', file: 'families.tsv', header: ['family', 'retry_limit'], keyColumn: 'family',
      keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } }], units: {} };
    expect(await unitKeys(dir, parent, head, ['families.tsv'], policy)).toEqual(['row:families:alpha']);
  });
});

// A real bridge, Worker, and separate runner verify the orchestration route.
// The runner is pumped once per observed job; land never executes it itself.
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { digest } from '../../src/http.ts';
import { localEnvironment } from '../../runner/profiles.ts';
import { wranglerStateDir } from '../../demo/scenarios.ts';

const services: ChildProcess[] = [];
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}
function service(file: string, args: string[], env: NodeJS.ProcessEnv): () => string {
  const child = spawn(file, args, { cwd: resolve('.'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  services.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', part => { output = (output + part.toString()).slice(-6000); });
  return () => output;
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('local stack startup timed out');
}
afterEach(async () => {
  for (const child of services.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>(done => child.once('close', () => done()));
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await Promise.race([closed, new Promise<void>(done => setTimeout(done, 3000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      await closed;
    }
  }
});

it('lands a generic agent commit through a separate checker, reviewer, queue, and promoter', async () => {
  const dir = await temp();
  const root = resolve('.');
  const bridgePort = await freePort(); const workerPort = await freePort();
  const url = `http://127.0.0.1:${workerPort}`;
  const secret = 'local-bridge-land-fixture';
  const environment = { ...process.env, TMPDIR: dir, XDG_CONFIG_HOME: dir, CONCORD_RUN_DIR: dir,
    CONCORD_URL: url, CONCORD_SHOW_DECOMPILED_C: '0' };
  const binary = `sha256:${createHash('sha256').update(await readFile('/bin/sh')).digest('hex')}`;
  const settings = { executable: '/bin/sh', argv: ['check.sh'], cwd: 'repo' as const, timeoutSeconds: 3,
    env: ['PATH', 'TMPDIR', 'LANG'], outputCap: 4096 };
  const profileInput = { id: 'generic-land', kind: 'command', checkerId: 'generic-land', checkerDigest: binary,
    toolchainDigest: binary, oracleDigest: await digest(settings), environmentDigest: await digest(localEnvironment()),
    timeoutMs: 10_000, maxOutputBytes: 4096, toolchainFile: '/bin/sh', ...settings };
  const profile = { ...profileInput, digest: await digest(profileInput) };
  const profilePath = join(dir, 'profile.json'); await writeFile(profilePath, JSON.stringify(profile));
  const units = Object.fromEntries(['check.sh', 'a.txt', 'b.txt', 'shared.txt'].map(file => [`file:${file}`, {
    canonicalKey: `file:${file}`, file, resources: [], dependencyKeys: [],
  }]));
  const policyInput = { id: 'generic-land', version: 1, checkerId: 'generic-land', checkerDigest: binary,
    acceptance: { kind: 'hard-gates', gates: [{ id: 'default', requiredOutcome: 'PASS' }] }, units };
  const policy = { ...policyInput, digest: await digest(policyInput) };
  const trusted = JSON.stringify({ policies: { 'generic-land': policy }, profiles: { 'generic-land': {
    id: profile.id, digest: profile.digest, toolchainDigest: profile.toolchainDigest,
    oracleDigest: profile.oracleDigest, environmentDigest: profile.environmentDigest,
    timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes,
  } } });
  const bridgeOutput = service(process.execPath, ['--import', 'tsx', 'local/git-bridge.ts'], {
    ...environment, CONCORD_BRIDGE_DATA_DIR: join(dir, 'bridge'), CONCORD_BRIDGE_TOKEN: secret,
    CONCORD_BRIDGE_PORT: String(bridgePort),
  });
  await waitFor(async () => bridgeOutput().includes(`listening on 127.0.0.1:${bridgePort}`));
  const workerOutput = service(join(root, 'node_modules/.bin/wrangler'), ['dev', '--config', 'wrangler.local.jsonc',
    '--port', String(workerPort), '--persist-to', wranglerStateDir(dir), '--var', 'STORAGE_BACKEND:bridge',
    '--var', `BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=${secret}`, '--var', `TRUSTED_CONFIG:${trusted}`],
    { ...environment, WRANGLER_SEND_METRICS: 'false' });
  await waitFor(async () => (await fetch(url + '/health')).ok);
  const api = async (path: string) => fetch(`${url}/v1/repos/landdemo${path}`, {
    headers: { authorization: 'Bearer local-owner' },
  }).then(response => response.json()) as Promise<any>;
  async function drive<T>(work: Promise<T>): Promise<T> {
    let finished = false;
    work.finally(() => { finished = true; }).catch(() => {});
    const handled = new Set<string>(); const until = Date.now() + 150_000;
    while (!finished && Date.now() < until) {
      const snapshot = await api('/snapshot').catch(() => null);
      const pending = snapshot?.data?.projections?.runners?.jobs?.find((job: any) =>
        job.state === 'pending' && !handled.has(job.jobId));
      if (pending) {
        handled.add(pending.jobId);
        const role = pending.kind === 'promote' ? 'promoter' : 'checker';
        const args = ['--import', 'tsx', 'runner/main.ts', '--repo', 'landdemo', '--role', role, '--once'];
        if (role === 'checker') args.push('--profile', profilePath);
        const run = await execFile(process.execPath, args, { cwd: root, env: {
          ...environment, CONCORD_TOKEN: `local-${role}`, CONCORD_PROFILE_DIGEST: profile.digest,
        }, timeout: 40_000 });
        expect(run.stdout).toContain('Completed 1 job(s)');
      } else await new Promise(done => setTimeout(done, 150));
    }
    if (!finished) throw new Error(`runner pump timed out: ${workerOutput()}`);
    return work;
  }
  const seed = await temp();
  await git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'check.sh'), 'exit 0\n');
  await writeFile(join(seed, 'a.txt'), 'a=0\n');
  await writeFile(join(seed, 'b.txt'), 'b=0\n');
  await writeFile(join(seed, 'shared.txt'), Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n') + '\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-qm', 'seed');
  const imported = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'import',
    '--source', seed, '--ref', 'main', '--repo', 'landdemo', '--policy-id', 'generic-land',
    '--profile-id', 'generic-land'], { cwd: root, env: { ...environment, CONCORD_TOKEN: 'local-owner' }, timeout: 150_000 }));
  const importedOid = JSON.parse(imported.stdout).canonicalOid;
  expect((await api('')).data.observedCanonicalOid).toBe(importedOid);
  const canonical = join(dir, 'bridge', (await api('')).data.canonicalStorageName + '.git');
  const sourceDir = await temp();
  await git(sourceDir, 'clone', '-q', '-b', 'main', canonical, '.');
  await writeFile(join(sourceDir, 'a.txt'), 'a=1\n');
  await git(sourceDir, 'add', '.'); await git(sourceDir, 'commit', '-qm', 'agent update');
  const commit = await git(sourceDir, 'rev-parse', 'HEAD');
  const allowed = join(dir, 'allowed.txt'); await writeFile(allowed, 'a.txt\n');
  const evidence = join(dir, 'review.txt'); await writeFile(evidence, `Review of ${commit}\nAPPROVED for merge\n`);
  const baseArgs = ['--repo', 'landdemo', '--source', sourceDir, '--commit', commit, '--intent-key', 'generic-task',
    '--intent', 'Update a value', '--allowed-files', allowed, '--wait-seconds', '150', '--json'];
  const landEnv = { ...environment, CONCORD_TOKEN: 'local-agent-a', CONCORD_REVIEWER_TOKEN: 'local-reviewer' };
  const first = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...baseArgs],
    { cwd: root, env: landEnv, timeout: 155_000 }));
  expect(first.stdout).toContain('"state":"awaiting-review"');
  const beforeResume = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === 'generic-task');
  const wrongEvidence = join(dir, 'wrong-review.txt');
  await writeFile(wrongEvidence, `Review of ${'f'.repeat(40)}\nAPPROVED for merge\n`);
  await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...baseArgs,
    '--review-evidence', wrongEvidence], { cwd: root, env: landEnv, timeout: 30_000 }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('exact published head SHA') });
  await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...baseArgs,
    '--review-evidence', evidence], { cwd: root, env: { ...landEnv, CONCORD_REVIEWER_TOKEN: 'local-agent-a' }, timeout: 30_000 }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('reviewer token must differ') });
  const landed = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land',
    ...baseArgs, '--review-evidence', evidence], { cwd: root, env: landEnv, timeout: 155_000 }))
    .catch(error => { throw new Error(`land failed after: ${(error as { stdout?: string }).stdout ?? ''}\n${(error as Error).message}`); });
  const afterResume = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === 'generic-task');
  expect(afterResume.changeId).toBe(beforeResume.changeId);
  expect(afterResume.revision).toBe(beforeResume.revision);
  const events = landed.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect([...first.stdout.trim().split('\n').map(line => JSON.parse(line)), ...events].map(item => item.state))
    .toEqual(expect.arrayContaining(['created', 'leased', 'published', 'reviewed', 'enqueued', 'landed']));
  expect(events.at(-1).canonicalOid).toBe((await api('')).data.observedCanonicalOid);
  for (const value of ['local-agent-a', 'local-reviewer', secret]) {
    expect(landed.stdout + landed.stderr).not.toContain(value);
  }
  const parallel = await Promise.all(['a.txt', 'b.txt'].map(async (file, index) => {
    const checkout = await temp(); await git(checkout, 'clone', '-q', '-b', 'main', canonical, '.');
    await writeFile(join(checkout, file), `${file}=parallel\n`);
    await git(checkout, 'add', file); await git(checkout, 'commit', '-qm', `parallel ${file}`);
    const oid = await git(checkout, 'rev-parse', 'HEAD');
    const paths = join(dir, `allowed-parallel-${index}.txt`); await writeFile(paths, `${file}\n`);
    const review = join(dir, `review-parallel-${index}.txt`); await writeFile(review, `${oid}\nAPPROVED for merge\n`);
    return { args: ['--repo', 'landdemo', '--source', checkout, '--commit', oid, '--intent-key', `parallel-${index}`,
      '--intent', `Update ${file}`, '--allowed-files', paths, '--wait-seconds', '150', '--json'], review,
      env: { ...environment, CONCORD_TOKEN: index ? 'local-agent-c' : 'local-agent-b', CONCORD_REVIEWER_TOKEN: 'local-reviewer' } };
  }));
  const inspected = await drive(Promise.all(parallel.map(item => execFile(process.execPath,
    ['--import', 'tsx', 'cli/main.ts', 'land', ...item.args], { cwd: root, env: item.env, timeout: 155_000 }))));
  for (const item of inspected) expect(item.stdout).toContain('"state":"awaiting-review"');
  const merged = await drive(Promise.all(parallel.map(item => execFile(process.execPath,
    ['--import', 'tsx', 'cli/main.ts', 'land', ...item.args, '--review-evidence', item.review],
    { cwd: root, env: item.env, timeout: 155_000 }))));
  for (const item of merged) expect(item.stdout).toContain('"state":"landed"');
  expect((await api('')).data.observedCanonicalOid).toMatch(/^[a-f0-9]{40}$/);
  const sameFile = await Promise.all([1, 18].map(async (line, index) => {
    const checkout = await temp(); await git(checkout, 'clone', '-q', '-b', 'main', canonical, '.');
    const text = await readFile(join(checkout, 'shared.txt'), 'utf8');
    await writeFile(join(checkout, 'shared.txt'), text.replace(`line-${line}\n`, `line-${line}-changed\n`));
    await git(checkout, 'add', 'shared.txt'); await git(checkout, 'commit', '-qm', `same file ${index}`);
    const oid = await git(checkout, 'rev-parse', 'HEAD');
    const paths = join(dir, `allowed-shared-${index}.txt`); await writeFile(paths, 'shared.txt\n');
    const review = join(dir, `review-shared-${index}.txt`); await writeFile(review, `${oid}\nAPPROVED for merge\n`);
    return { args: ['--repo', 'landdemo', '--source', checkout, '--commit', oid, '--intent-key', `shared-${index}`,
      '--intent', `Edit shared line ${line}`, '--allowed-files', paths, '--wait-seconds', '150', '--json'], review,
      env: { ...environment, CONCORD_TOKEN: index ? 'local-agent-c' : 'local-agent-b', CONCORD_REVIEWER_TOKEN: 'local-reviewer' } };
  }));
  const firstShared = execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...sameFile[0].args,
    '--review-evidence', sameFile[0].review], { cwd: root, env: sameFile[0].env, timeout: 155_000 });
  await waitFor(async () => (await api('/leases')).data.items.some((item: any) =>
    item.unitKey === 'file:shared.txt' && item.state === 'active'));
  const secondShared = execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...sameFile[1].args],
    { cwd: root, env: sameFile[1].env, timeout: 155_000 });
  const [firstResult, secondResult] = await drive(Promise.all([firstShared, secondShared]));
  expect(firstResult.stdout).toContain('"state":"landed"');
  expect(secondResult.stdout).toContain('"state":"LEASE_CONFLICT"');
  expect(secondResult.stdout).toContain('Edit shared line 1');
  const secondEvents = secondResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  const approved = secondEvents.find(item => item.state === 'awaiting-review');
  expect(approved.headOid).toMatch(/^[a-f0-9]{40}$/);
  await writeFile(sameFile[1].review, `${approved.headOid}\nAPPROVED for merge\n`);
  const secondLanded = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land',
    ...sameFile[1].args, '--review-evidence', sameFile[1].review],
  { cwd: root, env: sameFile[1].env, timeout: 155_000 }));
  expect(secondLanded.stdout).toContain('"state":"landed"');
}, 240_000);
