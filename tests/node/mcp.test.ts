import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';
import { prepareLocal, wranglerStateDir, type Manifest } from '../../demo/scenarios.ts';
import type { ConcordClient } from '../../cli/client.ts';
import { callTool } from '../../mcp/tools.ts';

it('dispatches issue and milestone MCP tools with issue links', async () => {
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const client = { request: async (method: string, path: string, options?: unknown) => {
    calls.push({ method, path, options }); return { data: { items: [] }, version: 2 };
  } } as unknown as ConcordClient;
  await callTool(client, 'issue_create', { repoId: 'repo', title: 'Task', body: 'Spec', labels: ['inbox'] });
  await callTool(client, 'issue_get', { repoId: 'repo', issueNumber: 3 });
  await callTool(client, 'issue_list', { repoId: 'repo', state: 'open' });
  await callTool(client, 'issue_close', { repoId: 'repo', issueNumber: 3, reason: 'Done', expectedVersion: 7 });
  await callTool(client, 'milestone_list', { repoId: 'repo' });
  await callTool(client, 'change_create', { repoId: 'repo', intentKey: 'task', intentText: 'Task', baseOid: 'a', branch: 'task', unitKeys: [], issueNumber: 3 });
  expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
    'POST /repos/repo/issues', 'GET /repos/repo/issues/3', 'GET /repos/repo/issues?state=open',
    'POST /repos/repo/issues/3/close', 'GET /repos/repo/milestones', 'POST /repos/repo/changes',
  ]);
  expect((calls[3].options as { body: object; expectedVersion: number }).expectedVersion).toBe(7);
  expect((calls[5].options as { body: { issueNumber: number } }).body.issueNumber).toBe(3);
});

