import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { TenantCatalog } from '../../src/catalog';
import { RepoCoordinator, modules } from '../../src/coordinator';
import { repos } from '../../src/features/repos';
import { localFixtureConfig, sqlState } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';
import productionWrangler from '../../wrangler.jsonc?raw';
import localWrangler from '../../wrangler.local.jsonc?raw';

const originalConfig = (env as Env).TRUSTED_CONFIG;
const originalTokens = (env as Env).AUTH_TOKENS;
afterEach(() => { (env as Env).TRUSTED_CONFIG = originalConfig; (env as Env).AUTH_TOKENS = originalTokens; (env as Env).CONCORD_TEST_NOW = undefined; vi.restoreAllMocks(); });
const fetchApi = (request: Request) => worker.fetch(request, env);

describe('cost guards', () => {
  it('sets the measured CPU ceiling in local and production configs', () => {
    expect(JSON.parse(productionWrangler).limits.cpu_ms).toBe(100);
    expect(JSON.parse(localWrangler).limits.cpu_ms).toBe(100);
  });
  it('uses the local rate limit binding for failed auth and leaves authenticated traffic alone', async () => {
    const ip = '203.0.113.181';
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetchApi(new Request('https://concord.test/v1/repos', { headers: { 'cf-connecting-ip': ip } }));
      expect(response.status).toBe(401);
    }
    const limited = await fetchApi(new Request('https://concord.test/v1/repos', { headers: { 'cf-connecting-ip': ip } }));
    expect(limited.status).toBe(429);
    expect((await responseBody(limited)).error.code).toBe('RATE_LIMITED');
    expect((await fetchApi(apiRequest('/v1/repos', 'local-owner', { headers: { 'cf-connecting-ip': ip } }))).status).toBe(200);
  });

  it('never charges valid principals for role, tenant, or repository scope denials', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 100) + 20}`;
    const scoped = 'scoped-cost-guard';
    const principal = { tenantId: 'local', principalId: 'scoped', roles: ['viewer'], repoIds: [scoped], expiresAt: Number.MAX_SAFE_INTEGER };
    const token = 'scope-cost-guard';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    (env as Env).AUTH_TOKENS = JSON.stringify({ [key]: principal });
    try {
      for (let attempt = 0; attempt < 25; attempt++) {
        const headers = { 'cf-connecting-ip': ip };
        const request = attempt % 3 === 0
          ? apiRequest('/v1/repos', token, { method: 'POST', headers })
          : attempt % 3 === 1
            ? apiRequest('/v1/repos', token, { headers: { ...headers, 'x-tenant-id': 'other' } })
            : apiRequest('/v1/repos/other-repo', token, { headers });
        const result = await fetchApi(request);
        expect(result.status).toBe(403);
      }
      const missing = await fetchApi(new Request('https://concord.test/v1/repos', { headers: { 'cf-connecting-ip': ip } }));
      expect(missing.status).toBe(401);
    } finally { (env as Env).AUTH_TOKENS = originalTokens; }
  });

  it('rejects streamed and declared oversized bodies before a Durable Object', async () => {
    const path = '/v1/repos';
    const oversized = 'x'.repeat(256 * 1024 + 1);
    for (const declared of [true, false]) {
      const headers = new Headers({ 'idempotency-key': crypto.randomUUID() });
      if (declared) headers.set('content-length', String(oversized.length));
      const request = apiRequest(path, 'local-owner', { method: 'POST', headers, body: oversized });
      const result = await fetchApi(request);
      expect(result.status).toBe(413);
      expect((await responseBody(result)).error.code).toBe('BODY_TOO_LARGE');
    }
  });

  it('returns 413 promptly for a multi-chunk body without Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 5; index++) controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() { cancelled = true; },
    });
    const request = apiRequest('/v1/repos', 'local-owner', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(request.headers.has('content-length')).toBe(false);
    const result = await Promise.race([
      fetchApi(request),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('oversized stream stalled')), 1000)),
    ]);
    expect(result.status).toBe(413);
    expect((await responseBody(result)).error.code).toBe('BODY_TOO_LARGE');
    expect(cancelled).toBe(true);
  });

  it('leaves idle catalog and repo without alarms and floors a stuck catalog deadline', async () => {
    const now = Date.now();
    (env as Env).CONCORD_TEST_NOW = String(now);
    await fetchApi(apiRequest('/v1/repos'));
    await fetchApi(apiRequest('/v1/repos/cost_idle/snapshot'));
    const catalog = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    const repo = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:cost_idle'));
    await runInDurableObject<TenantCatalog, void>(catalog, async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
    await runInDurableObject<RepoCoordinator, void>(repo, async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
    vi.spyOn(repos, 'nextDeadline').mockReturnValue(now - 1000);
    vi.spyOn(repos, 'onAlarm').mockImplementation(() => undefined);
    await runInDurableObject<TenantCatalog, void>(catalog, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(now + 1000);
    });
  });

  it('backs off a throwing repo module and floors a stuck deadline', async () => {
    const now = Date.now();
    (env as Env).CONCORD_TEST_NOW = String(now);
    await fetchApi(apiRequest('/v1/repos/cost_backoff/snapshot'));
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:cost_backoff'));
    vi.spyOn(modules[0], 'nextDeadline').mockReturnValue(now - 1000);
    vi.spyOn(modules[0], 'onAlarm').mockImplementation(() => { throw new Error('retry me'); });
    await runInDurableObject<RepoCoordinator, void>(stub, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(now + 1000);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(now + 2000);
    });
  });

  it('enforces trusted repo and daily token mint caps', async () => {
    const current = await responseBody(await fetchApi(apiRequest('/v1/repos')));
    (env as Env).TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'), costLimits: {
      maxReposPerTenant: current.data.items.length + 1, maxTokenMintsPerTenantPerDay: 1,
    } });
    const name = `cost_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const create = { name, policyId: 'local-demo', profileId: 'local-demo' };
    const created = await fetchApi(mutation('/v1/repos', create, `${name}-create`));
    expect(created.status).toBeLessThan(300);
    const storageName = (await responseBody(created)).data.canonicalStorageName;
    const denied = await fetchApi(mutation('/v1/repos', { ...create, name: `${name}_extra` }, `${name}-extra`));
    expect(denied.status).toBe(429);
    expect((await responseBody(denied)).error.code).toBe('TENANT_REPO_LIMIT');
    const tokenBody = { expectedVersion: 0, storageName, scope: 'read', ttlSeconds: 60 };
    expect((await fetchApi(mutation(`/v1/repos/${name}/git-token`, tokenBody, `${name}-token-1`))).status).toBe(200);
    const over = await fetchApi(mutation(`/v1/repos/${name}/git-token`, tokenBody, `${name}-token-2`));
    expect(over.status).toBe(429);
    expect((await responseBody(over)).error.code).toBe('TENANT_TOKEN_LIMIT');
  });

  it('caps retained forks across closed changes in tenant durable state', async () => {
    const catalog = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    const before = await runInDurableObject<TenantCatalog, number>(catalog, (_instance, state) =>
      sqlState(state.storage.sql).get<number>('catalog:forkCount') ?? 0);
    (env as Env).TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'), costLimits: { maxForksPerTenant: before + 2 } });
    const name = `fork_cost_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const created = await fetchApi(mutation('/v1/repos', { name, policyId: 'local-demo', profileId: 'local-demo' }, `create-${name}`));
    expect(created.status).toBe(201);
    const path = `/v1/repos/${name}/changes`;
    const input = (intentKey: string) => ({ intentKey, intentText: 'bounded fork', baseOid: null,
      branch: `refs/heads/${intentKey}`, unitKeys: [], dependencyChangeIds: [] });
    for (let index = 0; index < 2; index++) {
      const change = await fetchApi(mutation(path, input(`fork-${index}`), `${name}-${index}`));
      expect(change.status).toBe(201);
      const result = await responseBody(change);
      const closed = await fetchApi(mutation(`${path}/${result.data.changeId}/close`,
        { expectedVersion: result.version }, `${name}-close-${index}`));
      expect(closed.status).toBe(200);
    }
    const denied = await fetchApi(mutation(path, input('fork-third'), `${name}-third`));
    expect(denied.status).toBe(429);
    expect((await responseBody(denied)).error.code).toBe('TENANT_FORK_LIMIT');
    expect(await runInDurableObject<TenantCatalog, number>(catalog, (_instance, state) =>
      sqlState(state.storage.sql).get<number>('catalog:forkCount') ?? 0)).toBe(before + 2);
  });
});
