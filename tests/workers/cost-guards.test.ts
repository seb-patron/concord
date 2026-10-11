import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { TenantCatalog } from '../../src/catalog';
import { RepoCoordinator, modules } from '../../src/coordinator';
import { repos } from '../../src/features/repos';
import { localFixtureConfig } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';

const originalConfig = (env as Env).TRUSTED_CONFIG;
afterEach(() => { (env as Env).TRUSTED_CONFIG = originalConfig; (env as Env).CONCORD_TEST_NOW = undefined; vi.restoreAllMocks(); });
const fetchApi = (request: Request) => worker.fetch(request, env);

describe('cost guards', () => {
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
});
