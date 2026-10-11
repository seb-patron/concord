import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { BootstrapHandoff, ChangeView, Gate, Job, ModuleContext, Principal, PromotionResult, StackResult } from '../../src/contracts';
import type { RepoCoordinator } from '../../src/coordinator';
import { repos } from '../../src/features/repos';
import { queue } from '../../src/features/queue';
import { leases } from '../../src/features/leases';
import { runners } from '../../src/features/runners';
import { findings } from '../../src/features/findings';
import { verdicts } from '../../src/features/verdicts';
import { digest } from '../../src/http';
import { localFixtureConfig, sqlState } from '../../src/state';
import { FakeStorage } from '../../src/storage/fake';
import { arbitrate, accepted } from '../../src/queue/arbitrate';
import { advanceDiagnosis, dependencyClosure, startDiagnosis } from '../../src/queue/plan';
import { apiRequest, mutation, responseBody } from '../helpers';

const oid = (char: string) => char.repeat(40);
const main = oid('1');
const principal: Principal = { tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
let counter = 0;
const freshRepo = () => `queue_${++counter}`;
const gate = <T>(value: T): Gate<T> => ({ status: 'eligible', version: 1, evidenceIds: [], value });

interface Harness {
  repoId: string; views: Map<string, ChangeView>; findingsVersion: Map<string, number>;
  jobs: Job[]; releases: string[]; reserveAllowed: boolean;
  fetch(path: string, body?: Record<string, unknown>, key?: string): Promise<{ response: Response; body: any }>;
  state(): Promise<any>;
  seed(name: string, base?: string | null): Promise<void>;
  put(name: string, ref: string, next: string, old?: string | null, tree?: string): Promise<boolean>;
  tick(flush?: boolean): Promise<void>;
  deliver(job: Job, outcome: StackResult['outcome'], options?: { composed?: string; tree?: string; gates?: Array<{ gateId: string; outcome: StackResult['outcome'] }>; score?: { matched: number; total: number } }): Promise<Gate<{ promotionId: string | null }>>;
  promoteResult(job: Job, outcome: PromotionResult['outcome'], observed: string | null): Promise<Gate<{ promotionId: string | null }>>;
  ageTicket(ms: number): Promise<void>;
  bootstrap(seed: BootstrapHandoff, asOwner?: boolean): Promise<Gate<{ stackId: string }>>;
}

const original = {
  changeView: repos.changeView,
  reserve: leases.hooks['leases.reserve'], release: leases.hooks['leases.releaseReservation'],
  live: leases.hooks['leases.reservationLive'],
  findings: findings.hooks['findings.gate'], verdict: verdicts.hooks['verdicts.gate'],
  schedule: runners.hooks['runners.schedule'],
};
const originalTrustedConfig = (env as Env).TRUSTED_CONFIG;
let harness: Harness;
beforeEach(() => {
  const repoId = freshRepo();
  const views = new Map<string, ChangeView>();
  const findingsVersion = new Map<string, number>();
  const jobs: Job[] = [];
  const releases: string[] = [];
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repoId}`));
  const inside = <T>(callback: (context: ModuleContext) => T | Promise<T>) => runInDurableObject<RepoCoordinator, T>(stub, instance => {
    const internal = instance as unknown as { context(name: 'repos', principal: Principal, repoId: string): ModuleContext };
    return callback(internal.context('repos', principal, repoId));
  });
  harness = {
    repoId, views, findingsVersion, jobs, releases, reserveAllowed: true,
    async fetch(path, body, key = crypto.randomUUID()) {
      const request = body ? mutation(`/v1/repos/${repoId}${path}`, body, key) : apiRequest(`/v1/repos/${repoId}${path}`);
      const response = await worker.fetch(request, env);
      return { response, body: await responseBody(response) };
    },
    async state() { return (await this.fetch('/queue')).body.data; },
    async seed(name, base = main) {
      await inside(async context => {
        const storage = context.storage as FakeStorage;
        await storage.ensureRepo(name);
        if (base) {
          storage.putCommit(name, { oid: base, treeOid: oid('2'), parents: [] });
          storage.conditionalUpdateRef(name, 'refs/heads/main', null, base);
        }
      });
    },
    async put(name, ref, next, old = null, tree = oid('3')) {
      return await inside(context => {
        const storage = context.storage as FakeStorage;
        storage.putCommit(name, { oid: next, treeOid: tree, parents: old ? [old] : [] });
        return storage.conditionalUpdateRef(name, ref, old, next);
      });
    },
    async tick(flush = true) {
      await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
        if (flush) {
          const internal = instance as unknown as { context(name: 'repos', principal: Principal, repoId: string): ModuleContext };
          const queueContext = internal.context('queue' as 'repos', principal, repoId);
          const state = queueContext.state.get<any>('data');
          if (state) { state.coalesceUntil = 0; queueContext.state.put('data', state); }
        }
        await instance.alarm();
      });
    },
    async deliver(job, outcome, options = {}) {
      if (job.kind !== 'validate-stack') throw new Error('expected stack job');
      const composedOid = options.composed ?? (['PASS', 'MATCH'].includes(outcome) ? oid('e') : null);
      const tree = options.tree ?? oid('3');
      if (composedOid) await this.put(job.scratchStorageName, job.scratchRef, composedOid, null, tree);
      const preimage = {
        kind: 'validate-stack' as const, jobId: job.jobId, attempt: 1, inputDigest: job.inputDigest, fence: 1,
        sourceTreeOid: composedOid ? tree : null, checkerDigest: job.checkerDigest,
        toolchainDigest: job.toolchainDigest, oracleDigest: job.oracleDigest,
        environmentDigest: job.environmentDigest, durationMs: 1, log: '', outcome,
        composedOid, composedTreeOid: composedOid ? tree : null,
        gateResults: options.gates ?? [{ gateId: 'default', outcome: 'PASS' as const }],
        score: options.score ?? null, bootstrap: job.bootstrap, canonicalBaseOid: job.canonicalBaseOid,
      };
      const result = { ...preimage, resultDigest: await digest(preimage) } as StackResult;
      return await runInDurableObject<RepoCoordinator, Gate<{ promotionId: string | null }>>(stub, instance => {
        const internal = instance as unknown as { context(name: 'runners', principal: Principal, repoId: string): ModuleContext };
        return internal.context('runners', { ...principal, principalId: 'checker', roles: ['checker'] }, repoId)
          .call('queue.onResult', result);
      });
    },
    async promoteResult(job, outcome, observed) {
      if (job.kind !== 'promote') throw new Error('expected promotion job');
      const preimage = {
        kind: 'promote' as const, jobId: job.jobId, attempt: 1, inputDigest: job.inputDigest, fence: 1,
        sourceTreeOid: null, checkerDigest: job.checkerDigest, toolchainDigest: job.toolchainDigest,
        oracleDigest: job.oracleDigest, environmentDigest: job.environmentDigest,
        durationMs: 1, log: '', outcome, observedCanonicalOid: observed,
      };
      const result = { ...preimage, resultDigest: await digest(preimage) } as PromotionResult;
      return await runInDurableObject<RepoCoordinator, Gate<{ promotionId: string | null }>>(stub, instance => {
        const internal = instance as unknown as { context(name: 'runners', principal: Principal, repoId: string): ModuleContext };
        return internal.context('runners', { ...principal, principalId: 'promoter', roles: ['promoter'] }, repoId)
          .call('queue.onResult', result);
      });
    },
    async ageTicket(ms) {
      await runInDurableObject<RepoCoordinator, void>(stub, instance => {
        const internal = instance as unknown as { context(name: 'queue', principal: Principal, repoId: string): ModuleContext };
        const queueContext = internal.context('queue', principal, repoId);
        // Test-only state clock adjustment; the production queue never accepts this input.
        const state = queueContext.state.get<any>('data');
        state.ticket.createdAt -= ms;
        queueContext.state.put('data', state);
      });
    },
    async bootstrap(seed, asOwner = true) {
      return await runInDurableObject<RepoCoordinator, Gate<{ stackId: string }>>(stub, instance => {
        const internal = instance as unknown as { context(name: 'repos', principal: Principal, repoId: string): ModuleContext };
        const actor = asOwner ? principal : { ...principal, roles: ['agent'] as Principal['roles'] };
        return internal.context('repos', actor, repoId).handoffBootstrap!(seed);
      });
    },
  };
  repos.changeView = (_context, id) => views.has(id) ? gate(views.get(id)!)
    : { status: 'blocked', version: 1, code: 'CHANGE_NOT_FOUND', reason: 'Missing', evidenceIds: [] };
  leases.hooks['leases.reserve'] = (_context, id, fences) => harness.reserveAllowed
    ? gate({ reservationFences: { ...fences } })
    : { status: 'blocked', version: 1, code: 'LEASE_STALE', reason: 'Lease unavailable', evidenceIds: [] };
  leases.hooks['leases.releaseReservation'] = (_context, id) => { releases.push(id); return gate(undefined); };
  leases.hooks['leases.reservationLive'] = () => gate(undefined);
  findings.hooks['findings.gate'] = (_context, id) => gate({ findingSetVersion: findingsVersion.get(id) ?? 1,
    unresolvedIds: [], pendingRound: null });
  verdicts.hooks['verdicts.gate'] = (_context, id) => gate({ verdictId: `v-${id}`, reviewManifestDigest: 'sha256:0',
    findingSetVersion: findingsVersion.get(id) ?? 1 });
  runners.hooks['runners.schedule'] = (context, job) => {
    if (context.repoId !== repoId) return { status: 'blocked', version: 1, code: 'TEST_REPO_MISMATCH', reason: 'Old test alarm', evidenceIds: [] };
    jobs.push(job); return gate({ jobId: job.jobId });
  };
});
afterEach(async () => {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${harness.repoId}`));
  await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
    const state = instance as unknown as { ctx: { storage: { deleteAlarm(): Promise<void> } } };
    await state.ctx.storage.deleteAlarm();
  });
  repos.changeView = original.changeView;
  leases.hooks['leases.reserve'] = original.reserve;
  leases.hooks['leases.releaseReservation'] = original.release;
  leases.hooks['leases.reservationLive'] = original.live;
  findings.hooks['findings.gate'] = original.findings;
  verdicts.hooks['verdicts.gate'] = original.verdict;
  runners.hooks['runners.schedule'] = original.schedule;
  (env as Env).TRUSTED_CONFIG = originalTrustedConfig;
});

