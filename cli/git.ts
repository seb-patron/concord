import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ConcordError } from './client.ts';

const execFile = promisify(execFileCallback);
export interface GitOptions { token?: string; timeoutMs?: number; alternateObjectDirectory?: string; identity?: boolean; indexFile?: string }

// Never let a caller's Git context redirect an importer command into its source repository.
export function gitEnvironment(options: GitOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  if (options.alternateObjectDirectory) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = options.alternateObjectDirectory;
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
  if (options.identity) Object.assign(env, { GIT_AUTHOR_NAME: 'Concord Import', GIT_AUTHOR_EMAIL: 'import@concord.invalid',
    GIT_COMMITTER_NAME: 'Concord Import', GIT_COMMITTER_EMAIL: 'import@concord.invalid',
    GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' });
  if (options.token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${options.token}`;
  }
  return env;
}

export async function git(args: string[], options: GitOptions = {}, cwd?: string): Promise<string> {
  if (args.some(arg => arg.includes('\0'))) throw new ConcordError('Invalid Git argument', 'usage');
  try {
    const result = await execFile('git', args, { cwd, env: gitEnvironment(options), timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return result.stdout.trim();
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean };
    const category = e.killed ? 'timeout' : typeof e.code === 'number' ? 'exit' : 'spawn';
    const exitCode = typeof e.code === 'number' && Number.isSafeInteger(e.code) && e.code >= 0 && e.code <= 255 ? e.code : 'unknown';
    throw new ConcordError(`Git failed: ${category} (exit code ${exitCode})`, 'transport');
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

export async function pushCandidate(worktree: string, remote: string, branch: string, token?: string, headOid = 'HEAD', alternateObjectDirectory?: string): Promise<void> {
  validateRemote(remote);
  validateBranch(branch);
  if (!/^(?:HEAD|[0-9a-f]{40,64})$/i.test(headOid)) throw new ConcordError('Candidate head OID is malformed', 'usage');
  await git(['-c', 'core.hooksPath=/dev/null', 'push', '--no-follow-tags', '--', remote, `${headOid}:refs/heads/${branch}`], { token, alternateObjectDirectory }, worktree);
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
