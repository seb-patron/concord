#!/usr/bin/env node
import { createHash } from 'node:crypto';
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
interface RunState { schemaVersion: 1; mappings: Record<string, Mapping> }
interface Change { changeId: string; intentKey: string; intentText: string; branch: string; unitKeys: string[]; baseOid: string | null; headOid: string | null; revision: number; status: string; version: number; candidateStorageName: string }
interface Repo { canonicalStorageName: string; observedCanonicalOid: string | null; version: number; status: string }
interface Lease { changeId: string; unitKey: string; fence: number; state: string; expiresAt: number }
interface Verdict { verdictId: string; revision: number; decision: string }
type Envelope<T> = { data: T; version: number };
const terminal = new Set(['merged', 'superseded', 'closed']);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const path = (repo: string) => `/repos/${encodeURIComponent(repo)}`;

function fixtureIdentity(fixture: AwMockFixture): string { return `${fixture.project}/${fixture.taskId}/${fixture.explicitAttempt}`; }
function intentKey(fixture: AwMockFixture): string { return `aw-mock:${sha([fixture.project, fixture.taskId])}`; }
function branch(fixture: AwMockFixture): string { return `refs/heads/aw-mock/${sha([fixture.project, fixture.taskId]).slice(0, 24)}`; }
function fingerprint(fixture: AwMockFixture): string { return sha([fixture.intent, [...fixture.unitKeys].sort()]); }
function keyFor(identity: string, operation: string): string { return `aw-mock:${sha([identity, operation])}`; }

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
async function findIntent(client: ConcordClient, fixture: AwMockFixture): Promise<Change | undefined> {
  let cursor: string | null = null;
  let latest: Change | undefined;
  const seen = new Set<string>();
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page: { items: Change[]; nextCursor: string | null } = (await client.request<Envelope<{ items: Change[]; nextCursor: string | null }>>('GET', `${path(fixture.project)}/changes${query}`)).data;
    for (const item of page.items) if (item.intentKey === intentKey(fixture)) latest = item;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('INVALID_CHANGE_CURSOR');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return latest;
}

async function leaseFences(client: ConcordClient, fixture: AwMockFixture, mapping: Mapping): Promise<Record<string, number> | null> {
  if (mapping.leaseFences) return mapping.leaseFences;
  const data = (await client.request<Envelope<{ items: Lease[] }>>('GET', `${path(fixture.project)}/leases`)).data;
  const fences: Record<string, number> = {};
  for (const key of fixture.unitKeys) {
    const lease = data.items.find(item => item.changeId === mapping.changeId && item.unitKey === key && item.state === 'active' && item.expiresAt > Date.now());
    if (!lease) return null;
    fences[key] = lease.fence;
  }
  return fences;
}

