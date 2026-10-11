import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { wranglerStateDir } from '../../demo/scenarios';

const execFile = promisify(execFileCallback);
const cwd = realpathSync(resolve('.'));
const wrangler = join(cwd, 'node_modules/.bin/wrangler');
const children: ChildProcess[] = [];
const dirs: string[] = [];

async function externalTempDir(prefix: string): Promise<string> {
  for (const base of [tmpdir(), join(cwd, '..', 'sandbox-home', 'tmp'), '/tmp']) {
    if (!relative(cwd, resolve(base)).startsWith('..')) continue;
    try {
      const dir = await mkdtemp(join(base, prefix));
      dirs.push(dir);
      return dir;
    } catch (error) {
      if (!['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('No writable temporary directory outside the clone');
}

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const value = server.address();
  if (!value || typeof value === 'string') throw new Error('PORT_UNAVAILABLE');
  await new Promise<void>(done => server.close(() => done()));
  return value.port;
}
function start(file: string, args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + chunk.toString()).slice(-10_000); });
  return { child, output: () => output };
}
async function waitFor(label: string, predicate: () => Promise<boolean>, output: () => string): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (await predicate().catch(() => false)) return;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`TIMEOUT ${label}: ${output()}`);
}
async function demo(args: string[], env: NodeJS.ProcessEnv): Promise<any> {
  const { stdout } = await execFile(process.execPath, ['--import', 'tsx', 'demo/main.ts', ...args], { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
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
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('dispatch-lab local acceptance', () => {
  it('runs remote target through a production-style local Worker with provisioned principals', async () => {
    const dir = await externalTempDir('concord-demo-remote-');
    const bridgePort = await port();
    const workerPort = await port();
    const bridgeToken = 'local-bridge-fixture-remote';
    const url = `http://127.0.0.1:${workerPort}`;
    const env = { ...process.env, TMPDIR: dir, XDG_CONFIG_HOME: dir, CONCORD_RUN_DIR: dir,
      CONCORD_URL: url, CONCORD_SHOW_DECOMPILED_C: '0' };
    await demo(['preflight', '--local', '--state-dir', dir], env);
    const privateFiles = await demo(['provision', '--out-dir', join(dir, 'private')], env);
    const tokens = JSON.parse(await readFile(privateFiles.tokensFile, 'utf8')) as Record<string, string>;
    expect(tokens.owner).not.toMatch(/^local-/);
    const trusted = (await readFile(join(dir, 'trusted-config.json'), 'utf8')).trim();
    const auth = (await readFile(privateFiles.authTokensFile, 'utf8')).trim();
    const bridge = start(process.execPath, ['--import', 'tsx', 'local/git-bridge.ts'], { ...env,
      CONCORD_BRIDGE_DATA_DIR: join(dir, 'bridge'), CONCORD_BRIDGE_TOKEN: bridgeToken, CONCORD_BRIDGE_PORT: String(bridgePort) });
    await waitFor('bridge', async () => bridge.output().includes(`listening on 127.0.0.1:${bridgePort}`), bridge.output);
    const worker = start(wrangler, ['dev', '--config', 'wrangler.local.jsonc', '--port', String(workerPort),
      '--persist-to', wranglerStateDir(dir), '--var', 'STORAGE_BACKEND:bridge',
      '--var', `BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=${bridgeToken}`,
      '--var', `TRUSTED_CONFIG:${trusted}`, '--var', `AUTH_TOKENS:${auth}`], { ...env, WRANGLER_SEND_METRICS: 'false' });
    await waitFor('Worker health', async () => (await fetch(url + '/health')).ok, worker.output);
    const flags = ['--target', 'remote', '--url', url, '--tokens-file', privateFiles.tokensFile,
      '--run', 'remote', '--state-dir', dir];
    await expect(demo(['seed', ...flags, '--pump-local'], env)).rejects.toThrow('PUMP_LOCAL_FORBIDDEN_IN_REMOTE_MODE');
    const seeded = await demo(['seed', ...flags], env);
    expect(seeded.canonicalOid).toMatch(/^[a-f0-9]{40}$/);
    for (const name of ['context', 'leases', 'stack']) {
      const result = await demo(['scene', name, ...flags], env);
      expect(result.scene).toBe(name);
    }
    const inspected = await demo(['inspect', ...flags, '--json'], env);
    expect(inspected.scenes).toEqual(expect.arrayContaining(['seed', 'context', 'leases', 'stack']));
    expect(inspected.audit.some((item: any) => item.jobId)).toBe(true);
  }, 180_000);

  it('resolves Wrangler state under the physical checkout through a symlink', async () => {
    const root = await externalTempDir('concord-demo-link-');
    const linked = join(root, 'checkout');
    await symlink(cwd, linked, 'dir');
    const stateDir = join(root, 'run');
    const moduleUrl = pathToFileURL(join(linked, 'demo/scenarios.ts')).href;
    const script = `import { wranglerStateDir } from ${JSON.stringify(moduleUrl)}; console.log(wranglerStateDir(${JSON.stringify(stateDir)}));`;
    const { stdout } = await execFile(process.execPath,
      ['--preserve-symlinks', '--import', 'tsx', '--input-type=module', '-e', script], { cwd, timeout: 30_000 });
    expect(stdout.trim()).toBe(wranglerStateDir(stateDir));
    expect(stdout.trim().startsWith(join(cwd, '.wrangler', 'state') + '/')).toBe(true);
  });

  it('uses a distinct ignored Worker state path for each external demo run', async () => {
    const firstRun = await externalTempDir('concord-demo-path-');
    const secondRun = await externalTempDir('concord-demo-path-');
    expect(relative(cwd, firstRun).startsWith('..')).toBe(true);
    const firstState = wranglerStateDir(firstRun);
    expect(firstState.startsWith(join(cwd, '.wrangler', 'state') + '/')).toBe(true);
    expect(wranglerStateDir(secondRun)).not.toBe(firstState);
    const { stdout } = await execFile('git', ['check-ignore', firstState], { cwd });
    expect(stdout.trim()).toBe(firstState);
  });

  it('pins literal outputs and rejects malformed, unintended, and wrong executable results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concord-checker-'));
    dirs.push(dir);
    const source = join(cwd, 'demo/dispatch-lab');
    const { copyFile, writeFile } = await import('node:fs/promises');
    for (const name of ['families.tsv', 'dispatch.mjs']) await copyFile(join(source, name), join(dir, name));
    const check = async (caseId: string) => {
      const result = await execFile(process.execPath, ['demo/checker.mjs', '--repo', dir, '--unit', 'all', '--case', caseId],
        { cwd, timeout: 10_000 }).catch(error => ({ stdout: (error as { stdout?: string }).stdout ?? '' }));
      return JSON.parse(result.stdout);
    };
    expect((await check('seed')).outcome).toBe('PASS');
    const table = await readFile(join(dir, 'families.tsv'), 'utf8');
    await writeFile(join(dir, 'families.tsv'), table.replace('alpha\t1\t1000', 'alpha\t3\t1000'));
    expect((await check('seed')).outcome).toBe('FAIL');
    await writeFile(join(dir, 'families.tsv'), table.replace('gamma\t3\t1000', 'gamma\t0\t1000'));
    expect((await check('seed')).outcome).toBe('FAIL');
    await writeFile(join(dir, 'families.tsv'), table.replace('gamma\t3\t1000', 'gamma\t3\t1000\ngamma\t3\t1000'));
    expect((await check('seed')).outcome).toBe('FAIL');
    await writeFile(join(dir, 'families.tsv'), table.replace('gamma\t3\t1000\n', ''));
    expect((await check('seed')).outcome).toBe('FAIL');
    await writeFile(join(dir, 'families.tsv'), table.replace('gamma\t3\t1000', 'gamma\t6\t1000'));
    expect((await check('seed')).outcome).toBe('FAIL');
    await writeFile(join(dir, 'families.tsv'), table.replace('gamma\t3\t1000', 'gamma 3 1000'));
    expect((await check('seed')).outcome).toBe('FAIL');
    await writeFile(join(dir, 'families.tsv'), table);
    const executable = await readFile(join(dir, 'dispatch.mjs'), 'utf8');
    await writeFile(join(dir, 'dispatch.mjs'), executable.replace('return Number(cells[1]) * Number(cells[2]);',
      "return family === 'alpha' ? Math.min(5000, Number(cells[1]) * Number(cells[2]) + 250) : Number(cells[1]) * Number(cells[2]);"));
    expect((await check('seed')).log).toContain('Mismatch: alpha');
  });

  it('runs bridge, Worker, bounded runners, and scenario driver through all local barriers', async () => {
    const dir = await externalTempDir('concord-demo-');
    expect(relative(cwd, dir).startsWith('..')).toBe(true);
    const bridgePort = await port();
    const workerPort = await port();
    const bridgeToken = 'local-bridge-fixture-2026';
    const url = `http://127.0.0.1:${workerPort}`;
    const env = { ...process.env, TMPDIR: dir, XDG_CONFIG_HOME: dir, CONCORD_RUN_DIR: dir,
      CONCORD_URL: url, CONCORD_SHOW_DECOMPILED_C: '0' };
    const preflight = await demo(['preflight', '--local', '--state-dir', dir], env);
    expect(preflight.status).toBe('ready');
    const persistenceDir = wranglerStateDir(dir);
    expect(persistenceDir.startsWith(join(cwd, '.wrangler', 'state') + '/')).toBe(true);
    expect(preflight.workerCommand).toContain(`--persist-to ${persistenceDir}`);
    const trusted = (await readFile(join(dir, 'trusted-config.json'), 'utf8')).trim();
    const bridge = start(process.execPath, ['--import', 'tsx', 'local/git-bridge.ts'], { ...env, CONCORD_BRIDGE_DATA_DIR: join(dir, 'bridge'),
      CONCORD_BRIDGE_TOKEN: bridgeToken, CONCORD_BRIDGE_PORT: String(bridgePort) });
    await waitFor('bridge', async () => bridge.output().includes(`listening on 127.0.0.1:${bridgePort}`), bridge.output);
    const workerArgs = ['dev', '--config', 'wrangler.local.jsonc', '--port', String(workerPort),
      '--persist-to', persistenceDir, '--var', 'STORAGE_BACKEND:bridge',
      '--var', `BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=${bridgeToken}`,
      '--var', `TRUSTED_CONFIG:${trusted}`];
    expect(workerArgs[workerArgs.indexOf('--persist-to') + 1]).toBe(persistenceDir);
    const worker = start(wrangler, workerArgs, { ...env, WRANGLER_SEND_METRICS: 'false' });
    await waitFor('Worker health', async () => (await fetch(url + '/health')).ok, worker.output);
    expect((await (await fetch(url + '/health')).json() as any).data.storageBackend).toBe('bridge');
    const run = 'acceptance';
    const flags = ['--run', run, '--state-dir', dir, '--pump-local'];
    let seeded: any;
    try { seeded = await demo(['seed', ...flags], env); }
    catch (error) {
      const listed = await fetch(url + '/v1/repos', { headers: { authorization: 'Bearer local-owner' } }).then(value => value.text()).catch(() => 'unavailable');
      throw new Error(`${String(error)}\nREPOS: ${listed}\nWORKER: ${worker.output()}\nBRIDGE: ${bridge.output()}`);
    }
    expect(seeded.canonicalOid).toMatch(/^[a-f0-9]{40}$/);
    expect((await demo(['seed', ...flags], env)).canonicalOid).toBe(seeded.canonicalOid);
    const prefixedRun = await demo(['seed', '--run', 'dispatch_a', '--state-dir', dir, '--pump-local'], env);
    expect(prefixedRun.repoId).toBe('dispatch_dispatch_a');
    expect(prefixedRun.canonicalOid).toMatch(/^[a-f0-9]{40}$/);
    for (const name of ['context', 'leases', 'stack', 'isolate', 'negative', 'repair', 'carry', 'invalidate', 'contest', 'dedupe', 'aw']) {
      let result: any;
      try { result = await demo(['scene', name, ...(name === 'aw' ? flags.filter(flag => flag !== '--pump-local') : flags)], env); }
      catch (error) { throw new Error(`${name}: ${String(error)}\nWORKER: ${worker.output()}`); }
      expect(result.scene).toBe(name);
    }
    const inspected = await demo(['inspect', '--run', run, '--state-dir', dir, '--json'], env);
    expect(inspected.evidence.leases.refusal.code).toBe('LEASE_CONFLICT');
    expect(inspected.evidence.isolate.blocked.state).toBe('blocked');
    expect(inspected.evidence['wrong-exec'].declaredUnit).toBe('file:dispatch.mjs');
    expect(inspected.evidence['wrong-row'].checkerOutcomes).toContain('FAIL');
    expect(inspected.evidence.repair.incompleteStatus).toBe(409);
    expect(inspected.evidence.carry.derivedVerdictId).toBeTruthy();
    expect(inspected.evidence.invalidate.carried).toBe(false);
    expect(inspected.evidence.contest.scores.map((score: any) => score.score.matched).sort()).toEqual([2, 4]);
    expect(inspected.evidence.contest.winnerId).toBe(inspected.changes['J-high'].changeId);
    expect(inspected.evidence.dedupe).toMatchObject({ attempts: 7 });
    expect(new Set(inspected.evidence.dedupe.observedBases).size).toBe(2);
    expect(inspected.evidence.aw).toMatchObject({ attempts: 7, taskId: 'task-17', checkerOutcome: 'PASS', queueState: 'landed' });
    expect(new Set(inspected.evidence.aw.changeIds).size).toBe(1);
    expect(new Set(inspected.evidence.aw.observedBases).size).toBe(2);
    expect(inspected.evidence.aw.headOid).toMatch(/^[a-f0-9]{40}$/);
    expect(inspected.evidence.aw.headOid).not.toBe(inspected.evidence.aw.baseOid);
    expect(inspected.changes.AW.headOid).toBe(inspected.evidence.aw.headOid);
    expect(inspected.evidence.aw.leaseFences['row:families:gamma']).toBeGreaterThan(0);
    expect(inspected.evidence.aw.verdictId).toBeTruthy();
    expect(inspected.evidence.aw.canonicalOid).toBe(inspected.canonicalOid);
    expect(inspected.queue.entries.find((entry: any) => entry.changeId === inspected.evidence.aw.changeId)?.state).toBe('landed');
    expect(inspected.audit.some((event: any) => event.resultDigest && event.jobId)).toBe(true);
    expect(inspected.queue.finalCanonicalOid).toBe(inspected.canonicalOid);
  }, 300_000);
});
