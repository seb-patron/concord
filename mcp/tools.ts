import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConcordClient, ConcordError, idempotencyKey, redactOutput, rememberCredentialsIn } from '../cli/client.ts';
import { assertCommit, assertHeadBasedOn, git, rejectCanonicalTarget, resolveHead, validateRemote } from '../cli/git.ts';

type Args = Record<string, unknown>;
type Shape = Record<string, Record<string, unknown>>;
const s = { type: 'string' };
const n = { type: 'integer', minimum: 0 };
const strings = { type: 'array', items: s };
const unitKeys = { ...strings, maxItems: 128 };
const fences = { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } };
function tool(name: string, description: string, properties: Shape, required: string[] = []): Tool {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const repo = { repoId: s };
const change = { ...repo, changeId: s };
export const tools: Tool[] = [
  tool('repo_list', 'List authorized repositories.', { cursor: s }),
  tool('repo_get', 'Get repository detail and canonical head.', repo, ['repoId']),
  tool('repo_context', 'Get repository snapshot, policy state, changes, leases, queue and findings.', repo, ['repoId']),
  tool('change_create', 'Create a candidate change. Use the canonical head as baseOid.', { ...repo, intentKey: s, intentText: s, baseOid: s, branch: s, unitKeys, dependencyChangeIds: strings, attempt: n, issueNumber: { type: 'integer', minimum: 1 }, idempotencyKey: s }, ['repoId', 'intentKey', 'intentText', 'baseOid', 'branch', 'unitKeys']),
  tool('issue_create', 'Create an issue in the repository inbox.', { ...repo, title: s, body: s, labels: strings, milestoneId: s, allowedFiles: strings, idempotencyKey: s }, ['repoId', 'title', 'body']),
  tool('issue_get', 'Get an issue and its linked changes.', { ...repo, issueNumber: { type: 'integer', minimum: 1 } }, ['repoId', 'issueNumber']),
  tool('issue_list', 'List issues with optional state, label, milestone and cursor.', { ...repo, state: { type: 'string', enum: ['open', 'closed'] }, label: s, milestoneId: s, cursor: s }, ['repoId']),
  tool('issue_close', 'Close an issue with a reason and current issue version.', { ...repo, issueNumber: { type: 'integer', minimum: 1 }, reason: s, expectedVersion: n, idempotencyKey: s }, ['repoId', 'issueNumber', 'reason', 'expectedVersion']),
  tool('milestone_list', 'List milestones with issue and landed change progress.', { ...repo, cursor: s }, ['repoId']),
  tool('milestone_create', 'Create a milestone in the repository.', { ...repo, title: s, description: s, dueDate: s, idempotencyKey: s }, ['repoId', 'title']),
  tool('change_status', 'Get change status, revision, base, branch and candidate storage.', change, ['repoId', 'changeId']),
  tool('change_list', 'List changes with optional caller and status filters.', { ...repo, mine: { type: 'boolean' }, status: s, cursor: s }, ['repoId']),
  tool('change_close', 'Close your change and release its leases using the current repository version. An optional reason is forwarded to the API.', { ...change, reason: s, idempotencyKey: s }, ['repoId', 'changeId']),
  tool('lease_claim', 'Claim semantic units before editing. A conflict is a normal result. TTL is bounded by trusted maxLeaseHoldSeconds (default 14400).', { ...change, unitKeys: strings, intentText: s, ttlSeconds: { type: 'integer', minimum: 1, maximum: 86400 }, idempotencyKey: s }, ['repoId', 'changeId', 'unitKeys', 'intentText']),
  tool('lease_release', 'Release one lease using its current fence.', { ...repo, leaseId: s, fence: n, idempotencyKey: s }, ['repoId', 'leaseId', 'fence']),
  tool('lease_renew', 'Renew every live lease of a change in one call. Fences stay the same and holds are never shortened; renew before remainingSeconds drops below about 100.', { ...change, ttlSeconds: { type: 'integer', minimum: 1, maximum: 86400 }, idempotencyKey: s }, ['repoId', 'changeId']),
  tool('lease_force_release', 'Force-release a lease as an owner, recording the audit reason.', { ...repo, leaseId: s, reason: s, idempotencyKey: s }, ['repoId', 'leaseId', 'reason']),
  tool('lease_list', 'List active leases and recent refusals.', { ...repo, cursor: s }, ['repoId']),
  tool('change_checkout', 'Fetch the candidate revision, or create a new local branch at its base, with a short-lived, process-local Git credential.', { ...change, worktree: s }, ['repoId', 'changeId', 'worktree']),
  tool('change_publish', 'Verify and push local HEAD to the assigned candidate fork, then publish the revision.', { ...change, worktree: s, leaseFences: fences, idempotencyKey: s }, ['repoId', 'changeId', 'worktree', 'leaseFences']),
  tool('findings_list', 'List findings for a change.', { ...change, cursor: s }, ['repoId', 'changeId']),
  tool('review_verdict_submit', 'Submit an independent reviewer verdict for the inspected revision.', { ...change, revision: n, reviewManifestDigest: s, findingSetVersion: n, decision: { type: 'string', enum: ['approve', 'reject'] }, evidenceDigest: s, idempotencyKey: s }, ['repoId', 'changeId', 'revision', 'reviewManifestDigest', 'findingSetVersion', 'decision', 'evidenceDigest']),
  tool('queue_enqueue', 'Enqueue an approved change with its live lease fences.', { ...change, verdictId: s, leaseFences: fences, idempotencyKey: s }, ['repoId', 'changeId', 'verdictId', 'leaseFences']),
  tool('queue_status', 'Get queue entries, generation and result status.', repo, ['repoId']),
  tool('events_since', 'Read repository events after a sequence cursor.', { ...repo, after: n, cursor: s }, ['repoId']),
  tool('repo_metrics', 'Read measured repository flow metrics for a UTC window of at most 31 days.', { ...repo, since: s, until: s }, ['repoId', 'since', 'until']),
];

function value(args: Args, key: string): string {
  const item = args[key];
  if (typeof item !== 'string' || !item || !/^[A-Za-z0-9_-]{1,128}$/.test(item)) throw new ConcordError(`${key} must be an ID`, 'usage');
  return encodeURIComponent(item);
}
function root(args: Args): string { return `/repos/${value(args, 'repoId')}`; }
function path(args: Args): string { return `${root(args)}/changes/${value(args, 'changeId')}`; }
function query(name: string, item: unknown): string { return typeof item === 'string' && item ? `?${name}=${encodeURIComponent(item)}` : ''; }
function data(response: unknown): Record<string, unknown> {
  const item = (response as { data?: unknown })?.data;
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ConcordError('Concord returned an invalid data envelope', 'server');
  return item as Record<string, unknown>;
}
function version(response: unknown): number {
  const result = (response as { version?: unknown })?.version;
  if (!Number.isSafeInteger(result)) throw new ConcordError('Concord did not return a version', 'server');
  return result as number;
}
function field(object: Record<string, unknown>, key: string): string {
  const result = object[key];
  if (typeof result !== 'string' || !result) throw new ConcordError(`Concord did not return ${key}`, 'server');
  return result;
}
function accessToken(object: Record<string, unknown>): string {
  const token = object.token ?? object.secret ?? object.plaintext;
  if (typeof token !== 'string' || !token) throw new ConcordError('Concord did not return a Git token', 'server');
  return token;
}
function mutation(client: ConcordClient, url: string, body: Args, expectedVersion?: number, key?: unknown): Promise<unknown> {
  return client.request('POST', url, { body, expectedVersion, idempotencyKey: idempotencyKey(typeof key === 'string' ? key : undefined) });
}
async function currentVersion(client: ConcordClient, args: Args): Promise<number> {
  return version(await client.request('GET', `${root(args)}/snapshot`));
}
async function gitAccess(client: ConcordClient, args: Args, storageName: string, scope: 'read' | 'write', repoVersion: number): Promise<{ remote: string; token: string }> {
  const access = data(await mutation(client, `${root(args)}/git-token`, { storageName, scope, ttlSeconds: 300 }, repoVersion));
  const remote = field(access, 'remote');
  const token = accessToken(access);
  // The local bridge issues file remotes; only accept them when the API itself is loopback.
  const server = new URL(client.baseUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(server.hostname);
  const parsed = new URL(remote);
  if (local && parsed.protocol === 'file:' && !parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
    return { remote, token };
  }
  validateRemote(remote);
  return { remote, token };
}
function safeRemote(remote: string): string {
  const url = new URL(remote);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function changeBranch(changeId: string, branch: string): string {
  const name = branch.replace(/^refs\/heads\//, '');
  if (!name || name.startsWith('-') || name.includes('..') || name.includes('@{') || name.includes('\\') || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new ConcordError('Server supplied an invalid candidate branch', 'server');
  }
  return `concord/${changeId}/${name}`;
}

async function changeWorktree(root: string, changeId: string, localBranch: string, mustExist: boolean): Promise<{ root: string; worktree: string; exists: boolean }> {
  const top = await realpath(resolve(await git(['rev-parse', '--show-toplevel'], {}, root)));
  const requestedRoot = resolve(root);
  if (top !== await realpath(requestedRoot)) throw new ConcordError('worktree must be the root of the shared Git repository', 'usage');
  const worktree = join(requestedRoot, '.concord', 'changes', changeId);
  let exists = false;
  try {
    const actualTop = await realpath(resolve(await git(['rev-parse', '--show-toplevel'], {}, worktree)));
    exists = actualTop === await realpath(worktree);
  } catch { /* The change worktree has not been created. */ }
  if (mustExist && !exists) throw new ConcordError('Change worktree is missing; run change_checkout first', 'usage');
  if (exists) {
    const common = await realpath(resolve(worktree, await git(['rev-parse', '--git-common-dir'], {}, worktree)));
    const rootCommon = await realpath(resolve(root, await git(['rev-parse', '--git-common-dir'], {}, root)));
    if (common !== rootCommon || await git(['symbolic-ref', 'HEAD'], {}, worktree) !== `refs/heads/${localBranch}`) {
      throw new ConcordError('Change worktree is not on its assigned branch', 'usage');
    }
  }
  return { root: requestedRoot, worktree, exists };
}

export async function callTool(client: ConcordClient, name: string, args: Args): Promise<unknown> {
  rememberCredentialsIn(args);
  const r = name === 'repo_list' ? '' : root(args);
  const p = () => path(args);
  let result: unknown;
  switch (name) {
    case 'repo_list': result = await client.request('GET', `/repos${query('cursor', args.cursor)}`); break;
    case 'repo_get': result = await client.request('GET', r); break;
    case 'repo_context': result = await client.request('GET', `${r}/snapshot`); break;
    case 'change_create': {
      const { intentKey, intentText, baseOid, branch, unitKeys, dependencyChangeIds = [], attempt, issueNumber } = args;
      result = await mutation(client, `${r}/changes`, { intentKey, intentText, baseOid, branch, unitKeys, dependencyChangeIds, ...(attempt === undefined ? {} : { attempt }), ...(issueNumber === undefined ? {} : { issueNumber }) }, undefined, args.idempotencyKey);
      break;
    }
    case 'issue_create': result = await mutation(client, `${r}/issues`, { title: args.title, body: args.body, labels: args.labels ?? [], ...(args.milestoneId ? { milestoneId: args.milestoneId } : {}), ...(args.allowedFiles ? { allowedFiles: args.allowedFiles } : {}) }, undefined, args.idempotencyKey); break;
    case 'issue_get': result = await client.request('GET', `${r}/issues/${args.issueNumber}`); break;
    case 'issue_list': { const params = new URLSearchParams(); for (const key of ['state', 'label', 'milestoneId', 'cursor']) if (typeof args[key] === 'string') params.set(key, args[key] as string); result = await client.request('GET', `${r}/issues${params.size ? '?' + params : ''}`); break; }
    case 'issue_close': result = await mutation(client, `${r}/issues/${args.issueNumber}/close`, { reason: args.reason }, args.expectedVersion as number, args.idempotencyKey); break;
    case 'milestone_list': result = await client.request('GET', `${r}/milestones${query('cursor', args.cursor)}`); break;
    case 'milestone_create': result = await mutation(client, `${r}/milestones`, { title: args.title, ...(args.description !== undefined ? { description: args.description } : {}), ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}) }, undefined, args.idempotencyKey); break;
    case 'change_status': result = await client.request('GET', p()); break;
    case 'change_list': {
      const params = new URLSearchParams();
      if (typeof args.cursor === 'string' && args.cursor) params.set('cursor', args.cursor);
      const response = data(await client.request('GET', `${r}/changes${params.size ? `?${params}` : ''}`));
      if (!Array.isArray(response.items)) throw new ConcordError('Concord returned an invalid changes page', 'server');
      const principalId = args.mine === true ? field(data(await client.request('GET', '/me')), 'principalId') : undefined;
      const statuses = typeof args.status === 'string' ? new Set(args.status.split(',').map(status => status.trim()).filter(Boolean)) : undefined;
      result = { ...response, items: (response.items as Record<string, unknown>[]).filter(item =>
        (principalId === undefined || item.authorId === principalId) && (!statuses?.size || (typeof item.status === 'string' && statuses.has(item.status)))) };
      break;
    }
    case 'change_close': {
      const body = args.reason === undefined ? {} : { reason: args.reason as string };
      result = await mutation(client, `${p()}/close`, body, await currentVersion(client, args), args.idempotencyKey);
      break;
    }
    case 'lease_claim': {
      const body = { changeId: args.changeId, unitKeys: args.unitKeys, intentText: args.intentText, ttlSeconds: args.ttlSeconds ?? 120 };
      try { result = await mutation(client, `${r}/leases`, body, await currentVersion(client, args), args.idempotencyKey); }
      catch (error) {
        if (error instanceof ConcordError && error.status === 409 && (error.payload as { error?: { code?: string } } | undefined)?.error?.code === 'LEASE_CONFLICT') {
          result = { conflict: true, ...(error.payload as object) };
          break;
        }
        throw error;
      }
      break;
    }
    case 'lease_release': result = await mutation(client, `${r}/leases/${value(args, 'leaseId')}/release`, { fence: args.fence }, await currentVersion(client, args), args.idempotencyKey); break;
    case 'lease_renew': result = await mutation(client, `${r}/leases/renew-batch`, { changeId: args.changeId, ttlSeconds: args.ttlSeconds ?? 300 }, undefined, args.idempotencyKey); break;
    case 'lease_force_release': result = await mutation(client, `${r}/leases/${value(args, 'leaseId')}/force-release`, { reason: args.reason }, await currentVersion(client, args), args.idempotencyKey); break;
    case 'lease_list': result = await client.request('GET', `${r}/leases${query('cursor', args.cursor)}`); break;
    case 'change_checkout': {
      const change = data(await client.request('GET', p()));
      const repository = await client.request('GET', r);
      const access = await gitAccess(client, args, field(change, 'candidateStorageName'), 'read', version(repository));
      const branch = field(change, 'branch');
      const worktree = field(args, 'worktree');
      const localBranch = changeBranch(value(args, 'changeId'), branch);
      const target = await changeWorktree(worktree, value(args, 'changeId'), localBranch, false);
      const existing = change.headOid === null
        ? await git(['ls-remote', '--heads', '--', access.remote, branch], { token: access.token }, worktree)
        : branch;
      const forkExists = change.headOid !== null || existing.split('\n').some(line => line.endsWith(`\t${branch}`));
      let startRef = field(change, 'baseOid');
      const gitCwd = target.exists ? target.worktree : worktree;
      if (!forkExists) {
        const baseOid = field(change, 'baseOid');
        try {
          await git(['fetch', '--no-tags', '--', access.remote, baseOid], { token: access.token }, gitCwd);
        } catch {
          const canonical = await gitAccess(client, args, field(data(repository), 'canonicalStorageName'), 'read', version(repository));
          await git(['fetch', '--no-tags', '--', canonical.remote, baseOid], { token: canonical.token }, gitCwd);
        }
        await assertCommit(gitCwd, baseOid);
      } else {
        await git(['fetch', '--no-tags', '--', access.remote, `${branch}:refs/remotes/${localBranch}`], { token: access.token }, gitCwd);
        startRef = `refs/remotes/${localBranch}`;
        await assertHeadBasedOn(gitCwd, field(change, 'baseOid'), await git(['rev-parse', '--verify', `${startRef}^{commit}`], {}, gitCwd));
      }
      if (!target.exists) {
        await mkdir(join(target.root, '.concord', 'changes'), { recursive: true });
        await git(['worktree', 'add', '-b', localBranch, '--', target.worktree, startRef], {}, worktree);
      }
      await assertHeadBasedOn(target.worktree, field(change, 'baseOid'), await resolveHead(target.worktree));
      result = { fetched: true, changeId: args.changeId, worktree: target.worktree, branch, remote: safeRemote(access.remote) };
      break;
    }
    case 'change_publish': {
      const change = data(await client.request('GET', p()));
      const repository = await client.request('GET', r);
      const repoData = data(repository);
      const storageName = field(change, 'candidateStorageName');
      if (storageName === repoData.canonicalStorageName) throw new ConcordError('Refusing canonical Git target', 'server');
      const baseOid = field(change, 'baseOid');
      const branch = field(change, 'branch');
      const worktree = field(args, 'worktree');
      const localBranch = changeBranch(value(args, 'changeId'), branch);
      const target = await changeWorktree(worktree, value(args, 'changeId'), localBranch, true);
      const headOid = await resolveHead(target.worktree);
      await assertCommit(target.worktree, baseOid);
      await assertHeadBasedOn(target.worktree, baseOid, headOid);
      const access = await gitAccess(client, args, storageName, 'write', version(repository));
      rejectCanonicalTarget(storageName, repoData.canonicalStorageName, access.remote, repoData.canonicalRemote);
      await git(['-c', 'core.hooksPath=/dev/null', 'push', '--no-follow-tags', '--', access.remote, `${headOid}:${branch}`], { token: access.token }, target.worktree);
      await mutation(client, `${r}/branches`, { storageName, ref: branch, observedHead: headOid, ownerId: field(change, 'authorId') }, await currentVersion(client, args));
      result = await mutation(client, `${p()}/publish`, { baseOid, headOid, branch, unitKeys: change.unitKeys, leaseFences: args.leaseFences }, version(await client.request('GET', p())), args.idempotencyKey);
      break;
    }
    case 'findings_list': result = await client.request('GET', `${p()}/findings${query('cursor', args.cursor)}`); break;
    case 'review_verdict_submit': {
      const { revision, reviewManifestDigest, findingSetVersion, decision, evidenceDigest } = args;
      result = await mutation(client, `${p()}/verdicts`, { revision, reviewManifestDigest, findingSetVersion, decision, evidenceDigest }, await currentVersion(client, args), args.idempotencyKey);
      break;
    }
    case 'queue_enqueue': result = await mutation(client, `${r}/queue/enqueue`, { changeId: args.changeId, verdictId: args.verdictId, leaseFences: args.leaseFences }, await currentVersion(client, args), args.idempotencyKey); break;
    case 'queue_status': result = await client.request('GET', `${r}/queue`); break;
    case 'events_since': result = await client.request('GET', `${r}/events${args.after === undefined ? query('cursor', args.cursor) : `?after=${args.after}`}`); break;
    case 'repo_metrics': result = await client.request('GET', `${r}/metrics?${new URLSearchParams({ since: String(args.since), until: String(args.until) })}`); break;
    default: throw new ConcordError('Unknown MCP tool', 'usage');
  }
  return redactOutput(result);
}
