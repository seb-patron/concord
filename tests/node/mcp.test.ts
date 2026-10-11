import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  await a.call('change_checkout', { repoId, changeId, worktree });
  const { stdout: branchBeforePublish } = await execFile('git', ['ls-remote', '--heads', checkout.remote, branch]);
  expect(branchBeforePublish.trim()).toBe('');
  const existing = await a.call('change_checkout', { repoId, changeId: manifest.changes.A.changeId, worktree: manifest.changes.A.worktree });
  expect(existing.remote).toMatch(/^file:\/\//);
  const { stdout: existingHead } = await execFile('git', ['rev-parse', `refs/remotes/concord/${manifest.changes.A.changeId}/demo`], { cwd: manifest.changes.A.worktree });
  expect(existingHead.trim()).toBe(manifest.changes.A.headOid);
  const { stdout: localBranch } = await execFile('git', ['symbolic-ref', 'HEAD'], { cwd: worktree });
  expect(localBranch.trim()).toBe(`refs/heads/concord/${changeId}/mcp-fresh-alpha`);
  const tablePath = join(worktree, 'families.tsv');
  const original = await readFile(tablePath, 'utf8');
  expect(original).toMatch(/^alpha\t/m);
  await writeFile(tablePath, original.replace(/^alpha\t[^\n]*/m, 'alpha\t2\t1000'));
  await execFile('git', ['add', '--', 'families.tsv'], { cwd: worktree });
  await execFile('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '-m', 'Tune alpha'], { cwd: worktree });
  const { stdout: aHead } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  const otherArgs = { ...createArgs, intentKey: 'mcp-fresh-beta', intentText: 'Edit beta through MCP', unitKeys: ['row:families:beta'] };
  let other = await b.call('change_create', otherArgs);
  await waitFor(async () => {
    if (other.data.provisioning.state === 'observed') return true;
    other = await b.call('change_create', otherArgs);
    return other.data.provisioning.state === 'observed';
  });
  const otherId = other.data.changeId;
  expect(otherId).not.toBe(changeId);
  await b.call('change_checkout', { repoId, changeId: otherId, worktree });
  const { stdout: otherBranch } = await execFile('git', ['symbolic-ref', 'HEAD'], { cwd: worktree });
  const { stdout: otherHead } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  expect(otherBranch.trim()).toBe(`refs/heads/concord/${otherId}/mcp-fresh-alpha`);
  expect(otherHead.trim()).toBe(manifest.canonicalOid);
  expect(otherHead.trim()).not.toBe(aHead.trim());
  await execFile('git', ['switch', `concord/${changeId}/mcp-fresh-alpha`], { cwd: worktree });
  const { stdout: restoredHead } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
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

it('fetches an unreferenced canonical base when the candidate fork lacks it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concord-mcp-base-'));
  dirs.push(dir);
  const source = join(dir, 'source');
  const worktree = join(dir, 'worktree');
  const canonical = join(dir, 'canonical.git');
  const fork = join(dir, 'fork.git');
  await Promise.all([mkdir(source), mkdir(worktree)]);
  await execFile('git', ['init', '--quiet', source]);
  await execFile('git', ['init', '--quiet', worktree]);
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
  await callTool(client, 'change_checkout', { repoId: 'repo', changeId: 'change-b', worktree });
  expect(requested).toEqual(['fork', 'canonical']);
  const { stdout: head } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  expect(head.trim()).toBe(baseOid.trim());
}, 30000);
