import { describe, expect, it, vi } from 'vitest';
import { artifactsStorage } from '../../src/storage/artifacts';
import { pendingInitialToken, revokeOrphanTokens } from '../../src/repos/model';

type RepoState = { remote: string; status: 'ready' | 'forking'; refs: Record<string, string>; token?: string };

function provider() {
  const repos = new Map<string, RepoState>();
  const revoked: Array<[string, string]> = [];
  const disposed: string[] = [];
  const binding = {
    create: vi.fn(async (name: string, options: unknown) => {
      expect(options).toEqual({ setDefaultBranch: 'main' });
      repos.set(name, { remote: `https://example.test/${name}.git`, status: 'ready', refs: {}, token: `initial-${name}` });
      return { name, remote: repos.get(name)!.remote, token: `initial-${name}` };
    }),
    get: vi.fn(async (name: string) => {
      const repo = repos.get(name);
      if (!repo) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      if (repo.status === 'forking') throw Object.assign(new Error('pending'), { code: 'FORK_IN_PROGRESS' });
      return {
        [Symbol.dispose]: () => { disposed.push(name); },
        info: vi.fn(async () => ({ name, remote: repo.remote })),
        fork: vi.fn(async (target: string, options: unknown) => {
          expect(options).toEqual({ readOnly: false, defaultBranchOnly: false });
          repos.set(target, { remote: `https://example.test/${target}.git?exact=1`, status: 'ready', refs: { ...repo.refs }, token: `initial-${target}` });
          return { name: target, remote: repos.get(target)!.remote, token: `initial-${target}` };
        }),
        revokeToken: vi.fn(async (token: string) => { revoked.push([name, token]); if (token === repo.token || token === `id-${name}`) delete repo.token; return true; }),
        listTokens: vi.fn(async () => ({ total: repo.token ? 1 : 0, tokens: repo.token ? [{ id: `id-${name}`, state: 'active' }] : [] })),
        createToken: vi.fn(async (scope: string, ttl: number) => ({ plaintext: `${name}-${scope}-${ttl}`, expiresAt: '2026-10-11T08:00:00Z' })),
        log: vi.fn(async ({ ref }: { ref: string }) => repo.refs[ref] ? [{ hash: repo.refs[ref] }] : []),
        readCommit: vi.fn(async (oid: string) => oid === 'a'.repeat(40) ? { hash: oid, treeHash: 'b'.repeat(40), parents: [] } : null),
        readFile: vi.fn(async ({ ref, path }: { ref: string; path: string }) => ref === 'a'.repeat(40) && path === 'README.md' ? new Blob(['seed']) : null),
      };
    }),
    list: vi.fn(async () => ({ repos: [...repos].map(([name, repo]) => ({ name, status: repo.status })) })),
  };
  return { binding, repos, revoked, disposed };
}

describe('Artifacts binding adapter', () => {
  it('uses documented create, get, fork, info, read and token result shapes', async () => {
    const fixture = provider();
    const storage = artifactsStorage(fixture.binding as unknown as Artifacts);
    expect(await storage.ensureRepo('canonical')).toEqual({ name: 'canonical', remote: 'https://example.test/canonical.git', status: 'ready' });
    expect(fixture.revoked).toContainEqual(['canonical', 'initial-canonical']);
    fixture.repos.get('canonical')!.refs['refs/heads/main'] = 'a'.repeat(40);
    expect(await storage.resolveRef('canonical', 'refs/heads/main')).toBe('a'.repeat(40));
    expect(await storage.readCommit('canonical', 'a'.repeat(40))).toEqual({ oid: 'a'.repeat(40), treeOid: 'b'.repeat(40), parents: [] });
    expect(new TextDecoder().decode(await storage.readFile('canonical', 'a'.repeat(40), 'README.md') ?? new Uint8Array())).toBe('seed');
    expect(await storage.fork('canonical', 'candidate')).toEqual({ name: 'candidate', remote: 'https://example.test/candidate.git?exact=1', status: 'ready' });
    expect(fixture.revoked).toContainEqual(['candidate', 'initial-candidate']);
    expect(await storage.mintToken('candidate', 'write', 60)).toEqual({ secret: 'candidate-write-60', expiresAt: Date.parse('2026-10-11T08:00:00Z') });
    expect(await storage.revokeToken('candidate', 'another')).toBe(true);
    expect(fixture.disposed.length).toBeGreaterThanOrEqual(8);
    expect(fixture.binding.create).toHaveBeenCalledTimes(1);
  });

  it('reconciles a lost create response by exact name and reports a delayed fork as provisioning', async () => {
    const fixture = provider();
    const original = fixture.binding.create.getMockImplementation()!;
    fixture.binding.create.mockImplementationOnce(async (name: string, options: unknown) => {
      await original(name, options);
      throw new Error('response lost');
    });
    const storage = artifactsStorage(fixture.binding as unknown as Artifacts);
    await expect(storage.ensureRepo('lost')).rejects.toThrow('response lost');
    expect(await storage.ensureRepo('lost')).toEqual({ name: 'lost', remote: 'https://example.test/lost.git', status: 'ready' });
    await (storage as typeof storage & { [revokeOrphanTokens]: (name: string) => Promise<void> })[revokeOrphanTokens]('lost');
    expect(fixture.revoked).toContainEqual(['lost', 'id-lost']);
    expect(fixture.binding.create).toHaveBeenCalledTimes(1);
    fixture.repos.set('delayed', { remote: 'https://example.test/delayed.git', status: 'forking', refs: {} });
    expect(await storage.info('delayed')).toEqual({ name: 'delayed', remote: '', status: 'provisioning' });
    expect(await storage.fork('lost', 'delayed')).toEqual({ name: 'delayed', remote: '', status: 'provisioning' });
    fixture.repos.get('delayed')!.status = 'ready';
    expect(await storage.info('delayed')).toMatchObject({ remote: 'https://example.test/delayed.git', status: 'ready' });
    await expect(storage.mintToken('delayed', 'read', 601)).rejects.toThrow('INVALID_TOKEN_TTL');
  });

  it('keeps an unrevokeable initial token private while the fork capability is pending', async () => {
    const fixture = provider();
    const storage = artifactsStorage(fixture.binding as unknown as Artifacts);
    await storage.ensureRepo('source');
    const originalGet = fixture.binding.get.getMockImplementation()!;
    fixture.binding.get.mockImplementation(async (name: string) => {
      const handle = await originalGet(name);
      if (name === 'source') handle.fork.mockImplementation(async (target: string) => {
        fixture.repos.set(target, { remote: `https://example.test/${target}.git`, status: 'forking', refs: {} });
        return { name: target, remote: fixture.repos.get(target)!.remote, token: `initial-${target}` };
      });
      return handle;
    });
    const pending = await storage.fork('source', 'slow');
    expect(pending.status).toBe('provisioning');
    expect(JSON.stringify(pending)).not.toContain('initial-slow');
    expect((pending as typeof pending & { [pendingInitialToken]?: string })[pendingInitialToken]).toBe('initial-slow');
    fixture.repos.get('slow')!.status = 'ready';
    expect(await storage.revokeToken('slow', 'initial-slow')).toBe(true);
  });
});
