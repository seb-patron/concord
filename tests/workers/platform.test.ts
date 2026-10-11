import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { authenticate, clock } from '../../src/auth';
import { modules } from '../../src/coordinator';
import type { RepoCoordinator } from '../../src/coordinator';
import { repos } from '../../src/features/repos';
import { json } from '../../src/http';
import type { ModuleContext, ModuleRoute } from '../../src/contracts';
import { localFixtureConfig } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);

describe('local Worker and SQLite Durable Objects', () => {
  it('authenticates every named local actor as a distinct principal through the Worker', async () => {
    const fixtures = [
      ['local-owner', 'owner', 'owner'],
      ['local-agent-a', 'agent-a', 'agent'],
      ['local-agent-b', 'agent-b', 'agent'],
      ['local-agent-c', 'agent-c', 'agent'],
      ['local-contest-low', 'contest-agent-low', 'agent'],
      ['local-contest-high', 'contest-agent-high', 'agent'],
      ['local-mock-aw', 'mock-aw', 'agent'],
      ['local-reviewer', 'reviewer', 'reviewer'],
      ['local-checker', 'checker', 'checker'],
      ['local-promoter', 'promoter', 'promoter'],
      ['local-viewer', 'viewer', 'viewer'],
    ] as const;
    const route: ModuleRoute = {
      method: 'GET', pattern: /^\/v1\/repos\/identity_case\/test-identity$/,
      handle: context => json(context.principal),
    };
    repos.routes.push(route);
    try {
      const seen = new Set<string>();
      for (const [token, principalId, role] of fixtures) {
        const response = await fetchApi(apiRequest('/v1/repos/identity_case/test-identity', token));
        expect(response.status).toBe(200);
        const principal = (await responseBody(response)).data;
        expect(principal).toMatchObject({ tenantId: 'local', principalId, roles: [role], repoIds: '*' });
        expect(seen.has(principal.principalId)).toBe(false);
        seen.add(principal.principalId);
      }
      const production = { CONCORD_MODE: 'production' } as Env;
      for (const [token] of fixtures) {
        await expect(authenticate(apiRequest('/v1/repos/identity_case', token), production)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
      }
    } finally {
      repos.routes.splice(repos.routes.indexOf(route), 1);
    }
  });

  it('serves health and routes authenticated catalog and repo snapshots', async () => {
    const health = await fetchApi(new Request('https://concord.test/health'));
    expect(health.status).toBe(200);
    expect((await responseBody(health)).data).toMatchObject({ status: 'ok', mode: 'local', storageBackend: 'fake' });
    const catalog = await fetchApi(apiRequest('/v1/repos'));
    expect(catalog.status).toBe(200);
    expect((await responseBody(catalog)).data.items).toEqual([]);
    const snapshot = await fetchApi(apiRequest('/v1/repos/alpha/snapshot'));
    expect(snapshot.status).toBe(200);
    expect((await responseBody(snapshot)).data.projections).toMatchObject({
      repos: { status: 'unavailable' }, leases: { status: 'unavailable' },
      queue: { status: 'unavailable' }, runners: { status: 'unavailable' },
      findings: { status: 'unavailable' }, verdicts: { status: 'unavailable' },
    });
    expect((await fetchApi(apiRequest('/v1/repos/alpha/snapshot', 'local-viewer'))).status).toBe(200);
  });

  it('rejects absent, cross-tenant, expired, and production fixture identities', async () => {
    expect((await fetchApi(new Request('https://concord.test/v1/repos/alpha/snapshot'))).status).toBe(401);
    const cross = await fetchApi(apiRequest('/v1/repos/alpha/snapshot', 'local-owner', { headers: { 'x-tenant-id': 'other' } }));
    expect(cross.status).toBe(403);
    expect((await responseBody(cross)).error.code).toBe('TENANT_MISMATCH');
    const expiredSecret = 'expired-secret';
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expiredSecret))), b => b.toString(16).padStart(2, '0')).join('');
    const production = { CONCORD_MODE: 'production', AUTH_TOKENS: JSON.stringify({ [hash]: { tenantId: 'local', principalId: 'old', roles: ['viewer'], repoIds: '*', expiresAt: 100 } }) } as Env;
    await expect(authenticate(apiRequest('/v1/repos/alpha', expiredSecret), production, () => 101)).rejects.toMatchObject({ status: 401, code: 'CREDENTIAL_EXPIRED' });
    await expect(authenticate(apiRequest('/v1/repos/alpha', 'local-owner'), production, () => 0)).rejects.toMatchObject({ status: 401 });
    expect(() => localFixtureConfig('production')).toThrow('LOCAL_FIXTURE_FORBIDDEN');
    expect(clock({ CONCORD_MODE: 'local', CONCORD_TEST_NOW: '1234' })()).toBe(1234);
  });

  it('rejects conflicting bodies and stale versions, and leaves feature routes unavailable', async () => {
    const path = '/v1/repos/beta/queue/enqueue';
    const first = await fetchApi(mutation(path, { expectedVersion: 0, changeId: 'one' }, 'same-key'));
    expect(first.status).toBe(501);
    expect((await responseBody(first)).error.code).toBe('MODULE_UNAVAILABLE');
    const retry = await fetchApi(mutation(path, { expectedVersion: 0, changeId: 'one' }, 'same-key'));
    expect(retry.status).toBe(501);
    const conflict = await fetchApi(mutation(path, { expectedVersion: 0, changeId: 'two' }, 'same-key'));
    expect(conflict.status).toBe(409);
    expect((await responseBody(conflict)).error.code).toBe('IDEMPOTENCY_CONFLICT');
    const stale = await fetchApi(mutation(path, { expectedVersion: 99, changeId: 'three' }, 'new-key'));
    expect(stale.status).toBe(409);
    expect((await responseBody(stale)).error.code).toBe('STALE_VERSION');
    const missingVersion = await fetchApi(mutation(path, { changeId: 'four' }, 'missing-version'));
    expect(missingVersion.status).toBe(400);
    expect((await responseBody(missingVersion)).error.code).toBe('EXPECTED_VERSION_REQUIRED');
    const noKey = await fetchApi(apiRequest(path, 'local-owner', { method: 'POST', body: '{}' }));
    expect(noKey.status).toBe(400);
    const noApprove = await fetchApi(mutation('/v1/repos/beta/changes/c/verdicts', { expectedVersion: 0, decision: 'approve' }, 'verdict-key', 'local-reviewer'));
    expect(noApprove.status).toBe(501);
    expect((await fetchApi(mutation('/v1/repos/beta/changes/c/verdicts', { expectedVersion: 0, decision: 'approve' }, 'wrong-role', 'local-agent-a'))).status).toBe(403);
    expect((await fetchApi(mutation('/v1/repos', { name: 'new', policyId: 'local-demo', profileId: 'local-demo' }, 'catalog-key', 'local-viewer'))).status).toBe(403);
    const catalog = await fetchApi(mutation('/v1/repos', { name: 'new', policyId: 'local-demo', profileId: 'local-demo' }, 'catalog-key'));
    expect(catalog.status).toBe(501);
    const catalogConflict = await fetchApi(mutation('/v1/repos', { name: 'different', policyId: 'local-demo', profileId: 'local-demo' }, 'catalog-key'));
    expect(catalogConflict.status).toBe(409);
  });

  it('pages persisted events by cursor and keeps transaction rollback atomic', async () => {
    const path = '/v1/repos/events_case/events';
    await fetchApi(apiRequest('/v1/repos/events_case/snapshot'));
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:events_case'));
    const testRoute: ModuleRoute = {
      method: 'POST', pattern: /^\/v1\/repos\/events_case\/test-event$/,
      handle: context => context.transaction(() => {
        const version = context.nextVersion();
        const event = context.appendEvent('test', [], {}, version);
        return json({ recorded: true }, version, event.sequence);
      }),
    };
    repos.routes.push(testRoute);
    try {
      for (let version = 1; version <= 2; version++) {
        const response = await fetchApi(mutation('/v1/repos/events_case/test-event', { expectedVersion: version - 1 }, `event-${version}`));
        expect(response.status).toBe(200);
        expect((await responseBody(response)).version).toBe(version);
      }
    } finally {
      repos.routes.splice(repos.routes.indexOf(testRoute), 1);
    }
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      expect(() => state.storage.transactionSync(() => {
        sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)', 'rollback', 'owner', 1003, 3, '[]', '{}');
        throw new Error('rollback');
      })).toThrow('rollback');
    });
    const first = await fetchApi(apiRequest(`${path}?after=0&limit=1`));
    expect(first.status).toBe(200);
    const page1 = await responseBody(first);
    expect(page1.data.items).toHaveLength(1);
    const second = await fetchApi(apiRequest(`${path}?cursor=${page1.data.nextCursor}&limit=1`));
    expect(second.status).toBe(200);
    const page2 = await responseBody(second);
    expect(page2.data.items).toHaveLength(1);
    expect(page2.data.items[0].sequence).toBeGreaterThan(page1.data.items[0].sequence);
    expect(page2.data.nextCursor).toBeNull();
    const third = await fetchApi(apiRequest(`${path}?after=${page2.data.items[0].sequence}`));
    expect((await responseBody(third)).data.items).toHaveLength(0);
    expect((await fetchApi(apiRequest(`${path}?cursor=%%%`))).status).toBe(400);
  });

  it('dispatches an alarm to all six registered modules', async () => {
    await fetchApi(apiRequest('/v1/repos/alarm_case/snapshot'));
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:alarm_case'));
    const spies = modules.map(module => vi.spyOn(module, 'onAlarm'));
    try {
      await runInDurableObject<RepoCoordinator, void>(stub, instance => instance.alarm());
      for (const spy of spies) {
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0][0]).toMatchObject({ repoId: 'alarm_case', tenantId: 'local' });
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('keeps every prewired internal hook blocked', () => {
    for (const module of modules) {
      for (const hook of Object.values(module.hooks)) {
        expect((hook as (...args: unknown[]) => unknown)({} as ModuleContext)).toMatchObject({ status: 'blocked', code: 'MODULE_UNAVAILABLE' });
      }
    }
  });
});
