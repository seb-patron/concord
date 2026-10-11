import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ConcordClient } from '../../cli/client.ts';
import { git } from '../../cli/git.ts';
import { startGitBridge, type GitBridge } from '../../local/git-bridge.ts';
import { bridgeStorage } from '../../src/storage/bridge.ts';
import { runAwMock } from '../../adapters/aw-mock.ts';

const scratch: string[] = [];
const bridges: GitBridge[] = [];
const servers: Server[] = [];
const execFile = promisify(execFileCallback);
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'concord-aw-test-')); scratch.push(directory);
  const bridge = await startGitBridge(join(directory, 'bridge'), 'aw-mock-bridge-test-secret'); bridges.push(bridge);
  const storage = bridgeStorage(bridge.url);
  const canonical = await storage.ensureRepo('canonical');
  const worktree = join(directory, 'seed');
  await git(['init', '-b', 'main', worktree]);
  const seed = join(directory, 'seed.txt'); await writeFile(seed, 'public synthetic base\n');
  const blob = await git(['hash-object', '-w', seed], {}, worktree);
  await git(['update-index', '--add', '--cacheinfo', `100644,${blob},seed.txt`], {}, worktree);
  const tree = await git(['write-tree'], {}, worktree);
  const baseOid = await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'seed'], {}, worktree);
  await git(['update-ref', 'refs/heads/main', baseOid], {}, worktree);
  await git(['push', '--', canonical.remote, 'HEAD:refs/heads/main'], {}, worktree);
  const fixturePath = join(directory, 'aw-task.json'); const statePath = join(directory, 'run-state.json');
  const fixture = { schemaVersion: 1, project: 'demo', taskId: 'task-7', explicitAttempt: 1, intent: 'Apply mock edit',
    unitKeys: ['unit:a'], workerLabel: 'synthetic-agent', worktree: join(directory, 'aw-installation-unused'), observedBaseOid: baseOid };
  const saveFixture = () => writeFile(fixturePath, JSON.stringify(fixture));
  await saveFixture();
  type Change = { changeId: string; intentKey: string; intentText: string; branch: string; unitKeys: string[]; baseOid: string; headOid: string | null; revision: number; status: string; version: number; candidateStorageName: string };
  const changes: Change[] = [];
  const api = { creates: 0, claims: 0, publishes: 0, enqueues: 0, registers: 0, leaseConflict: false, queueUnavailable: false, publishPreparationUnavailable: false, publishUnavailable: false,
    leases: [] as Array<{ changeId: string; unitKey: string; fence: number; state: string; expiresAt: number }>,
    branches: [] as Array<{ storageName: string; ref: string; observedHead: string }>,
    queue: [] as Array<{ changeId: string; state: string }>,
    lastEnqueueFences: null as Record<string, number> | null,
    verdicts: [] as Array<{ verdictId: string; revision: number; decision: string }>, lastAttempt: 0, globalVersion: 1, nextFence: 7, canonicalOid: baseOid };
  const createBodies = new Map<string, string>();
  const keyed = new Map<string, { body: string; status: number; payload: string }>();
  const events: Array<{ sequence: number; kind: string; relatedIds: string[] }> = [];
  const claimKeys: string[] = [];
  const record = (kind: string, changeId: string) => events.push({ sequence: events.length + 1, kind, relatedIds: [changeId] });
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, version: api.globalVersion }), { status, headers: { 'content-type': 'application/json' } });
  const fail = (code: string, status = 409, details?: unknown) => new Response(JSON.stringify({ error: { code, message: code, details } }), { status });
  const handle: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const path = url.pathname;
    if (path === '/v1/repos/demo' && method === 'GET') return ok({ canonicalStorageName: 'canonical', observedCanonicalOid: api.canonicalOid, version: 1, status: 'ready' });
    if (path === '/v1/repos/demo/events' && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const items = events.filter(event => event.sequence > after).slice(0, 100);
      return ok({ items, nextCursor: events.some(event => event.sequence > (items.at(-1)?.sequence ?? after)) ? 'more' : null });
    }
    if (path === '/v1/repos/demo/changes' && method === 'GET') return ok({ items: changes, nextCursor: null });
    if (path === '/v1/repos/demo/changes' && method === 'POST') {
      api.creates++;
      const key = new Headers(init?.headers).get('idempotency-key') ?? '';
      if (createBodies.has(key) && createBodies.get(key) !== JSON.stringify(body)) return fail('IDEMPOTENCY_CONFLICT');
      createBodies.set(key, JSON.stringify(body));
      const prior = changes.at(-1);
      if (prior) {
        if (prior.intentKey !== body.intentKey || prior.intentText !== body.intentText || JSON.stringify(prior.unitKeys) !== JSON.stringify(body.unitKeys) || prior.branch !== body.branch) return fail('INTENT_CONFLICT');
        if (!['merged', 'closed', 'superseded'].includes(prior.status)) {
          if (body.attempt !== api.lastAttempt) return fail('ATTEMPT_CONFLICT');
          return ok(prior);
        }
        if (body.attempt !== api.lastAttempt + 1) return fail('ATTEMPT_REQUIRED');
      } else if (body.attempt !== 1) return fail('ATTEMPT_CONFLICT');
      api.lastAttempt = body.attempt as number;
      const id = `change-${changes.length + 1}`;
      const candidateStorageName = `fork-${changes.length + 1}`;
      await storage.fork('canonical', candidateStorageName);
      const change: Change = { changeId: id, intentKey: String(body.intentKey), intentText: String(body.intentText), branch: String(body.branch),
        unitKeys: body.unitKeys as string[], baseOid: String(body.baseOid), headOid: null, revision: 0, status: 'draft', version: changes.length + 2, candidateStorageName };
      changes.push(change); api.globalVersion++; return ok(change, 201);
    }
    const changeMatch = /^\/v1\/repos\/demo\/changes\/(change-\d+)$/.exec(path);
    if (changeMatch && method === 'GET') return ok(changes.find(item => item.changeId === changeMatch[1]));
    if (path === '/v1/repos/demo/leases' && method === 'POST') {
      api.claims++;
      claimKeys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (api.leaseConflict) {
        record('lease.refused', String(body.changeId));
        return fail('LEASE_CONFLICT', 409, { holderId: 'other-agent', intentText: 'Other work', keys: ['unit:a'], nextAction: 'Wait for holder' });
      }
      api.globalVersion++;
      const lease = { changeId: String(body.changeId), unitKey: 'unit:a', fence: api.nextFence++, state: 'active', expiresAt: Date.now() + 120_000 };
      api.leases.push(lease);
      record('lease.claimed', lease.changeId);
      return ok({ leases: [lease] }, 201);
    }
    if (path === '/v1/repos/demo/leases' && method === 'GET') return ok({ items: api.leases, nextCursor: null });
    if (path === '/v1/repos/demo/branches' && method === 'GET') return ok({ items: api.branches, nextCursor: null });
    if (path === '/v1/repos/demo/git-token' && method === 'POST') {
      if (body.expectedVersion !== api.globalVersion) return fail('STALE_VERSION');
      if (body.scope === 'write' && api.publishPreparationUnavailable) return fail('MODULE_UNAVAILABLE', 501);
      const remote = await storage.info(String(body.storageName));
      if (!remote) return fail('STORAGE_NOT_FOUND', 404);
      return ok({ remote: remote.remote, secret: 'bridge-issued-test-secret' });
    }
    if (path === '/v1/repos/demo/branches' && method === 'POST') {
      api.registers++;
      if (body.expectedVersion !== api.globalVersion) return fail('STALE_VERSION');
      const head = await storage.resolveRef(String(body.storageName), String(body.ref));
      if (body.ownerId !== 'mock-aw' || head !== body.observedHead) return fail('BRANCH_NOT_REGISTERED');
      api.branches.push({ storageName: String(body.storageName), ref: String(body.ref), observedHead: head! });
      api.globalVersion++; return ok({ observedHead: head });
    }
    const publishMatch = /^\/v1\/repos\/demo\/changes\/(change-\d+)\/publish$/.exec(path);
    if (publishMatch && method === 'POST') {
      api.publishes++;
      if (body.expectedVersion !== api.globalVersion) return fail('STALE_VERSION');
      if (api.publishUnavailable) return fail('MODULE_UNAVAILABLE', 501);
      if ((body.leaseFences as Record<string, number>)['unit:a'] !== [...api.leases].reverse().find(item => item.changeId === publishMatch[1] && item.expiresAt > Date.now())?.fence) return fail('LEASE_STALE');
      const change = changes.find(item => item.changeId === publishMatch[1])!;
      const commit = await storage.readCommit(change.candidateStorageName, String(body.headOid));
      if (!commit || commit.parents[0] !== baseOid || await storage.resolveRef(change.candidateStorageName, change.branch) !== body.headOid) return fail('HEAD_NOT_FOUND', 422);
      change.headOid = String(body.headOid); change.revision++; change.version = ++api.globalVersion; return ok(change, 202);
    }
    const verdictMatch = /^\/v1\/repos\/demo\/changes\/(change-\d+)\/verdicts$/.exec(path);
    if (verdictMatch && method === 'GET') return ok({ items: api.verdicts });
    if (path === '/v1/repos/demo/queue' && method === 'GET') return ok({ items: api.queue, nextCursor: null });
    if (path === '/v1/repos/demo/queue/enqueue' && method === 'POST') {
      api.enqueues++;
      if (body.expectedVersion !== api.globalVersion) return fail('STALE_VERSION');
      if (api.queueUnavailable) return fail('MODULE_UNAVAILABLE', 501);
      api.lastEnqueueFences = body.leaseFences as Record<string, number>;
      if (api.lastEnqueueFences['unit:a'] !== [...api.leases].reverse().find(item => item.changeId === body.changeId && item.expiresAt > Date.now())?.fence) return fail('LEASE_STALE');
      api.queue.push({ changeId: String(body.changeId), state: 'waiting' });
      changes.find(item => item.changeId === body.changeId)!.status = 'queued';
      return ok({ entryId: 'queue-1', state: 'waiting' }, 202);
    }
    return fail('NOT_FOUND', 404);
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = new Headers(init?.headers).get('idempotency-key');
    if (method !== 'POST' || !key) return handle(input, init);
    const slot = `${url.pathname}:${key}`;
    const body = String(init?.body ?? '');
    const prior = keyed.get(slot);
    if (prior) return prior.body === body ? new Response(prior.payload, { status: prior.status }) : fail('IDEMPOTENCY_CONFLICT');
    const response = await handle(input, init);
    // Concord records returned lease refusals and successful mutations. A
    // thrown module error (the harness's 5xx responses) is not recorded.
    if (response.ok || url.pathname.endsWith('/leases') && response.status === 409) {
      keyed.set(slot, { body, status: response.status, payload: await response.clone().text() });
    }
    return response;
  };
  const client = new ConcordClient({ url: 'http://127.0.0.1:8787', token: 'local-mock-aw', fetch: fetcher, sleep: async () => {} });
  const run = () => runAwMock(fixturePath, statePath, client);
  const startServer = async () => {
    const server = createServer(async (request, response) => {
      try {
        let body = ''; for await (const part of request) body += part.toString();
        const forwarded = await fetcher(`http://127.0.0.1:8787${request.url ?? ''}`, {
          method: request.method, headers: { 'idempotency-key': String(request.headers['idempotency-key'] ?? '') }, ...(body ? { body } : {}),
        });
        response.writeHead(forwarded.status, { 'content-type': 'application/json' }).end(await forwarded.text());
      } catch (error) { response.writeHead(500).end(String(error)); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local test server');
    return `http://127.0.0.1:${address.port}`;
  };
  return { directory, storage, fixture, fixturePath, statePath, saveFixture, changes, api, baseOid, run, startServer, claimKeys };
}

describe('AW mock adapter', () => {
  it('publishes a real descendant commit once across seven retries, changed base, and lost local state', async () => {
    const h = await harness();
    const first = await h.run();
    expect(first).toMatchObject({ mock: true, phase: 'awaiting_review', changeId: 'change-1' });
    expect(first.operations).toMatchObject({
      prepareWorktree: { repoId: 'demo', changeId: 'change-1', url: 'http://127.0.0.1:8787/v1/repos/demo' },
      openChange: { changeId: 'change-1' }, reviewStatus: { changeId: 'change-1' }, requestLanding: { changeId: 'change-1', state: 'deferred' },
    });
    expect(first.headOid).toMatch(/^[a-f0-9]{40}$/);
    expect(first.headOid).not.toBe(h.baseOid);
    expect(await h.storage.readCommit(h.changes[0].candidateStorageName, String(first.headOid))).toMatchObject({ parents: [h.baseOid] });
    for (let i = 0; i < 7; i++) expect((await h.run()).changeId).toBe(first.changeId);
    const newer = join(h.directory, 'newer.txt'); await writeFile(newer, 'later canonical observation\n');
    const newerBlob = await git(['hash-object', '-w', newer], {}, join(h.directory, 'seed'));
    await git(['update-index', '--add', '--cacheinfo', `100644,${newerBlob},newer.txt`], {}, join(h.directory, 'seed'));
    const newerTree = await git(['write-tree'], {}, join(h.directory, 'seed'));
    const newerOid = await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', newerTree, '-p', h.baseOid, '-m', 'later base'], {}, join(h.directory, 'seed'));
    await git(['update-ref', 'refs/heads/main', newerOid], {}, join(h.directory, 'seed'));
    await git(['push', '--', (await h.storage.info('canonical'))!.remote, 'HEAD:refs/heads/main'], {}, join(h.directory, 'seed'));
    h.api.canonicalOid = newerOid;
    h.fixture.observedBaseOid = newerOid; await h.saveFixture();
    expect((await h.run()).changeId).toBe(first.changeId);
    await rm(h.statePath);
    const url = await h.startServer();
    const restarted = await execFile(process.execPath, ['--import', 'tsx', 'adapters/aw-mock.ts', '--fixture', h.fixturePath, '--run-state', h.statePath], {
      cwd: process.cwd(), timeout: 20_000, env: { ...process.env, CONCORD_URL: url, CONCORD_TOKEN: 'local-mock-aw' },
    });
    expect(JSON.parse(restarted.stdout)).toMatchObject({ changeId: first.changeId, phase: 'awaiting_review', headOid: first.headOid });
    expect(h.changes).toHaveLength(1);
    expect(h.api).toMatchObject({ claims: 1, publishes: 1, enqueues: 0 });
    expect(h.api.creates).toBe(1);
    expect(JSON.parse(await readFile(h.statePath, 'utf8')).mappings['demo/task-7/1'].changeId).toBe(first.changeId);
  });

  it.each([
    ['opened', 'awaiting_review', 2, 1, 0],
    ['leased', 'awaiting_review', 1, 1, 0],
    ['registered', 'awaiting_review', 1, 4, 0],
    ['published', 'awaiting_review', 1, 1, 0],
    ['ready', 'awaiting_review', 1, 1, 0],
    ['approved', 'queued', 1, 1, 1],
    ['approved-without-lease', 'queued', 2, 1, 1],
    ['queued', 'queued', 1, 1, 1],
    ['checking', 'queued', 1, 1, 1],
    ['queue-entry', 'queued', 1, 1, 0],
    ['blocked', 'blocked', 1, 1, 0],
    ['merged', 'blocked', 1, 1, 0],
  ] as const)('resumes after state loss from %s', async (stage, phase, claims, publishes, enqueues) => {
    const h = await harness();
    if (stage === 'opened') h.api.leaseConflict = true;
    if (stage === 'leased') h.api.publishPreparationUnavailable = true;
    if (stage === 'registered') h.api.publishUnavailable = true;
    const first = await h.run();
    h.api.leaseConflict = false;
    h.api.publishPreparationUnavailable = false;
    h.api.publishUnavailable = false;
    if (['approved', 'approved-without-lease', 'queued', 'checking'].includes(stage)) h.api.verdicts.push({ verdictId: 'reviewer-verdict', revision: 1, decision: 'approve' });
    if (stage === 'ready') h.changes[0].status = 'ready';
    if (stage === 'approved') h.api.leases[0].fence = 9;
    if (stage === 'approved-without-lease') h.api.leases.length = 0;
    if (stage === 'queued' || stage === 'checking') await h.run();
    if (stage === 'checking') h.changes[0].status = 'checking';
    if (stage === 'queue-entry') h.api.queue.push({ changeId: first.changeId, state: 'waiting' });
    if (stage === 'blocked' || stage === 'merged') h.changes[0].status = stage;
    await rm(h.statePath);
    const resumed = await h.run();
    expect(resumed).toMatchObject({ changeId: first.changeId, phase });
    if (stage === 'opened' || stage === 'leased' || stage === 'registered') expect(resumed.headOid).toMatch(/^[a-f0-9]{40}$/);
    if (stage === 'registered') expect(h.api.registers).toBe(1);
    if (stage === 'blocked') expect(resumed.blocked).toMatchObject({ code: 'CHECKER_BLOCKED' });
    if (stage === 'merged') expect(resumed.blocked).toMatchObject({ code: 'ATTEMPT_REQUIRED' });
    if (stage === 'approved') expect(h.api.lastEnqueueFences).toEqual({ 'unit:a': 9 });
    if (stage === 'approved-without-lease') expect(h.api.lastEnqueueFences).toEqual({ 'unit:a': 8 });
    expect(h.changes).toHaveLength(1);
    expect(h.api).toMatchObject({ claims, publishes, enqueues, creates: 1 });
    expect(JSON.parse(await readFile(h.statePath, 'utf8')).mappings['demo/task-7/1']).toMatchObject({ changeId: first.changeId, phase });
  });

  it('rejects conflicting intent for the same key, even after local state is lost', async () => {
    const h = await harness(); await h.run();
    h.fixture.intent = 'Different intent'; await h.saveFixture();
    await expect(h.run()).rejects.toMatchObject({ kind: 'conflict' });
    await rm(h.statePath);
    await expect(h.run()).rejects.toMatchObject({ kind: 'conflict' });
    expect(h.changes).toHaveLength(1);
  });

  it('returns lease refusal with holder details and never publishes a candidate', async () => {
    const h = await harness(); h.api.leaseConflict = true;
    const result = await h.run();
    expect(result).toMatchObject({ phase: 'blocked', blocked: { code: 'LEASE_CONFLICT', details: { holderId: 'other-agent' } } });
    expect(h.api.publishes).toBe(0);
    expect(JSON.parse(await readFile(h.statePath, 'utf8')).mappings['demo/task-7/1'].block.code).toBe('LEASE_CONFLICT');
  });

  it('uses a new claim key after a recorded refusal and lost run state', async () => {
    const h = await harness(); h.api.leaseConflict = true;
    expect(await h.run()).toMatchObject({ phase: 'blocked', blocked: { code: 'LEASE_CONFLICT' } });
    expect(h.claimKeys).toHaveLength(1);
    h.api.leaseConflict = false;
    await rm(h.statePath);
    expect(await h.run()).toMatchObject({ phase: 'awaiting_review', changeId: 'change-1' });
    expect(h.claimKeys).toHaveLength(2);
    expect(new Set(h.claimKeys).size).toBe(2);
    expect(h.api.publishes).toBe(1);
  });

  it('uses a new claim key after an expired lease and lost run state', async () => {
    const h = await harness(); h.api.publishPreparationUnavailable = true;
    expect(await h.run()).toMatchObject({ phase: 'blocked', blocked: { status: 501 } });
    expect(h.claimKeys).toHaveLength(1);
    h.api.leases[0].expiresAt = Date.now() - 1;
    h.api.publishPreparationUnavailable = false;
    await rm(h.statePath);
    const result = await h.run();
    expect(result.blocked).toBeUndefined();
    expect(result).toMatchObject({ phase: 'awaiting_review', changeId: 'change-1' });
    expect(h.claimKeys).toHaveLength(2);
    expect(new Set(h.claimKeys).size).toBe(2);
    expect(h.api.leases.map(lease => lease.fence)).toEqual([7, 8]);
    expect(h.api.publishes).toBe(1);
  });

  it('waits for independent review, then records unavailable queue as a structured blocked terminal run', async () => {
    const h = await harness();
    expect((await h.run()).phase).toBe('awaiting_review');
    expect(h.api.enqueues).toBe(0);
    h.api.verdicts.push({ verdictId: 'reviewer-verdict-1', revision: 1, decision: 'approve' });
    h.api.queueUnavailable = true;
    const result = await h.run();
    expect(result).toMatchObject({ phase: 'blocked', blocked: { code: 'MODULE_UNAVAILABLE', status: 501 } });
    expect(h.api.enqueues).toBe(3); // The shared client retries a keyed 501 at most three times.
    expect(JSON.parse(await readFile(h.statePath, 'utf8')).mappings['demo/task-7/1'].block.code).toBe('MODULE_UNAVAILABLE');
    await h.run();
    expect(h.api.enqueues).toBe(3); // A terminal run refusal is not silently retried.
  });

  it('enqueues only after a reviewer verdict exists for the active revision', async () => {
    const h = await harness();
    expect((await h.run()).phase).toBe('awaiting_review');
    expect(h.api.enqueues).toBe(0);
    h.api.verdicts.push({ verdictId: 'independent-verdict', revision: 1, decision: 'approve' });
    expect((await h.run()).phase).toBe('queued');
    expect(h.api.enqueues).toBe(1);
  });

  it('requires an explicit incremented attempt after terminal state and recognizes failed inspection', async () => {
    const h = await harness(); await h.run();
    h.changes[0].status = 'blocked';
    expect(await h.run()).toMatchObject({ phase: 'blocked', blocked: { code: 'CHECKER_BLOCKED' } });
    h.changes[0].status = 'merged';
    expect(await h.run()).toMatchObject({ phase: 'blocked', blocked: { code: 'ATTEMPT_REQUIRED' } });
    h.fixture.explicitAttempt = 2; await h.saveFixture();
    expect(await h.run()).toMatchObject({ changeId: 'change-2', identity: 'demo/task-7/2', phase: 'awaiting_review' });
    await rm(h.statePath);
    expect(await h.run()).toMatchObject({ changeId: 'change-2', identity: 'demo/task-7/2' });
    expect(h.changes).toHaveLength(2);
    expect(h.api.publishes).toBe(2);
  });
});
