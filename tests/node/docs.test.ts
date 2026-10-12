import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentTest } from 'vitest/suite';
import { wranglerStateDir } from '../../demo/scenarios';

const execFile = promisify(execFileCallback);
const cwd = realpathSync(resolve('.'));
const children: ChildProcess[] = [];
const directories: string[] = [];
const CHILD_TIMEOUT_MS = 30_000;
const DOCUMENTED_BLOCK_TIMEOUT_MS = 300_000;
const SETUP_MARGIN_MS = 30_000;

function shellCallBudget(maxCalls: number, maxCallMs = CHILD_TIMEOUT_MS) {
  const timeout = maxCalls * maxCallMs + SETUP_MARGIN_MS;
  return {
    timeout,
    countCalls() {
      let calls = 0;
      return {
        run<T>(call: () => T): T {
          if (calls >= maxCalls) throw new Error(`Shell call budget exceeded: more than ${maxCalls} calls`);
          calls++;
          return call();
        },
        assertComplete() {
          expect(calls).toBe(maxCalls);
          expect(getCurrentTest()?.timeout).toBeGreaterThanOrEqual(timeout);
        },
      };
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const bridgePort = await freePort();
let workerPort = await freePort();
while (workerPort === bridgePort) workerPort = await freePort();

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
    .map(match => match[1].replaceAll('8788', String(bridgePort)).replaceAll('8787', String(workerPort))
      .replace(/npm run dev --/g, `npm run dev -- --port ${workerPort}`));
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
  const { stdout } = await execFile('sh', ['-c', script], { cwd, env, timeout: CHILD_TIMEOUT_MS });
  const lines = stdout.trimEnd().split('\n');
  return { args: lines.filter(line => line.startsWith('ARG:')).map(line => line.slice(4)),
    values: lines.filter(line => line.startsWith('ENV:')).map(line => line.slice(4)) };
}

type ShellCall = { command: string; args: string[]; env: NodeJS.ProcessEnv };

async function capturedBlock(block: string, root: string): Promise<ShellCall[]> {
  const bin = join(root, 'shims');
  const log = join(root, 'calls.jsonl');
  await mkdir(bin, { recursive: true });
  await writeFile(log, '');
  const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
fs.appendFileSync(process.env.CAPTURE_LOG, JSON.stringify({ command, args: process.argv.slice(2), env: process.env }) + '\\n');
if (command === 'npm' && process.argv.slice(2).join(' ').startsWith('run demo -- preflight')) {
  fs.mkdirSync(process.env.CONCORD_RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.CONCORD_RUN_DIR, 'trusted-config.json'), '{"fixture":"trusted"}\\n');
}
`;
  for (const command of ['npm', 'git', 'wrangler']) {
    const path = join(bin, command);
    await writeFile(path, shim);
    await chmod(path, 0o755);
  }
  const cleanEnv = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root, TMPDIR: root, CAPTURE_LOG: log };
  await execFile('env', ['-i', ...Object.entries(cleanEnv).map(([key, value]) => `${key}=${value}`),
    'sh', '-ec', block], { cwd, timeout: CHILD_TIMEOUT_MS });
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ShellCall);
}

function assertCallEnvironment(calls: ShellCall[], block: string, runDir: string): void {
  expect(calls).toHaveLength(commandLines(block).commands.length);
  for (const call of calls) {
    expect(call.command).toBe('npm');
    expect(call.args.length).toBeGreaterThan(0);
    if (call.args[0] === 'ci') continue;
    const required = ['CONCORD_RUN_DIR'];
    if (call.args[1] === 'git-bridge') required.push('CONCORD_BRIDGE_DATA_DIR', 'CONCORD_BRIDGE_TOKEN', 'CONCORD_BRIDGE_PORT');
    if (call.args[1] === 'dev') required.push('CONCORD_BRIDGE_TOKEN', 'CONCORD_WRANGLER_STATE', 'WRANGLER_SEND_METRICS');
    if (call.args[1] === 'demo' && call.args[3] !== 'preflight') required.push('CONCORD_URL', 'CONCORD_TOKEN', 'CONCORD_SHOW_DECOMPILED_C');
    if (call.args[1] === 'runner') required.push('CONCORD_URL', 'CONCORD_TOKEN');
    for (const key of required) expect(call.env[key], `${call.args.join(' ')} needs ${key}`).toBeTruthy();
    expect(call.env.CONCORD_RUN_DIR).toBe(runDir);
    if (call.args[1] === 'git-bridge') {
      expect(call.env.CONCORD_BRIDGE_DATA_DIR).toBe(join(runDir, 'bridge'));
      expect(call.env.CONCORD_BRIDGE_TOKEN).toBe('local-bridge-fixture-2026');
      expect(call.env.CONCORD_BRIDGE_PORT).toBe(String(bridgePort));
    }
    if (call.args[1] === 'dev') {
      expect(call.args).toContain(`BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=${call.env.CONCORD_BRIDGE_TOKEN}`);
      expect(call.args.some(arg => arg.startsWith('TRUSTED_CONFIG:{'))).toBe(true);
      expect(call.env.WRANGLER_SEND_METRICS).toBe('false');
    }
    if (call.args[1] === 'demo' && call.args[3] !== 'preflight') {
      expect(call.env.CONCORD_URL).toBe(`http://127.0.0.1:${workerPort}`);
      expect(call.env.CONCORD_TOKEN).toBe('local-owner');
      expect(call.env.CONCORD_SHOW_DECOMPILED_C).toBe('0');
    }
    if (call.args[1] === 'runner') {
      expect(call.env.CONCORD_URL).toBe(`http://127.0.0.1:${workerPort}`);
      expect(call.env.CONCORD_TOKEN).toBe(call.args.includes('checker') ? 'local-checker' : 'local-promoter');
    }
  }
}

