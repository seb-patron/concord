import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareLocal, wranglerStateDir } from '../../demo/scenarios';
import { importRepo } from '../../cli/import.ts';

const execFile = promisify(execFileCallback);
const cwd = realpathSync(resolve('.'));
const wrangler = join(cwd, 'node_modules/.bin/wrangler');
const dirs: string[] = [];
const children: ChildProcess[] = [];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Import Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Import Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd: directory, env: gitEnv, timeout: 30_000 })).stdout.trim();
}
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'concord-import-test-'));
  dirs.push(path);
  return path;
}
async function fixture(root: string): Promise<{ source: string; sourceOid: string }> {
  const source = join(root, 'source');
  await mkdir(source);
  await git(source, 'init', '--quiet', '-b', 'main');
  for (const name of ['families.tsv', 'dispatch.mjs', 'README.md']) {
    await copyFile(join(cwd, 'demo/dispatch-lab', name), join(source, name));
  }
  await git(source, 'add', '.');
  await git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'first');
  await mkdir(join(source, 'private'));
  await writeFile(join(source, 'private', 'secret.txt'), 'private fixture\n');
  await git(source, 'add', '.');
  await git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'second');
  return { source, sourceOid: await git(source, 'rev-parse', 'HEAD') };
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const value = server.address();
  if (!value || typeof value === 'string') throw new Error('port unavailable');
  await new Promise<void>(done => server.close(() => done()));
  return value.port;
}
function start(file: string, args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', part => { output = (output + part.toString()).slice(-10_000); });
  return { child, output: () => output };
}
async function waitFor<T>(action: () => Promise<T>, accept: (value: T) => boolean, output: () => string): Promise<T> {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try { const value = await action(); if (accept(value)) return value; } catch { /* service starting */ }
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('local stack timeout: ' + output());
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(done => child.once('close', () => done()));
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([closed, new Promise<void>(done => setTimeout(done, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    await closed;
  }
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

describe('adopted root import', () => {
  it('builds a filtered tree offline, rejects missing exclusions and symlinks', async () => {
    const root = await temporary();
    const { source } = await fixture(root);
    const fetcher = vi.fn(() => { throw new Error('API contacted during dry run'); });
    vi.stubGlobal('fetch', fetcher);
    const options = { source, ref: 'main', repo: 'adopted', excludes: ['private/**'], printTree: true };
    const tree = await importRepo(options);
    expect(tree).toMatchObject({ fileCount: 3, excludedPathCount: 1 });
    expect(tree.treeOid).toMatch(/^[a-f0-9]{40}$/);
    expect(JSON.stringify(tree)).not.toContain('secret.txt');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(importRepo({ ...options, excludeFile: join(root, 'missing') })).rejects.toThrow(/exclude-file/);
    await symlink('families.tsv', join(source, 'link'));
    await git(source, 'add', 'link');
    await git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'link');
    await expect(importRepo(options)).rejects.toThrow(/symlink/);
  });

  it('imports through the local bridge and Worker as one canonical root, then reconciles', async () => {
    const root = await temporary();
    const { source, sourceOid } = await fixture(root);
    const bridgePort = await port();
    const workerPort = await port();
    const url = `http://127.0.0.1:${workerPort}`;
    const env = { ...process.env, TMPDIR: root, XDG_CONFIG_HOME: root, CONCORD_RUN_DIR: root,
      CONCORD_URL: url, CONCORD_TOKEN: 'local-owner', CONCORD_SHOW_DECOMPILED_C: '0' };
    const { profile, trustedConfig } = await prepareLocal(root);
    const bridge = start(process.execPath, ['--import', 'tsx', 'local/git-bridge.ts'],
      { ...env, CONCORD_BRIDGE_DATA_DIR: join(root, 'bridge'), CONCORD_BRIDGE_TOKEN: 'local-bridge-fixture-2026',
        CONCORD_BRIDGE_PORT: String(bridgePort) });
    await waitFor(async () => bridge.output().includes(`listening on 127.0.0.1:${bridgePort}`), Boolean, bridge.output);
    const worker = start(wrangler, ['dev', '--config', 'wrangler.local.jsonc', '--port', String(workerPort),
      '--persist-to', wranglerStateDir(root), '--var', 'STORAGE_BACKEND:bridge',
      '--var', `BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=local-bridge-fixture-2026`,
      '--var', `TRUSTED_CONFIG:${trustedConfig.trim()}`], { ...env, WRANGLER_SEND_METRICS: 'false' });
    await waitFor(async () => (await fetch(url + '/health')).ok, Boolean, worker.output);
    const args = ['cli/main.ts', 'import', '--source', source, '--ref', 'main', '--repo', 'adopted',
      '--policy-id', 'dispatch-lab', '--profile-id', 'dispatch-lab', '--exclude', 'private/**'];
    const invocation = execFile(process.execPath, ['--import', 'tsx', ...args],
      { cwd, env, timeout: 180_000, maxBuffer: 1024 * 1024 });
    const api = async (path: string) => {
      const response = await fetch(url + '/v1/repos/adopted' + (path ? '/' + path : ''),
        { headers: { authorization: 'Bearer local-owner' } });
      return response.ok ? response.json() as Promise<any> : null;
    };
    let finished = false;
    invocation.finally(() => { finished = true; }).catch(() => {});
    const until = Date.now() + 150_000;
    const handled = new Set<string>();
    while (!finished && Date.now() < until) {
      const snapshot = await api('snapshot').catch(() => null);
      const pending = snapshot?.data?.projections?.runners?.jobs?.find((job: any) =>
        job.state === 'pending' && !handled.has(job.jobId));
      if (pending) {
        handled.add(pending.jobId);
        const role = pending.kind === 'promote' ? 'promoter' : 'checker';
        const runnerArgs = ['runner/main.ts', '--repo', 'adopted', '--role', role, '--once'];
        if (role === 'checker') runnerArgs.push('--profile', profile.sourcePath!);
        const run = await execFile(process.execPath, ['--import', 'tsx', ...runnerArgs],
          { cwd, env: { ...env, CONCORD_TOKEN: `local-${role}`, CONCORD_PROFILE_DIGEST: profile.digest },
            timeout: 40_000, maxBuffer: 1024 * 1024 });
        expect(run.stdout).toContain('Completed 1 job(s)');
      } else await new Promise(done => setTimeout(done, 150));
    }
    const first = await invocation;
    expect(first.stdout).not.toContain('local-owner');
    expect(first.stderr).not.toContain('local-owner');
    const imported = JSON.parse(first.stdout) as { canonicalOid: string; treeOid: string };
    const detail = (await api(''))?.data;
    expect(detail.observedCanonicalOid).toBe(imported.canonicalOid);
    const canonical = join(root, 'bridge', detail.canonicalStorageName + '.git');
    expect(await git(root, '--git-dir', canonical, 'rev-list', '--count', 'refs/heads/main')).toBe('1');
    expect(await git(root, '--git-dir', canonical, 'rev-parse', 'refs/heads/main^{tree}')).toBe(imported.treeOid);
    expect(await git(root, '--git-dir', canonical, 'show', '-s', '--format=%B', 'refs/heads/main')).toContain(sourceOid);
    await expect(git(root, '--git-dir', canonical, 'show', 'main:private/secret.txt')).rejects.toThrow();
    const second = await execFile(process.execPath, ['--import', 'tsx', ...args],
      { cwd, env, timeout: 40_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(second.stdout)).toMatchObject({ canonicalOid: imported.canonicalOid, reconciled: true });
    expect(await git(root, '--git-dir', canonical, 'rev-list', '--count', 'refs/heads/main')).toBe('1');
  }, 210_000);
});