const execFile = promisify(execFileCallback);
const cwd = resolve('.');
const children: ChildProcess[] = [];
const transports: StdioClientTransport[] = [];
const dirs: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}
function start(file: string, args: string[], env: NodeJS.ProcessEnv): { output: () => string } {
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + chunk.toString()).slice(-10000); });
  return { output: () => output };
}
async function waitFor(test: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await test().catch(() => false)) return;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('Local stack did not become ready');
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(done => child.once('close', () => done()));
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([closed, new Promise<void>(done => setTimeout(done, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    await closed;
  }
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('runs the agent loop over stdio MCP against the local bridge and Worker without leaking tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concord-mcp-'));
  dirs.push(dir);
  const bridgePort = await freePort();
  const workerPort = await freePort();
  const url = `http://127.0.0.1:${workerPort}`;
  const bridgeToken = 'mcp-bridge-fixture-secret';
  const env = { ...process.env, TMPDIR: dir, XDG_CONFIG_HOME: dir, CONCORD_RUN_DIR: dir, CONCORD_URL: url, CONCORD_SHOW_DECOMPILED_C: '0' };
  const { trustedConfig } = await prepareLocal(dir);
  const bridge = start(process.execPath, ['--import', 'tsx', 'local/git-bridge.ts'], { ...env, CONCORD_BRIDGE_DATA_DIR: join(dir, 'bridge'), CONCORD_BRIDGE_TOKEN: bridgeToken, CONCORD_BRIDGE_PORT: String(bridgePort) });
  await waitFor(async () => bridge.output().includes(`listening on 127.0.0.1:${bridgePort}`));
  const worker = start(join(cwd, 'node_modules/.bin/wrangler'), ['dev', '--config', 'wrangler.local.jsonc', '--port', String(workerPort), '--persist-to', wranglerStateDir(dir), '--var', 'STORAGE_BACKEND:bridge', '--var', `BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=${bridgeToken}`, '--var', `TRUSTED_CONFIG:${trustedConfig}`], { ...env, WRANGLER_SEND_METRICS: 'false' });
  await waitFor(async () => (await fetch(url + '/health')).ok);
  const { stdout } = await execFile(process.execPath, ['--import', 'tsx', 'demo/main.ts', 'seed', '--run', 'mcp', '--state-dir', dir, '--pump-local'], { cwd, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const manifest = JSON.parse(await readFile((JSON.parse(stdout) as { manifestPath: string }).manifestPath, 'utf8')) as Manifest;
  const observed: string[] = [];
  async function mcp(token: string): Promise<{ client: Client; call: (name: string, args: Record<string, unknown>) => Promise<any> }> {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'mcp/server.ts'], cwd, env: { ...env, CONCORD_TOKEN: token } as Record<string, string>, stderr: 'pipe' });
    transports.push(transport);
    transport.stderr?.on('data', chunk => observed.push(chunk.toString()));
    const client = new Client({ name: 'concord-test', version: '1.0.0' });
    await client.connect(transport);
    return { client, call: async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      const raw = JSON.stringify(response);
      observed.push(raw);
      expect(response.isError, raw).not.toBe(true);
      return JSON.parse(((response as { content: Array<{ text: string }> }).content[0]).text);
    } };
  }
  const a = await mcp('local-agent-a');
  const b = await mcp('local-agent-b');
  const reviewer = await mcp('local-reviewer');
  const listed = await a.client.listTools();
  observed.push(JSON.stringify(listed));
  expect(listed.tools.map(item => item.name)).toContain('queue_enqueue');
  const repoId = manifest.repoId;
  const unit = 'row:families:alpha';
  const branch = 'refs/heads/mcp-fresh-alpha';
  const worktree = join(dir, 'fresh-checkout');
  await mkdir(worktree);
  await execFile('git', ['init', '--quiet', worktree]);
  const createArgs = { repoId, intentKey: 'mcp-fresh-alpha', intentText: 'Edit alpha through MCP', baseOid: manifest.canonicalOid, branch, unitKeys: [unit] };
  let created = await a.call('change_create', createArgs);
  await waitFor(async () => {
    if (created.data.provisioning.state === 'observed') return true;
    created = await a.call('change_create', createArgs);
    return created.data.provisioning.state === 'observed';
  });
  const changeId = created.data.changeId;
  const grant = await a.call('lease_claim', { repoId, changeId, unitKeys: [unit], intentText: 'A edits alpha' });
  const lease = grant.data.leases[0];
  expect(lease.fence).toBeGreaterThan(0);
  const checkout = await a.call('change_checkout', { repoId, changeId, worktree });
  expect(checkout.remote).toMatch(/^file:\/\//);
  expect(checkout.worktree).toBe(join(worktree, '.concord', 'changes', changeId));
  await a.call('change_checkout', { repoId, changeId, worktree });
  const { stdout: branchBeforePublish } = await execFile('git', ['ls-remote', '--heads', checkout.remote, branch]);
  expect(branchBeforePublish.trim()).toBe('');
  const existing = await a.call('change_checkout', { repoId, changeId: manifest.changes.A.changeId, worktree: manifest.changes.A.worktree });
  expect(existing.remote).toMatch(/^file:\/\//);
  const { stdout: existingHead } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: existing.worktree });
  expect(existingHead.trim()).toBe(manifest.changes.A.headOid);
  const { stdout: localBranch } = await execFile('git', ['symbolic-ref', 'HEAD'], { cwd: checkout.worktree });
  expect(localBranch.trim()).toBe(`refs/heads/concord/${changeId}/mcp-fresh-alpha`);
  const tablePath = join(checkout.worktree, 'families.tsv');
  const original = await readFile(tablePath, 'utf8');
  expect(original).toMatch(/^alpha\t/m);
  await writeFile(tablePath, original.replace(/^alpha\t[^\n]*/m, 'alpha\t2\t1000'));
  await execFile('git', ['add', '--', 'families.tsv'], { cwd: checkout.worktree });
  await execFile('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '-m', 'Tune alpha'], { cwd: checkout.worktree });
  const { stdout: aHead } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: checkout.worktree });
  const otherArgs = { ...createArgs, intentKey: 'mcp-fresh-beta', intentText: 'Edit beta through MCP', unitKeys: ['row:families:beta'] };
  let other = await b.call('change_create', otherArgs);
  await waitFor(async () => {
    if (other.data.provisioning.state === 'observed') return true;
    other = await b.call('change_create', otherArgs);
    return other.data.provisioning.state === 'observed';
  });
  const otherId = other.data.changeId;
  expect(otherId).not.toBe(changeId);
  const otherCheckout = await b.call('change_checkout', { repoId, changeId: otherId, worktree });
  const { stdout: otherBranch } = await execFile('git', ['symbolic-ref', 'HEAD'], { cwd: otherCheckout.worktree });
  const { stdout: otherHead } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: otherCheckout.worktree });
  expect(otherBranch.trim()).toBe(`refs/heads/concord/${otherId}/mcp-fresh-alpha`);
  expect(otherHead.trim()).toBe(manifest.canonicalOid);
  expect(otherHead.trim()).not.toBe(aHead.trim());
  const { stdout: restoredHead } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: checkout.worktree });
  expect(restoredHead.trim()).toBe(aHead.trim());
  const conflictResponse = await b.client.callTool({ name: 'lease_claim', arguments: { repoId, changeId: manifest.changes.X.changeId, unitKeys: [unit], intentText: 'X edits alpha' } });
  observed.push(JSON.stringify(conflictResponse));
  expect(conflictResponse.isError).not.toBe(true);
  const conflict = JSON.parse(((conflictResponse as { content: Array<{ text: string }> }).content[0]).text);
  expect(conflict.conflict).toBe(true);
  expect(conflict.error.details).toMatchObject({ holderId: 'agent-a', intentText: 'A edits alpha' });
  const published = await a.call('change_publish', { repoId, changeId, worktree, leaseFences: { [unit]: lease.fence } });
  expect(published.data.revision).toBeGreaterThan(0);
  const { stdout: runnerOutput } = await execFile(process.execPath, ['--import', 'tsx', 'runner/main.ts', '--repo', repoId, '--role', 'checker', '--once', '--profile', manifest.profilePath], { cwd, env: { ...env, CONCORD_TOKEN: 'local-checker', CONCORD_PROFILE_DIGEST: manifest.profileDigest }, timeout: 35000 });
  expect(runnerOutput).toContain('Completed 1 job(s)');
  const snapshot = await reviewer.call('repo_context', { repoId });
  const jobs = snapshot.data.projections.runners.jobs as Array<{ jobId: string; changeId: string; kind: string }>;
  const job = jobs.find(item => item.kind === 'inspect-candidate' && item.changeId === changeId);
  expect(job).toBeDefined();
  const inspection = await fetch(`${url}/v1/repos/${repoId}/jobs/${job!.jobId}/result`, { headers: { authorization: 'Bearer local-reviewer' } }).then(response => response.json()) as any;
  expect(inspection.data.result.outcome).toBe('PASS');
  const finding = await reviewer.call('findings_list', { repoId, changeId });
  const verdict = await reviewer.call('review_verdict_submit', { repoId, changeId, revision: published.data.revision, reviewManifestDigest: inspection.data.result.reviewManifestDigest, findingSetVersion: finding.data.findingSetVersion, decision: 'approve', evidenceDigest: `sha256:${'a'.repeat(64)}` });
  const queued = await a.call('queue_enqueue', { repoId, changeId, verdictId: verdict.data.verdictId, leaseFences: { [unit]: lease.fence } });
  expect(queued.data.changeId).toBe(changeId);
  await a.call('queue_status', { repoId });
  await a.call('events_since', { repoId, after: 0 });
  for (const secret of ['local-agent-a', 'local-agent-b', 'local-reviewer', bridgeToken]) expect(observed.join('\n')).not.toContain(secret);
  expect(worker.output()).not.toContain('local-agent-a');
}, 180000);

