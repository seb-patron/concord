import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { leases } from '../../src/features/leases';
import { repos } from '../../src/features/repos';
import type { Change, Event, ModuleContext, Principal, Repo, TrustedConfiguration } from '../../src/contracts';
import { appendEvent, eventSequence, loadTrustedConfig, localFixtureConfig, sqlState } from '../../src/state';
import { changedUnitsForFile, normalizeUnits, overlaps, resolveUnit, unitRegistry } from '../../src/leases/units';
import { apiRequest, mutation, responseBody } from '../helpers';

const policy = localFixtureConfig('local').policies['local-demo'];
policy.units = {
  'symbol:sub_02000100': { canonicalKey: 'symbol:sub_02000100', file: 'src/code.c', resources: ['symbol:sub_02000100'], dependencyKeys: [] },
  'declaration:callee_alpha': { canonicalKey: 'declaration:callee_alpha', file: 'src/code.h', resources: ['callee_alpha'], dependencyKeys: [] },
  'declaration:old_callee_alpha': { canonicalKey: 'declaration:callee_alpha', file: 'src/code.h', resources: ['callee_alpha'], dependencyKeys: [] },
  'row:families:alpha': { canonicalKey: 'row:families:alpha', file: 'data/families.tsv', resources: ['alpha'], dependencyKeys: [] },
  'row:families:beta': { canonicalKey: 'row:families:beta', file: 'data/families.tsv', resources: ['beta'], dependencyKeys: [] },
};
const trusted: TrustedConfiguration = { policies: { 'local-demo': policy }, profiles: localFixtureConfig('local').profiles };
const previousTrustedConfig = (env as Env).TRUSTED_CONFIG;
const previousChangeView = repos.changeView;

afterEach(() => { (env as Env).TRUSTED_CONFIG = previousTrustedConfig; repos.changeView = previousChangeView; delete policy.tables; delete policy.newFilePrefixes; });

function setupPolicy(): void {
  (env as Env).TRUSTED_CONFIG = JSON.stringify(trusted);
  repos.changeView = (context, changeId) => {
    const change = sqlState(context.sql).get<Change>(`module:repos:change:${changeId}`);
    if (!change || change.repoId !== context.repoId || change.changeId !== changeId) {
      return { status: 'blocked', version: context.version(), code: 'CHANGE_NOT_FOUND', reason: 'Change missing', evidenceIds: [] };
    }
    return { status: 'eligible', version: context.version(), evidenceIds: [changeId], value: {
      authorId: change.authorId, headOid: change.headOid, revision: change.revision,
      status: change.status, unitKeys: change.unitKeys, frozen: false,
    } };
  };
}

const fetchApi = (request: Request) => worker.fetch(request, env);
const path = (repo: string) => `/v1/repos/${repo}/leases`;
async function claim(repo: string, actor: string, changeId: string, unitKeys: string[], key: string, extra: Record<string, unknown> = {}) {
  await runInDurableObject(stubFor(repo), async (_instance, state) => seedClaim(state, repo, changeId, actor.replace(/^local-/, '')));
  return fetchApi(mutation(path(repo), { changeId, unitKeys, intentText: `Work by ${actor}`, ...extra }, key, actor));
}

async function releaseLease(repo: string, actor: string, lease: { leaseId: string; fence: number }, key: string) {
  const version = (await responseBody(await fetchApi(apiRequest(path(repo), actor)))).version;
  return fetchApi(mutation(`${path(repo)}/${lease.leaseId}/release`, { expectedVersion: version, fence: lease.fence }, key, actor));
}

async function cancelLeaseWait(repo: string, actor: string, waitId: string, key: string) {
  const version = (await responseBody(await fetchApi(apiRequest(path(repo), actor)))).version;
  return fetchApi(apiRequest(`${path(repo)}/waits/${waitId}`, actor, {
    method: 'DELETE', headers: { 'idempotency-key': key }, body: JSON.stringify({ expectedVersion: version }),
  }));
}

async function listing(repo: string) {
  const response = await fetchApi(apiRequest(path(repo), 'local-viewer'));
  expect(response.status).toBe(200);
  return (await responseBody(response)).data;
}