/** Produces an actual descendant commit using only a local bridge-backed Git remote. */
async function makeCandidate(client: ConcordClient, fixture: AwMockFixture, repo: Repo, change: Change): Promise<{ headOid: string; remote: string; worktree: string; cleanup(): Promise<void> }> {
  if (!change.baseOid || !/^[a-f0-9]{40}$/.test(change.baseOid)) throw new Error('LOCAL_GIT_BASE_REQUIRED');
  const root = path(fixture.project);
  const token = (await client.request<Envelope<{ remote: string; secret: string }>>('POST', `${root}/git-token`, {
    body: { storageName: repo.canonicalStorageName, scope: 'read', ttlSeconds: 300 }, expectedVersion: await currentVersion(client, fixture),
    idempotencyKey: keyFor(fixtureIdentity(fixture), 'canonical-read'),
  })).data;
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

async function publishCandidate(client: ConcordClient, fixture: AwMockFixture, mapping: Mapping, repo: Repo, change: Change): Promise<string> {
  const candidate = await makeCandidate(client, fixture, repo, change);
  try {
    const root = path(fixture.project);
    const fork = (await client.request<Envelope<{ remote: string; secret: string }>>('POST', `${root}/git-token`, {
      body: { storageName: change.candidateStorageName, scope: 'write', ttlSeconds: 300 }, expectedVersion: await currentVersion(client, fixture),
      idempotencyKey: keyFor(mapping.identity, 'fork-write'),
    })).data;
    rememberCredential(fork.secret);
    const remote = new URL(fork.remote);
    if (remote.protocol !== 'file:' || remote.hostname || remote.search || remote.hash || remote.href === candidate.remote) throw new Error('LOCAL_GIT_BRIDGE_REQUIRED');
    await git(['push', '--no-follow-tags', '--', remote.href, `${candidate.headOid}:${change.branch}`], {}, candidate.worktree);
    await client.request('POST', `${root}/branches`, {
      body: { storageName: change.candidateStorageName, ref: change.branch, observedHead: candidate.headOid, ownerId: 'mock-aw' },
      expectedVersion: await currentVersion(client, fixture),
      idempotencyKey: keyFor(mapping.identity, 'register-branch'),
    });
    const latest = await getChangeEnvelope(client, fixture, mapping.changeId);
    await client.request('POST', `${root}/changes/${encodeURIComponent(mapping.changeId)}/publish`, {
      body: { baseOid: latest.data.baseOid, headOid: candidate.headOid, branch: latest.data.branch, unitKeys: latest.data.unitKeys, leaseFences: mapping.leaseFences },
      expectedVersion: latest.version, idempotencyKey: keyFor(mapping.identity, 'publish'),
    });
    return candidate.headOid;
  } finally { await candidate.cleanup(); }
}

async function pollAndMaybeQueue(client: ConcordClient, fixture: AwMockFixture, mapping: Mapping): Promise<Change> {
  const viewed = await getChangeEnvelope(client, fixture, mapping.changeId);
  const change = viewed.data;
  ensureTask(change, fixture);
  if (change.status === 'blocked') {
    mapping.phase = 'blocked'; mapping.block = { code: 'CHECKER_BLOCKED', reason: 'Concord marked the candidate blocked; inspect the change and checker evidence.' };
    return change;
  }
  if (terminal.has(change.status) || change.status === 'queued' || change.status === 'checking') return change;
  if (!change.headOid) return change;
  const verdicts = (await client.request<Envelope<{ items: Verdict[] }>>('GET', `${path(fixture.project)}/changes/${encodeURIComponent(mapping.changeId)}/verdicts`)).data;
  const approval = verdicts.items.find(item => item.revision === change.revision && item.decision === 'approve');
  if (!approval) { mapping.phase = 'awaiting_review'; return change; }
  const fences = await leaseFences(client, fixture, mapping);
  if (!fences) { mapping.phase = 'blocked'; mapping.block = { code: 'LEASE_STALE', reason: 'Active lease fences are unavailable; an operator must renew or reclaim before enqueue.' }; return change; }
  await client.request('POST', `${path(fixture.project)}/queue/enqueue`, {
    body: { changeId: mapping.changeId, verdictId: approval.verdictId, leaseFences: fences },
    expectedVersion: await currentVersion(client, fixture), idempotencyKey: keyFor(mapping.identity, `enqueue:${approval.verdictId}`),
  });
  mapping.phase = 'queued';
  return change;
}

export async function runAwMock(fixturePath: string, statePath: string, client: ConcordClient): Promise<ReturnType<typeof output>> {
  const fixture = parseAwFixture(JSON.parse(await readFile(fixturePath, 'utf8')));
  if (dirname(resolve(statePath)) !== dirname(resolve(fixturePath)) || resolve(statePath) === resolve(fixturePath)) throw new Error('Run-state must be a separate file in the fixture demo directory');
  const state = await loadState(statePath);
  const identity = fixtureIdentity(fixture);
  let mapping = state.mappings[identity];
  const remember = async () => { state.mappings[identity] = mapping!; await saveState(statePath, state); };
  if (mapping) {
    if (mapping.fingerprint !== fingerprint(fixture)) throw new ConcordError('Intent key reused with different task content', 'conflict', 409, { error: { code: 'INTENT_CONFLICT', message: 'Intent key reused with different task content' } });
    mapping.observedBaseOid = fixture.observedBaseOid;
    try {
      if (mapping.phase === 'blocked') {
        const change = await getChange(client, fixture, mapping.changeId);
        ensureTask(change, fixture);
        if (terminal.has(change.status)) mapping.block = { code: 'ATTEMPT_REQUIRED', reason: 'Terminal change requires the next explicitAttempt.' };
        mapping.headOid = change.headOid ?? mapping.headOid;
        await remember();
        return output(fixture, mapping, client, change);
      }
      const change = await pollAndMaybeQueue(client, fixture, mapping);
      if (terminal.has(change.status)) { mapping.phase = 'blocked'; mapping.block = { code: 'ATTEMPT_REQUIRED', reason: 'Terminal change requires the next explicitAttempt.' }; }
      await remember();
      return output(fixture, mapping, client, change);
    } catch (error) { mapping.phase = 'blocked'; mapping.block = blockFor(error); await remember(); return output(fixture, mapping, client); }
  }
  const root = path(fixture.project);
  const existing = await findIntent(client, fixture);
  if (existing) ensureTask(existing, fixture);
  const repo = (await client.request<Envelope<Repo>>('GET', root)).data;
  if (repo.status !== 'ready' || !repo.observedCanonicalOid) throw new Error('READY_CANONICAL_REPO_REQUIRED');
  const created = (await client.request<Envelope<Change>>('POST', `${root}/changes`, {
    body: { intentKey: intentKey(fixture), intentText: fixture.intent, baseOid: existing && !terminal.has(existing.status) ? existing.baseOid : repo.observedCanonicalOid,
      branch: branch(fixture), unitKeys: [...fixture.unitKeys].sort(), dependencyChangeIds: [], attempt: fixture.explicitAttempt },
    idempotencyKey: keyFor(identity, 'create'),
  })).data;
  ensureTask(created, fixture);
  mapping = { identity, intentKey: intentKey(fixture), fingerprint: fingerprint(fixture), changeId: created.changeId,
    phase: 'opened', observedBaseOid: fixture.observedBaseOid };
  await remember();
  if (existing && existing.changeId === created.changeId) {
    if (terminal.has(created.status)) { mapping.phase = 'blocked'; mapping.block = { code: 'ATTEMPT_REQUIRED', reason: 'Terminal change requires the next explicitAttempt.' }; await remember(); }
    return output(fixture, mapping, client, created);
  }
  try {
    const claim = (await client.request<Envelope<{ leases: Lease[] }>>('POST', `${root}/leases`, {
      body: { changeId: created.changeId, unitKeys: fixture.unitKeys, intentText: fixture.intent, ttlSeconds: 120 },
      expectedVersion: created.version, idempotencyKey: keyFor(identity, 'claim'),
    })).data;
    mapping.leaseFences = Object.fromEntries(claim.leases.map(item => [item.unitKey, item.fence]));
    mapping.phase = 'leased'; await remember();
    const latestRepo = (await client.request<Envelope<Repo>>('GET', root)).data;
    const latestChange = await getChange(client, fixture, created.changeId);
    mapping.headOid = await publishCandidate(client, fixture, mapping, latestRepo, latestChange);
    mapping.phase = 'awaiting_review'; await remember();
    const change = await pollAndMaybeQueue(client, fixture, mapping);
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
