import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTreeRowParser, startGitBridge, type GitBridge } from '../../local/git-bridge';
import { bridgeStorage } from '../../src/storage/bridge';

const temporary: string[] = [];
const openBridges: GitBridge[] = [];
afterEach(async () => {
  for (const bridge of openBridges.splice(0)) await bridge.close();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'concord-bridge-')); temporary.push(path); return path; };
const git = (args: string[]) => execFileSync('git', args, {
  encoding: 'utf8', timeout: 10_000,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
});

describe('authenticated loopback Git bridge', () => {
  it('creates, pushes, reads, forks, and reopens bare repos under one data directory', async () => {
    const directory = temp();
    const token = 'test-bridge-token-123456789';
    const bridge = await startGitBridge(directory, token);
    openBridges.push(bridge);
    expect(bridge.server.address()).toMatchObject({ address: '127.0.0.1' });
    const storage = bridgeStorage(bridge.url);
    const canonical = await storage.ensureRepo('canonical');
    expect(canonical.remote).toMatch(/^file:\/\//);
    expect(await storage.resolveRef('canonical', 'refs/heads/main')).toBeNull();
    const emptyFork = await storage.fork('canonical', 'empty-candidate');
    expect(emptyFork.status).toBe('ready');
    expect(await storage.resolveRef('empty-candidate', 'refs/heads/main')).toBeNull();
    const work = join(directory, 'working');
    git(['init', work]);
    writeFileSync(join(work, 'README.md'), 'first seed\n');
    git(['-C', work, 'add', 'README.md']);
    git(['-C', work, 'commit', '-m', 'seed']);
    const oid = git(['-C', work, 'rev-parse', 'HEAD']).trim();
    git(['-C', work, 'push', canonical.remote, 'HEAD:refs/heads/main']);
    expect(await storage.resolveRef('canonical', 'refs/heads/main')).toBe(oid);
    expect(await storage.readCommit('canonical', oid)).toMatchObject({ oid, parents: [] });
    const forged = join(directory, 'forged-commit.txt');
    writeFileSync(forged, `tree ${'a'.repeat(40)}\n\nlooks like a commit\n`);
    const blobOid = git(['--git-dir', new URL(canonical.remote).pathname, 'hash-object', '-w', forged]).trim();
    expect(git(['--git-dir', new URL(canonical.remote).pathname, 'cat-file', '-t', blobOid]).trim()).toBe('blob');
    expect(await storage.readCommit('canonical', blobOid)).toBeNull();
    expect(new TextDecoder().decode(await storage.readFile('canonical', oid, 'README.md') ?? new Uint8Array())).toBe('first seed\n');
    // The bridge checks the blob size before shipping bytes back.
    await expect(storage.readFile('canonical', oid, 'README.md', 5)).rejects.toThrow('FILE_TOO_LARGE');
    expect(new TextDecoder().decode(await storage.readFile('canonical', oid, 'README.md', 64 * 1024) ?? new Uint8Array())).toBe('first seed\n');
    expect(await storage.listTree('canonical', oid, '')).toEqual([expect.objectContaining({ name: 'README.md', type: 'blob' })]);
    expect(await storage.listTree('canonical', oid, 'missing')).toBeNull();
    const fork = await storage.fork('canonical', 'candidate');
    expect(fork.remote).toMatch(/^file:\/\//);
    expect(await storage.resolveRef('candidate', 'refs/heads/main')).toBe(oid);
    expect(await storage.readCommit('candidate', oid)).toMatchObject({ oid, parents: [] });
    expect(new TextDecoder().decode(await storage.readFile('candidate', oid, 'README.md') ?? new Uint8Array())).toBe('first seed\n');
    expect(await storage.info('candidate')).toEqual(fork);
    const issued = await storage.mintToken('candidate', 'write', 60);
    expect(issued.secret).toHaveLength(48);
    expect(await storage.revokeToken('candidate', issued.secret)).toBe(true);
    const persistentToken = await storage.mintToken('candidate', 'read', 60);
    await bridge.close();
    openBridges.splice(openBridges.indexOf(bridge), 1);
    const restarted = await startGitBridge(directory, token);
    openBridges.push(restarted);
    const restartedStorage = bridgeStorage(restarted.url);
    expect(await restartedStorage.resolveRef('candidate', 'refs/heads/main')).toBe(oid);
    expect(await restartedStorage.revokeToken('candidate', persistentToken.secret)).toBe(true);
  }, 20_000);

  it('lists tree entries whose names contain newlines', async () => {
    const directory = temp();
    const bridge = await startGitBridge(directory, 'newline-bridge-token-1234');
    openBridges.push(bridge);
    const storage = bridgeStorage(bridge.url);
    const canonical = await storage.ensureRepo('canonical');
    const work = join(directory, 'working');
    git(['init', work]);
    const newlineName = 'line\nbreak.md';
    for (const file of [newlineName, 'foo..bar.md', 'a:b', 'a\\b']) writeFileSync(join(work, file), 'seed\n');
    writeFileSync(join(work, 'boundary.bin'), Buffer.alloc(65_536));
    writeFileSync(join(work, 'over.bin'), Buffer.alloc(65_537));
    git(['-C', work, 'add', '-A']);
    git(['-C', work, 'commit', '-m', 'seed']);
    const oid = git(['-C', work, 'rev-parse', 'HEAD']).trim();
    git(['-C', work, 'push', canonical.remote, 'HEAD:refs/heads/main']);
    const entries = await storage.listTree('canonical', oid, '');
    for (const file of [newlineName, 'foo..bar.md', 'a:b', 'a\\b']) expect(entries).toContainEqual(expect.objectContaining({ name: file, type: 'blob' }));
    for (const file of [newlineName, 'foo..bar.md', 'a:b', 'a\\b']) expect(await storage.readFile('canonical', oid, file, 64 * 1024)).toHaveLength(5);
    await expect(storage.readFile('canonical', oid, 'boundary.bin', 65_536)).resolves.toHaveLength(65_536);
    await expect(storage.readFile('canonical', oid, 'over.bin', 65_536)).rejects.toThrow('FILE_TOO_LARGE');
    for (const path of ['..', '/x', 'a//b', 'a/../b', 'x\0y']) {
      await expect(storage.listTree('canonical', oid, path)).rejects.toThrow('INVALID_PATH');
      await expect(storage.readFile('canonical', oid, path, 64 * 1024)).rejects.toThrow('INVALID_PATH');
    }
  }, 20_000);

  it('stops parsing a large tree after the 1,001st row', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => Buffer.from(`100644 blob ${'a'.repeat(40)}\tfile-${String(index).padStart(4, '0')}\0`));
    const listing = Buffer.concat(rows);
    const parser = createTreeRowParser();
    expect(parser.push(listing)).toBe(true);
    expect(parser.entries).toHaveLength(1001);
    expect(parser.rowsParsed).toBe(1001);
    expect(parser.consumedBytes).toBeLessThan(listing.byteLength);

    const directory = temp();
    const bridge = await startGitBridge(directory, 'large-tree-bridge-token-123');
    openBridges.push(bridge);
    const storage = bridgeStorage(bridge.url);
    const canonical = await storage.ensureRepo('canonical');
    const work = join(directory, 'many-files');
    git(['init', work]);
    for (let index = 0; index < 5000; index++) writeFileSync(join(work, `file-${String(index).padStart(4, '0')}`), 'x');
    git(['-C', work, 'add', '-A']);
    git(['-C', work, 'commit', '-m', 'large tree']);
    const oid = git(['-C', work, 'rev-parse', 'HEAD']).trim();
    git(['-C', work, 'push', canonical.remote, 'HEAD:refs/heads/main']);
    const entries = await storage.listTree('canonical', oid, '');
    expect(entries).toHaveLength(1001);
    expect(entries?.[0].name).toBe('file-0000');
    expect(entries?.[1000].name).toBe('file-1000');
  }, 30_000);

  it('rejects unauthenticated calls, traversal, unknown names and unsafe refs', async () => {
    const bridge = await startGitBridge(temp(), 'another-bridge-token-12345');
    openBridges.push(bridge);
    const endpoint = `${new URL(bridge.url).origin}/rpc`;
    const noAuth = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ operation: 'ensureRepo', name: 'safe' }) });
    expect(noAuth.status).toBe(401);
    const auth = { authorization: 'Bearer another-bridge-token-12345' };
    const traversal = await fetch(endpoint, { method: 'POST', headers: auth, body: JSON.stringify({ operation: 'ensureRepo', name: '../escape' }) });
    expect(traversal.status).toBe(400);
    const storage = bridgeStorage(bridge.url);
    expect(await storage.info('missing')).toBeNull();
    await expect(storage.readCommit('missing', 'a'.repeat(40))).rejects.toThrow('UNKNOWN_STORAGE_NAME');
    await storage.ensureRepo('safe');
    await expect(storage.resolveRef('safe', 'refs/heads/../main')).rejects.toThrow('INVALID_REF');
    await expect(storage.readFile('safe', 'a'.repeat(40), '../secret')).rejects.toThrow('INVALID_PATH');
    await expect(storage.listTree('safe', 'a'.repeat(40), '../secret')).rejects.toThrow('INVALID_PATH');
  });
});