async function runDocumentedBlock(block: string, env: NodeJS.ProcessEnv): Promise<any[]> {
  const marker = '__CONCORD_DOCUMENTED_NPM_CALL__';
  const wrapper = `npm() { printf '\\n${marker}\\n'; command npm "$@"; }`;
  const { stdout } = await execFile('sh', ['-ec', `${wrapper}\n${block}`],
    { cwd, env, timeout: DOCUMENTED_BLOCK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const outputs = stdout.split(marker + '\n').slice(1);
  expect(outputs).toHaveLength(commandLines(block).commands.length);
  return outputs.map(output => {
    const jsonAt = output.indexOf('{');
    if (jsonAt < 0) throw new Error(`No JSON in documented command output: ${output}`);
    return JSON.parse(output.slice(jsonAt));
  });
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
  const deadline = Date.now() + 60_000;
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

describe('UI documentation', () => {
  it('states that verdict records are unavailable until the UI calls the serving route', async () => {
    const document = await readFile(join(cwd, 'docs/ui.md'), 'utf8');
    const provenance = /- \*\*Approval provenance\*\*:([\s\S]*?)(?=\n- \*\*|\n## )/.exec(document)?.[1] ?? '';
    const snapshotRow = document.split('\n').find(line => line.startsWith('| Approval provenance |')) ?? '';
    const demoRow = document.split('\n').find(line => line.startsWith('| D carried approval, H invalidation |')) ?? '';

    expect(provenance).toMatch(/no verdict records are available/i);
    expect(provenance).toContain('`items: []`');
    expect(provenance).toMatch(/renders verdicts from that snapshot only/i);
    expect(provenance).toMatch(/per-change verdict GET route\s+exists, but the UI\s+does not call it yet/i);
    expect(provenance).toMatch(/separate slice/i);
    expect(snapshotRow).toContain('returns `items: []`');
    expect(snapshotRow).toMatch(/GET \/v1\/repos\/:repoId\/changes\/:changeId\/verdicts.*UI does not call it/i);
    expect(demoRow).toMatch(/shows no verdict records today/i);
    expect(demoRow).not.toMatch(/panel reads verdict records/i);
  });
});

describe('documented demo commands', () => {
  const blockBudget = shellCallBudget(9);
  const persistenceBudget = shellCallBudget(5);
  const pathBudget = shellCallBudget(34);
  const liveBudget = shellCallBudget(8, DOCUMENTED_BLOCK_TIMEOUT_MS);

  it('rejects shell calls beyond the declared budget', () => {
    const calls = shellCallBudget(1).countCalls();
    calls.run(() => undefined);
    expect(() => calls.run(() => undefined)).toThrow('Shell call budget exceeded: more than 1 calls');
  });

  it('runs every 12c-tagged block in written order from a clean shell', async () => {
    const shell = blockBudget.countCalls();
    const root = await externalTempDir('concord-docs-shell-');
    const runDir = join(root, 'concord-demo-01');
    for (const path of ['README.md', 'docs/DEMO.md', 'docs/deploy.md']) {
      for (const block of await taggedBlocks(path)) {
        assertCallEnvironment(await shell.run(() => capturedBlock(block, root)), block, runDir);
      }
    }
    const deploy = (await taggedBlocks('docs/deploy.md'))[0];
    const [seed] = await shell.run(() => capturedBlock(deploy, root));
    expect(seed.args.slice(0, 4)).toEqual(['run', 'demo', '--', 'seed']);
    expect(seed.env.CONCORD_TOKEN).toBe('local-owner');
    const readme = (await taggedBlocks('README.md'))[4];
    const tokenExport = 'export CONCORD_TOKEN=local-owner\n';
    const movedToken = readme.replace(tokenExport, '').replace(/(npm run demo -- seed[^\n]*\n)/, `$1${tokenExport}`);
    expect(movedToken).not.toBe(readme);
    const mutatedCalls = await shell.run(() => capturedBlock(movedToken, root));
    expect(() => assertCallEnvironment(mutatedCalls, movedToken, runDir)).toThrow();
    expect(mutatedCalls.find(call => call.args[3] === 'seed')?.env.CONCORD_TOKEN).toBeUndefined();
    shell.assertComplete();
  }, blockBudget.timeout);

  it('keeps every documented Wrangler dev command persistent inside the clone', async () => {
    const shell = persistenceBudget.countCalls();
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
    const bridgeWorker = /In a second terminal[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(guide)?.[1]
      ?.replaceAll('8788', String(bridgePort)).replaceAll('8787', String(workerPort))
      .replace(/npm run dev --/g, `npm run dev -- --port ${workerPort}`);
    expect(bridgeWorker).toBeDefined();
    const bridgeBlock = /## Local Git bridge[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(guide)?.[1]
      ?.replaceAll('8788', String(bridgePort)).replaceAll('8787', String(workerPort));
    expect(bridgeBlock).toBeDefined();
    for (const suffix of ['first', 'second']) {
      const root = await externalTempDir(`concord-${suffix}-`);
      const env = { ...freshShellEnv(process.env), TMPDIR: root };
      const bridge = await shell.run(() => capturedNpm([], bridgeBlock!, env));
      const worker = await shell.run(() => capturedNpm([], bridgeWorker!, env));
      const runDir = join(root, 'concord-repos-01');
      const token = createHash('sha256').update(runDir + ':bridge').digest('hex');
      const hash = createHash('sha256').update(token).digest('hex').slice(0, 12);
      expect(bridge.args).toEqual(['run', 'git-bridge']);
      expect(bridge.values.slice(0, 3)).toEqual([join(runDir, 'bridge'), token, String(bridgePort)]);
      expect(worker.args.slice(0, 7)).toEqual(['run', 'dev', '--', '--port', String(workerPort), '--persist-to', `.wrangler/state/${hash}`]);
      expect(worker.args).toContain(`BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=${token}`);
      expect(worker.values[1]).toBe(token);
      expect(resolve(cwd, worker.args[6])).toBe(join(cwd, '.wrangler', 'state', hash));
    }
    const missingToken = bridgeWorker!.replace(/^export CONCORD_BRIDGE_TOKEN=.*\n/m, '');
    await expect(shell.run(() => capturedNpm([], missingToken, freshShellEnv(process.env)))).rejects.toMatchObject({ stdout: '' });
    shell.assertComplete();
  }, persistenceBudget.timeout);

  it('keeps Wrangler persistence in the clone when TMPDIR is outside it', async () => {
    const shell = pathBudget.countCalls();
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
      expect((await shell.run(() => capturedNpm([], block, env))).args.length).toBeGreaterThan(0);
    }
    const { stdout: runDir } = await shell.run(() => execFile('sh', ['-c', `${commandLines(readme[1]).exports[0]}\nprintf '%s' "$CONCORD_RUN_DIR"`],
      { cwd, env, timeout: CHILD_TIMEOUT_MS }));
    expect(isAbsolute(runDir)).toBe(true);
    expect(runDir).toBe(join(resolve(env.TMPDIR), 'concord-demo-01'));
    const firstDeploy = await shell.run(() => capturedNpm(commandLines(deploy[0]).exports, commandLines(deploy[0]).commands[0], env));
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
        const { args, values } = await shell.run(() => capturedNpm(exports, command, env));
        if (args[1] === 'dev') {
          workers++;
          expect(args).toEqual(['run', 'dev', '--', '--port', String(workerPort), '--persist-to', `.wrangler/state/${runHash}`,
            '--var', 'STORAGE_BACKEND:bridge', '--var', `BRIDGE_URL:http://127.0.0.1:${bridgePort}/?token=local-bridge-fixture-2026`,
            '--var', `TRUSTED_CONFIG:${trusted}`]);
          expect(resolve(cwd, args[6])).toBe(persistenceDir);
          expect(values[5]).toBe('false');
        } else if (args[1] === 'git-bridge') {
          bridges++;
          expect(args).toEqual(['run', 'git-bridge']);
          expect(values.slice(0, 3)).toEqual([join(runDir, 'bridge'), 'local-bridge-fixture-2026', String(bridgePort)]);
        } else {
          demos++;
          expect(args.slice(0, 3)).toEqual(['run', 'demo', '--']);
          if (args[3] !== 'preflight') {
            expect(values.slice(3, 5)).toEqual([`http://127.0.0.1:${workerPort}`, 'local-owner']);
          }
          const stateFlags = args.flatMap((arg, index) => arg === '--state-dir' ? [args[index + 1]] : []);
          expect(stateFlags, command).toEqual([runDir]);
          expect(isAbsolute(stateFlags[0])).toBe(true);
          expect(stateFlags[0].startsWith(root + '/')).toBe(true);
        }
      }
    }
    expect([workers, bridges, demos]).toEqual([1, 1, 18]);

    const manual = /To run them manually,[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(await readFile(join(cwd, 'docs/DEMO.md'), 'utf8'))?.[1]
      ?.replaceAll('8787', String(workerPort));
    expect(manual).toBeDefined();
    const { exports: runnerExports, commands: runnerCommands } = commandLines(manual!);
    expect(runnerCommands).toHaveLength(2);
    const checker = await shell.run(() => capturedNpm(runnerExports, runnerCommands[0], env));
    expect(checker.args).toEqual(['run', 'runner', '--', '--repo', 'REPO_ID', '--role', 'checker',
      '--profile', join(runDir, 'dispatch-profile.json'), '--once']);
    expect(checker.values.slice(3, 5)).toEqual([`http://127.0.0.1:${workerPort}`, 'local-checker']);
    const promoter = await shell.run(() => capturedNpm(runnerExports, runnerCommands[1], env));
    expect(promoter.args).toEqual(['run', 'runner', '--', '--repo', 'REPO_ID', '--role', 'promoter',
      '--profile-digest', 'PROFILE_DIGEST_FROM_PREFLIGHT', '--once']);
    expect(promoter.values.slice(3, 5)).toEqual([`http://127.0.0.1:${workerPort}`, 'local-promoter']);

    const missingRunDir = runnerExports.filter(line => !line.startsWith('export CONCORD_RUN_DIR='));
    expect(missingRunDir).toHaveLength(runnerExports.length - 1);
    await expect(shell.run(() => execFile('sh', ['-c', [...missingRunDir, runnerCommands[0]].join('\n')],
      { cwd, env: { ...env, TMPDIR: relative(cwd, root) }, timeout: CHILD_TIMEOUT_MS })))
      .rejects.toMatchObject({ stderr: expect.stringMatching(/ENOENT.*\/dispatch-profile\.json/) });

    const release = await readFile(join(cwd, 'docs/deploy.md'), 'utf8');
    const productionRunners = release.split('\n').filter(line => line.includes('npm run runner --'));
    expect(productionRunners).toHaveLength(2);
    const productionEnv = { ...env, CONCORD_REPO_ID: 'repo-id', CONCORD_HOME: join(root, 'operator'),
      CHECKER_TOKEN: 'checker-token', PROMOTER_TOKEN: 'promoter-token', PROFILE_DIGEST: 'profile-digest' };
    const productionChecker = await shell.run(() => capturedNpm([], productionRunners[0], productionEnv));
    expect(productionChecker.args).toEqual(['run', 'runner', '--', '--repo', 'repo-id', '--role', 'checker',
      '--profile', join(root, 'operator', 'checker-profile.json'), '--once']);
    expect(productionChecker.values[4]).toBe('checker-token');
    const productionPromoter = await shell.run(() => capturedNpm([], productionRunners[1], productionEnv));
    expect(productionPromoter.args).toEqual(['run', 'runner', '--', '--repo', 'repo-id', '--role', 'promoter',
      '--profile-digest', 'profile-digest', '--once']);
    expect(productionPromoter.values[4]).toBe('promoter-token');
    shell.assertComplete();
  }, pathBudget.timeout);

  it('runs every 12c-tagged local command against the real bridge and Worker', async () => {
    const shell = liveBudget.countCalls();
    const root = await externalTempDir('concord-docs-');
    // tsx needs a short socket path. This relative TMPDIR resolves outside the clone.
    // Demo and runner need the absolute path for their candidate worktrees.
    const preload = join(root, 'restore-tmp.cjs');
    await writeFile(preload, "if (/(?:demo|runner)\\/main\\.ts$/.test(process.argv[1] ?? '')) process.env.TMPDIR = process.env.CONCORD_DOCS_ABS_TMPDIR;\n");
    const env = { ...freshShellEnv(process.env), TMPDIR: relative(cwd, root), XDG_CONFIG_HOME: root,
      CONCORD_DOCS_ABS_TMPDIR: root, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
    };
    const workerUrl = `http://127.0.0.1:${workerPort}`;
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
    await shell.run(() => execFile('sh', ['-c', readme[0]], { cwd: install, timeout: 120_000, env: {
      ...env, TMPDIR: root, NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    } }));
    await access(join(install, 'node_modules/.bin/tsx'));

    const [preflight] = await shell.run(() => runDocumentedBlock(readme[1], env));
    expect(preflight.status).toBe('ready');
    const occupiedDefaultPort = shell.run(() => start(`node -e 'const s=require("node:net").createServer(); s.on("error",e=>{if(e.code!=="EADDRINUSE") throw e; console.log("held 8788 (existing process)")}); s.listen(8788,"127.0.0.1",()=>console.log("held 8788"))'`, env));
    await waitFor('default bridge port held', async () => occupiedDefaultPort.output().includes('held 8788'), occupiedDefaultPort.output);
    const bridge = shell.run(() => start(readme[2], env));
    await waitFor('bridge', async () => bridge.output().includes(`listening on 127.0.0.1:${bridgePort}`), bridge.output);
    const worker = shell.run(() => start(readme[3], env));
    await waitFor('Worker health', async () => (await fetch(workerUrl + '/health')).ok, worker.output);
    expect((await (await fetch(workerUrl + '/health')).json() as any).data.storageBackend).toBe('bridge');

    const execute = async (block: string) => {
      const commands = commandLines(block).commands;
      for (const command of commands) expect(command).toMatch(/^npm run demo -- (seed|scene|inspect) /);
      const results = await shell.run(() => runDocumentedBlock(block, env));
      for (const [index, result] of results.entries()) {
        const scene = /npm run demo -- scene (\w+)/.exec(commands[index])?.[1];
        if (scene) {
          expect(result.scene).toBe(scene);
          if (scene !== 'negative') expect(result.evidence).toBeTruthy();
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
    shell.assertComplete();
  }, liveBudget.timeout);
});
