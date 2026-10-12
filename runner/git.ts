import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OUTPUT_CAP = 16 * 1024;
/** Maximum bytes captured from one repository blob during unit inspection. */
export const MAX_INSPECTED_BLOB_BYTES = 8 * 1024 * 1024;
const jobDeadline = new AsyncLocalStorage<number>();
export function withJobDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  return jobDeadline.run(deadline, run);
}
export type CommandResult = { code: number; stdout: string; stderr: string; stdoutBytes: Buffer; timedOut: boolean; jobTimedOut: boolean; truncated: boolean; outputTail?: string };

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
  capture?: { outputCap: number; tail: true; redact?: string[] }, stdoutCap = OUTPUT_CAP): Promise<CommandResult> {
  const deadline = jobDeadline.getStore();
  const deadlineRemaining = deadline === undefined ? undefined : deadline - Date.now();
  const remaining = deadlineRemaining === undefined ? timeoutMs : Math.min(timeoutMs, deadlineRemaining);
  const deadlineLimited = deadlineRemaining !== undefined && deadlineRemaining <= timeoutMs;
  if (remaining <= 0) throw new Error('JOB_TIMEOUT');
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let killer: Promise<void> | null = null;
    let truncated = false;
    let eventOrder = 0;
    let tailBytes = 0;
    const orderedTail: { order: number; bytes: Buffer }[] = [];
    const redactions = (capture?.redact ?? []).filter(Boolean).map(value => Buffer.from(value))
      .sort((a, b) => b.length - a.length);
    const maxRedactionBytes = redactions[0]?.length ?? 0;
    const marker = Buffer.from('[redacted]');
    type Pending = { bytes: Buffer; origins: { end: number; order: number }[] };
    const pending: Record<'stdout' | 'stderr', Pending> = {
      stdout: { bytes: Buffer.alloc(0), origins: [] }, stderr: { bytes: Buffer.alloc(0), origins: [] },
    };
    const collectTail = (chunk: Buffer, order: number) => {
      if (!capture || !chunk.length) return;
      let at = orderedTail.length;
      while (at > 0 && orderedTail[at - 1].order > order) at--;
      orderedTail.splice(at, 0, { order, bytes: chunk });
      tailBytes += chunk.length;
      if (tailBytes > capture.outputCap) truncated = true;
      while (tailBytes > capture.outputCap) {
        const excess = tailBytes - capture.outputCap;
        const first = orderedTail[0];
        const removed = Math.min(first.bytes.length, excess);
        if (first.bytes.length <= excess) orderedTail.shift();
        else first.bytes = first.bytes.subarray(excess);
        tailBytes -= removed;
      }
    };
    const collectRedactedTail = (stream: 'stdout' | 'stderr', chunk: Buffer, order: number, final = false) => {
      if (!capture) return;
      if (!redactions.length) { collectTail(chunk, order); return; }
      const state = pending[stream];
      const buffered = Buffer.concat([state.bytes, chunk]);
      const origins = [...state.origins];
      if (chunk.length) origins.push({ end: buffered.length, order });
      const originAt = (offset: number) => origins.find(origin => offset < origin.end)!.order;
      const emitRange = (start: number, end: number) => {
        while (start < end) {
          const origin = origins.find(entry => start < entry.end)!;
          const next = Math.min(end, origin.end);
          collectTail(buffered.subarray(start, next), origin.order);
          start = next;
        }
      };
      // A match may begin in the final max(value length)-1 bytes and finish in
      // the next chunk. Keep that window until it can be classified safely.
      const safeEnd = final ? buffered.length : Math.max(0, buffered.length - maxRedactionBytes + 1);
      let cursor = 0;
      while (cursor < safeEnd) {
        let first = buffered.length;
        let match: Buffer | undefined;
        for (const value of redactions) {
          const at = buffered.indexOf(value, cursor);
          if (at >= 0 && at < first) { first = at; match = value; }
        }
        if (!match || first >= safeEnd) {
          emitRange(cursor, safeEnd);
          cursor = safeEnd;
          break;
        }
        emitRange(cursor, first);
        collectTail(marker, originAt(first));
        cursor = first + match.length;
      }
      state.bytes = buffered.subarray(cursor);
      state.origins = origins.filter(origin => origin.end > cursor)
        .map(origin => ({ end: origin.end - cursor, order: origin.order }));
    };
    const collect = (previous: Buffer, chunk: Buffer, cap: number) => {
      if (previous.length >= cap) { truncated = true; return previous; }
      const next = Buffer.concat([previous, chunk]);
      if (next.length > cap) truncated = true;
      return next.subarray(0, cap);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk, stdoutCap); collectRedactedTail('stdout', chunk, ++eventOrder); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk, OUTPUT_CAP); collectRedactedTail('stderr', chunk, ++eventOrder); });
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
      const streams: ('stdout' | 'stderr')[] = ['stdout', 'stderr'];
      streams.sort((a, b) => (pending[a].origins[0]?.order ?? Infinity) - (pending[b].origins[0]?.order ?? Infinity));
      for (const stream of streams) collectRedactedTail(stream, Buffer.alloc(0), ++eventOrder, true);
      resolveResult({ code: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutBytes: stdout,
        timedOut, jobTimedOut: timedOut && deadlineLimited, truncated,
        outputTail: capture ? Buffer.concat(orderedTail.map(part => part.bytes), tailBytes).toString('utf8') : undefined });
    });
  });
}

