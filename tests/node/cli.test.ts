import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ConcordClient, ConcordError } from '../../cli/client.ts';
import { git, pushCandidate, rejectCanonicalTarget, resolveHead } from '../../cli/git.ts';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `concord-${label}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Concord agent CLI client', () => {
  it('drives a complete fake transport lifecycle with JSON envelopes', async () => {
    const state: { repo?: string; change?: string; lease?: string; queue?: string } = {};
    const calls: Array<{ method: string; path: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname });
      const respond = (data: unknown, status = 200) => new Response(JSON.stringify({ data, version: 1, eventSeq: calls.length }), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/v1/repos' && method === 'POST') { state.repo = 'repo-1'; return respond({ repoId: state.repo }); }
      if (url.pathname === '/v1/repos' && method === 'GET') return respond({ items: [{ repoId: state.repo }] });
      if (url.pathname.endsWith('/changes') && method === 'POST') { state.change = 'change-1'; return respond({ changeId: state.change }); }
      if (url.pathname.endsWith('/leases') && method === 'POST') { state.lease = 'lease-1'; return respond({ leaseId: state.lease, fence: 1 }); }
      if (url.pathname.endsWith('/publish') && method === 'POST') return respond({ status: 'ready' });
      if (url.pathname.endsWith('/enqueue') && method === 'POST') { state.queue = 'queued'; return respond({ state: state.queue }); }
      if (url.pathname.endsWith('/events')) return respond({ items: [{ sequence: 1 }] });
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'missing' }, requestId: 'r1' }), { status: 404 });
    };
    const client = new ConcordClient({ url: 'https://concord.invalid', token: 'test-token', fetch: fetcher });
    await client.request('POST', '/repos', { body: { name: 'test', policyId: 'p', profileId: 'f' }, idempotencyKey: 'repo-key' });
    await client.request('GET', '/repos');
    await client.request('POST', '/repos/repo-1/changes', { body: { intentKey: 'stable', intentText: 'change', baseOid: 'abc', branch: 'agent', unitKeys: ['unit:a'], dependencyChangeIds: [] }, idempotencyKey: 'change-key' });
    await client.request('POST', '/repos/repo-1/leases', { body: { changeId: 'change-1', unitKeys: ['unit:a'], intentText: 'change' }, idempotencyKey: 'lease-key' });
    await client.request('POST', '/repos/repo-1/changes/change-1/publish', { body: { baseOid: 'abc', headOid: 'def', branch: 'agent', unitKeys: ['unit:a'], leaseFences: { 'unit:a': 1 } }, idempotencyKey: 'publish-key' });
    await client.request('POST', '/repos/repo-1/queue/enqueue', { body: { changeId: 'change-1', verdictId: 'v1', leaseFences: { 'unit:a': 1 } }, idempotencyKey: 'queue-key' });
    await client.request('GET', '/repos/repo-1/events?after=0');
    expect(state).toEqual({ repo: 'repo-1', change: 'change-1', lease: 'lease-1', queue: 'queued' });
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET', 'POST', 'POST', 'POST', 'POST', 'GET']);
  });

  it('preserves lease refusal details and maps version conflict to exit 3', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: { code: 'LEASE_CONFLICT', message: 'unit held', details: { holderId: 'agent-b', intentText: 'repair gamma' } }, requestId: 'r-conflict' }), { status: 409 });
    const client = new ConcordClient({ url: 'https://concord.invalid', fetch: fetcher });
    await expect(client.request('POST', '/repos/r/leases', { body: {}, idempotencyKey: 'same-key' })).rejects.toMatchObject({ kind: 'conflict', exitCode: 3, payload: { error: { details: { intentText: 'repair gamma' } } } });
  });

  it('preserves an expected-version conflict as a structured 409', async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ expectedVersion: 7 });
      return new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'expected version is stale', details: { currentVersion: 8 } }, requestId: 'r-version' }), { status: 409 });
    };
    const client = new ConcordClient({ url: 'https://concord.invalid', fetch: fetcher });
    await expect(client.request('POST', '/repos/r/changes/c/close', { body: { reason: 'close' }, expectedVersion: 7, idempotencyKey: 'version-key' }))
      .rejects.toMatchObject({ kind: 'conflict', status: 409, payload: { error: { details: { currentVersion: 8 } } } });
  });

  it('keeps stable identity after the server commits but the response is lost', async () => {
    let committed = false;
    const keys: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (!committed) { committed = true; throw new TypeError('lost response'); }
      return new Response(JSON.stringify({ data: { changeId: 'same-change' }, version: 1, eventSeq: 2 }), { status: 200 });
    };
    const client = new ConcordClient({ url: 'https://concord.invalid', fetch: fetcher, sleep: async () => {} });
    const result = await client.request<{ data: { changeId: string } }>('POST', '/repos/r/changes', { body: { intentKey: 'intent-1' }, idempotencyKey: 'retry-this-key' });
    expect(result.data.changeId).toBe('same-change');
    expect(keys).toEqual(['retry-this-key', 'retry-this-key']);
  });

  it('classifies expired identity as auth and redacts bearer credentials from transport diagnostics', async () => {
    const expired = new ConcordClient({ url: 'https://concord.invalid', token: 'expired-secret', fetch: async () => new Response(JSON.stringify({ error: { message: 'expired-secret' } }), { status: 401 }) });
    await expect(expired.request('GET', '/repos')).rejects.toMatchObject({ kind: 'auth', exitCode: 4 });
    try { await expired.request('GET', '/repos'); } catch (error) {
      expect(JSON.stringify((error as ConcordError).payload)).not.toContain('expired-secret');
    }
    const broken = new ConcordClient({ url: 'https://concord.invalid', token: 'private-token', fetch: async () => { throw new Error('request failed with Bearer private-token'); }, sleep: async () => {} });
    try { await broken.request('GET', '/repos'); } catch (error) {
      expect(error).toBeInstanceOf(ConcordError);
      expect((error as Error).message).not.toContain('private-token');
      expect((error as Error).message).toContain('[REDACTED]');
    }
  });

  it('keeps CLI JSON stdout separate from structured stderr and server exit status', async () => {
    const server = await import('node:http').then(({ createServer }) => createServer((_request, response) => {
      response.writeHead(501, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'MODULE_UNAVAILABLE', message: 'Feature is not implemented' }, requestId: 'unavailable-1' }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    try {
      await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'repo', 'list'], {
        cwd: process.cwd(), env: { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'test-token' },
      })).rejects.toMatchObject({ code: 5, stdout: '', stderr: expect.stringContaining('MODULE_UNAVAILABLE') });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('uses argv safely with worktree paths containing spaces', async () => {
    const root = await tempDir('git path with spaces');
    const worktree = join(root, 'agent worktree with spaces');
    await mkdir(worktree);
    await git(['init', '-b', 'main', worktree]);
    await writeFile(join(worktree, 'source.txt'), 'seed\n');
    await git(['add', '--', 'source.txt'], {}, worktree);
    await git(['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.invalid', 'commit', '-m', 'seed'], {}, worktree);
    expect(await resolveHead(worktree)).toMatch(/^[0-9a-f]{40,64}$/i);
  });

  it('rejects canonical push targets before invoking Git', () => {
    expect(() => rejectCanonicalTarget('repo-main', 'repo-main', 'https://git.invalid/main.git')).toThrow(/canonical/);
    expect(() => rejectCanonicalTarget('repo-fork', 'repo-main', 'https://git.invalid/main.git', 'https://git.invalid/main.git/')).toThrow(/canonical/);
  });

  it('never pushes a main branch, even if a server response assigns one', async () => {
    await expect(pushCandidate('/unused', 'https://git.invalid/fork.git', 'main')).rejects.toThrow(/invalid candidate branch/);
  });
});
