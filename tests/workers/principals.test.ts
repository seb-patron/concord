import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { authenticate } from '../../src/auth';
import type { RepoCoordinator } from '../../src/coordinator';
import type { Job, ModuleContext, Principal } from '../../src/contracts';
import { jobInput, runners } from '../../src/features/runners';
import { digest } from '../../src/http';
import { localFixtureConfig } from '../../src/state';
import { FakeStorage } from '../../src/storage/fake';
import { apiRequest, mutation, responseBody } from '../helpers';
import runnerGuide from '../../docs/runner.md?raw';

const runtime = env as Env;
const originalConfig = runtime.TRUSTED_CONFIG;
const originalTokens = runtime.AUTH_TOKENS;
const originalNow = runtime.CONCORD_TEST_NOW;
afterEach(() => {
  runtime.TRUSTED_CONFIG = originalConfig;
  runtime.AUTH_TOKENS = originalTokens;
  runtime.CONCORD_TEST_NOW = originalNow;
});
const fetchApi = (request: Request) => worker.fetch(request, env);
const mint = (body: Record<string, unknown>, key = crypto.randomUUID(), token = 'local-agent-a') =>
  fetchApi(mutation('/v1/principals', body, key, token));
async function scopedViewerParent(): Promise<string> {
  const secret = `scoped-viewer-${crypto.randomUUID()}`;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  runtime.AUTH_TOKENS = JSON.stringify({ [hash]: { tenantId: 'local', principalId: 'scoped-viewer',
    roles: ['agent', 'viewer'], repoIds: ['alpha'], expiresAt: Date.now() + 60_000 } });
  return secret;
}

