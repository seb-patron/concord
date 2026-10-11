import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import type { FeatureModule, RepoStorage } from '../../src/contracts';
import { FakeStorage } from '../../src/storage/fake';
import { artifactsStorage } from '../../src/storage/artifacts';
import { bridgeStorage } from '../../src/storage/bridge';
import { applyMigrations, sqlState } from '../../src/state';
import { apiRequest } from '../helpers';

describe('fake RepoStorage and module state', () => {
  it('keeps provider adapters explicitly unavailable', () => {
    expect(() => artifactsStorage({})).toThrow('ARTIFACTS_ADAPTER_UNAVAILABLE');
    expect(() => bridgeStorage('http://127.0.0.1:9999')).toThrow('BRIDGE_ADAPTER_UNAVAILABLE');
  });
  it('does not follow a bridge redirect with its bearer credential', async () => {
    const requested = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer local-test-token');
      return new Response(null, { status: 302, headers: { location: 'https://other.example/rpc' } });
    });
    vi.stubGlobal('fetch', requested);
    try {
      await expect(bridgeStorage('http://127.0.0.1:9999/?token=local-test-token').info('repo'))
        .rejects.toThrow('BRIDGE_302');
      expect(requested).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('persists objects across provider instances, forks, faults, tokens and absent-ref CAS', async () => {
    await worker.fetch(apiRequest('/v1/repos/storage_case/snapshot'), env);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:storage_case'));
    await runInDurableObject(stub, async (_instance, state) => {
      const store = sqlState(state.storage.sql);
      const first: RepoStorage = new FakeStorage(store, () => 1000);
      expect(await first.ensureRepo('source')).toMatchObject({ name: 'source', status: 'ready' });
      const fake = first as FakeStorage;
      fake.putCommit('source', { oid: 'a', treeOid: 'tree-a', parents: [] }, { 'a.txt': new TextEncoder().encode('hello') });
      expect(fake.conditionalUpdateRef('source', 'refs/heads/main', null, 'a')).toBe(true);
      expect(fake.conditionalUpdateRef('source', 'refs/heads/main', null, 'a')).toBe(false);
      expect(await first.fork('source', 'candidate')).toMatchObject({ name: 'candidate' });
      const second = new FakeStorage(store, () => 1000);
      expect(await second.resolveRef('source', 'refs/heads/main')).toBe('a');
      expect(await second.readCommit('candidate', 'a')).toMatchObject({ treeOid: 'tree-a' });
      expect(new TextDecoder().decode(await second.readFile('candidate', 'a', 'a.txt') ?? new Uint8Array())).toBe('hello');
      await expect(second.mintToken('candidate', 'read', 60)).resolves.toMatchObject({ expiresAt: 61000 });
      const token = await second.mintToken('candidate', 'write', 1);
      expect(await second.revokeToken('candidate', token.secret)).toBe(true);
      second.failNext('readCommit');
      await expect(second.readCommit('source', 'a')).rejects.toThrow('FAKE_FAULT:readCommit');
      expect(await second.readCommit('source', 'a')).not.toBeNull();
      expect(() => second.putCommit('source', { oid: 'a', treeOid: 'different', parents: [] })).toThrow('FAKE_IMMUTABLE_OBJECT');
    });
  });

  it('runs namespaced SQLite migrations once and rejects a foreign table name', async () => {
    await worker.fetch(apiRequest('/v1/repos/migration_case/snapshot'), env);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:migration_case'));
    await runInDurableObject(stub, (_instance, state) => {
      const module: FeatureModule = {
        name: 'leases', migrations: [{ version: 1, statements: ['CREATE TABLE IF NOT EXISTS leases_test (id TEXT PRIMARY KEY)'] }],
        routes: [], snapshot: () => ({}), nextDeadline: () => null, onAlarm: () => undefined, hooks: {},
      };
      applyMigrations(state.storage, module);
      applyMigrations(state.storage, module);
      expect(state.storage.sql.exec<{ version: number }>('SELECT version FROM concord_migrations WHERE namespace = ?', 'leases').toArray()[0].version).toBe(1);
      module.migrations.push({ version: 2, statements: ['CREATE TABLE other_test (id TEXT)'] });
      expect(() => applyMigrations(state.storage, module)).toThrow('Invalid leases migration namespace');
      expect(state.storage.sql.exec<{ version: number }>('SELECT version FROM concord_migrations WHERE namespace = ?', 'leases').toArray()[0].version).toBe(1);
      module.migrations[1].statements = ['CREATE TABLE leases_second (id TEXT); CREATE TABLE other_test (id TEXT)'];
      expect(() => applyMigrations(state.storage, module)).toThrow('Invalid leases migration statement');
    });
  });
});
