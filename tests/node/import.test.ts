import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareLocal, wranglerStateDir } from '../../demo/scenarios';
import { ConcordClient } from '../../cli/client.ts';
import { gitEnvironment } from '../../cli/git.ts';
import { importRepo } from '../../cli/import.ts';
import { mirrorGit } from '../../deploy/mirror.ts';

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
async function mergeFixture(root: string): Promise<{ source: string; sourceOid: string; ancestor: string }> {
  const source = join(root, 'source');
  await mkdir(source);
  await git(source, 'init', '--quiet', '-b', 'main');
  for (const name of ['families.tsv', 'dispatch.mjs', 'README.md']) {
    await copyFile(join(cwd, 'demo/dispatch-lab', name), join(source, name));
  }
  await git(source, 'add', '.');
  await git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'first');
  const ancestor = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'switch', '-c', 'feature');
  await writeFile(join(source, 'feature.txt'), 'feature\n');
  await git(source, 'add', 'feature.txt');
  await git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'feature');
  await git(source, 'switch', 'main');
  await git(source, '-c', 'core.hooksPath=/dev/null', 'merge', '--quiet', '--no-ff', 'feature', '-m', 'merge feature');
  return { source, sourceOid: await git(source, 'rev-parse', 'HEAD'), ancestor };
}
async function partialClone(root: string, source: string, checkout = false): Promise<string> {
  const partial = join(root, 'partial');
  await execFile('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout',
    '--upload-pack=git -c uploadpack.allowFilter=true upload-pack',
    pathToFileURL(source).href, partial], { cwd: root, env: gitEnv, timeout: 30_000 });
  if (!checkout) {
    const missing = await execFile('git', ['rev-list', '--objects', '--missing=print', 'HEAD'], {
      cwd: partial, env: { ...gitEnv, GIT_NO_LAZY_FETCH: '1' }, timeout: 30_000 });
    expect(missing.stdout).toMatch(/\?[a-f0-9]{40}/);
    const listing = await execFile('git', ['ls-tree', '-r', '-l', 'HEAD'], { cwd: partial,
      env: { ...gitEnv, GIT_NO_LAZY_FETCH: '1' }, timeout: 30_000 });
    expect(listing.stdout).toMatch(/ (?:-|BAD)\t/);
  }
  if (checkout) await git(partial, 'checkout', '--force', 'main');
  else await execFile('git', ['read-tree', 'HEAD'], { cwd: partial,
    env: { ...gitEnv, GIT_NO_LAZY_FETCH: '1' }, timeout: 30_000 });
  const packs = await readdir(join(partial, '.git', 'objects', 'pack'));
  expect(packs.some(name => name.endsWith('.promisor'))).toBe(true);
  expect(await git(partial, 'config', '--get', 'remote.origin.promisor')).toBe('true');
  return partial;
}
async function fileTree(directory: string): Promise<Record<string, Buffer | null>> {
  const result: Record<string, Buffer | null> = {};
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        result[relative + '/'] = null;
        await visit(join(path, entry.name), relative + '/');
      } else result[relative] = await readFile(join(path, entry.name));
    }
  }
  await visit(directory, '');
  return result;
}
async function sourceState(source: string): Promise<unknown> {
  const gitDir = join(source, '.git');
  return {
    objects: await fileTree(join(gitDir, 'objects')),
    refs: await fileTree(join(gitDir, 'refs')),
    index: await readFile(join(gitDir, 'index')),
    head: await readFile(join(gitDir, 'HEAD')),
    packedRefs: await readFile(join(gitDir, 'packed-refs')).catch(() => null),
  };
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
async function importWithLocalStack(root: string, source: string, extraArgs: string[]) {
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
    '--policy-id', 'dispatch-lab', '--profile-id', 'dispatch-lab', ...extraArgs];
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
  const imported = JSON.parse(first.stdout) as { canonicalOid: string; treeOid: string };
  const detail = (await api(''))?.data;
  const canonical = join(root, 'bridge', detail.canonicalStorageName + '.git');
  return { args, env, first, imported, detail, canonical };
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('adopted root import', () => {
  it('keeps source objects, index and refs byte-identical when the filtered tree already exists', async () => {
    const root = await temporary();
    const { source } = await fixture(root);
    const index = join(source, '.git', 'index');
    const before = await sourceState(source);
    const result = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'import',
      '--source', source, '--ref', 'main', '--repo', 'adopted', '--exclude', 'private/**', '--print-tree'], {
      cwd, env: { ...gitEnv, GIT_DIR: join(source, '.git'), GIT_INDEX_FILE: index }, timeout: 30_000,
    });
    const tree = JSON.parse(result.stdout);
    expect(tree).toMatchObject({ fileCount: 3, excludedPathCount: 1 });
    expect(await git(source, 'cat-file', '-t', String(tree.treeOid))).toBe('tree');
    expect(await sourceState(source)).toEqual(before);
    expect(await git(source, 'status', '--short')).toBe('');
  });

  it('removes inherited Git variables before adding importer owned settings', () => {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME']) {
      vi.stubEnv(name, 'inherited');
    }
    const clean = gitEnvironment();
    expect(Object.keys(clean).filter(name => /^GIT_/i.test(name)).sort()).toEqual([
      'GIT_CONFIG_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'GIT_TERMINAL_PROMPT']);
    const configured = gitEnvironment({ token: 'test-token', alternateObjectDirectory: '/scratch/objects',
      indexFile: '/scratch/index', identity: true, noLazyFetch: true });
    expect(configured).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer test-token', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/scratch/objects',
      GIT_INDEX_FILE: '/scratch/index', GIT_AUTHOR_NAME: 'Concord Import', GIT_NO_LAZY_FETCH: '1' });
    expect(configured.GIT_DIR).toBeUndefined();
    expect(configured.GIT_WORK_TREE).toBeUndefined();
    expect(configured.GIT_OBJECT_DIRECTORY).toBeUndefined();
  });

  it('builds a filtered tree offline, rejects missing exclusions and symlinks', async () => {
    const root = await temporary();
    const { source } = await fixture(root);
    await writeFile(join(source, 'added.txt'), 'new included file\n');
    await git(source, 'add', 'added.txt');
    await git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'added');
    const before = await sourceState(source);
    vi.stubEnv('GIT_DIR', join(source, '.git'));
    vi.stubEnv('GIT_INDEX_FILE', join(source, '.git', 'index'));
    const fetcher = vi.fn(() => { throw new Error('API contacted during dry run'); });
    vi.stubGlobal('fetch', fetcher);
    const options = { source, ref: 'main', repo: 'adopted', excludes: ['private/**'], printTree: true };
    const tree = await importRepo(options);
    expect(tree).toMatchObject({ fileCount: 4, excludedPathCount: 1 });
    await expect(git(source, 'cat-file', '-e', String(tree.treeOid))).rejects.toThrow();
    expect(await sourceState(source)).toEqual(before);
    expect(JSON.stringify(tree)).not.toContain('secret.txt');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(importRepo({ ...options, excludeFile: join(root, 'missing') })).rejects.toThrow(/exclude-file/);
    await symlink('families.tsv', join(source, 'link'));
    await git(source, 'add', 'link');
    await git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'link');
    await expect(importRepo(options)).rejects.toThrow(/symlink/);
  });

  it('rejects exclusions with history mode as a CLI usage error', async () => {
    const root = await temporary();
    const { source } = await fixture(root);
    const args = ['--import', 'tsx', 'cli/main.ts', 'import', '--source', source, '--ref', 'main',
      '--repo', 'adopted', '--with-history', '--print-tree'];
    for (const extra of [['--exclude', 'private/**'], ['--exclude-file', join(root, 'missing')]]) {
      await expect(execFile(process.execPath, [...args, ...extra], { cwd, env: gitEnv, timeout: 30_000 }))
        .rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/--with-history cannot be combined/) });
    }
  });

  it('does not fetch unavailable blobs from a local promisor remote', async () => {
    const root = await temporary();
    const original = await fixture(root);
    const source = await partialClone(root, original.source);
    const before = await sourceState(source);
    const args = ['--import', 'tsx', 'cli/main.ts', 'import', '--source', source, '--ref', 'main',
      '--repo', 'adopted', '--print-tree'];
    await expect(execFile(process.execPath, args, { cwd, env: gitEnv, timeout: 30_000 }))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/unavailable locally/) });
    expect(await sourceState(source)).toEqual(before);
    const fetcher = vi.fn(() => { throw new Error('API contacted for unavailable blob'); });
    const client = new ConcordClient({ url: 'http://127.0.0.1:1', fetch: fetcher });
    await expect(importRepo({ source, ref: 'main', repo: 'adopted', policyId: 'policy',
      profileId: 'profile' }, client)).rejects.toThrow(/unavailable locally/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await sourceState(source)).toEqual(before);
  });

  it('rejects malformed exclusion bytes before contacting Concord', async () => {
    const root = await temporary();
    const { source } = await fixture(root);
    const excludeFile = join(root, 'excludes');
    await writeFile(excludeFile, Buffer.concat([Buffer.from('private/**'), Buffer.from([0xff])]));
    const fetcher = vi.fn(() => { throw new Error('API contacted for invalid exclusions'); });
    const client = new ConcordClient({ url: 'http://127.0.0.1:1', fetch: fetcher });
    await expect(importRepo({ source, ref: 'main', repo: 'adopted', policyId: 'policy',
      profileId: 'profile', excludeFile }, client)).rejects.toThrow(/valid UTF-8/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires the source repository top level', async () => {
    const root = await temporary();
    const { source } = await fixture(root);
    await expect(importRepo({ source: join(source, 'private'), ref: 'main', repo: 'adopted',
      printTree: true })).rejects.toThrow(/top level/);
  });

  it('reports unmatched exclusions and can require each pattern to match', async () => {
    const root = await temporary();
    const { source } = await fixture(root);
    const options = { source, ref: 'main', repo: 'adopted', printTree: true,
      excludes: ['private/**', 'absent/**'] };
    await expect(importRepo(options)).resolves.toMatchObject({ excludedPathCount: 1,
      unmatchedPatterns: ['absent/**'] });
    await expect(importRepo({ ...options, requireMatch: true })).rejects.toThrow(/matches no paths/);
    await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'import', '--source', source,
      '--ref', 'main', '--repo', 'adopted', '--exclude', 'absent/**', '--require-match', '--print-tree'],
    { cwd, env: gitEnv, timeout: 30_000 })).rejects.toMatchObject({ code: 2 });
    await expect(importRepo({ ...options, excludes: [''] })).rejects.toThrow(/Invalid exclusion glob/);
    await expect(importRepo({ ...options, excludes: ['private//secret.txt'] })).rejects.toThrow(/Invalid exclusion glob/);
  });

  it('imports through the local bridge and Worker as one canonical root, then reconciles', async () => {
    const root = await temporary();
    const { source: original, sourceOid } = await fixture(root);
    const source = await partialClone(root, original, true);
    const beforeSource = await sourceState(source);
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
    expect(await sourceState(source)).toEqual(beforeSource);
    expect(first.stdout).not.toContain('local-owner');
    expect(first.stderr).not.toContain('local-owner');
    const imported = JSON.parse(first.stdout) as { canonicalOid: string; treeOid: string };
    const detail = (await api(''))?.data;
    expect(detail.observedCanonicalOid).toBe(imported.canonicalOid);
    const canonical = join(root, 'bridge', detail.canonicalStorageName + '.git');
    expect(await git(root, '--git-dir', canonical, 'rev-list', '--count', 'refs/heads/main')).toBe('1');
    const sourceWithoutExcludedPaths = await git(source, 'rev-parse', 'HEAD~1^{tree}');
    expect(imported.treeOid).toBe(sourceWithoutExcludedPaths);
    expect(await git(root, '--git-dir', canonical, 'rev-parse', 'refs/heads/main^{tree}')).toBe(sourceWithoutExcludedPaths);
    expect(await git(root, '--git-dir', canonical, 'show', '-s', '--format=%B', 'refs/heads/main')).toContain(sourceOid);
    await expect(git(root, '--git-dir', canonical, 'show', 'main:private/secret.txt')).rejects.toThrow();
    const second = await execFile(process.execPath, ['--import', 'tsx', ...args],
      { cwd, env, timeout: 40_000, maxBuffer: 1024 * 1024 });
    expect(await sourceState(source)).toEqual(beforeSource);
    expect(JSON.parse(second.stdout)).toMatchObject({ canonicalOid: imported.canonicalOid, reconciled: true });
    expect(await git(root, '--git-dir', canonical, 'rev-list', '--count', 'refs/heads/main')).toBe('1');
  }, 210_000);

  it('imports a three-commit merge unchanged and can mirror to an ancestor', async () => {
    const root = await temporary();
    const { source, sourceOid, ancestor } = await mergeFixture(root);
    expect(await git(source, 'rev-list', '--count', sourceOid)).toBe('3');
    expect((await git(source, 'rev-list', '--parents', '-n', '1', sourceOid)).split(' ')).toHaveLength(3);
    const beforeSource = await sourceState(source);
    const { args, env, first, imported, detail, canonical } = await importWithLocalStack(root, source, ['--with-history']);
    expect(first.stderr).not.toContain('local-owner');
    expect(imported.canonicalOid).toBe(sourceOid);
    expect(detail.observedCanonicalOid).toBe(sourceOid);
    expect(await git(root, '--git-dir', canonical, 'rev-list', '--count', 'refs/heads/main')).toBe('3');
    expect(await git(root, '--git-dir', canonical, 'rev-parse', 'refs/heads/main')).toBe(sourceOid);
    expect(await sourceState(source)).toEqual(beforeSource);
    const second = await execFile(process.execPath, ['--import', 'tsx', ...args],
      { cwd, env, timeout: 40_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(second.stdout)).toMatchObject({ canonicalOid: sourceOid, reconciled: true });

    const destination = join(root, 'destination.git');
    await git(root, 'init', '--quiet', '--bare', destination);
    await git(source, 'push', destination, `${ancestor}:refs/heads/main`);
    const input = { sourceRemote: pathToFileURL(canonical).href, sourceOid,
      destinationRemote: pathToFileURL(destination).href };
    expect(await mirrorGit(input)).toMatchObject({ destinationOid: ancestor, action: 'advance', executed: false });
    expect(await mirrorGit({ ...input, execute: true })).toMatchObject({ destinationOid: ancestor, action: 'advance', executed: true });
    expect(await git(root, '--git-dir', destination, 'rev-parse', 'refs/heads/main')).toBe(sourceOid);
  }, 210_000);
});