describe('delegated principals', () => {
  it('skips the catalog for tokens outside the exact delegated format', async () => {
    const idFromName = vi.fn(() => { throw new Error('unexpected catalog lookup'); });
    const get = vi.fn(() => { throw new Error('unexpected catalog lookup'); });
    const guardedEnv = { CONCORD_MODE: 'production', AUTH_TOKENS: '{}',
      TENANT_CATALOG: { idFromName, get } } as unknown as Env;
    const tokens = ['ordinary-token', 'cct_', `cct_local_${'a'.repeat(63)}`,
      `cct_local_${'a'.repeat(65)}`, `cct_local_${'g'.repeat(64)}`, `cct_${'a'.repeat(65)}_${'a'.repeat(64)}`];
    for (const token of tokens) {
      await expect(authenticate(apiRequest('/v1/repos', token), guardedEnv))
        .rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    }
    expect(idFromName).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects unknown delegated tenants before catalog access and charges the auth-failure limiter', async () => {
    const idFromName = vi.fn(() => { throw new Error('unexpected catalog lookup'); });
    const get = vi.fn(() => { throw new Error('unexpected catalog lookup'); });
    const limit = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const guardedEnv = { CONCORD_MODE: 'production',
      AUTH_TOKENS: JSON.stringify({ operator: { tenantId: 'known', principalId: 'owner',
        roles: ['owner'], repoIds: '*', expiresAt: Date.now() + 60_000 } }),
      TENANT_CATALOG: { idFromName, get }, AUTH_RATE_LIMIT: { limit } } as unknown as Env;
    const first = await worker.fetch(apiRequest('/v1/repos', `cct_trialA_${'a'.repeat(64)}`), guardedEnv);
    expect(first.status).toBe(401);
    expect((await responseBody(first)).error.code).toBe('UNAUTHORIZED');
    const second = await worker.fetch(apiRequest('/v1/repos', `cct_trialB_${'b'.repeat(64)}`), guardedEnv);
    expect(second.status).toBe(429);
    expect((await responseBody(second)).error.code).toBe('RATE_LIMITED');
    expect(limit).toHaveBeenCalledTimes(2);
    expect(idFromName).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('looks up a delegated token for a tenant provisioned by AUTH_TOKENS', async () => {
    const principal = { tenantId: 'known', principalId: 'agent', roles: ['agent'],
      repoIds: '*', expiresAt: Date.now() + 60_000 };
    const fetch = vi.fn(async () => Response.json({ data: principal }));
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => 'catalog-id');
    const guardedEnv = { CONCORD_MODE: 'production',
      AUTH_TOKENS: JSON.stringify({ operator: { ...principal, principalId: 'owner', roles: ['owner'] } }),
      TENANT_CATALOG: { idFromName, get } } as unknown as Env;
    const token = `cct_known_${'a'.repeat(64)}`;
    await expect(authenticate(apiRequest('/v1/repos', token), guardedEnv)).resolves.toMatchObject(principal);
    expect(idFromName).toHaveBeenCalledWith('tenant:known');
    expect(get).toHaveBeenCalledWith('catalog-id');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not charge a valid delegated token to the auth-failure limiter', async () => {
    const created = (await responseBody(await mint({ roles: ['agent'] }))).data;
    const limit = vi.fn(async () => ({ success: true }));
    const guardedEnv = { ...runtime, AUTH_RATE_LIMIT: { limit } } as Env;
    expect((await worker.fetch(apiRequest('/v1/repos', created.token), guardedEnv)).status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
    expect((await worker.fetch(apiRequest('/v1/repos', `cct_local_${'a'.repeat(64)}`), guardedEnv)).status).toBe(401);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('mints a scoped token, uses it on existing routes, and lists metadata without secrets', async () => {
    const response = await mint({ roles: ['agent'], repoIds: ['alpha'], ttlSeconds: 3600, name: 'worker' });
    expect(response.status).toBe(201);
    const item = (await responseBody(response)).data;
    expect(item.token).toMatch(/^cct_local_[a-f0-9]{64}$/);
    expect(item).toMatchObject({ roles: ['agent'], repoIds: ['alpha'], parentId: 'agent-a', name: 'worker', revokedAt: null });
    expect((await fetchApi(apiRequest('/v1/repos/alpha/snapshot', item.token))).status).toBe(200);
    expect((await fetchApi(apiRequest('/v1/repos/beta/snapshot', item.token))).status).toBe(403);
    const listing = (await responseBody(await fetchApi(apiRequest('/v1/principals')))).data.items;
    expect(listing.find((entry: { id: string }) => entry.id === item.id)).toMatchObject({ id: item.id, roles: ['agent'] });
    expect(JSON.stringify(listing)).not.toContain(item.token);
    expect(JSON.stringify(listing)).not.toContain('token_digest');
  });

  it('stores and returns trimmed self-reported agent metadata', async () => {
    const agent = { model: ' m-1 ', effort: ' high ', harness: ' harness-1 ', host: ' host-1 ', launchedFrom: ' parent-1 ' };
    const response = await mint({ roles: ['agent'], agent, name: 'worker' });
    expect(response.status).toBe(201);
    const created = (await responseBody(response)).data;
    const expected = { model: 'm-1', effort: 'high', harness: 'harness-1', host: 'host-1', launchedFrom: 'parent-1' };
    expect(created.agent).toEqual(expected);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/principals/${created.id}`)))).data.agent).toEqual(expected);
    const listing = (await responseBody(await fetchApi(apiRequest('/v1/principals')))).data.items;
    expect(listing.find((item: { id: string }) => item.id === created.id).agent).toEqual(expected);
    expect(JSON.stringify(created)).not.toContain('token_digest');
  });

  it('rejects descriptor values exceeding their length limits and control characters', async () => {
    const overLimits: Record<string, string> = {
      model: 'm'.repeat(65), effort: 'e'.repeat(17), harness: 'h'.repeat(33),
      host: 'h'.repeat(65), launchedFrom: 'l'.repeat(129),
    };
    for (const [field, value] of Object.entries(overLimits)) {
      const response = await mint({ roles: ['agent'], agent: { [field]: value } });
      expect(response.status).toBe(400);
      expect((await responseBody(response)).error.code).toBe('INVALID_AGENT');
    }
    const control = await mint({ roles: ['agent'], agent: { model: 'm-1\nother' } });
    expect(control.status).toBe(400);
    expect((await responseBody(control)).error.code).toBe('INVALID_AGENT');
  });

  it('records a delegated descriptor as the change author after an owner seed', async () => {
    const parentToken = `descriptor-parent-${crypto.randomUUID()}`;
    const parentDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parentToken))),
      byte => byte.toString(16).padStart(2, '0')).join('');
    runtime.AUTH_TOKENS = JSON.stringify({ ...JSON.parse(originalTokens ?? '{}'), [parentDigest]: {
      tenantId: 'local', principalId: 'descriptor-parent', roles: ['owner', 'agent'], repoIds: '*', expiresAt: Date.now() + 3_600_000,
    } });
    const repoId = `agent_descriptor_${crypto.randomUUID().replaceAll('-', '')}`;
    const repoResponse = await fetchApi(mutation('/v1/repos', { name: repoId, policyId: 'local-demo', profileId: 'local-demo' }, crypto.randomUUID()));
    expect([201, 202]).toContain(repoResponse.status);
    const repo = (await responseBody(repoResponse)).data;
    await fetchApi(apiRequest(`/v1/repos/${repoId}`));
    const ownerSeed = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
      intentKey: 'owner-seed', intentText: 'initialize test repository', baseOid: null,
      branch: 'refs/heads/owner-seed', unitKeys: [], dependencyChangeIds: [],
    }, crypto.randomUUID()));
    expect(ownerSeed.status).toBe(201);
    const owner: Principal = { tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
    const stub = runtime.REPO_COORDINATOR.get(runtime.REPO_COORDINATOR.idFromName(`repo:local:${repoId}`));
    const seedOid = 'a'.repeat(40);
    await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
      const context = (instance as unknown as { context(name: 'repos', principal: Principal, repoId: string): ModuleContext })
        .context('repos', owner, repoId);
      const storage = context.storage as FakeStorage;
      await storage.ensureRepo(repo.canonicalStorageName);
      storage.putCommit(repo.canonicalStorageName, { oid: seedOid, treeOid: 'b'.repeat(40), parents: [] });
      expect(storage.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, seedOid)).toBe(true);
    });
    const agent = { model: 'm-1', effort: 'high', harness: 'harness-1', host: 'host-1', launchedFrom: 'parent-1' };
    const mintResponse = await mint({ roles: ['agent'], repoIds: [repoId], name: 'worker', agent, ttlSeconds: 120 }, crypto.randomUUID(), parentToken);
    expect(mintResponse.status).toBe(201);
    const minted = (await responseBody(mintResponse)).data;
    const changeResponse = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
      intentKey: 'descriptor-task', intentText: 'descriptor task', baseOid: seedOid,
      branch: 'refs/heads/descriptor', unitKeys: [], dependencyChangeIds: [],
    }, crypto.randomUUID(), minted.token));
    const changeEnvelope = await responseBody(changeResponse);
    expect(changeResponse.status, JSON.stringify(changeEnvelope)).toBe(201);
    const change = changeEnvelope.data;
    const expectedAuthor = { ...agent, startedAt: minted.createdAt, name: 'worker' };
    expect(change.authorModel).toBe('m-1');
    expect(change.authorAgent).toEqual(expectedAuthor);
    const listed = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repoId}/changes`)))).data.items;
    expect(listed.find((item: { changeId: string }) => item.changeId === change.changeId).authorAgent).toEqual(expectedAuthor);
    const snapshot = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repoId}/snapshot`)))).data.projections.repos.changes;
    expect(snapshot.find((item: { changeId: string }) => item.changeId === change.changeId).authorAgent).toEqual(expectedAuthor);
    const plainResponse = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
      intentKey: 'plain-task', intentText: 'plain task', baseOid: seedOid,
      branch: 'refs/heads/plain', unitKeys: [], dependencyChangeIds: [],
    }, crypto.randomUUID()));
    expect(plainResponse.status).toBe(201);
    const plain = (await responseBody(plainResponse)).data;
    expect(plain.authorModel).toBeNull();
    expect(plain).not.toHaveProperty('authorAgent');
  });

  it('reads mint and revoke from the tenant event stream in order without secrets', async () => {
    const before = await responseBody(await fetchApi(apiRequest('/v1/principals')));
    const cursor = btoa(String(before.eventSeq));
    const minted = await mint({ roles: ['agent'], repoIds: ['alpha'] });
    expect(minted.status).toBe(201);
    const created = (await responseBody(minted)).data;
    const revoked = await fetchApi(apiRequest(`/v1/principals/${created.id}`, 'local-agent-a', { method: 'DELETE' }));
    expect(revoked.status).toBe(200);

    const first = await fetchApi(apiRequest(`/v1/events?cursor=${cursor}&limit=1`, 'local-owner'));
    expect(first.status).toBe(200);
    const firstPage = await responseBody(first);
    expect(firstPage.data.items).toHaveLength(1);
    expect(firstPage.data.items[0]).toMatchObject({ kind: 'principal.minted', actorId: 'agent-a', relatedIds: [created.id],
      payload: { parentId: 'agent-a', roles: ['agent'], repoIds: ['alpha'], expiresAt: created.expiresAt } });
    expect(firstPage.data.nextCursor).toBeTruthy();
    const second = await fetchApi(apiRequest(`/v1/events?cursor=${encodeURIComponent(firstPage.data.nextCursor)}&limit=1`));
    expect(second.status).toBe(200);
    const secondPage = await responseBody(second);
    expect(secondPage.data.items).toHaveLength(1);
    expect(secondPage.data.items[0]).toMatchObject({ kind: 'principal.revoked', actorId: 'agent-a', relatedIds: [created.id], payload: { rootId: created.id } });
    expect(secondPage.data.items[0].sequence).toBeGreaterThan(firstPage.data.items[0].sequence);
    expect(secondPage.data.nextCursor).toBeNull();
    expect(secondPage.eventSeq).toBe(secondPage.data.items[0].sequence);
    const eventsJson = JSON.stringify([...firstPage.data.items, ...secondPage.data.items]);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(created.token))),
      byte => byte.toString(16).padStart(2, '0')).join('');
    expect(eventsJson).not.toContain(created.token);
    expect(eventsJson).not.toContain(digest);
    expect(eventsJson).not.toContain('token_digest');
    expect(eventsJson).not.toContain('tokenDigest');
    expect((await fetchApi(apiRequest('/v1/events', 'local-agent-a'))).status).toBe(403);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/events?cursor=${cursor}`, 'local-viewer')))).data.items).toEqual([]);
    expect((await fetchApi(apiRequest('/v1/events?cursor=bad!', 'local-viewer'))).status).toBe(400);
    expect((await fetchApi(apiRequest('/v1/events?limit=101', 'local-viewer'))).status).toBe(400);
  });

  it('filters catalog events before paging and hides storage names from scoped viewers', async () => {
    const before = await responseBody(await fetchApi(apiRequest('/v1/events')));
    const cursor = btoa(String(before.eventSeq));
    const parent = await scopedViewerParent();
    const minted = await mint({ roles: ['viewer'], repoIds: ['alpha'], ttlSeconds: 30 }, crypto.randomUUID(), parent);
    expect(minted.status).toBe(201);
    const viewer = (await responseBody(minted)).data;
    for (const name of ['beta', 'alpha']) {
      const created = await fetchApi(mutation('/v1/repos', { name, policyId: 'local-demo', profileId: 'local-demo' }, crypto.randomUUID()));
      expect([201, 202]).toContain(created.status);
    }
    const visibleRepos = (await responseBody(await fetchApi(apiRequest('/v1/repos', viewer.token)))).data.items;
    expect(visibleRepos.map((repo: { repoId: string }) => repo.repoId)).toEqual(['alpha']);

    const ownerEvents = (await responseBody(await fetchApi(apiRequest(`/v1/events?cursor=${cursor}`)))).data.items;
    const betaEvent = ownerEvents.find((event: { kind: string; relatedIds: string[] }) =>
      event.kind === 'repo.provisioning' && event.relatedIds.includes('beta'));
    expect(betaEvent?.payload.storageName).toMatch(/^concord-r-/);
    const allViewerEvents = (await responseBody(await fetchApi(apiRequest(`/v1/events?cursor=${cursor}`, 'local-viewer')))).data.items;
    expect(allViewerEvents.some((event: { relatedIds: string[] }) => event.relatedIds.includes('beta'))).toBe(true);
    expect(JSON.stringify(allViewerEvents)).not.toContain(betaEvent.payload.storageName);
    expect(JSON.stringify(allViewerEvents)).not.toContain('storageName');

    const first = await responseBody(await fetchApi(apiRequest(`/v1/events?cursor=${cursor}&limit=1`, viewer.token)));
    expect(first.data.items).toHaveLength(1);
    expect(first.data.items[0]).toMatchObject({ kind: 'principal.minted', relatedIds: [viewer.id] });
    expect(first.data.nextCursor).toBeTruthy();
    const second = await responseBody(await fetchApi(apiRequest(
      `/v1/events?cursor=${encodeURIComponent(first.data.nextCursor)}&limit=1`, viewer.token)));
    expect(second.data.items).toHaveLength(1);
    expect(second.data.items[0]).toMatchObject({ kind: 'repo.provisioning', relatedIds: ['alpha'] });
    expect(second.data.items[0].sequence).toBeGreaterThan(first.data.items[0].sequence);
    expect(second.data.nextCursor).toBeTruthy();
    const third = await responseBody(await fetchApi(apiRequest(
      `/v1/events?cursor=${encodeURIComponent(second.data.nextCursor)}`, viewer.token)));
    const visible = [...first.data.items, ...second.data.items, ...third.data.items];
    expect(visible.every((event: { relatedIds: string[] }) => !event.relatedIds.includes('beta'))).toBe(true);
    expect(JSON.stringify(visible)).not.toContain(betaEvent.payload.storageName);
    expect(JSON.stringify(visible)).not.toContain('storageName');
    expect(third.data.nextCursor).toBeNull();
  });

  it('includes principal events for a scoped viewer and principals it minted', async () => {
    const secret = await scopedViewerParent();
    const before = await responseBody(await fetchApi(apiRequest('/v1/events', secret)));
    const cursor = btoa(String(before.eventSeq));
    const own = await mint({ roles: ['viewer'], repoIds: ['alpha'], ttlSeconds: 30 }, crypto.randomUUID(), secret);
    expect(own.status).toBe(201);
    const ownId = (await responseBody(own)).data.id;
    const other = await mint({ roles: ['agent'], repoIds: ['beta'] }, crypto.randomUUID(), 'local-agent-a');
    expect(other.status).toBe(201);
    const otherId = (await responseBody(other)).data.id;
    const revoked = await fetchApi(apiRequest(`/v1/principals/${ownId}`, secret, { method: 'DELETE' }));
    expect(revoked.status).toBe(200);
    const events = (await responseBody(await fetchApi(apiRequest(`/v1/events?cursor=${cursor}`, secret)))).data.items;
    expect(events.filter((event: { relatedIds: string[] }) => event.relatedIds.includes(ownId))
      .map((event: { kind: string }) => event.kind)).toEqual(['principal.minted', 'principal.revoked']);
    expect(events.some((event: { relatedIds: string[] }) => event.relatedIds.includes(otherId))).toBe(false);
  });

  it('hides other principals and their events from scoped viewers and agents on every read route', async () => {
    const parent = await scopedViewerParent();
    const before = (await responseBody(await fetchApi(apiRequest('/v1/events')))).eventSeq;
    const beta = (await responseBody(await mint({ roles: ['agent'], repoIds: ['beta'], name: 'beta-private-name' }))).data;
    const alphaAgent = (await responseBody(await mint({ roles: ['agent', 'viewer'], repoIds: ['alpha'], ttlSeconds: 30, name: 'alpha-agent' }, crypto.randomUUID(), parent))).data;
    const alphaViewer = (await responseBody(await mint({ roles: ['viewer'], repoIds: ['alpha'], ttlSeconds: 30, name: 'alpha-viewer' }, crypto.randomUUID(), parent))).data;
    const grandchild = (await responseBody(await mint({ roles: ['viewer'], repoIds: ['alpha'], ttlSeconds: 10, name: 'alpha-grandchild' }, crypto.randomUUID(), alphaAgent.token))).data;
    const cursor = btoa(String(before));

    for (const token of [parent, alphaAgent.token, alphaViewer.token]) {
      const listed = (await responseBody(await fetchApi(apiRequest('/v1/principals', token)))).data.items;
      expect(JSON.stringify(listed)).not.toContain('beta-private-name');
      expect(listed.some((item: { id: string }) => item.id === beta.id)).toBe(false);
      const hidden = await fetchApi(apiRequest(`/v1/principals/${beta.id}`, token));
      expect(hidden.status).toBe(404);
      const events = (await responseBody(await fetchApi(apiRequest(`/v1/events?cursor=${cursor}`, token)))).data.items;
      expect(events.some((event: { relatedIds: string[] }) => event.relatedIds.includes(beta.id))).toBe(false);
      expect(JSON.stringify(events)).not.toContain(beta.id);
    }
    const parentList = (await responseBody(await fetchApi(apiRequest('/v1/principals', parent)))).data.items;
    expect(parentList.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([alphaAgent.id, alphaViewer.id, grandchild.id]));
    const parentEvents = (await responseBody(await fetchApi(apiRequest(`/v1/events?cursor=${cursor}`, parent)))).data.items;
    expect(parentEvents.map((event: { relatedIds: string[] }) => event.relatedIds[0]))
      .toEqual(expect.arrayContaining([alphaAgent.id, alphaViewer.id, grandchild.id]));
    expect((await responseBody(await fetchApi(apiRequest(`/v1/principals/${grandchild.id}`, parent)))).data.id).toBe(grandchild.id);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/principals/${grandchild.id}`, alphaAgent.token)))).data.id).toBe(grandchild.id);
    expect((await fetchApi(apiRequest(`/v1/principals/${grandchild.id}`, alphaViewer.token))).status).toBe(404);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/principals/${beta.id}`)))).data.name).toBe('beta-private-name');
  });

  it('does not let a repository-scoped owner revoke a principal outside its scope', async () => {
    const beta = (await responseBody(await mint({ roles: ['agent'], repoIds: ['beta'] }))).data;
    const secret = `alpha-owner-${crypto.randomUUID()}`;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))),
      byte => byte.toString(16).padStart(2, '0')).join('');
    runtime.AUTH_TOKENS = JSON.stringify({ [digest]: { tenantId: 'local', principalId: 'alpha-owner',
      roles: ['owner', 'agent'], repoIds: ['alpha'], expiresAt: Date.now() + 60_000 } });
    const alphaResponse = await mint({ roles: ['agent'], repoIds: ['alpha'], ttlSeconds: 30 }, crypto.randomUUID(), secret);
    expect(alphaResponse.status).toBe(201);
    const alpha = (await responseBody(alphaResponse)).data;

    const before = (await responseBody(await fetchApi(apiRequest('/v1/events')))).eventSeq;
    const denied = await fetchApi(apiRequest(`/v1/principals/${beta.id}`, secret, { method: 'DELETE' }));
    expect(denied.status).toBe(404);
    expect((await responseBody(denied)).error.code).toBe('NOT_FOUND');
    expect((await responseBody(await fetchApi(apiRequest('/v1/events')))).eventSeq).toBe(before);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/principals/${beta.id}`)))).data.revokedAt).toBeNull();
    expect((await fetchApi(apiRequest('/v1/repos', beta.token))).status).toBe(200);

    const allowed = await fetchApi(apiRequest(`/v1/principals/${alpha.id}`, secret, { method: 'DELETE' }));
    expect(allowed.status).toBe(200);
    expect((await responseBody(allowed)).data.revokedIds).toContain(alpha.id);
    const tenantOwner = await fetchApi(apiRequest(`/v1/principals/${beta.id}`, 'local-owner', { method: 'DELETE' }));
    expect(tenantOwner.status).toBe(200);
    expect((await responseBody(tenantOwner)).data.revokedIds).toContain(beta.id);
  });

  it('refuses role, repository, TTL, and parent-expiry escalation', async () => {
    for (const roles of [['checker'], ['promoter'], ['owner'], ['reviewer'], ['viewer'], ['agent', 'viewer']]) {
      expect((await mint({ roles })).status).toBe(403);
    }
    expect((await mint({ roles: ['agent'], ttlSeconds: 86401 })).status).toBe(400);
    const source = 'scoped-parent-token';
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)));
    const hash = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    runtime.AUTH_TOKENS = JSON.stringify({ [hash]: { tenantId: 'local', principalId: 'scoped-parent', roles: ['agent'], repoIds: ['alpha'], expiresAt: Date.now() + 60_000 } });
    expect((await mint({ roles: ['agent'], repoIds: ['beta'] }, crypto.randomUUID(), source)).status).toBe(403);
    expect((await mint({ roles: ['agent'], repoIds: '*' }, crypto.randomUUID(), source)).status).toBe(403);
    expect((await mint({ roles: ['agent'], ttlSeconds: 120 }, crypto.randomUUID(), source)).status).toBe(403);
  });

  it('enforces tenant cap and never repeats a plaintext token for one idempotency key', async () => {
    const listing = (await responseBody(await fetchApi(apiRequest('/v1/principals')))).data.items as Array<{ revokedAt: number | null; expiresAt: number }>;
    const active = listing.filter(item => item.revokedAt === null && item.expiresAt > Date.now()).length;
    runtime.TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'), delegatedPrincipals: { activeLimit: active + 1 } });
    const key = crypto.randomUUID();
    expect((await mint({ roles: ['agent'] }, key)).status).toBe(201);
    expect((await mint({ roles: ['agent'] }, key)).status).toBe(409);
    expect((await mint({ roles: ['agent'] })).status).toBe(409);
  });

  it('bounds stored repository scopes', async () => {
    const repoIds = Array.from({ length: 100 }, (_, index) => `repo-${index}`);
    const tooMany = await mint({ roles: ['agent'], repoIds: [...repoIds, 'repo-100'] });
    expect(tooMany.status).toBe(400);
    expect((await responseBody(tooMany)).error.code).toBe('INVALID_SCOPE');
    const accepted = await mint({ roles: ['agent'], repoIds });
    expect(accepted.status).toBe(201);
    const item = (await responseBody(accepted)).data;
    expect(item.repoIds).toEqual(repoIds);
    expect((await fetchApi(apiRequest(`/v1/principals/${item.id}`, 'local-agent-a', { method: 'DELETE' }))).status).toBe(200);
  });

  it('paginates revoked history and enforces the total tenant cap', async () => {
    const existingIds: string[] = [];
    let cursor: string | null = null;
    do {
      const pageResponse = await fetchApi(apiRequest(`/v1/principals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
      expect(pageResponse.status).toBe(200);
      const page = (await responseBody(pageResponse)).data as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(page.items.length).toBeLessThanOrEqual(25);
      existingIds.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    runtime.TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'), delegatedPrincipals: { activeLimit: 1000, totalLimit: existingIds.length + 27 } });
    const mintedIds: string[] = [];
    for (let index = 0; index < 27; index++) {
      const created = await mint({ roles: ['agent'], repoIds: [`history-${index}`] });
      expect(created.status).toBe(201);
      const item = (await responseBody(created)).data;
      mintedIds.push(item.id);
      const revoked = await fetchApi(apiRequest(`/v1/principals/${item.id}`, 'local-agent-a', { method: 'DELETE' }));
      expect(revoked.status).toBe(200);
    }
    const rejected = await mint({ roles: ['agent'] });
    expect(rejected.status).toBe(409);
    expect((await responseBody(rejected)).error.code).toBe('PRINCIPAL_CAP');

    const allIds: string[] = [];
    cursor = null;
    let pages = 0;
    do {
      const response = await fetchApi(apiRequest(`/v1/principals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
      expect(response.status).toBe(200);
      const page = (await responseBody(response)).data as { items: Array<{ id: string; revokedAt: number | null }>; nextCursor: string | null };
      expect(page.items.length).toBeLessThanOrEqual(25);
      if (pages === 0) expect(page.items).toHaveLength(25);
      allIds.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(allIds).toHaveLength(existingIds.length + 27);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toEqual(expect.arrayContaining(mintedIds));
    const malformed = await fetchApi(apiRequest('/v1/principals?cursor=bad!'));
    expect(malformed.status).toBe(400);
    expect((await responseBody(malformed)).error.code).toBe('INVALID_CURSOR');
  });

  it('expires tokens and cascades revocation to descendants', async () => {
    const parent = (await responseBody(await mint({ roles: ['agent'], ttlSeconds: 600 }))).data;
    const child = (await responseBody(await mint({ roles: ['agent'], ttlSeconds: 300 }, crypto.randomUUID(), parent.token))).data;
    expect((await fetchApi(apiRequest('/v1/repos', child.token))).status).toBe(200);
    const revoke = await fetchApi(apiRequest(`/v1/principals/${parent.id}`, 'local-agent-a', { method: 'DELETE' }));
    expect(revoke.status).toBe(200);
    expect((await responseBody(revoke)).data.revokedIds).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect((await fetchApi(apiRequest('/v1/repos', parent.token))).status).toBe(401);
    expect((await fetchApi(apiRequest('/v1/repos', child.token))).status).toBe(401);
    const short = (await responseBody(await mint({ roles: ['agent'], ttlSeconds: 1 }))).data;
    runtime.CONCORD_TEST_NOW = String(short.expiresAt + 1);
    expect((await fetchApi(apiRequest('/v1/repos', short.token))).status).toBe(401);
  });

  it('lets an owner mint a repo-scoped checker that polls its repo until revoked', async () => {
    const minted = await mint({ roles: ['checker'], repoIds: ['alpha'], ttlSeconds: 3600, name: 'mac-mini' }, crypto.randomUUID(), 'local-owner');
    expect(minted.status).toBe(201);
    const item = (await responseBody(minted)).data;
    expect(item.token).toMatch(/^cct_local_[a-f0-9]{64}$/);
    expect(item).toMatchObject({ roles: ['checker'], repoIds: ['alpha'], parentId: 'owner', name: 'mac-mini', revokedAt: null });
    const pin = `sha256:${'0'.repeat(64)}` as const;
    const headOid = 'a'.repeat(40);
    const treeOid = 'b'.repeat(40);
    const jobId = `checker-${crypto.randomUUID().replaceAll('-', '')}`;
    const owner: Principal = { tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
    const stub = runtime.REPO_COORDINATOR.get(runtime.REPO_COORDINATOR.idFromName('repo:local:alpha'));
    await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
      const context = (instance as unknown as { context(name: 'runners', principal: Principal, repoId: string): ModuleContext })
        .context('runners', owner, 'alpha');
      const storage = context.storage as FakeStorage;
      await storage.ensureRepo('delegated-candidate');
      storage.putCommit('delegated-candidate', { oid: headOid, treeOid, parents: [] });
      storage.conditionalUpdateRef('delegated-candidate', 'refs/heads/main', null, headOid);
      const job: Job = {
        kind: 'inspect-candidate', jobId, repoId: 'alpha', inputDigest: pin, generation: 1,
        profileDigest: pin, policyId: 'local-demo', policyDigest: pin,
        unitPolicy: localFixtureConfig('local').policies['local-demo'],
        expectedRefs: { 'delegated-candidate': headOid }, storageRemotes: { 'delegated-candidate': 'file:///delegated-candidate' },
        checkerId: 'local-demo', checkerDigest: pin, oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin,
        timeoutMs: 120_000, maxOutputBytes: 16 * 1024, state: 'pending', attempt: 0,
        runnerId: null, fence: 0, expiresAt: null, version: 0, changeId: 'change1', revision: 1,
        candidate: { changeId: 'change1', revision: 1, baseOid: headOid, headOid,
          storageName: 'delegated-candidate', ref: 'refs/heads/main' },
      };
      expect(runners.hooks['runners.schedule']!(context, { ...job, inputDigest: await digest(jobInput(job)) }).status).toBe('eligible');
    });
    const poll = (repo: string, profiles: string[] = []) => fetchApi(mutation(`/v1/repos/${repo}/runner/poll`,
      { runnerId: 'mac-mini', role: 'checker', supportedProfileDigests: profiles }, crypto.randomUUID(), item.token));
    expect((await poll('alpha')).status).toBe(204);
    const claimed = await poll('alpha', [pin]);
    expect(claimed.status).toBe(200);
    const job = (await responseBody(claimed)).data.job as Job;
    expect(job).toMatchObject({ jobId, state: 'claimed', runnerId: 'mac-mini' });
    const reviewManifest = { changedUnits: [], policyVersion: 1, policyDigest: pin, checkerDigest: pin,
      oracleDigest: pin, toolchainDigest: pin, coverage: 'complete' as const, dependencyScope: [] };
    const unsigned = { jobId, attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest,
      kind: 'inspect-candidate' as const, checkerDigest: pin, oracleDigest: pin, toolchainDigest: pin,
      environmentDigest: pin, sourceTreeOid: treeOid, durationMs: 1, log: '', outcome: 'PASS' as const,
      observedHeadOid: headOid, unitKeys: [], reviewManifestDigest: await digest(reviewManifest), reviewManifest };
    const resultDigest = await digest(unsigned);
    const submitted = await fetchApi(mutation(`/v1/repos/alpha/jobs/${jobId}/result`, {
      attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest,
      resultDigest, result: { ...unsigned, resultDigest },
    }, crypto.randomUUID(), item.token));
    expect(submitted.status).toBe(200);
    expect((await responseBody(submitted)).data.resultDigest).toBe(resultDigest);
    expect((await poll('alpha', [pin])).status).toBe(204);
    expect((await poll('beta')).status).toBe(403);
    const revoked = await fetchApi(apiRequest(`/v1/principals/${item.id}`, 'local-owner', { method: 'DELETE' }));
    expect(revoked.status).toBe(200);
    expect((await poll('alpha')).status).toBe(401);
  });

  it('refuses checker mints for non-owners and promoter mints entirely', async () => {
    for (const token of ['local-agent-a', 'local-reviewer', 'local-checker']) {
      expect((await mint({ roles: ['checker'] }, crypto.randomUUID(), token)).status).toBe(403);
    }
    expect((await mint({ roles: ['promoter'] }, crypto.randomUUID(), 'local-owner')).status).toBe(403);
    expect((await mint({ roles: ['checker', 'promoter'] }, crypto.randomUUID(), 'local-owner')).status).toBe(403);
    const checker = (await responseBody(await mint({ roles: ['checker'], ttlSeconds: 60 }, crypto.randomUUID(), 'local-owner'))).data;
    expect((await mint({ roles: ['checker'] }, crypto.randomUUID(), checker.token)).status).toBe(403);
    expect((await mint({ roles: ['agent'] }, crypto.randomUUID(), checker.token)).status).toBe(403);
  });

  it('mints the documented checker request under default trusted limits and explains longer TTLs', async () => {
    runtime.TRUSTED_CONFIG = JSON.stringify(localFixtureConfig('local'));
    const example = /npm run concord -- principals mint --role checker --repo REPO_ID --ttl ([1-9]\d*)([smhd]) --name mac-mini/.exec(runnerGuide);
    expect(example).not.toBeNull();
    expect(`${example![1]}${example![2]}`).toBe('24h');
    expect(runnerGuide).toContain('delegatedPrincipals.maxTtlMs');
    expect(runnerGuide).toContain('"delegatedPrincipals": {"maxTtlMs": 2592000000}');
    expect(runnerGuide).toContain('400 INVALID_TTL');

    const ttlSeconds = Number(example![1]) * ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[example![2] as 's' | 'm' | 'h' | 'd'];
    const body = { roles: ['checker'], repoIds: ['REPO_ID'], ttlSeconds, name: 'mac-mini' };
    const accepted = await mint(body, crypto.randomUUID(), 'local-owner');
    expect(accepted.status).toBe(201);
    expect((await responseBody(accepted)).data).toMatchObject({ roles: ['checker'], repoIds: ['REPO_ID'], name: 'mac-mini' });

    const rejected = await mint({ ...body, ttlSeconds: 30 * 86400 }, crypto.randomUUID(), 'local-owner');
    expect(rejected.status).toBe(400);
    expect((await responseBody(rejected)).error.code).toBe('INVALID_TTL');
  });

  it('caps checker TTL at the smaller of 30 days and the trusted maximum', async () => {
    const DAY_MS = 86_400_000;
    runtime.TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'), delegatedPrincipals: { maxTtlMs: 90 * DAY_MS } });
    const over = await mint({ roles: ['checker'], ttlSeconds: 30 * 86400 + 1 }, crypto.randomUUID(), 'local-owner');
    expect(over.status).toBe(400);
    expect((await responseBody(over)).error.code).toBe('INVALID_TTL');
    const minted = await mint({ roles: ['checker'], ttlSeconds: 30 * 86400, name: 'runner-30d' }, crypto.randomUUID(), 'local-owner');
    expect(minted.status).toBe(201);
    const item = (await responseBody(minted)).data;
    expect(item.expiresAt).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    expect(item.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    const agent = await mint({ roles: ['agent'], ttlSeconds: 45 * 86400 });
    expect(agent.status).toBe(201);
    const agentId = (await responseBody(agent)).data.id;
    await fetchApi(apiRequest(`/v1/principals/${agentId}`, 'local-agent-a', { method: 'DELETE' }));

    runtime.TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'), delegatedPrincipals: { maxTtlMs: DAY_MS } });
    expect((await mint({ roles: ['checker'], ttlSeconds: 2 * 86400 }, crypto.randomUUID(), 'local-owner')).status).toBe(400);
    expect((await mint({ roles: ['checker'], ttlSeconds: 86400 }, crypto.randomUUID(), 'local-owner')).status).toBe(201);
  });

  it('keeps local fixture credentials invalid in production', async () => {
    await expect(authenticate(apiRequest('/v1/principals', 'local-owner'), { CONCORD_MODE: 'production' } as Env))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});