async function addChange(h: Harness, id: string, deps: string[] = [], profileId = 'local-demo') {
  await h.seed(`candidate-${h.repoId}-${id}`);
  h.views.set(id, {
    authorId: 'agent-a', headOid: oid(id.toLowerCase().replace(/[^a-f0-9]/g, 'a').slice(0, 1)),
    revision: 1, status: 'ready', unitKeys: [`row:${id}`], frozen: false, baseOid: main,
    candidateStorageName: `candidate-${h.repoId}-${id}`, branch: 'refs/heads/work',
    dependencyChangeIds: deps, canonicalStorageName: `canonical-${h.repoId}`,
    scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId,
    intentKey: 'shared-intent',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = (await h.fetch('/queue')).body.version;
    const admitted = await h.fetch('/queue/enqueue', { expectedVersion: version,
      changeId: id, verdictId: `v-${id}`, leaseFences: { [`row:${id}`]: 1 } });
    if (admitted.body.error?.code !== 'STALE_VERSION') return admitted;
  }
  throw new Error('Admission stayed stale after three bounded attempts');
}

async function setup(...ids: string[]): Promise<Harness> {
  const h = harness;
  await h.seed(`canonical-${h.repoId}`);
  await h.seed(`scratch-${h.repoId}`, null);
  for (const id of ids) {
    const response = await addChange(h, id);
    if (response.response.status !== 201) throw new Error(JSON.stringify({ id, status: response.response.status, body: response.body }));
  }
  return h;
}

async function realLeases(h: Harness, changes: Array<{ id: string; unit: string }>, claimedIds: string[]): Promise<void> {
  const config = localFixtureConfig('local');
  for (const unit of new Set(changes.map(change => change.unit))) {
    config.policies['local-demo'].units[unit] = { canonicalKey: unit, file: 'data/queue.tsv',
      resources: [unit], dependencyKeys: [] };
  }
  (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
  leases.hooks['leases.reserve'] = original.reserve;
  leases.hooks['leases.reservationLive'] = original.live;
  leases.hooks['leases.releaseReservation'] = original.release;
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
  await runInDurableObject<RepoCoordinator, void>(stub, instance => {
    const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
    const context = internal.context('queue', principal, h.repoId);
    const store = sqlState(context.sql);
    store.put('module:repos:repo', { repoId: h.repoId, tenantId: 'local', displayName: h.repoId,
      canonicalStorageName: `canonical-${h.repoId}`, defaultBranch: 'main', observedCanonicalOid: main,
      policyId: 'local-demo', policyDigest: config.policies['local-demo'].digest,
      profileId: 'local-demo', status: 'ready', version: 1 });
    for (const { id, unit } of changes) {
      const view = h.views.get(id)!;
      store.put(`module:repos:change:${id}`, { changeId: id, repoId: h.repoId, authorId: 'agent-a',
        intentKey: 'shared-intent', intentText: id, candidateStorageName: view.candidateStorageName,
        branch: view.branch, baseOid: view.baseOid, headOid: view.headOid, revision: 1,
        unitKeys: [unit], dependencyChangeIds: [], status: 'ready', version: 1 });
      store.put(`module:repos:verified:${id}`, { changeId: id, revision: 1, headOid: view.headOid,
        policyDigest: config.policies['local-demo'].digest, unitKeys: [unit], verifiedBy: 'checker' });
      if (claimedIds.includes(id)) {
        context.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          `lease-${id}`, unit, 'agent-a', id, id, 1, Date.now() + 120_000, 'active', 1, Date.now(), Date.now());
        context.sql.exec('INSERT INTO leases_fences(unit_key, fence) VALUES(?, ?)', unit, 1);
      }
    }
  });
}

async function leaseState(h: Harness, id: string): Promise<{ state: string; expires_at: number }> {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
  return runInDurableObject<RepoCoordinator, { state: string; expires_at: number }>(stub, instance => {
    const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
    const context = internal.context('queue', principal, h.repoId);
    return context.sql.exec<{ state: string; expires_at: number }>('SELECT state, expires_at FROM leases_claims WHERE lease_id = ?', `lease-${id}`).toArray()[0];
  });
}

async function contestReleaseCount(h: Harness): Promise<number> {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
  return runInDurableObject<RepoCoordinator, number>(stub, instance => {
    const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
    const context = internal.context('queue', principal, h.repoId);
    return context.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM concord_events WHERE kind = 'lease.reservationReleased'").toArray()[0].count;
  });
}

async function contestLeaseGates(h: Harness): Promise<{ reserve: string; live: string }[]> {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
  return runInDurableObject<RepoCoordinator, { reserve: string; live: string }[]>(stub, instance => {
    const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
    const context = internal.context('queue', principal, h.repoId);
    return ['A', 'B'].map(id => ({
      reserve: context.call('leases.reserve', id, { 'row:J': 1 }).status,
      live: context.call('leases.reservationLive', id, { 'row:J': 1 }).status,
    }));
  });
}

async function contestLeaseRecord(h: Harness): Promise<{ selectedChangeId: string | null; closed?: boolean }> {
  const contestId = (await h.state()).contests[0].contestId;
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
  return runInDurableObject<RepoCoordinator, { selectedChangeId: string | null; closed?: boolean }>(stub, instance => {
    const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
    return internal.context('queue', principal, h.repoId).state.get(`contest:${contestId}`)!;
  });
}

async function expectContestTerminal(h: Harness, state: 'landed' | 'blocked'): Promise<void> {
  expect((await h.state()).contests[0].state).toBe(state);
  expect((await contestLeaseRecord(h)).closed).toBe(true);
  expect((await leaseState(h, 'A')).state).toBe('released');
  expect(await contestReleaseCount(h)).toBe(1);
  expect(await contestLeaseGates(h)).toEqual([
    { reserve: 'blocked', live: 'blocked' }, { reserve: 'blocked', live: 'blocked' },
  ]);
}

async function prepareReal(changes: Array<{ id: string; unit: string }>, claimedIds: string[]): Promise<Harness> {
  const h = harness;
  await h.seed(`canonical-${h.repoId}`);
  await h.seed(`scratch-${h.repoId}`, null);
  for (const { id, unit } of changes) {
    await h.seed(`candidate-${h.repoId}-${id}`);
    h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1,
      status: 'ready', unitKeys: [unit], frozen: false, baseOid: main,
      candidateStorageName: `candidate-${h.repoId}-${id}`, branch: 'refs/heads/work',
      dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
      scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'shared-intent' });
  }
  await realLeases(h, changes, claimedIds);
  return h;
}

