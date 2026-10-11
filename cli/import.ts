import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConcordClient, ConcordError, idempotencyKey, rememberCredential } from './client.ts';
import { git, pushCandidate, rejectCanonicalTarget } from './git.ts';

const execFile = promisify(execFileCallback);
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const oidPattern = /^[a-f0-9]{40}$/;
const branch = 'concord-import';
type Entry = { path: string; mode: string; oid: string; bytes: number };
type Envelope = { version: number; data: Record<string, unknown> };

export interface ImportOptions {
  source: string; ref: string; repo: string; policyId?: string; profileId?: string;
  excludes?: string[]; excludeFile?: string; requireMatch?: boolean; printTree?: boolean; verbose?: boolean;
}

function glob(pattern: string): RegExp {
  if (!pattern || pattern.startsWith('/') || pattern.includes('\\') || pattern.includes('\0') ||
      pattern.split('/').some((part, index, parts) => (!part && index !== parts.length - 1) || part === '.' || part === '..') ||
      /[\[\]{}]/.test(pattern)) {
    throw new ConcordError('Invalid exclusion glob; use normalized Git paths and *, **, or ?', 'usage');
  }
  const value = pattern.endsWith('/') ? pattern + '**' : pattern;
  let expression = '^';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '*' && value[i + 1] === '*') {
      if (value[i + 2] === '/') { expression += '(?:.*/)?'; i += 2; }
      else { expression += '.*'; i++; }
    } else if (ch === '*') expression += '[^/]*';
    else if (ch === '?') expression += '[^/]';
    else expression += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$');
}

async function treeEntries(source: string, tree: string, alternateObjectDirectory?: string): Promise<Entry[]> {
  let raw: Buffer;
  try {
    const result = await execFile('git', ['-C', source, 'ls-tree', '-r', '-z', '-l', tree], {
      encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        ...(alternateObjectDirectory ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectory } : {}) },
    });
    raw = result.stdout;
  } catch { throw new ConcordError('Cannot inspect source Git tree', 'usage'); }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: Entry[] = [];
  try {
    for (const record of raw.subarray(0, raw.length ? -1 : 0).toString('binary').split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const meta = record.slice(0, tab);
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)$/.exec(meta);
      if (tab < 0 || !match) throw new Error('invalid tree entry');
      const path = decoder.decode(Buffer.from(record.slice(tab + 1), 'binary'));
      if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid path');
      if (match[1] === '120000') throw new ConcordError('Source tree contains a symlink', 'usage');
      if (match[1] === '160000' || match[2] === 'commit') throw new ConcordError('Source tree contains a submodule', 'usage');
      if (!['100644', '100755'].includes(match[1]) || match[4] === '-') throw new Error('unsupported tree entry');
      entries.push({ path, mode: match[1], oid: match[3], bytes: Number(match[4]) });
    }
  } catch (error) {
    if (error instanceof ConcordError) throw error;
    throw new ConcordError('Source tree contains an unsupported or invalid Git path', 'usage');
  }
  return entries;
}

function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || !('data' in value) || !((value as Envelope).data) ||
      typeof (value as Envelope).data !== 'object') throw new ConcordError('Invalid Concord response', 'server');
  return (value as Envelope).data;
}
function version(value: unknown): number {
  const found = (value as Envelope)?.version;
  if (!Number.isSafeInteger(found)) throw new ConcordError('Concord response lacks version', 'server');
  return found;
}
function field(record: Record<string, unknown>, name: string): string {
  const found = record[name];
  if (typeof found !== 'string' || !found) throw new ConcordError(`Concord response lacks ${name}`, 'server');
  return found;
}
async function poll<T>(label: string, action: () => Promise<T>, done: (value: T) => boolean, timeout = 120_000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await action();
    if (done(result)) return result;
    await pause(400);
  }
  throw new ConcordError(`Timed out waiting for ${label}; re-run import to reconcile`, 'transport');
}

