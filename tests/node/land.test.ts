import { execFile as callback, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvedHead, filesChanged, land, parseAllowed, unitKeys, waitChange } from '../../cli/land.ts';
import { ConcordError } from '../../cli/client.ts';
import { patchId } from '../../cli/git.ts';
import { readAwRun } from '../../cli/aw-run.ts';
import { withoutNodeDeprecationWarnings } from '../helpers.ts';
import { tools } from '../../mcp/tools.ts';

const execFile = promisify(callback);
const dirs: string[] = [];
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'land-test-')); dirs.push(dir); return dir; }
async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
  return stdout.trim();
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function source(): Promise<{ dir: string; commit: string; parent: string }> {
  const dir = await temp();
  await git(dir, 'init', '-q');
  await writeFile(join(dir, 'first.txt'), 'original\n');
  await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\talpha\t\n');
  await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
  const parent = await git(dir, 'rev-parse', 'HEAD');
  await writeFile(join(dir, 'first.txt'), 'changed\n');
  await git(dir, 'mv', 'families.tsv', 'renamed.tsv');
  await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'candidate');
  return { dir, parent, commit: await git(dir, 'rev-parse', 'HEAD') };
}

describe('land input and evidence gates', () => {
  it('advertises lease claims by normalized count rather than raw array length', () => {
    const claim = tools.find(tool => tool.name === 'lease_claim');
    expect(claim?.inputSchema.properties?.unitKeys).toEqual({ type: 'array', items: { type: 'string' } });
    expect(tools.find(tool => tool.name === 'change_create')?.inputSchema.properties?.unitKeys)
      .toMatchObject({ maxItems: 128 });
  });

  it('derives an exact new file unit from an Allowed-files list under an approved prefix', async () => {
    const dir = await temp(); await git(dir, 'init', '-q');
    await writeFile(join(dir, 'first.txt'), 'base\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const parent = await git(dir, 'rev-parse', 'HEAD');
    const path = 'tests/new.test.ts';
    await mkdir(join(dir, 'tests'));
    await writeFile(join(dir, path), 'new\n');
    await git(dir, 'add', path); await git(dir, 'commit', '-qm', 'new file');
    const head = await git(dir, 'rev-parse', 'HEAD');
    expect([...parseAllowed(`${path}\n`)]).toEqual([path]);
    expect(await unitKeys(dir, parent, head, [path], { newFilePrefixes: ['tests/'], units: {} }))
      .toEqual([`file:${path}`]);
  });
  it('releases fifteen unused started leases after publishing one file without review evidence', async () => {
    const dir = await temp(); await git(dir, 'init', '-q');
    const files = Array.from({ length: 16 }, (_, index) => `file-${index}.txt`);
    for (const file of files) await writeFile(join(dir, file), 'original\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const parent = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, files[0]), 'changed\n');
    await git(dir, 'add', files[0]); await git(dir, 'commit', '-qm', 'candidate');
    const commit = await git(dir, 'rev-parse', 'HEAD');
    const allowedFiles = join(await temp(), 'allowed.txt');
    await writeFile(allowedFiles, `${files.join('\n')}\n`);
    const change = { changeId: 'started', provisioning: { state: 'observed' }, candidateStorageName: 'candidate',
      branch: 'refs/heads/work', authorId: 'agent', baseOid: parent, headOid: commit, revision: 1,
      unitKeys: [`file:${files[0]}`], status: 'ready' };
    const active = files.map((file, index) => ({ changeId: 'started', state: 'active', unitKey: `file:${file}`,
      leaseId: `lease-${index}`, fence: 1, remainingSeconds: 7200 }));
    const released: string[] = [];
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: parent,
        canonicalStorageName: 'canonical', canonicalRemote: `file://${dir}` }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { runners: { jobs: [
        { kind: 'inspect-candidate', changeId: 'started', revision: 1, jobId: 'pass-job', state: 'completed' },
      ] } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/changes/started') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: active.filter(item => !released.includes(item.leaseId)) }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: { remote: `file://${dir}`, token: 'local-git-token' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/jobs/pass-job/result')
        throw new ConcordError('result read denied', 'auth', 403);
      if (method === 'POST' && path.endsWith('/release')) {
        released.push(path.split('/')[4]); return { data: {}, version: 1 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    const result = await land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'work', allowedFiles,
      waitSeconds: 10, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} });
    expect(result.status).toBe('awaiting-review');
    expect(released.sort()).toEqual(active.slice(1).map(item => item.leaseId).sort());
  });
  it.each(['live', 'expired', 'renew'])('adopts a started TSV change with a %s file lease', async mode => {
    const dir = await temp(); await git(dir, 'init', '-q');
    await writeFile(join(dir, 'families.tsv'), 'family\tvalue\nalpha\told\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const parent = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'families.tsv'), 'family\tvalue\nalpha\tnew\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'row edit');
    const commit = await git(dir, 'rev-parse', 'HEAD');
    const allowedFiles = join(await temp(), 'allowed.txt');
    await writeFile(allowedFiles, 'families.tsv\n');
    const policy = { digest: 'digest', units: {}, tables: [{ name: 'families', file: 'families.tsv',
      header: ['family', 'value'], keyColumn: 'family', keySpec: { charset: 'lower', minLength: 1, maxLength: 64 } }] };
    const change = { changeId: 'started', intentKey: 'task', intentText: 'work', provisioning: { state: 'observed' },
      candidateStorageName: 'candidate', branch: `refs/heads/land/${createHash('sha256').update('task').digest('hex').slice(0, 16)}`, authorId: 'agent', baseOid: parent,
      headOid: commit, revision: 1, status: 'ready' };
    let leaseActive = mode !== 'expired';
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: parent,
        canonicalStorageName: 'canonical', canonicalRemote: `file://${dir}`, policyDigest: 'digest' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { repos: { unitPolicy: policy }, runners: { jobs: [
        { kind: 'inspect-candidate', changeId: 'started', revision: 1, jobId: 'pass-job', state: 'completed' },
      ] } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') throw new ConcordError('INTENT_CONFLICT', 'conflict', 409,
        { error: { code: 'INTENT_CONFLICT' } });
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/changes/started') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: leaseActive ? [{
        changeId: 'started', state: 'active', unitKey: mode === 'expired' ? 'row:families:alpha' : 'file:families.tsv',
        leaseId: 'lease', fence: 1, remainingSeconds: mode === 'renew' ? 30 : 7200,
      }] : [] }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/leases') {
        leaseActive = true; return { data: { leases: [{ changeId: 'started', state: 'active', unitKey: 'row:families:alpha',
          leaseId: 'lease', fence: 1, remainingSeconds: 300 }] }, version: 1 };
      }
      if (method === 'POST' && path === '/repos/demo/leases/lease/renew') return { data: { lease: {
        leaseId: 'lease', unitKey: 'file:families.tsv', changeId: 'started', fence: 2, state: 'active',
        expiresAt: Date.now() + 300000, remainingSeconds: 300 } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: { remote: `file://${dir}`, token: 'local-git-token' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/jobs/pass-job/result') throw new ConcordError('denied', 'auth', 403);
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    vi.stubEnv('CONCORD_REVIEWER_TOKEN', '');
    const result = await land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'work', allowedFiles,
      waitSeconds: 10, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} });
    expect(result).toMatchObject({ status: 'awaiting-review', changeId: 'started' });
    expect(request.mock.calls.filter(([method, path]) => method === 'POST' && path === '/repos/demo/leases')).toHaveLength(mode === 'expired' ? 1 : 0);
    expect(request.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/renew'))).toHaveLength(mode === 'renew' ? 1 : 0);
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path.endsWith('/release'))).toBe(false);
  });
  it.each(['conflict', 'reuse'])('keeps a lease reclaimed after the start hold expired when land is refused after %s', async mode => {
    const dir = await temp(); await git(dir, 'init', '-q');
    await writeFile(join(dir, 'a.txt'), 'old\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const parent = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'a.txt'), 'new\n');
    await git(dir, 'add', 'a.txt'); await git(dir, 'commit', '-qm', 'edit A');
    const commit = await git(dir, 'rev-parse', 'HEAD');
    const candidate = await temp(); await git(candidate, 'init', '-q', '--bare');
    const allowedFiles = join(await temp(), 'allowed.txt'); await writeFile(allowedFiles, 'a.txt\n');
    const change = { changeId: 'started', intentKey: 'task', intentText: 'work', provisioning: { state: 'observed' },
      candidateStorageName: 'candidate', branch: `refs/heads/land/${createHash('sha256').update('task').digest('hex').slice(0, 16)}`,
      authorId: 'agent', baseOid: parent, headOid: null, revision: 0, status: 'draft', dependencyChangeIds: [],
      unitKeys: ['file:a.txt'], startUnitKeys: ['file:a.txt'] };
    // The `concord start` lease has expired, so land must claim the unit again before publishing.
    const leaseRows = [{ changeId: 'started', state: 'expired', unitKey: 'file:a.txt', leaseId: 'start-lease', fence: 1, remainingSeconds: 0 }];
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, any> }) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: parent,
        canonicalStorageName: 'canonical', canonicalRemote: `file://${dir}` }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: {}, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') {
        if (mode === 'reuse') return { data: change, version: 1 };
        throw new ConcordError('INTENT_CONFLICT', 'conflict', 409, { error: { code: 'INTENT_CONFLICT' } });
      }
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/changes/started') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: leaseRows }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/leases') {
        const lease = { changeId: 'started', state: 'active', unitKey: 'file:a.txt', leaseId: 'reclaimed', fence: 2, remainingSeconds: 300 };
        leaseRows.push(lease); return { data: { leases: [{ ...lease }] }, version: 1 };
      }
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: {
        remote: options?.body?.storageName === 'canonical' ? `file://${dir}` : `file://${candidate}`, token: 'local-git-token' }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/branches') return { data: {}, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes/started/publish')
        throw new ConcordError('HEAD_MOVED', 'conflict', 409, { error: { code: 'HEAD_MOVED' } });
      if (method === 'POST' && path.endsWith('/release')) {
        const lease = leaseRows.find(item => path === `/repos/demo/leases/${item.leaseId}/release`);
        if (lease) lease.state = 'released';
        return { data: {}, version: 1 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    await expect(land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'work', allowedFiles,
      waitSeconds: 10, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} }))
      .rejects.toMatchObject({ message: expect.stringContaining('HEAD_MOVED') });
    expect(request.mock.calls.filter(([method, path]) => method === 'POST' && path === '/repos/demo/leases')).toHaveLength(1);
    expect(leaseRows.find(item => item.leaseId === 'reclaimed')).toMatchObject({ state: 'active' });
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path.endsWith('/release'))).toBe(false);
  }, 30_000);
  it.each(['conflict', 'reuse'])('refuses a commit outside the recorded start scope after %s before claiming a lease', async mode => {
    const dir = await temp(); await git(dir, 'init', '-q');
    await writeFile(join(dir, 'a.txt'), 'old\n'); await writeFile(join(dir, 'b.txt'), 'old\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const parent = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'b.txt'), 'new\n');
    await git(dir, 'add', 'b.txt'); await git(dir, 'commit', '-qm', 'edit B');
    const commit = await git(dir, 'rev-parse', 'HEAD');
    const allowedFiles = join(await temp(), 'allowed.txt'); await writeFile(allowedFiles, 'b.txt\n');
    const change = { changeId: 'started', intentKey: 'task', intentText: 'work', baseOid: parent,
      branch: `refs/heads/land/${createHash('sha256').update('task').digest('hex').slice(0, 16)}`,
      dependencyChangeIds: [], headOid: mode === 'reuse' ? commit : null,
      unitKeys: [mode === 'reuse' ? 'file:b.txt' : 'file:a.txt'], startUnitKeys: ['file:a.txt'] };
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: parent } };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: {} };
      if (method === 'POST' && path === '/repos/demo/changes') {
        if (mode === 'reuse') return { data: change };
        throw new ConcordError('INTENT_CONFLICT', 'conflict', 409, { error: { code: 'INTENT_CONFLICT' } });
      }
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null } };
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    await expect(land({ repo: 'demo', source: dir, commit,
      intentKey: 'task', intent: 'work', allowedFiles, client: { request } as never, emit: () => {} }))
      .rejects.toMatchObject({ message: expect.stringContaining('START_SCOPE_CONFLICT: file:b.txt') });
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path === '/repos/demo/leases')).toBe(false);
  });
  it('adopts two different row commits under the original file scope', async () => {
    const canonical = await temp(); await git(canonical, 'init', '-q');
    await writeFile(join(canonical, 'families.tsv'), 'family\tvalue\nalpha\told\nbeta\told\n');
    await git(canonical, 'add', '.'); await git(canonical, 'commit', '-qm', 'base');
    const parent = await git(canonical, 'rev-parse', 'HEAD');
    const commits: Array<{ dir: string; oid: string; row: string }> = [];
    for (const row of ['alpha', 'beta']) {
      const dir = await temp(); await git(dir, 'clone', '-q', canonical, '.');
      await writeFile(join(dir, 'families.tsv'), `family\tvalue\nalpha\t${row === 'alpha' ? 'new' : 'old'}\nbeta\t${row === 'beta' ? 'new' : 'old'}\n`);
      await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', `edit ${row}`);
      commits.push({ dir, oid: await git(dir, 'rev-parse', 'HEAD'), row });
    }
    const allowedFiles = join(await temp(), 'allowed.txt'); await writeFile(allowedFiles, 'families.tsv\n');
    const policy = { digest: 'digest', units: {}, tables: [{ name: 'families', file: 'families.tsv',
      header: ['family', 'value'], keyColumn: 'family', keySpec: { charset: 'lower', minLength: 1, maxLength: 64 } }] };
    const change = { changeId: 'started', intentKey: 'task', intentText: 'work', provisioning: { state: 'observed' },
      candidateStorageName: 'candidate', branch: `refs/heads/land/${createHash('sha256').update('task').digest('hex').slice(0, 16)}`,
      authorId: 'agent', baseOid: parent, headOid: commits[0].oid, revision: 1, status: 'ready',
      startUnitKeys: ['file:families.tsv'], unitKeys: ['row:families:alpha'] };
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: parent,
        canonicalStorageName: 'canonical', canonicalRemote: `file://${canonical}`, policyDigest: 'digest' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { repos: { unitPolicy: policy }, runners: { jobs: [
        { kind: 'inspect-candidate', changeId: 'started', revision: 1, jobId: 'pass-job', state: 'completed' },
      ] } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') throw new ConcordError('INTENT_CONFLICT', 'conflict', 409,
        { error: { code: 'INTENT_CONFLICT' } });
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null } };
      if (method === 'GET' && path === '/repos/demo/changes/started') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [{ changeId: 'started', state: 'active',
        unitKey: 'file:families.tsv', leaseId: 'lease', fence: 1, remainingSeconds: 7200 }] }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: { remote: `file://${canonical}`, token: 'local-git-token' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/jobs/pass-job/result') throw new ConcordError('denied', 'auth', 403);
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    vi.stubEnv('CONCORD_REVIEWER_TOKEN', '');
    for (const item of commits) {
      change.headOid = item.oid; change.unitKeys = [`row:families:${item.row}`];
      const result = await land({ repo: 'demo', source: item.dir, commit: item.oid, intentKey: 'task', intent: 'work',
        allowedFiles, waitSeconds: 10, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} });
      expect(result).toMatchObject({ status: 'awaiting-review', changeId: 'started' });
    }
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path === '/repos/demo/leases')).toBe(false);
  });
  it('publishes the complete tree after successive commits to different rows of a started file', async () => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'families.tsv'), 'family\tvalue\nalpha\told\nbeta\told\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const base = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'families.tsv'), 'family\tvalue\nalpha\tnew\nbeta\told\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'edit alpha');
    const first = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'families.tsv'), 'family\tvalue\nalpha\tnew\nbeta\tnew\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'edit beta');
    const second = await git(dir, 'rev-parse', 'HEAD');
    const candidate = await temp(); await git(candidate, 'init', '-q', '--bare');
    const allowedFiles = join(await temp(), 'allowed.txt'); await writeFile(allowedFiles, 'families.tsv\n');
    const policy = { digest: 'digest', units: {}, tables: [{ name: 'families', file: 'families.tsv',
      header: ['family', 'value'], keyColumn: 'family', keySpec: { charset: 'lower', minLength: 1, maxLength: 64 } }] };
    const branch = `refs/heads/land/${createHash('sha256').update('task').digest('hex').slice(0, 16)}`;
    const change = { changeId: 'started', intentKey: 'task', intentText: 'work', provisioning: { state: 'observed' },
      candidateStorageName: 'candidate', branch, authorId: 'agent', baseOid: base,
      headOid: null as string | null, revision: 0, status: 'draft', startUnitKeys: ['file:families.tsv'], unitKeys: ['file:families.tsv'], dependencyChangeIds: [] };
    const published: string[][] = [];
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, any> }) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: base,
        canonicalStorageName: 'canonical', canonicalRemote: `file://${dir}`, policyDigest: 'digest' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { repos: { unitPolicy: policy }, runners: { jobs: [] } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') throw new ConcordError('INTENT_CONFLICT', 'conflict', 409, { error: { code: 'INTENT_CONFLICT' } });
      if (method === 'GET' && path === '/repos/demo/changes') return { data: { items: [change], nextCursor: null }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/changes/started') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [{ changeId: 'started', state: 'active',
        unitKey: 'file:families.tsv', leaseId: 'lease', fence: 1, remainingSeconds: 7200 }] }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: {
        remote: options?.body?.storageName === 'canonical' ? `file://${dir}` : `file://${candidate}`, token: 'local-git-token' }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/branches') return { data: {}, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes/started/publish') {
        change.headOid = options?.body?.headOid; change.unitKeys = options?.body?.unitKeys;
        change.revision++; change.status = 'ready'; published.push(change.unitKeys);
        return { data: change, version: 1 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    for (const commit of [first, second]) {
      const result = await land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'work', allowedFiles,
        waitSeconds: 10, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} });
      expect(result.status).toBe('awaiting-review');
    }
    expect(published).toEqual([['row:families:alpha'], ['row:families:alpha', 'row:families:beta']]);
    expect(await git(candidate, 'show', `${branch}:families.tsv`)).toBe('family\tvalue\nalpha\tnew\nbeta\tnew');
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path === '/repos/demo/leases')).toBe(false);
  }, 30_000);
  it.each(['ENV_ERROR', 'FAIL', 'TIMEOUT'])(`fails immediately with the completed %s inspection log`, async (outcome) => {
    const change = { changeId: 'change', revision: 3, status: 'draft' };
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/repos/demo/snapshot') return { data: { projections: { runners: { jobs: [
        { kind: 'inspect-candidate', changeId: 'change', revision: 3, jobId: 'job', state: 'completed' },
      ] } } } };
      if (path === '/repos/demo/changes/change') return { data: change };
      if (path === '/repos/demo/jobs/job/result') return { data: { result: { outcome, log: 'checker diagnostic tail' } } };
      throw new Error(`unexpected ${path}`);
    });
    await expect(waitChange({ request } as never, '/repos/demo/changes/change', Date.now() + 10_000, () => {}, async () => {}))
      .rejects.toMatchObject({ message: `INSPECTION_FAILED: ${outcome}${['ENV_ERROR', 'TIMEOUT'].includes(outcome) ? '; fix the environment, then re-run land with a new --intent-key' : ''}`,
        payload: { log: 'checker diagnostic tail' } });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 404])('returns awaiting-review for an author-only PASS inspection when result read returns %s', async status => {
    const { dir, commit, parent } = await source();
    const allowed = join(await temp(), 'allowed.txt');
    await writeFile(allowed, 'first.txt\nfamilies.tsv\nrenamed.tsv\n');
    const change = { changeId: 'change', provisioning: { state: 'observed' }, candidateStorageName: 'candidate',
      branch: 'refs/heads/work', authorId: 'agent', baseOid: parent, headOid: commit, revision: 1, status: 'ready' };
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: parent,
        canonicalStorageName: 'canonical', canonicalRemote: `file://${dir}` }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { runners: { jobs: [
        { kind: 'inspect-candidate', changeId: 'change', revision: 1, jobId: 'pass-job', state: 'completed' },
      ] } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/changes/change') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [
        'families.tsv', 'first.txt', 'renamed.tsv'].map((file, index) => ({ changeId: 'change', state: 'active',
          unitKey: `file:${file}`, leaseId: `lease-${index}`, fence: 1, remainingSeconds: 300 })) }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: { remote: `file://${dir}`, token: 'local-git-token' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/jobs/pass-job/result')
        throw new ConcordError('result read denied', 'auth', status);
      if (method === 'POST' && path.startsWith('/repos/demo/leases/') && path.endsWith('/release'))
        return { data: {}, version: 1 };
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    vi.stubEnv('CONCORD_REVIEWER_TOKEN', '');
    const result = await land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'test', allowedFiles: allowed,
      waitSeconds: 10, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} });
    expect(result).toEqual({ status: 'awaiting-review', changeId: 'change', headOid: commit });
    expect(request.mock.calls.filter(([method, path]) => method === 'GET' && path === '/repos/demo/jobs/pass-job/result'))
      .toHaveLength(1);
  });
  it.each([false, true])('republishes a repaired commit with the same intent after a failed inspection (advanced base: %s)', async advanceCanonical => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'a.txt'), 'original\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const base = await git(dir, 'rev-parse', 'HEAD');
    const failedSource = await temp(); await git(dir, 'clone', '-q', dir, failedSource);
    await writeFile(join(failedSource, 'a.txt'), 'failed\n');
    await git(failedSource, 'add', 'a.txt'); await git(failedSource, 'commit', '-qm', 'failed candidate');
    const failedHead = await git(failedSource, 'rev-parse', 'HEAD');
    const canonical = await temp(); await git(dir, 'clone', '-q', dir, canonical);
    if (advanceCanonical) {
      await writeFile(join(canonical, 'b.txt'), 'canonical advance\n');
      await git(canonical, 'add', 'b.txt'); await git(canonical, 'commit', '-qm', 'advance canonical');
    }
    const canonicalBase = await git(canonical, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'a.txt'), 'repaired\n');
    await git(dir, 'add', 'a.txt'); await git(dir, 'commit', '-qm', 'repaired candidate');
    const repairedHead = await git(dir, 'rev-parse', 'HEAD');
    const candidate = await temp(); await git(candidate, 'init', '-q', '--bare');
    await git(failedSource, 'push', '-q', candidate, `${failedHead}:refs/heads/work`);
    const allowed = join(await temp(), 'allowed.txt'); await writeFile(allowed, 'a.txt\n');
    const repository = { observedCanonicalOid: canonicalBase, canonicalStorageName: 'canonical',
      canonicalRemote: `file://${canonical}` };
    const change = { changeId: 'change', provisioning: { state: 'observed' }, candidateStorageName: 'candidate',
      branch: 'refs/heads/work', authorId: 'agent', baseOid: base, headOid: failedHead, revision: 1, status: 'draft' };
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, any> }) => {
      if (method === 'GET' && path === '/repos/demo') return { data: repository, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { runners: { jobs: [
        { kind: 'inspect-candidate', changeId: 'change', revision: 1, jobId: 'old-job', state: 'completed' },
        ...(change.revision === 2 ? [{ kind: 'inspect-candidate', changeId: 'change', revision: 2, jobId: 'new-job', state: 'completed' }] : []),
      ] } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/changes/change') return { data: change, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [{ changeId: 'change', state: 'active',
        unitKey: 'file:a.txt', leaseId: 'lease', fence: 1, remainingSeconds: 300 }] }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: {
        remote: options?.body?.storageName === 'canonical' ? `file://${canonical}` : `file://${candidate}`,
        token: 'local-git-token' }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/branches') return { data: {}, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes/change/publish') {
        change.baseOid = options?.body?.baseOid;
        change.headOid = options?.body?.headOid;
        change.revision = 2;
        change.status = 'ready';
        return { data: change, version: 1 };
      }
      if (method === 'GET' && path === '/repos/demo/jobs/old-job/result') return { data: { result: { outcome: 'FAIL', log: 'old failure' } }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/jobs/new-job/result') return { data: { result: { outcome: 'PASS' } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/leases/lease/release') return { data: {}, version: 1 };
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    const result = await land({ repo: 'demo', source: dir, commit: repairedHead, intentKey: 'same-task', intent: 'repair',
      allowedFiles: allowed, waitSeconds: 10, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} });
    expect(result).toMatchObject({ status: 'awaiting-review', changeId: 'change' });
    expect(change.baseOid).toBe(canonicalBase);
    expect(change.headOid).not.toBe(failedHead);
    expect(change.revision).toBe(2);
    expect(await git(candidate, 'rev-parse', 'refs/heads/work')).toBe(change.headOid);
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path.endsWith('/publish'))).toBe(true);
    expect(request.mock.calls.some(([method, path]) => method === 'GET' && path.endsWith('/old-job/result'))).toBe(false);
    expect(request.mock.calls.some(([method, path]) => method === 'GET' && path.endsWith('/new-job/result'))).toBe(true);
  });
  it('treats a rename as a deleted and an added path', async () => {
    const { dir, commit, parent } = await source();
    expect(await filesChanged(dir, commit)).toEqual({ parent, files: expect.arrayContaining(['first.txt', 'families.tsv', 'renamed.tsv']) });
  });
  it('checks the full range, and refuses merges, unrelated bases, and empty ranges', async () => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'a.txt'), 'a=0\n'); await writeFile(join(dir, 'b.txt'), 'b=0\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const base = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'a.txt'), 'a=1\n'); await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'first');
    const first = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'b.txt'), 'b=1\n'); await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'second');
    const head = await git(dir, 'rev-parse', 'HEAD');
    expect(await filesChanged(dir, head, base)).toEqual({ parent: base, files: ['a.txt', 'b.txt'] });
    expect(await filesChanged(dir, head)).toEqual({ parent: first, files: ['b.txt'] });
    await expect(filesChanged(dir, first, head)).rejects.toThrow('REFUSED: base is not an ancestor of head');
    await expect(filesChanged(dir, head, head)).rejects.toThrow('REFUSED: range has an empty diff');
    await git(dir, 'checkout', '-qb', 'side', base);
    await writeFile(join(dir, 'side.txt'), 'side\n'); await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'side');
    await git(dir, 'checkout', '-q', 'main'); await git(dir, 'merge', '--no-ff', '-qm', 'merge side', 'side');
    const merged = await git(dir, 'rev-parse', 'HEAD');
    await expect(filesChanged(dir, merged, base)).rejects.toThrow('REFUSED: range contains a merge commit');
  });
  it('rejects an out-of-scope file before any API request', async () => {
    const { dir, commit } = await source();
    const allow = join(dir, 'allowed-files.txt'); await writeFile(allow, 'first.txt\n');
    const request = vi.fn();
    await expect(land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'test', allowedFiles: allow,
      client: { request } as never })).rejects.toThrow('OUTSIDE_ALLOWED_FILES: families.tsv, renamed.tsv');
    expect(request).not.toHaveBeenCalled();
  });
  it('preserves leading spaces in Git paths for single commits and ranges', async () => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'seed.txt'), 'seed\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const base = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, ' a.txt'), 'first\n');
    await git(dir, 'add', '--', ' a.txt'); await git(dir, 'commit', '-qm', 'first');
    const first = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'b.txt'), 'second\n');
    await git(dir, 'add', 'b.txt'); await git(dir, 'commit', '-qm', 'second');
    const head = await git(dir, 'rev-parse', 'HEAD');
    const allowed = join(await temp(), 'allowed.txt'); await writeFile(allowed, 'a.txt\nb.txt\n');
    const request = vi.fn();
    expect((await filesChanged(dir, first)).files).toEqual([' a.txt']);
    expect((await filesChanged(dir, head, base)).files).toEqual([' a.txt', 'b.txt']);
    for (const [commit, rangeBase] of [[first, undefined], [head, base]] as const) {
      await expect(land({ repo: 'demo', source: dir, commit, base: rangeBase, intentKey: 'task', intent: 'test', allowedFiles: allowed,
        client: { request } as never })).rejects.toThrow('OUTSIDE_ALLOWED_FILES:  a.txt');
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('refuses invalid UTF-8 Git path bytes in single commits and ranges before API writes', async () => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'seed.txt'), 'seed\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const base = await git(dir, 'rev-parse', 'HEAD');
    const seedBlob = await git(dir, 'rev-parse', `${base}:seed.txt`);
    const emptyBlob = await git(dir, 'hash-object', '-w', '--', '/dev/null');
    const rawName = Buffer.from('ff612e747874', 'hex');
    const makeTree = (withSecond: boolean): string => {
      const entries = [Buffer.from(`100644 blob ${seedBlob}\tseed.txt\0`),
        Buffer.concat([Buffer.from(`100644 blob ${emptyBlob}\t`), rawName, Buffer.from([0])])];
      if (withSecond) entries.push(Buffer.from(`100644 blob ${emptyBlob}\tb.txt\0`));
      return execFileSync('git', ['mktree', '-z'], { cwd: dir, input: Buffer.concat(entries) }).toString().trim();
    };
    const first = await git(dir, 'commit-tree', makeTree(false), '-p', base, '-m', 'first');
    const head = await git(dir, 'commit-tree', makeTree(true), '-p', first, '-m', 'second');
    const allowed = join(await temp(), 'allowed.txt'); await writeFile(allowed, '�a.txt\nb.txt\n');
    const request = vi.fn();
    for (const [commit, rangeBase] of [[first, undefined], [head, base]] as const) {
      await expect(filesChanged(dir, commit, rangeBase)).rejects.toThrow('Git path is not valid UTF-8');
      await expect(land({ repo: 'demo', source: dir, commit, base: rangeBase, intentKey: 'task', intent: 'test', allowedFiles: allowed,
        client: { request } as never })).rejects.toThrow('Git path is not valid UTF-8');
    }
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['single commit', 'range'])('preserves a leading UTF-8 BOM in Git paths for a %s before API requests', async (kind) => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'seed.txt'), 'seed\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const base = await git(dir, 'rev-parse', 'HEAD');
    const seedBlob = await git(dir, 'rev-parse', `${base}:seed.txt`);
    const emptyBlob = await git(dir, 'hash-object', '-w', '--', '/dev/null');
    const rawName = Buffer.from('efbbbf612e747874', 'hex');
    const makeTree = (withSecond: boolean): string => {
      const entries = [Buffer.from(`100644 blob ${seedBlob}\tseed.txt\0`),
        Buffer.concat([Buffer.from(`100644 blob ${emptyBlob}\t`), rawName, Buffer.from([0])])];
      if (withSecond) entries.push(Buffer.from(`100644 blob ${emptyBlob}\t😀.txt\0`));
      return execFileSync('git', ['mktree', '-z'], { cwd: dir, input: Buffer.concat(entries) }).toString().trim();
    };
    const first = await git(dir, 'commit-tree', makeTree(false), '-p', base, '-m', 'first');
    const head = await git(dir, 'commit-tree', makeTree(true), '-p', first, '-m', 'second');
    const commit = kind === 'range' ? head : first;
    const rangeBase = kind === 'range' ? base : undefined;
    const raw = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--no-renames', '--name-only', '-z', base, commit], { cwd: dir });
    expect(raw.includes(Buffer.concat([rawName, Buffer.from([0])]))).toBe(true);
    const allowed = join(await temp(), 'allowed.txt'); await writeFile(allowed, 'a.txt\n😀.txt\n');
    const request = vi.fn();
    expect((await filesChanged(dir, commit, rangeBase)).files).toContain('\uFEFFa.txt');
    await expect(land({ repo: 'demo', source: dir, commit, base: rangeBase, intentKey: 'task', intent: 'test', allowedFiles: allowed,
      client: { request } as never })).rejects.toThrow('OUTSIDE_ALLOWED_FILES: \uFEFFa.txt');
    expect(request).not.toHaveBeenCalled();
  });
  it('requires one unambiguous approval line naming the published SHA', () => {
    const head = 'a'.repeat(40);
    const report = `# ✅ APPROVED FOR MERGE — head ${head}\n\nReview details.\n\nAPPROVED for merge`;
    expect(approvedHead(report, head)).toBe(true);
    expect(approvedHead(`# ✅ approved for merge — head ${head}\nAPPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`# ✅ APPROVED FOR MERGE — head ${'b'.repeat(40)}\nAPPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`# ✅ APPROVED FOR MERGE — head ${head}\nCHANGES REQUIRED\nAPPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`Review evidence:\n\`\`\`\n# ✅ APPROVED FOR MERGE — head ${head}\nAPPROVED for merge\n\`\`\``, head)).toBe(false);
    expect(approvedHead(`> # ✅ APPROVED FOR MERGE — head ${head}\n> APPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`# ✅ APPROVED FOR MERGE — head ${head}\n\nAPPROVED for merge\nAdditional notes`, head)).toBe(false);
    expect(approvedHead(`# ✅ APPROVED FOR MERGE — head ${head}\nNOT APPROVED\nAPPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`# ✅ APPROVED FOR MERGE — head ${head}\nREQUEST CHANGES\nAPPROVED for merge`, head)).toBe(false);
    expect(approvedHead(`\`\`\`markdown\n# ✅ APPROVED FOR MERGE — head ${head}\nAPPROVED for merge\n\`\`\``, head)).toBe(false);
  });
  it('accepts the AW launcher review trailer only when its verdict and outcome are final', () => {
    const head = 'a'.repeat(40);
    const body = `# ✅ APPROVED FOR MERGE — head ${head}\n\nReview details.\n\n`;
    expect(approvedHead(`${body}VERDICT: APPROVED\nDELEGATE_OUTCOME=completed\n`, head)).toBe(true);
    expect(approvedHead(`# ✅ APPROVED FOR MERGE — head ${head.toUpperCase()}\nVERDICT: APPROVED`, head)).toBe(true);
    expect(approvedHead(`${body}VERDICT: APPROVED\n`, head)).toBe(true);
    expect(approvedHead(`${body}VERDICT: APPROVED\nDELEGATE_OUTCOME=failed\n`, head)).toBe(false);
    expect(approvedHead(`${body}VERDICT: REQUEST CHANGES\nDELEGATE_OUTCOME=completed\n`, head)).toBe(false);
    expect(approvedHead(`${body}VERDICT: APPROVED\nDELEGATE_OUTCOME=completed\nTrailing text\n`, head)).toBe(false);
    expect(approvedHead(`${body}APPROVED for merge\nDELEGATE_OUTCOME=completed\n`, head)).toBe(false);
  });
  it('rejects conflicting AW commit and allowed-file overrides before any API request', async () => {
    const { dir, commit, parent } = await source();
    const run = await temp();
    await writeFile(join(run, 'status.json'), JSON.stringify({ validated_sha: commit, worktree: dir, job_id: 'run_123' }));
    await writeFile(join(run, 'work-spec.md'), 'Goal:\n  Outcome: Ship the command\n');
    await writeFile(join(run, 'allowed-files.txt'), 'first.txt\nfamilies.tsv\nrenamed.tsv\n');
    await writeFile(join(dir, 'first.txt'), 'later\n');
    await git(dir, 'add', 'first.txt'); await git(dir, 'commit', '-qm', 'other commit');
    const other = await git(dir, 'rev-parse', 'HEAD');
    const wider = join(run, 'wider.txt'); await writeFile(wider, 'first.txt\nfamilies.tsv\nrenamed.tsv\nother.txt\n');
    const request = vi.fn();
    const base = { repo: 'demo', awRun: run, base: parent, client: { request } as never };
    await expect(land({ ...base, commit: other })).rejects.toThrow('--commit conflicts with AW validated_sha');
    await expect(land({ ...base, allowedFiles: wider })).rejects.toThrow('--allowed-files conflicts with AW run allowed-files.txt');
    expect(request).not.toHaveBeenCalled();
  });
  it.each([17, 64, 65])('applies the 64-unit cap to a %i-file commit', async count => {
    const dir = await temp(); await git(dir, 'init', '-q');
    const names = Array.from({ length: count }, (_, index) => `file-${index}.txt`);
    for (const name of names) await writeFile(join(dir, name), 'before\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    for (const name of names) await writeFile(join(dir, name), 'after\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'candidate');
    const commit = await git(dir, 'rev-parse', 'HEAD');
    const allowed = join(await temp(), 'allowed.txt'); await writeFile(allowed, names.join('\n') + '\n');
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: 'a'.repeat(40) } };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { runners: { jobs: [] } } } };
      if (method === 'POST' && path === '/repos/demo/changes') throw new Error('change create reached');
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-test'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    await expect(land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'test', allowedFiles: allowed,
      client: { request } as never })).rejects.toThrow(count === 65
      ? 'LAND_TOO_MANY_UNITS: 65 normalized units exceed the cap of 64; declare coarser prefix or section units in policy'
      : 'change create reached');
    expect(request).toHaveBeenCalledTimes(count === 65 ? 2 : 3);
    expect(request.mock.calls.some(([method]) => method === 'POST')).toBe(count <= 64);
  });
  it.each(['wait result', 'current readback'])('rejects a concurrent republication in the %s without submitting a verdict', async (race) => {
    const { dir, commit, parent } = await source();
    const allowed = join(dir, 'allowed.txt');
    await writeFile(allowed, 'first.txt\nfamilies.tsv\nrenamed.tsv\n');
    const evidence = join(dir, 'review.txt');
    await writeFile(evidence, `# ✅ APPROVED FOR MERGE — head ${commit}\nAPPROVED for merge\n`);
    const original = { changeId: 'change', provisioning: { state: 'observed' }, candidateStorageName: 'candidate',
      branch: 'refs/heads/work', authorId: 'agent', baseOid: parent, headOid: commit, revision: 1, status: 'ready' };
    const republished = { ...original, headOid: 'b'.repeat(40), revision: 2 };
    let reads = 0;
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/repos/demo') return { data: { observedCanonicalOid: parent,
        canonicalStorageName: 'canonical', canonicalRemote: 'file:///tmp/canonical.git' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/snapshot') return { data: { projections: { runners: { jobs: [] } } }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/changes') return { data: original, version: 1 };
      if (method === 'GET' && path === '/repos/demo/queue') return { data: { entries: [] }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/leases') return { data: { items: [
        'families.tsv', 'first.txt', 'renamed.tsv'].map((file, index) => ({ changeId: 'change', state: 'active',
          unitKey: `file:${file}`, leaseId: `lease-${index}`, fence: 1, remainingSeconds: 300 })) }, version: 1 };
      if (method === 'POST' && path === '/repos/demo/git-token') return { data: { remote: 'file:///tmp/canonical.git', token: 'local-git-token' }, version: 1 };
      if (method === 'GET' && path === '/repos/demo/changes/change') {
        reads++;
        return { data: reads >= (race === 'wait result' ? 2 : 3) ? republished : original, version: 1 };
      }
      if (method === 'POST' && path.startsWith('/repos/demo/leases/') && path.endsWith('/release')) return { data: {}, version: 1 };
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubEnv('CONCORD_TOKEN', 'local-agent'); vi.stubEnv('CONCORD_URL', 'http://127.0.0.1:1234');
    vi.stubEnv('CONCORD_REVIEWER_TOKEN', 'local-reviewer');
    await expect(land({ repo: 'demo', source: dir, commit, intentKey: 'task', intent: 'test', allowedFiles: allowed,
      reviewEvidence: evidence, waitSeconds: 2, client: { baseUrl: 'http://127.0.0.1:1234', request } as never, emit: () => {} }))
      .rejects.toThrow('PUBLISHED_HEAD_MISMATCH');
    expect(request.mock.calls.some(([method, path]) => method === 'POST' && path.endsWith('/verdicts'))).toBe(false);
    expect(reads).toBeGreaterThanOrEqual(race === 'wait result' ? 2 : 3);
  });
  it('reads the validated AW SHA and stable intent key', async () => {
    const dir = await temp(); const sha = 'a'.repeat(40);
    await writeFile(join(dir, 'status.json'), JSON.stringify({ validated_sha: sha, worktree: '/tmp/work', job_id: 'run_123' }));
    await writeFile(join(dir, 'work-spec.md'), 'Goal:\n  Outcome: Ship the command\n  Done when: checked\n');
    await writeFile(join(dir, 'allowed-files.txt'), 'first.txt\n');
    expect(await readAwRun(dir)).toEqual({ source: '/tmp/work', commit: sha, intentKey: 'run_123', intent: 'Ship the command', allowedFiles: join(dir, 'allowed-files.txt') });
    expect(await readFile(join(dir, 'allowed-files.txt'), 'utf8')).toBe('first.txt\n');
  });
  it('requires an explicit AW base even when status records a base or parent', async () => {
    const { dir, parent, commit } = await source();
    const run = await temp();
    await writeFile(join(run, 'status.json'), JSON.stringify({ validated_sha: commit, worktree: dir, job_id: 'run_123', base_sha: parent, parent_sha: parent }));
    await writeFile(join(run, 'work-spec.md'), 'Goal:\n  Outcome: Ship the command\n');
    await writeFile(join(run, 'allowed-files.txt'), 'first.txt\nfamilies.tsv\nrenamed.tsv\n');
    expect(await readAwRun(run)).not.toHaveProperty('base');
    const request = vi.fn();
    await expect(land({ repo: 'demo', awRun: run, client: { request } as never }))
      .rejects.toThrow('supply --base');
    expect(request).not.toHaveBeenCalled();
  });
  it('does not treat the second commit parent_sha as the AW run base', async () => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'seed.txt'), 'seed\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const base = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'a.txt'), 'first\n');
    await git(dir, 'add', 'a.txt'); await git(dir, 'commit', '-qm', 'first');
    const first = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'b.txt'), 'second\n');
    await git(dir, 'add', 'b.txt'); await git(dir, 'commit', '-qm', 'second');
    const head = await git(dir, 'rev-parse', 'HEAD');
    const run = await temp();
    await writeFile(join(run, 'status.json'), JSON.stringify({ validated_sha: head, worktree: dir, job_id: 'two_commits', parent_sha: first }));
    await writeFile(join(run, 'work-spec.md'), 'Goal:\n  Outcome: Land both commits\n');
    await writeFile(join(run, 'allowed-files.txt'), 'b.txt\n');
    const request = vi.fn();
    await expect(land({ repo: 'demo', awRun: run, client: { request } as never })).rejects.toThrow('supply --base');
    await expect(land({ repo: 'demo', awRun: run, base, client: { request } as never }))
      .rejects.toThrow('OUTSIDE_ALLOWED_FILES: a.txt');
    expect(await filesChanged(dir, head, base)).toEqual({ parent: base, files: ['a.txt', 'b.txt'] });
    expect(request).not.toHaveBeenCalled();
  });
  it('requires --base for a single-commit AW run too', async () => {
    const dir = await temp(); await git(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'seed.txt'), 'seed\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    await git(dir, 'checkout', '-qb', 'agent');
    await writeFile(join(dir, 'changed.txt'), 'changed\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'candidate');
    const commit = await git(dir, 'rev-parse', 'HEAD');
    const run = await temp();
    await writeFile(join(run, 'status.json'), JSON.stringify({ validated_sha: commit, worktree: dir, job_id: 'single-task' }));
    await writeFile(join(run, 'work-spec.md'), 'Goal:\n  Outcome: Land one commit\n');
    await writeFile(join(run, 'allowed-files.txt'), 'other.txt\n');
    const request = vi.fn();
    await expect(land({ repo: 'demo', awRun: run, client: { request } as never }))
      .rejects.toThrow('supply --base');
    expect(request).not.toHaveBeenCalled();
  });
  it('validates allowed path syntax', () => {
    expect([...parseAllowed('a.txt\nb/c.txt\n')]).toEqual(['a.txt', 'b/c.txt']);
    expect(() => parseAllowed('../secret\n')).toThrow('invalid path');
  });
  it('maps changed rows through a declared TSV policy', async () => {
    const dir = await temp(); await git(dir, 'init', '-q');
    await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\nalpha\t1\nbeta\t2\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'base');
    const parent = await git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'families.tsv'), 'family\tretry_limit\nalpha\t3\nbeta\t2\n');
    await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'update');
    const head = await git(dir, 'rev-parse', 'HEAD');
    const policy = { tables: [{ name: 'families', file: 'families.tsv', header: ['family', 'retry_limit'], keyColumn: 'family',
      keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } }], units: {} };
    expect(await unitKeys(dir, parent, head, ['families.tsv'], policy)).toEqual(['row:families:alpha']);
  });
});