async function enqueueReal(h: Harness, id: string, unit: string): Promise<void> {
  const response = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
    changeId: id, verdictId: `v-${id}`, leaseFences: { [unit]: 1 } });
  expect(response.response.status).toBe(201);
}

async function contestReal(h: Harness): Promise<void> {
  const response = await h.fetch('/contests', { intentKey: 'shared-intent', intentText: 'compete', unitKey: 'row:J',
    baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
    leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
  expect(response.response.status).toBe(201);
}

describe('queue with real lease hooks', () => {
  it('releases a withdrawn reservation', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:A' }], ['A']);
    await enqueueReal(h, 'A', 'row:A');
    expect((await leaseState(h, 'A')).state).toBe('reserved');
    const response = await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', reason: 'cancel' });
    expect(response.response.status).toBe(200);
    expect((await leaseState(h, 'A')).state).toBe('released');
  });

  it('releases a reservation after failed diagnosis', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:A' }], ['A']);
    await enqueueReal(h, 'A', 'row:A');
    await h.tick();
    await h.deliver(h.jobs[0], 'FAIL'); await h.tick();
    await h.deliver(h.jobs[1], 'FAIL'); await h.tick();
    expect((await h.state()).entries[0].state).toBe('blocked');
    expect((await leaseState(h, 'A')).state).toBe('released');
  });

  it('shares one contest reservation, keeps it after a loss, and releases it on landing', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    const created = await h.fetch('/contests', { intentKey: 'shared-intent', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
    expect(created.response.status).toBe(201);
    expect((await leaseState(h, 'A')).state).toBe('reserved');
    await h.tick();
    expect(h.jobs).toHaveLength(2);
    await h.deliver(h.jobs[1], 'PASS'); await h.tick();
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    expect((await h.state()).contests[0].winnerId).toBe('B');
    expect(await contestLeaseRecord(h)).toMatchObject({ selectedChangeId: 'B' });
    expect((await h.state()).entries.find((entry: any) => entry.changeId === 'A').state).toBe('failed');
    expect((await leaseState(h, 'A')).state).toBe('reserved');
    expect(await contestLeaseGates(h)).toEqual([
      { reserve: 'blocked', live: 'blocked' }, { reserve: 'eligible', live: 'eligible' },
    ]);
    const loser = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:J': 1 } });
    expect(loser.response.status).toBe(409);
    expect(loser.body.error.code).toBe('CONTEST_OWNED');
    expect((await h.state()).entries).toHaveLength(2);
    const contestedStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    const directReserve = await runInDurableObject<RepoCoordinator, Gate<{ reservationFences: Record<string, number> }>>(contestedStub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      return internal.context('queue', principal, h.repoId).call('leases.reserve', 'A', { 'row:J': 1 });
    });
    expect(directReserve).toMatchObject({ status: 'blocked', code: 'LEASE_STALE' });
    await h.tick();
    await h.deliver(h.jobs[2], 'PASS'); await h.tick();
    expect((await h.state()).promotion.state).toBe('pending');
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('e'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries.find((entry: any) => entry.changeId === 'B').state).toBe('landed');
    await expectContestTerminal(h, 'landed');
    const stale = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:J': 1 } });
    expect(stale.response.status).toBe(409);
    h.views.set('A', { ...h.views.get('A')!, baseOid: oid('e') });
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      context.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'lease-A-fresh', 'row:J', 'agent-a', 'A', 'fresh', 2, Date.now() + 120_000, 'active', 1, Date.now(), Date.now());
      context.sql.exec('UPDATE leases_fences SET fence = ? WHERE unit_key = ?', 2, 'row:J');
    });
    const fresh = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:J': 2 } });
    expect(fresh.response.status).toBe(201);
  });

  it('releases the contest reservation when the first child loses eligibility', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    await contestReal(h);
    h.views.set('A', { ...h.views.get('A')!, status: 'draft' });
    await h.tick();
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['blocked', 'blocked']);
    expect((await h.state()).contests[0]).toMatchObject({ state: 'blocked', reason: 'ELIGIBILITY_CHANGED' });
    await expectContestTerminal(h, 'blocked');
  });

  it('releases the contest reservation when a child job fails before arbitration', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    await contestReal(h);
    await h.tick();
    await h.deliver(h.jobs[0], 'TIMEOUT'); await h.tick();
    expect(h.jobs).toHaveLength(3);
    await h.deliver(h.jobs[2], 'TIMEOUT'); await h.tick();
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['blocked', 'blocked']);
    await expectContestTerminal(h, 'blocked');
  });

  it('releases the contest reservation when both children fail validation', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    await contestReal(h);
    await h.tick();
    await h.deliver(h.jobs[0], 'FAIL'); await h.tick();
    await h.deliver(h.jobs[1], 'FAIL'); await h.tick();
    expect((await h.state()).contests[0].state).toBe('blocked');
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['blocked', 'blocked']);
    await expectContestTerminal(h, 'blocked');
  });

  it('releases the contest reservation when the selected winner becomes ineligible', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    await contestReal(h);
    await h.tick();
    await h.deliver(h.jobs[1], 'PASS'); await h.tick();
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    expect((await h.state()).contests[0].winnerId).toBe('B');
    h.views.set('B', { ...h.views.get('B')!, status: 'draft' });
    await h.tick();
    expect((await h.state()).entries.find((entry: any) => entry.changeId === 'B').state).toBe('blocked');
    await expectContestTerminal(h, 'blocked');
  });

  it('blocks the selected contest and releases its reservation when the winner withdraws', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    await contestReal(h);
    await h.tick();
    await h.deliver(h.jobs[1], 'PASS'); await h.tick();
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    expect((await h.state()).contests[0]).toMatchObject({ state: 'selected', winnerId: 'B' });
    const withdrawn = await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'B', reason: 'cancel' });
    expect(withdrawn.response.status).toBe(200);
    expect((await h.state()).entries.find((entry: any) => entry.changeId === 'B').state).toBe('withdrawn');
    await expectContestTerminal(h, 'blocked');
  });

  it('blocks both contest children and releases the shared reservation when one withdraws', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    expect((await h.fetch('/contests', { intentKey: 'shared-intent', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] })).response.status).toBe(201);
    const withdrawn = await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'B', reason: 'cancel' });
    expect(withdrawn.response.status).toBe(200);
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['blocked', 'withdrawn']);
    await expectContestTerminal(h, 'blocked');
  });

  it('blocks an expired reservation before scheduling a contest child', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    expect((await h.fetch('/contests', { intentKey: 'shared-intent', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] })).response.status).toBe(201);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      context.sql.exec('UPDATE leases_claims SET expires_at = ? WHERE lease_id = ?', Date.now() - 1, 'lease-A');
    });
    await h.tick();
    expect(h.jobs).toHaveLength(0);
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['blocked', 'blocked']);
    expect((await h.state()).contests[0].state).toBe('blocked');
    expect(await contestLeaseGates(h)).toEqual([
      { reserve: 'blocked', live: 'blocked' }, { reserve: 'blocked', live: 'blocked' },
    ]);
  });

  it('does not issue a promotion ticket after the reservation expires', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:A' }], ['A']);
    await enqueueReal(h, 'A', 'row:A');
    await h.tick();
    expect(h.jobs).toHaveLength(1);
    await h.deliver(h.jobs[0], 'PASS');
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      context.sql.exec('UPDATE leases_claims SET expires_at = ? WHERE lease_id = ?', Date.now() - 1, 'lease-A');
    });
    await h.tick();
    expect((await h.state()).promotion).toBeNull();
    expect((await h.state()).entries[0].state).toBe('blocked');
  });
});