it('fetches an unreferenced canonical base through a symlinked workdir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concord-mcp-base-'));
  dirs.push(dir);
  const source = join(dir, 'source');
  const worktree = join(dir, 'worktree');
  const linkedWorktree = join(dir, 'linked-worktree');
  const canonical = join(dir, 'canonical.git');
  const fork = join(dir, 'fork.git');
  await Promise.all([mkdir(source), mkdir(worktree)]);
  await execFile('git', ['init', '--quiet', source]);
  await execFile('git', ['init', '--quiet', worktree]);
  await symlink(worktree, linkedWorktree, 'dir');
  await execFile('git', ['init', '--quiet', '--bare', canonical]);
  await execFile('git', ['init', '--quiet', '--bare', fork]);
  await writeFile(join(source, 'base.txt'), 'canonical base\n');
  await execFile('git', ['add', 'base.txt'], { cwd: source });
  await execFile('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '-m', 'Base'], { cwd: source });
  const { stdout: baseOid } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: source });
  await execFile('git', ['push', canonical, 'HEAD:refs/heads/temporary'], { cwd: source });
  await execFile('git', ['push', canonical, ':refs/heads/temporary'], { cwd: source });
  const requested: string[] = [];
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    request: async (_method: string, path: string, options?: { body?: { storageName: string } }) => {
      if (path.endsWith('/changes/change-b')) return { data: { candidateStorageName: 'fork', branch: 'refs/heads/same', baseOid: baseOid.trim(), headOid: null } };
      if (path.endsWith('/git-token')) {
        const storageName = options!.body!.storageName;
        requested.push(storageName);
        return { data: { remote: pathToFileURL(storageName === 'fork' ? fork : canonical).href, token: 'test-token' } };
      }
      return { data: { canonicalStorageName: 'canonical' }, version: 1 };
    },
  } as unknown as ConcordClient;
  const checkout = await callTool(client, 'change_checkout', { repoId: 'repo', changeId: 'change-b', worktree: linkedWorktree }) as { worktree: string };
  expect(checkout.worktree).toBe(join(linkedWorktree, '.concord', 'changes', 'change-b'));
  const repeated = await callTool(client, 'change_checkout', { repoId: 'repo', changeId: 'change-b', worktree: linkedWorktree }) as { worktree: string };
  expect(repeated.worktree).toBe(checkout.worktree);
  expect(requested).toEqual(['fork', 'canonical', 'fork']);
  const { stdout: head } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: join(worktree, '.concord', 'changes', 'change-b') });
  expect(head.trim()).toBe(baseOid.trim());
}, 30000);