export async function git(cwd: string, args: string[], timeoutMs = 30_000, env: NodeJS.ProcessEnv = childEnvironment()): Promise<string> {
  const result = await command('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], cwd, timeoutMs, env);
  if (result.timedOut) throw new Error(result.jobTimedOut ? 'JOB_TIMEOUT' : 'GIT_TIMEOUT');
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
export async function fetchOid(directory: string, remote: string, oid: string, env?: NodeJS.ProcessEnv,
  retry: { runGit?: typeof git; sleep?: (ms: number) => Promise<void>; random?: () => number } = {}): Promise<void> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid)) throw new Error('INVALID_OID');
  const runGit = retry.runGit ?? git;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await runGit(directory, ['fetch', '--no-tags', remote, oid], 60_000, env);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (attempt === 2 || /(?:401|403|authentication failed|access denied|not authorized|could not read username)/i.test(message) ||
        !(/^(?:GIT_TIMEOUT)$/i.test(message) || /(?:Could not resolve host|Connection reset|early EOF|RPC failed|the remote end hung up unexpectedly|Operation timed out|HTTP 5\d\d|returned error: 50[234])/i.test(message))) throw error;
      const delay = (attempt === 0 ? 250 : 1000) * (0.5 + (retry.random ?? Math.random)());
      const deadline = jobDeadline.getStore();
      if (deadline !== undefined && Date.now() + delay >= deadline) throw new Error('JOB_TIMEOUT');
      await (retry.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(delay);
    }
  }
  const readback = await runGit(directory, ['rev-parse', 'FETCH_HEAD^{commit}']);
  if (readback !== oid) throw new Error('FETCH_OID_MISMATCH');
}

export async function treeOid(directory: string, oid: string): Promise<string> {
  return git(directory, ['rev-parse', oid + '^{tree}']);
}

/** Stable patch identity for the complete candidate delta, streamed without a size-limited capture. */
export async function patchId(directory: string, base: string, head: string): Promise<string> {
  const env = childEnvironment();
  const diff = spawn('git', ['diff', '--no-ext-diff', '--binary', base, head, '--'],
    { cwd: directory, env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  const patch = spawn('git', ['patch-id', '--stable'],
    { cwd: directory, env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  diff.stdout.pipe(patch.stdin);
  let output = '';
  patch.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const deadline = jobDeadline.getStore();
  const timeout = Math.max(1, Math.min(60_000, (deadline ?? Date.now() + 60_000) - Date.now()));
  const timer = setTimeout(() => { diff.kill('SIGKILL'); patch.kill('SIGKILL'); }, timeout);
  try {
    const [diffCode, patchCode] = await Promise.all([
      new Promise<number>((resolve, reject) => { diff.once('error', reject); diff.once('close', code => resolve(code ?? -1)); }),
      new Promise<number>((resolve, reject) => { patch.once('error', reject); patch.once('close', code => resolve(code ?? -1)); }),
    ]);
    if (diffCode !== 0 || patchCode !== 0 || !/^[a-f0-9]{40,64}\s/.test(output)) throw new Error('PATCH_ID_UNAVAILABLE');
    return output.split(/\s+/)[0];
  } finally { clearTimeout(timer); }
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
