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
  it('lists canonical trees through the Artifacts adapter', async () => {
    const trees: Record<string, { name: string; type: string; hash: string }[]> = {
      'tree-root': [{ name: 'docs', type: 'tree', hash: 'tree-docs' }, { name: 'README.md', type: 'blob', hash: 'blob-readme' }],
      'tree-docs': [{ name: 'guide.md', type: 'blob', hash: 'blob-guide' }],
    };
    const binding = {
      get: vi.fn(async () => ({
        [Symbol.dispose]: () => {},
        readCommit: async (oid: string) => oid === 'a'.repeat(40) ? { hash: oid, treeHash: 'tree-root', parents: [] } : null,
        readTree: async (treeOid: string) => trees[treeOid] ?? null,
      })),
      create: vi.fn(),
    };
    const storage = artifactsStorage(binding as unknown as Artifacts);
    expect(await storage.listTree('repo', 'a'.repeat(40), '')).toEqual([
      { name: 'docs', type: 'tree', oid: 'tree-docs' },
      { name: 'README.md', type: 'blob', oid: 'blob-readme' },
    ]);
    expect(await storage.listTree('repo', 'a'.repeat(40), 'docs')).toEqual([{ name: 'guide.md', type: 'blob', oid: 'blob-guide' }]);
    expect(await storage.listTree('repo', 'a'.repeat(40), 'missing')).toBeNull();
    expect(await storage.listTree('repo', 'b'.repeat(40), '')).toBeNull();
  });
  it('checks the Artifacts blob size before materializing a bounded readFile', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array(4).buffer);
    const binding = {
      get: vi.fn(async () => ({
        [Symbol.dispose]: () => {},
        readFile: async () => ({ size: 70 * 1024, arrayBuffer }),
      })),
      create: vi.fn(),
    };
    const storage = artifactsStorage(binding as unknown as Artifacts);
    await expect(storage.readFile('repo', 'a'.repeat(40), 'big.bin', 64 * 1024)).rejects.toThrow('FILE_TOO_LARGE');
    expect(arrayBuffer).not.toHaveBeenCalled();
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
      // Entries advertise the real Git object OID, stable across provider instances: sha1('blob 5\0hello').
      expect(await second.listTree('candidate', 'a', '')).toEqual([{ name: 'a.txt', type: 'blob', oid: 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0' }]);
      expect(await second.listTree('candidate', 'a', 'missing')).toBeNull();
      await expect(second.readFile('candidate', 'a', 'a.txt', 4)).rejects.toThrow('FILE_TOO_LARGE');
      await expect(second.readFile('candidate', 'a', 'a.txt', 5)).resolves.toHaveLength(5);
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
        name: 'storagecase' as unknown as FeatureModule['name'], migrations: [{ version: 1, statements: ['CREATE TABLE IF NOT EXISTS storagecase_test (id TEXT PRIMARY KEY)'] }],
        routes: [], snapshot: () => ({}), nextDeadline: () => null, onAlarm: () => undefined, hooks: {},
      };
      applyMigrations(state.storage, module);
      applyMigrations(state.storage, module);
      expect(state.storage.sql.exec<{ version: number }>('SELECT version FROM concord_migrations WHERE namespace = ?', 'storagecase').toArray()[0].version).toBe(1);
      module.migrations.push({ version: 2, statements: ['CREATE TABLE other_test (id TEXT)'] });
      expect(() => applyMigrations(state.storage, module)).toThrow('Invalid storagecase migration namespace');
      expect(state.storage.sql.exec<{ version: number }>('SELECT version FROM concord_migrations WHERE namespace = ?', 'storagecase').toArray()[0].version).toBe(1);
      module.migrations[1].statements = ['CREATE TABLE storagecase_second (id TEXT); CREATE TABLE other_test (id TEXT)'];
      expect(() => applyMigrations(state.storage, module)).toThrow('Invalid storagecase migration statement');
    });
  });
});
