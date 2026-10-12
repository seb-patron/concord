import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OUTPUT_CAP = 16 * 1024;
const jobDeadline = new AsyncLocalStorage<number>();
export function withJobDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  return jobDeadline.run(deadline, run);
}
export type CommandResult = { code: number; stdout: string; stderr: string; stdoutBytes: Buffer; timedOut: boolean; truncated: boolean; outputTail?: string };

export function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: process.platform === 'win32' ? 'NUL' : '/dev/null', ...extra };
}

/** No shell interpolation, and output is capped while it is collected. */
export async function command(file: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = childEnvironment(),
  capture?: { outputCap: number; tail: true }): Promise<CommandResult> {
  const remaining = jobDeadline.getStore() === undefined ? timeoutMs : Math.min(timeoutMs, jobDeadline.getStore()! - Date.now());
  if (remaining <= 0) throw new Error('JOB_TIMEOUT');
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let killer: Promise<void> | null = null;
    let truncated = false;
    let outputTail = Buffer.alloc(0);
    const collectTail = (chunk: Buffer) => {
      if (!capture) return;
      const next = Buffer.concat([outputTail, chunk]);
      if (next.length > capture.outputCap) truncated = true;
      outputTail = next.subarray(Math.max(0, next.length - capture.outputCap));
    };
    const collect = (previous: Buffer, chunk: Buffer) => {
      if (previous.length >= OUTPUT_CAP) { truncated = true; return previous; }
      const next = Buffer.concat([previous, chunk]);
      if (next.length > OUTPUT_CAP) truncated = true;
      return next.subarray(0, OUTPUT_CAP);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); collectTail(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); collectTail(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else if (process.platform === 'win32' && child.pid) {
        killer = new Promise(done => {
          const taskkill = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', shell: false });
          taskkill.once('error', () => { child.kill('SIGKILL'); done(); });
          taskkill.once('close', () => done());
        });
      } else child.kill('SIGKILL');
    }, remaining);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer);
      if (killer) await killer;
      resolveResult({ code: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutBytes: stdout,
        timedOut, truncated, outputTail: capture ? outputTail.toString('utf8') : undefined });
    });
  });
}

export async function git(cwd: string, args: string[], timeoutMs = 30_000, env: NodeJS.ProcessEnv = childEnvironment()): Promise<string> {
  const result = await command('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], cwd, timeoutMs, env);
  if (result.timedOut) throw new Error('GIT_TIMEOUT');
  if (result.truncated) throw new Error('GIT_OUTPUT_TRUNCATED');
  if (result.code !== 0) throw new Error('GIT_ERROR: ' + result.stderr.slice(0, 1024));
  return result.stdout.trim();
}

export async function temporaryWork<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'concord-runner-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function initWorktree(directory: string): Promise<void> {
  await git(directory, ['init', '--quiet']);
}

/** The runner never resolves a moving branch name for an input. */
export async function fetchOid(directory: string, remote: string, oid: string, env?: NodeJS.ProcessEnv): Promise<void> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid)) throw new Error('INVALID_OID');
  await git(directory, ['fetch', '--no-tags', remote, oid], 60_000, env);
  const readback = await git(directory, ['rev-parse', 'FETCH_HEAD^{commit}']);
  if (readback !== oid) throw new Error('FETCH_OID_MISMATCH');
}

export async function treeOid(directory: string, oid: string): Promise<string> {
  return git(directory, ['rev-parse', oid + '^{tree}']);
}

export async function isAncestor(directory: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await command('git', ['merge-base', '--is-ancestor', ancestor, descendant], directory, 30_000);
  if (result.timedOut || result.code > 1) throw new Error('ANCESTRY_CHECK_FAILED');
  return result.code === 0;
}

export async function refOid(directory: string, remote: string, ref = 'refs/heads/main', env?: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await command('git', ['ls-remote', '--exit-code', remote, ref], directory, 30_000, env);
  if (result.timedOut || result.truncated || ![0, 2].includes(result.code)) throw new Error('REF_READ_FAILED');
  return result.code === 2 ? null : result.stdout.trim().split(/\s+/)[0];
}

/** Explicit expected-old compare-and-swap; absence is represented by an empty lease value. */
export async function conditionalPush(directory: string, remote: string, newOid: string, expectedOld: string | null, env?: NodeJS.ProcessEnv, ref = 'refs/heads/main'): Promise<'APPLIED' | 'OLD_REF' | 'THIRD_REF'> {
  const before = await refOid(directory, remote, ref, env);
  if (before === newOid) return 'APPLIED';
  if (before !== expectedOld) return 'OLD_REF';
  const result = await command('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    'push', '--porcelain', '--force-with-lease=' + ref + ':' + (expectedOld ?? ''), remote, newOid + ':' + ref], directory, 60_000, env);
  const after = await refOid(directory, remote, ref, env);
  if (after === newOid) return 'APPLIED';
  if (after !== expectedOld) return 'THIRD_REF';
  return result.code === 0 ? 'THIRD_REF' : 'OLD_REF';
}

/** Git receives the short-lived credential only through child environment config. */
export async function gitCredentialEnvironment(_directory: string, secret: string): Promise<NodeJS.ProcessEnv> {
  return childEnvironment({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'http.extraHeader',
    GIT_CONFIG_VALUE_1: `Authorization: Bearer ${secret}` });
}