function contextFor(state: DurableObjectState, repoId: string, principalId: string, now: () => number): ModuleContext {
  const sql = state.storage.sql;
  const base = sqlState(sql);
  const principal: Principal = { tenantId: 'local', principalId, roles: ['agent'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
  const context: ModuleContext = {
    repoId, tenantId: 'local', principal, env, trusted, sql, now,
    storage: {} as ModuleContext['storage'],
    transaction: <T>(run: () => T) => state.storage.transactionSync(run),
    version: () => base.get<number>('repo:version') ?? 0,
    nextVersion: () => {
      const version = (base.get<number>('repo:version') ?? 0) + 1;
      base.put('repo:version', version);
      return version;
    },
    appendEvent: (kind: string, relatedIds: string[], payload: Record<string, unknown>, version: number): Event => appendEvent(context, kind, relatedIds, payload, version),
    state: { get: <T>(key: string) => base.get<T>(`module:leases:${key}`),
      put: <T>(key: string, value: T) => base.put(`module:leases:${key}`, value),
      delete: (key: string) => base.delete(`module:leases:${key}`) },
    call: (() => { throw new Error('unused'); }) as ModuleContext['call'],
    readChange: changeId => repos.changeView?.(context, changeId) ?? {
      status: 'blocked', version: context.version(), code: 'MODULE_UNAVAILABLE', reason: 'Repos change view unavailable', evidenceIds: [],
    },
  };
  return context;
}

function stubFor(repo: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
}

function fakeReadyChange(repo: string, changeId: string, authorId: string, unitKeys: string[]): Change {
  return {
    changeId, repoId: repo, authorId, intentKey: `intent-${changeId}`,
    intentText: `Work by ${authorId}`, candidateStorageName: `candidate-${changeId}`,
    branch: 'main', baseOid: 'base', headOid: `head-${changeId}`,
    revision: 1, unitKeys, dependencyChangeIds: [], status: 'ready', version: 1,
  };
}

function seedClaim(state: DurableObjectState, repoId: string, changeId: string, authorId: string): void {
  const store = sqlState(state.storage.sql);
  const repo: Repo = {
    repoId, tenantId: 'local', displayName: repoId, canonicalStorageName: repoId,
    defaultBranch: 'main', observedCanonicalOid: null, policyId: 'local-demo',
    policyDigest: policy.digest, profileId: 'local-demo', status: 'ready', version: 1,
  };
  store.put('module:repos:repo', repo);
  store.put(`module:repos:change:${changeId}`, fakeReadyChange(repoId, changeId, authorId, []));
}

function addVerified(state: DurableObjectState, change: Change, unitKeys = change.unitKeys): void {
  const store = sqlState(state.storage.sql);
  store.put(`module:repos:change:${change.changeId}`, change);
  store.put(`module:repos:verified:${change.changeId}`, {
    changeId: change.changeId, revision: change.revision, headOid: change.headOid,
    policyDigest: policy.digest, unitKeys, verifiedBy: 'checker',
  });
}

describe('semantic lease identities', () => {
  it('claims exact new paths under a prefix and conflicts only on the same path', async () => {
    policy.newFilePrefixes = ['tests/'];
    setupPolicy();
    const repo = 'lease_new_file_prefix';
    const first = await claim(repo, 'local-agent-a', 'first', ['file:tests/new.test.ts'], 'first');
    expect(first.status).toBe(201);
    expect((await responseBody(first)).data.leases[0].unitKey).toBe('file:tests/new.test.ts');
    expect((await claim(repo, 'local-agent-b', 'other', ['file:tests/other.test.ts'], 'other')).status).toBe(201);
    const rival = await claim(repo, 'local-agent-b', 'rival', ['file:tests/new.test.ts'], 'rival');
    expect(rival.status).toBe(409);
    expect((await responseBody(rival)).error.code).toBe('LEASE_CONFLICT');
    const outside = await claim(repo, 'local-agent-b', 'outside', ['file:src/new.ts'], 'outside');
    expect(outside.status).toBe(422);
    expect((await responseBody(outside)).error.code).toBe('UNKNOWN_UNIT');
  });
  it('validates owner TSV declarations and maps only matching new keys', () => {
    const declared = structuredClone(policy);
    declared.tables = [{ name: 'jobs', file: 'data/jobs.tsv', header: ['job', 'value'],
      keyColumn: 'job', keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } }];
    const registry = unitRegistry(declared);
    expect(resolveUnit(registry, 'row:jobs:zeta')).toMatchObject({ file: 'data/jobs.tsv', resources: ['data/jobs.tsv#zeta'] });
    expect(() => resolveUnit(registry, 'row:jobs:zeta7')).toThrow('Unit key is not registered');
    expect(() => resolveUnit(registry, 'row:jobs:zeta!')).toThrow('Unit key is not registered');
    expect(() => resolveUnit(registry, 'row:other:zeta')).toThrow('Unit key is not registered');
    expect(changedUnitsForFile(registry, 'data/jobs.tsv', 'job\tvalue\nalpha\told\n',
      'job\tvalue\nalpha\told\nzeta\tnew\n').map(unit => unit.key)).toEqual(['row:jobs:zeta']);
    expect(changedUnitsForFile(registry, 'data/jobs.tsv', 'job\tvalue\nalpha\told\n',
      'job\tvalue\nalpha\told\nzeta7\tnew\n').map(unit => unit.key)).toEqual(['file:data/jobs.tsv']);
    expect(changedUnitsForFile(registry, 'data/jobs.tsv', 'job\tvalue\nbad7\tunchanged\nalpha\told\n',
      'job\tvalue\nbad7\tunchanged\nalpha\tnew\n').map(unit => unit.key)).toEqual(['file:data/jobs.tsv']);
    expect(changedUnitsForFile(registry, 'data/jobs.tsv', 'job\tvalue\nalpha\told\n',
      'job\tchanged\nalpha\told\n').map(unit => unit.key)).toEqual(['file:data/jobs.tsv']);
    const config = { policies: { 'local-demo': declared }, profiles: trusted.profiles };
    expect(loadTrustedConfig({ CONCORD_MODE: 'local', TRUSTED_CONFIG: JSON.stringify(config) }).policies['local-demo'].tables).toEqual(declared.tables);
    for (const keySpec of [
      { charset: '^([a-z]+)+$', minLength: 1, maxLength: 256 },
      { charset: 'lower', minLength: 0, maxLength: 256 },
      { charset: 'lower', minLength: 1, maxLength: 257 },
      { charset: ['a', 'a'], minLength: 1, maxLength: 2 },
      { charset: ['ab'], minLength: 1, maxLength: 2 },
    ]) {
      expect(() => loadTrustedConfig({ CONCORD_MODE: 'local', TRUSTED_CONFIG: JSON.stringify({ ...config, policies: {
        'local-demo': { ...declared, tables: [{ ...declared.tables![0], keySpec }] },
      } }) })).toThrow('TABLE_KEY_SPEC_INVALID');
    }
    expect(() => loadTrustedConfig({ CONCORD_MODE: 'local', TRUSTED_CONFIG: JSON.stringify({ ...config, policies: {
      'local-demo': { ...declared, tables: [{ ...declared.tables![0], keyPattern: '^([a-z]+)+$' }] },
    } }) })).toThrow('TABLE_KEY_SPEC_INVALID');
    expect(() => loadTrustedConfig({ CONCORD_MODE: 'local', TRUSTED_CONFIG: JSON.stringify({ ...config, policies: {
      'local-demo': { ...declared, tables: [{ name: 'jobs', file: 'data/jobs.tsv', header: ['job', 'value'],
        keyColumn: 'job', keyPattern: '^([a-z]+)+$' }] },
    } }) })).toThrow('TABLE_KEY_SPEC_INVALID');
  });

  it('matches complete bounded keys and retains colons in declared row identities', () => {
    const declared = structuredClone(policy);
    declared.tables = [{ name: 'jobs', file: 'data/jobs.tsv', header: ['job', 'value'], keyColumn: 'job',
      keySpec: { charset: ['a', 'b', ':'], minLength: 3, maxLength: 3 } }];
    declared.units = { 'row:jobs:a:b': { canonicalKey: 'row:jobs:a:b', file: 'data/jobs.tsv',
      resources: ['data/jobs.tsv#a:b'], dependencyKeys: [] } };
    const registry = unitRegistry(declared);
    expect(resolveUnit(registry, 'row:jobs:a:b').resources).toEqual(['data/jobs.tsv#a:b']);
    expect(() => resolveUnit(registry, 'row:jobs:a:b!')).toThrow('Unit key is not registered');
    expect(() => resolveUnit(registry, 'row:jobs:a:')).toThrow('Unit key is not registered');
    expect(changedUnitsForFile(registry, 'data/jobs.tsv', 'job\tvalue\na:b\told\n',
      'job\tvalue\na:b\tnew\n').map(unit => unit.key)).toEqual(['row:jobs:a:b']);
  });

  it('claims and reserves distinct new rows while refusing the same key with holder intent', async () => {
    policy.tables = [{ name: 'jobs', file: 'data/jobs.tsv', header: ['job', 'value'],
      keyColumn: 'job', keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } }];
    setupPolicy();
    const repo = 'lease_pattern_rows';
    const zeta = await claim(repo, 'local-agent-a', 'zeta-change', ['row:jobs:zeta'], 'zeta');
    const eta = await claim(repo, 'local-agent-b', 'eta-change', ['row:jobs:eta'], 'eta');
    expect([zeta.status, eta.status]).toEqual([201, 201]);
    const rival = await claim(repo, 'local-agent-b', 'rival', ['row:jobs:zeta'], 'rival');
    expect(rival.status).toBe(409);
    expect((await responseBody(rival)).error).toMatchObject({ code: 'LEASE_CONFLICT', details: { intentText: 'Work by local-agent-a' } });
    for (const [index, key] of ['row:jobs:zeta7', 'row:other:zeta'].entries()) {
      const denied = await claim(repo, 'local-agent-b', 'unknown-' + index, [key], 'unknown-' + index);
      expect(denied.status).toBe(422);
      expect((await responseBody(denied)).error.code).toBe('UNKNOWN_UNIT');
    }
    const zetaLease = (await responseBody(zeta)).data.leases[0];
    const etaLease = (await responseBody(eta)).data.leases[0];
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      for (const [id, actor, unit, lease] of [
        ['zeta-change', 'agent-a', 'row:jobs:zeta', zetaLease],
        ['eta-change', 'agent-b', 'row:jobs:eta', etaLease],
      ] as const) {
        const change = fakeReadyChange(repo, id, actor, [unit]);
        addVerified(state, change);
        const context = contextFor(state, repo, actor, Date.now);
        expect(context.transaction(() => leases.hooks['leases.reserve']!(context, id, { [unit]: lease.fence }))).toMatchObject({ status: 'eligible' });
      }
    });
  });
  it('normalizes aliases, contains file footprints, and lets distinct rows coexist', () => {
    const registry = unitRegistry(policy);
    const aliases = normalizeUnits(registry, ['declaration:old_callee_alpha', 'declaration:callee_alpha']);
    expect(aliases.map(unit => unit.key)).toEqual(['declaration:callee_alpha']);
    expect(overlaps(resolveUnit(registry, 'file:src/code.h'), aliases[0])).toBe(true);
    expect(overlaps(resolveUnit(registry, 'row:families:alpha'), resolveUnit(registry, 'row:families:beta'))).toBe(false);
    expect(() => resolveUnit(registry, 'file:src/unregistered.h')).toThrow();
    expect(() => normalizeUnits(registry, Array.from({ length: 17 }, (_, i) => `unknown:${i}`))).toThrow();
    expect(changedUnitsForFile(registry, 'data/families.tsv', 'alpha\told\nbeta\told\n', 'alpha\tnew\nbeta\told\n')
      .map(unit => unit.key)).toEqual(['row:families:alpha']);
    expect(changedUnitsForFile(registry, 'data/families.tsv', 'alpha\told\n', 'gamma\tnew\n')
      .map(unit => unit.key)).toEqual(['file:data/families.tsv']);
    expect(changedUnitsForFile(registry, 'data/families.tsv', 'alpha\tone\nalpha\ttwo\n', 'alpha\tnew\n')
      .map(unit => unit.key)).toEqual(['file:data/families.tsv']);
    const many = structuredClone(policy);
    many.units = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
      `row:many:${index}`, { canonicalKey: `row:many:${index}`, file: 'data/many.tsv', resources: [`${index}`], dependencyKeys: [] },
    ]));
    const manyRegistry = unitRegistry(many);
    const keys = Object.keys(many.units);
    expect(normalizeUnits(manyRegistry, keys.slice(0, 16))).toHaveLength(16);
    expect(() => normalizeUnits(manyRegistry, keys)).toThrow();
    const ambiguous = structuredClone(policy);
    ambiguous.units['row:other:alpha'] = { canonicalKey: 'row:other:alpha', file: 'data/families.tsv', resources: ['other-alpha'], dependencyKeys: [] };
    expect(() => unitRegistry(ambiguous)).toThrow('UNIT_REGISTRY_INVALID');
  });
});