export async function importRepo(options: ImportOptions, client?: ConcordClient): Promise<Record<string, unknown>> {
  if (!options.source || !options.ref || options.ref.startsWith('-') || /[\r\n\0]/.test(options.ref) || !/^[A-Za-z0-9_-]{1,64}$/.test(options.repo)) {
    throw new ConcordError('import requires --source PATH --ref REF --repo NAME', 'usage');
  }
  if (!options.printTree && (!options.policyId || !options.profileId)) {
    throw new ConcordError('import requires --policy-id and --profile-id', 'usage');
  }
  const source = await realpath(resolve(options.source)).catch(() => { throw new ConcordError('Source Git repository is unreadable', 'usage'); });
  const topLevel = await git(['-C', source, 'rev-parse', '--show-toplevel']).catch(() => {
    throw new ConcordError('--source must be a Git repository top level', 'usage');
  });
  const sourceRoot = await realpath(topLevel).catch(() => {
    throw new ConcordError('Source Git repository top level is unreadable', 'usage');
  });
  if (source !== sourceRoot) throw new ConcordError('--source must be the Git repository top level', 'usage');
  const sourceName = basename(source);
  const sourceOid = await git(['-C', source, 'rev-parse', '--verify', `${options.ref}^{commit}`]).catch(() => {
    throw new ConcordError('Source ref does not resolve to a commit', 'usage');
  });
  if (!oidPattern.test(sourceOid)) throw new ConcordError('Source must use Git SHA-1 object IDs', 'usage');
  const sourceTree = await git(['-C', source, 'rev-parse', `${sourceOid}^{tree}`]);
  const objectDirectory = await git(['-C', source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const entries = await treeEntries(source, sourceTree);
  const patterns = [...(options.excludes ?? [])];
  if (options.excludeFile) {
    let bytes: Buffer;
    try { bytes = await readFile(options.excludeFile); }
    catch { throw new ConcordError('Cannot read --exclude-file', 'usage'); }
    let file: string;
    try { file = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ConcordError('--exclude-file is not valid UTF-8', 'usage'); }
    patterns.push(...file.split(/\r?\n/).filter(line => line && !line.startsWith('#')));
  }
  const excludes = patterns.map(glob);
  const unmatchedPatterns = patterns.filter((_, index) => !entries.some(item => excludes[index].test(item.path)));
  if (options.requireMatch && unmatchedPatterns.length) {
    throw new ConcordError(`Exclusion glob matches no paths: ${unmatchedPatterns.join(', ')}`, 'usage');
  }
  const excluded = entries.filter(item => excludes.some(pattern => pattern.test(item.path)));
  const included = entries.filter(item => !excludes.some(pattern => pattern.test(item.path)));
  const scratch = await mkdtemp(join(tmpdir(), 'concord-import-'));
  try {
    await git(['init', '--quiet'], {}, scratch);
    const plumbing = { alternateObjectDirectory: objectDirectory };
    await git(['read-tree', '--empty'], plumbing, scratch);
    for (let i = 0; i < included.length; i += 100) {
      await git(['update-index', '--add', ...included.slice(i, i + 100).flatMap(item =>
        ['--cacheinfo', `${item.mode},${item.oid},${item.path}`])], plumbing, scratch);
    }
    const treeOid = await git(['write-tree'], plumbing, scratch);
    const actual = await treeEntries(scratch, treeOid, objectDirectory);
    if (actual.length !== included.length || actual.some((item, i) =>
      item.path !== included[i].path || item.mode !== included[i].mode || item.oid !== included[i].oid ||
      excludes.some(pattern => pattern.test(item.path)))) {
      throw new ConcordError('Excluded path verification failed; import aborted', 'server');
    }
    const summary: Record<string, unknown> = { fileCount: included.length,
      totalBytes: included.reduce((sum, item) => sum + item.bytes, 0),
      excludedPathCount: excluded.length, unmatchedPatterns, treeOid };
    if (options.verbose) summary.excludedPaths = excluded.map(item => item.path);
    if (options.printTree) return summary;
    if (!client) throw new ConcordError('CONCORD_URL and CONCORD_TOKEN are required', 'usage');
    const message = `Concord import\n\nSource repository: ${JSON.stringify(sourceName)}\nSource ref: ${JSON.stringify(options.ref)}\nSource commit: ${sourceOid}`;
    const headOid = await git(['commit-tree', treeOid, '-m', message], { ...plumbing, identity: true }, scratch);
    const root = `/repos/${encodeURIComponent(options.repo)}`;
    const repoBody = { name: options.repo, policyId: options.policyId, profileId: options.profileId };
    await poll('repository provisioning', () => client.request('POST', '/repos',
      { body: repoBody, idempotencyKey: idempotencyKey() }), result => data(result).status === 'ready');
    const repository = data(await client.request('GET', root));
    if (repository.observedCanonicalOid) {
      if (repository.observedCanonicalOid !== headOid) throw new ConcordError('Canonical main already differs from this import', 'conflict');
      return { ...summary, canonicalOid: headOid, repoId: options.repo, reconciled: true };
    }
    const intentKey = 'import:' + createHash('sha256').update(message).update('\0').update(patterns.join('\0')).digest('hex');
    const draftBody = { intentKey, intentText: message, baseOid: null, branch: `refs/heads/${branch}`,
      unitKeys: ['import:root'], dependencyChangeIds: [] };
    const changeResponse = await poll('seed fork', () => client.request('POST', `${root}/changes`,
      { body: draftBody, idempotencyKey: idempotencyKey() }), result => Boolean(data(result).provisioning) &&
      (data(result).provisioning as Record<string, unknown>).state === 'observed');
    const change = data(changeResponse);
    const storageName = field(change, 'candidateStorageName');
    const repoDetail = await client.request('GET', root);
    const access = data(await client.request('POST', `${root}/git-token`, {
      body: { storageName, scope: 'write', ttlSeconds: 300 },
      expectedVersion: version(repoDetail), idempotencyKey: idempotencyKey(),
    }));
    const remote = field(access, 'remote');
    const secret = typeof access.secret === 'string' ? access.secret : field(access, 'token');
    rememberCredential(secret);
    rejectCanonicalTarget(storageName, data(repoDetail).canonicalStorageName, remote,
      data(repoDetail).canonicalRemote);
    const assigned = new URL(remote);
    const localApi = new URL(client.baseUrl);
    if (assigned.protocol === 'file:' && ['localhost', '127.0.0.1', '::1'].includes(localApi.hostname) &&
        !assigned.username && !assigned.password && !assigned.search && !assigned.hash) {
      await git(['-c', 'core.hooksPath=/dev/null', 'push', '--no-follow-tags', '--', remote,
        `${headOid}:refs/heads/${branch}`], { token: secret, alternateObjectDirectory: objectDirectory }, scratch);
    } else {
      await pushCandidate(scratch, remote, branch, secret, headOid, objectDirectory);
    }
    const registerDetail = await client.request('GET', root);
    await client.request('POST', `${root}/branches`, { body: { storageName, ref: `refs/heads/${branch}`,
      observedHead: headOid, ownerId: field(change, 'authorId') },
      expectedVersion: version(registerDetail), idempotencyKey: idempotencyKey() });
    await poll('bootstrap request', async () => {
      const detail = await client.request('GET', root);
      return client.request('POST', `${root}/bootstrap`, { body: { seedStorageName: storageName,
        seedRef: `refs/heads/${branch}`, headOid, policyId: options.policyId, profileId: options.profileId },
      expectedVersion: version(detail), idempotencyKey: idempotencyKey() });
    }, result => data(result).state === 'requested');
    await poll('canonical main', () => client.request('GET', root), result => {
      const oid = data(result).observedCanonicalOid;
      if (oid && oid !== headOid) throw new ConcordError('Canonical main differs from imported root', 'conflict');
      return oid === headOid;
    }, 300_000);
    return { ...summary, canonicalOid: headOid, repoId: options.repo, reconciled: false };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
