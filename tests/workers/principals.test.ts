import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { authenticate } from '../../src/auth';
import { localFixtureConfig } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';

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

  it('reads mint and revoke from the tenant event stream in order without secrets', async () => {
    const before = await responseBody(await fetchApi(apiRequest('/v1/principals')));
    const cursor = btoa(String(before.eventSeq));
    const minted = await mint({ roles: ['agent'], repoIds: ['alpha'] });
    expect(minted.status).toBe(201);
    const created = (await responseBody(minted)).data;
    const revoked = await fetchApi(apiRequest(`/v1/principals/${created.id}`, 'local-agent-a', { method: 'DELETE' }));
    expect(revoked.status).toBe(200);

    const first = await fetchApi(apiRequest(`/v1/events?cursor=${cursor}&limit=1`, 'local-viewer'));
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

  it('keeps local fixture credentials invalid in production', async () => {
    await expect(authenticate(apiRequest('/v1/principals', 'local-owner'), { CONCORD_MODE: 'production' } as Env))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});