// A real bridge, Worker, and separate runner verify the orchestration route.
// The runner is pumped once per observed job; land never executes it itself.
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { digest } from '../../src/http.ts';
import { localEnvironment } from '../../runner/profiles.ts';
import { wranglerStateDir } from '../../demo/scenarios.ts';

const services: ChildProcess[] = [];
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}
function service(file: string, args: string[], env: NodeJS.ProcessEnv): () => string {
  const child = spawn(file, args, { cwd: resolve('.'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  services.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', part => { output = (output + part.toString()).slice(-6000); });
  return () => output;
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('local stack startup timed out');
}
afterEach(async () => {
  for (const child of services.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>(done => child.once('close', () => done()));
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await Promise.race([closed, new Promise<void>(done => setTimeout(done, 3000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      await closed;
    }
  }
});

it('lands a generic agent commit through a separate checker, reviewer, queue, and promoter', async () => {
  const dir = await temp();
  const root = resolve('.');
  const bridgePort = await freePort(); const workerPort = await freePort();
  const url = `http://127.0.0.1:${workerPort}`;
  const secret = 'local-bridge-land-fixture';
  const environment = { ...process.env, TMPDIR: dir, XDG_CONFIG_HOME: dir, CONCORD_RUN_DIR: dir,
    CONCORD_URL: url, CONCORD_SHOW_DECOMPILED_C: '0' };
  const binary = `sha256:${createHash('sha256').update(await readFile('/bin/sh')).digest('hex')}`;
  const settings = { executable: '/bin/sh', argv: ['check.sh'], cwd: 'repo' as const, timeoutSeconds: 3,
    env: ['PATH', 'TMPDIR', 'LANG'], outputCap: 4096 };
  const profileInput = { id: 'generic-land', kind: 'command', checkerId: 'generic-land', checkerDigest: binary,
    toolchainDigest: binary, oracleDigest: await digest(settings), environmentDigest: await digest(localEnvironment()),
    timeoutMs: 10_000, maxOutputBytes: 4096, toolchainFile: '/bin/sh', ...settings };
  const profile = { ...profileInput, digest: await digest(profileInput) };
  const profilePath = join(dir, 'profile.json'); await writeFile(profilePath, JSON.stringify(profile));
  const bulkFiles = Array.from({ length: 15 }, (_, index) => `bulk-${index}.txt`);
  const units = Object.fromEntries(['check.sh', 'a.txt', 'b.txt', 'families.tsv', 'shared.txt', 'range-a.txt', 'range-b.txt', ...bulkFiles].map(file => [`file:${file}`, {
    canonicalKey: `file:${file}`, file, resources: [], dependencyKeys: [],
  }]));
  const policyInput = { id: 'generic-land', version: 1, checkerId: 'generic-land', checkerDigest: binary,
    acceptance: { kind: 'hard-gates', gates: [{ id: 'default', requiredOutcome: 'PASS' }] }, units,
    tables: [{ name: 'families', file: 'families.tsv', header: ['family', 'value'], keyColumn: 'family',
      keySpec: { charset: 'lower', minLength: 1, maxLength: 64 } }] };
  const policy = { ...policyInput, digest: await digest(policyInput) };
  const trusted = JSON.stringify({ policies: { 'generic-land': policy }, profiles: { 'generic-land': {
    id: profile.id, digest: profile.digest, toolchainDigest: profile.toolchainDigest,
    oracleDigest: profile.oracleDigest, environmentDigest: profile.environmentDigest,
    timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes,
  } } });
  const bridgeOutput = service(process.execPath, ['--import', 'tsx', 'local/git-bridge.ts'], {
    ...environment, CONCORD_BRIDGE_DATA_DIR: join(dir, 'bridge'), CONCORD_BRIDGE_TOKEN: secret,
    CONCORD_BRIDGE_PORT: String(bridgePort),
  });
  await waitFor(async () => bridgeOutput().includes(`listening on 127.0.0.1:${bridgePort}`));
  const workerOutput = service(join(root, 'node_modules/.bin/wrangler'), ['dev', '--config', 'wrangler.local.jsonc',
    '--port', String(workerPort), '--persist-to', wranglerStateDir(dir), '--var', 'STORAGE_BACKEND:bridge',
    '--var', `BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=${secret}`, '--var', `TRUSTED_CONFIG:${trusted}`],
    { ...environment, WRANGLER_SEND_METRICS: 'false' });
  await waitFor(async () => (await fetch(url + '/health')).ok);
  const api = async (path: string) => fetch(`${url}/v1/repos/landdemo${path}`, {
    headers: { authorization: 'Bearer local-owner' },
  }).then(response => response.json()) as Promise<any>;
  async function drive<T>(work: Promise<T>, beforeRun?: (job: any) => Promise<void>): Promise<T> {
    let finished = false;
    work.finally(() => { finished = true; }).catch(() => {});
    const handled = new Set<string>(); const until = Date.now() + 150_000;
    while (!finished && Date.now() < until) {
      const snapshot = await api('/snapshot').catch(() => null);
      const pending = snapshot?.data?.projections?.runners?.jobs?.find((job: any) =>
        job.state === 'pending' && !handled.has(job.jobId));
      if (pending) {
        handled.add(pending.jobId);
        if (beforeRun) await beforeRun(pending);
        const role = pending.kind === 'promote' ? 'promoter' : 'checker';
        const args = ['--import', 'tsx', 'runner/main.ts', '--repo', 'landdemo', '--role', role, '--once'];
        if (role === 'checker') args.push('--profile', profilePath);
        const run = await execFile(process.execPath, args, { cwd: root, env: {
          ...environment, CONCORD_TOKEN: `local-${role}`, CONCORD_PROFILE_DIGEST: profile.digest,
        }, timeout: 40_000 });
        expect(run.stdout).toContain('Completed 1 job(s)');
      } else await new Promise(done => setTimeout(done, 150));
    }
    if (!finished) throw new Error(`runner pump timed out: ${workerOutput()}`);
    return work;
  }
  const seed = await temp();
  await git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'check.sh'), 'exit 0\n');
  await writeFile(join(seed, 'a.txt'), 'a=0\n');
  await writeFile(join(seed, 'b.txt'), 'b=0\n');
  await writeFile(join(seed, 'families.tsv'), 'family\tvalue\nalpha\told\n');
  for (const file of bulkFiles) await writeFile(join(seed, file), 'before\n');
  await writeFile(join(seed, 'shared.txt'), Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n') + '\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-qm', 'seed');
  const imported = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'import',
    '--source', seed, '--ref', 'main', '--repo', 'landdemo', '--policy-id', 'generic-land',
    '--profile-id', 'generic-land'], { cwd: root, env: { ...environment, CONCORD_TOKEN: 'local-owner' }, timeout: 150_000 }));
  const importedOid = JSON.parse(imported.stdout).canonicalOid;
  expect((await api('')).data.observedCanonicalOid).toBe(importedOid);
  const canonical = join(dir, 'bridge', (await api('')).data.canonicalStorageName + '.git');
  const sourceDir = await temp();
  await git(sourceDir, 'clone', '-q', '-b', 'main', canonical, '.');
  await writeFile(join(sourceDir, 'a.txt'), 'a=1\n');
  for (const file of bulkFiles) await writeFile(join(sourceDir, file), 'after\n');
  await git(sourceDir, 'add', '.'); await git(sourceDir, 'commit', '-qm', 'agent update');
  const commit = await git(sourceDir, 'rev-parse', 'HEAD');
  const allowed = join(dir, 'allowed.txt'); await writeFile(allowed, ['a.txt', ...bulkFiles].join('\n') + '\n');
  const evidence = join(dir, 'review.txt'); await writeFile(evidence, `# ✅ APPROVED FOR MERGE — head ${commit}\n\nReview of ${commit}\n\nAPPROVED for merge\n`);
  const baseArgs = ['--repo', 'landdemo', '--source', sourceDir, '--commit', commit, '--intent-key', 'generic-task',
    '--intent', 'Update a value', '--allowed-files', allowed, '--wait-seconds', '150', '--json'];
  const landEnv = { ...environment, CONCORD_TOKEN: 'local-agent-a', CONCORD_REVIEWER_TOKEN: 'local-reviewer' };
  const authorEnv: NodeJS.ProcessEnv = { ...landEnv };
  delete authorEnv.CONCORD_REVIEWER_TOKEN;
  const startedRun = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'start', '--repo', 'landdemo',
    '--intent-key', 'generic-task', '--intent', 'Update a value', '--allowed-files', allowed, '--hold', '2h', '--json'],
  { cwd: root, env: authorEnv, timeout: 30_000 });
  const started = JSON.parse(startedRun.stdout);
  expect(started.leases).toHaveLength(16);
  const first = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...baseArgs],
    { cwd: root, env: authorEnv, timeout: 155_000 }));
  expect(first.stdout).toContain('"state":"awaiting-review"');
  expect(first.stdout.trim().split('\n').map(line => JSON.parse(line))).not.toContainEqual(expect.objectContaining({ state: 'leased' }));
  const beforeResume = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === 'generic-task');
  const wrongEvidence = join(dir, 'wrong-review.txt');
  await writeFile(wrongEvidence, `APPROVED for merge: ${'f'.repeat(40)}\n`);
  await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...baseArgs,
    '--review-evidence', wrongEvidence], { cwd: root, env: landEnv, timeout: 30_000 }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('exact published head SHA') });
  await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...baseArgs,
    '--review-evidence', evidence], { cwd: root, env: { ...landEnv, CONCORD_REVIEWER_TOKEN: 'local-agent-a' }, timeout: 30_000 }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('reviewer token must differ') });
  const landed = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land',
    ...baseArgs, '--review-evidence', evidence], { cwd: root, env: landEnv, timeout: 155_000 }))
    .catch(error => { throw new Error(`land failed after: ${(error as { stdout?: string }).stdout ?? ''}\n${(error as Error).message}`); });
  const afterResume = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === 'generic-task');
  expect(afterResume.changeId).toBe(started.changeId);
  expect(afterResume.changeId).toBe(beforeResume.changeId);
  expect(afterResume.revision).toBe(beforeResume.revision);
  const events = landed.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect([...first.stdout.trim().split('\n').map(line => JSON.parse(line)), ...events].map(item => item.state))
    .toEqual(expect.arrayContaining(['created', 'published', 'reviewed', 'enqueued', 'landed']));
  expect(events.at(-1).canonicalOid).toBe((await api('')).data.observedCanonicalOid);
  for (const value of ['local-agent-a', 'local-reviewer', secret]) {
    expect(landed.stdout + landed.stderr).not.toContain(value);
  }
  const oldSource = await temp(); await git(oldSource, 'clone', '-q', '-b', 'main', seed, '.');
  const carryAllowed = join(dir, 'carry-allowed.txt'); await writeFile(carryAllowed, 'families.tsv\n');
  const rowStarted = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'start', '--repo', 'landdemo',
    '--intent-key', 'carry-task', '--intent', 'Carry old-parent update', '--allowed-files', carryAllowed, '--hold', '2h', '--json'],
  { cwd: root, env: authorEnv, timeout: 30_000 });
  expect(JSON.parse(rowStarted.stdout).leases).toMatchObject([{ unitKey: 'file:families.tsv' }]);
  await writeFile(join(oldSource, 'families.tsv'), 'family\tvalue\nalpha\tnew\n');
  await git(oldSource, 'add', 'families.tsv'); await git(oldSource, 'commit', '-qm', 'old-parent row update');
  const sourceOid = await git(oldSource, 'rev-parse', 'HEAD');
  const carryEvidence = join(dir, 'carry-review.txt');
  await writeFile(carryEvidence, `# ✅ APPROVED FOR MERGE — head ${sourceOid}\nAPPROVED for merge\n`);
  const carryArgs = ['--repo', 'landdemo', '--source', oldSource, '--commit', sourceOid,
    '--intent-key', 'carry-task', '--intent', 'Carry old-parent update', '--allowed-files', carryAllowed,
    '--wait-seconds', '150', '--json'];
  const otherEvidence = join(dir, 'other-review.txt');
  await writeFile(otherEvidence, `# ✅ APPROVED FOR MERGE — head ${'f'.repeat(40)}\nAPPROVED for merge\n`);
  await drive(expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...carryArgs,
    '--review-evidence', otherEvidence], { cwd: root, env: landEnv, timeout: 155_000 }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('exact published head SHA') }));
  const carried = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...carryArgs,
    '--review-evidence', carryEvidence], { cwd: root, env: landEnv, timeout: 155_000 }));
  const carriedEvents = carried.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(carriedEvents.some(item => item.state === 'leased')).toBe(false);
  expect(carriedEvents.at(-1).changeId).toBe(JSON.parse(rowStarted.stdout).changeId);
  const carryEvent = carriedEvents.find(item => item.state === 'review-carried');
  expect(carryEvent).toMatchObject({ sourceOid, publishedOid: expect.stringMatching(/^[a-f0-9]{40}$/) });
  expect(carryEvent.publishedOid).not.toBe(sourceOid);
  expect(carriedEvents.findIndex(item => item.state === 'review-carried')).toBeLessThan(carriedEvents.findIndex(item => item.state === 'reviewed'));
  expect(carriedEvents.at(-1).state).toBe('landed');
  const carryChange = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === 'carry-task');
  const carryVerdicts = await api(`/changes/${carryChange.changeId}/verdicts`);
  expect(carryVerdicts.data.items.at(-1).carriedFrom).toEqual({ sourceOid, method: 'patch-id' });

  const republishCases = await Promise.all(['a.txt', 'b.txt', 'bulk-0.txt'].map(async (file, index) => {
    const checkout = await temp(); await git(checkout, 'clone', '-q', '-b', 'main', canonical, '.');
    await writeFile(join(checkout, file), `${file}=reviewed-${index}\n`);
    await git(checkout, 'add', file); await git(checkout, 'commit', '-qm', 'reviewed patch');
    const head = await git(checkout, 'rev-parse', 'HEAD');
    const paths = join(dir, `republish-allowed-${index}.txt`); await writeFile(paths, `${file}\n`);
    const review = join(dir, `republish-review-${index}.txt`);
    return { file, checkout, head, paths, review, intent: `republish-${index}`, reviewedHead: '' };
  }));

  const rangeSource = await temp(); await git(rangeSource, 'clone', '-q', '-b', 'main', seed, '.');
  const rangeBase = await git(rangeSource, 'rev-parse', 'HEAD');
  await git(rangeSource, 'checkout', '-qb', 'agent-range');
  await writeFile(join(rangeSource, 'range-a.txt'), 'first\n');
  await git(rangeSource, 'add', 'range-a.txt'); await git(rangeSource, 'commit', '-qm', 'range implementation');
  const firstRangeCommit = await git(rangeSource, 'rev-parse', 'HEAD');
  await writeFile(join(rangeSource, 'range-b.txt'), 'second\n');
  await git(rangeSource, 'add', 'range-b.txt'); await git(rangeSource, 'commit', '-qm', 'range repair');
  const rangeHead = await git(rangeSource, 'rev-parse', 'HEAD');
  const rangeRun = await temp();
  await writeFile(join(rangeRun, 'status.json'), JSON.stringify({ validated_sha: rangeHead, worktree: rangeSource, job_id: 'range-task', parent_sha: firstRangeCommit }));
  await writeFile(join(rangeRun, 'work-spec.md'), 'Goal:\n  Outcome: Land repaired range\n');
  await writeFile(join(rangeRun, 'allowed-files.txt'), 'range-a.txt\nrange-b.txt\n');
  const rangeEvidence = join(dir, 'range-review.txt');
  const rangeArgs = ['--repo', 'landdemo', '--aw-run', rangeRun, '--base', rangeBase, '--wait-seconds', '150', '--json'];
  await expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', '--repo', 'landdemo',
    '--aw-run', rangeRun, '--wait-seconds', '150', '--json'], { cwd: root, env: landEnv, timeout: 155_000 }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('supply --base') });
  await writeFile(rangeEvidence, `# ✅ APPROVED FOR MERGE — head ${firstRangeCommit}\nAPPROVED for merge\n`);
  await drive(expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...rangeArgs,
    '--review-evidence', rangeEvidence], { cwd: root, env: landEnv, timeout: 155_000 }))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('exact published head SHA') }));
  await writeFile(rangeEvidence, `# ✅ APPROVED FOR MERGE — head ${rangeHead}\nAPPROVED for merge\n`);
  const beforeRange = (await api('')).data.observedCanonicalOid;
  const rangeResult = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...rangeArgs,
    '--review-evidence', rangeEvidence], { cwd: root, env: landEnv, timeout: 155_000 }));
  const rangeEvents = rangeResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  const squashEvent = rangeEvents.find(item => item.state === 'squashed');
  expect(squashEvent).toMatchObject({ base: rangeBase, headOid: rangeHead,
    squashOid: expect.stringMatching(/^[a-f0-9]{40}$/) });
  expect(rangeEvents.map(item => item.state)).toEqual(expect.arrayContaining(['review-carried', 'landed']));
  const rangeChange = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === 'range-task');
  const rangeCandidate = join(dir, 'bridge', `${rangeChange.candidateStorageName}.git`);
  const publishedParent = await git(rangeCandidate, 'rev-list', '--parents', '-n', '1', rangeChange.headOid);
  expect(publishedParent.split(' ')).toEqual([rangeChange.headOid, beforeRange]);
  expect(await git(rangeCandidate, 'diff', '--binary', beforeRange, rangeChange.headOid)).toBe(
    await git(rangeSource, 'diff', '--binary', rangeBase, rangeHead));
  const canonicalAfterRange = (await api('')).data.observedCanonicalOid;
  expect(await git(canonical, 'show', `${canonicalAfterRange}:range-a.txt`)).toBe('first');
  expect(await git(canonical, 'show', `${canonicalAfterRange}:range-b.txt`)).toBe('second');
  expect((await git(canonical, 'rev-list', '--parents', '-n', '1', canonicalAfterRange)).split(' '))
    .toEqual([canonicalAfterRange, beforeRange, rangeChange.headOid]);
  const rangeVerdicts = await api(`/changes/${rangeChange.changeId}/verdicts`);
  expect(rangeVerdicts.data.items.at(-1).carriedFrom).toEqual({ sourceOid: rangeHead, method: 'patch-id' });

  for (const item of republishCases) {
    const args = ['--repo', 'landdemo', '--source', item.checkout, '--commit', item.head,
      '--intent-key', item.intent, '--intent', `Republish ${item.file}`, '--allowed-files', item.paths,
      '--wait-seconds', '150', '--json'];
    const first = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...args],
      { cwd: root, env: authorEnv, timeout: 155_000 }));
    const events = first.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1).state).toBe('awaiting-review');
    item.reviewedHead = events.at(-1).headOid;
    expect(item.reviewedHead).not.toBe(item.head);
    await writeFile(item.review, `# ✅ APPROVED FOR MERGE — head ${item.reviewedHead}\nAPPROVED for merge\n`);
  }

  const contextSource = await temp(); await git(contextSource, 'clone', '-q', '-b', 'main', canonical, '.');
  const context = await readFile(join(contextSource, 'shared.txt'), 'utf8');
  await writeFile(join(contextSource, 'shared.txt'), context.replace('line-5\n', 'line-5-canonical\n'));
  await git(contextSource, 'add', 'shared.txt'); await git(contextSource, 'commit', '-qm', 'change nearby context');
  const contextOid = await git(contextSource, 'rev-parse', 'HEAD');
  const sharedAllowed = join(dir, 'shared-allowed.txt'); await writeFile(sharedAllowed, 'shared.txt\n');
  const contextEvidence = join(dir, 'context-review.txt');
  await writeFile(contextEvidence, `# ✅ APPROVED FOR MERGE — head ${contextOid}\nAPPROVED for merge\n`);
  const contextLand = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land',
    '--repo', 'landdemo', '--source', contextSource, '--commit', contextOid, '--intent-key', 'context-task',
    '--intent', 'Update shared context', '--allowed-files', sharedAllowed, '--review-evidence', contextEvidence,
    '--wait-seconds', '150', '--json'], { cwd: root, env: landEnv, timeout: 155_000 }));
  expect(contextLand.stdout).toContain('"state":"landed"');

  const changedEvidence = republishCases[2];
  const originalEvidence = await readFile(changedEvidence.review, 'utf8');
  const rejectingEvidence = `# ✅ APPROVED FOR MERGE — head ${changedEvidence.reviewedHead}\nREQUEST CHANGES\n`;
  expect(approvedHead(rejectingEvidence, changedEvidence.reviewedHead)).toBe(false);
  const changedEvidenceArgs = ['--repo', 'landdemo', '--source', changedEvidence.checkout, '--commit', changedEvidence.head,
    '--intent-key', changedEvidence.intent, '--intent', `Republish ${changedEvidence.file}`,
    '--allowed-files', changedEvidence.paths, '--review-evidence', changedEvidence.review, '--wait-seconds', '150', '--json'];
  let replacedDuringInspection = false;
  const changedEvidenceResult = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...changedEvidenceArgs],
    { cwd: root, env: landEnv, timeout: 155_000 }), async job => {
    if (job.kind === 'inspect-candidate' && !replacedDuringInspection) {
      await writeFile(changedEvidence.review, rejectingEvidence);
      replacedDuringInspection = true;
    }
  });
  expect(replacedDuringInspection).toBe(true);
  expect(changedEvidenceResult.stdout).toContain('"state":"landed"');
  const changedEvidenceChange = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === changedEvidence.intent);
  expect(changedEvidenceChange.revision).toBe(2);
  expect(changedEvidenceChange.headOid).not.toBe(changedEvidence.reviewedHead);
  const changedEvidenceVerdicts = await api(`/changes/${changedEvidenceChange.changeId}/verdicts`);
  expect(changedEvidenceVerdicts.data.items.at(-1)).toMatchObject({
    carriedFrom: { sourceOid: changedEvidence.reviewedHead, method: 'patch-id' },
    evidenceDigest: `sha256:${createHash('sha256').update(originalEvidence).digest('hex')}`,
  });

  const unchanged = republishCases[0];
  const unchangedArgs = ['--repo', 'landdemo', '--source', unchanged.checkout, '--commit', unchanged.head,
    '--intent-key', unchanged.intent, '--intent', `Republish ${unchanged.file}`, '--allowed-files', unchanged.paths,
    '--review-evidence', unchanged.review, '--wait-seconds', '150', '--json'];
  const republished = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...unchangedArgs],
    { cwd: root, env: landEnv, timeout: 155_000 }));
  const republishedEvents = republished.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(republishedEvents.at(-1).state).toBe('landed');
  expect(republishedEvents.find(item => item.state === 'review-carried')).toMatchObject({
    sourceOid: unchanged.reviewedHead, publishedOid: expect.stringMatching(/^[a-f0-9]{40}$/) });
  const unchangedChange = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === unchanged.intent);
  expect(unchangedChange.revision).toBe(2);
  const unchangedVerdicts = await api(`/changes/${unchangedChange.changeId}/verdicts`);
  expect(unchangedVerdicts.data.items.at(-1).carriedFrom).toEqual({ sourceOid: unchanged.reviewedHead, method: 'patch-id' });

  const altered = republishCases[1];
  const alteredSource = await temp(); await git(alteredSource, 'clone', '-q', '-b', 'main', canonical, '.');
  await writeFile(join(alteredSource, altered.file), `${altered.file}=different-patch\n`);
  await git(alteredSource, 'add', altered.file); await git(alteredSource, 'commit', '-qm', 'different patch');
  const alteredHead = await git(alteredSource, 'rev-parse', 'HEAD');
  const alteredArgs = ['--repo', 'landdemo', '--source', alteredSource, '--commit', alteredHead,
    '--intent-key', altered.intent, '--intent', `Republish ${altered.file}`, '--allowed-files', altered.paths,
    '--review-evidence', altered.review, '--wait-seconds', '150', '--json'];
  const refusal = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...alteredArgs],
    { cwd: root, env: landEnv, timeout: 155_000 }).then(() => null, error => error as { code: number; stderr: string }));
  expect(refusal).toMatchObject({ code: 2 });
  const alteredChange = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === altered.intent);
  expect(alteredChange.revision).toBe(2);
  expect(refusal?.stderr).toContain(altered.reviewedHead);
  expect(refusal?.stderr).toContain(alteredChange.headOid);
  expect((await api(`/changes/${alteredChange.changeId}/verdicts`)).data.items).toEqual([]);
  // A refused land keeps the change's leases so its author can repair the refusal. This author abandons the
  // change instead, as a real agent would, so the later parallel landing can lease b.txt.
  expect((await api('/leases')).data.items).toContainEqual(expect.objectContaining({
    changeId: alteredChange.changeId, unitKey: `file:${altered.file}`, state: 'active' }));
  const abandoned = await execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'release', '--repo', 'landdemo',
    '--intent-key', altered.intent, '--json'], { cwd: root, env: authorEnv, timeout: 30_000 });
  expect(JSON.parse(abandoned.stdout)).toEqual({ changeId: alteredChange.changeId, released: [`file:${altered.file}`] });
  expect((await api('/leases')).data.items).not.toContainEqual(expect.objectContaining({
    unitKey: `file:${altered.file}`, state: 'active' }));
  const staleContext = await temp(); await git(staleContext, 'clone', '-q', '-b', 'main', seed, '.');
  const stale = await readFile(join(staleContext, 'shared.txt'), 'utf8');
  await writeFile(join(staleContext, 'shared.txt'), stale.replace('line-7\n', 'line-7-source\n'));
  await git(staleContext, 'add', 'shared.txt'); await git(staleContext, 'commit', '-qm', 'old-context patch');
  const staleOid = await git(staleContext, 'rev-parse', 'HEAD');
  const staleEvidence = join(dir, 'stale-review.txt');
  await writeFile(staleEvidence, `# ✅ APPROVED FOR MERGE — head ${staleOid}\nAPPROVED for merge\n`);
  const staleArgs = ['--repo', 'landdemo', '--source', staleContext, '--commit', staleOid,
    '--intent-key', 'stale-context-task', '--intent', 'Update nearby line', '--allowed-files', sharedAllowed,
    '--review-evidence', staleEvidence, '--wait-seconds', '150', '--json'];
  await drive(expect(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...staleArgs],
    { cwd: root, env: landEnv, timeout: 155_000 })).rejects.toMatchObject({ code: 2,
    stderr: expect.stringContaining('exact published head SHA') }));
  const staleChange = (await api('/snapshot')).data.projections.repos.changes.find((item: any) => item.intentKey === 'stale-context-task');
  const staleCandidate = join(dir, 'bridge', `${staleChange.candidateStorageName}.git`);
  expect((await filesChanged(staleCandidate, staleChange.headOid)).files).toEqual(['shared.txt']);
  expect(await patchId(staleContext, staleOid)).not.toBe(await patchId(staleCandidate, staleChange.headOid));
  const parallel = await Promise.all(['a.txt', 'b.txt'].map(async (file, index) => {
    const checkout = await temp(); await git(checkout, 'clone', '-q', '-b', 'main', canonical, '.');
    await writeFile(join(checkout, file), `${file}=parallel\n`);
    await git(checkout, 'add', file); await git(checkout, 'commit', '-qm', `parallel ${file}`);
    const oid = await git(checkout, 'rev-parse', 'HEAD');
    const paths = join(dir, `allowed-parallel-${index}.txt`); await writeFile(paths, `${file}\n`);
    const review = join(dir, `review-parallel-${index}.txt`); await writeFile(review, `# ✅ APPROVED FOR MERGE — head ${oid}\nAPPROVED for merge\n`);
    return { args: ['--repo', 'landdemo', '--source', checkout, '--commit', oid, '--intent-key', `parallel-${index}`,
      '--intent', `Update ${file}`, '--allowed-files', paths, '--wait-seconds', '150', '--json'], review,
      env: { ...environment, CONCORD_TOKEN: index ? 'local-agent-c' : 'local-agent-b', CONCORD_REVIEWER_TOKEN: 'local-reviewer' } };
  }));
  const inspected = await drive(Promise.all(parallel.map(item => execFile(process.execPath,
    ['--import', 'tsx', 'cli/main.ts', 'land', ...item.args], { cwd: root, env: item.env, timeout: 155_000 }))));
  for (const item of inspected) expect(item.stdout).toContain('"state":"awaiting-review"');
  const attemptOutcomes: Array<{ result: Awaited<ReturnType<typeof execFile>> } | { error: Error & { stdout?: string; stderr?: string } } | undefined> = [];
  const stderrTails = parallel.map(() => '');
  const startAttempt = (index: number) => new Promise<NonNullable<typeof attemptOutcomes[number]>>(resolveAttempt => {
    const item = parallel[index];
    callback(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...item.args, '--review-evidence', item.review],
      { cwd: root, env: item.env, timeout: 155_000 }, (error, stdout, stderr) => {
        const outcome = error
          ? { error: Object.assign(error, { stdout, stderr }) as Error & { stdout?: string; stderr?: string } }
          : { result: { stdout, stderr } as Awaited<ReturnType<typeof execFile>> };
        attemptOutcomes[index] = outcome;
        resolveAttempt(outcome);
      }).stderr?.on('data', part => { stderrTails[index] = (stderrTails[index] + part.toString()).slice(-6000); });
  });
  const firstAttempt = startAttempt(0);
  const firstQueueDeadline = Date.now() + 45_000;
  let firstSelected = false;
  while (Date.now() < firstQueueDeadline) {
    const snapshot = await api('/snapshot').catch(() => null);
    const changeId = snapshot?.data?.projections?.repos?.changes?.find((change: any) => change.intentKey === 'parallel-0')?.changeId;
    const queue = await api('/queue').catch(() => null);
    if (changeId && queue?.data?.activeStackJobId && queue.data.entries?.some((entry: any) =>
      entry.changeId === changeId && entry.state === 'checking')) {
      firstSelected = true;
      break;
    }
    const earlyExit = attemptOutcomes[0];
    if (earlyExit && 'error' in earlyExit) {
      throw new Error(`first land child exited before queue selection: ${earlyExit.error.message}\nstderr tail:\n${stderrTails[0]}`);
    }
    await new Promise(done => setTimeout(done, 150));
  }
  expect(firstSelected, `first queue entry was not selected within 45s\nstderr tail:\n${stderrTails[0]}`).toBe(true);
  const secondAttempt = startAttempt(1);
  const secondQueueDeadline = Date.now() + 45_000;
  let secondAdmitted = false;
  while (Date.now() < secondQueueDeadline) {
    const snapshot = await api('/snapshot').catch(() => null);
    const changeId = snapshot?.data?.projections?.repos?.changes?.find((change: any) => change.intentKey === 'parallel-1')?.changeId;
    const queue = await api('/queue').catch(() => null);
    // Admission bumps the queue, so two seconds later the coalesce alarm may select the entry into its own
    // stack. A poll stalled past that window sees checking, which still means admitted.
    if (changeId && queue?.data?.entries?.some((entry: any) => entry.changeId === changeId && ['reserved', 'checking'].includes(entry.state))) {
      secondAdmitted = true;
      break;
    }
    const earlyExit = attemptOutcomes[1];
    if (earlyExit && 'error' in earlyExit) {
      throw new Error(`second land child exited before enqueue: ${earlyExit.error.message}\nstderr tail:\n${stderrTails[1]}`);
    }
    await new Promise(done => setTimeout(done, 150));
  }
  expect(secondAdmitted, `second queue entry was not admitted within 45s\nstderr tail:\n${stderrTails[1]}`).toBe(true);
  const attemptsWork = drive(Promise.all([firstAttempt, secondAttempt]));
  void attemptsWork.catch(() => {});
  let staleMainBlocked = false;
  const blockedDeadline = Date.now() + 150_000;
  while (Date.now() < blockedDeadline) {
    const queue = await api('/queue').catch(() => null);
    if (queue?.data?.entries?.some((entry: any) => entry.state === 'blocked' && entry.blockedReason === 'STALE_MAIN') ||
      stderrTails.some(output => output.includes('QUEUE_BLOCKED: STALE_MAIN'))) {
      staleMainBlocked = true;
      break;
    }
    const earlyExit = attemptOutcomes.find((attempt): attempt is { error: Error & { stdout?: string; stderr?: string } } =>
      attempt !== undefined && 'error' in attempt);
    if (earlyExit) {
      const stderrTail = stderrTails[attemptOutcomes.indexOf(earlyExit)] || (earlyExit.error.stderr ?? '').slice(-6000);
      throw new Error(`land child exited before queue showed STALE_MAIN: ${earlyExit.error.message}\nstderr tail:\n${stderrTail}`);
    }
    await new Promise(done => setTimeout(done, 150));
  }
  expect(staleMainBlocked, `queue did not become observably blocked with STALE_MAIN within 150s\nstderr tails:\n${stderrTails.join('\n--- child ---\n')}`).toBe(true);
  const attempts = await attemptsWork;
  const merged = [];
  for (const [index, attempt] of attempts.entries()) {
    if ('result' in attempt) { merged.push(attempt.result); continue; }
    // execFile settles only after the child exits (or its 155s timeout); inspect both streams
    // because the CLI diagnostic and Node warnings may be written to different streams.
    const output = withoutNodeDeprecationWarnings([attempt.error.stdout, attempt.error.stderr].filter(Boolean).join('\n'));
    expect(output, attempt.error.message).toContain('QUEUE_BLOCKED: STALE_MAIN');
    const item = parallel[index];
    const retryArgs = [...item.args]; retryArgs[retryArgs.indexOf('--intent-key') + 1] += '-retry';
    merged.push(await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land',
      ...retryArgs, '--review-evidence', item.review], { cwd: root, env: item.env, timeout: 155_000 })));
  }
  for (const item of merged) expect(item.stdout).toContain('"state":"landed"');
  expect((await api('')).data.observedCanonicalOid).toMatch(/^[a-f0-9]{40}$/);
  const sameFile = await Promise.all([1, 18].map(async (line, index) => {
    const checkout = await temp(); await git(checkout, 'clone', '-q', '-b', 'main', canonical, '.');
    const text = await readFile(join(checkout, 'shared.txt'), 'utf8');
    await writeFile(join(checkout, 'shared.txt'), text.replace(`line-${line}\n`, `line-${line}-changed\n`));
    await git(checkout, 'add', 'shared.txt'); await git(checkout, 'commit', '-qm', `same file ${index}`);
    const oid = await git(checkout, 'rev-parse', 'HEAD');
    const paths = join(dir, `allowed-shared-${index}.txt`); await writeFile(paths, 'shared.txt\n');
    const review = join(dir, `review-shared-${index}.txt`); await writeFile(review, `# ✅ APPROVED FOR MERGE — head ${oid}\nAPPROVED for merge\n`);
    return { args: ['--repo', 'landdemo', '--source', checkout, '--commit', oid, '--intent-key', `shared-${index}`,
      '--intent', `Edit shared line ${line}`, '--allowed-files', paths, '--wait-seconds', '150', '--json'], review,
      env: { ...environment, CONCORD_TOKEN: index ? 'local-agent-c' : 'local-agent-b', CONCORD_REVIEWER_TOKEN: 'local-reviewer' } };
  }));
  const firstShared = execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...sameFile[0].args,
    '--review-evidence', sameFile[0].review], { cwd: root, env: sameFile[0].env, timeout: 155_000 });
  await waitFor(async () => (await api('/leases')).data.items.some((item: any) =>
    item.unitKey === 'file:shared.txt' && item.state === 'active'));
  const secondShared = execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land', ...sameFile[1].args],
    { cwd: root, env: sameFile[1].env, timeout: 155_000 });
  const [firstResult, secondResult] = await drive(Promise.all([firstShared, secondShared]));
  expect(firstResult.stdout).toContain('"state":"landed"');
  expect(secondResult.stdout).toContain('"state":"LEASE_CONFLICT"');
  expect(secondResult.stdout).toContain('Edit shared line 1');
  const secondEvents = secondResult.stdout.trim().split('\n').map(line => JSON.parse(line));
  const approved = secondEvents.find(item => item.state === 'awaiting-review');
  expect(approved.headOid).toMatch(/^[a-f0-9]{40}$/);
  await writeFile(sameFile[1].review, `# ✅ APPROVED FOR MERGE — head ${approved.headOid}\nAPPROVED for merge\n`);
  const secondLanded = await drive(execFile(process.execPath, ['--import', 'tsx', 'cli/main.ts', 'land',
    ...sameFile[1].args, '--review-evidence', sameFile[1].review],
  { cwd: root, env: sameFile[1].env, timeout: 155_000 }));
  expect(secondLanded.stdout).toContain('"state":"landed"');
}, 360_000);