describe('lease wait queue', () => {
  const alpha = 'row:families:alpha';
  const beta = 'row:families:beta';

  it('grants FIFO on release, reports position and fences, and prevents barging', async () => {
    setupPolicy();
    const repo = 'lease_wait_fifo';
    const first = (await responseBody(await claim(repo, 'local-agent-a', 'holder', [alpha], 'holder'))).data.leases[0];
    const w1 = await claim(repo, 'local-agent-b', 'wait-one', [alpha], 'wait-one', { wait: true });
    const w2 = await claim(repo, 'local-agent-c', 'wait-two', [alpha], 'wait-two', { wait: true });
    expect(w1.status).toBe(202);
    expect(w2.status).toBe(202);
    const one = (await responseBody(w1)).data;
    const two = (await responseBody(w2)).data;
    expect(one).toMatchObject({ code: 'LEASE_QUEUED', position: 1, holderId: 'agent-a', keys: [alpha] });
    expect(two.position).toBe(2);
    const late = await claim(repo, 'local-agent-c', 'late', [alpha], 'late');
    expect(late.status).toBe(409);
    expect((await responseBody(late)).error.details.queue[0].waitId).toBe(one.waitId);
    expect((await releaseLease(repo, 'local-agent-a', first, 'release-first')).status).toBe(200);
    const granted = (await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${one.waitId}`, 'local-agent-b')))).data;
    expect(granted).toMatchObject({ state: 'granted', leases: [{ unitKey: alpha, holderId: 'agent-b', fence: 2 }] });
    expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${two.waitId}`, 'local-agent-c')))).data.position).toBe(1);
    expect((await releaseLease(repo, 'local-agent-b', granted.leases[0], 'release-second')).status).toBe(200);
    expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${two.waitId}`, 'local-agent-c')))).data)
      .toMatchObject({ state: 'granted', leases: [{ unitKey: alpha, holderId: 'agent-c', fence: 3 }] });
    const events = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repo}/events`, 'local-owner')))).data.items;
    expect(events.filter((event: Event) => event.kind === 'lease.queued')).toHaveLength(2);
    expect(events.filter((event: Event) => event.kind === 'lease.granted_from_queue')).toHaveLength(2);
  });

  it('waits for every unit, then grants atomically', async () => {
    setupPolicy();
    const repo = 'lease_wait_multi';
    const first = (await responseBody(await claim(repo, 'local-agent-a', 'hold-a', [alpha], 'hold-a'))).data.leases[0];
    const second = (await responseBody(await claim(repo, 'local-agent-c', 'hold-b', [beta], 'hold-b'))).data.leases[0];
    const wait = (await responseBody(await claim(repo, 'local-agent-b', 'both', [alpha, beta], 'both', { wait: true }))).data;
    expect((await releaseLease(repo, 'local-agent-a', first, 'release-a')).status).toBe(200);
    expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${wait.waitId}`, 'local-agent-b')))).data.state).toBe('queued');
    expect((await claim(repo, 'local-agent-a', 'barge', [alpha], 'barge')).status).toBe(409);
    expect((await releaseLease(repo, 'local-agent-c', second, 'release-b')).status).toBe(200);
    expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${wait.waitId}`, 'local-agent-b')))).data.leases)
      .toMatchObject([{ unitKey: alpha, fence: 2 }, { unitKey: beta, fence: 2 }]);
  });

  it('cancels closed and no longer owned waits before granting the next claimant', async () => {
    setupPolicy();
    const repo = 'lease_wait_stale_change';
    const held = (await responseBody(await claim(repo, 'local-agent-a', 'holder', [alpha], 'holder'))).data.leases[0];
    const closed = (await responseBody(await claim(repo, 'local-agent-b', 'closed', [alpha], 'closed', { wait: true }))).data;
    const reassigned = (await responseBody(await claim(repo, 'local-agent-c', 'reassigned', [alpha], 'reassigned', { wait: true }))).data;
    const next = (await responseBody(await claim(repo, 'local-agent-b', 'next', [alpha], 'next', { wait: true }))).data;
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      const store = sqlState(state.storage.sql);
      for (const [changeId, update] of [['closed', { status: 'closed' }], ['reassigned', { authorId: 'agent-a' }]] as const) {
        const change = store.get<Change>(`module:repos:change:${changeId}`)!;
        store.put(`module:repos:change:${changeId}`, { ...change, ...update });
      }
    });
    expect((await releaseLease(repo, 'local-agent-a', held, 'release-stale')).status).toBe(200);
    for (const [wait, actor] of [[closed, 'local-agent-b'], [reassigned, 'local-agent-c']] as const) {
      expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${wait.waitId}`, actor)))).data.state).toBe('cancelled');
    }
    const granted = (await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${next.waitId}`, 'local-agent-b')))).data;
    expect(granted).toMatchObject({ state: 'granted', leases: [{ holderId: 'agent-b', unitKey: alpha, fence: 2 }] });
    const events = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repo}/events`, 'local-owner')))).data.items as Event[];
    expect(events.filter(event => event.kind === 'lease.wait_cancelled').map(event => event.payload))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ waitId: closed.waitId, reason: 'change_not_open' }),
        expect.objectContaining({ waitId: reassigned.waitId, reason: 'change_not_open' }),
      ]));
  });

  it('derives ETA through an earlier multi-unit wait', async () => {
    setupPolicy();
    const repo = 'lease_wait_eta_chain';
    await claim(repo, 'local-agent-a', 'holder', [beta], 'holder');
    const first = (await responseBody(await claim(repo, 'local-agent-b', 'first', [alpha, beta], 'first', { wait: true }))).data;
    const second = (await responseBody(await claim(repo, 'local-agent-c', 'second', [alpha], 'second', { wait: true }))).data;
    expect(first.etaSeconds).toBeGreaterThan(0);
    expect(second.etaSeconds).toBeGreaterThan(0);
    const polled = (await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${second.waitId}`, 'local-agent-c')))).data;
    expect(polled.etaSeconds).toBeGreaterThan(0);
  });

  it('cancels only for author or owner and expires waits', async () => {
    setupPolicy();
    const repo = 'lease_wait_cancel';
    await claim(repo, 'local-agent-a', 'holder', [alpha], 'holder');
    const wait = (await responseBody(await claim(repo, 'local-agent-b', 'waiting', [alpha], 'waiting', { wait: true, waitSeconds: 30 }))).data;
    expect((await fetchApi(apiRequest(`${path(repo)}/waits/${wait.waitId}`, 'local-agent-c'))).status).toBe(403);
    expect((await fetchApi(apiRequest(`${path(repo)}/waits/${wait.waitId}`, 'local-owner'))).status).toBe(200);
    expect((await cancelLeaseWait(repo, 'local-agent-c', wait.waitId, 'bad-cancel')).status).toBe(403);
    expect((await cancelLeaseWait(repo, 'local-agent-b', wait.waitId, 'cancel')).status).toBe(200);
    expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${wait.waitId}`, 'local-agent-b')))).data.state).toBe('cancelled');
    const expiring = (await responseBody(await claim(repo, 'local-agent-b', 'expiring', [alpha], 'expiring', { wait: true, waitSeconds: 30 }))).data;
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      const context = contextFor(state, repo, 'agent-b', () => Date.now() + 31_000);
      leases.onAlarm(context);
    });
    expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${expiring.waitId}`, 'local-agent-b')))).data.state).toBe('expired');
    const events = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repo}/events`, 'local-owner')))).data.items;
    expect(events.map((event: Event) => event.kind)).toContain('lease.wait_cancelled');
    expect(events.map((event: Event) => event.kind)).toContain('lease.wait_expired');
  });

  it('grants after holder expiry and enforces per-change cap', async () => {
    setupPolicy();
    const repo = 'lease_wait_expire';
    await claim(repo, 'local-agent-a', 'holder', [alpha], 'holder', { ttlSeconds: 1 });
    const waits = [];
    for (let index = 0; index < 8; index++) {
      const result = await claim(repo, 'local-agent-b', 'waiting', [alpha], `wait-${index}`, { wait: true });
      expect(result.status).toBe(202);
      waits.push((await responseBody(result)).data);
    }
    const full = await claim(repo, 'local-agent-b', 'waiting', [alpha], 'wait-over-cap', { wait: true });
    expect(full.status).toBe(429);
    expect((await responseBody(full)).error.code).toBe('WAIT_QUEUE_FULL');
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      const context = contextFor(state, repo, 'agent-a', () => Date.now() + 2_000);
      leases.onAlarm(context);
    });
    expect((await responseBody(await fetchApi(apiRequest(`${path(repo)}/waits/${waits[0].waitId}`, 'local-agent-b')))).data)
      .toMatchObject({ state: 'granted', leases: [{ fence: 2 }] });
  });

  it('limits queued waits to 64 per repository', async () => {
    setupPolicy();
    const repo = 'lease_wait_repo_cap';
    await claim(repo, 'local-agent-a', 'holder', [alpha], 'holder');
    for (let index = 0; index < 64; index++) {
      const response = await claim(repo, 'local-agent-b', `change-${index}`, [alpha], `wait-${index}`, { wait: true });
      expect(response.status).toBe(202);
    }
    const full = await claim(repo, 'local-agent-c', 'overflow', [alpha], 'overflow', { wait: true });
    expect(full.status).toBe(429);
    expect((await responseBody(full)).error.code).toBe('WAIT_QUEUE_FULL');
  });

  it('refuses a direct hold-and-wait cycle', async () => {
    setupPolicy();
    const repo = 'lease_wait_cycle';
    await claim(repo, 'local-agent-a', 'change-a', [alpha], 'hold-a');
    await claim(repo, 'local-agent-b', 'change-b', [beta], 'hold-b');
    expect((await claim(repo, 'local-agent-a', 'change-a', [beta], 'wait-a', { wait: true })).status).toBe(202);
    const cycle = await claim(repo, 'local-agent-b', 'change-b', [alpha], 'wait-b', { wait: true });
    expect(cycle.status).toBe(409);
    expect((await responseBody(cycle)).error.code).toBe('LEASE_WAIT_DEADLOCK');
  });

  it('refuses a cycle through an older wait for an unheld unit', async () => {
    setupPolicy();
    const repo = 'lease_wait_fifo_cycle';
    const gamma = 'declaration:callee_alpha';
    await claim(repo, 'local-agent-a', 'change-a', [alpha], 'hold-a');
    await claim(repo, 'local-agent-b', 'change-b', [beta], 'hold-b');
    expect((await claim(repo, 'local-agent-a', 'change-a', [beta, gamma], 'wait-a', { wait: true })).status).toBe(202);
    const cycle = await claim(repo, 'local-agent-b', 'change-b', [gamma], 'wait-b', { wait: true });
    expect(cycle.status).toBe(409);
    expect((await responseBody(cycle)).error).toMatchObject({
      code: 'LEASE_WAIT_DEADLOCK', details: { cycle: ['change-b', 'change-a', 'change-b'] },
    });
  });

  it('refuses a transitive hold-and-wait cycle', async () => {
    setupPolicy();
    const repo = 'lease_wait_long_cycle';
    const gamma = 'declaration:callee_alpha';
    await claim(repo, 'local-agent-a', 'change-a', [alpha], 'hold-a');
    await claim(repo, 'local-agent-b', 'change-b', [beta], 'hold-b');
    await claim(repo, 'local-agent-c', 'change-c', [gamma], 'hold-c');
    expect((await claim(repo, 'local-agent-a', 'change-a', [beta], 'wait-a', { wait: true })).status).toBe(202);
    expect((await claim(repo, 'local-agent-b', 'change-b', [gamma], 'wait-b', { wait: true })).status).toBe(202);
    const cycle = await claim(repo, 'local-agent-c', 'change-c', [alpha], 'wait-c', { wait: true });
    expect(cycle.status).toBe(409);
    expect((await responseBody(cycle)).error.code).toBe('LEASE_WAIT_DEADLOCK');
  });
});

describe('RepoCoordinator lease routes', () => {
  it('refuses claims without a repository record or a registered change view', async () => {
    setupPolicy();
    const repo = 'lease_missing_repo';
    const request = (key: string) => mutation(path(repo), {
      changeId: 'unowned', unitKeys: ['row:families:alpha'], intentText: 'Claim without authority',
    }, key, 'local-agent-a');
    const absent = await fetchApi(request('absent-repo'));
    expect(absent.status).toBe(404);
    expect((await responseBody(absent)).error.code).toBe('REPO_NOT_FOUND');
    await runInDurableObject(stubFor(repo), async (_instance, state) => seedClaim(state, repo, 'unowned', 'agent-a'));
    repos.changeView = undefined;
    const unavailable = await fetchApi(request('absent-view'));
    expect(unavailable.status).toBe(501);
    expect((await responseBody(unavailable)).error.code).toBe('MODULE_UNAVAILABLE');
    expect((await listing(repo)).items).toEqual([]);
  });

  it('requires an owned active change from the repos change view', async () => {
    setupPolicy();
    const repo = 'lease_change_owner';
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      seedClaim(state, repo, 'other-owner', 'agent-b');
      seedClaim(state, repo, 'closed', 'agent-a');
      sqlState(state.storage.sql).put('module:repos:change:closed', {
        ...fakeReadyChange(repo, 'closed', 'agent-a', []), status: 'closed',
      });
    });
    for (const [changeId, key] of [['other-owner', 'other-owner'], ['closed', 'closed'], ['missing', 'missing']]) {
      const result = await fetchApi(mutation(path(repo), {
        changeId, unitKeys: ['row:families:alpha'], intentText: 'Invalid ownership',
      }, key, 'local-agent-a'));
      expect(result.status).toBe(403);
      expect((await responseBody(result)).error.code).toBe('CHANGE_NOT_OWNED');
    }
    expect((await listing(repo)).items).toEqual([]);
  });

  it('pages 127 older live leases and 100 newer released leases without losing any', async () => {
    setupPolicy();
    const repo = 'lease_many_live';
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      seedClaim(state, repo, 'seed', 'local-agent-a');
      const now = Date.now();
      for (let index = 0; index < 227; index++) {
        const live = index < 127;
        state.storage.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          `seed-${index}`, `row:seed:${index}`, 'local-agent-a', 'seed', 'Seeded lease', 1,
          now + 60_000, live ? 'active' : 'released', 1, now + index, now + index);
      }
    });
    const seen = new Set<string>();
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    do {
      const response = await fetchApi(apiRequest(`${path(repo)}${cursor ? `?cursor=${cursor}` : ''}`, 'local-viewer'));
      expect(response.status).toBe(200);
      const page = (await responseBody(response)).data;
      expect(page.items.length).toBeLessThanOrEqual(100);
      pageSizes.push(page.items.length);
      for (const item of page.items as Array<{ leaseId: string }>) {
        expect(seen.has(item.leaseId)).toBe(false);
        seen.add(item.leaseId);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(pageSizes).toEqual([100, 100, 27]);
    expect(seen.size).toBe(227);
    for (let index = 0; index < 127; index++) expect(seen.has(`seed-${index}`)).toBe(true);
    expect((await fetchApi(apiRequest(`${path(repo)}?cursor=%%%`, 'local-viewer'))).status).toBe(400);
  });

  it('exposes all issue-linked held leases in snapshots at 100, 101, and 128', async () => {
    setupPolicy();
    for (const count of [100, 101, 128]) {
      const repo = `lease_issue_snapshot_${count}`;
      await runInDurableObject(stubFor(repo), async (_instance, state) => {
        seedClaim(state, repo, 'seed', 'agent-a');
        const store = sqlState(state.storage.sql);
        const change = store.get<Change>('module:repos:change:seed')!;
        store.put('module:repos:change:seed', { ...change, issueNumber: 1 });
        const now = Date.now();
        for (let index = 0; index < count; index++) {
          state.storage.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            `held-${index}`, `row:seed:${index}`, 'agent-a', 'seed', 'Issue work', 1,
            now + 60_000, 'active', 1, now + index, now + index);
        }
      });
      const response = await fetchApi(apiRequest(`/v1/repos/${repo}/snapshot`, 'local-viewer'));
      expect(response.status).toBe(200);
      const projection = (await responseBody(response)).data.projections.leases;
      expect(projection.items).toHaveLength(100);
      expect(projection.heldItems).toHaveLength(count);
      expect(new Set(projection.heldItems.map((item: { leaseId: string }) => item.leaseId)).size).toBe(count);
      expect(projection.heldItems.every((item: { issueNumber: number; state: string }) => item.issueNumber === 1 && item.state === 'active')).toBe(true);
    }
  });

  it('keeps every remaining live lease exactly once when a page-one lease is released', async () => {
    setupPolicy();
    const repo = 'lease_page_release';
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      seedClaim(state, repo, 'seed', 'agent-a');
      const now = Date.now();
      for (let index = 0; index < 227; index++) {
        state.storage.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          `live-${index}`, `row:seed:${index}`, 'agent-a', 'seed', 'Seeded lease', 1,
          now + 60_000, index < 127 ? 'active' : 'released', 1, now + index, now + index);
      }
      sqlState(state.storage.sql).put('repo:version', 1);
    });
    const firstResponse = await fetchApi(apiRequest(path(repo), 'local-viewer'));
    expect(firstResponse.status).toBe(200);
    const first = (await responseBody(firstResponse)).data;
    expect(first.items).toHaveLength(100);
    const released = first.items[0].leaseId as string;
    expect(first.items.every((item: { state: string }) => item.state === 'active')).toBe(true);
    const releaseResponse = await fetchApi(mutation(`${path(repo)}/${released}/release`,
      { expectedVersion: 1, fence: 1 }, 'release-between-pages', 'local-agent-a'));
    expect(releaseResponse.status).toBe(200);

    const seen = new Set<string>(first.items.map((item: { leaseId: string }) => item.leaseId));
    let cursor: string | null = first.nextCursor;
    const later: string[] = [];
    for (let pageNumber = 0; cursor && pageNumber < 4; pageNumber++) {
      const response = await fetchApi(apiRequest(`${path(repo)}?cursor=${cursor}`, 'local-viewer'));
      expect(response.status).toBe(200);
      const page = (await responseBody(response)).data;
      for (const item of page.items as Array<{ leaseId: string }>) {
        expect(seen.has(item.leaseId)).toBe(false);
        seen.add(item.leaseId);
        later.push(item.leaseId);
      }
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(later).toContain('live-26');
    expect(seen.size).toBe(227);
    for (let index = 0; index < 127; index++) expect(seen.has(`live-${index}`)).toBe(true);
  });

  it('serializes concurrent claims, refuses the entire multi-key request, and isolates repositories', async () => {
    setupPolicy();
    const repo = 'lease_race';
    const [a, b] = await Promise.all([
      claim(repo, 'local-agent-a', 'change-a', ['row:families:alpha'], 'race-a'),
      claim(repo, 'local-agent-b', 'change-b', ['row:families:alpha'], 'race-b'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const denied = a.status === 409 ? a : b;
    const deniedBody = await responseBody(denied);
    expect(deniedBody.error).toMatchObject({ code: 'LEASE_CONFLICT', details: { keys: ['row:families:alpha'] } });
    expect(deniedBody.error.details).toHaveProperty('holderId');
    expect(deniedBody.error.details).toHaveProperty('intentText');
    expect(deniedBody.error.details).toHaveProperty('expiresAt');
    const failedSet = await claim(repo, 'local-agent-b', 'change-multi', ['row:families:alpha', 'row:families:beta'], 'multi');
    expect(failedSet.status).toBe(409);
    const after = await listing(repo);
    expect(after.items.filter((item: { state: string }) => item.state === 'active')).toHaveLength(1);
    expect(after.refusals).toHaveLength(2);
    expect(after.refusals[0].nextAction).toContain('retry');
    expect((await claim('lease_other_repo', 'local-agent-b', 'change-b', ['row:families:alpha'], 'other')).status).toBe(201);
  });

  it('conflicts through file and declaration aliases, but grants separate table rows', async () => {
    setupPolicy();
    const repo = 'lease_aliases';
    expect((await claim(repo, 'local-agent-a', 'first', ['declaration:old_callee_alpha'], 'alias-one')).status).toBe(201);
    const alias = await claim(repo, 'local-agent-b', 'second', ['declaration:callee_alpha'], 'alias-two');
    expect(alias.status).toBe(409);
    const file = await claim(repo, 'local-agent-b', 'second', ['file:src/code.h'], 'file-conflict');
    expect(file.status).toBe(409);
    expect((await claim(repo, 'local-agent-a', 'row-a', ['row:families:alpha'], 'row-a')).status).toBe(201);
    expect((await claim(repo, 'local-agent-b', 'row-b', ['row:families:beta'], 'row-b')).status).toBe(201);
    const unknown = await claim(repo, 'local-agent-b', 'unknown', ['file:src/unknown.ts'], 'unknown');
    expect(unknown.status).toBe(422);
    expect((await responseBody(unknown)).error.code).toBe('UNKNOWN_UNIT');
  });

  it('uses server TTL, monotonic fences, and rejects stale holders after reacquisition', async () => {
    setupPolicy();
    const repo = 'lease_lifetime';
    const tooLong = await claim(repo, 'local-agent-a', 'too-long', ['symbol:sub_02000100'], 'ttl-invalid', { ttlSeconds: 301 });
    expect(tooLong.status).toBe(422);
    expect((await responseBody(tooLong)).error.code).toBe('INVALID_TTL');
    const grant = await claim(repo, 'local-agent-a', 'first', ['symbol:sub_02000100'], 'lifetime');
    expect(grant.status).toBe(201);
    const lease = (await responseBody(grant)).data.leases[0];
    expect(lease.expiresAt).toBeGreaterThan(Date.now() + 115000);
    expect((await listing(repo)).renewAfterSeconds).toBe(40);
    const renewPath = `${path(repo)}/${lease.leaseId}/renew`;
    const wrong = await fetchApi(mutation(renewPath, { expectedVersion: 1, fence: lease.fence }, 'wrong-holder', 'local-agent-b'));
    expect(wrong.status).toBe(409);
    const renewed = await fetchApi(mutation(renewPath, { expectedVersion: 1, fence: lease.fence }, 'renew', 'local-agent-a'));
    expect(renewed.status).toBe(200);
    const next = (await responseBody(renewed)).data.lease;
    expect(next.fence).toBeGreaterThan(lease.fence);
    const releasePath = `${path(repo)}/${lease.leaseId}/release`;
    expect((await fetchApi(mutation(releasePath, { expectedVersion: 2, fence: lease.fence }, 'old-fence', 'local-agent-a'))).status).toBe(409);
    expect((await fetchApi(mutation(releasePath, { expectedVersion: 2, fence: next.fence }, 'release', 'local-agent-a'))).status).toBe(200);
    const replacement = await claim(repo, 'local-agent-b', 'second', ['symbol:sub_02000100'], 'replacement');
    expect(replacement.status).toBe(201);
    expect((await responseBody(replacement)).data.leases[0].fence).toBeGreaterThan(next.fence);
    expect((await fetchApi(mutation(releasePath, { expectedVersion: 4, fence: next.fence }, 'after-replace', 'local-agent-a'))).status).toBe(409);
    expect((await listing(repo)).items.some((item: { state: string; intentText: string }) => item.state === 'released' && item.intentText === 'Work by local-agent-a')).toBe(true);
  });

  it('expires at server time before an alarm and makes alarm replay harmless', async () => {
    setupPolicy();
    const repo = 'lease_expiry';
    const grant = await claim(repo, 'local-agent-a', 'first', ['row:families:alpha'], 'expiring', { ttlSeconds: 1 });
    expect(grant.status).toBe(201);
    const original = (await responseBody(grant)).data.leases[0];
    const stub = stubFor(repo);
    await runInDurableObject(stub, async (_instance, state) => {
      const now = () => original.expiresAt + 1;
      const oldContext = contextFor(state, repo, 'agent-a', now);
      const newContext = contextFor(state, repo, 'agent-b', now);
      const action = leases.routes.find(route => route.method === 'POST' && route.pattern.test(`${path(repo)}/${original.leaseId}/renew`))!;
      expect(() => action.handle(oldContext, new Request(`https://concord.test${path(repo)}/${original.leaseId}/renew`),
        `${path(repo)}/${original.leaseId}/renew`.match(action.pattern)!, { fence: original.fence })).toThrow();
      const route = leases.routes.find(item => item.method === 'POST' && item.pattern.test(path(repo)))!;
      seedClaim(state, repo, 'second', 'agent-b');
      const replacementResponse = await route.handle(newContext, new Request(`https://concord.test${path(repo)}`),
        path(repo).match(route.pattern)!, { changeId: 'second', intentText: 'Second intent', unitKeys: ['row:families:alpha'] });
      expect(replacementResponse.status).toBe(201);
      const replacement = (await responseBody(replacementResponse)).data.leases[0];
      expect(replacement.fence).toBeGreaterThan(original.fence);
      const eventCount = eventSequence(state.storage.sql);
      await leases.onAlarm(newContext);
      await leases.onAlarm(newContext);
      expect(eventSequence(state.storage.sql)).toBe(eventCount);
    });
    const history = await listing(repo);
    expect(history.items.some((item: { leaseId: string; state: string }) => item.leaseId === original.leaseId && item.state === 'expired')).toBe(true);
  });

  it('reserves only checker-verified writes, holds through heartbeat loss, and releases on terminal queue evidence', async () => {
    setupPolicy();
    const repo = 'lease_reservation';
    const grant = await claim(repo, 'local-agent-a', 'ready', ['row:families:alpha'], 'reserve');
    expect(grant.status).toBe(201);
    const item = (await responseBody(grant)).data.leases[0];
    const extraGrant = await claim(repo, 'local-agent-a', 'ready', ['row:families:beta'], 'reserve-extra');
    expect(extraGrant.status).toBe(201);
    const extra = (await responseBody(extraGrant)).data.leases[0];
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      const context = contextFor(state, repo, 'agent-a', Date.now);
      const reserve = leases.hooks['leases.reserve']!;
      expect(reserve(context, 'ready', { [item.unitKey]: item.fence })).toMatchObject({ status: 'blocked', code: 'UNVERIFIED_FOOTPRINT' });
      const change = fakeReadyChange(repo, 'ready', 'agent-a', ['row:families:alpha']);
      addVerified(state, change, ['row:families:beta']);
      expect(reserve(context, 'ready', { [item.unitKey]: item.fence })).toMatchObject({ status: 'blocked', code: 'UNDECLARED_WRITE' });
      addVerified(state, change);
      expect(reserve(context, 'ready', { [item.unitKey]: item.fence - 1 })).toMatchObject({ status: 'blocked', code: 'LEASE_STALE' });
      expect(reserve(context, 'ready', { [item.unitKey]: item.fence, [extra.unitKey]: extra.fence })).toMatchObject({ status: 'blocked', code: 'UNLEASED_WRITE' });
      const admitted = context.transaction(() => reserve(context, 'ready', { [item.unitKey]: item.fence }));
      expect(admitted).toMatchObject({ status: 'eligible', value: { reservationFences: { [item.unitKey]: item.fence } } });
      const reserved = state.storage.sql.exec<{ state: string; expires_at: number }>('SELECT state, expires_at FROM leases_claims WHERE lease_id = ?', item.leaseId).toArray()[0];
      expect(reserved.state).toBe('reserved');
      expect(reserved.expires_at).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
      expect(reserve(context, 'ready', { [item.unitKey]: item.fence })).toMatchObject({ status: 'eligible' });
      expect(state.storage.sql.exec<{ expires_at: number }>('SELECT expires_at FROM leases_claims WHERE lease_id = ?', item.leaseId).toArray()[0].expires_at).toBe(reserved.expires_at);
      const releaseRoute = leases.routes.find(route => route.method === 'POST' && route.pattern.test(`${path(repo)}/${item.leaseId}/release`))!;
      expect(() => releaseRoute.handle(context, new Request(`https://concord.test${path(repo)}/${item.leaseId}/release`),
        `${path(repo)}/${item.leaseId}/release`.match(releaseRoute.pattern)!, { fence: item.fence })).toThrow();
      expect(leases.hooks['leases.releaseReservation']!(context, 'ready')).toMatchObject({ status: 'blocked', code: 'QUEUE_NOT_TERMINAL' });
      sqlState(state.storage.sql).put('module:queue:entry:ready', { changeId: 'ready', state: 'checking' });
      expect(leases.hooks['leases.releaseReservation']!(context, 'ready')).toMatchObject({ status: 'blocked', code: 'QUEUE_NOT_TERMINAL' });
      context.transaction(() => {
        sqlState(state.storage.sql).put('module:queue:entry:ready', { changeId: 'ready', state: 'merged' });
        expect(leases.hooks['leases.releaseReservation']!(context, 'ready')).toMatchObject({ status: 'eligible' });
      });
    });
    const releaseAttempt = await fetchApi(mutation(`${path(repo)}/${item.leaseId}/release`,
      { expectedVersion: (await responseBody(await fetchApi(apiRequest(path(repo))))).version, fence: item.fence }, 'agent-release', 'local-agent-a'));
    expect(releaseAttempt.status).toBe(409);
    const after = await listing(repo);
    expect(after.items.find((entry: { leaseId: string }) => entry.leaseId === item.leaseId).state).toBe('released');
  });

  it('bounds a queue reservation to 30 minutes even when the alarm is late', async () => {
    setupPolicy();
    const repo = 'lease_queue_timeout';
    const grant = await claim(repo, 'local-agent-a', 'timeout-change', ['row:families:beta'], 'timeout-grant', { ttlSeconds: 1 });
    const item = (await responseBody(grant)).data.leases[0];
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      const context = contextFor(state, repo, 'agent-a', Date.now);
      addVerified(state, fakeReadyChange(repo, 'timeout-change', 'agent-a', [item.unitKey]));
      expect(leases.hooks['leases.reserve']!(context, 'timeout-change', { [item.unitKey]: item.fence }).status).toBe('eligible');
      const reserved = state.storage.sql.exec<{ expires_at: number }>('SELECT expires_at FROM leases_claims WHERE lease_id = ?', item.leaseId).toArray()[0];
      expect(reserved.expires_at).toBeGreaterThan(item.expiresAt);
      const later = contextFor(state, repo, 'agent-b', () => reserved.expires_at + 1);
      const route = leases.routes.find(entry => entry.method === 'POST' && entry.pattern.test(path(repo)))!;
      seedClaim(state, repo, 'later', 'agent-b');
      const replacementResponse = await route.handle(later, new Request(`https://concord.test${path(repo)}`),
        path(repo).match(route.pattern)!, { changeId: 'later', intentText: 'Later work', unitKeys: [item.unitKey] });
      expect(replacementResponse.status).toBe(201);
      expect((await responseBody(replacementResponse)).data.leases[0].fence).toBeGreaterThan(item.fence);
      const events = eventSequence(state.storage.sql);
      await leases.onAlarm(later);
      expect(eventSequence(state.storage.sql)).toBe(events);
    });
  });

  it('shares only an owner-created contest parent reservation with its named children', async () => {
    setupPolicy();
    const repo = 'lease_contest';
    const grant = await claim(repo, 'local-agent-a', 'parent', ['row:families:alpha'], 'parent-claim');
    const item = (await responseBody(grant)).data.leases[0];
    await runInDurableObject(stubFor(repo), async (_instance, state) => {
      const context = contextFor(state, repo, 'agent-a', Date.now);
      addVerified(state, fakeReadyChange(repo, 'parent', 'agent-a', [item.unitKey]));
      expect(leases.hooks['leases.reserve']!(context, 'parent', { [item.unitKey]: item.fence }).status).toBe('eligible');
      addVerified(state, fakeReadyChange(repo, 'child-a', 'agent-b', [item.unitKey]));
      const reserve = leases.hooks['leases.reserve']!;
      expect(reserve(context, 'child-a', { [item.unitKey]: item.fence })).toMatchObject({ status: 'blocked', code: 'LEASE_STALE' });
      const contest = { contestId: 'contest-one', parentChangeId: 'parent', childChangeIds: ['child-a', 'child-b'], selectedChangeId: null, ownerCreated: true };
      const store = sqlState(state.storage.sql);
      store.put('module:queue:contest:contest-one', contest);
      store.put('module:queue:contest-child:child-a', { contestId: contest.contestId });
      expect(reserve(context, 'child-a', { [item.unitKey]: item.fence })).toMatchObject({ status: 'eligible', value: { reservationFences: { [item.unitKey]: item.fence } } });
      expect(leases.hooks['leases.reservationLive']!(context, 'child-a', { [item.unitKey]: item.fence })).toMatchObject({ status: 'eligible' });
      const claimRoute = leases.routes.find(route => route.method === 'POST' && route.pattern.test(path(repo)))!;
      seedClaim(state, repo, 'ordinary', 'agent-b');
      const bypass = await claimRoute.handle(contextFor(state, repo, 'agent-b', Date.now), new Request(`https://concord.test${path(repo)}`),
        path(repo).match(claimRoute.pattern)!, { changeId: 'ordinary', intentText: 'Ordinary overlap', unitKeys: [item.unitKey], contestId: 'contest-one', override: true });
      expect(bypass.status).toBe(409);
      store.put('module:queue:contest:contest-one', { ...contest, selectedChangeId: 'child-b' });
      expect(reserve(context, 'child-a', { [item.unitKey]: item.fence })).toMatchObject({ status: 'blocked', code: 'LEASE_STALE' });
      expect(leases.hooks['leases.reservationLive']!(context, 'child-a', { [item.unitKey]: item.fence })).toMatchObject({ status: 'blocked', code: 'LEASE_STALE' });
      addVerified(state, fakeReadyChange(repo, 'child-b', 'agent-b', [item.unitKey]));
      store.put('module:queue:contest-child:child-b', { contestId: contest.contestId });
      expect(reserve(context, 'child-b', { [item.unitKey]: item.fence })).toMatchObject({ status: 'eligible' });
      expect(leases.hooks['leases.reservationLive']!(context, 'child-b', { [item.unitKey]: item.fence })).toMatchObject({ status: 'eligible' });
      store.put('module:queue:entry:child-b', { changeId: 'child-b', state: 'merged' });
      expect(leases.hooks['leases.releaseReservation']!(context, 'child-b')).toMatchObject({ status: 'eligible' });
      expect(store.get<{ closed: boolean }>('module:queue:contest:contest-one')?.closed).toBe(true);
      expect(reserve(context, 'child-a', { [item.unitKey]: item.fence })).toMatchObject({ status: 'blocked', code: 'LEASE_STALE' });
      expect(leases.hooks['leases.reservationLive']!(context, 'child-a', { [item.unitKey]: item.fence })).toMatchObject({ status: 'blocked', code: 'LEASE_STALE' });
    });
  });
  it('shows the holder issue on lease lists and conflicts', async () => {
    setupPolicy();
    const repo = 'lease_issue_links';
    expect((await claim(repo, 'local-agent-a', 'issue-holder', ['row:families:alpha'], 'issue-claim')).status).toBe(201);
    await runInDurableObject(stubFor(repo), (_instance, durable) => {
      const state = sqlState(durable.storage.sql);
      const change = state.get<Change>('module:repos:change:issue-holder')!;
      state.put('module:repos:change:issue-holder', { ...change, issueNumber: 1 });
      state.put('module:issues:items', [{ number: 1, title: 'Protect alpha' }]);
    });
    expect((await listing(repo)).items[0]).toMatchObject({ issueNumber: 1, issueTitle: 'Protect alpha' });
    const conflict = await claim(repo, 'local-agent-b', 'waiting-change', ['row:families:alpha'], 'waiting-claim');
    expect(conflict.status).toBe(409);
    expect((await responseBody(conflict)).error.details).toMatchObject({ issueNumber: 1, issueTitle: 'Protect alpha' });
  });
});
