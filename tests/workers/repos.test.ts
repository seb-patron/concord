import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import type { RepoCoordinator } from '../../src/coordinator';
import type { InspectionResult, ModuleContext } from '../../src/contracts';
import { repos } from '../../src/features/repos';
import { runners } from '../../src/features/runners';
import { digest as canonicalDigest } from '../../src/http';
import { ids } from '../../src/repos/model';
import { FakeStorage } from '../../src/storage/fake';
import { sqlState } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);
const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);
const d = 'd'.repeat(40);
const digest = `sha256:${'0'.repeat(64)}` as const;

async function create(name: string) {
  const response = await fetchApi(mutation('/v1/repos', { name, policyId: 'local-demo', profileId: 'local-demo' }, `create-${name}`));
  expect(response.status).toBe(201);
  return (await responseBody(response)).data;
}

async function fake(name: string, action: (provider: FakeStorage) => void) {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`));
  await runInDurableObject(stub, (_instance, state) => action(new FakeStorage(sqlState(state.storage.sql))));
}

function provisioningAtProvider(storage: FakeStorage, name: string, kind: 'ensure-repo' | 'fork') {
  const state = (storage as unknown as { state: { get: <T>(key: string) => T | null } }).state;
  const intents = state.get<Record<string, { storageName: string }>>('module:repos:provisioning');
  expect(intents?.[`${kind}:${name}`]?.storageName).toBe(name);
  return state;
}

describe('repository and change lifecycle', () => {
  it('accepts trusted policy unit key syntax used by the demo', () => {
    expect(ids(['file:dispatch.mjs', 'row:families:gamma'], 'unitKeys')).toEqual(['file:dispatch.mjs', 'row:families:gamma']);
  });

  it('creates a visible repo, allocates an owner seed fork, and records one bootstrap request', async () => {
    const repo = await create('seed_case');
    expect(repo).toMatchObject({ repoId: 'seed_case', status: 'ready', observedCanonicalOid: null });
    const listing = await fetchApi(apiRequest('/v1/repos'));
    expect((await responseBody(listing)).data.items).toContainEqual(expect.objectContaining({ repoId: 'seed_case' }));
    const detail = await fetchApi(apiRequest('/v1/repos/seed_case'));
    expect((await responseBody(detail)).data.observedCanonicalOid).toBeNull();
    expect((await fetchApi(mutation('/v1/repos/seed_case/changes', {
      intentKey: 'seed', intentText: 'first commit', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [],
    }, 'agent-seed', 'local-agent-a'))).status).toBe(403);
    const created = await fetchApi(mutation('/v1/repos/seed_case/changes', {
      intentKey: 'seed', intentText: 'first commit', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [],
    }, 'seed-change'));
    expect(created.status).toBe(201);
    const change = (await responseBody(created)).data;
    expect(change).toMatchObject({ status: 'draft', revision: 0, baseOid: null, authorId: 'owner' });
    expect((await fetchApi(mutation('/v1/repos/seed_case/git-token', {
      expectedVersion: 1, storageName: change.candidateStorageName, scope: 'write', ttlSeconds: 60,
    }, 'wrong-token', 'local-agent-a'))).status).toBe(403);
    const token = await fetchApi(mutation('/v1/repos/seed_case/git-token', {
      expectedVersion: 1, storageName: change.candidateStorageName, scope: 'write', ttlSeconds: 60,
    }, 'owner-token'));
    expect(token.status).toBe(200);
    expect((await responseBody(token)).data.secret).toMatch(/^fake-token:/);
    expect((await fetchApi(mutation('/v1/repos/seed_case/git-token', {
      expectedVersion: 1, storageName: repo.canonicalStorageName, scope: 'write', ttlSeconds: 60,
    }, 'canonical-token'))).status).toBe(403);
    await fake('seed_case', provider => {
      provider.putCommit(change.candidateStorageName, { oid: a, treeOid: b, parents: [] });
      expect(provider.conditionalUpdateRef(change.candidateStorageName, 'refs/heads/seed', null, a)).toBe(true);
    });
    const registered = await fetchApi(mutation('/v1/repos/seed_case/branches', {
      expectedVersion: 1, storageName: change.candidateStorageName, ref: 'refs/heads/seed', observedHead: a, ownerId: 'owner',
    }, 'register-seed'));
    expect(registered.status).toBe(201);
    const bootstrapBody = { expectedVersion: 2, seedStorageName: change.candidateStorageName, seedRef: 'refs/heads/seed', headOid: a, policyId: 'local-demo', profileId: 'local-demo' };
    const bootstrap = await fetchApi(mutation('/v1/repos/seed_case/bootstrap', bootstrapBody, 'bootstrap-seed'));
    expect(bootstrap.status).toBe(409);
    expect((await responseBody(bootstrap)).error.code).toBe('INVALID_JOB');
    const snapshot = await fetchApi(apiRequest('/v1/repos/seed_case/snapshot'));
    expect((await responseBody(snapshot)).data.projections.repos.bootstrap).toMatchObject({ changeId: change.changeId, headOid: a, status: 'blocked' });
    const retry = await fetchApi(mutation('/v1/repos/seed_case/bootstrap', { ...bootstrapBody, expectedVersion: 3 }, 'bootstrap-retry'));
    expect(retry.status).toBe(409);
    expect((await responseBody(retry)).error.code).toBe('INVALID_JOB');
    const secondSeed = await fetchApi(mutation('/v1/repos/seed_case/changes', {
      intentKey: 'seed-two', intentText: 'another initializer', baseOid: null, branch: 'refs/heads/seed-two', unitKeys: [], dependencyChangeIds: [],
    }, 'seed-two-change'));
    expect(secondSeed.status).toBe(201);
    const rival = (await responseBody(secondSeed)).data;
    await fake('seed_case', provider => {
      provider.putCommit(rival.candidateStorageName, { oid: c, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(rival.candidateStorageName, 'refs/heads/seed-two', null, c);
    });
    const rivalBranch = await fetchApi(mutation('/v1/repos/seed_case/branches', {
      expectedVersion: 4, storageName: rival.candidateStorageName, ref: 'refs/heads/seed-two', observedHead: c, ownerId: 'owner',
    }, 'register-rival'));
    expect(rivalBranch.status).toBe(201);
    const second = await fetchApi(mutation('/v1/repos/seed_case/bootstrap', {
      expectedVersion: 5, seedStorageName: rival.candidateStorageName, seedRef: 'refs/heads/seed-two', headOid: c,
      policyId: 'local-demo', profileId: 'local-demo',
    }, 'second-bootstrap'));
    expect(second.status).toBe(409);
    expect((await responseBody(second)).error.code).toBe('BOOTSTRAP_PENDING');
  });

  it('records only one bootstrap request from two concurrent owner initializers', async () => {
    await create('bootstrap_race_case');
    await fetchApi(apiRequest('/v1/repos/bootstrap_race_case'));
    const drafts: Array<{ changeId: string; candidateStorageName: string; ref: string }> = [];
    for (const [key, ref] of [['first', 'refs/heads/first'], ['second', 'refs/heads/second']] as const) {
      const response = await fetchApi(mutation('/v1/repos/bootstrap_race_case/changes', {
        intentKey: key, intentText: `seed ${key}`, baseOid: null, branch: ref, unitKeys: [], dependencyChangeIds: [],
      }, `draft-${key}`));
      expect(response.status).toBe(201);
      drafts.push({ ...(await responseBody(response)).data, ref });
    }
    await fake('bootstrap_race_case', provider => {
      for (const [index, draft] of drafts.entries()) {
        const head = index === 0 ? a : c;
        provider.putCommit(draft.candidateStorageName, { oid: head, treeOid: b, parents: [] });
        provider.conditionalUpdateRef(draft.candidateStorageName, draft.ref, null, head);
      }
    });
    for (const [index, draft] of drafts.entries()) {
      const response = await fetchApi(mutation('/v1/repos/bootstrap_race_case/branches', {
        expectedVersion: 2 + index, storageName: draft.candidateStorageName, ref: draft.ref,
        observedHead: index === 0 ? a : c, ownerId: 'owner',
      }, `branch-${index}`));
      expect(response.status).toBe(201);
    }
    const responses = await Promise.all(drafts.map((draft, index) => fetchApi(mutation('/v1/repos/bootstrap_race_case/bootstrap', {
      expectedVersion: 4, seedStorageName: draft.candidateStorageName, seedRef: draft.ref,
      headOid: index === 0 ? a : c, policyId: 'local-demo', profileId: 'local-demo',
    }, `race-${index}`))));
    expect(responses.map(response => response.status).sort()).toEqual([409, 409]);
    expect((await Promise.all(responses.map(response => responseBody(response)))).map(body => body.error.code).sort()).toEqual(['INVALID_JOB', 'STALE_VERSION']);
    const snapshot = await fetchApi(apiRequest('/v1/repos/bootstrap_race_case/snapshot'));
    const bootstrap = (await responseBody(snapshot)).data.projections.repos.bootstrap;
    expect(drafts.map(draft => draft.changeId)).toContain(bootstrap.changeId);
  });

  it('keeps one scratch intent and job while bootstrap storage is provisioning', async () => {
    const repoId = 'slow_scratch_case';
    await create(repoId);
    await fetchApi(apiRequest(`/v1/repos/${repoId}`));
    const created = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
      intentKey: 'seed', intentText: 'initial tree', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [],
    }, 'slow-scratch-change'));
    const change = (await responseBody(created)).data;
    await fake(repoId, provider => {
      provider.putCommit(change.candidateStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(change.candidateStorageName, 'refs/heads/seed', null, a);
    });
    expect((await fetchApi(mutation(`/v1/repos/${repoId}/branches`, {
      expectedVersion: 1, storageName: change.candidateStorageName, ref: 'refs/heads/seed', observedHead: a, ownerId: 'owner',
    }, 'slow-scratch-branch'))).status).toBe(201);

    const originalEnsure = FakeStorage.prototype.ensureRepo;
    const originalInfo = FakeStorage.prototype.info;
    const names: string[] = [];
    let ready = false;
    const ensure = vi.spyOn(FakeStorage.prototype, 'ensureRepo').mockImplementation(async function (this: FakeStorage, name) {
      if (name.startsWith('concord-s-')) {
        const state = provisioningAtProvider(this, name, 'ensure-repo');
        expect(state.get<{ jobId: string; scratchStorageName: string; status: string }>('module:repos:bootstrap'))
          .toMatchObject({ scratchStorageName: name, jobId: name.slice('concord-s-'.length), status: 'provisioning' });
        names.push(name);
      }
      const result = await originalEnsure.call(this, name);
      return name.startsWith('concord-s-') && !ready ? { name, remote: '', status: 'provisioning' } : result;
    });
    const info = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, name) {
      const result = await originalInfo.call(this, name);
      return result && name.startsWith('concord-s-') && !ready ? { name, remote: '', status: 'provisioning' } : result;
    });
    try {
      const body = { expectedVersion: 2, seedStorageName: change.candidateStorageName, seedRef: 'refs/heads/seed', headOid: a,
        policyId: 'local-demo', profileId: 'local-demo' };
      const first = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, body, 'slow-scratch-first'));
      expect(first.status).toBe(202);
      const pending = (await responseBody(first)).data;
      expect(pending.state).toBe('provisioning');
      const second = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, body, 'slow-scratch-second'));
      expect(second.status).toBe(202);
      expect((await responseBody(second)).data).toEqual(pending);
      const snapshot = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repoId}/snapshot`)))).data.projections.repos;
      expect(snapshot.bootstrap).toMatchObject({ jobId: pending.jobId, scratchStorageName: `concord-s-${pending.jobId}`, status: 'provisioning' });
      expect(snapshot.provisioning).toContainEqual(expect.objectContaining({ storageName: `concord-s-${pending.jobId}`, state: 'pending' }));
      expect(names).toEqual([`concord-s-${pending.jobId}`]);
      ready = true;
      const third = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, body, 'slow-scratch-ready'));
      expect(third.status).toBe(409);
      expect((await responseBody(third)).error.code).toBe('INVALID_JOB');
      const finished = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repoId}/snapshot`)))).data.projections.repos;
      expect(finished.bootstrap).toMatchObject({ jobId: pending.jobId, scratchStorageName: `concord-s-${pending.jobId}`, status: 'blocked' });
      expect(finished.provisioning).toContainEqual(expect.objectContaining({ storageName: `concord-s-${pending.jobId}`, state: 'observed' }));
      expect(names).toEqual([`concord-s-${pending.jobId}`]);
    } finally {
      info.mockRestore();
      ensure.mockRestore();
    }
  });

  it('rejects a closed owner seed even when its registered root ref remains current', async () => {
    const repoId = 'closed_seed_case';
    await create(repoId);
    const created = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
      intentKey: 'seed', intentText: 'initial tree', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [],
    }, 'closed-seed-create'));
    expect(created.status).toBe(201);
    const change = (await responseBody(created)).data;
    await fake(repoId, provider => {
      provider.putCommit(change.candidateStorageName, { oid: a, treeOid: b, parents: [] });
      expect(provider.conditionalUpdateRef(change.candidateStorageName, 'refs/heads/seed', null, a)).toBe(true);
    });
    const registered = await fetchApi(mutation(`/v1/repos/${repoId}/branches`, {
      expectedVersion: 1, storageName: change.candidateStorageName, ref: 'refs/heads/seed', observedHead: a, ownerId: 'owner',
    }, 'closed-seed-branch'));
    expect(registered.status).toBe(201);
    const closed = await fetchApi(mutation(`/v1/repos/${repoId}/changes/${change.changeId}/close`, { expectedVersion: 2 }, 'closed-seed-close'));
    expect(closed.status).toBe(200);
    expect((await responseBody(closed)).data.status).toBe('closed');
    const bootstrap = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, {
      expectedVersion: 3, seedStorageName: change.candidateStorageName, seedRef: 'refs/heads/seed', headOid: a,
      policyId: 'local-demo', profileId: 'local-demo',
    }, 'closed-seed-bootstrap'));
    expect(bootstrap.status).toBe(409);
    expect((await responseBody(bootstrap)).error.code).toBe('SEED_NOT_OPEN');
    const snapshot = await fetchApi(apiRequest(`/v1/repos/${repoId}/snapshot`));
    expect((await responseBody(snapshot)).data.projections.repos.bootstrap).toBeNull();
  });

  it('deduplicates changed-base tasks, verifies refs and objects, and leaves inspection pending when runner is unavailable', async () => {
    const repo = await create('publish_case');
    await fetchApi(apiRequest('/v1/repos/publish_case'));
    await fake('publish_case', provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      provider.putCommit(repo.canonicalStorageName, { oid: c, treeOid: b, parents: [a] });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const lateBootstrap = await fetchApi(mutation('/v1/repos/publish_case/bootstrap', {
      expectedVersion: 0, seedStorageName: 'unknown', seedRef: 'refs/heads/seed', headOid: b,
      policyId: 'local-demo', profileId: 'local-demo',
    }, 'late-bootstrap'));
    expect(lateBootstrap.status).toBe(409);
    expect((await responseBody(lateBootstrap)).error.code).toBe('ALREADY_INITIALIZED');
    const input = { intentKey: 'task', intentText: 'edit row', baseOid: a, branch: 'refs/heads/candidate', unitKeys: [], dependencyChangeIds: [] };
    const created = await fetchApi(mutation('/v1/repos/publish_case/changes', input, 'change-one', 'local-agent-a'));
    expect(created.status).toBe(201);
    const change = (await responseBody(created)).data;
    const repeated = await fetchApi(mutation('/v1/repos/publish_case/changes', { ...input, baseOid: c }, 'change-two', 'local-agent-a'));
    expect((await responseBody(repeated)).data.changeId).toBe(change.changeId);
    const repeatedWithMissingBase = await fetchApi(mutation('/v1/repos/publish_case/changes', { ...input, baseOid: d }, 'change-three', 'local-agent-a'));
    expect((await responseBody(repeatedWithMissingBase)).data.changeId).toBe(change.changeId);
    expect((await fetchApi(mutation('/v1/repos/publish_case/changes', { ...input, intentText: 'another task' }, 'change-conflict', 'local-agent-a'))).status).toBe(409);
    expect((await fetchApi(mutation('/v1/repos/publish_case/git-token', {
      expectedVersion: 1, storageName: change.candidateStorageName, scope: 'write', ttlSeconds: 60,
    }, 'other-token', 'local-agent-b'))).status).toBe(403);
    const missing = await fetchApi(mutation('/v1/repos/publish_case/branches', {
      expectedVersion: 1, storageName: change.candidateStorageName, ref: input.branch, observedHead: b, ownerId: 'agent-a',
    }, 'missing-head', 'local-agent-a'));
    expect(missing.status).toBe(422);
    await fake('publish_case', provider => {
      provider.putCommit(change.candidateStorageName, { oid: b, treeOid: c, parents: [a] });
      provider.conditionalUpdateRef(change.candidateStorageName, input.branch, null, b);
    });
    const registered = await fetchApi(mutation('/v1/repos/publish_case/branches', {
      expectedVersion: 1, storageName: change.candidateStorageName, ref: input.branch, observedHead: b, ownerId: 'agent-a',
    }, 'register-head', 'local-agent-a'));
    expect(registered.status).toBe(201);
    const badBase = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, {
      expectedVersion: 2, baseOid: d, headOid: b, branch: input.branch, unitKeys: [], leaseFences: {},
    }, 'bad-base', 'local-agent-a'));
    expect(badBase.status).toBe(422);
    const unknownUnit = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, {
      expectedVersion: 2, baseOid: a, headOid: b, branch: input.branch, unitKeys: ['file:unknown.mjs'], leaseFences: { 'file:unknown.mjs': 1 },
    }, 'unknown-unit', 'local-agent-a'));
    expect(unknownUnit.status).toBe(422);
    const publishBody = { expectedVersion: 2, baseOid: a, headOid: b, branch: input.branch, unitKeys: [], leaseFences: {} };
    const publish = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, publishBody, 'publish-one', 'local-agent-a'));
    expect(publish.status).toBe(409);
    expect((await responseBody(publish)).error.code).toBe('INVALID_JOB');
    const detail = await fetchApi(apiRequest(`/v1/repos/publish_case/changes/${change.changeId}`));
    expect((await responseBody(detail)).data).toMatchObject({ revision: 1, headOid: b, status: 'draft' });
    const repeatPublish = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, { ...publishBody, expectedVersion: 3 }, 'publish-again', 'local-agent-a'));
    expect(repeatPublish.status).toBe(409);
    expect((await responseBody(repeatPublish)).error.code).toBe('INVALID_JOB');
    const scheduleOriginal = runners.hooks['runners.schedule'];
    runners.hooks['runners.schedule'] = (context, job) => ({ status: 'eligible', version: context.version(), evidenceIds: [], value: { jobId: job.jobId } });
    try {
      const scheduled = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, { ...publishBody, expectedVersion: 3 }, 'publish-scheduled', 'local-agent-a'));
      expect(scheduled.status).toBe(202);
      expect((await responseBody(scheduled)).data.revision).toBe(1);
      const identical = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, { ...publishBody, expectedVersion: 3 }, 'publish-identical', 'local-agent-a'));
      expect(identical.status).toBe(200);
      expect((await responseBody(identical)).data.revision).toBe(1);
    } finally {
      runners.hooks['runners.schedule'] = scheduleOriginal;
    }
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:publish_case'));
    let inspection!: InspectionResult;
    await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
      const context = (instance as unknown as { context(name: 'repos', principal: object, repoId: string): ModuleContext }).context('repos', {
        tenantId: 'local', principalId: 'checker', roles: ['checker'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      }, 'publish_case');
      const pending = context.state.get<{ jobId: string; inputDigest: string }>(`inspection:${change.changeId}`)!;
      const reviewManifest = {
        coverage: 'complete' as const, changedUnits: [], dependencyScope: [], policyVersion: 1,
        policyDigest: digest, checkerDigest: digest, oracleDigest: digest, toolchainDigest: digest,
      };
      inspection = {
        kind: 'inspect-candidate', jobId: pending.jobId, attempt: 1, inputDigest: pending.inputDigest as typeof digest,
        fence: 1, sourceTreeOid: c, checkerDigest: digest, toolchainDigest: digest, oracleDigest: digest,
        environmentDigest: digest, durationMs: 1, log: '', resultDigest: digest,
        outcome: 'PASS', observedHeadOid: b, unitKeys: [], reviewManifestDigest: await canonicalDigest(reviewManifest),
        reviewManifest,
      };
      const { resultDigest: _resultDigest, ...preimage } = inspection;
      inspection.resultDigest = await canonicalDigest(preimage);
      const hook = repos.hooks['repos.inspectRevision']!;
      expect(hook(context, { ...inspection, observedHeadOid: d }).status).toBe('blocked');
      const forgedManifestDigest = { ...inspection, reviewManifestDigest: digest };
      const { resultDigest: _forgedResultDigest, ...forgedPreimage } = forgedManifestDigest;
      forgedManifestDigest.resultDigest = await canonicalDigest(forgedPreimage);
      expect(hook(context, forgedManifestDigest)).toMatchObject({ status: 'blocked', code: 'INSPECTION_MISMATCH' });
      expect(hook(context, { ...inspection, log: 'tampered' })).toMatchObject({ status: 'blocked', code: 'INSPECTION_MISMATCH' });
      const accepted = hook(context, inspection);
      expect(accepted.status).toBe('eligible');
      expect(hook(context, inspection).version).toBe(accepted.version);
    });
    const ready = await fetchApi(apiRequest(`/v1/repos/publish_case/changes/${change.changeId}`));
    expect((await responseBody(ready)).data.status).toBe('ready');
    await fake('publish_case', provider => {
      provider.putCommit(change.candidateStorageName, { oid: d, treeOid: c, parents: [b] });
      provider.conditionalUpdateRef(change.candidateStorageName, input.branch, b, d);
    });
    const moved = await fetchApi(mutation('/v1/repos/publish_case/branches', {
      expectedVersion: 4, storageName: change.candidateStorageName, ref: input.branch, observedHead: d, ownerId: 'agent-a',
    }, 'move-head', 'local-agent-a'));
    expect(moved.status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const context = (instance as unknown as { context(name: 'repos', principal: object, repoId: string): ModuleContext }).context('repos', {
        tenantId: 'local', principalId: 'checker', roles: ['checker'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      }, 'publish_case');
      expect(repos.hooks['repos.inspectRevision']!(context, inspection).status).toBe('blocked');
    });
    const stale = await fetchApi(apiRequest(`/v1/repos/publish_case/changes/${change.changeId}`));
    expect((await responseBody(stale)).data.status).toBe('draft');
    const closed = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/close`, { expectedVersion: 5 }, 'close', 'local-agent-a'));
    expect(closed.status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const context = (instance as unknown as { context(name: 'repos', principal: object, repoId: string): ModuleContext }).context('repos', {
        tenantId: 'local', principalId: 'checker', roles: ['checker'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      }, 'publish_case');
      expect(repos.hooks['repos.inspectRevision']!(context, inspection).status).toBe('blocked');
    });
    const afterClose = await fetchApi(mutation('/v1/repos/publish_case/changes', input, 'after-close', 'local-agent-a'));
    expect(afterClose.status).toBe(409);
    const attemptTwo = await fetchApi(mutation('/v1/repos/publish_case/changes', { ...input, attempt: 2 }, 'attempt-two', 'local-agent-a'));
    expect(attemptTwo.status).toBe(201);
  });

  it('keeps a failed fork visible and reconciles a retry without allocating another change', async () => {
    await create('retry_case');
    await fetchApi(apiRequest('/v1/repos/retry_case'));
    await fake('retry_case', provider => provider.failNext('fork'));
    const body = { intentKey: 'retry-task', intentText: 'seed after failure', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [] };
    const first = await fetchApi(mutation('/v1/repos/retry_case/changes', body, 'retry-first'));
    expect(first.status).toBe(503);
    const firstListing = await fetchApi(apiRequest('/v1/repos/retry_case/changes'));
    const failed = (await responseBody(firstListing)).data.items[0];
    expect(failed.status).toBe('draft');
    const detail = await fetchApi(apiRequest(`/v1/repos/retry_case/changes/${failed.changeId}`));
    expect((await responseBody(detail)).data.provisioning.state).toBe('failed');
    const second = await fetchApi(mutation('/v1/repos/retry_case/changes', body, 'retry-first'));
    expect(second.status).toBe(200);
    const retried = (await responseBody(second)).data;
    expect(retried.changeId).toBe(failed.changeId);
    expect(retried.candidateStorageName).toBe(failed.candidateStorageName);
    expect(retried.provisioning.state).toBe('observed');
    const listing = await fetchApi(apiRequest('/v1/repos/retry_case/changes'));
    expect((await responseBody(listing)).data.items).toHaveLength(1);
  });

  it('reuses one candidate fork while the provider is provisioning it', async () => {
    const repoId = 'slow_fork_case';
    await create(repoId);
    await fetchApi(apiRequest(`/v1/repos/${repoId}`));
    const originalFork = FakeStorage.prototype.fork;
    const originalInfo = FakeStorage.prototype.info;
    const names: string[] = [];
    let ready = false;
    const fork = vi.spyOn(FakeStorage.prototype, 'fork').mockImplementation(async function (this: FakeStorage, source, name) {
      provisioningAtProvider(this, name, 'fork');
      names.push(name);
      const result = await originalFork.call(this, source, name);
      return ready ? result : { name, remote: '', status: 'provisioning' };
    });
    const info = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, name) {
      const result = await originalInfo.call(this, name);
      return result && name.startsWith('concord-f-') && !ready ? { name, remote: '', status: 'provisioning' } : result;
    });
    try {
      const body = { intentKey: 'slow-task', intentText: 'seed later', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [] };
      const first = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, body, 'slow-fork-first'));
      expect(first.status).toBe(202);
      const pending = (await responseBody(first)).data;
      expect(pending.provisioning.state).toBe('pending');
      const second = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, body, 'slow-fork-second'));
      expect(second.status).toBe(202);
      expect((await responseBody(second)).data.changeId).toBe(pending.changeId);
      expect(names).toEqual([pending.candidateStorageName]);
      ready = true;
      const third = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, body, 'slow-fork-ready'));
      expect(third.status).toBe(200);
      expect((await responseBody(third)).data).toMatchObject({ changeId: pending.changeId, candidateStorageName: pending.candidateStorageName,
        provisioning: { state: 'observed' } });
      expect(names).toEqual([pending.candidateStorageName]);
    } finally {
      info.mockRestore();
      fork.mockRestore();
    }
  });

  it('reuses one canonical repository while the provider is provisioning it', async () => {
    const originalEnsure = FakeStorage.prototype.ensureRepo;
    const originalInfo = FakeStorage.prototype.info;
    const names: string[] = [];
    let ready = false;
    const ensure = vi.spyOn(FakeStorage.prototype, 'ensureRepo').mockImplementation(async function (this: FakeStorage, name) {
      if (name.startsWith('concord-r-')) {
        provisioningAtProvider(this, name, 'ensure-repo');
        names.push(name);
      }
      const result = await originalEnsure.call(this, name);
      return name.startsWith('concord-r-') && !ready ? { name, remote: '', status: 'provisioning' } : result;
    });
    const info = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, name) {
      const result = await originalInfo.call(this, name);
      return result && name.startsWith('concord-r-') && !ready ? { name, remote: '', status: 'provisioning' } : result;
    });
    try {
      const body = { name: 'slow_canonical_case', policyId: 'local-demo', profileId: 'local-demo' };
      const first = await fetchApi(mutation('/v1/repos', body, 'slow-canonical-first'));
      expect(first.status).toBe(202);
      const pending = (await responseBody(first)).data;
      expect(pending.status).toBe('provisioning');
      const second = await fetchApi(mutation('/v1/repos', body, 'slow-canonical-second'));
      expect(second.status).toBe(202);
      expect((await responseBody(second)).data.canonicalStorageName).toBe(pending.canonicalStorageName);
      expect(names).toEqual([pending.canonicalStorageName]);
      ready = true;
      const third = await fetchApi(mutation('/v1/repos', body, 'slow-canonical-ready'));
      expect(third.status).toBe(201);
      expect((await responseBody(third)).data).toMatchObject({ canonicalStorageName: pending.canonicalStorageName, status: 'ready' });
      expect(names).toEqual([pending.canonicalStorageName]);
    } finally {
      info.mockRestore();
      ensure.mockRestore();
    }
  });

  it('records repository provisioning before work and retries a failed provider call by storage name', async () => {
    await fetchApi(apiRequest('/v1/repos'));
    const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    await runInDurableObject(stub, (_instance, state) => new FakeStorage(sqlState(state.storage.sql)).failNext('ensureRepo'));
    const body = { name: 'provider_retry_case', policyId: 'local-demo', profileId: 'local-demo' };
    const first = await fetchApi(mutation('/v1/repos', body, 'provider-failure'));
    expect(first.status).toBe(503);
    const listing = await fetchApi(apiRequest('/v1/repos'));
    const blocked = (await responseBody(listing)).data.items.find((item: { repoId: string }) => item.repoId === body.name);
    expect(blocked.status).toBe('blocked');
    const retry = await fetchApi(mutation('/v1/repos', body, 'provider-failure'));
    expect(retry.status).toBe(201);
    const ready = (await responseBody(retry)).data;
    expect(ready.status).toBe('ready');
    expect(ready.canonicalStorageName).toBe(blocked.canonicalStorageName);
  });

  it('blocks a previously observed repository that disappears instead of recreating an empty replacement', async () => {
    const repo = await create('missing_provider_case');
    const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    await runInDurableObject(stub, (_instance, state) => sqlState(state.storage.sql).delete(`fake:repo:${repo.canonicalStorageName}`));
    const body = { name: repo.repoId, policyId: repo.policyId, profileId: repo.profileId };
    const repeat = await fetchApi(mutation('/v1/repos', body, 'missing-provider'));
    expect(repeat.status).toBe(503);
    const again = await fetchApi(mutation('/v1/repos', body, 'missing-provider'));
    expect(again.status).toBe(503);
    await runInDurableObject(stub, (_instance, state) => {
      expect(sqlState(state.storage.sql).get(`fake:repo:${repo.canonicalStorageName}`)).toBeNull();
    });
    const listing = await fetchApi(apiRequest('/v1/repos'));
    expect((await responseBody(listing)).data.items).toContainEqual(expect.objectContaining({ repoId: repo.repoId, status: 'blocked' }));
  });
});
