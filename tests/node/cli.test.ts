import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConcordClient, ConcordError, redactOutput, rememberCredential } from '../../cli/client.ts';
import { git, pushCandidate, rejectCanonicalTarget, resolveHead } from '../../cli/git.ts';
import { parseArgs as parseRunnerArgs, runLoop } from '../../runner/main.ts';
import { holdSeconds, releaseByIntent, start } from '../../cli/start.ts';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `concord-${label}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function publicationFixture(label: string) {
  const root = await tempDir(label);
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  await git(['init', '-b', 'main', worktree]);
  await writeFile(join(worktree, 'source.txt'), 'base\n');
  await git(['add', '--', 'source.txt'], {}, worktree);
  await git(['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.invalid', 'commit', '-m', 'base'], {}, worktree);
  return { root, worktree, baseOid: await resolveHead(worktree) };
}

async function publicationServer(baseOid: string, onToken?: () => Promise<void>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const server = await import('node:http').then(({ createServer }) => createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ path: request.url ?? '', body: body ? JSON.parse(body) : undefined });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/repos/repo-1/changes/change-1') response.end(JSON.stringify({ data: { candidateStorageName: 'fork', branch: 'agent-branch', baseOid, unitKeys: ['unit:a'], version: 1 } }));
    else if (request.url === '/v1/repos/repo-1') response.end(JSON.stringify({ data: { canonicalStorageName: 'canonical', canonicalRemote: 'https://git.invalid/canonical.git', version: 1 } }));
    else if (request.url === '/v1/repos/repo-1/git-token') {
      if (onToken) await onToken();
      response.end(JSON.stringify({ data: { remote: 'https://git.invalid/fork.git', plaintext: 'git-test-token' } }));
    } else if (request.url === '/v1/repos/repo-1/changes/change-1/publish') response.end(JSON.stringify({ data: { status: 'published' } }));
    else { response.statusCode = 404; response.end('{}'); }
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected local test server address');
  return { calls, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function publishCli(url: string, worktree: string, fences: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'change', 'publish', '--repo', 'repo-1', '--id', 'change-1', '--worktree', worktree, '--lease-fences', fences], {
    cwd: process.cwd(), env: { ...process.env, CONCORD_URL: url, CONCORD_TOKEN: 'api-token', ...extraEnv },
  });
}

describe('Concord agent CLI client', () => {
  it('sends issue, milestone and linked change CLI commands', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const server = await import('node:http').then(({ createServer }) => createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      calls.push({ method: request.method ?? '', path: request.url ?? '', body: text ? JSON.parse(text) : null });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: { number: 1, version: 2 }, version: 2 }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server unavailable');
    const env = { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'owner-token' };
    const cli = (...args: string[]) => execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', ...args], { cwd: process.cwd(), env });
    try {
      await cli('issue', 'create', '--repo', 'r', '--title', 'Task', '--body', 'Spec');
      await cli('issue', 'list', '--repo', 'r', '--state', 'open');
      await cli('issue', 'edit', '--repo', 'r', '--id', '1', '--title', 'Revised', '--allowed-files', '["a.ts"]', '--expected-version', '2');
      await cli('milestone', 'create', '--repo', 'r', '--title', 'Release');
      await cli('change', 'create', '--repo', 'r', '--intent-key', 'task', '--intent-text', 'Task', '--base-oid', 'null', '--branch', 'task', '--unit-keys', '[]', '--issue', '1');
      expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /v1/repos/r/issues', 'GET /v1/repos/r/issues?state=open', 'PATCH /v1/repos/r/issues/1', 'POST /v1/repos/r/milestones', 'POST /v1/repos/r/changes']);
      expect(calls[2].body).toEqual({ title: 'Revised', allowedFiles: ['a.ts'], expectedVersion: 2 });
      expect(calls[4].body.issueNumber).toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('starts once, reuses its change and lease, and releases by intent key', async () => {
    const dir = await tempDir('start'); const allowedFiles = join(dir, 'allowed.txt');
    await writeFile(allowedFiles, 'families.tsv\n');
    const base = 'a'.repeat(40); let change: Record<string, unknown> | undefined;
    let lease: Record<string, unknown> | undefined; const calls: string[] = [];
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, unknown> }) => {
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: base } };
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: change ? [change] : [], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: lease ? [lease] : [], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: {}, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') {
        change = { ...options?.body, changeId: 'change', status: 'draft' }; return { data: change };
      }
      if (method === 'POST' && path === '/repos/demo/leases') {
        expect(options?.body).toMatchObject({ unitKeys: ['file:families.tsv'], ttlSeconds: 7200 });
        lease = { changeId: 'change', leaseId: 'lease', unitKey: 'file:families.tsv', fence: 1,
          expiresAt: Date.now() + 7200000, state: 'active' }; return { data: { leases: [lease] } };
      }
      if (method === 'POST' && path === '/repos/demo/leases/lease/release') {
        lease = { ...lease, state: 'released' }; return { data: { lease } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const client = { request } as never;
    const input = { repo: 'demo', intentKey: 'task', intent: 'work', allowedFiles, client };
    expect(await start(input)).toMatchObject({ changeId: 'change', base, leases: [{ unitKey: 'file:families.tsv' }] });
    expect(await start(input)).toMatchObject({ changeId: 'change', leases: [{ fence: 1 }] });
    expect(calls.filter(call => call === 'POST /repos/demo/changes')).toHaveLength(2);
    expect(calls.filter(call => call === 'POST /repos/demo/leases')).toHaveLength(1);
    expect(await releaseByIntent('demo', 'task', client)).toEqual({ changeId: 'change', released: ['file:families.tsv'] });
    expect(holdSeconds('2h')).toBe(7200);
  });
  it('retries a promotion freeze with a fresh version when starting and releasing', async () => {
    const dir = await tempDir('start-frozen'); const allowedFiles = join(dir, 'allowed.txt');
    await writeFile(allowedFiles, 'file.txt\n');
    const base = 'a'.repeat(40); let change: Record<string, unknown> | undefined;
    let lease: Record<string, unknown> | undefined; let version = 1; const posts: string[] = [];
    const frozen = new Set(['POST /repos/demo/changes', 'POST /repos/demo/leases', 'POST /repos/demo/leases/lease/release']);
    const request = vi.fn(async (method: string, path: string,
      options?: { body?: Record<string, unknown>; expectedVersion?: number }) => {
      const call = `${method} ${path}`;
      if (method === 'POST') posts.push(options?.expectedVersion === undefined ? call : `${call} @${options.expectedVersion}`);
      if (frozen.delete(call)) {
        version++;
        throw new ConcordError('PROMOTION_IN_PROGRESS: Repository promotion is in progress', 'conflict', 409,
          { error: { code: 'PROMOTION_IN_PROGRESS' } });
      }
      if (method === 'POST' && options?.expectedVersion !== undefined && options.expectedVersion !== version)
        throw new ConcordError('STALE_VERSION', 'conflict', 409, { error: { code: 'STALE_VERSION' } });
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: base } };
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: change ? [change] : [], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: lease ? [lease] : [], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: {}, version };
      if (method === 'POST' && path === '/repos/demo/changes') {
        change = { ...options?.body, changeId: 'change', status: 'draft' }; return { data: change };
      }
      if (method === 'POST' && path === '/repos/demo/leases') {
        lease = { changeId: 'change', leaseId: 'lease', unitKey: 'file:file.txt', fence: 1,
          expiresAt: Date.now() + 7200000, state: 'active' }; return { data: { leases: [lease] } };
      }
      if (method === 'POST' && path === '/repos/demo/leases/lease/release') {
        lease = { ...lease, state: 'released' }; return { data: { lease } };
      }
      throw new Error(`unexpected ${call}`);
    });
    const client = { request } as never;
    expect(await start({ repo: 'demo', intentKey: 'task', intent: 'work', allowedFiles, client }))
      .toMatchObject({ changeId: 'change', leases: [{ unitKey: 'file:file.txt', fence: 1 }] });
    expect(await releaseByIntent('demo', 'task', client)).toEqual({ changeId: 'change', released: ['file:file.txt'] });
    expect(frozen.size).toBe(0);
    expect(posts).toEqual(['POST /repos/demo/changes', 'POST /repos/demo/changes',
      'POST /repos/demo/leases @2', 'POST /repos/demo/leases @3', 'POST /repos/demo/changes',
      'POST /repos/demo/leases/lease/release @3', 'POST /repos/demo/leases/lease/release @4']);
  });
  it('restarts a started change after publication replaces its file unit with a TSV row', async () => {
    const dir = await tempDir('start-published'); const allowedFiles = join(dir, 'allowed.txt');
    await writeFile(allowedFiles, 'families.tsv\nunused.txt\n');
    const base = 'a'.repeat(40);
    const branch = `refs/heads/land/${(await import('node:crypto')).createHash('sha256').update('task').digest('hex').slice(0, 16)}`;
    const change = { changeId: 'change', intentKey: 'task', intentText: 'work', baseOid: base, branch,
      unitKeys: ['row:families:alpha'], headOid: 'b'.repeat(40), status: 'ready' };
    let lease = { changeId: 'change', leaseId: 'lease', unitKey: 'file:families.tsv', fence: 1,
      expiresAt: Date.now() + 30_000, state: 'active' };
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, unknown> }) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: base } };
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [lease], nextCursor: null } };
      if (method === 'POST' && path === '/repos/demo/changes') {
        expect(options?.body?.unitKeys).toEqual(['row:families:alpha']);
        return { data: change };
      }
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { repos: { unitPolicy: {
        tables: [{ name: 'families', file: 'families.tsv' }], units: {} } } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/leases/lease/renew') {
        lease = { ...lease, fence: 2, expiresAt: Date.now() + 7200_000 };
        return { data: { lease } };
      }
      if (method === 'POST' && path === '/repos/demo/leases/lease/release') {
        lease = { ...lease, state: 'released' };
        return { data: { lease } };
      }
      throw new Error(`unexpected ${method} ${path}: ${JSON.stringify(options?.body)}`);
    });
    const result = await start({ repo: 'demo', intentKey: 'task', intent: 'work', allowedFiles, client: { request } as never });
    expect(result).toMatchObject({ changeId: 'change', leases: [{ unitKey: 'file:families.tsv', fence: 2 }] });
    expect(request.mock.calls.filter(([method, path]) => method === 'POST' && path === '/repos/demo/changes')).toHaveLength(1);
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path === '/repos/demo/leases')).toBe(false);
    expect(await releaseByIntent('demo', 'task', { request } as never)).toEqual({ changeId: 'change', released: ['file:families.tsv'] });
  });
  it('requires an ownership-checked reuse before a published change can restart', async () => {
    const dir = await tempDir('start-owner'); const allowedFiles = join(dir, 'allowed.txt');
    await writeFile(allowedFiles, 'families.tsv\n');
    const base = 'a'.repeat(40);
    const branch = `refs/heads/land/${(await import('node:crypto')).createHash('sha256').update('task').digest('hex').slice(0, 16)}`;
    const change = { changeId: 'agent-a-change', intentKey: 'task', intentText: 'work', baseOid: base, branch,
      unitKeys: ['row:families:alpha'], headOid: 'b'.repeat(40), status: 'ready' };
    const calls: string[] = [];
    const requestFor = (agent: 'A' | 'B') => vi.fn(async (method: string, path: string,
      options?: { body?: Record<string, unknown> }) => {
      calls.push(`${agent} ${method} ${path}`);
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: base } };
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { repos: { unitPolicy: {
        tables: [{ name: 'families', file: 'families.tsv' }], units: {} } } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') {
        expect(options?.body?.unitKeys).toEqual(['row:families:alpha']);
        if (agent === 'B') throw new ConcordError('INTENT_OWNED', 'conflict', 409,
          { error: { code: 'INTENT_OWNED' } });
        return { data: change };
      }
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [{
        changeId: change.changeId, leaseId: 'lease', unitKey: 'file:families.tsv', fence: 1,
        expiresAt: Date.now() + 7200_000, state: 'active',
      }], nextCursor: null } };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const input = { repo: 'demo', intentKey: 'task', intent: 'work', allowedFiles };
    await expect(start({ ...input, client: { request: requestFor('B') } as never }))
      .rejects.toMatchObject({ kind: 'conflict', status: 409 });
    expect(calls.some(call => call === 'B GET /repos/demo/leases')).toBe(false);
    expect(await start({ ...input, client: { request: requestFor('A') } as never }))
      .toMatchObject({ changeId: 'agent-a-change', leases: [{ fence: 1 }] });
    expect(calls.filter(call => call.endsWith('POST /repos/demo/changes'))).toHaveLength(2);
  });
  it('checks ownership before releasing a change whose lease has expired', async () => {
    const change = { changeId: 'agent-a-change', intentKey: 'task', intentText: 'work',
      baseOid: 'a'.repeat(40), branch: 'refs/heads/land/task', unitKeys: ['row:families:alpha'],
      dependencyChangeIds: [], headOid: 'b'.repeat(40), status: 'ready' };
    const expiredLease = { changeId: change.changeId, leaseId: 'lease', unitKey: 'row:families:alpha',
      fence: 1, expiresAt: Date.now() - 1000, state: 'active' };
    const calls: string[] = [];
    const requestFor = (agent: 'A' | 'B') => vi.fn(async (method: string, path: string,
      options?: { body?: Record<string, unknown> }) => {
      calls.push(`${agent} ${method} ${path}`);
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null } };
      if (method === 'POST' && path === '/repos/demo/changes') {
        expect(options?.body).toMatchObject({ intentKey: 'task', intentText: 'work', baseOid: change.baseOid,
          branch: change.branch, unitKeys: change.unitKeys, dependencyChangeIds: [] });
        if (agent === 'B') throw new ConcordError('INTENT_OWNED', 'conflict', 409,
          { error: { code: 'INTENT_OWNED' } });
        return { data: change };
      }
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [expiredLease], nextCursor: null } };
      throw new Error(`unexpected ${method} ${path}`);
    });
    await expect(releaseByIntent('demo', 'task', { request: requestFor('B') } as never))
      .rejects.toMatchObject({ kind: 'conflict', status: 409 });
    expect(calls).toEqual(['B GET /repos/demo/changes', 'B POST /repos/demo/changes']);
    expect(await releaseByIntent('demo', 'task', { request: requestFor('A') } as never))
      .toEqual({ changeId: change.changeId, released: [] });
    expect(calls.slice(2)).toEqual(['A GET /repos/demo/changes', 'A POST /repos/demo/changes', 'A GET /repos/demo/leases']);
  });
  it('renews a short hold when less than half its duration remains', async () => {
    const dir = await tempDir('start-short-hold'); const allowedFiles = join(dir, 'allowed.txt');
    await writeFile(allowedFiles, 'file.txt\n');
    const base = 'a'.repeat(40);
    const branch = `refs/heads/land/${(await import('node:crypto')).createHash('sha256').update('task').digest('hex').slice(0, 16)}`;
    const change = { changeId: 'change', intentKey: 'task', intentText: 'work', baseOid: base, branch,
      unitKeys: ['file:file.txt'], status: 'draft' };
    let lease = { changeId: 'change', leaseId: 'lease', unitKey: 'file:file.txt', fence: 1,
      expiresAt: Date.now() + 10_000, state: 'active' };
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, unknown> }) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: base } };
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null } };
      if (method === 'POST' && path === '/repos/demo/changes') return { data: change };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [lease], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: {}, version: 1 };
      if (method === 'POST' && path === '/repos/demo/leases/lease/renew') {
        expect(options?.body).toMatchObject({ fence: 1, ttlSeconds: 30 });
        lease = { ...lease, fence: 2, expiresAt: Date.now() + 30_000 };
        return { data: { lease } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const result = await start({ repo: 'demo', intentKey: 'task', intent: 'work', allowedFiles,
      hold: '30s', client: { request } as never });
    expect(result).toMatchObject({ changeId: 'change', leases: [{ fence: 2 }] });
    expect(request.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/renew'))).toHaveLength(1);
  });
  it('reports a start conflict without retrying a partial claim', async () => {
    const dir = await tempDir('start-conflict'); const allowedFiles = join(dir, 'allowed.txt');
    await writeFile(allowedFiles, 'a.txt\nb.txt\n');
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, unknown> }) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: 'a'.repeat(40) } };
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [], nextCursor: null } };
      if (method === 'POST' && path === '/repos/demo/changes') return { data: { changeId: 'change' } };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: {}, version: 1 };
      if (method === 'POST' && path === '/repos/demo/leases') {
        expect(options?.body?.unitKeys).toEqual(['file:a.txt', 'file:b.txt']);
        throw new ConcordError('LEASE_CONFLICT', 'conflict', 409, { error: { code: 'LEASE_CONFLICT',
          details: { holderId: 'other', intentText: 'other work', keys: ['file:a.txt'], expiresAt: 123 } } });
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    await expect(start({ repo: 'demo', intentKey: 'task', intent: 'work', allowedFiles,
      client: { request } as never })).rejects.toMatchObject({ kind: 'conflict', exitCode: 3 });
    expect(request.mock.calls.filter(([method, path]) => method === 'POST' && path === '/repos/demo/leases')).toHaveLength(1);
  });
  it('rejects 65 allowed paths before an API request', async () => {
    const dir = await tempDir('start-cap'); const allowedFiles = join(dir, 'allowed.txt');
    await writeFile(allowedFiles, Array.from({ length: 65 }, (_, index) => `file-${index}.txt`).join('\n'));
    const request = vi.fn();
    await expect(start({ repo: 'demo', intentKey: 'task', intent: 'work', allowedFiles,
      client: { request } as never })).rejects.toMatchObject({ kind: 'usage', message: expect.stringMatching(/65.*64/) });
    expect(request).not.toHaveBeenCalled();
  });
  it('requests tenant events without a repository and forwards the page cursor', async () => {
    const paths: string[] = [];
    const server = await import('node:http').then(({ createServer }) => createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { items: [{ sequence: 7, kind: 'principal.minted' }], nextCursor: null }, version: 2, eventSeq: 7 }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local server');
    const env = { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'viewer-token' };
    try {
      const result = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'events', '--tenant'], { cwd: process.cwd(), env });
      expect(JSON.parse(result.stdout)).toMatchObject({ data: { items: [{ kind: 'principal.minted' }] }, eventSeq: 7 });
      await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'events', '--tenant', '--cursor', 'Nw'], { cwd: process.cwd(), env });
      expect(paths).toEqual(['/v1/events', '/v1/events?cursor=Nw']);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('mints one plaintext token on stdout and sends scoped principal commands', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const token = `cct_local_${'a'.repeat(64)}`;
    const server = await import('node:http').then(({ createServer }) => createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push({ method: request.method ?? '', path: request.url ?? '', body: body ? JSON.parse(body) : null });
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST') response.end(JSON.stringify({ data: { id: 'child', token } }));
      else if (request.method === 'GET') response.end(JSON.stringify({ data: { items: [{ id: 'child' }] } }));
      else response.end(JSON.stringify({ data: { revokedIds: ['child'] } }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local server');
    const env = { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'parent-token' };
    try {
      const minted = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'principals', 'mint', '--role', 'agent', '--repo', 'alpha', '--ttl', '2h', '--name', 'worker'], { cwd: process.cwd(), env });
      expect(minted.stdout).toBe(`${token}\n`);
      expect(minted.stderr).not.toContain(token);
      expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/principals', body: { roles: ['agent'], repoIds: ['alpha'], ttlSeconds: 7200, name: 'worker' } });
      const listed = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'principals', 'list'], { cwd: process.cwd(), env });
      expect(JSON.parse(listed.stdout)).toMatchObject({ data: { items: [{ id: 'child' }] } });
      await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'principals', 'list', '--cursor', 'MjU'], { cwd: process.cwd(), env });
      const revoked = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'principals', 'revoke', 'child'], { cwd: process.cwd(), env });
      expect(JSON.parse(revoked.stdout)).toMatchObject({ data: { revokedIds: ['child'] } });
      expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /v1/principals', 'GET /v1/principals', 'GET /v1/principals?cursor=MjU', 'DELETE /v1/principals/child']);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('prints a checker token once on stdout and a runner command that reads it from an env var', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const token = `cct_local_${'c'.repeat(64)}`;
    const server = await import('node:http').then(({ createServer }) => createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push({ method: request.method ?? '', path: request.url ?? '', body: body ? JSON.parse(body) : null });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { id: 'checker-1', token, expiresAt: 4_000_000_000_000, roles: ['checker'], repoIds: ['alpha'] } }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local server');
    const url = `http://127.0.0.1:${address.port}`;
    const env = { ...process.env, CONCORD_URL: url, CONCORD_TOKEN: 'owner-token' };
    const cli = (...args: string[]) => execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', ...args], { cwd: process.cwd(), env });
    try {
      const minted = await cli('principals', 'mint', '--role', 'checker', '--repo', 'alpha', '--ttl', '24h', '--name', 'mac-mini');
      expect(minted.stdout).toBe(`${token}\n`);
      expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/principals',
        body: { roles: ['checker'], repoIds: ['alpha'], ttlSeconds: 86400, name: 'mac-mini' } });
      expect(minted.stderr).toContain('checker-1');
      expect(minted.stderr).toContain(`CONCORD_URL=${url} CONCORD_TOKEN="$CHECKER_TOKEN" npm run runner -- --repo alpha --role checker`);
      expect(minted.stderr).not.toContain(token);
      const command = minted.stderr.match(/npm run runner -- ([^\n]+)/)?.[1];
      expect(command).toBeDefined();
      const options = parseRunnerArgs(command!.trim().split(/\s+/));
      expect(options).toMatchObject({ repo: 'alpha', role: 'checker', once: false,
        maxJobs: 1000, idleTimeoutSeconds: 86400 });
      vi.useFakeTimers();
      try {
        let polls = 0;
        const stopped = expect(runLoop({ ...options, profileDigest: `sha256:${'0'.repeat(64)}` }, async () => {
          polls++;
          return polls === 1 ? { status: 204 } : { status: 403, error: { code: 'STOP' } };
        }, null)).rejects.toThrow('POLL_FAILED:STOP');
        await vi.advanceTimersByTimeAsync(1000);
        await stopped;
        expect(polls).toBe(2);
      } finally { vi.useRealTimers(); }
      await expect(cli('principals', 'mint', '--role', 'promoter')).rejects.toMatchObject({ code: 2, stdout: '' });
      expect(calls).toHaveLength(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
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

  it('supports transport-only retries without retrying an HTTP refusal', async () => {
    const keys: string[] = [];
    let calls = 0;
    const client = new ConcordClient({ url: 'https://concord.invalid', sleep: async () => {}, fetch: async (_input, init) => {
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (++calls === 1) throw new TypeError('response lost');
      return new Response(JSON.stringify({ error: { code: 'LEASE_CAPACITY', message: 'full' } }), { status: 429 });
    } });
    await expect(client.request('POST', '/repos/r/leases', { body: {}, idempotencyKey: 'once', retryMode: 'transport-only' }))
      .rejects.toMatchObject({ status: 429, payload: { error: { code: 'LEASE_CAPACITY' } } });
    expect(keys).toEqual(['once', 'once']);
  });

  it('does not retry a nonce after response body reading fails', async () => {
    let calls = 0;
    const client = new ConcordClient({ url: 'https://concord.invalid', sleep: async () => {}, fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('body lost')); } }), { status: 200 });
    } });
    await expect(client.request('POST', '/repos/r/leases', { body: {}, idempotencyKey: 'once', retryMode: 'transport-only' }))
      .rejects.toMatchObject({ kind: 'server', status: 200 });
    expect(calls).toBe(1);
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

  it('does not expose any Git-token error response fields in diagnostics', async () => {
    const secret = 'unexpected-git-credential';
    const client = new ConcordClient({
      url: 'https://concord.invalid',
      fetch: async () => new Response(JSON.stringify({ plaintext: secret, error: { message: secret }, arbitrary: { credential: secret } }), { status: 400 }),
    });
    try {
      await client.request('POST', '/repos/r/git-token', { body: { scope: 'read' } });
      throw new Error('expected Git-token request to fail');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'server', status: 400, message: 'Git token request failed with HTTP 400' });
      expect((error as ConcordError).payload).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(secret);
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

  it('returns machine-readable help on stdout', async () => {
    const result = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'help'], { cwd: process.cwd() });
    expect(result.stderr).not.toContain('Concord agent CLI');
    expect(JSON.parse(result.stdout)).toMatchObject({ help: expect.stringContaining('Concord agent CLI') });
  });

  it('redacts Git credentials when a token response is missing its remote', async () => {
    const secret = 'plaintext-git-secret';
    const server = await import('node:http').then(({ createServer }) => createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/repos/repo-1') response.end(JSON.stringify({ data: { canonicalStorageName: 'canonical', version: 1 } }));
      else if (request.url === '/v1/repos/repo-1/git-token') response.end(JSON.stringify({ data: { plaintext: secret, nested: { arbitrary: 'another-secret' }, scope: 'read' } }));
      else { response.statusCode = 404; response.end('{}'); }
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    try {
      try {
        await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'repo', 'clone', '--repo', 'repo-1', '--path', '/unused'], {
          cwd: process.cwd(), env: { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'api-token' },
        });
        throw new Error('expected repo clone to reject a missing remote');
      } catch (error) {
        expect(error).toMatchObject({ code: 5, stdout: '' });
        const stderr = (error as { stderr: string }).stderr;
        expect(stderr).not.toContain(secret);
        const diagnostic = JSON.parse(stderr.split('\n').find(line => line.startsWith('{"error":')) ?? '');
        expect(diagnostic.error).toMatchObject({ kind: 'server', message: 'Server response is missing remote' });
        expect(diagnostic.error).not.toHaveProperty('details');
        expect(JSON.stringify(diagnostic)).not.toContain('another-secret');
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('never emits a bare Git token printed by an authenticated child process', async () => {
    const secret = 'git-plaintext-credential-unique';
    const root = await tempDir('git-stderr-secret');
    const shimDir = join(root, 'bin');
    await mkdir(shimDir);
    await writeFile(join(shimDir, 'git'), '#!/bin/sh\nprintf "%s\\n" "${GIT_CONFIG_VALUE_0#Authorization: Bearer }" >&2\nexit 17\n');
    await chmod(join(shimDir, 'git'), 0o755);
    const server = await import('node:http').then(({ createServer }) => createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/repos/repo-1') response.end(JSON.stringify({ data: { canonicalStorageName: 'canonical', version: 1 } }));
      else response.end(JSON.stringify({ data: { remote: 'https://git.invalid/repo.git', plaintext: secret } }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    try {
      try {
        await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'repo', 'clone', '--repo', 'repo-1', '--path', join(root, 'clone')], {
          cwd: process.cwd(), env: { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'api-token', PATH: `${shimDir}:${process.env.PATH ?? ''}` },
        });
        throw new Error('expected Git failure');
      } catch (error) {
        expect(error).toMatchObject({ code: 5, stdout: '', stderr: expect.stringContaining('Git failed: exit (exit code 17)') });
        expect((error as { stderr: string }).stderr).not.toContain(secret);
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('redacts a known credential on every command error path and on stdout', async () => {
    const secret = 'known+credential/unique=123';
    const common = ['--repo', 'repo-1'];
    const version = ['--expected-version', '1'];
    const change = ['--change-id', 'change-1'];
    const commands: string[][] = [
      ['repo', 'create', '--name', 'name', '--policy-id', 'policy', '--profile-id', 'profile'],
      ['repo', 'list'], ['repo', 'clone', ...common, '--path', '/unused'],
      ['change', 'create', ...common, '--intent-key', 'key', '--intent-text', 'text', '--base-oid', 'null', '--branch', 'agent/a', '--unit-keys', '[]'],
      ['change', 'get', ...common, '--id', 'change-1'], ['change', 'checkout', ...common, '--id', 'change-1', '--worktree', '/unused'],
      ['change', 'publish', ...common, '--id', 'change-1', '--worktree', '/unused', '--lease-fences', '{}'],
      ['change', 'close', ...common, '--id', 'change-1', ...version],
      ['lease', 'claim', ...common, ...change, '--unit-keys', '[]', '--intent-text', 'text', ...version],
      ['lease', 'list', ...common], ['lease', 'renew', ...common, '--id', 'lease-1', '--fence', '1', ...version],
      ['lease', 'release', ...common, '--id', 'lease-1', '--fence', '1', ...version],
      ['queue', 'list', ...common], ['queue', 'enqueue', ...common, ...change, '--verdict-id', 'v1', '--lease-fences', '{}', ...version],
      ['queue', 'withdraw', ...common, ...change, '--reason', 'reason', ...version],
      ['finding', 'list', ...common, ...change],
      ['finding', 'add', ...common, ...change, '--revision', '1', '--unit-key', 'unit:a', '--text', 'text', '--evidence-digest', 'sha256:abc', ...version],
      ['repair', 'submit', ...common, ...change, '--revision', '1', '--finding-set-version', '1', '--dispositions', '[]', ...version],
      ['repair', 'review', ...common, ...change, '--round-id', 'round-1', '--revision', '1', '--finding-set-version', '1', '--decision', 'accept', '--evidence-digest', 'sha256:abc', ...version],
      ['verdict', 'add', ...common, ...change, '--revision', '1', '--review-manifest-digest', 'sha256:abc', '--finding-set-version', '1', '--decision', 'approve', '--evidence-digest', 'sha256:abc', ...version],
      ['verdict', 'carry', ...common, ...change, '--parent-verdict-id', 'v1', '--revision', '2', '--new-base-oid', 'abc', ...version],
      ['events', 'list', ...common], ['api', 'GET', '/repos'],
    ];
    const server = await import('node:http').then(({ createServer }) => createServer((request, response) => {
      if (request.url === '/v1/echo-success') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { echo: secret, embedded: `https://host.invalid/${encodeURIComponent(secret)}`, lowerEncoded: encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()), base64: Buffer.from(secret).toString('base64'), generic: 'ghp_abcdefghijklmnop' } }));
        return;
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'FAIL', message: `Bearer ${secret} https://host.invalid/${encodeURIComponent(secret)}`, details: { echo: secret } } }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    const env = { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: secret };
    try {
      for (const command of commands) {
        try {
          await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', ...command], { cwd: process.cwd(), env });
          throw new Error(`expected ${command.join(' ')} to fail`);
        } catch (error) {
          expect(error, command.join(' ')).toMatchObject({ code: 5, stdout: '' });
          const output = error as { stdout: string; stderr: string };
          expect(output.stdout + output.stderr, command.join(' ')).not.toContain(secret);
          expect(output.stdout + output.stderr, command.join(' ')).not.toContain(encodeURIComponent(secret));
        }
      }
      const success = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'GET', '/echo-success'], { cwd: process.cwd(), env });
      expect(success.stdout + success.stderr).not.toContain(secret);
      expect(success.stdout).not.toContain(encodeURIComponent(secret).toLowerCase());
      expect(success.stdout).not.toContain(Buffer.from(secret).toString('base64'));
      expect(success.stdout).not.toContain('ghp_abcdefghijklmnop');
      expect(JSON.parse(success.stdout).data.echo).toBe('[REDACTED]');
      expect(JSON.parse(success.stdout).data.lowerEncoded).toBe('[REDACTED]');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 60_000);

  it('rejects a mismatched publication identity before requesting Git write access', async () => {
    const root = await tempDir('publish-identity');
    const worktree = join(root, 'worktree');
    await mkdir(worktree);
    await git(['init', '-b', 'main', worktree]);
    await writeFile(join(worktree, 'source.txt'), 'base\n');
    await git(['add', '--', 'source.txt'], {}, worktree);
    await git(['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.invalid', 'commit', '-m', 'base'], {}, worktree);
    const baseOid = await resolveHead(worktree);
    const bodyPath = join(root, 'publish-body.json');
    await writeFile(bodyPath, JSON.stringify({ baseOid, headOid: baseOid, branch: 'different-branch', unitKeys: ['unit:a'], leaseFences: { 'unit:a': 1 } }));
    const calls: string[] = [];
    const server = await import('node:http').then(({ createServer }) => createServer((request, response) => {
      calls.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/repos/repo-1/changes/change-1') response.end(JSON.stringify({ data: { candidateStorageName: 'fork', branch: 'agent-branch', baseOid, unitKeys: ['unit:a'], version: 1 } }));
      else if (request.url === '/v1/repos/repo-1') response.end(JSON.stringify({ data: { canonicalStorageName: 'canonical', canonicalRemote: 'https://git.invalid/canonical.git', version: 1 } }));
      else { response.statusCode = 500; response.end('{}'); }
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    try {
      await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'change', 'publish', '--repo', 'repo-1', '--id', 'change-1', '--worktree', worktree, '--lease-fences', '{"unit:a":1}', '--body-file', bodyPath], {
        cwd: process.cwd(), env: { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'api-token' },
      })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Publish body identity') });
      expect(calls).toEqual(['/v1/repos/repo-1/changes/change-1', '/v1/repos/repo-1']);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('rejects a valid but non-ancestor server base before requesting Git write access', async () => {
    const { worktree, baseOid } = await publicationFixture('publish-ancestry');
    await git(['checkout', '-b', 'agent-work'], {}, worktree);
    await writeFile(join(worktree, 'source.txt'), 'head branch\n');
    await git(['add', '--', 'source.txt'], {}, worktree);
    await git(['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.invalid', 'commit', '-m', 'head'], {}, worktree);
    await git(['checkout', '-b', 'sibling', baseOid], {}, worktree);
    await writeFile(join(worktree, 'source.txt'), 'sibling branch\n');
    await git(['add', '--', 'source.txt'], {}, worktree);
    await git(['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.invalid', 'commit', '-m', 'sibling'], {}, worktree);
    const siblingOid = await resolveHead(worktree);
    await git(['checkout', 'agent-work'], {}, worktree);
    const server = await publicationServer(siblingOid);
    try {
      await expect(publishCli(server.url, worktree, '{"unit:a":1}')).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('must descend from the server base') });
      expect(server.calls.map(call => call.path)).toEqual(['/v1/repos/repo-1/changes/change-1', '/v1/repos/repo-1']);
    } finally { await server.close(); }
  });

  it('rejects malformed lease fences before requesting Git write access', async () => {
    const { worktree, baseOid } = await publicationFixture('publish-fences');
    const server = await publicationServer(baseOid);
    try {
      await expect(publishCli(server.url, worktree, '{"unit:a":"invalid"}')).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--lease-fences must map') });
      expect(server.calls.map(call => call.path)).toEqual(['/v1/repos/repo-1/changes/change-1', '/v1/repos/repo-1']);
    } finally { await server.close(); }
  });

  it('pushes the verified head OID even when HEAD moves before Git write access', async () => {
    const { root, worktree, baseOid } = await publicationFixture('publish-pinned-head');
    const verifiedOid = await resolveHead(worktree);
    const gitPath = (await execFile('which', ['git'])).stdout.trim();
    const shimDir = join(root, 'shim');
    await mkdir(shimDir);
    const shimPath = join(shimDir, 'git');
    const pushLog = join(root, 'push-args.txt');
    await writeFile(shimPath, '#!/bin/sh\nif [ "$3" = "push" ]; then\n  printf "%s\\n" "$@" > "$CONCORD_TEST_PUSH_LOG"\n  exit 0\nfi\nexec "$CONCORD_TEST_REAL_GIT" "$@"\n');
    await chmod(shimPath, 0o755);
    const server = await publicationServer(baseOid, async () => {
      await writeFile(join(worktree, 'source.txt'), 'moved after verification\n');
      await git(['add', '--', 'source.txt'], {}, worktree);
      await git(['-c', 'user.name=CLI Test', '-c', 'user.email=cli@example.invalid', 'commit', '-m', 'moved'], {}, worktree);
    });
    try {
      await publishCli(server.url, worktree, '{"unit:a":1}', { PATH: `${shimDir}:${process.env.PATH ?? ''}`, CONCORD_TEST_REAL_GIT: gitPath, CONCORD_TEST_PUSH_LOG: pushLog });
      expect(await resolveHead(worktree)).not.toBe(verifiedOid);
      const pushArgs = await import('node:fs/promises').then(({ readFile }) => readFile(pushLog, 'utf8'));
      expect(pushArgs).toContain(`${verifiedOid}:refs/heads/agent-branch`);
      expect(pushArgs).not.toContain('HEAD:refs/heads/agent-branch');
      expect(server.calls.map(call => call.path)).toEqual(['/v1/repos/repo-1/changes/change-1', '/v1/repos/repo-1', '/v1/repos/repo-1/git-token', '/v1/repos/repo-1/changes/change-1/publish']);
      expect(server.calls[3]?.body).toMatchObject({ headOid: verifiedOid, baseOid, branch: 'agent-branch' });
    } finally { await server.close(); }
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

  it('registers nested credentials from a body file before an error echoes them', async () => {
    const root = await tempDir('body-secret');
    const bodyPath = join(root, 'body.json');
    const secrets = ['bodyToken+unique/123=', 'nestedPlaintext-456', 'nestedPassword-789', 'bodyAuthorization-ABC'];
    await writeFile(bodyPath, JSON.stringify({ token: secrets[0], nested: { plaintext: secrets[1], password: secrets[2], authorization: `Bearer ${secrets[3]}` } }));
    const server = await import('node:http').then(({ createServer }) => createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'ECHO', message: body, details: JSON.parse(body) } }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    try {
      try {
        await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'POST', '/echo', '--body-file', bodyPath], {
          cwd: process.cwd(), env: { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'api-token' },
        });
        throw new Error('expected server failure');
      } catch (error) {
        expect(error).toMatchObject({ code: 5, stdout: '' });
        const stderr = (error as { stderr: string }).stderr;
        const diagnostic = JSON.parse(stderr.split('\n').find(line => line.startsWith('{"error":')) ?? '');
        expect(diagnostic.error.kind).toBe('server');
        for (const secret of secrets) expect(stderr).not.toContain(secret);
        expect(stderr).toContain('[REDACTED]');
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('redacts numeric and boolean credentials echoed in an HTTP error', async () => {
    const body = { nested: { password: 123456789, apiKey: 0, secret: false } };
    const fetcher: typeof fetch = async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(body);
      expect(redactOutput('123456789')).toBe('[REDACTED]');
      expect(redactOutput('0')).toBe('[REDACTED]');
      expect(redactOutput('false')).toBe('[REDACTED]');
      return new Response(JSON.stringify({ error: { code: 'BAD', message: 'password 123456789; key 0; secret false', details: { echoNumber: 123456789, echoZero: 0, echoBoolean: false } } }), { status: 400 });
    };
    const client = new ConcordClient({ url: 'https://concord.invalid', fetch: fetcher });
    try {
      await client.request('POST', '/echo', { body });
      throw new Error('expected HTTP error');
    } catch (error) {
      const diagnostic = error as ConcordError;
      expect(diagnostic.kind).toBe('server');
      expect(diagnostic.message).not.toContain('123456789');
      expect(diagnostic.message).not.toContain('false');
      expect(JSON.stringify(diagnostic.payload)).not.toContain('123456789');
      expect(JSON.stringify(diagnostic.payload)).not.toContain('false');
      expect(diagnostic.payload).toMatchObject({ error: { details: { echoNumber: '[REDACTED]', echoZero: '[REDACTED]', echoBoolean: '[REDACTED]' } } });
    }
  });

  it('keeps stdout and stderr parseable when a token contains JSON syntax', async () => {
    const secret = '"';
    const server = await import('node:http').then(({ createServer }) => createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/ok') response.end(JSON.stringify({ data: { echoed: secret, quoted: `before ${secret} after` } }));
      else { response.statusCode = 400; response.end(JSON.stringify({ error: { code: 'FAIL', message: secret } })); }
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    const env = { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: secret };
    try {
      const ok = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'GET', '/ok'], { cwd: process.cwd(), env });
      expect(JSON.parse(ok.stdout)).toEqual({ data: { echoed: '[REDACTED]', quoted: '[REDACTED]' } });
      try {
        await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'GET', '/fail'], { cwd: process.cwd(), env });
        throw new Error('expected server failure');
      } catch (error) {
        const diagnostic = JSON.parse((error as { stderr: string }).stderr.split('\n').find(line => line.startsWith('{"error":')) ?? '');
        expect(diagnostic.error).toMatchObject({ kind: 'server', message: 'FAIL: [REDACTED]' });
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('redacts lowercase percent escapes and base64 in response and transport diagnostics', async () => {
    const secret = 'known+credential/unique=123';
    const encoded = encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, match => match.toLowerCase());
    const base64 = Buffer.from(secret).toString('base64');
    const client = new ConcordClient({ url: 'https://concord.invalid', token: secret, fetch: async () => new Response(JSON.stringify({ data: { encoded, base64, bearer: `Bearer ${secret}` } })) });
    expect(redactOutput(await client.request('GET', '/echo'))).toEqual({ data: { encoded: '[REDACTED]', base64: '[REDACTED]', bearer: '[REDACTED]' } });
    const broken = new ConcordClient({ url: 'https://concord.invalid', token: secret, fetch: async () => { throw new Error(`failure ${encoded} ${base64}`); }, sleep: async () => {} });
    await expect(broken.request('GET', '/echo')).rejects.toMatchObject({ kind: 'transport', message: expect.stringContaining('[REDACTED]'), payload: { message: '[REDACTED]' } });
  });

  it('omits secret-bearing response keys and reports the number on stdout and stderr', async () => {
    const secret = 'demoSecret42';
    const allEncoded = [...Buffer.from(secret)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
    const doubleEncoded = encodeURIComponent(allEncoded);
    const base64 = Buffer.from(secret).toString('base64');
    const server = await import('node:http').then(({ createServer }) => createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const members = { [`raw-${secret}`]: 1, [`encoded-${allEncoded}`]: 2, [`base64-${base64}`]: 3, keep: 'safe' };
      if (request.url === '/v1/ok') response.end(JSON.stringify({ data: { members, nested: [{ [`again-${doubleEncoded}`]: 4, keep: true }] } }));
      else { response.statusCode = 400; response.end(JSON.stringify({ error: { code: 'BAD', message: 'failure', details: members } })); }
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    const env = { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: secret };
    try {
      const ok = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'GET', '/ok'], { cwd: process.cwd(), env });
      expect(JSON.parse(ok.stdout)).toEqual({ data: { members: { keep: 'safe' }, nested: [{ keep: true }] }, omittedMembers: 4 });
      expect(ok.stdout).not.toContain(secret);
      expect(ok.stdout).not.toContain(allEncoded);
      expect(ok.stdout).not.toContain(base64);
      try {
        await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'GET', '/fail'], { cwd: process.cwd(), env });
        throw new Error('expected HTTP error');
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const diagnostic = JSON.parse(stderr.split('\n').find(line => line.startsWith('{"error":')) ?? '');
        expect(diagnostic).toEqual({ error: { kind: 'server', message: 'BAD: failure', details: { error: { code: 'BAD', message: 'failure', details: { keep: 'safe' } } }, status: 400 }, omittedMembers: 3 });
        expect(stderr).not.toContain(secret);
        expect(stderr).not.toContain(allEncoded);
        expect(stderr).not.toContain(base64);
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('omits members whose key or value still has escapes at the decoding limit', () => {
    rememberCredential('abc');
    let encoded = '%61%62%63';
    for (let layer = 0; layer < 10; layer++) encoded = encodeURIComponent(encoded);
    const count = { omittedMembers: 0 };
    expect(redactOutput({ [encoded]: 'visible', value: encoded, items: [encoded, 'visible'] }, count))
      .toEqual({ items: ['visible'] });
    expect(count.omittedMembers).toBe(3);
  });

  it('rejects raw and encoded traversal, backslashes, and origin changes before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const client = new ConcordClient({ url: 'https://concord.invalid/base', fetch: fetcher });
    for (const path of [
      '/%2e%2e/admin', '/v1/%2E%2E/admin', '/v1/.%2e/admin', '/v1/%252e%252e/admin',
      '/v1/./admin', '/v1/../admin', '/v1/%2f..%2fadmin', '/v1/%5c..%5cadmin',
      '/v1\\..\\admin', '//evil.invalid/v1/repos', '/%2f%2fevil.invalid/v1/repos',
    ]) {
      await expect(client.request('GET', path), path).rejects.toMatchObject({ kind: 'usage' });
      expect(fetcher, path).not.toHaveBeenCalled();
    }
    await client.request('GET', '/repos?after=1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://concord.invalid/v1/repos?after=1');
  });

  it('preserves valid JSON for generated tokens with arbitrary punctuation and quotes', () => {
    const alphabet = Array.from('abcXYZ09"\\\n\r\t+/%=&?[]{}:!@#$^*() é😀');
    let seed = 0x1234abcd;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let caseNumber = 0; caseNumber < 100; caseNumber++) {
      const secret = Array.from({ length: 1 + next() % 20 }, () => alphabet[next() % alphabet.length]).join('');
      rememberCredential(secret);
      const forms = [secret, `prefix ${secret} suffix`, encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()), Buffer.from(secret).toString('base64'), `Bearer ${secret}`];
      const serialized = JSON.stringify(redactOutput(forms));
      expect(JSON.parse(serialized), `case ${caseNumber}`).toEqual(forms.map(() => '[REDACTED]'));
    }
  });

  it('preserves fixed envelope keys and error kind for a one-character credential', async () => {
    const server = await import('node:http').then(({ createServer }) => createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/ok') response.end(JSON.stringify({ data: { message: 'secret e', nested: { echo: 'e' } } }));
      else {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { code: 'BAD', message: 'secret e', data: { echo: 'e' } } }));
      }
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected local test server address');
    const env = { ...process.env, CONCORD_URL: `http://127.0.0.1:${address.port}`, CONCORD_TOKEN: 'e' };
    try {
      const ok = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'GET', '/ok'], { cwd: process.cwd(), env });
      expect(JSON.parse(ok.stdout)).toEqual({ data: {}, omittedMembers: 2 });
      try {
        await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'api', 'GET', '/fail'], { cwd: process.cwd(), env });
        throw new Error('expected server failure');
      } catch (error) {
        const diagnostic = JSON.parse((error as { stderr: string }).stderr.split('\n').find(line => line.startsWith('{"error":')) ?? '');
        expect(diagnostic.error).toMatchObject({ kind: 'server', status: 400 });
        expect(diagnostic.omittedMembers).toBe(1);
        expect(diagnostic.error.message).not.toContain('secret e');
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
