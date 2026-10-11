import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ConcordError } from './client.ts';

const execFile = promisify(execFileCallback);
export interface GitOptions { token?: string; timeoutMs?: number }

export async function git(args: string[], options: GitOptions = {}, cwd?: string): Promise<string> {
  if (args.some(arg => arg.includes('\0'))) throw new ConcordError('Invalid Git argument', 'usage');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  if (options.token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${options.token}`;
  }
  try {
    const result = await execFile('git', args, { cwd, env, timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return result.stdout.trim();
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    const message = (e.stderr || e.message || 'Git command failed').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    throw new ConcordError(`Git failed: ${message.trim()}`, 'transport');
  }
}

export async function resolveHead(worktree: string): Promise<string> {
  return git(['rev-parse', '--verify', 'HEAD^{commit}'], {}, worktree);
}

export async function assertCommit(worktree: string, oid: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) throw new ConcordError('Base OID is missing or malformed', 'usage');
  const actual = await git(['rev-parse', '--verify', `${oid}^{commit}`], {}, worktree);
  if (actual.toLowerCase() !== oid.toLowerCase()) throw new ConcordError(`Local base ${oid} did not resolve exactly`, 'usage');
}

export async function assertHeadBasedOn(worktree: string, baseOid: string, headOid: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(headOid)) throw new ConcordError('Local HEAD is missing or malformed', 'usage');
  try { await git(['merge-base', '--is-ancestor', baseOid, headOid], {}, worktree); }
  catch { throw new ConcordError('Local HEAD must descend from the server base commit', 'usage'); }
}

export async function cloneRepo(remote: string, destination: string, token?: string): Promise<void> {
  validateRemote(remote);
  await git(['clone', '--', remote, destination], { token });
}

export async function fetchFork(worktree: string, remote: string, branch: string, token?: string): Promise<void> {
  validateRemote(remote);
  validateBranch(branch);
  await git(['fetch', '--no-tags', '--', remote, `refs/heads/${branch}:refs/remotes/concord/${branch}`], { token }, worktree);
}

export async function pushCandidate(worktree: string, remote: string, branch: string, token?: string, headOid = 'HEAD'): Promise<void> {
  validateRemote(remote);
  validateBranch(branch);
  if (!/^(?:HEAD|[0-9a-f]{40,64})$/i.test(headOid)) throw new ConcordError('Candidate head OID is malformed', 'usage');
  await git(['-c', 'core.hooksPath=/dev/null', 'push', '--no-follow-tags', '--', remote, `${headOid}:refs/heads/${branch}`], { token }, worktree);
}

export function rejectCanonicalTarget(candidateStorageName: string, canonicalStorageName: unknown, candidateRemote: string, canonicalRemote?: unknown): void {
  if (candidateStorageName === canonicalStorageName || (typeof canonicalRemote === 'string' && normalizeRemote(candidateRemote) === normalizeRemote(canonicalRemote))) {
    throw new ConcordError('Refusing to push to the canonical repository', 'server');
  }
}

export function validateRemote(remote: string): void {
  let url: URL;
  try { url = new URL(remote); } catch { throw new ConcordError('Server assigned Git remote is not an absolute HTTP(S) URL', 'server'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConcordError('Server assigned Git remote is unsafe; credentials and query strings are forbidden', 'server');
  }
}

function normalizeRemote(value: string): string { return value.replace(/\/$/, '').toLowerCase(); }

function validateBranch(branch: string): void {
  if (!branch || branch === 'main' || branch === 'refs/heads/main' || branch.startsWith('-') || branch.includes('..') || branch.includes('@{') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) {
    throw new ConcordError('Server supplied an invalid candidate branch', 'server');
  }
}