it.each(['A then B', 'B then A'])('isolates same-named branches with an existing fork branch: %s publication', async order => {
  const dir = await mkdtemp(join(tmpdir(), 'concord-mcp-isolation-'));
  dirs.push(dir);
  const source = join(dir, 'source');
  const worktree = join(dir, 'worktree');
  const forks = { A: join(dir, 'a.git'), B: join(dir, 'b.git') };
  await Promise.all([mkdir(source), mkdir(worktree)]);
  await execFile('git', ['init', '--quiet', source]);
  await execFile('git', ['init', '--quiet', worktree]);
  for (const fork of Object.values(forks)) await execFile('git', ['init', '--quiet', '--bare', fork]);
  await writeFile(join(source, 'base.txt'), 'base\n');
  await execFile('git', ['add', 'base.txt'], { cwd: source });
  await execFile('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '-m', 'Base'], { cwd: source });
  const { stdout: baseOid } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: source });
  for (const fork of Object.values(forks)) await execFile('git', ['push', fork, 'HEAD:refs/heads/base'], { cwd: source });
  await writeFile(join(source, 'b.txt'), 'existing B\n');
  await execFile('git', ['add', 'b.txt'], { cwd: source });
  await execFile('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '-m', 'Existing B'], { cwd: source });
  const { stdout: existingBOid } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: source });
  await execFile('git', ['push', forks.B, 'HEAD:refs/heads/shared'], { cwd: source });
  const changes = { A: { candidateStorageName: 'A', branch: 'refs/heads/shared', baseOid: baseOid.trim(), headOid: null, authorId: 'agent-a', unitKeys: ['a'] }, B: { candidateStorageName: 'B', branch: 'refs/heads/shared', baseOid: baseOid.trim(), headOid: existingBOid.trim(), authorId: 'agent-b', unitKeys: ['b'] } };
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    request: async (_method: string, path: string, options?: { body?: { storageName?: string } }) => {
      if (path.endsWith('/changes/A')) return { data: changes.A, version: 1 };
      if (path.endsWith('/changes/B')) return { data: changes.B, version: 1 };
      if (path.endsWith('/git-token')) return { data: { remote: pathToFileURL(forks[options!.body!.storageName as 'A' | 'B']).href, token: 'test-token' } };
      if (path.endsWith('/publish')) return { data: { revision: 1 } };
      return { data: { canonicalStorageName: 'canonical' }, version: 1 };
    },
  } as unknown as ConcordClient;
  const checkout = async (id: 'A' | 'B') => callTool(client, 'change_checkout', { repoId: 'repo', changeId: id, worktree }) as Promise<{ worktree: string }>;
  const a = await checkout('A');
  await writeFile(join(a.worktree, 'a.txt'), 'A only\n');
  await execFile('git', ['add', 'a.txt'], { cwd: a.worktree });
  await execFile('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '-m', 'A change'], { cwd: a.worktree });
  const { stdout: aOid } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: a.worktree });
  const b = await checkout('B');
  expect(b.worktree).not.toBe(a.worktree);
  const { stdout: bStart } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: b.worktree });
  expect(bStart.trim()).toBe(existingBOid.trim());
  await writeFile(join(b.worktree, 'b.txt'), 'B only\n');
  await execFile('git', ['add', 'b.txt'], { cwd: b.worktree });
  await execFile('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '-m', 'B change'], { cwd: b.worktree });
  const { stdout: bOid } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: b.worktree });
  await checkout('A');
  await checkout('B');
  for (const id of order === 'A then B' ? ['A', 'B'] : ['B', 'A']) {
    await callTool(client, 'change_publish', { repoId: 'repo', changeId: id, worktree, leaseFences: { [id.toLowerCase()]: 1 } });
  }
  for (const [id, oid] of [['A', aOid], ['B', bOid]] as const) {
    const { stdout } = await execFile('git', ['ls-remote', '--heads', forks[id], 'shared']);
    expect(stdout.split('\t')[0]).toBe(oid.trim());
  }
  await expect(callTool(client, 'change_publish', { repoId: 'repo', changeId: 'B', worktree: a.worktree, leaseFences: { b: 1 } })).rejects.toThrow();
}, 30000);
