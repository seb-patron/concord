import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { leases } from '../../src/features/leases';
import type { Event, ModuleContext, Principal, TrustedConfiguration } from '../../src/contracts';
import { localFixtureConfig, sqlState } from '../../src/state';

const repo = 'lease_bounded_reads';
const config = localFixtureConfig('local');
const trusted: TrustedConfiguration = { policies: config.policies, profiles: config.profiles };
const principal: Principal = {
  tenantId: 'local', principalId: 'local-viewer', roles: ['agent'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
};

function contextFor(state: DurableObjectState, now: number, repoId = repo, rowsRead?: { value: number }): ModuleContext {
  const originalSql = state.storage.sql;
  const sql = rowsRead ? new Proxy(originalSql, {
    get(target, property) {
      if (property === 'exec') return (query: string, ...args: (string | number)[]) => {
        const cursor = target.exec(query, ...args);
        let counted = false;
        return new Proxy(cursor, {
          get(result, cursorProperty) {
            if (cursorProperty === 'toArray') return () => {
              const value = result.toArray();
              if (!counted) {
                rowsRead.value += result.rowsRead;
                counted = true;
              }
              return value;
            };
            const value = Reflect.get(result, cursorProperty, result);
            return typeof value === 'function' ? value.bind(result) : value;
          },
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SqlStorage : originalSql;
  const store = sqlState(originalSql);
  return {
    repoId, tenantId: 'local', principal, env, trusted, sql, now: () => now,
    storage: {} as ModuleContext['storage'], transaction: <T>(run: () => T) => state.storage.transactionSync(run),
    version: () => store.get<number>('repo:version') ?? 1,
    nextVersion: () => { throw new Error('unused by read tests'); },
    appendEvent: (() => { throw new Error('unused by read tests'); }) as ModuleContext['appendEvent'],
    state: { get: <T>(key: string) => store.get<T>(`module:leases:${key}`),
      put: <T>(key: string, value: T) => store.put(`module:leases:${key}`, value),
      delete: (key: string) => store.delete(`module:leases:${key}`) },
    call: (() => { throw new Error('unused by read tests'); }) as ModuleContext['call'],
  };
}

function stubFor(repoId = repo) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repoId}`));
}

async function listPage(cursor: string | null, now: number, rowsRead: { value: number }) {
  const pagePath = `/v1/repos/${repo}/leases${cursor ? `?cursor=${cursor}` : ''}`;
  const routePath = new URL(`https://concord.test${pagePath}`).pathname;
  const route = leases.routes.find(item => item.method === 'GET' && item.pattern.test(routePath))!;
  return runInDurableObject(stubFor(), async (_instance, state) => {
    const response = await route.handle(contextFor(state, now, repo, rowsRead), new Request(`https://concord.test${pagePath}`),
      routePath.match(route.pattern)!, undefined);
    expect(response.status).toBe(200);
    return (await response.json() as { data: any }).data;
  });
}

describe('bounded lease listing reads', () => {
  it('reads pages from indexes and keeps live-first, newest-first cursor ordering', async () => {
    const now = 1_800_000_000_000;
    await runInDurableObject(stubFor(), async (_instance, state) => {
      const sql = state.storage.sql;
      for (let index = 0; index < 2_000; index++) {
        sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          `terminal-${String(index).padStart(4, '0')}`, `row:terminal:${index}`, 'agent', 'history', 'Seeded terminal', 1,
          now - 1, 'released', 1, now - 10_000 + index, now - 10_000 + index);
      }
      for (let index = 0; index < 3; index++) {
        sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          `live-${index}`, `row:live:${index}`, 'agent', 'live', 'Seeded live', 1,
          now + 60_000, 'active', 1, now + index, now + index);
      }
    });

    const firstReads = { value: 0 };
    const first = await listPage(null, now, firstReads);
    expect(firstReads.value).toBeLessThan(400);
    expect(first.items).toHaveLength(100);
    expect(first.items.slice(0, 3).map((item: { leaseId: string }) => item.leaseId)).toEqual(['live-2', 'live-1', 'live-0']);
    expect(first.items.slice(3).map((item: { leaseId: string }) => item.leaseId)).toEqual(
      Array.from({ length: 97 }, (_, offset) => `terminal-${String(1999 - offset).padStart(4, '0')}`));
    expect(first.nextCursor).toBe(btoa(JSON.stringify({ phase: 1, createdAt: now - 10_000 + 1903,
      leaseId: 'terminal-1903', maxVersion: 1, serverTime: now })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''));

    const secondReads = { value: 0 };
    const second = await listPage(first.nextCursor, now, secondReads);
    expect(secondReads.value).toBeLessThan(400);
    expect(second.items).toHaveLength(100);
    expect(second.items.map((item: { leaseId: string }) => item.leaseId)).toEqual(
      Array.from({ length: 100 }, (_, offset) => `terminal-${String(1902 - offset).padStart(4, '0')}`));
  });

  it('retains recent terminal rows and live rows while sweeping old terminal rows', async () => {
    const now = 1_800_000_000_000;
    const retentionRepo = 'lease_retention_reads';
    await runInDurableObject(stubFor(retentionRepo), async (_instance, state) => {
      const sql = state.storage.sql;
      const add = (leaseId: string, stateName: string, updatedAt: number, expiresAt: number) => sql.exec(
        'INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        leaseId, `row:${leaseId}`, 'agent', 'retention', 'Retention fixture', 1, expiresAt, stateName, 1, now - 100, updatedAt);
      add('old-terminal', 'released', now - 25 * 60 * 60 * 1000, now - 25 * 60 * 60 * 1000);
      add('recent-terminal', 'expired', now - 60 * 60 * 1000, now - 60 * 60 * 1000);
      add('live-row', 'active', now - 25 * 60 * 60 * 1000, now + 60_000);
      leases.onAlarm(contextFor(state, now, retentionRepo));
      const remaining = sql.exec<{ lease_id: string }>('SELECT lease_id FROM leases_claims ORDER BY lease_id').toArray()
        .map(row => row.lease_id);
      expect(remaining).toEqual(['live-row', 'recent-terminal']);
    });
  });
});
