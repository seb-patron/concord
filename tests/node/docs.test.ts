import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { wranglerStateDir } from '../../demo/scenarios';

const execFile = promisify(execFileCallback);
const cwd = realpathSync(resolve('.'));
const children: ChildProcess[] = [];
const directories: string[] = [];

function freshShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const fresh = { ...env };
  for (const key of Object.keys(fresh)) {
    if (key.startsWith('CONCORD_') || key === 'WRANGLER_SEND_METRICS') delete fresh[key];
  }
  return fresh;
}

async function externalTempDir(prefix: string): Promise<string> {
  for (const base of ['/tmp', join(cwd, '..', 'sandbox-home', 'tmp'), tmpdir()]) {
    if (!relative(cwd, resolve(base)).startsWith('..')) continue;
    try {
      const root = await mkdtemp(join(base, prefix));
      directories.push(root);
      return root;
    } catch (error) {
      if (!['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('No writable temporary directory outside the clone');
}

async function taggedBlocks(path: string, tag = '12c'): Promise<string[]> {
  const document = await readFile(join(cwd, path), 'utf8');
  const marker = `<!-- verified-by: ${tag} -->`;
  const blocks = [...document.matchAll(new RegExp(`${marker}\\s*\`\`\`sh\\n([\\s\\S]*?)\\n\`\`\``, 'g'))]
    .map(match => match[1]);
  expect(blocks).toHaveLength(document.split(marker).length - 1);
  return blocks;
}

function commandLines(block: string): { exports: string[]; commands: string[] } {
  const lines = block.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const exports = lines.filter(line => line.startsWith('export '));
  const commands = lines.filter(line => !line.startsWith('export ') && line !== 'cd "$(pwd -P)"');
  return { exports, commands };
}

async function capturedNpm(exports: string[], command: string, env: NodeJS.ProcessEnv): Promise<{ args: string[]; values: string[] }> {
  const script = [
    'npm() {',
    '  printf "ARG:%s\\n" "$@"',
    '  printf "ENV:%s\\n" "$CONCORD_BRIDGE_DATA_DIR" "$CONCORD_BRIDGE_TOKEN" "$CONCORD_BRIDGE_PORT" "$CONCORD_URL" "$CONCORD_TOKEN" "$WRANGLER_SEND_METRICS"',
    '}',
    ...exports, command,
  ].join('\n');
  const { stdout } = await execFile('sh', ['-c', script], { cwd, env });
  const lines = stdout.trimEnd().split('\n');
  return { args: lines.filter(line => line.startsWith('ARG:')).map(line => line.slice(4)),
    values: lines.filter(line => line.startsWith('ENV:')).map(line => line.slice(4)) };
}

async function run(command: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; data: any }> {
  const { stdout } = await execFile('sh', ['-c', command], { cwd, env, timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024 });
  const jsonAt = stdout.indexOf('{');
  if (jsonAt < 0) throw new Error(`No JSON output from ${command}: ${stdout}`);
  return { stdout, data: JSON.parse(stdout.slice(jsonAt)) };
}

function start(command: string, env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  const child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', chunk => { output = (output + chunk.toString()).slice(-12_000); });
  }
  return { child, output: () => output };
}

async function waitFor(label: string, predicate: () => Promise<boolean>, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`TIMEOUT ${label}: ${output()}`);
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
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('documented demo commands', () => {
  it('keeps every documented Wrangler dev command persistent inside the clone', async () => {
    async function markdownFiles(dir: string): Promise<string[]> {
      const entries = await readdir(join(cwd, dir), { withFileTypes: true });
      const nested = await Promise.all(entries.map(async entry => {
        const path = join(dir, entry.name);
        // Design records describe historical contracts, not runnable operator commands.
        if (path === 'docs/ARCHITECTURE.md' || path === 'docs/JUDGING.md' || path === 'docs/specs') return [];
        if (entry.isDirectory()) return markdownFiles(path);
        return entry.isFile() && path.endsWith('.md') ? [path] : [];
      }));
      return nested.flat();
    }

    const files = ['README.md', ...await markdownFiles('docs')];
    const checked: string[] = [];
    for (const file of files) {
      const document = await readFile(join(cwd, file), 'utf8');
      const lines = document.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/);
      for (const line of lines) {
        if (!/\b(?:npm\s+run\s+dev|(?:npx\s+)?wrangler\s+dev)\b/.test(line)) continue;
        checked.push(file);
        const value = /--persist-to\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(line)?.slice(1).find(Boolean);
        expect(value, `${file}: ${line}`).toBeDefined();
        const statePath = value === '$CONCORD_WRANGLER_STATE'
          ? /export CONCORD_WRANGLER_STATE="(\.wrangler\/state\/[^"\n]+)/.exec(document)?.[1]
          : value;
        expect(statePath, `${file}: ${line}`).toMatch(/^\.wrangler\/state\/[^\s]+/);
      }
    }
    expect(checked.sort()).toEqual(['README.md', 'docs/api-repos.md', 'docs/dev.md', 'docs/ui.md']);

    const guide = await readFile(join(cwd, 'docs/api-repos.md'), 'utf8');
    const bridgeWorker = /In a second terminal[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(guide)?.[1];
    expect(bridgeWorker).toBeDefined();
    const bridgeBlock = /## Local Git bridge[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(guide)?.[1];
    expect(bridgeBlock).toBeDefined();
    for (const suffix of ['first', 'second']) {
      const root = await externalTempDir(`concord-${suffix}-`);
      const env = { ...freshShellEnv(process.env), TMPDIR: root };
      const bridge = await capturedNpm([], bridgeBlock!, env);
      const worker = await capturedNpm([], bridgeWorker!, env);
      const runDir = join(root, 'concord-repos-01');
      const token = createHash('sha256').update(runDir + ':bridge').digest('hex');
      const hash = createHash('sha256').update(token).digest('hex').slice(0, 12);
      expect(bridge.args).toEqual(['run', 'git-bridge']);
      expect(bridge.values.slice(0, 3)).toEqual([join(runDir, 'bridge'), token, '8788']);
      expect(worker.args.slice(0, 5)).toEqual(['run', 'dev', '--', '--persist-to', `.wrangler/state/${hash}`]);
      expect(worker.args).toContain(`BRIDGE_URL:http://127.0.0.1:8788/?token=${token}`);
      expect(worker.values[1]).toBe(token);
      expect(resolve(cwd, worker.args[4])).toBe(join(cwd, '.wrangler', 'state', hash));
    }
    const missingToken = bridgeWorker!.replace(/^export CONCORD_BRIDGE_TOKEN=.*\n/m, '');
    await expect(capturedNpm([], missingToken, freshShellEnv(process.env))).rejects.toMatchObject({ stdout: '' });
  });

  it('keeps Wrangler persistence in the clone when TMPDIR is outside it', async () => {
    const root = await externalTempDir('concord-docs-paths-');
    const readme = await taggedBlocks('README.md');
    const demo = await taggedBlocks('docs/DEMO.md');
    const deploy = await taggedBlocks('docs/deploy.md');
    const blocks = [...readme, ...demo, ...deploy];
    const env = { ...freshShellEnv(process.env), TMPDIR: root };
    expect(relative(cwd, root).startsWith('..')).toBe(true);
    expect(readme).toHaveLength(5);
    for (const block of readme) expect(block).toContain('cd "$(pwd -P)"');
    for (const block of blocks) {
      expect((await capturedNpm([], block, env)).args.length).toBeGreaterThan(0);
    }
    const { stdout: runDir } = await execFile('sh', ['-c', `${commandLines(readme[1]).exports[0]}\nprintf '%s' "$CONCORD_RUN_DIR"`],
      { cwd, env });
    expect(isAbsolute(runDir)).toBe(true);
    expect(runDir).toBe(join(resolve(env.TMPDIR), 'concord-demo-01'));
    const firstDeploy = await capturedNpm([], commandLines(deploy[0]).commands[0], env);
    expect(firstDeploy.args).toEqual(['run', 'demo', '--', 'seed', '--run', 'demo-01', '--state-dir', runDir]);
    await mkdir(runDir);
    await writeFile(join(runDir, 'trusted-config.json'), '{}\n');

    const trusted = (await readFile(join(runDir, 'trusted-config.json'), 'utf8')).trim();
    const runHash = createHash('sha256').update(resolve(runDir)).digest('hex').slice(0, 12);
    const persistenceDir = join(cwd, '.wrangler', 'state', runHash);
    expect(wranglerStateDir(runDir)).toBe(persistenceDir);
    expect(relative(cwd, persistenceDir).startsWith('.wrangler/state/')).toBe(true);
    let workers = 0;
    let bridges = 0;
    let demos = 0;
    for (const block of blocks.slice(1)) {
      const { exports, commands } = commandLines(block);
      for (const command of commands) {
        const { args, values } = await capturedNpm(exports, command, env);
        if (args[1] === 'dev') {
          workers++;
          expect(args).toEqual(['run', 'dev', '--', '--persist-to', `.wrangler/state/${runHash}`,
            '--var', 'STORAGE_BACKEND:bridge', '--var', 'BRIDGE_URL:http://127.0.0.1:8788/?token=local-bridge-fixture-2026',
            '--var', `TRUSTED_CONFIG:${trusted}`]);
          expect(resolve(cwd, args[4])).toBe(persistenceDir);
          expect(values[5]).toBe('false');
        } else if (args[1] === 'git-bridge') {
          bridges++;
          expect(args).toEqual(['run', 'git-bridge']);
          expect(values.slice(0, 3)).toEqual([join(runDir, 'bridge'), 'local-bridge-fixture-2026', '8788']);
        } else {
          demos++;
          expect(args.slice(0, 3)).toEqual(['run', 'demo', '--']);
          if (args[3] !== 'preflight') {
            expect(values.slice(3, 5)).toEqual(['http://127.0.0.1:8787', 'local-owner']);
          }
          const stateFlags = args.flatMap((arg, index) => arg === '--state-dir' ? [args[index + 1]] : []);
          expect(stateFlags, command).toEqual([runDir]);
          expect(isAbsolute(stateFlags[0])).toBe(true);
          expect(stateFlags[0].startsWith(root + '/')).toBe(true);
        }
      }
    }
    expect([workers, bridges, demos]).toEqual([1, 1, 18]);

    const manual = /To run them manually,[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(await readFile(join(cwd, 'docs/DEMO.md'), 'utf8'))?.[1];
    expect(manual).toBeDefined();
    const runnerCommands = commandLines(manual!).commands;
    expect(runnerCommands).toHaveLength(2);
    const checker = await capturedNpm([], runnerCommands[0], { ...env, CONCORD_RUN_DIR: runDir });
    expect(checker.args).toEqual(['run', 'runner', '--', '--repo', 'REPO_ID', '--role', 'checker',
      '--profile', join(runDir, 'dispatch-profile.json'), '--once']);
    expect(checker.values.slice(3, 5)).toEqual(['http://127.0.0.1:8787', 'local-checker']);
    const promoter = await capturedNpm([], runnerCommands[1], { ...env, CONCORD_RUN_DIR: runDir });
    expect(promoter.args).toEqual(['run', 'runner', '--', '--repo', 'REPO_ID', '--role', 'promoter',
      '--profile-digest', 'PROFILE_DIGEST_FROM_PREFLIGHT', '--once']);
    expect(promoter.values.slice(3, 5)).toEqual(['http://127.0.0.1:8787', 'local-promoter']);

    const release = await readFile(join(cwd, 'docs/deploy.md'), 'utf8');
    const productionRunners = release.split('\n').filter(line => line.includes('npm run runner --'));
    expect(productionRunners).toHaveLength(2);
    const productionEnv = { ...env, CONCORD_REPO_ID: 'repo-id', CONCORD_HOME: join(root, 'operator'),
      CHECKER_TOKEN: 'checker-token', PROMOTER_TOKEN: 'promoter-token', PROFILE_DIGEST: 'profile-digest' };
    const productionChecker = await capturedNpm([], productionRunners[0], productionEnv);
    expect(productionChecker.args).toEqual(['run', 'runner', '--', '--repo', 'repo-id', '--role', 'checker',
      '--profile', join(root, 'operator', 'checker-profile.json'), '--once']);
    expect(productionChecker.values[4]).toBe('checker-token');
    const productionPromoter = await capturedNpm([], productionRunners[1], productionEnv);
    expect(productionPromoter.args).toEqual(['run', 'runner', '--', '--repo', 'repo-id', '--role', 'promoter',
      '--profile-digest', 'profile-digest', '--once']);
    expect(productionPromoter.values[4]).toBe('promoter-token');
  });

  it('runs every 12c-tagged local command against the real bridge and Worker', async () => {
    const root = await externalTempDir('concord-docs-');
    // tsx needs a short socket path. This relative TMPDIR resolves outside the clone.
    // Demo and runner need the absolute path for their candidate worktrees.
    const preload = join(root, 'restore-tmp.cjs');
    await writeFile(preload, "if (/(?:demo|runner)\\/main\\.ts$/.test(process.argv[1] ?? '')) process.env.TMPDIR = process.env.CONCORD_DOCS_ABS_TMPDIR;\n");
    const env = { ...freshShellEnv(process.env), TMPDIR: relative(cwd, root), XDG_CONFIG_HOME: root,
      CONCORD_DOCS_ABS_TMPDIR: root, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
    };
    const workerUrl = 'http://127.0.0.1:8787';
    expect(relative(cwd, resolve(env.TMPDIR)).startsWith('..')).toBe(true);
    const readme = await taggedBlocks('README.md');
    const demo = await taggedBlocks('docs/DEMO.md');
    const deploy = await taggedBlocks('docs/deploy.md');
    expect(readme).toHaveLength(5);
    expect(demo).toHaveLength(1);
    expect(deploy).toHaveLength(1);
    expect(demo[0]).toContain('scene aw');

    const implemented = [...(await readFile(join(cwd, 'demo/scenarios.ts'), 'utf8'))
      .matchAll(/\bname === '([^']+)'/g)].map(match => match[1]);
    const documented = [...readme, ...demo]
      .flatMap(block => [...block.matchAll(/npm run demo -- scene (\w+)/g)].map(match => match[1]));
    expect([...new Set(documented)].sort()).toEqual([...new Set(implemented)].sort());

    expect(readme[0].trim()).toBe('cd "$(pwd -P)"\nnpm ci');
    const install = join(root, 'install');
    await mkdir(install);
    await Promise.all(['package.json', 'package-lock.json'].map(file => copyFile(join(cwd, file), join(install, file))));
    await execFile('sh', ['-c', readme[0]], { cwd: install, timeout: 120_000, env: {
      ...env, TMPDIR: root, NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    } });
    await access(join(install, 'node_modules/.bin/tsx'));

    const preflight = await run(readme[1], env);
    expect(preflight.data.status).toBe('ready');
    const bridge = start(readme[2], env);
    await waitFor('bridge', async () => bridge.output().includes('listening on 127.0.0.1:8788'), bridge.output);
    const worker = start(readme[3], env);
    await waitFor('Worker health', async () => (await fetch(workerUrl + '/health')).ok, worker.output);
    expect((await (await fetch(workerUrl + '/health')).json() as any).data.storageBackend).toBe('bridge');

    const execute = async (block: string) => {
      const { exports, commands } = commandLines(block);
      const results: any[] = [];
      for (const command of commands) {
        expect(command).toMatch(/^npm run demo -- (seed|scene|inspect) /);
        const result = await run([...exports, command].join('\n'), env);
        results.push(result.data);
        const scene = /npm run demo -- scene (\w+)/.exec(command)?.[1];
        if (scene) {
          expect(result.data.scene).toBe(scene);
          if (scene !== 'negative') expect(result.data.evidence).toBeTruthy();
        }
      }
      return results;
    };
    let first: any[];
    try { first = await execute(readme[4]); }
    catch (error) {
      const snapshot = await fetch(workerUrl + '/v1/repos/dispatch_demo-01/snapshot',
        { headers: { authorization: 'Bearer local-owner' } }).then(response => response.json()).catch(() => null) as any;
      const jobId = snapshot?.data?.projections?.runners?.jobs?.[0]?.jobId;
      const result = jobId ? await fetch(workerUrl + `/v1/repos/dispatch_demo-01/jobs/${jobId}/result`,
        { headers: { authorization: 'Bearer local-owner' } }).then(response => response.json()).catch(() => null) : null;
      throw new Error(`${String(error)}\nRESULT: ${JSON.stringify(result)}\nQUEUE: ${JSON.stringify(snapshot?.data?.projections?.queue)}\nWORKER: ${worker.output()}\nBRIDGE: ${bridge.output()}`);
    }
    expect(first[0].canonicalOid).toMatch(/^[a-f0-9]{40}$/);
    expect(first[2].evidence.refusal.code).toBe('LEASE_CONFLICT');
    expect(first[3].evidence.diagnosis).toBeTruthy();
    const later = await execute(demo[0]);
    expect(later[0].evidence.blocked.state).toBe('blocked');
    expect(later[2].evidence.incompleteStatus).toBe(409);
    expect(later[3].evidence.derivedVerdictId).toBeTruthy();
    expect(later[4].evidence.carried).toBe(false);
    expect(later[5].evidence.scores.map((score: any) => score.score.matched).sort()).toEqual([2, 4]);
    expect(later[6].evidence.attempts).toBe(7);
    expect(later[7].evidence).toMatchObject({ attempts: 7, taskId: 'task-17', checkerOutcome: 'PASS', queueState: 'landed' });
    expect(new Set(later[7].evidence.changeIds).size).toBe(1);
    const deployed = await execute(deploy[0]);
    expect(deployed[0].canonicalOid).toBe(later[7].canonicalOid);
    expect(deployed[3].evidence['wrong-exec'].checkerOutcomes).toContain('FAIL');
    expect(deployed[3].queue.finalCanonicalOid).toMatch(/^[a-f0-9]{40}$/);
  }, 600_000);
});
