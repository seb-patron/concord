#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConcordClient, ConcordError, redactOutput, rememberCredential } from '../cli/client.ts';
import { git } from '../cli/git.ts';
import { parseAwFixture, type AwMockFixture } from './aw-schema.ts';

type Phase = 'opened' | 'leased' | 'awaiting_review' | 'queued' | 'blocked';
interface Block { code: string; reason: string; status?: number; details?: unknown }
interface Mapping {
  identity: string; intentKey: string; fingerprint: string; changeId: string;
  phase: Phase; observedBaseOid?: string; leaseFences?: Record<string, number>;
  headOid?: string; block?: Block;
}
interface PendingRequest { path: string; body: string; key: string }
interface RunState { schemaVersion: 1; mappings: Record<string, Mapping>; pendingRequest?: PendingRequest }
interface Change { changeId: string; authorId: string; intentKey: string; intentText: string; branch: string; unitKeys: string[]; baseOid: string | null; headOid: string | null; revision: number; status: string; version: number; candidateStorageName: string }
interface Repo { canonicalStorageName: string; observedCanonicalOid: string | null; version: number; status: string }
interface Lease { changeId: string; unitKey: string; fence: number; state: string; expiresAt: number }
interface Verdict { verdictId: string; revision: number; decision: string }
interface QueueEntry { entryId?: string; changeId: string; admittedRevision: number; state: string; blockedReason?: string | null }
interface ServerState { change: Change; attempt: number; queue: QueueEntry[] | null }
type ReconcileDecision = { kind: 'reuse'; queued: boolean } | { kind: 'refuse'; block: Block };
const workerPrincipal = 'mock-aw';
type Envelope<T> = { data: T; version: number };
const terminal = new Set(['merged', 'superseded', 'closed']);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const path = (repo: string) => `/repos/${encodeURIComponent(repo)}`;

function fixtureIdentity(fixture: AwMockFixture): string { return `${fixture.project}/${fixture.taskId}/${fixture.explicitAttempt}`; }
function intentKey(fixture: AwMockFixture): string { return `aw-mock:${sha([fixture.project, fixture.taskId])}`; }
function branch(fixture: AwMockFixture): string { return `refs/heads/aw-mock/${sha([fixture.project, fixture.taskId]).slice(0, 24)}`; }
function fingerprint(fixture: AwMockFixture): string { return sha([fixture.intent, [...fixture.unitKeys].sort()]); }
type Post = <T = unknown>(route: string, body: Record<string, unknown>, expectedVersion?: number) => Promise<T>;

function blockFor(error: unknown): Block {
  if (error instanceof ConcordError) {
    const payload = error.payload as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
    return { code: payload?.error?.code ?? error.kind.toUpperCase(), reason: payload?.error?.message ?? error.message,
      ...(error.status === undefined ? {} : { status: error.status }), ...(payload?.error?.details === undefined ? {} : { details: payload.error.details }) };
  }
  return { code: 'MOCK_ERROR', reason: error instanceof Error ? error.message : String(error) };
}

async function loadState(statePath: string): Promise<RunState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || (parsed as RunState).schemaVersion !== 1 || !(parsed as RunState).mappings || Array.isArray((parsed as RunState).mappings)) throw new Error('Invalid run-state format');
    return parsed as RunState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, mappings: {} };
    throw error;
  }
}