describe('queue state machine', () => {
  it('fails closed for missing change, review, and lease providers', async () => {
    const h = await setup();
    const absent = await h.fetch('/queue/enqueue', { expectedVersion: 0, changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:A': 1 } });
    expect(absent.body.error.code).toBe('CHANGE_NOT_FOUND');
    await h.seed(`candidate-${h.repoId}-A`);
    h.views.set('A', { authorId: 'agent-a', headOid: oid('a'), revision: 1, status: 'ready', unitKeys: ['row:A'], frozen: false });
    const incomplete = await h.fetch('/queue/enqueue', { expectedVersion: 0, changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:A': 1 } });
    expect(incomplete.body.error.code).toBe('IMMUTABLE_INPUT_MISSING');
    h.views.set('A', { ...h.views.get('A')!, baseOid: main, candidateStorageName: `candidate-${h.repoId}-A`, branch: 'refs/heads/work',
      dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`, scratchStorageName: `scratch-${h.repoId}`,
      policyId: 'local-demo', profileId: 'local-demo' });
    verdicts.hooks['verdicts.gate'] = undefined;
    const noReview = await h.fetch('/queue/enqueue', { expectedVersion: 0, changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:A': 1 } });
    expect(noReview.body.error.code).toBe('MODULE_UNAVAILABLE');
    verdicts.hooks['verdicts.gate'] = (_context, id) => gate({ verdictId: `v-${id}`, reviewManifestDigest: 'sha256:0', findingSetVersion: 1 });
    h.reserveAllowed = false;
    const noLease = await h.fetch('/queue/enqueue', { expectedVersion: 0, changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:A': 1 } });
    expect(noLease.body.error.code).toBe('LEASE_STALE');
    expect((await h.state()).entries).toHaveLength(0);
  });

  it('defers safely when the runner scheduling hook is absent', async () => {
    const h = await setup('A');
    runners.hooks['runners.schedule'] = undefined;
    await h.tick();
    expect(h.jobs).toHaveLength(0);
    expect((await h.state()).blockedReason).toBe('MODULE_UNAVAILABLE');
    expect((await h.state()).promotion).toBeNull();
  });

  it('orders admissions and withdraws with reservations', async () => {
    const h = await setup('A', 'B');
    const state = await h.state();
    expect(state.entries.map((entry: any) => entry.changeId)).toEqual(['A', 'B']);
    expect(state.entries[0].sequence).toBeLessThan(state.entries[1].sequence);
    const version = (await h.fetch('/queue')).body.version;
    const withdrawn = await h.fetch('/queue/withdraw', { expectedVersion: version, changeId: 'A', reason: 'owner requested' });
    expect(withdrawn.response.status).toBe(200);
    expect(h.releases).toContain('A');
    expect((await h.state()).entries[0].state).toBe('withdrawn');
  });

  it.each(['reserved', 'checking'])('withdraws a %s admission and releases once', async startingState => {
    const h = await setup('A');
    if (startingState === 'checking') await h.tick();
    const before = (await h.state()).entries[0];
    expect(before.state).toBe(startingState);
    const withdrawn = await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', reason: 'cancel' });
    expect(withdrawn.response.status).toBe(200);
    expect((await h.state()).entries[0]).toMatchObject({ entryId: before.entryId, state: 'withdrawn' });
    expect(h.releases).toEqual(['A']);
  });

  it('uses the new admission after withdrawal and re-enqueue, including the new immutable head', async () => {
    const h = await setup('A');
    const old = (await h.state()).entries[0];
    await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version, changeId: 'A', reason: 'replace' });
    h.views.set('A', { ...h.views.get('A')!, headOid: oid('f'), revision: 2 });
    const added = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:A': 1 } });
    expect(added.response.status).toBe(201);
    const next = (await h.state()).entries[1];
    expect(next.entryId).not.toBe(old.entryId);
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['withdrawn', 'reserved']);
    await h.tick();
    expect((h.jobs[0] as any).candidates).toMatchObject([{ changeId: 'A', revision: 2, headOid: oid('f') }]);
    expect((await h.state()).entries[1].state).toBe('checking');
    expect((await h.state()).entries.map((entry: any) => entry.stackMember)).toEqual([false, true]);
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    expect((await h.state()).promotion.frozenAdmission).toMatchObject([{ revision: 2, headOid: oid('f') }]);
    expect((await h.state()).entries[0].state).toBe('withdrawn');
    expect(h.releases.filter(id => id === 'A')).toHaveLength(1);
  });

  it.each(['before scheduling', 'after scheduling'])('closes a contest when a child withdraws %s', async timing => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`); await h.seed(`scratch-${h.repoId}`, null);
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'shared-intent' });
    }
    expect((await h.fetch('/contests', { intentKey: 'shared-intent', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] })).response.status).toBe(201);
    if (timing === 'after scheduling') await h.tick();
    await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version, changeId: 'A', reason: 'cancel' });
    if (timing === 'after scheduling') expect((await h.deliver(h.jobs[0], 'PASS')).status).toBe('blocked');
    await h.tick();
    const state = await h.state();
    expect(state.contests[0]).toMatchObject({ state: 'blocked', reason: 'CHILD_WITHDRAWN', winnerId: null });
    expect(state.entries.map((entry: any) => entry.state)).toEqual(['withdrawn', 'blocked']);
    expect(h.jobs.filter(job => job.kind === 'validate-stack')).toHaveLength(timing === 'after scheduling' ? 2 : 0);
    expect(h.releases).toEqual(['A', 'B']);
  });

  it('coalesces for two seconds when fewer than four are available', async () => {
    const h = await setup('A');
    await h.tick(false);
    expect(h.jobs).toHaveLength(0);
    expect((await h.state()).entries[0].state).toBe('reserved');
    await h.tick();
    expect(h.jobs).toHaveLength(1);
  });

  it('admits a candidate based on an admitted prerequisite head and stacks the prerequisite first', async () => {
    const h = await setup('A');
    await h.seed(`candidate-${h.repoId}-B`);
    h.views.set('B', { authorId: 'agent-a', headOid: oid('b'), revision: 1, status: 'ready',
      unitKeys: ['row:B'], frozen: false, baseOid: oid('a'), candidateStorageName: `candidate-${h.repoId}-B`,
      branch: 'refs/heads/work', dependencyChangeIds: ['A'], canonicalStorageName: `canonical-${h.repoId}`,
      scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo' });
    const admitted = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'B', verdictId: 'v-B', leaseFences: { 'row:B': 1 } });
    expect(admitted.response.status).toBe(201);
    await h.tick();
    expect((h.jobs[0] as any).candidates.map((candidate: any) => [candidate.changeId, candidate.baseOid]))
      .toEqual([['A', main], ['B', oid('a')]]);
  });

  it('caps stack width at four and refuses a ninth active candidate', async () => {
    const h = await setup('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H');
    await h.tick();
    expect((h.jobs[0] as any).candidates.map((item: any) => item.changeId)).toEqual(['A', 'B', 'C', 'D']);
    const ninth = await addChange(h, 'I');
    expect(ninth.response.status).toBe(429);
    expect(ninth.body.error.code).toBe('QUEUE_FULL');
  });

  it('starts the stack as soon as four comparable entries are available', async () => {
    const h = await setup('A', 'B', 'C', 'D');
    await h.tick(false);
    expect((h.jobs[0] as any).candidates.map((item: any) => item.changeId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('isolates A-good/B-bad/C-good and checks A+C before ticketing', async () => {
    const h = await setup('A', 'B', 'C');
    await h.tick();
    expect(h.jobs[0].kind).toBe('validate-stack');
    expect((h.jobs[0] as any).candidates.map((item: any) => item.changeId)).toEqual(['A', 'B', 'C']);
    await h.deliver(h.jobs[0], 'FAIL'); await h.tick();
    expect((h.jobs[1] as any).candidates).toEqual([]);
    await h.deliver(h.jobs[1], 'PASS'); await h.tick();
    await h.deliver(h.jobs[2], 'PASS'); await h.tick();
    await h.deliver(h.jobs[3], 'FAIL'); await h.tick();
    await h.deliver(h.jobs[4], 'FAIL'); await h.tick();
    expect((h.jobs[5] as any).candidates.map((item: any) => item.changeId)).toEqual(['A', 'C']);
    await h.deliver(h.jobs[5], 'PASS'); await h.tick();
    const state = await h.state();
    expect(state.diagnosis).toMatchObject({ reason: 'SINGLETON', blame: ['B'], survivors: ['A', 'C'] });
    expect(state.diagnosticResults).toHaveLength(5);
    expect(state.promotion.memberIds).toEqual(['A', 'C']);
    expect(state.entries.find((entry: any) => entry.changeId === 'B').state).toBe('blocked');
  });

  it('classifies pairwise interaction, dependency closure, baseline failure, and budget exhaustion without invented singleton blame', () => {
    const two = [{ changeId: 'A', sequence: 1, dependencyChangeIds: [] }, { changeId: 'B', sequence: 2, dependencyChangeIds: [] }];
    let step = startDiagnosis(['A', 'B']);
    step = advanceDiagnosis(step.diagnosis, true, two);
    step = advanceDiagnosis(step.diagnosis, true, two);
    step = advanceDiagnosis(step.diagnosis, true, two);
    expect(step.diagnosis).toMatchObject({ reason: 'INTERACTION', blame: ['A', 'B'] });
    expect(startDiagnosis(['A', 'B']).diagnosis.phase).toBe('baseline');
    expect(advanceDiagnosis(startDiagnosis(['A']).diagnosis, false, two).diagnosis.reason).toBe('BASE_RED');
    const dependent = [{ changeId: 'A', sequence: 1, dependencyChangeIds: ['B'] }, { changeId: 'B', sequence: 2, dependencyChangeIds: ['A'] }];
    expect(dependencyClosure(['A'], dependent)).toEqual(['A', 'B']);
    expect(advanceDiagnosis(startDiagnosis(['A', 'B']).diagnosis, true, dependent).diagnosis.reason).toBe('DEPENDENCY_GROUP');
    const many = Array.from({ length: 256 }, (_, i) => ({ changeId: `c${i}`, sequence: i, dependencyChangeIds: [] }));
    step = startDiagnosis(many.map(item => item.changeId));
    for (let i = 0; i < 20 && step.next !== null; i++) step = advanceDiagnosis(step.diagnosis, step.diagnosis.phase === 'baseline', many);
    expect(step.diagnosis.reason).toBe('INCONCLUSIVE');
    expect(step.diagnosis.jobs).toBe(8);
    const dependentSurvivor = [{ changeId: 'A', sequence: 1, dependencyChangeIds: [] },
      { changeId: 'B', sequence: 2, dependencyChangeIds: ['A'] }];
    let dependencyStep = startDiagnosis(['A', 'B']);
    dependencyStep = advanceDiagnosis(dependencyStep.diagnosis, true, dependentSurvivor);
    dependencyStep = advanceDiagnosis(dependencyStep.diagnosis, false, dependentSurvivor);
    expect(dependencyStep.diagnosis.reason).toBe('DEPENDENCY_GROUP');
  });

  it('records pairwise interaction without a promotion ticket', async () => {
    const h = await setup('A', 'B');
    await h.tick();
    await h.deliver(h.jobs[0], 'FAIL'); await h.tick();
    await h.deliver(h.jobs[1], 'PASS'); await h.tick();
    await h.deliver(h.jobs[2], 'PASS'); await h.tick();
    await h.deliver(h.jobs[3], 'PASS'); await h.tick();
    expect((await h.state()).diagnosis).toMatchObject({ reason: 'INTERACTION', blame: ['A', 'B'] });
    expect((await h.state()).promotion).toBeNull();
  });

  it.each([
    { name: 'red baseline', ids: ['A', 'B'], diagnostic: ['FAIL'], reason: 'BASE_RED' },
    { name: 'failed survivor check', ids: ['A', 'B'], diagnostic: ['PASS', 'FAIL', 'FAIL'], reason: 'INCONCLUSIVE' },
    { name: 'interaction inside a subset', ids: ['A', 'B', 'C'], diagnostic: ['PASS', 'PASS', 'FAIL', 'PASS', 'PASS'], reason: 'INTERACTION' },
  ])('blocks and releases every unresolved member after $name', async ({ ids, diagnostic, reason }) => {
    const h = await setup(...ids);
    await h.tick(); await h.deliver(h.jobs[0], 'FAIL'); await h.tick();
    for (let i = 0; i < diagnostic.length; i++) {
      expect(h.jobs[i + 1]).toBeDefined();
      await h.deliver(h.jobs[i + 1], diagnostic[i] as StackResult['outcome']); await h.tick();
    }
    const state = await h.state();
    expect(state.diagnosis.reason).toBe(reason);
    expect(state.entries.map((entry: any) => entry.state)).toEqual(ids.map(() => 'blocked'));
    expect(state.activeStackJobId).toBeNull();
    expect(state.promotion).toBeNull();
    expect([...h.releases].sort()).toEqual([...ids].sort());
  });

  it('releases a checking entry when both bounded timeout attempts fail', async () => {
    const h = await setup('A');
    await h.tick();
    await h.deliver(h.jobs[0], 'TIMEOUT'); await h.tick();
    expect(h.jobs).toHaveLength(2);
    expect((await h.state()).entries[0].state).toBe('checking');
    await h.deliver(h.jobs[1], 'TIMEOUT'); await h.tick();
    expect((await h.state()).entries[0]).toMatchObject({ state: 'blocked', blockedReason: 'ENVIRONMENT_FAILURE' });
    expect(h.releases).toEqual(['A']);
  });

  it('records suspected flake when an environment retry disagrees', async () => {
    const h = await setup('A');
    await h.tick();
    const original = h.jobs[0];
    await h.deliver(original, 'ENV_ERROR'); await h.tick();
    const retry = h.jobs[1];
    expect(retry.inputDigest).toBe(original.inputDigest);
    expect(retry.jobId).not.toBe(original.jobId);
    await h.deliver(retry, 'PASS'); await h.tick();
    expect((await h.state()).blockedReason).toBe('SUSPECTED_FLAKE');
    expect((await h.state()).promotion).toBeNull();
  });

  it('blocks stale main results before promotion', async () => {
    const h = await setup('A');
    await h.tick();
    const job = h.jobs[0];
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('4'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries[0]).toMatchObject({ state: 'blocked', blockedReason: 'STALE_MAIN' });
    expect((await h.deliver(job, 'PASS')).status).toBe('blocked');
    expect((await h.state()).promotion).toBeNull();
  });

  it('blocks stale head results before promotion', async () => {
    const h = await setup('B');
    await h.tick();
    h.views.set('B', { ...h.views.get('B')!, headOid: oid('5'), revision: 2 });
    await h.deliver(h.jobs[0], 'PASS');
    await h.tick();
    expect((await h.state()).promotion).toBeNull();
    expect((await h.state()).entries[0]).toMatchObject({ state: 'blocked', blockedReason: 'ELIGIBILITY_CHANGED' });
  });

  it('does not ticket an in-flight changed finding set and rejects conflicting duplicate results', async () => {
    const h = await setup('A');
    await h.tick();
    const job = h.jobs[0];
    expect((await h.deliver(job, 'PASS')).status).toBe('eligible');
    expect((await h.deliver(job, 'PASS')).status).toBe('eligible');
    expect((await h.deliver(job, 'FAIL')).status).toBe('blocked');
    h.findingsVersion.set('A', 2);
    await h.tick();
    expect((await h.state()).promotion).toBeNull();
    expect((await h.state()).entries[0].state).toBe('blocked');
  });

  it('creates one durable ticket for repeated identical green results', async () => {
    const h = await setup('A');
    await h.tick();
    const job = h.jobs[0];
    expect((await h.deliver(job, 'PASS')).status).toBe('eligible');
    expect((await h.deliver(job, 'PASS')).status).toBe('eligible');
    await h.tick(); await h.tick();
    expect((await h.state()).promotion).toMatchObject({ state: 'pending', checkedNewOid: oid('e') });
    expect(h.jobs.filter(item => item.kind === 'promote')).toHaveLength(1);
  });

  it('rejects a green result whose checked scratch ref moved', async () => {
    const h = await setup('A');
    await h.tick();
    const job = h.jobs[0];
    await h.deliver(job, 'PASS');
    if (job.kind !== 'validate-stack') throw new Error('expected stack job');
    expect(await h.put(job.scratchStorageName, job.scratchRef, oid('f'), oid('e'))).toBe(true);
    await h.tick();
    expect((await h.state()).promotion).toBeNull();
    expect((await h.state()).blockedReason).toBe('CHECKED_SCRATCH_MISMATCH');
  });

  it('freezes an ambiguous old OID through timeout and merges only after exact readback', async () => {
    const h = await setup('A');
    await h.tick();
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    let state = await h.state();
    expect(state.promotion).toMatchObject({ expectedOldOid: main, checkedNewOid: oid('e'), state: 'pending' });
    const blocked = await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', reason: 'late' });
    expect(blocked.body.error.code).toBe('PROMOTION_IN_PROGRESS');
    await h.ageTicket(61_000); await h.tick();
    state = await h.state();
    expect(state.promotion).toMatchObject({ state: 'reconcile', reconciliation: 'AMBIGUOUS_OLD_OID' });
    expect(state.promotion.jobIds).toHaveLength(2);
    const attempts = h.jobs.filter(job => job.kind === 'promote');
    expect(attempts).toHaveLength(2);
    expect(attempts[1].inputDigest).toBe(attempts[0].inputDigest);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    const freeze = await runInDurableObject<RepoCoordinator, { first: unknown; retry: unknown; unrelated: unknown }>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', { ...principal, principalId: 'promoter', roles: ['promoter'] }, h.repoId);
      const decision = (jobId: string) => queue.promotionFreeze!(context,
        new Request(`https://concord.test/v1/repos/${h.repoId}/jobs/${jobId}/credentials`, { method: 'POST' }));
      return { first: decision(attempts[0].jobId), retry: decision(attempts[1].jobId), unrelated: decision('unrelated') };
    });
    expect(freeze).toEqual({ first: { frozen: true, exempt: true }, retry: { frozen: true, exempt: true },
      unrelated: { frozen: true, exempt: false } });
    expect((await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', reason: 'late again' })).body.error.code).toBe('PROMOTION_IN_PROGRESS');
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('e'), main)).toBe(true);
    await h.tick();
    state = await h.state();
    expect(state.promotion.state).toBe('applied');
    expect(state.entries[0].state).toBe('landed');
    expect(state.finalCanonicalOid).toBe(oid('e'));
    expect(h.releases).toEqual(['A']);
  });

  it('keeps a third-OID promotion fenced', async () => {
    const h = await setup('A');
    await h.tick(); await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('4'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).promotion).toMatchObject({ state: 'reconcile', reconciliation: 'THIRD_OID' });
  });

  it('does not mark merged from an applied response without canonical readback', async () => {
    const h = await setup('A');
    await h.tick(); await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    const promote = h.jobs.find(job => job.kind === 'promote')!;
    expect((await h.promoteResult(promote, 'APPLIED', oid('e'))).status).toBe('eligible');
    await h.tick();
    expect((await h.state()).entries[0].state).not.toBe('landed');
    expect((await h.state()).promotion.state).toBe('pending');
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('e'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries[0].state).toBe('landed');
  });

  it('releases a confirmed old-ref failure for rechecking', async () => {
    const h = await setup('B');
    await h.tick(); await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    const promote = h.jobs.find(job => job.kind === 'promote')!;
    expect((await h.promoteResult(promote, 'OLD_REF', main)).status).toBe('eligible');
    await h.tick();
    const state = await h.state();
    expect(state.promotion).toMatchObject({ state: 'failed', reconciliation: 'CONFIRMED_OLD_REF' });
    expect(state.entries[0].state).toBe('reserved');
  });

  it('allows one explicit empty-repo bootstrap and closes the internal handoff to HTTP callers', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`, null);
    await h.seed(`scratch-${h.repoId}`, null);
    await h.seed(`seed-${h.repoId}`, null);
    await h.put(`seed-${h.repoId}`, 'refs/heads/seed', oid('a'));
    const seed: BootstrapHandoff = {
      seedStorageName: `seed-${h.repoId}`, seedRef: 'refs/heads/seed', headOid: oid('a'),
      canonicalStorageName: `canonical-${h.repoId}`, scratchStorageName: `scratch-${h.repoId}`,
      policyId: 'local-demo', profileId: 'local-demo',
    };
    expect((await h.bootstrap(seed, false)).status).toBe('blocked');
    expect((await h.fetch('/queue/bootstrap', { expectedVersion: 0, ...seed })).response.status).toBe(404);
    expect((await h.bootstrap(seed)).status).toBe('eligible');
    expect((await h.bootstrap(seed)).status).toBe('blocked');
    await h.tick();
    const job = h.jobs[0];
    expect(job).toMatchObject({ bootstrap: true, canonicalBaseOid: null, ownerAuthorized: true });
    await h.deliver(job, 'PASS'); await h.tick();
    expect((await h.state()).promotion).toMatchObject({ bootstrap: true, expectedOldOid: null, state: 'pending' });
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('e'), null)).toBe(true);
    await h.tick();
    expect((await h.state()).bootstrap.state).toBe('merged');
    expect((await h.bootstrap(seed)).status).toBe('blocked');
  });

  it('blocks a failed bootstrap check without creating a ticket', async () => {
    const h = harness;
    await h.fetch('/queue');
    await h.seed(`canonical-${h.repoId}`, null);
    await h.seed(`scratch-${h.repoId}`, null);
    await h.seed(`seed-${h.repoId}`, null);
    const seed: BootstrapHandoff = { seedStorageName: `seed-${h.repoId}`, seedRef: 'refs/heads/seed', headOid: oid('a'),
      canonicalStorageName: `canonical-${h.repoId}`, scratchStorageName: `scratch-${h.repoId}`,
      policyId: 'local-demo', profileId: 'local-demo' };
    expect((await h.bootstrap(seed)).status).toBe('eligible');
    await h.tick();
    expect(h.jobs).toHaveLength(1);
    await h.deliver(h.jobs[0], 'FAIL'); await h.tick();
    expect((await h.state()).bootstrap).toMatchObject({ state: 'blocked', blockedReason: 'FAIL' });
    expect((await h.state()).promotion).toBeNull();
  });

  it('chooses the first valid green contest result and supersedes the loser', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'shared-intent' });
    }
    const created = await h.fetch('/contests', { intentKey: 'shared-intent', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
    expect(created.response.status).toBe(201);
    await h.tick();
    if (h.jobs.length !== 2) throw new Error(JSON.stringify(h.jobs.map(job => ({ jobId: job.jobId, candidates: job.kind === 'validate-stack' ? job.candidates.map(item => item.changeId) : [] }))));
    await h.deliver(h.jobs[1], 'PASS'); await h.tick();
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    const state = await h.state();
    expect(state.contests[0]).toMatchObject({ state: 'selected', winnerId: 'B', reason: 'FIRST_VALID_GREEN' });
    expect(state.entries.find((entry: any) => entry.changeId === 'A').state).toBe('failed');
    expect(['reserved', 'checking']).toContain(state.entries.find((entry: any) => entry.changeId === 'B').state);
    expect(h.releases).toEqual(['A']);
    await h.tick();
    expect((h.jobs[2] as any).candidates.map((item: any) => item.changeId)).toEqual(['B']);
  });

  it('arbitrates hard gates before fixed-denominator score, ties by creation, and rejects profile mismatch', () => {
    const green = (matched: number, total = 100, gateOutcome: 'PASS' | 'FAIL' = 'PASS'): StackResult => ({
      kind: 'validate-stack', jobId: 'j', attempt: 1, inputDigest: 'sha256:1', fence: 1, sourceTreeOid: oid('3'),
      checkerDigest: 'sha256:1', toolchainDigest: 'sha256:1', oracleDigest: 'sha256:1',
      environmentDigest: 'sha256:1', durationMs: 1, log: '', resultDigest: 'sha256:1',
      outcome: 'PASS', composedOid: oid('e'), composedTreeOid: oid('3'),
      gateResults: [{ gateId: 'default', outcome: gateOutcome }], score: { matched, total },
      bootstrap: false, canonicalBaseOid: main,
    });
    const policy = { kind: 'score' as const, gates: [{ id: 'default', requiredOutcome: 'PASS' as const }], fixedDenominator: 100 };
    const candidate = (id: string, result: StackResult, creationSequence: number, resultSequence: number, profileDigest = 'p') => ({
      changeId: id, result, creationSequence, resultSequence, policyDigest: 'policy', profileDigest,
      oracleDigest: result.oracleDigest, toolchainDigest: result.toolchainDigest,
      checkerDigest: result.checkerDigest, canonicalBaseOid: main,
    });
    expect(accepted(green(99, 99), policy)).toBe(false);
    expect(arbitrate(candidate('A', green(90, 100, 'FAIL'), 1, 1), candidate('B', green(70), 2, 2), policy))
      .toMatchObject({ winnerId: 'B' });
    expect(arbitrate(candidate('A', green(70), 1, 2), candidate('B', green(70), 2, 1), policy))
      .toMatchObject({ winnerId: 'A', reason: 'SCORE_TIE_CREATION_ORDER' });
    expect(arbitrate(candidate('A', green(70), 1, 1), candidate('B', green(90), 2, 2, 'other'), policy))
      .toEqual({ status: 'blocked', reason: 'NON_COMPARABLE_PROFILE' });
  });
});
