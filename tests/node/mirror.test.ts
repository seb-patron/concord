import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, mirrorGit, validateDemoRemote } from '../../deploy/mirror.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mockMirrorApi(onToken: (body: Record<string, unknown>, key: string | null) => Response) {
  vi.stubEnv('CONCORD_URL', 'https://concord.test');
  vi.stubEnv('CONCORD_TOKEN', 'owner-token');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/repos/demo' && init?.method === 'GET') return Response.json({ version: 17, data: {
      status: 'ready', version: 4, canonicalStorageName: 'canonical', observedCanonicalOid: 'a'.repeat(40),
    } });
    if (path === '/v1/repos/demo/git-token' && init?.method === 'POST') {
      return onToken(JSON.parse(String(init.body)) as Record<string, unknown>, new Headers(init.headers).get('idempotency-key'));
    }
    throw new Error(`unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const mirrorArgs = ['--repo', 'demo', '--remote', 'https://github.com/example/demo.git', '--dry-run'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Mirror Test', GIT_AUTHOR_EMAIL: 'mirror@example.test',
    GIT_COMMITTER_NAME: 'Mirror Test', GIT_COMMITTER_EMAIL: 'mirror@example.test',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  } }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'concord-mirror-test-'));
  directories.push(root);
  const work = join(root, 'work');
  const source = join(root, 'source.git');
  const destination = join(root, 'destination.git');
  git(root, 'init', '--quiet', '--bare', source);
  git(root, 'init', '--quiet', '--bare', destination);
  git(root, 'init', '--quiet', '-b', 'main', work);
  await writeFile(join(work, 'sample.txt'), 'first\n');
  git(work, 'add', 'sample.txt');
  git(work, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'seed');
  const first = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', source, 'HEAD:refs/heads/main');
  return { root, work, source: pathToFileURL(source).href, destination: pathToFileURL(destination).href, first };
}

describe('one-way mirror', () => {
  it('requests a Git token with the coordinator envelope version, not the catalog repo version', async () => {
    const bodies: Record<string, unknown>[] = [];
    mockMirrorApi((body) => {
      bodies.push(body);
      return body.expectedVersion === 17
        ? Response.json({ data: { remote: 'file:///nonexistent/concord-mirror-test.git', secret: 'read-token' } })
        : Response.json({ error: { code: 'STALE_VERSION' } }, { status: 409 });
    });
    await main(mirrorArgs);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ storageName: 'canonical', scope: 'read', ttlSeconds: 300, expectedVersion: 17 });
  });

  it('uses a fresh token request key for each invocation and retains it across a retry', async () => {
    const keys: (string | null)[] = [];
    mockMirrorApi((_body, key) => {
      keys.push(key);
      return keys.length % 2 === 1
        ? Response.json({ error: { code: 'TEMPORARY' } }, { status: 503 })
        : Response.json({ data: { remote: 'file:///nonexistent/concord-mirror-test.git', secret: 'read-token' } });
    });
    await main(mirrorArgs);
    await main(mirrorArgs);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(/^mirror-read-demo-[0-9a-f-]{36}$/);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('requires an owner-supplied credential-free GitHub demo URL', () => {
    expect(validateDemoRemote('https://github.com/example/dispatch-lab.git')).toBe('https://github.com/example/dispatch-lab.git');
    for (const value of ['https://token@github.com/a/b.git', 'https://github.com/a/b.git?token=x', 'https://evil.example/a/b.git', 'git@github.com:a/b.git', 'https://github.com/a/../b.git']) {
      expect(() => validateDemoRemote(value)).toThrow();
    }
  });

  it('defaults to dry run, then pushes only main and reads back the exact SHA', async () => {
    const f = await fixture();
    const input = { sourceRemote: f.source, sourceOid: f.first, destinationRemote: f.destination };
    expect(await mirrorGit(input)).toEqual({ sourceOid: f.first, destinationOid: null, action: 'create', executed: false });
    expect(git(f.root, 'ls-remote', '--heads', f.destination)).toBe('');
    expect(await mirrorGit({ ...input, execute: true })).toEqual({ sourceOid: f.first, destinationOid: null, action: 'create', executed: true });
    expect(git(f.root, 'ls-remote', '--heads', f.destination)).toBe(`${f.first}\trefs/heads/main`);
    expect(await mirrorGit(input)).toEqual({ sourceOid: f.first, destinationOid: f.first, action: 'already-current', executed: false });
  });

  it('blocks divergence and a stale confirmed canonical SHA without changing either remote', async () => {
    const f = await fixture();
    await mirrorGit({ sourceRemote: f.source, sourceOid: f.first, destinationRemote: f.destination, execute: true });
    await writeFile(join(f.work, 'sample.txt'), 'second\n');
    git(f.work, 'add', 'sample.txt');
    git(f.work, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'second');
    const second = git(f.work, 'rev-parse', 'HEAD');
    git(f.work, 'push', f.source.replace('file://', ''), 'HEAD:refs/heads/main');
    await expect(mirrorGit({ sourceRemote: f.source, sourceOid: f.first, destinationRemote: f.destination })).rejects.toThrow(/no longer matches/);
    // An independent destination commit is never overwritten by a source advancement.
    const other = join(f.root, 'other');
    git(f.root, 'clone', '--quiet', '--branch', 'main', f.destination, other);
    await writeFile(join(other, 'other.txt'), 'other\n');
    git(other, 'add', 'other.txt');
    git(other, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'diverge');
    git(other, 'push', f.destination.replace('file://', ''), 'HEAD:refs/heads/main');
    const before = git(f.root, 'ls-remote', f.destination, 'refs/heads/main');
    await expect(mirrorGit({ sourceRemote: f.source, sourceOid: second, destinationRemote: f.destination, execute: true })).rejects.toThrow(/diverged/);
    expect(git(f.root, 'ls-remote', f.destination, 'refs/heads/main')).toBe(before);
  });
});
