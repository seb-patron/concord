import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { access, copyFile, mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { wranglerStateDir } from '../../demo/scenarios';

const execFile = promisify(execFileCallback);
const cwd = resolve('.');
const children: ChildProcess[] = [];
const directories: string[] = [];

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
  const commands = lines.filter(line => !line.startsWith('export '));
  return { exports, commands };
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
  it('keeps Wrangler persistence in the clone when TMPDIR is outside it', async () => {
    const root = await externalTempDir('concord-docs-paths-');
    const readme = await taggedBlocks('README.md');
    const blocks = [...readme, ...await taggedBlocks('docs/DEMO.md'), ...await taggedBlocks('docs/deploy.md')];
    const env = { ...process.env, TMPDIR: root };
    expect(relative(cwd, root).startsWith('..')).toBe(true);
    const { stdout: runDir } = await execFile('sh', ['-c', `${commandLines(readme[1]).exports[0]}\nprintf '%s' "$CONCORD_RUN_DIR"`],
      { cwd, env });
    expect(isAbsolute(runDir)).toBe(true);
    expect(runDir).toBe(join(resolve(env.TMPDIR), 'concord-demo-01'));
    await mkdir(runDir);
    await writeFile(join(runDir, 'trusted-config.json'), '{}\n');

    let checked = 0;
    for (const block of blocks) {
      const { exports, commands } = commandLines(block);
      for (const command of commands) {
        const script = [
          'npm() { previous=; for arg do',
          '  if [ "$previous" = --state-dir ] || [ "$previous" = --persist-to ]; then printf "%s\\n%s\\n" "$previous" "$arg"; fi',
          '  previous=$arg',
          'done; }',
          ...exports, command,
        ].join('\n');
        const { stdout } = await execFile('sh', ['-c', script], { cwd, env: { ...env, CONCORD_RUN_DIR: runDir } });
        const args = stdout.trim() ? stdout.trim().split('\n') : [];
        expect(args).toHaveLength(2 * (command.match(/--(?:state-dir|persist-to)\b/g) ?? []).length);
        for (let index = 0; index < args.length; index += 2) {
          const [flag, path] = args.slice(index, index + 2);
          if (flag === '--state-dir') {
            expect(isAbsolute(path), `${command}: ${path}`).toBe(true);
            expect(path.startsWith(root + '/'), `${command}: ${path}`).toBe(true);
          } else {
            expect(flag).toBe('--persist-to');
            expect(resolve(cwd, path), `${command}: ${path}`).toBe(wranglerStateDir(runDir));
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('runs every 12c-tagged local command against the real bridge and Worker', async () => {
    const root = await externalTempDir('concord-docs-');
    // tsx needs a short socket path. This relative TMPDIR resolves outside the clone.
    // Demo and runner need the absolute path for their candidate worktrees.
    const preload = join(root, 'restore-tmp.cjs');
    await writeFile(preload, "if (/(?:demo|runner)\\/main\\.ts$/.test(process.argv[1] ?? '')) process.env.TMPDIR = process.env.CONCORD_DOCS_ABS_TMPDIR;\n");
    const env = { ...process.env, TMPDIR: relative(cwd, root), XDG_CONFIG_HOME: root,
      CONCORD_RUN_DIR: join(root, 'concord-demo-01'), CONCORD_URL: 'http://127.0.0.1:8787',
      CONCORD_TOKEN: 'local-owner', CONCORD_SHOW_DECOMPILED_C: '0', WRANGLER_SEND_METRICS: 'false',
      CONCORD_DOCS_ABS_TMPDIR: root, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
    };
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

    expect(readme[0].trim()).toBe('npm ci');
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
    await waitFor('Worker health', async () => (await fetch(env.CONCORD_URL + '/health')).ok, worker.output);
    expect((await (await fetch(env.CONCORD_URL + '/health')).json() as any).data.storageBackend).toBe('bridge');

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
      const snapshot = await fetch(env.CONCORD_URL + '/v1/repos/dispatch_demo-01/snapshot',
        { headers: { authorization: 'Bearer local-owner' } }).then(response => response.json()).catch(() => null) as any;
      const jobId = snapshot?.data?.projections?.runners?.jobs?.[0]?.jobId;
      const result = jobId ? await fetch(env.CONCORD_URL + `/v1/repos/dispatch_demo-01/jobs/${jobId}/result`,
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
