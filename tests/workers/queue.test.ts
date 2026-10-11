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
  findings: findings.hooks['findings.gate'], verdict: verdicts.hooks['verdicts.gate'],
  schedule: runners.hooks['runners.schedule'],
};
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
  findings.hooks['findings.gate'] = original.findings;
  verdicts.hooks['verdicts.gate'] = original.verdict;
  runners.hooks['runners.schedule'] = original.schedule;
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

  it('coalesces for two seconds when fewer than four are available', async () => {
    const h = await setup('A');
    await h.tick(false);
    expect(h.jobs).toHaveLength(0);
    expect((await h.state()).entries[0].state).toBe('waiting');
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
    expect(state.entries[0].state).toBe('merged');
    expect(state.finalCanonicalOid).toBe(oid('e'));
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
    expect((await h.state()).entries[0].state).not.toBe('merged');
    expect((await h.state()).promotion.state).toBe('pending');
    expect(await h.put(`canonical-${h.repoId}`, 'refs/heads/main', oid('e'), main)).toBe(true);
    await h.tick();
    expect((await h.state()).entries[0].state).toBe('merged');
  });

  it('releases a confirmed old-ref failure for rechecking', async () => {
    const h = await setup('B');
    await h.tick(); await h.deliver(h.jobs[0], 'PASS'); await h.tick();
    const promote = h.jobs.find(job => job.kind === 'promote')!;
    expect((await h.promoteResult(promote, 'OLD_REF', main)).status).toBe('eligible');
    await h.tick();
    const state = await h.state();
    expect(state.promotion).toMatchObject({ state: 'failed', reconciliation: 'CONFIRMED_OLD_REF' });
    expect(state.entries[0].state).toBe('waiting');
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
    expect(state.entries.find((entry: any) => entry.changeId === 'A').state).toBe('superseded');
    expect(['waiting', 'checking']).toContain(state.entries.find((entry: any) => entry.changeId === 'B').state);
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
