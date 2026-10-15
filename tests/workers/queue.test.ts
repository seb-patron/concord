import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { BootstrapHandoff, ChangeView, Gate, Job, ModuleContext, Principal, PromotionResult, ReviewManifest, StackResult } from '../../src/contracts';
import type { RepoCoordinator } from '../../src/coordinator';
import { repos } from '../../src/features/repos';
import { queue } from '../../src/features/queue';
import { leases } from '../../src/features/leases';
import { jobInput, runners } from '../../src/features/runners';
import { findings } from '../../src/features/findings';
import { verdicts } from '../../src/features/verdicts';
import { digest } from '../../src/http';
import { manifestDigest } from '../../src/verdicts/manifest';
import { localFixtureConfig, sqlState } from '../../src/state';
import { mergeLandedChanges } from '../../src/repos/model';
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
  queueData(): Promise<any>;
  injectLegacyQueueCopies(): Promise<void>;
  seed(name: string, base?: string | null): Promise<void>;
  put(name: string, ref: string, next: string, old?: string | null, tree?: string): Promise<boolean>;
  tick(flush?: boolean): Promise<void>;
  deliver(job: Job, outcome: StackResult['outcome'], options?: { composed?: string; tree?: string; gates?: Array<{ gateId: string; outcome: StackResult['outcome'] }>; score?: { matched: number; total: number }; badDigest?: boolean }): Promise<Gate<{ promotionId: string | null }>>;
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
const originalStorageInfo = FakeStorage.prototype.info;
const originalStorageResolveRef = FakeStorage.prototype.resolveRef;
const originalStorageReadCommit = FakeStorage.prototype.readCommit;
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
  FakeStorage.prototype.info = async function(name) {
    const info = await originalStorageInfo.call(this, name);
    return info && { ...info, remote: `file:///${encodeURIComponent(name)}` };
  };
  const refreshJobs = async () => {
    const scheduled = await runInDurableObject<RepoCoordinator, Job[]>(stub, instance => {
      const internal = instance as unknown as { context(name: 'runners', principal: Principal, repoId: string): ModuleContext };
      return (runners.snapshot(internal.context('runners', principal, repoId)) as { jobs: Job[] }).jobs;
    });
    jobs.splice(0, jobs.length, ...scheduled);
  };
  harness = {
    repoId, views, findingsVersion, jobs, releases, reserveAllowed: true,
    async fetch(path, body, key = crypto.randomUUID()) {
      const request = body ? mutation(`/v1/repos/${repoId}${path}`, body, key) : apiRequest(`/v1/repos/${repoId}${path}`);
      const response = await worker.fetch(request, env);
      const parsed = await responseBody(response);
      await refreshJobs();
      return { response, body: parsed };
    },
    async state() { return (await this.fetch('/queue')).body.data; },
    async queueData() { return inside(context => sqlState(context.sql).get<any>('module:queue:data')); },
    async injectLegacyQueueCopies() { return inside(context => {
      const state = sqlState(context.sql).get<any>('module:queue:data');
      for (const record of state.jobs) record.job.unitPolicy = localFixtureConfig('local').policies['local-demo'];
      sqlState(context.sql).put('module:queue:data', state);
    }); },
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
      await refreshJobs();
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
      const result = { ...preimage, resultDigest: options.badDigest ? `sha256:${'0'.repeat(64)}` : await digest(preimage) } as StackResult;
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
      const result = await runInDurableObject<RepoCoordinator, Gate<{ stackId: string }>>(stub, instance => {
        const internal = instance as unknown as { context(name: 'repos', principal: Principal, repoId: string): ModuleContext };
        const actor = asOwner ? principal : { ...principal, roles: ['agent'] as Principal['roles'] };
        return internal.context('repos', actor, repoId).handoffBootstrap!(seed);
      });
      await refreshJobs();
      return result;
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
  FakeStorage.prototype.info = originalStorageInfo;
  FakeStorage.prototype.resolveRef = originalStorageResolveRef;
  FakeStorage.prototype.readCommit = originalStorageReadCommit;
  (env as Env).TRUSTED_CONFIG = originalTrustedConfig;
});

async function addChange(h: Harness, id: string, deps: string[] = [], profileId = 'local-demo', intentKey = 'shared-intent') {
  await h.seed(`candidate-${h.repoId}-${id}`);
  h.views.set(id, {
    authorId: 'agent-a', headOid: oid(id.toLowerCase().replace(/[^a-f0-9]/g, 'a').slice(0, 1)),
    revision: 1, status: 'ready', unitKeys: [`row:${id}`], frozen: false, baseOid: main,
    candidateStorageName: `candidate-${h.repoId}-${id}`, branch: 'refs/heads/work',
    dependencyChangeIds: deps, canonicalStorageName: `canonical-${h.repoId}`,
    scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId,
    intentKey,
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

async function deliverChecked(h: Harness, job: Job, outcome: StackResult['outcome'],
  options: { composedOid?: string; tree?: string; expectedStatus?: number } = {}): Promise<{ response: Response; body: any }> {
  if (job.kind !== 'validate-stack' || job.bootstrap) throw new Error('expected ordinary stack job');
  const prefix = `/v1/repos/${h.repoId}`;
  const poll = await worker.fetch(mutation(`${prefix}/runner/poll`,
    { runnerId: 'diagnostic-checker', role: 'checker', supportedProfileDigests: [job.profileDigest] },
    crypto.randomUUID(), 'local-checker'), env);
  if (poll.status !== 200) throw new Error(`runner poll: ${poll.status}`);
  const claimed = (await responseBody(poll)).data.job as Job;
  if (claimed.jobId !== job.jobId) throw new Error(`unexpected runner job: ${claimed.jobId}`);
  const composedOid = options.composedOid ?? (job.baseCheck && ['PASS', 'FAIL'].includes(outcome) ? main :
    outcome === 'PASS' ? oid((h.jobs.indexOf(job) + 2).toString(16)) : null);
  const tree = options.tree ?? (job.baseCheck ? oid('2') : oid('3'));
  if (composedOid && ['PASS', 'MATCH'].includes(outcome)) {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'runners', actor: Principal, repoId: string): ModuleContext };
      const storage = internal.context('runners', principal, h.repoId).storage as FakeStorage;
      storage.putCommit(job.scratchStorageName, { oid: main,
        treeOid: job.baseCheck && composedOid === main ? tree : oid('2'), parents: [] });
      for (const candidate of job.candidates) storage.putCommit(job.scratchStorageName,
        { oid: candidate.headOid, treeOid: tree, parents: [candidate.baseOid] });
      if (composedOid !== main) storage.putCommit(job.scratchStorageName, { oid: composedOid!, treeOid: tree,
        parents: [main, ...job.candidates.map(candidate => candidate.headOid)] });
      if (!storage.conditionalUpdateRef(job.scratchStorageName, job.scratchRef, null, composedOid!))
        throw new Error('scratch ref already exists');
    });
  }
  const preimage = {
    kind: 'validate-stack' as const, jobId: claimed.jobId, attempt: claimed.attempt, fence: claimed.fence,
    inputDigest: claimed.inputDigest, sourceTreeOid: composedOid ? tree : null,
    checkerDigest: claimed.checkerDigest, toolchainDigest: claimed.toolchainDigest,
    oracleDigest: claimed.oracleDigest, environmentDigest: claimed.environmentDigest,
    durationMs: 1, log: '', outcome, composedOid, composedTreeOid: composedOid ? tree : null,
    gateResults: [{ gateId: 'default', outcome: 'PASS' as const }], score: null,
    bootstrap: job.bootstrap, canonicalBaseOid: job.canonicalBaseOid,
  };
  const resultDigest = await digest(preimage);
  const response = await worker.fetch(mutation(`${prefix}/jobs/${job.jobId}/result`,
    { attempt: claimed.attempt, fence: claimed.fence, inputDigest: claimed.inputDigest,
      resultDigest, result: { ...preimage, resultDigest } }, crypto.randomUUID(), 'local-checker'), env);
  const body = await responseBody(response);
  if (response.status !== (options.expectedStatus ?? 200) ||
    response.status === 200 && body.data.dispatch.status !== 'eligible')
    throw new Error(`runner result: ${response.status} ${JSON.stringify(body)}`);
  return { response, body };
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
        intentKey: 'J', intentText: id, candidateStorageName: view.candidateStorageName,
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
      scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
  }
  await realLeases(h, changes, claimedIds);
  return h;
}