import type { DeltaCheckJob, DeltaResult, Digest, ModuleContext, ReviewManifest, TrustedPolicy, TrustedProfile, Verdict } from '../../src/contracts';
import { dependencyScopeDigest, hashCanonical, manifestDigest } from '../../src/verdicts/manifest';
import { verdicts } from '../../src/features/verdicts';

const oid = (character: string) => character.repeat(40);
const d = (value: string): Digest => hashCanonical(value);

it('drops patch-id provenance when an approval is later carried by a delta check', async () => {
  const policy: TrustedPolicy = { id: 'demo', version: 1, digest: d('policy'), checkerId: 'checker',
    checkerDigest: d('checker'), acceptance: { kind: 'hard-gates', gates: [{ id: 'check', requiredOutcome: 'PASS' }] },
    units: { 'file:a.txt': { canonicalKey: 'file:a.txt', file: 'a.txt', resources: [], dependencyKeys: [] } } };
  const profile: TrustedProfile = { id: 'demo', digest: d('profile'), oracleDigest: d('oracle'),
    toolchainDigest: d('toolchain'), environmentDigest: d('environment'), timeoutMs: 1000, maxOutputBytes: 1024 };
  const manifest: ReviewManifest = { changedUnits: [{ unitKey: 'file:a.txt', beforePath: 'a.txt', afterPath: 'a.txt',
    beforeMode: '100644', afterMode: '100644', beforeDigest: d('before'), afterDigest: d('after') }],
    policyVersion: policy.version, policyDigest: policy.digest, checkerDigest: policy.checkerDigest,
    oracleDigest: profile.oracleDigest, toolchainDigest: profile.toolchainDigest, coverage: 'complete', dependencyScope: [] };
  const manifestHash = manifestDigest(manifest, policy, ['file:a.txt']);
  const values = new Map<string, unknown>();
  const jobs: DeltaCheckJob[] = [];
  let version = 0;
  let revision = 1;
  let baseOid = oid('0');
  let headOid = oid('a');
  const candidate = () => ({ changeId: 'change', revision, baseOid, headOid, storageName: 'candidate', ref: 'refs/heads/work' });
  const installInspection = () => values.set('inspection:change', { changeId: 'change', revision, candidate: candidate(),
    canonicalStorageName: 'canonical', policyId: 'demo', profileId: 'demo', reviewManifest: manifest,
    reviewManifestDigest: manifestHash, outcome: 'PASS' });
  installInspection();
  const context = { repoId: 'repo', tenantId: 'local',
    principal: { tenantId: 'local', principalId: 'reviewer', roles: ['reviewer'], repoIds: '*', expiresAt: Infinity },
    trusted: { policies: { demo: policy }, profiles: { demo: profile } }, now: () => 100,
    storage: { resolveRef: async () => baseOid, info: async (name: string) => ({ name, remote: `https://example.test/${name}`, status: 'ready' }) },
    state: { get: <T>(key: string) => (values.get(key) ?? null) as T | null,
      put: <T>(key: string, value: T) => { values.set(key, value); }, delete: (key: string) => { values.delete(key); } },
    version: () => version, nextVersion: () => ++version,
    appendEvent: (_kind: string, _ids: string[], _payload: Record<string, unknown>, eventVersion: number) => ({ sequence: eventVersion }),
    readChange: () => ({ status: 'eligible', version, evidenceIds: ['change'], value: {
      authorId: 'author', headOid, revision, status: 'ready', unitKeys: ['file:a.txt'], frozen: false } }),
    call: (name: string, ...args: unknown[]) => {
      if (name === 'findings.gate') return { status: 'eligible', version, evidenceIds: [], value: {
        findingSetVersion: 0, unresolvedIds: [], pendingRound: null } };
      if (name === 'runners.schedule') { jobs.push(args[0] as DeltaCheckJob); return { status: 'eligible', version,
        evidenceIds: [], value: { jobId: (args[0] as DeltaCheckJob).jobId } }; }
      throw new Error(`unexpected hook ${name}`);
    },
  } as unknown as ModuleContext;
  const post = async (path: 'verdicts' | 'carry', body: Record<string, unknown>) => {
    const pathname = `/v1/repos/repo/changes/change/${path}`;
    const route = verdicts.routes.find(item => item.method === 'POST' && item.pattern.test(pathname))!;
    return route.handle(context, new Request(`https://concord.test${pathname}`, { method: 'POST' }),
      pathname.match(route.pattern)!, body);
  };
  const provenance = { sourceOid: oid('c'), method: 'patch-id' };
  const approval = await post('verdicts', { revision: 1, findingSetVersion: 0, reviewManifestDigest: manifestHash,
    decision: 'approve', evidenceDigest: d('review'), carriedFrom: provenance });
  expect(approval.status).toBe(201);
  const parent = (await approval.json() as { data: Verdict }).data;
  expect(parent.carriedFrom).toEqual(provenance);

  revision = 2; baseOid = oid('1'); headOid = oid('b'); installInspection();
  const scheduled = await post('carry', { parentVerdictId: parent.verdictId, revision, newBaseOid: baseOid });
  expect(scheduled.status).toBe(202);
  const job = jobs[0];
  const preimage = { kind: 'delta-check' as const, jobId: job.jobId, attempt: 1, fence: 1,
    inputDigest: job.inputDigest, sourceTreeOid: oid('e'), checkerDigest: job.checkerDigest,
    toolchainDigest: job.toolchainDigest, oracleDigest: job.oracleDigest, environmentDigest: job.environmentDigest,
    durationMs: 1, log: '', outcome: 'PASS' as const, reviewManifestDigest: manifestHash,
    reviewManifest: manifest, dependencyScopeDigest: dependencyScopeDigest([]), dependencyScope: [] };
  const result: DeltaResult = { ...preimage, resultDigest: hashCanonical(preimage) };
  const carried = verdicts.hooks['verdicts.evaluateCarry']!(context, result);
  expect(carried.status).toBe('eligible');
  if (carried.status !== 'eligible') return;
  const child = values.get(`verdict:${carried.value.verdictId}`) as Verdict;
  expect(child).toMatchObject({ parentVerdictId: parent.verdictId, deltaResultId: job.jobId, revision: 2 });
  expect(child).not.toHaveProperty('carriedFrom');
  expect(values.get(`verdict:${parent.verdictId}`)).toEqual(parent);
});