async function saveState(statePath: string, state: RunState): Promise<void> {
  const staged = join(dirname(statePath), `.${basename(statePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(staged, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(staged, statePath);
  } finally { await rm(staged, { force: true }); }
}

function ensureTask(change: Change, fixture: AwMockFixture): void {
  if (change.intentKey !== intentKey(fixture) || change.intentText !== fixture.intent || change.branch !== branch(fixture) ||
    JSON.stringify([...change.unitKeys].sort()) !== JSON.stringify([...fixture.unitKeys].sort())) {
    throw new ConcordError('Active intent has different task content', 'conflict', 409, { error: { code: 'INTENT_CONFLICT', message: 'Active intent has different task content' } });
  }
}

export function reconcile(serverState: ServerState, fixture: AwMockFixture, identity: string): ReconcileDecision {
  const { change, attempt, queue } = serverState;
  const refuse = (code: string, reason: string, details?: unknown): ReconcileDecision =>
    ({ kind: 'refuse', block: { code, reason, status: 409, ...(details === undefined ? {} : { details }) } });
  if (change.authorId !== identity) return refuse('INTENT_OWNED', 'Intent key belongs to another author');
  if (change.intentKey !== intentKey(fixture) || change.intentText !== fixture.intent || change.branch !== branch(fixture) ||
    JSON.stringify([...change.unitKeys].sort()) !== JSON.stringify([...fixture.unitKeys].sort()))
    return refuse('INTENT_CONFLICT', 'Active intent has different task content');
  if (attempt !== fixture.explicitAttempt)
    return refuse('ATTEMPT_CONFLICT', 'Explicit attempt differs from the server intent', { serverAttempt: attempt, explicitAttempt: fixture.explicitAttempt });
  if (terminal.has(change.status)) return refuse('ATTEMPT_REQUIRED', 'Terminal change requires the next explicitAttempt.');
  if (change.status === 'blocked') return refuse('CHECKER_BLOCKED', 'Concord marked the candidate blocked; inspect the change and checker evidence.');
  const active = queue?.find(entry => entry.changeId === change.changeId && entry.admittedRevision === change.revision);
  if (active?.state === 'blocked') return refuse('QUEUE_BLOCKED', 'Concord queue blocked the active revision.', active);
  if (change.status === 'queued' || change.status === 'checking') {
    if (!queue) return refuse('QUEUE_UNAVAILABLE', 'Queue state is unavailable for an admitted change.');
    if (!active) return refuse('QUEUE_REVISION_MISMATCH', 'No queue entry matches the active revision.',
      { revision: change.revision, entries: queue.filter(entry => entry.changeId === change.changeId) });
    if (active.state !== 'waiting' && active.state !== 'checking')
      return refuse('QUEUE_STATE_CONFLICT', 'Queue entry is not awaiting admission or checking.', active);
    return { kind: 'reuse', queued: true };
  }
  return { kind: 'reuse', queued: active?.state === 'waiting' || active?.state === 'checking' };
}

function refusalError(block: Block): ConcordError {
  return new ConcordError(block.reason, 'conflict', block.status, { error: { code: block.code, message: block.reason, details: block.details } });
}

function output(fixture: AwMockFixture, mapping: Mapping, client: ConcordClient, change?: Change) {
  const root = `${client.baseUrl}/v1${path(fixture.project)}`;
  const changeUrl = `${root}/changes/${encodeURIComponent(mapping.changeId)}`;
  return {
    mock: true, identity: mapping.identity, workerLabel: fixture.workerLabel, changeId: mapping.changeId,
    phase: mapping.phase, concordStatus: change?.status ?? null, revision: change?.revision ?? null,
    observedBaseOid: mapping.observedBaseOid ?? null, headOid: mapping.headOid ?? change?.headOid ?? null,
    operations: {
      prepareWorktree: { repoId: fixture.project, changeId: mapping.changeId, url: root, fixtureWorktree: fixture.worktree, mode: 'temporary synthetic Git commit' },
      openChange: { changeId: mapping.changeId, url: changeUrl },
      reviewStatus: { changeId: mapping.changeId, url: `${changeUrl}/verdicts` },
      requestLanding: { changeId: mapping.changeId, url: `${root}/queue/enqueue`, state: mapping.phase === 'queued' ? 'requested' : 'deferred' },
    },
    ...(mapping.block ? { blocked: mapping.block } : {}),
  };
}

async function getChange(client: ConcordClient, fixture: AwMockFixture, id: string): Promise<Change> {
  return (await getChangeEnvelope(client, fixture, id)).data;
}
async function getChangeEnvelope(client: ConcordClient, fixture: AwMockFixture, id: string): Promise<Envelope<Change>> {
  return client.request<Envelope<Change>>('GET', `${path(fixture.project)}/changes/${encodeURIComponent(id)}`);
}
async function currentVersion(client: ConcordClient, fixture: AwMockFixture): Promise<number> {
  return (await client.request<Envelope<Repo>>('GET', path(fixture.project))).version;
}
async function findIntent(client: ConcordClient, fixture: AwMockFixture): Promise<{ change: Change; attempt: number } | undefined> {
  let cursor: string | null = null;
  let latest: Change | undefined;
  let attempt = 0;
  const seen = new Set<string>();
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page: { items: Change[]; nextCursor: string | null } = (await client.request<Envelope<{ items: Change[]; nextCursor: string | null }>>('GET', `${path(fixture.project)}/changes${query}`)).data;
    for (const item of page.items) if (item.intentKey === intentKey(fixture)) { latest = item; attempt++; }
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('INVALID_CHANGE_CURSOR');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return latest ? { change: latest, attempt } : undefined;
}

async function leaseFences(client: ConcordClient, fixture: AwMockFixture, mapping: Mapping): Promise<Record<string, number> | null> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  const fences: Record<string, number> = {};
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const data: { items: Lease[]; nextCursor?: string | null } = (await client.request<Envelope<{ items: Lease[]; nextCursor?: string | null }>>('GET', `${path(fixture.project)}/leases${query}`)).data;
    for (const lease of data.items) if (lease.changeId === mapping.changeId && fixture.unitKeys.includes(lease.unitKey) &&
      (lease.state === 'active' || lease.state === 'reserved') && lease.expiresAt > Date.now()) fences[lease.unitKey] = lease.fence;
    cursor = data.nextCursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error('INVALID_LEASE_CURSOR');
    if (cursor) seen.add(cursor);
  } while (cursor && Object.keys(fences).length < fixture.unitKeys.length);
  if (fixture.unitKeys.every(key => fences[key] !== undefined)) return fences;
  if (Object.keys(fences).length) throw new ConcordError('A partial live lease set must be resolved before a new claim', 'conflict', 409,
    { error: { code: 'LEASE_PARTIAL', message: 'A partial live lease set must be resolved before a new claim' } });
  return null;
}

async function claimLeases(client: ConcordClient, fixture: AwMockFixture, change: Change, post: Post): Promise<Record<string, number>> {
  const claim = (await post<Envelope<{ leases: Lease[] }>>(`${path(fixture.project)}/leases`,
    { changeId: change.changeId, unitKeys: fixture.unitKeys, intentText: fixture.intent, ttlSeconds: 120 },
    await currentVersion(client, fixture))).data;
  return Object.fromEntries(claim.leases.map(item => [item.unitKey, item.fence]));
}

async function queueEntries(client: ConcordClient, fixture: AwMockFixture): Promise<QueueEntry[] | null> {
  try {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const entries: QueueEntry[] = [];
    do {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const queue: { items: QueueEntry[]; nextCursor?: string | null } = (await client.request<Envelope<{ items: QueueEntry[]; nextCursor?: string | null }>>('GET', `${path(fixture.project)}/queue${query}`)).data;
      entries.push(...queue.items);
      cursor = queue.nextCursor ?? null;
      if (cursor && seen.has(cursor)) throw new Error('INVALID_QUEUE_CURSOR');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return entries;
  } catch (error) {
    // The optional queue module has no readable state until it is installed.
    if (error instanceof ConcordError && error.status === 501) return null;
    throw error;
  }
}

async function registeredHead(client: ConcordClient, fixture: AwMockFixture, change: Change): Promise<string | null> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page: { items: Array<{ storageName: string; ref: string; observedHead: string | null }>; nextCursor: string | null } =
      (await client.request<Envelope<{ items: Array<{ storageName: string; ref: string; observedHead: string | null }>; nextCursor: string | null }>>('GET', `${path(fixture.project)}/branches${query}`)).data;
    const branch = page.items.find(item => item.storageName === change.candidateStorageName && item.ref === change.branch);
    if (branch?.observedHead) return branch.observedHead;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('INVALID_BRANCH_CURSOR');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return null;
}

/** Produces an actual descendant commit using only a local bridge-backed Git remote. */
async function makeCandidate(client: ConcordClient, fixture: AwMockFixture, repo: Repo, change: Change, post: Post): Promise<{ headOid: string; remote: string; worktree: string; cleanup(): Promise<void> }> {
  if (!change.baseOid || !/^[a-f0-9]{40}$/.test(change.baseOid)) throw new Error('LOCAL_GIT_BASE_REQUIRED');
  const root = path(fixture.project);
  const token = (await post<Envelope<{ remote: string; secret: string }>>(`${root}/git-token`,
    { storageName: repo.canonicalStorageName, scope: 'read', ttlSeconds: 300 }, await currentVersion(client, fixture))).data;
  rememberCredential(token.secret);
  const remote = new URL(token.remote);
  if (remote.protocol !== 'file:' || remote.hostname || remote.search || remote.hash) throw new Error('LOCAL_GIT_BRIDGE_REQUIRED');
  const temporary = await mkdtemp(join(tmpdir(), 'concord-aw-mock-'));
  const worktree = join(temporary, 'candidate');
  try {
    await git(['clone', '--no-checkout', '--single-branch', '--branch', 'main', '--', remote.href, worktree]);
    const actualBase = await git(['rev-parse', '--verify', `${change.baseOid}^{commit}`], {}, worktree);
    if (actualBase !== change.baseOid) throw new Error('CANONICAL_BASE_UNAVAILABLE');
    await git(['read-tree', actualBase], {}, worktree);
    const edit = join(temporary, 'aw-mock-change.txt');
    await writeFile(edit, 'Concord AW mock: pre-authored synthetic candidate edit.\n');
    const blob = await git(['hash-object', '-w', edit], {}, worktree);
    await git(['update-index', '--add', '--cacheinfo', `100644,${blob},aw-mock-change.txt`], {}, worktree);
    const tree = await git(['write-tree'], {}, worktree);
    const headOid = await git(['-c', 'user.name=Concord AW Mock', '-c', 'user.email=aw-mock@example.invalid', 'commit-tree', tree, '-p', actualBase, '-m', 'AW mock synthetic edit'], {}, worktree);
    await git(['update-ref', 'HEAD', headOid], {}, worktree);
    return { headOid, remote: remote.href, worktree, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function publishCandidate(client: ConcordClient, fixture: AwMockFixture, mapping: Mapping, repo: Repo, change: Change, post: Post): Promise<string> {
  const candidate = await makeCandidate(client, fixture, repo, change, post);
  try {
    const root = path(fixture.project);
    const fork = (await post<Envelope<{ remote: string; secret: string }>>(`${root}/git-token`,
      { storageName: change.candidateStorageName, scope: 'write', ttlSeconds: 300 }, await currentVersion(client, fixture))).data;
    rememberCredential(fork.secret);
    const remote = new URL(fork.remote);
    if (remote.protocol !== 'file:' || remote.hostname || remote.search || remote.hash || remote.href === candidate.remote) throw new Error('LOCAL_GIT_BRIDGE_REQUIRED');
    await git(['push', '--no-follow-tags', '--', remote.href, `${candidate.headOid}:${change.branch}`], {}, candidate.worktree);
    await post(`${root}/branches`, { storageName: change.candidateStorageName, ref: change.branch, observedHead: candidate.headOid, ownerId: 'mock-aw' },
      await currentVersion(client, fixture));
    const latest = await getChangeEnvelope(client, fixture, mapping.changeId);
    await post(`${root}/changes/${encodeURIComponent(mapping.changeId)}/publish`,
      { baseOid: latest.data.baseOid, headOid: candidate.headOid, branch: latest.data.branch, unitKeys: latest.data.unitKeys, leaseFences: mapping.leaseFences }, latest.version);
    return candidate.headOid;
  } finally { await candidate.cleanup(); }
}

async function pollAndMaybeQueue(client: ConcordClient, fixture: AwMockFixture, mapping: Mapping, post: Post): Promise<Change> {
  const viewed = await getChangeEnvelope(client, fixture, mapping.changeId);
  const change = viewed.data;
  const decision = reconcile({ change, attempt: fixture.explicitAttempt, queue: await queueEntries(client, fixture) }, fixture, workerPrincipal);
  if (decision.kind === 'refuse') {
    mapping.phase = 'blocked'; mapping.block = decision.block;
    return change;
  }
  if (decision.queued) { mapping.phase = 'queued'; mapping.block = undefined; return change; }
  if (!change.headOid) return change;
  const verdicts = (await client.request<Envelope<{ items: Verdict[] }>>('GET', `${path(fixture.project)}/changes/${encodeURIComponent(mapping.changeId)}/verdicts`)).data;
  const approval = verdicts.items.find(item => item.revision === change.revision && item.decision === 'approve');
  if (!approval) { mapping.phase = 'awaiting_review'; return change; }
  let fences = await leaseFences(client, fixture, mapping);
  if (!fences && (change.status === 'draft' || change.status === 'ready')) {
    fences = await claimLeases(client, fixture, change, post);
  }
  if (!fences) { mapping.phase = 'blocked'; mapping.block = { code: 'LEASE_STALE', reason: 'Active lease fences are unavailable; an operator must renew or reclaim before enqueue.' }; return change; }
  mapping.leaseFences = fences;
  await post(`${path(fixture.project)}/queue/enqueue`,
    { changeId: mapping.changeId, verdictId: approval.verdictId, leaseFences: fences }, await currentVersion(client, fixture));
  mapping.phase = 'queued';
  return change;
}

async function resume(client: ConcordClient, fixture: AwMockFixture, mapping: Mapping, change: Change, attempt: number, remember: () => Promise<void>, post: Post): Promise<Change> {
  const decision = reconcile({ change, attempt, queue: await queueEntries(client, fixture) }, fixture, workerPrincipal);
  mapping.headOid = change.headOid ?? undefined;
  if (decision.kind === 'refuse') {
    mapping.phase = 'blocked'; mapping.block = decision.block;
    return change;
  }
  if (decision.queued) {
    mapping.phase = 'queued'; mapping.block = undefined;
    return change;
  }
  if (change.headOid) {
    mapping.phase = 'awaiting_review'; mapping.block = undefined;
    mapping.leaseFences = await leaseFences(client, fixture, mapping) ?? undefined;
    return pollAndMaybeQueue(client, fixture, mapping, post);
  }
  let fences = await leaseFences(client, fixture, mapping);
  if (!fences) {
    fences = await claimLeases(client, fixture, change, post);
  }
  mapping.leaseFences = fences;
  mapping.phase = 'leased'; mapping.block = undefined; await remember();
  const latestRepo = (await client.request<Envelope<Repo>>('GET', path(fixture.project))).data;
  const latestChange = await getChange(client, fixture, change.changeId);
  if (latestChange.headOid || !['draft', 'ready'].includes(latestChange.status)) return resume(client, fixture, mapping, latestChange, attempt, remember, post);
  const head = await registeredHead(client, fixture, latestChange);
  if (head) {
    const viewed = await getChangeEnvelope(client, fixture, mapping.changeId);
    await post(`${path(fixture.project)}/changes/${encodeURIComponent(mapping.changeId)}/publish`,
      { baseOid: viewed.data.baseOid, headOid: head, branch: viewed.data.branch, unitKeys: viewed.data.unitKeys, leaseFences: fences }, viewed.version);
    mapping.headOid = head;
  } else mapping.headOid = await publishCandidate(client, fixture, mapping, latestRepo, latestChange, post);
  mapping.phase = 'awaiting_review'; await remember();
  return pollAndMaybeQueue(client, fixture, mapping, post);
}

export async function runAwMock(fixturePath: string, statePath: string, client: ConcordClient): Promise<ReturnType<typeof output>> {
  const fixture = parseAwFixture(JSON.parse(await readFile(fixturePath, 'utf8')));
  if (dirname(resolve(statePath)) !== dirname(resolve(fixturePath)) || resolve(statePath) === resolve(fixturePath)) throw new Error('Run-state must be a separate file in the fixture demo directory');
  const state = await loadState(statePath);
  const identity = fixtureIdentity(fixture);
  // Persist the nonce before sending. Only a transport failure can leave an
  // in-flight request to retry; every HTTP response retires that nonce.
  const post: Post = async <T>(route: string, body: Record<string, unknown>, expectedVersion?: number): Promise<T> => {
    const wireBody = JSON.stringify(expectedVersion === undefined ? body : { ...body, expectedVersion });
    if (state.pendingRequest?.path !== route || state.pendingRequest.body !== wireBody) {
      state.pendingRequest = { path: route, body: wireBody, key: randomUUID() };
      await saveState(statePath, state);
    }
    try {
      const response = await client.request<T>('POST', route, { body, expectedVersion, idempotencyKey: state.pendingRequest.key, retryMode: 'transport-only' });
      state.pendingRequest = undefined;
      await saveState(statePath, state);
      return response;
    } catch (error) {
      if (error instanceof ConcordError && error.kind !== 'transport') {
        state.pendingRequest = undefined;
        await saveState(statePath, state);
      }
      throw error;
    }
  };
  let mapping = state.mappings[identity];
  const remember = async () => { state.mappings[identity] = mapping!; await saveState(statePath, state); };
  const root = path(fixture.project);
  const found = await findIntent(client, fixture);
  const existing = found?.change;
  if (existing?.authorId !== undefined && existing.authorId !== workerPrincipal) throw refusalError({ code: 'INTENT_OWNED', reason: 'Intent key belongs to another author', status: 409 });
  if (existing) ensureTask(existing, fixture);
  const serverAttempt = found?.attempt ?? 0;
  if (serverAttempt !== fixture.explicitAttempt && !(existing && terminal.has(existing.status) && serverAttempt + 1 === fixture.explicitAttempt) &&
    !(serverAttempt === 0 && fixture.explicitAttempt === 1)) {
    throw new ConcordError('Explicit attempt differs from the server intent', 'conflict', 409,
      { error: { code: 'ATTEMPT_CONFLICT', message: 'Explicit attempt differs from the server intent', details: { serverAttempt, explicitAttempt: fixture.explicitAttempt } } });
  }
  if (mapping && mapping.fingerprint !== fingerprint(fixture)) throw new ConcordError('Intent key reused with different task content', 'conflict', 409,
    { error: { code: 'INTENT_CONFLICT', message: 'Intent key reused with different task content' } });
  const repo = (await client.request<Envelope<Repo>>('GET', root)).data;
  if (repo.status !== 'ready' || !repo.observedCanonicalOid) throw new Error('READY_CANONICAL_REPO_REQUIRED');
  let created: Change;
  if (existing && (serverAttempt === fixture.explicitAttempt)) created = existing;
  else {
    const reply = (await post<Envelope<Change>>(`${root}/changes`,
      { intentKey: intentKey(fixture), intentText: fixture.intent, baseOid: repo.observedCanonicalOid,
        branch: branch(fixture), unitKeys: [...fixture.unitKeys].sort(), dependencyChangeIds: [], attempt: fixture.explicitAttempt })).data;
    created = reply;
  }
  ensureTask(created, fixture);
  if (created.authorId !== workerPrincipal) throw refusalError({ code: 'INTENT_OWNED', reason: 'Intent key belongs to another author', status: 409 });
  if (!mapping || mapping.changeId !== created.changeId) mapping = { identity, intentKey: intentKey(fixture), fingerprint: fingerprint(fixture), changeId: created.changeId,
    phase: 'opened', observedBaseOid: fixture.observedBaseOid };
  else mapping.observedBaseOid = fixture.observedBaseOid;
  await remember();
  try {
    const change = await resume(client, fixture, mapping, created, fixture.explicitAttempt, remember, post);
    await remember();
    return output(fixture, mapping, client, change);
  } catch (error) {
    mapping.phase = 'blocked'; mapping.block = blockFor(error); await remember();
    try { mapping.headOid = (await getChange(client, fixture, mapping.changeId)).headOid ?? mapping.headOid; await remember(); } catch { /* retain the original refusal */ }
    return output(fixture, mapping, client);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureIndex = args.indexOf('--fixture'); const stateIndex = args.indexOf('--run-state');
  if (args.length !== 4 || fixtureIndex < 0 || stateIndex < 0 || !args[fixtureIndex + 1] || !args[stateIndex + 1]) throw new Error('Usage: npm run aw-mock -- --fixture PATH --run-state PATH');
  const url = process.env.CONCORD_URL; const token = process.env.CONCORD_TOKEN;
  if (!url || !token) throw new Error('CONCORD_URL and CONCORD_TOKEN are required');
  const origin = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('AW mock only accepts a local Concord Worker');
  const client = new ConcordClient({ url, token });
  process.stdout.write(`${JSON.stringify(redactOutput(await runAwMock(args[fixtureIndex + 1], args[stateIndex + 1], client)))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`${JSON.stringify(redactOutput({ mock: true, error: blockFor(error) }))}\n`);
    process.exitCode = error instanceof ConcordError ? error.exitCode : 2;
  });
}