async function dispatchContestFixture(): Promise<void> {
  const config = (env as Env).TRUSTED_CONFIG
    ? JSON.parse((env as Env).TRUSTED_CONFIG!) as ReturnType<typeof localFixtureConfig>
    : localFixtureConfig('local');
  config.policies['local-demo'].checkerId = 'dispatch-lab';
  (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
}

async function contest(h: Harness, body: Record<string, unknown>): Promise<{ response: Response; body: any }> {
  await dispatchContestFixture();
  const created = await h.fetch('/contests', body);
  if (created.response.status === 201) {
    // Contest fixtures start at the dispatch scene immediately before J.
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const state = context.state.get<any>('data');
      state.dispatchCaseId = 'i-only';
      context.state.put('data', state);
    });
  }
  return created;
}

async function enqueueReal(h: Harness, id: string, unit: string): Promise<void> {
  const response = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
    changeId: id, verdictId: `v-${id}`, leaseFences: { [unit]: 1 } });
  expect(response.response.status).toBe(201);
}

async function contestReal(h: Harness): Promise<void> {
  const response = await contest(h, { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
    baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
    leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
  expect(response.response.status).toBe(201);
}

describe('queue with real lease hooks', () => {
  it('releases every lease of a landed change while preserving another change\'s lease', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:L' }], ['A', 'B']);
    const config = JSON.parse((env as Env).TRUSTED_CONFIG!) as ReturnType<typeof localFixtureConfig>;
    config.policies['local-demo'].units['row:K'] = { canonicalKey: 'row:K', file: 'data/queue.tsv', resources: ['row:K'], dependencyKeys: [] };
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const store = sqlState(context.sql);
      const a = store.get<any>('module:repos:change:A');
      const b = store.get<any>('module:repos:change:B');
      store.put('module:repos:changes', [a, b]);
      context.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'lease-A-extra', 'row:K', 'agent-a', 'A', 'A extra', 1, Date.now() + 7_200_000, 'active', 1, Date.now(), Date.now());
      context.sql.exec("INSERT INTO leases_fences(unit_key, fence) VALUES(?, ?)", 'row:K', 1);
    });
    await enqueueReal(h, 'A', 'row:J');
    await h.tick();
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    expect((await h.state()).promotion.state).toBe('pending');
    const promotion = h.jobs.find(job => job.kind === 'promote')!;
    expect((await h.promoteResult(promotion, 'APPLIED', oid('e'))).status).toBe('eligible');
    await h.tick();
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('e'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries[0].state).toBe('landed');
    const landed = await runInDurableObject<RepoCoordinator, { status: string }>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      return sqlState(internal.context('queue', principal, h.repoId).sql).get<{ status: string }>('module:repos:change:A')!;
    });
    expect(landed.status).toBe('merged');
    const rows = await runInDurableObject<RepoCoordinator, { lease_id: string; state: string }[]>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      return internal.context('queue', principal, h.repoId).sql.exec<{ lease_id: string; state: string }>(
        'SELECT lease_id, state FROM leases_claims ORDER BY lease_id').toArray();
    });
    expect(rows).toEqual(expect.arrayContaining([
      { lease_id: 'lease-A', state: 'released' }, { lease_id: 'lease-A-extra', state: 'released' },
      { lease_id: 'lease-B', state: 'active' },
    ]));
    const event = await runInDurableObject<RepoCoordinator, { payload: string }>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      return internal.context('queue', principal, h.repoId).sql.exec<{ payload: string }>(
        "SELECT payload FROM concord_events WHERE kind = 'lease.released' AND related_ids LIKE '%lease-A-extra%'").toArray()[0];
    });
    expect(JSON.parse(event.payload)).toMatchObject({ reason: 'change-merged' });
  });

  it('releases active leases from mergeLandedChanges once and allows another claimant', async () => {
    const h = await prepareReal([{ id: 'C', unit: 'row:C' }], []);
    const config = JSON.parse((env as Env).TRUSTED_CONFIG!) as ReturnType<typeof localFixtureConfig>;
    config.policies['local-demo'].units['row:D'] = { canonicalKey: 'row:D', file: 'data/queue.tsv', resources: ['row:D'], dependencyKeys: [] };
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    h.views.set('D', { authorId: 'agent-b', headOid: oid('d'), revision: 1, status: 'ready', unitKeys: ['row:C'], frozen: false,
      baseOid: main, candidateStorageName: 'candidate-D', branch: 'refs/heads/work', dependencyChangeIds: [],
      canonicalStorageName: `canonical-${h.repoId}`, scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'D' });
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const store = sqlState(context.sql);
      const change = store.get<any>('module:repos:change:C');
      store.put('module:repos:changes', [change]);
      store.put('module:repos:change:D', { ...change, changeId: 'D', authorId: 'agent-b', intentKey: 'D', intentText: 'D' });
      for (const [leaseId, unit] of [['lease-C-one', 'row:C'], ['lease-C-two', 'row:D']]) {
        context.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          leaseId, unit, 'agent-a', 'C', 'C', 1, Date.now() + 7_200_000, 'active', 1, Date.now(), Date.now());
        context.sql.exec('INSERT INTO leases_fences(unit_key, fence) VALUES(?, ?)', unit, 1);
      }
      context.transaction(() => mergeLandedChanges(context, ['C'], oid('e')));
    });
    const claim = await worker.fetch(mutation(`/v1/repos/${h.repoId}/leases`, { changeId: 'D', unitKeys: ['row:C'], intentText: 'claim released unit' }, 'claim-after-land', 'local-agent-b'), env);
    expect(claim.status).toBe(201);
    const beforeRetry = await runInDurableObject<RepoCoordinator, { states: string[]; events: string[] }>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      return { states: context.sql.exec<{ state: string }>("SELECT state FROM leases_claims WHERE change_id = 'C' ORDER BY lease_id").toArray().map(row => row.state),
        events: context.sql.exec<{ payload: string }>("SELECT payload FROM concord_events WHERE kind = 'lease.released' ORDER BY sequence").toArray().map(row => JSON.parse(row.payload)) };
    });
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      context.transaction(() => mergeLandedChanges(context, ['C'], oid('e')));
    });
    const afterRetry = await runInDurableObject<RepoCoordinator, { states: string[]; events: string[] }>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      return { states: context.sql.exec<{ state: string }>("SELECT state FROM leases_claims WHERE change_id = 'C' ORDER BY lease_id").toArray().map(row => row.state),
        events: context.sql.exec<{ payload: string }>("SELECT payload FROM concord_events WHERE kind = 'lease.released' ORDER BY sequence").toArray().map(row => JSON.parse(row.payload)) };
    });
    expect(beforeRetry).toMatchObject({ states: ['released', 'released'], events: [{ reason: 'change-merged' }, { reason: 'change-merged' }] });
    expect(afterRetry).toEqual(beforeRetry);
  });

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
    const created = await contest(h, { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
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
    expect((await contest(h, { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
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
    expect((await contest(h, { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
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
  it('does not rewrite queue data on unchanged active stack alarm ticks', async () => {
    const h = await setup('A');
    await h.tick();
    expect((await h.state()).activeStackJobId).toBeTruthy();
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    const writes = await runInDurableObject<RepoCoordinator, number>(stub, async instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const put = context.state.put.bind(context.state);
      let dataWrites = 0;
      context.state.put = (key, value) => {
        if (key === 'data') dataWrites++;
        return put(key, value);
      };
      await queue.onAlarm(context);
      await queue.onAlarm(context);
      return dataWrites;
    });
    expect(writes).toBe(0);
  });

  it('writes queue data once when an alarm observes a main ref change', async () => {
    const h = await setup('A');
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    const nextMain = oid('4');
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const state = context.state.get<any>('data');
      state.entries[0].state = 'landed';
      state.activeStackJobId = null;
      state.observedMain = main;
      context.state.put('data', state);
    });
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', nextMain, main)).toBe(true);
    const writes = await runInDurableObject<RepoCoordinator, number>(stub, async instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const put = context.state.put.bind(context.state);
      let dataWrites = 0;
      context.state.put = (key, value) => {
        if (key === 'data') dataWrites++;
        return put(key, value);
      };
      await queue.onAlarm(context);
      return dataWrites;
    });
    expect(writes).toBe(1);
    expect((await h.queueData()).observedMain).toBe(nextMain);
  });

  it('skips queue data writes on a repeated identical error tick', async () => {
    const h = await setup('A');
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    const writes = await runInDurableObject<RepoCoordinator, number>(stub, async instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const fixedNow = context.now();
      Object.defineProperty(context, 'now', { value: () => fixedNow });
      (context.storage as unknown as { resolveRef: () => Promise<never> }).resolveRef = async () => {
        throw new Error('storage unavailable');
      };
      const put = context.state.put.bind(context.state);
      let dataWrites = 0;
      context.state.put = (key, value) => {
        if (key === 'data') dataWrites++;
        return put(key, value);
      };
      await queue.onAlarm(context);
      const firstTickWrites = dataWrites;
      dataWrites = 0;
      await queue.onAlarm(context);
      if (firstTickWrites !== 1) return -1;
      return dataWrites;
    });
    expect(writes).toBe(0);
    expect((await h.queueData()).blockedReason).toBe('QUEUE_ALARM_ERROR');
  });

  it('holds a protected change until an owner decision and then permits landing', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    await h.seed(`candidate-${h.repoId}-A`);
    h.views.set('A', { authorId: 'agent-a', headOid: oid('a'), revision: 1, status: 'ready', unitKeys: ['row:A'], frozen: false,
      baseOid: main, candidateStorageName: `candidate-${h.repoId}-A`, branch: 'refs/heads/work',
      dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`, scratchStorageName: `scratch-${h.repoId}`,
      policyId: 'local-demo', profileId: 'local-demo' });
    const manifest: ReviewManifest = { changedUnits: [{ unitKey: 'row:A', beforePath: 'AGENTS.md', afterPath: 'AGENTS.md',
      beforeMode: '100644', afterMode: '100644', beforeDigest: `sha256:${'1'.repeat(64)}`, afterDigest: `sha256:${'2'.repeat(64)}` }],
      policyVersion: 1, policyDigest: `sha256:${'0'.repeat(64)}`, checkerDigest: `sha256:${'0'.repeat(64)}`,
      oracleDigest: `sha256:${'0'.repeat(64)}`, toolchainDigest: `sha256:${'0'.repeat(64)}`, coverage: 'complete', dependencyScope: [] };
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'verdicts', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('verdicts', principal, h.repoId);
      sqlState(context.sql).put('module:settings:record', { version: 1, protectedPaths: [{ pattern: 'AGENTS.md', level: 'human-approval' }] });
      context.state.put('inspection:A', { changeId: 'A', revision: 1,
        candidate: { changeId: 'A', revision: 1, baseOid: main, headOid: oid('a'), storageName: `candidate-${h.repoId}-A`, ref: 'refs/heads/work' },
        canonicalStorageName: `canonical-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo',
        reviewManifest: manifest, reviewManifestDigest: `sha256:${'3'.repeat(64)}`, outcome: 'PASS' });
    });
    const enqueue = () => h.fetch('/queue/enqueue', { expectedVersion: 0, changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:A': 1 } });
    const waiting = await enqueue();
    expect(waiting.body.error.code).toBe('HUMAN_APPROVAL_REQUIRED');
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'verdicts', actor: Principal, repoId: string): ModuleContext };
      internal.context('verdicts', principal, h.repoId).state.put('human:A', { revision: 1, headOid: oid('a'),
        manifestDigest: `sha256:${'3'.repeat(64)}`, evidenceDigest: `sha256:${'4'.repeat(64)}`, ownerId: 'owner',
        decision: 'approve', version: 1, patterns: ['AGENTS.md'] });
    });
    expect((await enqueue()).response.status).toBe(201);
    await h.tick();
    expect((await h.deliver(h.jobs[0], 'PASS')).status).toBe('eligible');
    await h.tick();
    const promotion = (await h.state()).promotion;
    expect(promotion).toMatchObject({ state: 'pending', memberIds: ['A'] });
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', promotion.checkedNewOid, main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries[0].state).toBe('landed');
  });
  it('admission while a stack is checking keeps that check', async () => {
    const h = await setup('A');
    await h.tick();
    const first = h.jobs[0];
    if (first.kind !== 'validate-stack') throw new Error('expected stack job');
    expect(first.candidates.map(candidate => candidate.changeId)).toEqual(['A']);
    expect((await h.state()).entries[0].state).toBe('checking');
    const before = await h.state();

    // D-LAND-FIX-NOW: admission waits for the active check instead of invalidating it.
    expect((await addChange(h, 'B')).response.status).toBe(201);
    let state = await h.state();
    expect(state.entries.map((entry: any) => [entry.changeId, entry.state, entry.stackMember]))
      .toEqual([['A', 'checking', true], ['B', 'reserved', false]]);
    expect(state.generation).toBe(before.generation);
    expect(state.activeStackJobId).toBe(before.activeStackJobId);

    expect((await h.deliver(first, 'PASS', { composed: oid('d') }))).toMatchObject({ status: 'eligible' });
    await h.tick();
    state = await h.state();
    expect(state.promotion).toMatchObject({ state: 'pending', memberIds: ['A'] });
    expect(state.entries.map((entry: any) => [entry.changeId, entry.state]))
      .toEqual([['A', 'checking'], ['B', 'reserved']]);
  });

  it('admission during diagnosis keeps the diagnosis', async () => {
    const h = await setup('A', 'B');
    await h.tick();
    const first = h.jobs[0];
    if (first.kind !== 'validate-stack') throw new Error('expected stack job');
    expect((await h.deliver(first, 'FAIL')).status).toBe('eligible');
    await h.tick();
    const before = await h.state();
    const diagnosis = structuredClone(before.diagnosis);
    const diagnosticJob = h.jobs.find(job => job.jobId === before.activeStackJobId);
    expect(diagnosticJob?.kind).toBe('validate-stack');
    expect(diagnosis).toMatchObject({ phase: 'baseline' });

    expect((await addChange(h, 'C')).response.status).toBe(201);
    const after = await h.state();
    expect(after.generation).toBe(before.generation);
    expect(after.activeStackJobId).toBe(before.activeStackJobId);
    expect(after.diagnosis).toEqual(diagnosis);
    expect(after.entries.map((entry: any) => [entry.changeId, entry.state]))
      .toEqual([['A', 'checking'], ['B', 'checking'], ['C', 'reserved']]);
    expect(h.jobs.find(job => job.jobId === after.activeStackJobId)).toEqual(diagnosticJob);
  });

  it('withdrawing a running stack member still invalidates the check', async () => {
    const h = await setup('A', 'B');
    await h.tick();
    const first = h.jobs[0];
    if (first.kind !== 'validate-stack') throw new Error('expected stack job');
    expect(first.candidates.map(candidate => candidate.changeId)).toEqual(['A', 'B']);
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['checking', 'checking']);

    const withdrawn = await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'B', reason: 'cancel' });
    expect(withdrawn.response.status).toBe(200);
    expect((await h.state()).entries.map((entry: any) => [entry.changeId, entry.state]))
      .toEqual([['A', 'reserved'], ['B', 'withdrawn']]);
    expect((await h.deliver(first, 'PASS', { composed: oid('d') })))
      .toMatchObject({ status: 'blocked', code: 'STALE_GENERATION' });
    await h.tick();
    const next = h.jobs[1];
    if (next.kind !== 'validate-stack') throw new Error('expected re-stacked job');
    expect(next.candidates.map(candidate => candidate.changeId)).toEqual(['A']);
    expect((await h.deliver(next, 'PASS')).status).toBe('eligible');
    await h.tick();
    expect((await h.state()).promotion).toMatchObject({ state: 'pending', memberIds: ['A'] });
  });

  it('merges 33 sequential landings, frees the active slot, and repairs an older landing', async () => {
    const h = harness;
    const unit = 'row:landed';
    const config = localFixtureConfig('local');
    config.policies['local-demo'].units[unit] = { canonicalKey: unit, file: 'landed.tsv', resources: [], dependencyKeys: [] };
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    const createdRepo = await worker.fetch(mutation('/v1/repos', { name: h.repoId, policyId: 'local-demo', profileId: 'local-demo' }, crypto.randomUUID()), env);
    expect(createdRepo.status).toBe(201);
    const repo = (await responseBody(createdRepo)).data;
    await h.fetch('');
    await h.seed(repo.canonicalStorageName);
    const scratchName = `concord-s-${h.repoId}`;
    await h.seed(scratchName, null);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    let currentMain = main;
    const ids: string[] = [];
    for (let index = 0; index < 33; index++) {
      const id = `landed-${index}`;
      const candidateName = `candidate-${h.repoId}-${index}`;
      const head = (100 + index).toString(16).padStart(40, '0');
      const nextMain = (1000 + index).toString(16).padStart(40, '0');
      if (index < 32) {
        await h.seed(candidateName, currentMain);
        await runInDurableObject<RepoCoordinator, void>(stub, instance => {
          const internal = instance as unknown as { context(name: 'repos', actor: Principal, repoId: string): ModuleContext };
          const context = internal.context('repos', principal, h.repoId);
          const changes = context.state.get<any[]>('changes') ?? [];
          const change = { changeId: id, repoId: h.repoId, authorId: 'owner', intentKey: id, intentText: id,
            candidateStorageName: candidateName, branch: 'refs/heads/work', baseOid: currentMain, headOid: head,
            revision: 1, unitKeys: [unit], dependencyChangeIds: [], status: 'ready', version: 1 };
          context.state.put('changes', [...changes, change]); context.state.put(`change:${id}`, change);
        });
      } else {
        const created = await h.fetch('/changes', { intentKey: id, intentText: id, baseOid: currentMain,
          branch: 'refs/heads/work', unitKeys: [unit], dependencyChangeIds: [] });
        expect(created.response.status).toBe(201);
        const change = created.body.data;
        ids.push(change.changeId);
        await runInDurableObject<RepoCoordinator, void>(stub, instance => {
          const internal = instance as unknown as { context(name: 'repos', actor: Principal, repoId: string): ModuleContext };
          const context = internal.context('repos', principal, h.repoId);
          const changes = context.state.get<any[]>('changes')!;
          const stored = changes.find(item => item.changeId === change.changeId)!;
          stored.status = 'ready'; stored.headOid = head; stored.revision = 1;
          context.state.put('changes', changes); context.state.put(`change:${change.changeId}`, stored);
        });
        h.views.set(change.changeId, { authorId: 'owner', headOid: head, revision: 1, status: 'ready', unitKeys: [unit], frozen: false,
          baseOid: currentMain, candidateStorageName: change.candidateStorageName, branch: 'refs/heads/work', dependencyChangeIds: [],
          canonicalStorageName: repo.canonicalStorageName, scratchStorageName: scratchName, policyId: 'local-demo', profileId: 'local-demo', intentKey: id });
      }
      const changeId = index < 32 ? id : ids[32];
      if (index < 32) {
        ids.push(id);
        h.views.set(id, { authorId: 'owner', headOid: head, revision: 1, status: 'ready', unitKeys: [unit], frozen: false,
          baseOid: currentMain, candidateStorageName: candidateName, branch: 'refs/heads/work', dependencyChangeIds: [],
          canonicalStorageName: repo.canonicalStorageName, scratchStorageName: scratchName, policyId: 'local-demo', profileId: 'local-demo', intentKey: id });
      }
      const enqueue = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
        changeId, verdictId: `v-${changeId}`, leaseFences: { [unit]: 1 } });
      expect(enqueue.response.status).toBe(201);
      await h.tick();
      const job = [...h.jobs].reverse().find(item => item.kind === 'validate-stack' && item.candidates.some(candidate => candidate.changeId === changeId))!;
      expect(job).toBeDefined();
      expect((await h.deliver(job, 'PASS', { composed: nextMain })).status).toBe('eligible');
      await h.tick();
      expect(await h.put(repo.canonicalStorageName, 'refs/heads/main', nextMain, currentMain)).toBe(true);
      await h.tick();
      expect((await h.fetch(`/changes/${changeId}`)).body.data).toMatchObject({ status: 'merged', canonicalOid: nextMain });
      const changes = (await h.fetch('/changes')).body.data.items;
      expect(changes.filter((change: any) => !['merged', 'superseded', 'closed'].includes(change.status))).toHaveLength(0);
      currentMain = nextMain;
    }
    const first = ids[0];
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'repos', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('repos', principal, h.repoId);
      const changes = context.state.get<any[]>('changes')!;
      const old = changes.find(change => change.changeId === first)!;
      old.status = 'ready'; delete old.canonicalOid;
      context.state.put('changes', changes); context.state.put(`change:${first}`, old);
    });
    const repair = await h.fetch('/changes/repair-landed', { expectedVersion: (await h.fetch('/queue')).body.version });
    expect(repair.response.status).toBe(200);
    expect(repair.body.data.repairedChangeIds).toEqual([first]);
    expect((await h.fetch(`/changes/${first}`)).body.data).toMatchObject({ status: 'merged', canonicalOid: (1000).toString(16).padStart(40, '0') });
    const again = await h.fetch('/changes/repair-landed', { expectedVersion: repair.body.version });
    expect(again.body.data.repairedChangeIds).toEqual([]);
  }, 120_000);

  it('admits a row write using a live covering file lease fence', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`); await h.seed(`scratch-${h.repoId}`, null);
    await h.seed(`candidate-${h.repoId}-A`);
    h.views.set('A', { authorId: 'agent-a', headOid: oid('a'), revision: 1, status: 'ready',
      unitKeys: ['row:A'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-A`,
      branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
      scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'covering' });
    await realLeases(h, [{ id: 'A', unit: 'row:A' }], ['A']);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      context.sql.exec('UPDATE leases_claims SET unit_key = ? WHERE lease_id = ?', 'file:data/queue.tsv', 'lease-A');
    });
    const result = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', verdictId: 'v-A', leaseFences: { 'file:data/queue.tsv': 1 } });
    expect(result.response.status).toBe(201);
    expect((await h.state()).entries[0].reservationFences).toEqual({ 'file:data/queue.tsv': 1 });
  });
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
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
    }
    expect((await contest(h, { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
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
    expect((await h.deliver(h.jobs[0], 'PASS')).status).toBe('eligible');
    await h.tick();
    expect((await h.state()).promotion).toMatchObject({ state: 'pending', memberIds: ['A', 'B'] });
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
    await deliverChecked(h, h.jobs[0], 'FAIL'); await h.tick();
    expect(h.jobs[1]).toMatchObject({ kind: 'validate-stack', baseCheck: true, canonicalBaseOid: main, candidates: [] });
    await deliverChecked(h, h.jobs[1], 'PASS'); await h.tick();
    await deliverChecked(h, h.jobs[2], 'PASS'); await h.tick();
    await deliverChecked(h, h.jobs[3], 'FAIL'); await h.tick();
    await deliverChecked(h, h.jobs[4], 'FAIL'); await h.tick();
    expect((h.jobs[5] as any).candidates.map((item: any) => item.changeId)).toEqual(['A', 'C']);
    await deliverChecked(h, h.jobs[5], 'PASS'); await h.tick();
    const state = await h.state();
    expect(state.diagnosis).toMatchObject({ reason: 'SINGLETON', blame: ['B'], survivors: ['A', 'C'] });
    expect(state.diagnosticResults).toHaveLength(5);
    expect(state.promotion.memberIds).toEqual(['A', 'C']);
    expect(state.entries.find((entry: any) => entry.changeId === 'B').state).toBe('blocked');
  });

  it('lands three generic candidates with arbitrary intents and pinned queue order', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    for (const [id, intent] of [['A', 'repair/alpha'], ['B', 'feature:beta'], ['C', 'misc.gamma']]) {
      const response = await addChange(h, id, [], 'local-demo', intent);
      expect(response.response.status).toBe(201);
    }
    await h.tick();
    const job = h.jobs[0];
    if (job.kind !== 'validate-stack' || job.bootstrap) throw new Error('expected generic stack');
    expect(job.caseId).toBeUndefined();
    expect(job.candidates.map(candidate => candidate.changeId)).toEqual(['A', 'B', 'C']);
    expect(job.canonicalBaseOid).toBe(main);
    expect(job.expectedRefs[`canonical-${h.repoId}`]).toBe(main);
    expect(job.candidates.map(candidate => job.expectedRefs[candidate.storageName])).toEqual(job.candidates.map(candidate => candidate.headOid));
    expect('unitPolicy' in job).toBe(false);
    expect(job.inputDigest).toBe(await digest(jobInput({ ...job,
      unitPolicy: localFixtureConfig('local').policies['local-demo'] })));
    expect((await h.queueData()).jobs.every((record: any) => !('unitPolicy' in record.job))).toBe(true);
    await deliverChecked(h, job, 'PASS'); await h.tick();
    expect((await h.state()).promotion).toMatchObject({ memberIds: ['A', 'B', 'C'], expectedOldOid: main });
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('2'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['landed', 'landed', 'landed']);
  });

  it('rewrites legacy queue job copies on its next save', async () => {
    const h = await setup('A');
    await h.tick();
    const job = h.jobs[0];
    expect(job.kind).toBe('validate-stack');
    await deliverChecked(h, job, 'PASS');
    await h.injectLegacyQueueCopies();
    await h.tick();
    expect((await h.state()).promotion).toBeTruthy();
    expect((await h.queueData()).jobs.every((record: any) => !('unitPolicy' in record.job))).toBe(true);
  });

  it('bisects a failing generic middle candidate and lands the survivors', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    for (const [id, intent] of [['A', 'first/unknown'], ['B', 'second/unknown'], ['C', 'third/unknown']]) {
      expect((await addChange(h, id, [], 'local-demo', intent)).response.status).toBe(201);
    }
    await h.tick();
    await deliverChecked(h, h.jobs[0], 'FAIL'); await h.tick();
    for (const [index, outcome] of [[1, 'PASS'], [2, 'PASS'], [3, 'FAIL'], [4, 'FAIL'], [5, 'PASS']] as const) {
      expect(h.jobs[index].caseId).toBeUndefined();
      await deliverChecked(h, h.jobs[index], outcome); await h.tick();
    }
    expect((await h.state()).diagnosis).toMatchObject({ reason: 'SINGLETON', blame: ['B'], survivors: ['A', 'C'] });
    expect((await h.state()).promotion.memberIds).toEqual(['A', 'C']);
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('7'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries.map((entry: any) => entry.state)).toEqual(['landed', 'blocked', 'landed']);
  });

  it.each([
    { name: 'descendant commit', outcome: 'PASS', composedOid: oid('3'), tree: oid('3') },
    { name: 'canonical OID with a different tree', outcome: 'PASS', composedOid: main, tree: oid('3') },
    { name: 'matching descendant commit', outcome: 'MATCH', composedOid: oid('5'), tree: oid('3') },
    { name: 'failed descendant commit', outcome: 'FAIL', composedOid: oid('4'), tree: oid('3') },
  ] as const)('rejects a baseline $outcome for $name before advancing diagnosis', async ({ outcome, composedOid, tree }) => {
    const h = await setup('A', 'B');
    await h.tick();
    await deliverChecked(h, h.jobs[0], 'FAIL'); await h.tick();
    const baseline = h.jobs[1];
    expect(baseline).toMatchObject({ kind: 'validate-stack', baseCheck: true, canonicalBaseOid: main, candidates: [] });
    const { response, body } = await deliverChecked(h, baseline, outcome, { composedOid, tree, expectedStatus: 409 });
    expect(response.status).toBe(409);
    expect(body.error.code).toBe('RESULT_IDENTITY');
    expect((await h.state()).diagnosis).toMatchObject({ phase: 'baseline' });
    expect(h.jobs).toHaveLength(2);
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
    await deliverChecked(h, h.jobs[0], 'FAIL'); await h.tick();
    expect(h.jobs[1]).toMatchObject({ kind: 'validate-stack', baseCheck: true, candidates: [] });
    await deliverChecked(h, h.jobs[1], 'PASS'); await h.tick();
    await deliverChecked(h, h.jobs[2], 'PASS'); await h.tick();
    await deliverChecked(h, h.jobs[3], 'PASS'); await h.tick();
    expect((await h.state()).diagnosis).toMatchObject({ reason: 'INTERACTION', blame: ['A', 'B'] });
    expect((await h.state()).promotion).toBeNull();
  });

  it.each([
    { name: 'red baseline', ids: ['A', 'B'], diagnostic: ['FAIL'], reason: 'BASE_RED' },
    { name: 'failed survivor check', ids: ['A', 'B'], diagnostic: ['PASS', 'FAIL', 'FAIL'], reason: 'INCONCLUSIVE' },
    { name: 'interaction inside a subset', ids: ['A', 'B', 'C'], diagnostic: ['PASS', 'PASS', 'FAIL', 'PASS', 'PASS'], reason: 'INTERACTION' },
  ])('blocks and releases every unresolved member after $name', async ({ ids, diagnostic, reason }) => {
    const h = await setup(...ids);
    await h.tick(); await deliverChecked(h, h.jobs[0], 'FAIL'); await h.tick();
    expect(h.jobs[1]).toMatchObject({ kind: 'validate-stack', baseCheck: true, candidates: [] });
    for (let i = 0; i < diagnostic.length; i++) {
      expect(h.jobs[i + 1]).toBeDefined();
      await deliverChecked(h, h.jobs[i + 1], diagnostic[i] as StackResult['outcome']); await h.tick();
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
    expect(retry.inputDigest).not.toBe(original.inputDigest);
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

  it('does not ticket an admission whose recorded base differs from live main', async () => {
    const h = await setup('A');
    await h.tick();
    const checked = h.jobs[0];
    const staleBase = oid('0');
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const state = context.state.get<any>('data');
      state.entries[0].baseOid = staleBase;
      context.state.put('data', state);
    });
    h.views.set('A', { ...h.views.get('A')!, baseOid: staleBase });
    expect((await h.deliver(checked, 'PASS')).status).toBe('eligible');
    await h.tick();
    expect((await h.state()).promotion).toBeNull();
  });

  it('blocks old admissions when enqueue observes external main before an alarm', async () => {
    const h = await setup('A');
    const nextMain = oid('4');
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', nextMain, main)).toBe(true);
    await h.seed(`candidate-${h.repoId}-B`);
    h.views.set('B', { ...h.views.get('A')!, headOid: oid('b'), baseOid: nextMain,
      candidateStorageName: `candidate-${h.repoId}-B`, unitKeys: ['row:B'] });
    const added = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'B', verdictId: 'v-B', leaseFences: { 'row:B': 1 } });
    expect(added.response.status).toBe(201);
    const state = await h.state();
    expect(state.observedMain).toBe(nextMain);
    expect(state.entries.map((entry: any) => [entry.changeId, entry.state, entry.blockedReason]))
      .toEqual([['A', 'blocked', 'STALE_MAIN'], ['B', 'reserved', null]]);
    expect(h.releases).toEqual(['A']);
    await h.tick();
    expect(h.jobs.filter(job => job.kind === 'validate-stack').every(job =>
      job.candidates.every(candidate => candidate.changeId !== 'A'))).toBe(true);
  });

  it('blocks old admissions when contest creation observes external main before an alarm', async () => {
    await dispatchContestFixture();
    const h = await setup('X');
    const nextMain = oid('4');
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', nextMain, main)).toBe(true);
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { ...h.views.get('X')!, headOid: oid(id.toLowerCase()), baseOid: nextMain,
        candidateStorageName: `candidate-${h.repoId}-${id}`, unitKeys: ['row:J'] });
    }
    const created = await h.fetch('/contests', { intentKey: 'shared-intent', intentText: 'compete',
      unitKey: 'row:J', baseOid: nextMain, profileId: 'local-demo', childChangeIds: ['A', 'B'],
      verdictIds: ['v-A', 'v-B'], leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
    expect(created.response.status).toBe(201);
    const state = await h.state();
    expect(state.observedMain).toBe(nextMain);
    expect(state.entries.map((entry: any) => [entry.changeId, entry.state, entry.blockedReason]))
      .toEqual([['X', 'blocked', 'STALE_MAIN'], ['A', 'reserved', null], ['B', 'reserved', null]]);
    expect(state.contests[0].state).toBe('open');
    expect(h.releases).toEqual(['X']);
  });

  it('blocks remaining old-base entries after its own stack lands, including a dependent', async () => {
    const h = await setup('B', 'D', 'E');
    for (const [id, deps] of [['F', []], ['A', ['B']], ['C', []]] as const) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1,
        status: 'ready', unitKeys: [`row:${id}`], frozen: false, baseOid: main,
        candidateStorageName: `candidate-${h.repoId}-${id}`, branch: 'refs/heads/work',
        dependencyChangeIds: [...deps], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo' });
    }
    // Admit the remaining cohort in one coordinator turn, before its due alarm schedules the first four.
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, h.repoId);
      const route = queue.routes.find(item => item.pattern.test(`/v1/repos/${h.repoId}/queue/enqueue`))!;
      for (const id of ['F', 'A', 'C']) {
        const response = await route.handle(context, new Request(`https://concord.test/v1/repos/${h.repoId}/queue/enqueue`,
          { method: 'POST' }), [] as unknown as RegExpMatchArray,
        { changeId: id, verdictId: `v-${id}`, leaseFences: { [`row:${id}`]: 1 } });
        expect(response.status).toBe(201);
      }
    });
    await h.tick();
    const checked = h.jobs[0];
    if (checked.kind !== 'validate-stack') throw new Error('expected stack job');
    expect(checked.candidates.map(candidate => candidate.changeId)).toEqual(['B', 'D', 'E', 'F']);
    expect((await h.deliver(checked, 'PASS')).status).toBe('eligible');
    await h.tick();
    expect((await h.state()).promotion).toMatchObject({ state: 'pending', memberIds: ['B', 'D', 'E', 'F'] });
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('e'), main)).toBe(true);
    await h.tick();
    const state = await h.state();
    expect(state.promotion).toMatchObject({ state: 'applied', reconciliation: 'EXACT_NEW_OID' });
    expect(state.finalCanonicalOid).toBe(oid('e'));
    expect(state.entries.map((entry: any) => [entry.changeId, entry.state, entry.blockedReason])).toEqual([
      ['B', 'landed', null], ['D', 'landed', null], ['E', 'landed', null], ['F', 'landed', null],
      ['A', 'blocked', 'STALE_MAIN'], ['C', 'blocked', 'STALE_MAIN'],
    ]);
    expect([...h.releases].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const generation = state.generation;
    await h.tick(); await h.tick();
    expect((await h.state()).generation).toBe(generation);
    expect((await h.state()).promotion.promotionId).toBe(state.promotion.promotionId);
    expect(h.jobs.filter(job => job.kind === 'promote')).toHaveLength(1);
    expect([...h.releases].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect((await h.deliver(checked, 'PASS')).status).toBe('blocked');
    expect((await h.state()).promotion.promotionId).toBe(state.promotion.promotionId);

    const stale = await h.fetch('/queue/enqueue', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId: 'A', verdictId: 'v-A', leaseFences: { 'row:A': 1 } });
    expect(stale.response.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_BASE');
  });

  it('requires withdrawal, rebase, republish, and revision-bound review before recovery', async () => {
    const h = harness;
    const unit = 'row:recovery';
    const config = localFixtureConfig('local');
    config.policies['local-demo'].units[unit] = { canonicalKey: unit, file: 'recovery.tsv',
      resources: [], dependencyKeys: [] };
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    repos.changeView = original.changeView;
    verdicts.hooks['verdicts.gate'] = original.verdict;
    findings.hooks['findings.gate'] = (_context, id, revision) => revision === h.findingsVersion.get(id)
      ? gate({ findingSetVersion: revision, unresolvedIds: [], pendingRound: null })
      : { status: 'blocked', version: 1, code: 'FINDINGS_STALE', reason: 'Wrong revision', evidenceIds: [] };
    const post = async (path: string, body: Record<string, unknown>, actor = 'local-agent-a') => {
      const response = await worker.fetch(mutation(`/v1/repos/${h.repoId}${path}`, body, crypto.randomUUID(), actor), env);
      return { response, body: await responseBody(response) };
    };
    const createdRepo = await worker.fetch(mutation('/v1/repos', {
      name: h.repoId, policyId: 'local-demo', profileId: 'local-demo',
    }, crypto.randomUUID()), env);
    expect(createdRepo.status).toBe(201);
    const repo = (await responseBody(createdRepo)).data;
    await h.fetch('');
    await h.seed(repo.canonicalStorageName);
    await h.seed(`concord-s-${h.repoId}`, null);
    const created = await post('/changes', { intentKey: 'recovery', intentText: 'repair', baseOid: main,
      branch: 'refs/heads/work', unitKeys: [unit], dependencyChangeIds: [] });
    expect(created.response.status).toBe(201);
    const changeId = created.body.data.changeId as string;
    const storageName = created.body.data.candidateStorageName as string;
    const branch = 'refs/heads/work';
    const firstHead = oid('a');
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'repos', actor: Principal, repoId: string): ModuleContext };
      const storage = internal.context('repos', principal, h.repoId).storage as FakeStorage;
      storage.putCommit(storageName, { oid: firstHead, treeOid: oid('3'), parents: [main] });
      expect(storage.conditionalUpdateRef(storageName, branch, null, firstHead)).toBe(true);
    });
    const register = async (headOid: string) => post('/branches', {
      expectedVersion: (await h.fetch(`/changes/${changeId}`)).body.version,
      storageName, ref: branch, observedHead: headOid, ownerId: 'agent-a',
    });
    expect((await register(firstHead)).response.status).toBe(201);
    const publish = async (baseOid: string, headOid: string) => post(`/changes/${changeId}/publish`, {
      expectedVersion: (await h.fetch(`/changes/${changeId}`)).body.version,
      baseOid, headOid, branch, unitKeys: [unit], leaseFences: { [unit]: 1 },
    });
    expect((await publish(main, firstHead)).response.status).toBe(202);
    const manifestFor = (revision: number): ReviewManifest => ({
      changedUnits: [{ unitKey: unit, beforePath: 'recovery.tsv', afterPath: 'recovery.tsv',
        beforeMode: '100644', afterMode: '100644', beforeDigest: `sha256:${'4'.repeat(64)}`,
        afterDigest: `sha256:${String(revision + 4).repeat(64)}` }],
      policyVersion: config.policies['local-demo'].version, policyDigest: config.policies['local-demo'].digest,
      checkerDigest: config.policies['local-demo'].checkerDigest,
      oracleDigest: config.profiles['local-demo'].oracleDigest,
      toolchainDigest: config.profiles['local-demo'].toolchainDigest,
      coverage: 'complete', dependencyScope: [],
    });
    const inspect = async (revision: number, expectedStatus = 200) => {
      const manifest = manifestFor(revision);
      const reviewManifestDigest = manifestDigest(manifest, config.policies['local-demo'], [unit]);
      await h.fetch('/queue');
      const job = h.jobs.find(item => item.kind === 'inspect-candidate' && item.changeId === changeId && item.revision === revision);
      expect(job?.kind).toBe('inspect-candidate');
      if (job?.kind !== 'inspect-candidate') throw new Error(`Missing inspection for revision ${revision}`);
      const runnerId = `recovery-checker-${revision}`;
      const poll = await post('/runner/poll', {
        runnerId, role: 'checker', supportedProfileDigests: [job.profileDigest],
      }, 'local-checker');
      expect(poll.response.status).toBe(200);
      const claimed = poll.body.data.job as Job;
      expect(claimed.jobId).toBe(job.jobId);
      if (claimed.kind !== 'inspect-candidate') throw new Error('Expected inspection job');
      const preimage = {
        kind: 'inspect-candidate' as const, jobId: claimed.jobId, attempt: claimed.attempt, fence: claimed.fence,
        inputDigest: claimed.inputDigest, sourceTreeOid: oid('3'), checkerDigest: claimed.checkerDigest,
        toolchainDigest: claimed.toolchainDigest, oracleDigest: claimed.oracleDigest,
        environmentDigest: claimed.environmentDigest, durationMs: 1, log: '', outcome: 'PASS' as const,
        observedHeadOid: claimed.candidate.headOid, unitKeys: [unit], reviewManifestDigest,
        reviewManifest: manifest,
      };
      const resultDigest = await digest(preimage);
      const result = await post(`/jobs/${job.jobId}/result`, {
        attempt: claimed.attempt, fence: claimed.fence, inputDigest: claimed.inputDigest,
        resultDigest, result: { ...preimage, resultDigest },
      }, 'local-checker');
      expect(result.response.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(result.body.data.dispatch.status).toBe('eligible');
        h.findingsVersion.set(changeId, revision);
      }
      return { reviewManifestDigest, result };
    };
    const review = async (revision: number, reviewManifestDigest: string) => post(`/changes/${changeId}/verdicts`, {
      expectedVersion: (await h.fetch('/snapshot')).body.version,
      revision, reviewManifestDigest, findingSetVersion: revision, decision: 'approve',
      evidenceDigest: `sha256:${'6'.repeat(64)}`,
    }, 'local-reviewer');
    const enqueue = async (verdictId: string) => h.fetch('/queue/enqueue', {
      expectedVersion: (await h.fetch('/queue')).body.version, changeId, verdictId, leaseFences: { [unit]: 1 },
    });
    const firstDigest = (await inspect(1)).reviewManifestDigest;
    const firstReview = await review(1, firstDigest);
    expect(firstReview.response.status).toBe(201);
    const firstVerdict = firstReview.body.data.verdictId as string;
    expect((await enqueue(firstVerdict)).response.status).toBe(201);
    const nextMain = oid('4');
    expect(await h.put(repo.canonicalStorageName, 'refs/heads/main', nextMain, main)).toBe(true);
    expect((await enqueue(firstVerdict)).response.status).toBe(409);
    const withdrawn = await h.fetch('/queue/withdraw', { expectedVersion: (await h.fetch('/queue')).body.version,
      changeId, reason: 'rebase onto current main' });
    expect(withdrawn.response.status).toBe(200);
    expect((await enqueue(firstVerdict)).body.error.code).toBe('STALE_BASE');
    expect((await h.state()).promotion).toBeNull();
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'repos', actor: Principal, repoId: string): ModuleContext };
      const storage = internal.context('repos', principal, h.repoId).storage as FakeStorage;
      // Fetch the new canonical commit into the candidate fork before checking ancestry.
      storage.putCommit(storageName, { oid: nextMain, treeOid: oid('3'), parents: [main] });
    });
    // A claimed new base without new ancestry cannot produce a passing inspection.
    expect((await publish(nextMain, firstHead)).response.status).toBe(202);
    const unrebased = await inspect(2, 409);
    expect(unrebased.result.body.error.code).toBe('RESULT_IDENTITY');
    expect((await h.fetch(`/changes/${changeId}`)).body.data.status).toBe('draft');
    expect((await enqueue(firstVerdict)).body.error.code).toBe('CHANGE_NOT_READY');
    expect((await h.state()).promotion).toBeNull();
    const secondHead = oid('b');
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const internal = instance as unknown as { context(name: 'repos', actor: Principal, repoId: string): ModuleContext };
      const storage = internal.context('repos', principal, h.repoId).storage as FakeStorage;
      storage.putCommit(storageName, { oid: secondHead, treeOid: oid('3'), parents: [nextMain] });
      expect(storage.conditionalUpdateRef(storageName, branch, firstHead, secondHead)).toBe(true);
    });
    const rebased = await runInDurableObject<RepoCoordinator, string[]>(stub, instance => {
      const internal = instance as unknown as { context(name: 'repos', actor: Principal, repoId: string): ModuleContext };
      const storage = internal.context('repos', principal, h.repoId).storage as FakeStorage;
      return storage.readCommit(storageName, secondHead).then(commit => commit?.parents ?? []);
    });
    expect(rebased).toEqual([nextMain]);
    expect((await register(secondHead)).response.status).toBe(200);
    expect((await publish(nextMain, secondHead)).response.status).toBe(202);
    expect((await enqueue(firstVerdict)).body.error.code).toBe('CHANGE_NOT_READY');
    const secondDigest = manifestDigest(manifestFor(3), config.policies['local-demo'], [unit]);
    expect((await review(3, secondDigest)).body.error.code).toBe('REVIEW_REQUIRED');
    expect((await h.state()).promotion).toBeNull();
    expect((await inspect(3)).reviewManifestDigest).toBe(secondDigest);
    expect((await h.fetch(`/changes/${changeId}`)).body.data.status).toBe('ready');
    expect((await enqueue(firstVerdict)).body.error.code).toBe('REVIEW_REQUIRED');
    expect((await review(1, firstDigest)).body.error.code).toBe('INVALID_VERDICT');
    const secondReview = await review(3, secondDigest);
    expect(secondReview.response.status).toBe(201);
    const secondVerdict = secondReview.body.data.verdictId as string;
    expect(secondVerdict).not.toBe(firstVerdict);
    expect((await enqueue(firstVerdict)).body.error.code).toBe('VERDICT_STALE');
    expect((await h.state()).promotion).toBeNull();
    expect((await enqueue(secondVerdict)).response.status).toBe(201);
    await h.tick();
    const job = h.jobs.find(item => item.kind === 'validate-stack' && item.candidates.some(candidate => candidate.changeId === changeId));
    expect(job).toBeDefined();
    expect(job?.kind === 'validate-stack' && job.candidates[0].revision).toBe(3);
    expect((await h.deliver(job!, 'PASS')).status).toBe('eligible');
    await h.tick();
    expect((await h.state()).promotion).toMatchObject({ state: 'pending', memberIds: [changeId] });
  });

  it('closes an open contest once when external main makes both children stale', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }, { id: 'B', unit: 'row:J' }], ['A']);
    await contestReal(h);
    expect((await h.state()).contests[0].state).toBe('open');
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('4'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).contests[0]).toMatchObject({ state: 'blocked', reason: 'STALE_MAIN' });
    expect((await h.state()).entries.map((entry: any) => [entry.state, entry.blockedReason]))
      .toEqual([['blocked', 'STALE_MAIN'], ['blocked', 'STALE_MAIN']]);
    expect(await contestReleaseCount(h)).toBe(1);
    await h.tick();
    expect(await contestReleaseCount(h)).toBe(1);
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

  it('retries the queue scratch identity reads when storage visibility lags once', async () => {
    const h = await setup('A');
    await h.tick();
    const job = h.jobs[0];
    expect((await h.deliver(job, 'PASS')).status).toBe('eligible');
    if (job.kind !== 'validate-stack') throw new Error('expected stack job');

    let staleRef = true;
    let staleCommit = true;
    FakeStorage.prototype.resolveRef = async function(name, ref) {
      if (name === job.scratchStorageName && ref === job.scratchRef && staleRef) {
        staleRef = false;
        return null;
      }
      return originalStorageResolveRef.call(this, name, ref);
    };
    FakeStorage.prototype.readCommit = async function(name, commitOid) {
      if (name === job.scratchStorageName && commitOid === oid('e') && staleCommit) {
        staleCommit = false;
        return null;
      }
      return originalStorageReadCommit.call(this, name, commitOid);
    };

    await h.tick();

    expect(staleRef).toBe(false);
    expect(staleCommit).toBe(false);
    expect((await h.state()).promotion).toMatchObject({ state: 'pending', checkedNewOid: oid('e') });
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
    h.views.set('A', { ...h.views.get('A')!, issueNumber: 1 });
    const issueStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(issueStub, (_instance, durable) => {
      const store = sqlState(durable.storage.sql);
      store.put('module:issues:items', [{ number: 1, title: 'Queue task', body: '', labels: [], milestoneId: null, allowedFiles: null, state: 'open', authorId: 'owner', version: 1, reason: null, closedBy: null }]);
      store.put('module:repos:changes', [{ changeId: 'A', issueNumber: 1 }]);
    });
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
    expect((await h.fetch('/issues/1')).body.data.state).toBe('open');
    expect(state.promotion.jobIds).toHaveLength(2);
    const attempts = h.jobs.filter(job => job.kind === 'promote');
    expect(attempts).toHaveLength(2);
    expect(attempts[1].inputDigest).not.toBe(attempts[0].inputDigest);
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
    expect((await h.fetch('/issues/1')).body.data).toMatchObject({ state: 'closed', closedBy: { changeId: 'A', canonicalOid: oid('e') } });
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

  it('keeps a failed bootstrap ticket while its promotion claim is live', async () => {
    const h = harness;
    await h.fetch('/queue');
    await h.seed(`canonical-${h.repoId}`, null);
    await h.seed(`scratch-${h.repoId}`, null);
    await h.seed(`seed-${h.repoId}`, null);
    await h.put(`seed-${h.repoId}`, 'refs/heads/seed', oid('a'));
    const seed: BootstrapHandoff = { seedStorageName: `seed-${h.repoId}`, seedRef: 'refs/heads/seed', headOid: oid('a'),
      canonicalStorageName: `canonical-${h.repoId}`, scratchStorageName: `scratch-${h.repoId}`,
      policyId: 'local-demo', profileId: 'local-demo', jobId: 'original-bootstrap' };
    expect((await h.bootstrap(seed)).status).toBe('eligible');
    await h.tick();
    await h.deliver(h.jobs[0], 'PASS');
    await h.tick();
    const promotion = h.jobs.find(job => job.kind === 'promote')!;
    const claim = await worker.fetch(mutation(`/v1/repos/${h.repoId}/runner/poll`, {
      runnerId: 'claimed-promoter', role: 'promoter', supportedProfileDigests: [promotion.profileDigest],
    }, 'claimed-promoter-poll', 'local-promoter'), env);
    expect(claim.status).toBe(200);
    expect((await responseBody(claim)).data.job.jobId).toBe(promotion.jobId);
    // A queue result alone does not release the runner's claim.
    expect((await h.promoteResult(promotion, 'OLD_REF', null)).status).toBe('eligible');
    await h.tick();
    expect((await h.state()).promotion).toMatchObject({ state: 'failed', bootstrap: true });
    const config = localFixtureConfig('local');
    config.profiles['local-demo'].digest = `sha256:${'b'.repeat(64)}`;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    await expect(h.bootstrap({ ...seed, jobId: 'replacement-bootstrap', repin: true }))
      .rejects.toMatchObject({ code: 'BOOTSTRAP_BUSY' });
    expect((await h.state()).promotion).toMatchObject({ state: 'failed', jobId: promotion.jobId });
  });

  it('refuses a generic repository contest before looking up unavailable children', async () => {
    const h = await prepareReal([{ id: 'A', unit: 'row:J' }], ['A']);
    const refused = await h.fetch('/contests', { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'missing'], verdictIds: ['v-A', 'v-missing'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
    expect(refused.response.status).toBe(409);
    expect(refused.body.error.code).toBe('CONTEST_UNSUPPORTED_FOR_PROFILE');
    expect((await leaseState(h, 'A')).state).toBe('active');
    expect((await h.state()).contests).toEqual([]);
    expect(h.jobs).toHaveLength(0);
  });

  it.each(['hard-gates', 'score'] as const)('refuses a generic %s contest through the public API before reservation or scheduling', async kind => {
    const h = harness;
    const config = localFixtureConfig('local');
    if (kind === 'score') config.policies['local-demo'].acceptance = { kind: 'score', gates: [{ id: 'default', requiredOutcome: 'PASS' }], fixedDenominator: 4 };
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    for (const id of ['A', 'B']) {
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
    }
    const refused = await h.fetch('/contests', { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
    expect(refused.response.status).toBe(409);
    expect(refused.body.error.code).toBe('CONTEST_UNSUPPORTED_FOR_PROFILE');
    expect((await h.state()).contests).toEqual([]);
    expect(h.jobs).toHaveLength(0);
    expect(h.releases).toEqual([]);
  });

  it('chooses the first valid green contest result and supersedes the loser', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    const issueStub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    await runInDurableObject<RepoCoordinator, void>(issueStub, (_instance, durable) => {
      const store = sqlState(durable.storage.sql);
      store.put('module:issues:items', [{ number: 1, title: 'Contest loser', body: '', labels: [], milestoneId: null, allowedFiles: null, state: 'open', authorId: 'owner', version: 1, reason: null, closedBy: null }]);
      store.put('module:repos:changes', [{ changeId: 'A', issueNumber: 1 }]);
    });
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
    }
    const created = await contest(h, { intentKey: 'J', intentText: 'compete', unitKey: 'row:J',
      baseOid: main, profileId: 'local-demo', childChangeIds: ['A', 'B'], verdictIds: ['v-A', 'v-B'],
      leaseFences: [{ 'row:J': 1 }, { 'row:J': 1 }] });
    expect(created.response.status).toBe(201);
    await h.tick();
    if (h.jobs.length !== 2) throw new Error(JSON.stringify(h.jobs.map(job => ({ jobId: job.jobId, candidates: job.kind === 'validate-stack' ? job.candidates.map(item => item.changeId) : [] }))));
    expect(h.jobs.map(job => ({ caseId: job.caseId, contest: job.contest })))
      .toEqual([{ caseId: 'j-common', contest: true }, { caseId: 'j-common', contest: true }]);
    await h.deliver(h.jobs[1], 'PASS'); await h.tick();
    await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    const state = await h.state();
    expect(state.contests[0]).toMatchObject({ state: 'selected', winnerId: 'B', reason: 'FIRST_VALID_GREEN' });
    expect(state.entries.find((entry: any) => entry.changeId === 'A').state).toBe('failed');
    expect((await h.fetch('/issues/1')).body.data.state).toBe('open');
    expect(['reserved', 'checking']).toContain(state.entries.find((entry: any) => entry.changeId === 'B').state);
    expect(h.releases).toEqual(['A']);
    await h.tick();
    expect((h.jobs[2] as any).candidates.map((item: any) => item.changeId)).toEqual(['B']);
  });

  it.each(['A,B', 'B,A'])('settles both valid children delivered %s before one alarm', async order => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
    }
    await contestReal(h);
    await h.tick();
    expect(h.jobs).toHaveLength(2);
    const jobs = Object.fromEntries(h.jobs.map(job => [job.kind === 'validate-stack' ? job.candidates[0].changeId : '', job]));
    const [first, second] = order.split(',') as ['A' | 'B', 'A' | 'B'];
    await h.deliver(jobs[first], 'PASS');
    await h.deliver(jobs[second], 'PASS');
    await h.tick();
    if ((await h.state()).contests[0].state === 'open') await h.tick();
    expect((await h.state()).contests[0]).toMatchObject({ state: 'selected', winnerId: first });
  });

  it.each(['A,B', 'B,A'])('rejects a bad digest delivered %s before one alarm', async order => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
    }
    await contestReal(h);
    await h.tick();
    const jobs = Object.fromEntries(h.jobs.map(job => [job.kind === 'validate-stack' ? job.candidates[0].changeId : '', job]));
    const [first, second] = order.split(',') as ['A' | 'B', 'A' | 'B'];
    await h.deliver(jobs[first], 'PASS', { badDigest: first === 'B' });
    await h.deliver(jobs[second], 'PASS', { badDigest: second === 'B' });
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${h.repoId}`));
    const stored = await runInDurableObject<RepoCoordinator, any>(stub, instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      return internal.context('queue', principal, h.repoId).state.get<any>('data');
    });
    expect(stored.jobs.find((item: any) => item.job.jobId === jobs.B.jobId).result).toBeUndefined();
    await h.tick();
    expect((await h.state()).contests[0]).toMatchObject({ state: 'blocked', reason: 'RESULT_DIGEST_MISMATCH', winnerId: null });
    expect((await h.state()).promotion).toBeNull();
  });

  it('checks the stored sibling scratch result before selecting a valid child', async () => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
    }
    await contestReal(h);
    await h.tick();
    const jobs = Object.fromEntries(h.jobs.map(job => [job.kind === 'validate-stack' ? job.candidates[0].changeId : '', job]));
    await h.deliver(jobs.A, 'PASS');
    await h.deliver(jobs.B, 'PASS');
    if (jobs.B.kind !== 'validate-stack') throw new Error('expected contest child job');
    expect(await h.put(jobs.B.scratchStorageName, jobs.B.scratchRef, oid('f'), oid('e'))).toBe(true);
    await h.tick();
    if ((await h.state()).contests[0].state === 'open') await h.tick();
    expect((await h.state()).contests[0]).toMatchObject({ state: 'blocked', reason: 'CHECKED_SCRATCH_MISMATCH', winnerId: null });
  });

  it.each([
    ['A,B', 'PASS'], ['B,A', 'PASS'], ['A,B', 'FAIL'], ['B,A', 'FAIL'],
  ] as const)('waits for the retry with %s delivery and %s retry outcome', async (order, retryOutcome) => {
    const h = harness;
    await h.seed(`canonical-${h.repoId}`);
    await h.seed(`scratch-${h.repoId}`, null);
    for (const id of ['A', 'B']) {
      await h.seed(`candidate-${h.repoId}-${id}`);
      h.views.set(id, { authorId: 'agent-a', headOid: oid(id.toLowerCase()), revision: 1, status: 'ready',
        unitKeys: ['row:J'], frozen: false, baseOid: main, candidateStorageName: `candidate-${h.repoId}-${id}`,
        branch: 'refs/heads/work', dependencyChangeIds: [], canonicalStorageName: `canonical-${h.repoId}`,
        scratchStorageName: `scratch-${h.repoId}`, policyId: 'local-demo', profileId: 'local-demo', intentKey: 'J' });
    }
    await contestReal(h);
    await h.tick();
    const jobs = Object.fromEntries(h.jobs.map(job => [job.kind === 'validate-stack' ? job.candidates[0].changeId : '', job]));
    for (const id of order.split(',')) await h.deliver(jobs[id], id === 'A' ? 'TIMEOUT' : 'PASS');
    await h.tick();
    await h.tick();
    expect(h.jobs).toHaveLength(3);
    expect((await h.state()).contests[0]).toMatchObject({ state: 'open', winnerId: null });
    await h.deliver(h.jobs[2], retryOutcome);
    await h.tick();
    expect((await h.state()).contests[0]).toMatchObject({ state: 'blocked', reason: 'SUSPECTED_FLAKE', winnerId: null });
    expect((await h.state()).promotion).toBeNull();
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
    const ordinary = { ...green(0), score: null };
    expect(accepted(ordinary, policy, false)).toBe(true);
    expect(accepted(ordinary, policy, true)).toBe(false);
    expect(accepted({ ...ordinary, gateResults: [{ gateId: 'default', outcome: 'FAIL' }] }, policy, false)).toBe(false);
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
