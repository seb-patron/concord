import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import type { TenantCatalog } from '../../src/catalog';
import type { RepoCoordinator } from '../../src/coordinator';
import type { Change, InspectionResult, ModuleContext } from '../../src/contracts';
import { repos } from '../../src/features/repos';
import { jobInput, runners } from '../../src/features/runners';
import { digest as canonicalDigest } from '../../src/http';
import { ids, pendingInitialToken, type ProvisioningIntent } from '../../src/repos/model';
import { FakeStorage } from '../../src/storage/fake';
import { artifactsStorage } from '../../src/storage/artifacts';
import { localFixtureConfig, sqlState } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);
const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);
const d = 'd'.repeat(40);
const digest = `sha256:${'0'.repeat(64)}` as const;

const originalTrustedConfig = (env as Env).TRUSTED_CONFIG;
afterEach(() => { (env as Env).TRUSTED_CONFIG = originalTrustedConfig; });

async function create(name: string, configuration = 'local-demo') {
  const response = await fetchApi(mutation('/v1/repos', { name, policyId: configuration, profileId: configuration }, `create-${name}`));
  expect(response.status).toBe(201);
  return (await responseBody(response)).data;
}

it('keeps the observed canonical OID and repo version through catalog refreshes', async () => {
  const name = 'catalog_oid_stability_case';
  const repo = await create(name);
  await fetchApi(apiRequest(`/v1/repos/${name}`));
  await fake(name, provider => {
    provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
    provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
  });
  const detail = await fetchApi(apiRequest(`/v1/repos/${name}`));
  const original = await responseBody(detail);
  expect(original.data.observedCanonicalOid).toBe(a);
  await fetchApi(apiRequest(`/v1/repos/${name}/branches`));
  await fetchApi(apiRequest(`/v1/repos/${name}/changes`));
  const patched = await fetchApi(apiRequest(`/v1/repos/${name}/milestone-settings`, 'local-owner', {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': 'catalog-oid-settings' },
    body: JSON.stringify({ create: 'owners', expectedVersion: 0 }),
  }));
  expect(patched.status).toBe(200);
  const snapshot = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)));
  expect(snapshot.data.projections.repos.repo.observedCanonicalOid).toBe(a);
  const after = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
  expect(after.data.observedCanonicalOid).toBe(a);
  expect(after.data.version).toBe(original.data.version);
});

async function fake(name: string, action: (provider: FakeStorage) => void) {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`));
  await runInDurableObject(stub, (_instance, state) => action(new FakeStorage(sqlState(state.storage.sql))));
}

async function bootstrapSeed(name: string) {
  const repo = await create(name);
  await fetchApi(apiRequest(`/v1/repos/${name}`));
  const created = await fetchApi(mutation(`/v1/repos/${name}/changes`, {
    intentKey: 'seed', intentText: 'seed', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [],
  }, `${name}-seed-change`));
  const change = (await responseBody(created)).data;
  await fake(name, provider => {
    provider.putCommit(change.candidateStorageName, { oid: a, treeOid: b, parents: [] });
    provider.conditionalUpdateRef(change.candidateStorageName, 'refs/heads/seed', null, a);
  });
  const branch = await fetchApi(mutation(`/v1/repos/${name}/branches`, {
    expectedVersion: 1, storageName: change.candidateStorageName, ref: 'refs/heads/seed', observedHead: a, ownerId: 'owner',
  }, `${name}-seed-branch`));
  expect(branch.status).toBe(201);
  const body = { seedStorageName: change.candidateStorageName, seedRef: 'refs/heads/seed', headOid: a,
    policyId: 'local-demo', profileId: 'local-demo' };
  const requested = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, {
    ...body, expectedVersion: (await responseBody(branch)).version,
  }, `${name}-bootstrap`));
  expect(requested.status).toBe(202);
  return { repo, change, body, requested: (await responseBody(requested)).data,
    coordinator: env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`)) };
}

async function makeLegacyChange(name: string, changeId: string) {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`));
  await runInDurableObject(stub, (_instance, durable) => {
    const state = sqlState(durable.storage.sql);
    const changes = state.get<Change[]>('module:repos:changes')!;
    const change = changes.find(item => item.changeId === changeId)!;
    const { authorModel: _authorModel, ...legacy } = change;
    state.put('module:repos:changes', changes.map(item => item.changeId === changeId ? legacy : item));
    state.put(`module:repos:change:${changeId}`, legacy);
  });
}

function provisioningAtProvider(storage: FakeStorage, name: string, kind: 'ensure-repo' | 'fork') {
  const state = (storage as unknown as { state: { get: <T>(key: string) => T | null } }).state;
  const intents = state.get<Record<string, { storageName: string }>>('module:repos:provisioning');
  expect(intents?.[`${kind}:${name}`]?.storageName).toBe(name);
  return state;
}

describe('repository and change lifecycle', () => {
  it('reads canonical directories, files and README at a pinned commit with bounded text', async () => {
    const name = 'canonical_browse_case';
    const repo = await create(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await fake(name, provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] }, {
        'README.md': new TextEncoder().encode('# Human <script>\n'),
        'agents/rules.md': new TextEncoder().encode('agent rules'),
        'line\nbreak.md': new TextEncoder().encode('newline'),
        'foo..bar.md': new TextEncoder().encode('dots'),
        'a:b': new TextEncoder().encode('colon'),
        'a\\b': new TextEncoder().encode('backslash'),
        'binary.bin': new Uint8Array([0, 1]),
        'invalid-utf8.bin': new Uint8Array([0xff]),
        'c1-control.txt': new TextEncoder().encode('\u0085'),
        'control.bin': new Uint8Array([1, 2, 3]),
        'boundary.txt': new Uint8Array(65_536).fill(65),
        'large.txt': new Uint8Array(65_537),
      });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const base = `/v1/repos/${name}`;
    const root = await responseBody(await fetchApi(apiRequest(`${base}/tree`)));
    expect(root.data.oid).toBe(a);
    expect(root.data.entries).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'agents', type: 'tree' })]));
    expect(root.data.entries.every((entry: { oid: string }) => /^[a-f0-9]{40}$/.test(entry.oid))).toBe(true);
    expect(root.data).toMatchObject({ unitFiles: {}, rowTables: {} });
    const rootByClient = await responseBody(await fetchApi(apiRequest(`${base}/tree?${new URLSearchParams({ path: '' })}`)));
    expect(rootByClient.data).toEqual(root.data);
    expect((await responseBody(await fetchApi(apiRequest(`${base}/tree?path=agents`)))).data.entries).toEqual([expect.objectContaining({ name: 'rules.md' })]);
    expect((await responseBody(await fetchApi(apiRequest(`${base}/readme?oid=${a}`)))).data.content).toBe('# Human <script>\n');
    expect((await responseBody(await fetchApi(apiRequest(`${base}/file?path=agents%2Frules.md`)))).data.content).toBe('agent rules');
    for (const path of ['line\nbreak.md', 'foo..bar.md', 'a:b', 'a\\b']) {
      expect(root.data.entries).toContainEqual(expect.objectContaining({ name: path }));
      expect((await responseBody(await fetchApi(apiRequest(`${base}/file?${new URLSearchParams({ path })}`)))).data.content).toBe(path === 'line\nbreak.md' ? 'newline' : path === 'foo..bar.md' ? 'dots' : path === 'a:b' ? 'colon' : 'backslash');
    }
    const maxPath = 'p'.repeat(4096);
    const overByteLimit = 'é'.repeat(2049);
    expect((await fetchApi(apiRequest(`${base}/tree?${new URLSearchParams({ path: maxPath })}`))).status).toBe(404);
    expect((await fetchApi(apiRequest(`${base}/tree?${new URLSearchParams({ path: `${maxPath}p` })}`))).status).toBe(400);
    expect(overByteLimit.length).toBeLessThanOrEqual(4096);
    expect(new TextEncoder().encode(overByteLimit).byteLength).toBeGreaterThan(4096);
    expect((await fetchApi(apiRequest(`${base}/tree?${new URLSearchParams({ path: overByteLimit })}`))).status).toBe(400);
    expect((await responseBody(await fetchApi(apiRequest(`${base}/file?path=boundary.txt`)))).data.size).toBe(65_536);
    for (const [path, status] of [['file?path=../secret', 400], ['file?path=/x', 400], ['file?path=a%2F%2Fb', 400], ['file?path=%00', 400], ['file?path=', 400], ['tree?path=missing', 404], ['file?path=binary.bin', 415], ['file?path=control.bin', 415], ['file?path=invalid-utf8.bin', 415], ['file?path=c1-control.txt', 415], ['file?path=large.txt', 413], ['readme?oid=bad', 400], ['tree?oid=', 400], ['file?path=README.md&oid=', 400], ['readme?oid=', 400]]) {
      expect((await fetchApi(apiRequest(`${base}/${path}`))).status).toBe(status);
    }
    expect((await responseBody(await fetchApi(apiRequest(`${base}/tree?oid=`)))).error.code).toBe('INVALID_OID');
    expect((await fetchApi(apiRequest(`${base}/changes?cursor=`))).status).toBe(400);
    expect((await fetchApi(apiRequest(`${base}/tree`, 'invalid-token'))).status).toBe(401);
  });
  it('distinguishes absent main from explicit commit reads before resolving main', async () => {
    const name = 'canonical_no_main_case';
    const repo = await create(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await fake(name, provider => provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] }, { 'README.md': new TextEncoder().encode('stored') }));
    const base = `/v1/repos/${name}`;
    expect((await responseBody(await fetchApi(apiRequest(`${base}/tree`)))).error.code).toBe('MAIN_NOT_FOUND');
    const empty = await responseBody(await fetchApi(apiRequest(`${base}/tree?oid=`)));
    expect(empty.error.code).toBe('INVALID_OID');
    expect((await responseBody(await fetchApi(apiRequest(`${base}/readme?oid=${a}`)))).data.content).toBe('stored');
    expect((await fetchApi(apiRequest(`${base}/readme?oid=${'f'.repeat(40)}`))).status).toBe(404);
  });
  it('bounds canonical tree responses at one thousand entries', async () => {
    const name = 'canonical_tree_limit_case';
    const repo = await create(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    const files = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`file-${String(i).padStart(4, '0')}.txt`, new TextEncoder().encode('x')]));
    await fake(name, provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] }, files);
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const listing = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/tree`)))).data;
    expect(listing.entries).toHaveLength(1000);
    expect(listing.truncated).toBe(true);
  });
  it('refuses a started change publishing outside its original file scope while ordinary changes remain unrestricted', async () => {
    const name = 'start_scope_case';
    const config = localFixtureConfig('local');
    config.policies['local-demo'].newFilePrefixes = ['docs/'];
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    const repo = await create(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await fake(name, provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const input = { intentKey: 'started-task', intentText: 'work', baseOid: a, branch: 'refs/heads/work',
      unitKeys: ['file:docs/a.txt'], dependencyChangeIds: [], startScope: true };
    const created = await fetchApi(mutation(`/v1/repos/${name}/changes`, input, 'scope-create'));
    expect(created.status).toBe(201);
    const createdBody = await responseBody(created);
    const change = createdBody.data;
    expect(change.startUnitKeys).toEqual(['file:docs/a.txt']);
    const publishBody = { expectedVersion: createdBody.version, baseOid: a, headOid: b,
      branch: input.branch, unitKeys: ['file:docs/b.txt'], leaseFences: { 'file:docs/b.txt': 1 } };
    const outside = await fetchApi(mutation(`/v1/repos/${name}/changes/${change.changeId}/publish`, publishBody, 'scope-outside'));
    expect(outside.status).toBe(409);
    expect((await responseBody(outside)).error.code).toBe('START_SCOPE_CONFLICT');
    const reread = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/changes/${change.changeId}`)))).data;
    expect(reread.startUnitKeys).toEqual(['file:docs/a.txt']);
    expect(reread.unitKeys).toEqual(['file:docs/a.txt']);
    const ordinary = await fetchApi(mutation(`/v1/repos/${name}/changes`, { ...input, intentKey: 'ordinary-task', startScope: undefined }, 'ordinary-create'));
    expect(ordinary.status).toBe(201);
    const ordinaryBody = await responseBody(ordinary);
    const ordinaryId = ordinaryBody.data.changeId;
    const ordinaryPublish = await fetchApi(mutation(`/v1/repos/${name}/changes/${ordinaryId}/publish`,
      { ...publishBody, expectedVersion: ordinaryBody.version }, 'ordinary-publish'));
    expect((await responseBody(ordinaryPublish)).error.code).toBe('BRANCH_NOT_REGISTERED');
  });
  it('keeps the original file start scope after a successful row publish', async () => {
    const name = 'start_scope_row_publish';
    const config = localFixtureConfig('local');
    config.policies['local-demo'].tables = [{ name: 'families', file: 'data/families.tsv', header: ['family', 'value'],
      keyColumn: 'family', keySpec: { charset: 'lower', minLength: 1, maxLength: 64 } }];
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    const repo = await create(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await fake(name, provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const version = async () => (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).version;
    const input = { intentKey: 'started-row', intentText: 'edit alpha', baseOid: a, branch: 'refs/heads/started-row',
      unitKeys: ['file:data/families.tsv'], dependencyChangeIds: [], startScope: true };
    const created = await fetchApi(mutation(`/v1/repos/${name}/changes`, input, 'row-create', 'local-agent-a'));
    expect(created.status).toBe(201);
    const change = (await responseBody(created)).data;
    await fake(name, provider => {
      provider.putCommit(change.candidateStorageName, { oid: b, treeOid: c, parents: [a] });
      provider.conditionalUpdateRef(change.candidateStorageName, input.branch, null, b);
    });
    const registered = await fetchApi(mutation(`/v1/repos/${name}/branches`, {
      expectedVersion: await version(), storageName: change.candidateStorageName, ref: input.branch, observedHead: b, ownerId: 'agent-a',
    }, 'row-register', 'local-agent-a'));
    expect(registered.status).toBe(201);
    const scheduleOriginal = runners.hooks['runners.schedule'];
    runners.hooks['runners.schedule'] = (context, job) => ({ status: 'eligible', version: context.version(), evidenceIds: [], value: { jobId: job.jobId } });
    try {
      const published = await fetchApi(mutation(`/v1/repos/${name}/changes/${change.changeId}/publish`, {
        expectedVersion: await version(), baseOid: a, headOid: b, branch: input.branch,
        unitKeys: ['row:families:alpha'], leaseFences: { 'file:data/families.tsv': 1 },
      }, 'row-publish', 'local-agent-a'));
      expect(published.status).toBe(202);
    } finally {
      runners.hooks['runners.schedule'] = scheduleOriginal;
    }
    const reread = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/changes/${change.changeId}`)))).data;
    expect(reread).toMatchObject({ headOid: b, revision: 1, unitKeys: ['row:families:alpha'] });
    expect(reread.startUnitKeys).toEqual(['file:data/families.tsv']);
  });
  it('records the creating principal model and returns null for an absent label', async () => {
    const name = 'author_model_case';
    await create(name);
    const token = 'model-owner-token';
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
    const original = (env as Env).AUTH_TOKENS;
    (env as Env).AUTH_TOKENS = JSON.stringify({ [hash]: {
      tenantId: 'local', principalId: 'model-owner', roles: ['owner'], repoIds: [name],
      expiresAt: Number.MAX_SAFE_INTEGER, model: 'GPT-6.1/fast',
    } });
    try {
      const body = { intentKey: 'model-task', intentText: 'model task', baseOid: null,
        branch: 'refs/heads/model', unitKeys: [], dependencyChangeIds: [] };
      const modeled = await fetchApi(mutation(`/v1/repos/${name}/changes`, body, 'model-change', token));
      expect(modeled.status).toBe(201);
      const modeledId = (await responseBody(modeled)).data.changeId;
      const plain = await fetchApi(mutation(`/v1/repos/${name}/changes`, { ...body, intentKey: 'plain-task' }, 'plain-change'));
      expect(plain.status).toBe(201);
      const plainId = (await responseBody(plain)).data.changeId;
      const list = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/changes`)))).data.items;
      expect(list.find((change: { changeId: string }) => change.changeId === modeledId).authorModel).toBe('GPT-6.1/fast');
      expect(list.find((change: { changeId: string }) => change.changeId === plainId).authorModel).toBeNull();
      const snapshot = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections.repos.changes;
      expect(snapshot.find((change: { changeId: string }) => change.changeId === modeledId).authorModel).toBe('GPT-6.1/fast');
      expect((await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/changes/${plainId}`)))).data.authorModel).toBeNull();
    } finally { (env as Env).AUTH_TOKENS = original; }
  });
  it('projects authorModel when closing a change stored before model capture', async () => {
    const name = 'legacy_close_case';
    await create(name);
    const created = await fetchApi(mutation(`/v1/repos/${name}/changes`, {
      intentKey: 'legacy', intentText: 'legacy task', baseOid: null,
      branch: 'refs/heads/legacy', unitKeys: [], dependencyChangeIds: [],
    }, 'legacy-close-create'));
    expect(created.status).toBe(201);
    const body = await responseBody(created);
    await makeLegacyChange(name, body.data.changeId);
    const closed = await fetchApi(mutation(`/v1/repos/${name}/changes/${body.data.changeId}/close`,
      { expectedVersion: body.version }, 'legacy-close'));
    expect(closed.status).toBe(200);
    expect((await responseBody(closed)).data).toMatchObject({ status: 'closed', authorModel: null });
  });
  it('releases active and reserved leases when closing a change, leaving other changes untouched', async () => {
    const name = 'close_releases_leases';
    const config = localFixtureConfig('local');
    config.policies['local-demo'].units = Object.fromEntries(['alpha', 'beta', 'gamma'].map(key => [`row:families:${key}`, {
      canonicalKey: `row:families:${key}`, file: 'data/families.tsv', resources: [key], dependencyKeys: [],
    }]));
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    const repo = await create(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await fake(name, provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const createChange = async (actor: string, task: string) => {
      const response = await fetchApi(mutation(`/v1/repos/${name}/changes`, {
        intentKey: task, intentText: task, baseOid: a, branch: `refs/heads/${task}`, unitKeys: [], dependencyChangeIds: [],
      }, `create-${task}`, actor));
      expect(response.status).toBe(201);
      return responseBody(response);
    };
    const first = await createChange('local-agent-a', 'close-holder');
    const second = await createChange('local-agent-b', 'other-holder');
    const claim = async (changeId: string, keys: string[], actor: string, key: string) => {
      const response = await fetchApi(mutation(`/v1/repos/${name}/leases`, {
        changeId, unitKeys: keys, intentText: key,
      }, key, actor));
      expect(response.status).toBe(201);
      return (await responseBody(response)).data.leases;
    };
    const released = await claim(first.data.changeId, ['row:families:alpha', 'row:families:beta'], 'local-agent-a', 'close-claims');
    const retained = await claim(second.data.changeId, ['row:families:gamma'], 'local-agent-b', 'other-claim');
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE leases_claims SET state = 'reserved' WHERE lease_id = ?", released[1].leaseId);
    });
    const latest = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/changes/${first.data.changeId}`)));
    const closed = await fetchApi(mutation(`/v1/repos/${name}/changes/${first.data.changeId}/close`,
      { expectedVersion: latest.version }, 'close-holder', 'local-agent-a'));
    expect(closed.status).toBe(200);
    expect((await responseBody(closed)).data).toMatchObject({ changeId: first.data.changeId, status: 'closed' });
    const listing = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/leases`)))).data.items;
    expect(listing.find((lease: { leaseId: string }) => lease.leaseId === released[0].leaseId).state).toBe('released');
    expect(listing.find((lease: { leaseId: string }) => lease.leaseId === released[1].leaseId).state).toBe('released');
    expect(listing.find((lease: { leaseId: string }) => lease.leaseId === retained[0].leaseId).state).toBe('active');
    const reclaimed = await claim(second.data.changeId, ['row:families:alpha'], 'local-agent-b', 'reclaim-alpha');
    expect(reclaimed).toHaveLength(1);
    const events = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/events`)))).data.items;
    for (const lease of released) {
      expect(events).toContainEqual(expect.objectContaining({ kind: 'lease.released', relatedIds: expect.arrayContaining([lease.leaseId]), payload: expect.objectContaining({ reason: 'change-closed' }) }));
    }
  });
  it('keeps ordinary intent keys owned, including contest-shaped tasks and fixture authors', async () => {
    const repo = await create('intent_ownership_case');
    await fetchApi(apiRequest('/v1/repos/intent_ownership_case'));
    await fake('intent_ownership_case', provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const path = '/v1/repos/intent_ownership_case/changes';
    const ordinary = { intentKey: 'public-aw/task-17', intentText: 'Increase gamma retry budget safely',
      baseOid: a, branch: 'refs/heads/demo', unitKeys: ['row:families:gamma'], dependencyChangeIds: [] };
    const first = await fetchApi(mutation(path, ordinary, 'ordinary-first', 'local-agent-a'));
    expect(first.status).toBe(201);
    const firstId = (await responseBody(first)).data.changeId;
    const repeated = await fetchApi(mutation(path, ordinary, 'ordinary-repeat', 'local-agent-a'));
    expect((await responseBody(repeated)).data.changeId).toBe(firstId);
    const stolen = await fetchApi(mutation(path, ordinary, 'ordinary-stolen', 'local-agent-b'));
    expect(stolen.status).toBe(409);
    expect((await responseBody(stolen)).error.code).toBe('INTENT_OWNED');

    const contest = { ...ordinary, intentKey: 'J', intentText: 'epsilon-contest', unitKeys: ['row:families:epsilon'] };
    const low = await fetchApi(mutation(path, contest, 'contest-low', 'local-contest-low'));
    const high = await fetchApi(mutation(path, contest, 'contest-high', 'local-contest-high'));
    expect(low.status).toBe(201);
    expect(high.status).toBe(409);
    expect((await responseBody(high)).error.code).toBe('INTENT_OWNED');
    const lowId = (await responseBody(low)).data.changeId;
    const lowRepeat = await fetchApi(mutation(path, contest, 'contest-low-repeat', 'local-contest-low'));
    expect((await responseBody(lowRepeat)).data.changeId).toBe(lowId);
    const third = await fetchApi(mutation(path, contest, 'contest-third', 'local-agent-a'));
    expect(third.status).toBe(409);
    expect((await responseBody(third)).error.code).toBe('INTENT_OWNED');
  });

  it('requires an owner-authorized contest for the exact dispatch-lab repo and intent', async () => {
    const fixture = localFixtureConfig('local');
    (env as Env).TRUSTED_CONFIG = JSON.stringify({
      policies: { ...fixture.policies, 'dispatch-lab': { ...fixture.policies['local-demo'], id: 'dispatch-lab', checkerId: 'dispatch-lab' } },
      profiles: { ...fixture.profiles, 'dispatch-lab': { ...fixture.profiles['local-demo'], id: 'dispatch-lab' } },
    });
    const makeReady = async (name: string) => {
      const repo = await create(name, 'dispatch-lab');
      await fetchApi(apiRequest(`/v1/repos/${name}`));
      await fake(name, provider => {
        provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
        provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
      });
      return `/v1/repos/${name}`;
    };
    const task = { intentKey: 'J', intentText: 'epsilon-contest', baseOid: a, branch: 'refs/heads/demo',
      unitKeys: ['row:families:epsilon'], dependencyChangeIds: [] };
    const unapproved = await makeReady('dispatch_without_contest');
    expect((await fetchApi(mutation(`${unapproved}/changes`, task, 'unapproved-first', 'local-contest-low'))).status).toBe(201);
    const denied = await fetchApi(mutation(`${unapproved}/changes`, task, 'unapproved-second', 'local-contest-high'));
    expect(denied.status).toBe(409);
    expect((await responseBody(denied)).error.code).toBe('INTENT_OWNED');

    const approved = await makeReady('dispatch_with_contest');
    const detail = await responseBody(await fetchApi(apiRequest(approved)));
    const authorization = { expectedVersion: detail.version, intentKey: 'J', childAuthorIds: ['contest-agent-low', 'contest-agent-high'] };
    expect((await fetchApi(mutation(`${approved}/intent-contests`, authorization, 'agent-authorization', 'local-contest-low'))).status).toBe(403);
    const authorized = await fetchApi(mutation(`${approved}/intent-contests`, authorization, 'owner-authorization'));
    expect(authorized.status).toBe(201);
    expect((await fetchApi(mutation(`${approved}/changes`, task, 'approved-first', 'local-contest-low'))).status).toBe(201);
    expect((await fetchApi(mutation(`${approved}/changes`, task, 'approved-second', 'local-contest-high'))).status).toBe(201);
    const third = await fetchApi(mutation(`${approved}/changes`, task, 'approved-third', 'local-agent-a'));
    expect(third.status).toBe(409);
    expect((await responseBody(third)).error.code).toBe('INTENT_OWNED');
    const otherIntent = await fetchApi(mutation(`${approved}/changes`, { ...task, intentKey: 'K' }, 'wrong-intent', 'local-contest-low'));
    expect(otherIntent.status).toBe(201);
    const deniedOtherIntent = await fetchApi(mutation(`${approved}/changes`, { ...task, intentKey: 'K' }, 'wrong-intent-second', 'local-contest-high'));
    expect(deniedOtherIntent.status).toBe(409);
    expect((await responseBody(deniedOtherIntent)).error.code).toBe('INTENT_OWNED');
  });

  it('accepts trusted policy unit key syntax used by the demo', () => {
    expect(ids(['file:dispatch.mjs', 'row:families:gamma'], 'unitKeys')).toEqual(['file:dispatch.mjs', 'row:families:gamma']);
  });

  const makeReady = async (name: string) => {
    const repo = await create(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await fake(name, provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
  };
  const createChange = (name: string, index: number) => fetchApi(mutation(`/v1/repos/${name}/changes`, {
    intentKey: `task-${index}`, intentText: `task ${index}`, baseOid: a,
    branch: `refs/heads/task-${index}`, unitKeys: [], dependencyChangeIds: [],
  }, `${name}-change-${index}`));

  it('enforces the default active-change limit of 32', async () => {
    const name = 'limit_default_case';
    await makeReady(name);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)))).data.activeChangeLimit).toBe(32);
    for (let index = 0; index < 32; index++) expect((await createChange(name, index)).status).toBe(201);
    const denied = await createChange(name, 32);
    expect(denied.status).toBe(429);
    const deniedBody = await responseBody(denied);
    expect(deniedBody.error.code).toBe('CHANGE_LIMIT');
    expect(deniedBody.error.details).toEqual({ limit: 32, active: 32 });
  });

  it('enforces an installed maxActiveChangesPerRepo above the default', async () => {
    (env as Env).TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'),
      costLimits: { maxActiveChangesPerRepo: 34 } });
    const name = 'limit_install_case';
    await makeReady(name);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)))).data.activeChangeLimit).toBe(34);
    for (let index = 0; index < 34; index++) expect((await createChange(name, index)).status).toBe(201);
    const capped = await createChange(name, 34);
    expect(capped.status).toBe(429);
    const cappedBody = await responseBody(capped);
    expect(cappedBody.error.code).toBe('CHANGE_LIMIT');
    expect(cappedBody.error.details).toEqual({ limit: 34, active: 34 });
  });

  it('enforces a per-repo activeChangeLimits override', async () => {
    (env as Env).TRUSTED_CONFIG = JSON.stringify({ ...localFixtureConfig('local'),
      costLimits: { activeChangeLimits: { limit_override_case: 2 } } });
    const name = 'limit_override_case';
    await makeReady(name);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)))).data.activeChangeLimit).toBe(2);
    for (let index = 0; index < 2; index++) expect((await createChange(name, index)).status).toBe(201);
    const refused = await createChange(name, 2);
    expect(refused.status).toBe(429);
    const refusedBody = await responseBody(refused);
    expect(refusedBody.error.code).toBe('CHANGE_LIMIT');
    expect(refusedBody.error.details).toEqual({ limit: 2, active: 2 });
  });

  it('takes an owner seed through real queue and runner scheduling to canonical main', async () => {
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
    expect(bootstrap.status).toBe(202);
    const bootstrapResult = await responseBody(bootstrap);
    expect(bootstrapResult.data).toMatchObject({ state: 'requested', jobId: expect.any(String) });
    const snapshot = await fetchApi(apiRequest('/v1/repos/seed_case/snapshot'));
    const snapshotResult = await responseBody(snapshot);
    expect(snapshotResult.data.projections.repos.bootstrap).toMatchObject({ changeId: change.changeId, headOid: a, status: 'requested' });
    const retry = await fetchApi(mutation('/v1/repos/seed_case/bootstrap', { ...bootstrapBody, expectedVersion: snapshotResult.version }, 'bootstrap-retry'));
    expect(retry.status).toBe(202);
    expect((await responseBody(retry)).data).toEqual(bootstrapResult.data);
    const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:seed_case'));
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => {
      const context = (instance as unknown as { context(name: 'repos', principal: object, repoId: string): ModuleContext }).context('repos', {
        tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      }, 'seed_case');
      expect(context.readChange?.(change.changeId)).toMatchObject({ status: 'eligible', value: {
        candidateStorageName: change.candidateStorageName, canonicalStorageName: repo.canonicalStorageName,
        scratchStorageName: snapshotResult.data.projections.repos.bootstrap.scratchStorageName,
        policyId: 'local-demo', profileId: 'local-demo', intentKey: 'seed',
      } });
    });
    const originalInfo = FakeStorage.prototype.info;
    const localRemotes = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, name) {
      const info = await originalInfo.call(this, name);
      return info ? { ...info, remote: `file:///${name}` } : null;
    });
    try {
      await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    } finally {
      localRemotes.mockRestore();
    }
    const scheduled = (await responseBody(await fetchApi(apiRequest('/v1/repos/seed_case/snapshot')))).data.projections;
    expect(scheduled.queue.bootstrap).toMatchObject({ state: 'checking' });
    expect(scheduled.runners.jobs).toHaveLength(1);
    expect(scheduled.runners.jobs[0]).toMatchObject({ bootstrap: true, ownerAuthorized: true, canonicalBaseOid: null,
      scratchStorageName: snapshotResult.data.projections.repos.bootstrap.scratchStorageName });
    expect(scheduled.runners.jobs[0].jobId).toBe(bootstrapResult.data.jobId);
    expect(scheduled.runners.jobs[0].expectedRefs).toEqual({
      [repo.canonicalStorageName]: null,
      [change.candidateStorageName]: a,
      [scheduled.runners.jobs[0].scratchStorageName]: null,
    });
    const secondSeed = await fetchApi(mutation('/v1/repos/seed_case/changes', {
      intentKey: 'seed-two', intentText: 'another initializer', baseOid: null, branch: 'refs/heads/seed-two', unitKeys: [], dependencyChangeIds: [],
    }, 'seed-two-change'));
    expect(secondSeed.status).toBe(201);
    const secondSeedResult = await responseBody(secondSeed);
    const rival = secondSeedResult.data;
    await fake('seed_case', provider => {
      provider.putCommit(rival.candidateStorageName, { oid: c, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(rival.candidateStorageName, 'refs/heads/seed-two', null, c);
    });
    const rivalBranch = await fetchApi(mutation('/v1/repos/seed_case/branches', {
      expectedVersion: secondSeedResult.version, storageName: rival.candidateStorageName, ref: 'refs/heads/seed-two', observedHead: c, ownerId: 'owner',
    }, 'register-rival'));
    expect(rivalBranch.status).toBe(201);
    const rivalBranchResult = await responseBody(rivalBranch);
    const second = await fetchApi(mutation('/v1/repos/seed_case/bootstrap', {
      expectedVersion: rivalBranchResult.version, seedStorageName: rival.candidateStorageName, seedRef: 'refs/heads/seed-two', headOid: c,
      policyId: 'local-demo', profileId: 'local-demo',
    }, 'second-bootstrap'));
    expect(second.status).toBe(409);
    expect((await responseBody(second)).error.code).toBe('BOOTSTRAP_PENDING');

    const checkerPoll = await fetchApi(mutation('/v1/repos/seed_case/runner/poll', {
      runnerId: 'seed-checker', role: 'checker', supportedProfileDigests: [scheduled.runners.jobs[0].profileDigest],
    }, 'seed-checker-poll', 'local-checker'));
    expect(checkerPoll.status).toBe(200);
    const checkedJob = (await responseBody(checkerPoll)).data.job;
    expect(checkedJob.jobId).toBe(bootstrapResult.data.jobId);
    await fake('seed_case', async provider => {
      expect(await provider.resolveRef(change.candidateStorageName, 'refs/heads/seed')).toBe(a);
      expect(await provider.readCommit(change.candidateStorageName, a)).toMatchObject({ treeOid: b, parents: [] });
    });
    await fake('seed_case', provider => {
      provider.putCommit(checkedJob.scratchStorageName, { oid: a, treeOid: b, parents: [] });
      expect(provider.conditionalUpdateRef(checkedJob.scratchStorageName, checkedJob.scratchRef, null, a)).toBe(true);
    });
    const checkedInput = {
      kind: 'validate-stack', jobId: checkedJob.jobId, attempt: checkedJob.attempt, fence: checkedJob.fence,
      inputDigest: checkedJob.inputDigest, sourceTreeOid: b, checkerDigest: checkedJob.checkerDigest,
      toolchainDigest: checkedJob.toolchainDigest, oracleDigest: checkedJob.oracleDigest,
      environmentDigest: checkedJob.environmentDigest, durationMs: 1, log: '', outcome: 'PASS',
      composedOid: a, composedTreeOid: b,
      gateResults: checkedJob.unitPolicy.acceptance.gates.map((gate: { id: string; requiredOutcome: string }) => ({
        gateId: gate.id, outcome: gate.requiredOutcome,
      })), score: null, bootstrap: true, canonicalBaseOid: null,
    };
    const checkedDigest = await canonicalDigest(checkedInput);
    const checkedResult = await fetchApi(mutation(`/v1/repos/seed_case/jobs/${checkedJob.jobId}/result`, {
      attempt: checkedJob.attempt, fence: checkedJob.fence, inputDigest: checkedJob.inputDigest,
      resultDigest: checkedDigest, result: { ...checkedInput, resultDigest: checkedDigest },
    }, 'seed-check-result', 'local-checker'));
    expect(checkedResult.status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    const ticketedResponse = await fetchApi(apiRequest('/v1/repos/seed_case/snapshot'));
    const ticketedBody = await responseBody(ticketedResponse);
    const ticketed = ticketedBody.data.projections;
    expect(ticketed.queue.promotion).toMatchObject({ state: 'pending', bootstrap: true, checkedNewOid: a });
    const promotionJob = ticketed.runners.jobs.find((job: { kind: string }) => job.kind === 'promote');
    expect(promotionJob.expectedRefs).toEqual({ [repo.canonicalStorageName]: null, [checkedJob.scratchStorageName]: a });
    const catalog = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    const catalogIndexKey = 'module:repos:catalog:index';
    const originalCatalogIndex = await runInDurableObject<TenantCatalog, Array<{ repoId: string; canonicalStorageName: string; tenantId: string }>>(
      catalog, (_instance, durable) => {
        const state = sqlState(durable.storage.sql);
        const original = state.get<Array<{ repoId: string; canonicalStorageName: string; tenantId: string }>>(catalogIndexKey) ?? [];
        const precedingRepos = Array.from({ length: 100 }, (_, index) => ({
          repoId: `promotion_page_filler_${index}`, canonicalStorageName: `canonical_filler_${index}`, tenantId: 'local',
        }));
        state.put(catalogIndexKey, [...precedingRepos, ...original.filter(item => item.repoId === 'seed_case')]);
        return original;
      },
    );
    try {
      const firstCatalogPage = (await responseBody(await fetchApi(apiRequest('/v1/repos')))).data;
      expect(firstCatalogPage.items).toHaveLength(100);
      expect(firstCatalogPage.items.some((item: { repoId: string }) => item.repoId === 'seed_case')).toBe(false);
      const secondCatalogPage = (await responseBody(await fetchApi(apiRequest(`/v1/repos?cursor=${encodeURIComponent(firstCatalogPage.nextCursor)}`)))).data;
      expect(secondCatalogPage.items.some((item: { repoId: string }) => item.repoId === 'seed_case')).toBe(true);
      const canonicalRead = await fetchApi(mutation('/v1/repos/seed_case/git-token', {
        expectedVersion: ticketedBody.version, storageName: repo.canonicalStorageName, scope: 'read', ttlSeconds: 60,
      }, 'token-during-promotion-read'));
      expect(canonicalRead.status, JSON.stringify(await responseBody(canonicalRead))).toBe(200);
      const forkWrite = await fetchApi(mutation('/v1/repos/seed_case/git-token', {
        expectedVersion: ticketedBody.version, storageName: change.candidateStorageName, scope: 'write', ttlSeconds: 60,
      }, 'token-during-promotion-write'));
      expect(forkWrite.status).toBe(409);
      expect((await responseBody(forkWrite)).error.code).toBe('PROMOTION_IN_PROGRESS');
    } finally {
      await runInDurableObject<TenantCatalog, void>(catalog, (_instance, durable) => {
        sqlState(durable.storage.sql).put(catalogIndexKey, originalCatalogIndex);
      });
    }
    const promoterPoll = await fetchApi(mutation('/v1/repos/seed_case/runner/poll', {
      runnerId: 'seed-promoter', role: 'promoter', supportedProfileDigests: [promotionJob.profileDigest],
    }, 'seed-promoter-poll', 'local-promoter'));
    expect(promoterPoll.status).toBe(200);
    const claimedPromotion = (await responseBody(promoterPoll)).data.job;
    expect(claimedPromotion.jobId).toBe(promotionJob.jobId);
    await fake('seed_case', provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      expect(provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a)).toBe(true);
    });
    const promotedInput = {
      kind: 'promote', jobId: claimedPromotion.jobId, attempt: claimedPromotion.attempt, fence: claimedPromotion.fence,
      inputDigest: claimedPromotion.inputDigest, sourceTreeOid: null, checkerDigest: claimedPromotion.checkerDigest,
      toolchainDigest: claimedPromotion.toolchainDigest, oracleDigest: claimedPromotion.oracleDigest,
      environmentDigest: claimedPromotion.environmentDigest, durationMs: 1, log: '', outcome: 'APPLIED',
      observedCanonicalOid: a,
    };
    const promotedDigest = await canonicalDigest(promotedInput);
    const promotedResult = await fetchApi(mutation(`/v1/repos/seed_case/jobs/${claimedPromotion.jobId}/result`, {
      attempt: claimedPromotion.attempt, fence: claimedPromotion.fence, inputDigest: claimedPromotion.inputDigest,
      resultDigest: promotedDigest, result: { ...promotedInput, resultDigest: promotedDigest },
    }, 'seed-promotion-result', 'local-promoter'));
    expect(promotedResult.status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    const merged = (await responseBody(await fetchApi(apiRequest('/v1/repos/seed_case/snapshot')))).data.projections;
    expect(merged.queue.promotion).toMatchObject({ state: 'applied', checkedNewOid: a });
    expect(merged.queue.bootstrap.state).toBe('merged');
    await fake('seed_case', async provider => {
      expect(await provider.resolveRef(repo.canonicalStorageName, 'refs/heads/main')).toBe(a);
    });
  });

  it('re-pins a profile-blocked bootstrap and promotes the original seed', async () => {
    const name = 'bootstrap_repin_case';
    const { repo, body, requested, coordinator } = await bootstrapSeed(name);
    const config = localFixtureConfig('local');
    config.profiles['local-demo'].digest = `sha256:${'b'.repeat(64)}`;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    const detail = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
    expect(detail.data.bootstrap).toMatchObject({ jobId: requested.jobId, state: 'waiting', blockedReason: 'PROFILE_CHANGED' });
    const events = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/events`)))).data.items;
    expect(events.filter((event: { kind: string; payload?: { reason?: string } }) =>
      event.kind === 'queue.alarm_deferred' && event.payload?.reason === 'PROFILE_CHANGED')).toHaveLength(1);
    const repinned = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, { ...body, expectedVersion: detail.version }, `${name}-repin`));
    expect(repinned.status).toBe(202);
    const newJobId = (await responseBody(repinned)).data.jobId;
    expect(newJobId).not.toBe(requested.jobId);
    const repeated = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, { ...body, expectedVersion: detail.version }, `${name}-repin`));
    expect((await responseBody(repeated)).data.jobId).toBe(newJobId);
    const updated = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)))).data;
    expect(updated.bootstrap).toMatchObject({ jobId: newJobId, state: 'waiting', blockedReason: null });
    const repinEvents = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/events`)))).data.items
      .filter((event: { kind: string }) => event.kind === 'repo.bootstrap.repinned');
    expect(repinEvents).toHaveLength(1);
    expect(repinEvents[0].payload).toMatchObject({ newProfileDigest: config.profiles['local-demo'].digest });
    const originalInfo = FakeStorage.prototype.info;
    const remote = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, storageName) {
      const info = await originalInfo.call(this, storageName);
      return info ? { ...info, remote: `file:///${storageName}` } : null;
    });
    try { await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm()); }
    finally { remote.mockRestore(); }
    const poll = await fetchApi(mutation(`/v1/repos/${name}/runner/poll`, {
      runnerId: 'repin-checker', role: 'checker', supportedProfileDigests: [config.profiles['local-demo'].digest],
    }, `${name}-poll`, 'local-checker'));
    expect(poll.status).toBe(200);
    const job = (await responseBody(poll)).data.job;
    expect(job.jobId).toBe(newJobId);
    const newer = localFixtureConfig('local');
    newer.profiles['local-demo'].digest = `sha256:${'c'.repeat(64)}`;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(newer);
    const busyDetail = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
    const busy = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, { ...body, expectedVersion: busyDetail.version }, `${name}-busy`));
    expect(busy.status).toBe(409);
    expect((await responseBody(busy)).error.code).toBe('BOOTSTRAP_BUSY');
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    await fake(name, provider => {
      provider.putCommit(job.scratchStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(job.scratchStorageName, job.scratchRef, null, a);
    });
    const checked = { kind: 'validate-stack', jobId: job.jobId, attempt: job.attempt, fence: job.fence,
      inputDigest: job.inputDigest, sourceTreeOid: b, checkerDigest: job.checkerDigest,
      toolchainDigest: job.toolchainDigest, oracleDigest: job.oracleDigest, environmentDigest: job.environmentDigest,
      durationMs: 1, log: '', outcome: 'PASS', composedOid: a, composedTreeOid: b,
      gateResults: job.unitPolicy.acceptance.gates.map((gate: { id: string; requiredOutcome: string }) => ({
        gateId: gate.id, outcome: gate.requiredOutcome,
      })), score: null, bootstrap: true, canonicalBaseOid: null };
    const checkedDigest = await canonicalDigest(checked);
    const result = await fetchApi(mutation(`/v1/repos/${name}/jobs/${job.jobId}/result`, {
      attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest, resultDigest: checkedDigest,
      result: { ...checked, resultDigest: checkedDigest },
    }, `${name}-check-result`, 'local-checker'));
    expect(result.status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    const ticket = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    expect(ticket.queue.promotion).toMatchObject({ state: 'pending', bootstrap: true, checkedNewOid: a });
    const promotion = ticket.runners.jobs.find((item: { kind: string }) => item.kind === 'promote');
    const promoter = await fetchApi(mutation(`/v1/repos/${name}/runner/poll`, {
      runnerId: 'repin-promoter', role: 'promoter', supportedProfileDigests: [promotion.profileDigest],
    }, `${name}-promoter-poll`, 'local-promoter'));
    expect(promoter.status).toBe(200);
    const promotionJob = (await responseBody(promoter)).data.job;
    await fake(name, provider => {
      provider.putCommit(repo.canonicalStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, a);
    });
    const applied = { kind: 'promote', jobId: promotionJob.jobId, attempt: promotionJob.attempt, fence: promotionJob.fence,
      inputDigest: promotionJob.inputDigest, sourceTreeOid: null, checkerDigest: promotionJob.checkerDigest,
      toolchainDigest: promotionJob.toolchainDigest, oracleDigest: promotionJob.oracleDigest,
      environmentDigest: promotionJob.environmentDigest, durationMs: 1, log: '', outcome: 'APPLIED', observedCanonicalOid: a };
    const appliedDigest = await canonicalDigest(applied);
    expect((await fetchApi(mutation(`/v1/repos/${name}/jobs/${promotionJob.jobId}/result`, {
      attempt: promotionJob.attempt, fence: promotionJob.fence, inputDigest: promotionJob.inputDigest,
      resultDigest: appliedDigest, result: { ...applied, resultDigest: appliedDigest },
    }, `${name}-promoted`, 'local-promoter'))).status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    expect((await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)))).data.observedCanonicalOid).toBe(a);
    const afterMain = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
    const refused = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, { ...body, expectedVersion: afterMain.version }, `${name}-after-main`));
    expect((await responseBody(refused)).error.code).toBe('ALREADY_INITIALIZED');
  });

  it('re-pins the same seed after a failed bootstrap promotion and a profile change', async () => {
    const name = 'bootstrap_failed_promotion_repin';
    const { repo, body, requested, coordinator } = await bootstrapSeed(name);
    const originalInfo = FakeStorage.prototype.info;
    const remote = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, storageName) {
      const info = await originalInfo.call(this, storageName);
      return info ? { ...info, remote: `file:///${storageName}` } : null;
    });
    try { await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm()); }
    finally { remote.mockRestore(); }
    const scheduled = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    const checkJob = scheduled.runners.jobs.find((job: { jobId: string }) => job.jobId === requested.jobId);
    const checker = await fetchApi(mutation(`/v1/repos/${name}/runner/poll`, {
      runnerId: 'failed-bootstrap-checker', role: 'checker', supportedProfileDigests: [checkJob.profileDigest],
    }, `${name}-checker`, 'local-checker'));
    expect(checker.status).toBe(200);
    const claimedCheck = (await responseBody(checker)).data.job;
    await fake(name, provider => {
      provider.putCommit(claimedCheck.scratchStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(claimedCheck.scratchStorageName, claimedCheck.scratchRef, null, a);
    });
    const checked = { kind: 'validate-stack', jobId: claimedCheck.jobId, attempt: claimedCheck.attempt, fence: claimedCheck.fence,
      inputDigest: claimedCheck.inputDigest, sourceTreeOid: b, checkerDigest: claimedCheck.checkerDigest,
      toolchainDigest: claimedCheck.toolchainDigest, oracleDigest: claimedCheck.oracleDigest,
      environmentDigest: claimedCheck.environmentDigest, durationMs: 1, log: '', outcome: 'PASS',
      composedOid: a, composedTreeOid: b,
      gateResults: claimedCheck.unitPolicy.acceptance.gates.map((gate: { id: string; requiredOutcome: string }) => ({
        gateId: gate.id, outcome: gate.requiredOutcome,
      })), score: null, bootstrap: true, canonicalBaseOid: null };
    const checkedDigest = await canonicalDigest(checked);
    expect((await fetchApi(mutation(`/v1/repos/${name}/jobs/${claimedCheck.jobId}/result`, {
      attempt: claimedCheck.attempt, fence: claimedCheck.fence, inputDigest: claimedCheck.inputDigest,
      resultDigest: checkedDigest, result: { ...checked, resultDigest: checkedDigest },
    }, `${name}-check-result`, 'local-checker'))).status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    const ticketed = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    expect(ticketed.queue.promotion).toMatchObject({ state: 'pending', bootstrap: true, expectedOldOid: null });
    const promotion = ticketed.runners.jobs.find((job: { kind: string }) => job.kind === 'promote');
    const promoter = await fetchApi(mutation(`/v1/repos/${name}/runner/poll`, {
      runnerId: 'failed-bootstrap-promoter', role: 'promoter', supportedProfileDigests: [promotion.profileDigest],
    }, `${name}-promoter`, 'local-promoter'));
    expect(promoter.status).toBe(200);
    const claimedPromotion = (await responseBody(promoter)).data.job;
    const oldRef = { kind: 'promote', jobId: claimedPromotion.jobId, attempt: claimedPromotion.attempt, fence: claimedPromotion.fence,
      inputDigest: claimedPromotion.inputDigest, sourceTreeOid: null, checkerDigest: claimedPromotion.checkerDigest,
      toolchainDigest: claimedPromotion.toolchainDigest, oracleDigest: claimedPromotion.oracleDigest,
      environmentDigest: claimedPromotion.environmentDigest, durationMs: 1, log: '', outcome: 'OLD_REF', observedCanonicalOid: null };
    const oldRefDigest = await canonicalDigest(oldRef);
    expect((await fetchApi(mutation(`/v1/repos/${name}/jobs/${claimedPromotion.jobId}/result`, {
      attempt: claimedPromotion.attempt, fence: claimedPromotion.fence, inputDigest: claimedPromotion.inputDigest,
      resultDigest: oldRefDigest, result: { ...oldRef, resultDigest: oldRefDigest },
    }, `${name}-promotion-result`, 'local-promoter'))).status).toBe(200);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    const failed = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    expect(failed.queue.promotion).toMatchObject({ state: 'failed', bootstrap: true, reconciliation: 'CONFIRMED_OLD_REF' });
    expect(failed.queue.bootstrap).toMatchObject({ state: 'waiting', jobId: requested.jobId });
    const mainRef = await runInDurableObject(coordinator, (_instance, state) =>
      new FakeStorage(sqlState(state.storage.sql)).resolveRef(repo.canonicalStorageName, 'refs/heads/main'));
    expect(mainRef).toBeNull();
    const config = localFixtureConfig('local');
    config.profiles['local-demo'].digest = `sha256:${'b'.repeat(64)}`;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    const detail = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
    const repinned = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, { ...body, expectedVersion: detail.version }, `${name}-repin`));
    expect(repinned.status).toBe(202);
    const replacementId = (await responseBody(repinned)).data.jobId;
    expect(replacementId).not.toBe(requested.jobId);
    const after = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    expect(after.queue.promotion).toBeNull();
    expect(after.queue.bootstrap).toMatchObject({ state: 'waiting', jobId: replacementId, profileDigest: config.profiles['local-demo'].digest });
    expect(after.runners.jobs.find((job: { jobId: string }) => job.jobId === claimedPromotion.jobId)).toMatchObject({ state: 'blocked' });
    const replacementInfo = FakeStorage.prototype.info;
    const replacementRemote = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, storageName) {
      const info = await replacementInfo.call(this, storageName);
      return info ? { ...info, remote: `file:///${storageName}` } : null;
    });
    try { await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm()); }
    finally { replacementRemote.mockRestore(); }
    const rescheduled = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    expect(rescheduled.runners.jobs.find((job: { jobId: string }) => job.jobId === replacementId)).toMatchObject({ kind: 'validate-stack', state: 'pending' });
  });

  it('recovers INVALID_JOB and fences a scheduled stale bootstrap job', async () => {
    const name = 'bootstrap_invalid_repin_case';
    const invalid = localFixtureConfig('local');
    invalid.profiles['local-demo'].timeoutMs = 40 * 60_000;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(invalid);
    const { body, requested, coordinator } = await bootstrapSeed(name);
    await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm());
    const blocked = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
    expect(blocked.data.bootstrap.blockedReason).toBe('INVALID_JOB');
    const fixed = localFixtureConfig('local');
    fixed.profiles['local-demo'].digest = `sha256:${'b'.repeat(64)}`;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(fixed);
    const first = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, { ...body, expectedVersion: blocked.version }, `${name}-fixed`));
    expect(first.status).toBe(202);
    const firstId = (await responseBody(first)).data.jobId;
    expect(firstId).not.toBe(requested.jobId);
    const originalInfo = FakeStorage.prototype.info;
    const remote = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, storageName) {
      const info = await originalInfo.call(this, storageName);
      return info ? { ...info, remote: `file:///${storageName}` } : null;
    });
    try { await runInDurableObject<RepoCoordinator, void>(coordinator, instance => instance.alarm()); }
    finally { remote.mockRestore(); }
    const before = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    expect(before.runners.jobs.find((job: { jobId: string }) => job.jobId === firstId)).toMatchObject({ state: 'pending' });
    const newer = localFixtureConfig('local');
    newer.profiles['local-demo'].digest = `sha256:${'c'.repeat(64)}`;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(newer);
    const detail = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
    const second = await fetchApi(mutation(`/v1/repos/${name}/bootstrap`, { ...body, expectedVersion: detail.version }, `${name}-newer`));
    expect(second.status).toBe(202);
    expect((await responseBody(second)).data.jobId).not.toBe(firstId);
    const after = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/snapshot`)))).data.projections;
    expect(after.runners.jobs.find((job: { jobId: string }) => job.jobId === firstId)).toMatchObject({ state: 'blocked' });
    expect(after.repos.bootstrap.scratchStorageName).toBe(before.repos.bootstrap.scratchStorageName);
    const stalePoll = await fetchApi(mutation(`/v1/repos/${name}/runner/poll`, {
      runnerId: 'stale-checker', role: 'checker', supportedProfileDigests: [fixed.profiles['local-demo'].digest],
    }, `${name}-stale-poll`, 'local-checker'));
    expect(stalePoll.status).toBe(204);
  });

  it('requires an explicit history declaration for a registered non-root seed', async () => {
    const repoId = 'history_seed_case';
    await create(repoId);
    await fetchApi(apiRequest(`/v1/repos/${repoId}`));
    const created = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
      intentKey: 'history-seed', intentText: 'preserve history', baseOid: null,
      branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [],
    }, 'history-seed-change'));
    const change = (await responseBody(created)).data;
    await fake(repoId, provider => {
      provider.putCommit(change.candidateStorageName, { oid: a, treeOid: d, parents: [] });
      provider.putCommit(change.candidateStorageName, { oid: b, treeOid: d, parents: [a] });
      expect(provider.conditionalUpdateRef(change.candidateStorageName, 'refs/heads/seed', null, b)).toBe(true);
    });
    const registered = await fetchApi(mutation(`/v1/repos/${repoId}/branches`, {
      expectedVersion: 1, storageName: change.candidateStorageName, ref: 'refs/heads/seed', observedHead: b, ownerId: 'owner',
    }, 'history-seed-branch'));
    expect(registered.status).toBe(201);
    const body = { expectedVersion: 2, seedStorageName: change.candidateStorageName,
      seedRef: 'refs/heads/seed', headOid: b, policyId: 'local-demo', profileId: 'local-demo' };
    const defaultMode = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, body, 'history-default'));
    expect(defaultMode.status).toBe(422);
    expect((await responseBody(defaultMode)).error.code).toBe('SEED_NOT_ROOT');
    const wrongHead = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, { ...body, headOid: a, withHistory: true }, 'history-wrong-head'));
    expect(wrongHead.status).toBe(422);
    expect((await responseBody(wrongHead)).error.code).toBe('SEED_REF_MISMATCH');
    const accepted = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, { ...body, withHistory: true }, 'history-accepted'));
    expect(accepted.status).toBe(202);
    expect((await responseBody(accepted)).data.state).toBe('requested');
  });

  it('records only one bootstrap request from two concurrent retries of the same seed', async () => {
    await create('bootstrap_race_case');
    await fetchApi(apiRequest('/v1/repos/bootstrap_race_case'));
    const ref = 'refs/heads/seed';
    const response = await fetchApi(mutation('/v1/repos/bootstrap_race_case/changes', {
      intentKey: 'seed', intentText: 'seed', baseOid: null, branch: ref, unitKeys: [], dependencyChangeIds: [],
    }, 'draft-seed'));
    expect(response.status).toBe(201);
    const draft = (await responseBody(response)).data;
    await fake('bootstrap_race_case', provider => {
      provider.putCommit(draft.candidateStorageName, { oid: a, treeOid: b, parents: [] });
      provider.conditionalUpdateRef(draft.candidateStorageName, ref, null, a);
    });
    const branchResponse = await fetchApi(mutation('/v1/repos/bootstrap_race_case/branches', {
      expectedVersion: 1, storageName: draft.candidateStorageName, ref, observedHead: a, ownerId: 'owner',
    }, 'branch-seed'));
    expect(branchResponse.status).toBe(201);
    const bootstrapBody = { expectedVersion: 2, seedStorageName: draft.candidateStorageName, seedRef: ref,
      headOid: a, policyId: 'local-demo', profileId: 'local-demo' };
    const responses = await Promise.all([0, 1].map(index => fetchApi(mutation('/v1/repos/bootstrap_race_case/bootstrap',
      bootstrapBody, `race-${index}`))));
    expect(responses.every(item => item.status === 202 || item.status === 409)).toBe(true);
    expect(responses.some(item => item.status === 202)).toBe(true);
    const bodies = await Promise.all(responses.map(response => responseBody(response)));
    expect(bodies.filter(body => body.error).every(body => ['STALE_VERSION', 'BOOTSTRAP_PENDING'].includes(body.error.code))).toBe(true);
    const snapshot = await fetchApi(apiRequest('/v1/repos/bootstrap_race_case/snapshot'));
    const projections = (await responseBody(snapshot)).data.projections;
    const bootstrap = projections.repos.bootstrap;
    expect(bootstrap).toMatchObject({ changeId: draft.changeId, status: 'requested', jobId: bodies.find(body => body.data)?.data.jobId });
    for (const body of bodies.filter(body => body.data)) expect(body.data.jobId).toBe(bootstrap.jobId);
    expect(projections.queue.bootstrap).toMatchObject({ state: 'waiting' });
    const events = (await responseBody(await fetchApi(apiRequest('/v1/repos/bootstrap_race_case/events')))).data.items;
    const requests = events.filter((event: { kind: string }) => event.kind === 'repo.bootstrap.requested');
    expect(requests).toHaveLength(1);
    expect(requests[0].relatedIds).toContain(draft.changeId);
  });

  it('records only one bootstrap request from competing owner seed drafts', async () => {
    await create('bootstrap_competition_case');
    await fetchApi(apiRequest('/v1/repos/bootstrap_competition_case'));
    const drafts: Array<{ changeId: string; candidateStorageName: string; ref: string }> = [];
    for (const [key, ref] of [['first', 'refs/heads/first'], ['second', 'refs/heads/second']] as const) {
      const response = await fetchApi(mutation('/v1/repos/bootstrap_competition_case/changes', {
        intentKey: key, intentText: `seed ${key}`, baseOid: null, branch: ref, unitKeys: [], dependencyChangeIds: [],
      }, `draft-${key}`));
      expect(response.status).toBe(201);
      drafts.push({ ...(await responseBody(response)).data, ref });
    }
    await fake('bootstrap_competition_case', provider => {
      for (const [index, draft] of drafts.entries()) {
        const head = index === 0 ? a : c;
        provider.putCommit(draft.candidateStorageName, { oid: head, treeOid: b, parents: [] });
        provider.conditionalUpdateRef(draft.candidateStorageName, draft.ref, null, head);
      }
    });
    for (const [index, draft] of drafts.entries()) {
      const response = await fetchApi(mutation('/v1/repos/bootstrap_competition_case/branches', {
        expectedVersion: 2 + index, storageName: draft.candidateStorageName, ref: draft.ref,
        observedHead: index === 0 ? a : c, ownerId: 'owner',
      }, `branch-${index}`));
      expect(response.status).toBe(201);
    }
    const responses = await Promise.all(drafts.map((draft, index) => fetchApi(mutation('/v1/repos/bootstrap_competition_case/bootstrap', {
      expectedVersion: 4, seedStorageName: draft.candidateStorageName, seedRef: draft.ref,
      headOid: index === 0 ? a : c, policyId: 'local-demo', profileId: 'local-demo',
    }, `compete-${index}`))));
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    const bodies = await Promise.all(responses.map(response => responseBody(response)));
    expect(bodies.filter(body => body.error).map(body => body.error.code)).toEqual(['STALE_VERSION']);
    const winner = responses.findIndex(response => response.status === 202);
    const projections = (await responseBody(await fetchApi(apiRequest('/v1/repos/bootstrap_competition_case/snapshot')))).data.projections;
    expect(projections.repos.bootstrap).toMatchObject({ changeId: drafts[winner].changeId, status: 'requested', jobId: bodies[winner].data.jobId });
    expect(projections.queue.bootstrap).toMatchObject({ state: 'waiting' });
    const events = (await responseBody(await fetchApi(apiRequest('/v1/repos/bootstrap_competition_case/events')))).data.items;
    const requests = events.filter((event: { kind: string }) => event.kind === 'repo.bootstrap.requested');
    expect(requests).toHaveLength(1);
    expect(requests[0].relatedIds).toContain(drafts[winner].changeId);
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
      expect(snapshot.provisioning).toContainEqual(expect.objectContaining({ storageName: `concord-s-${pending.jobId}`, state: 'creating' }));
      expect(names).toEqual([`concord-s-${pending.jobId}`]);
      ready = true;
      const third = await fetchApi(mutation(`/v1/repos/${repoId}/bootstrap`, body, 'slow-scratch-ready'));
      expect(third.status).toBe(202);
      expect((await responseBody(third)).data).toMatchObject({ state: 'requested', jobId: pending.jobId });
      const finished = (await responseBody(await fetchApi(apiRequest(`/v1/repos/${repoId}/snapshot`)))).data.projections.repos;
      expect(finished.bootstrap).toMatchObject({ jobId: pending.jobId, scratchStorageName: `concord-s-${pending.jobId}`, status: 'requested' });
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
    await makeLegacyChange('publish_case', change.changeId);
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
    const firstIntent = await runInDurableObject<RepoCoordinator, any>(env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:publish_case')),
      instance => sqlState((instance as any).ctx.storage.sql).get(`module:repos:inspection-job:${change.changeId}`));
    expect(firstIntent).toMatchObject({ policyId: 'local-demo' });
    expect('unitPolicy' in firstIntent).toBe(false);
    const detail = await fetchApi(apiRequest(`/v1/repos/publish_case/changes/${change.changeId}`));
    expect((await responseBody(detail)).data).toMatchObject({ revision: 1, headOid: b, status: 'draft' });
    const repeatPublish = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, { ...publishBody, expectedVersion: 3 }, 'publish-again', 'local-agent-a'));
    expect(repeatPublish.status).toBe(409);
    expect((await responseBody(repeatPublish)).error.code).toBe('INVALID_JOB');
    const scheduleOriginal = runners.hooks['runners.schedule'];
    let scheduledJob!: import('../../src/contracts').Job;
    runners.hooks['runners.schedule'] = (context, job) => { scheduledJob = job; return { status: 'eligible', version: context.version(), evidenceIds: [], value: { jobId: job.jobId } }; };
    try {
      const scheduled = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, { ...publishBody, expectedVersion: 3 }, 'publish-scheduled', 'local-agent-a'));
      expect(scheduled.status).toBe(202);
      expect(scheduledJob.unitPolicy).toEqual(localFixtureConfig('local').policies['local-demo']);
      expect(await canonicalDigest(jobInput(scheduledJob))).toBe(firstIntent.inputDigest);
      expect((await responseBody(scheduled)).data).toMatchObject({ revision: 1, authorModel: null });
      const identical = await fetchApi(mutation(`/v1/repos/publish_case/changes/${change.changeId}/publish`, { ...publishBody, expectedVersion: 3 }, 'publish-identical', 'local-agent-a'));
      expect(identical.status).toBe(200);
      expect((await responseBody(identical)).data).toMatchObject({ revision: 1, authorModel: null });
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
      expect(context.state.get(`change:${change.changeId}`)).toMatchObject({ status: 'ready', headOid: b });
      expect(context.state.get(`verified:${change.changeId}`)).toMatchObject({ verifiedBy: 'checker', headOid: b,
        policyDigest: digest, unitKeys: [] });
      expect(sqlState(context.sql).get(`module:verdicts:inspection:${change.changeId}`)).toMatchObject({
        changeId: change.changeId, revision: 1, reviewManifestDigest: inspection.reviewManifestDigest,
      });
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
      expect(pending.provisioning.state).toBe('creating');
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

  it.each([
    { result: 'ready', token: false, revoked: true, status: 201, state: 'observed', polls: 0 },
    { result: 'pending', token: false, revoked: true, status: 202, state: 'creating', polls: 1 },
    { result: 'pending', token: true, revoked: true, status: 202, state: 'token-held', polls: 1 },
    { result: 'ready', token: true, revoked: true, status: 201, state: 'observed', polls: 0 },
    { result: 'ready', token: true, revoked: false, status: 503, state: 'failed', polls: 0 },
  ])('persists provisioning transition for $result, token=$token, revoked=$revoked', async ({ result, token, revoked, status, state, polls }) => {
    const originalEnsure = FakeStorage.prototype.ensureRepo;
    const originalInfo = FakeStorage.prototype.info;
    const visited: string[] = [];
    let storageName = '';
    const ensure = vi.spyOn(FakeStorage.prototype, 'ensureRepo').mockImplementation(async function (this: FakeStorage, name) {
      if (!name.startsWith('concord-r-')) return originalEnsure.call(this, name);
      storageName = name;
      const persisted = provisioningAtProvider(this, name, 'ensure-repo');
      visited.push(persisted.get<Record<string, ProvisioningIntent>>('module:repos:provisioning')![`ensure-repo:${name}`].state);
      const created = await originalEnsure.call(this, name);
      const observation = result === 'pending' ? { name, remote: '', status: 'provisioning' as const } : created;
      return token ? Object.assign(observation, { [pendingInitialToken]: 'initial-secret' }) : observation;
    });
    const info = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, name) {
      const found = await originalInfo.call(this, name);
      return found && name === storageName && result === 'pending' ? { name, remote: '', status: 'provisioning' } : found;
    });
    const revoke = vi.spyOn(FakeStorage.prototype, 'revokeToken').mockImplementation(async function (this: FakeStorage, name, secret) {
      const persisted = provisioningAtProvider(this, name, 'ensure-repo');
      visited.push(persisted.get<Record<string, ProvisioningIntent>>('module:repos:provisioning')![`ensure-repo:${name}`].state);
      expect(persisted.get<string>(`module:repos:initial-token:${name}`)).toBe(secret);
      return revoked;
    });
    try {
      const name = `transition_${result}_${token}_${revoked}`;
      const response = await fetchApi(mutation('/v1/repos', { name, policyId: 'local-demo', profileId: 'local-demo' }, `transition-${name}`));
      expect(response.status).toBe(status);
      const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
      await runInDurableObject(stub, (_instance, durable) => {
        const stored = sqlState(durable.storage.sql);
        expect(stored.get<Record<string, ProvisioningIntent>>('module:repos:provisioning')![`ensure-repo:${storageName}`])
          .toMatchObject({ state, polls });
        expect(stored.get<string>(`module:repos:initial-token:${storageName}`)).toBe(token && (!revoked || result === 'pending') ? 'initial-secret' : null);
      });
      expect(visited).toEqual(token && result === 'ready' ? ['creating', 'revoking'] : ['creating']);
    } finally {
      revoke.mockRestore();
      info.mockRestore();
      ensure.mockRestore();
    }
  });

  it('retains a token after false revocation and retries cleanup without creating another repository', async () => {
    const originalEnsure = FakeStorage.prototype.ensureRepo;
    const ensure = vi.spyOn(FakeStorage.prototype, 'ensureRepo').mockImplementation(async function (this: FakeStorage, name) {
      return Object.assign(await originalEnsure.call(this, name), { [pendingInitialToken]: 'held-secret' });
    });
    const revoke = vi.spyOn(FakeStorage.prototype, 'revokeToken').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const body = { name: 'revocation_retry_case', policyId: 'local-demo', profileId: 'local-demo' };
    try {
      expect((await fetchApi(mutation('/v1/repos', body, 'revoke-first'))).status).toBe(503);
      expect(ensure).toHaveBeenCalledTimes(1);
      const retry = await fetchApi(mutation('/v1/repos', body, 'revoke-retry'));
      expect(retry.status).toBe(201);
      expect(ensure).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledTimes(2);
      const name = (await responseBody(retry)).data.canonicalStorageName;
      const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
      await runInDurableObject(stub, (_instance, durable) => {
        expect(sqlState(durable.storage.sql).get<string>(`module:repos:initial-token:${name}`)).toBeNull();
      });
    } finally {
      revoke.mockRestore();
      ensure.mockRestore();
    }
  });

  it.each([false, true])('persists an Artifacts creation token with empty remote=%s before retry despite an empty token listing', async emptyRemote => {
    let createdName = '';
    let active = false;
    let revokeCalls = 0;
    const binding = {
      create: vi.fn(async (name: string) => {
        createdName = name;
        active = true;
        return { name, remote: emptyRemote ? '' : `https://example.test/${name}.git`, token: 'artifact-secret' };
      }),
      get: vi.fn(async (name: string) => {
        if (name !== createdName) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
        return {
          [Symbol.dispose]: () => {},
          info: async () => ({ name, remote: `https://example.test/${name}.git` }),
          revokeToken: vi.fn(async (token: string) => {
            expect(token).toBe('artifact-secret');
            revokeCalls++;
            if (!emptyRemote && revokeCalls === 1) return false;
            active = false;
            return true;
          }),
          listTokens: async () => ({ total: 0, tokens: [] }),
        };
      }),
      list: vi.fn(async () => ({ repos: [], cursor: undefined })),
    };
    const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    await runInDurableObject<TenantCatalog, void>(stub, async instance => {
      const context = (instance as unknown as { context(principal: object): ModuleContext }).context({
        tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      });
      Object.assign(context, { storage: artifactsStorage(binding as unknown as Artifacts) });
      const route = repos.routes[0];
      const request = new Request('https://concord.test/v1/repos', { method: 'POST' });
      const match = route.pattern.exec('/v1/repos')!;
      const body = { name: emptyRemote ? 'artifact_empty_remote_retry' : 'artifact_revoke_retry', policyId: 'local-demo', profileId: 'local-demo' };
      await expect(route.handle(context, request, match, body)).rejects.toMatchObject({ status: 503, code: 'PROVISIONING_FAILED' });
      const intentKey = `ensure-repo:${createdName}`;
      expect(context.state.get<Record<string, ProvisioningIntent>>('provisioning')![intentKey].state).toBe('failed');
      expect(context.state.get<string>(`initial-token:${createdName}`)).toBe('artifact-secret');
      expect(active).toBe(true);
      expect(revokeCalls).toBe(emptyRemote ? 0 : 1);
      expect(await (await binding.get(createdName)).listTokens()).toEqual({ total: 0, tokens: [] });
      const retry = await route.handle(context, request, match, body);
      expect(retry.status).toBe(201);
      expect(context.state.get<Record<string, ProvisioningIntent>>('provisioning')![intentKey].state).toBe('observed');
      expect(context.state.get<string>(`initial-token:${createdName}`)).toBeNull();
      expect(active).toBe(false);
      expect(revokeCalls).toBe(emptyRemote ? 1 : 2);
      expect(binding.create).toHaveBeenCalledTimes(1);
    });
  });

  it('persists a fork token after source disposal throws and revokes it on retry despite an empty token listing', async () => {
    let sourceName = '';
    let candidateName = '';
    let active = false;
    let forkCalls = 0;
    let revokeCalls = 0;
    const binding = {
      create: vi.fn(async (name: string) => {
        sourceName = name;
        return { name, remote: `https://example.test/${name}.git`, token: 'source-secret' };
      }),
      get: vi.fn(async (name: string) => {
        if (name !== sourceName && name !== candidateName) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
        let forked = false;
        return {
          [Symbol.dispose]: () => { if (forked) throw new Error('dispose failed'); },
          info: async () => ({ name, remote: `https://example.test/${name}.git` }),
          log: async () => [],
          fork: async (target: string) => {
            forkCalls++;
            forked = true;
            candidateName = target;
            active = true;
            return { name: target, remote: `https://example.test/${target}.git`, token: 'fork-secret' };
          },
          revokeToken: async (secret: string) => {
            if (name === candidateName) {
              expect(secret).toBe('fork-secret');
              revokeCalls++;
              active = false;
            }
            return true;
          },
          listTokens: async () => ({ total: 0, tokens: [] }),
        };
      }),
      list: vi.fn(async () => ({ repos: [], cursor: undefined })),
    };
    const catalog = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    await runInDurableObject<TenantCatalog, void>(catalog, async instance => {
      const context = (instance as unknown as { context(principal: object): ModuleContext }).context({
        tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      });
      Object.assign(context, { storage: artifactsStorage(binding as unknown as Artifacts) });
      const path = '/v1/repos';
      const route = repos.routes[0];
      const response = await route.handle(context, new Request(`https://concord.test${path}`, { method: 'POST' }), route.pattern.exec(path)!,
        { name: 'artifact_fork_disposal_retry', policyId: 'local-demo', profileId: 'local-demo' });
      expect(response.status).toBe(201);
    });
    const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:artifact_fork_disposal_retry'));
    await runInDurableObject<RepoCoordinator, void>(coordinator, async instance => {
      const context = (instance as unknown as { context(name: 'repos', principal: object, repoId: string): ModuleContext }).context('repos', {
        tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      }, 'artifact_fork_disposal_retry');
      Object.assign(context, { storage: artifactsStorage(binding as unknown as Artifacts) });
      const path = '/v1/repos/artifact_fork_disposal_retry/changes';
      const route = repos.routes.find(item => item.method === 'POST' && item.pattern.test(path))!;
      const request = new Request(`https://concord.test${path}`, { method: 'POST' });
      const body = { intentKey: 'disposal', intentText: 'fork retry', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: [] };
      await expect(route.handle(context, request, route.pattern.exec(path)!, body))
        .rejects.toMatchObject({ status: 503, code: 'PROVISIONING_FAILED' });
      expect(context.state.get<string>(`initial-token:${candidateName}`)).toBe('fork-secret');
      expect(active).toBe(true);
      expect(await (await binding.get(candidateName)).listTokens()).toEqual({ total: 0, tokens: [] });
      const retry = await route.handle(context, request, route.pattern.exec(path)!, body);
      expect(retry.status).toBe(200);
      expect(context.state.get<string>(`initial-token:${candidateName}`)).toBeNull();
      expect(active).toBe(false);
      expect(forkCalls).toBe(1);
      expect(revokeCalls).toBe(1);
    });
  });

  it.each([false, true])('retains a minted token after malformed result or throwing disposal=%s until revocation succeeds on retry', async disposalThrows => {
    const repoId = disposalThrows ? 'artifact_mint_disposal_retry' : 'artifact_mint_retry';
    let createdName = '';
    let mintCalls = 0;
    let mintedRevocations = 0;
    let disposeMintHandle = false;
    const binding = {
      create: vi.fn(async (name: string) => {
        createdName = name;
        return { name, remote: `https://example.test/${name}.git`, token: 'initial-secret' };
      }),
      get: vi.fn(async (name: string) => {
        if (name !== createdName) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
        return {
          [Symbol.dispose]: () => {
            if (disposeMintHandle) {
              disposeMintHandle = false;
              throw new Error('dispose failed');
            }
          },
          info: async () => ({ name, remote: `https://example.test/${name}.git` }),
          revokeToken: async (secret: string) => {
            if (secret === 'minted-secret') return ++mintedRevocations > 1;
            return true;
          },
          listTokens: async () => ({ total: 0, tokens: [] }),
          createToken: async () => {
            if (++mintCalls === 1) {
              disposeMintHandle = disposalThrows;
              return { plaintext: 'minted-secret', expiresAt: disposalThrows ? '2026-10-11T08:00:00Z' : 'invalid' };
            }
            return { plaintext: 'next-secret', expiresAt: '2026-10-11T08:00:00Z' };
          },
        };
      }),
      list: vi.fn(async () => ({ repos: [], cursor: undefined })),
    };
    const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
    await runInDurableObject<TenantCatalog, void>(stub, async instance => {
      const context = (instance as unknown as { context(principal: object): ModuleContext }).context({
        tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      });
      Object.assign(context, { storage: artifactsStorage(binding as unknown as Artifacts) });
      const createRoute = repos.routes[0];
      const createRequest = new Request('https://concord.test/v1/repos', { method: 'POST' });
      const created = await createRoute.handle(context, createRequest, createRoute.pattern.exec('/v1/repos')!,
        { name: repoId, policyId: 'local-demo', profileId: 'local-demo' });
      expect(created.status).toBe(201);
      Object.assign(context, { repoId });
      const path = `/v1/repos/${repoId}/git-token`;
      const tokenRoute = repos.routes.find(route => route.method === 'POST' && route.pattern.test(path))!;
      const request = new Request(`https://concord.test${path}`, { method: 'POST' });
      const body = { storageName: createdName, scope: 'read', ttlSeconds: 60 };
      await expect(tokenRoute.handle(context, request, tokenRoute.pattern.exec(path)!, body))
        .rejects.toMatchObject({ status: 503, code: 'TOKEN_RESULT_INVALID' });
      expect(context.state.get<string>(`mint-token:${createdName}`)).toBe('minted-secret');
      expect(mintedRevocations).toBe(1);
      const retry = await tokenRoute.handle(context, request, tokenRoute.pattern.exec(path)!, body);
      expect(retry.status).toBe(200);
      expect((await responseBody(retry)).data.secret).toBe('next-secret');
      expect(context.state.get<string>(`mint-token:${createdName}`)).toBeNull();
      expect(mintedRevocations).toBe(2);
    });
  });

  it.each([false, true])('maps an empty status poll with held token=%s to a persisted pending transition', async held => {
    const originalEnsure = FakeStorage.prototype.ensureRepo;
    const ensure = vi.spyOn(FakeStorage.prototype, 'ensureRepo').mockImplementation(async function (this: FakeStorage, name) {
      await originalEnsure.call(this, name);
      const pending = { name, remote: '', status: 'provisioning' as const };
      return held ? Object.assign(pending, { [pendingInitialToken]: 'pending-secret' }) : pending;
    });
    const info = vi.spyOn(FakeStorage.prototype, 'info').mockResolvedValue(null);
    try {
      const body = { name: `empty_poll_${held}`, policyId: 'local-demo', profileId: 'local-demo' };
      expect((await fetchApi(mutation('/v1/repos', body, `empty-${held}`))).status).toBe(202);
      const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
      await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
        const context = (instance as unknown as { context(name: 'repos', principal: object, repoId: string): ModuleContext }).context('repos', {
          tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
        }, '');
        const all = context.state.get<Record<string, ProvisioningIntent>>('provisioning')!;
        const intent = Object.values(all).find(item => item.storageName ===
          (context.state.get<Array<{ repoId: string; canonicalStorageName: string }>>('catalog:index') ?? []).find(repo => repo.repoId === body.name)?.canonicalStorageName)!;
        intent.retryAt = 0;
        context.state.put('provisioning', all);
        await repos.onAlarm!(context);
        expect(context.state.get<Record<string, ProvisioningIntent>>('provisioning')![`ensure-repo:${intent.storageName}`])
          .toMatchObject({ state: held ? 'token-held' : 'creating', polls: 2 });
        expect(context.state.get<string>(`initial-token:${intent.storageName}`)).toBe(held ? 'pending-secret' : null);
      });
      expect(ensure).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      ensure.mockRestore();
    }
  });

  it('counts 30 pending observations across API retries and resets only after a failed attempt', async () => {
    const originalEnsure = FakeStorage.prototype.ensureRepo;
    const originalInfo = FakeStorage.prototype.info;
    const ensure = vi.spyOn(FakeStorage.prototype, 'ensureRepo').mockImplementation(async function (this: FakeStorage, name) {
      await originalEnsure.call(this, name);
      return { name, remote: '', status: 'provisioning' };
    });
    const info = vi.spyOn(FakeStorage.prototype, 'info').mockImplementation(async function (this: FakeStorage, name) {
      const found = await originalInfo.call(this, name);
      return found?.name.startsWith('concord-r-') ? { name, remote: '', status: 'provisioning' } : found;
    });
    try {
      const body = { name: 'poll_limit_case', policyId: 'local-demo', profileId: 'local-demo' };
      for (let poll = 1; poll <= 31; poll++) {
        const response = await fetchApi(mutation('/v1/repos', body, `poll-${poll}`));
        expect(response.status).toBe(poll === 30 ? 503 : 202);
        const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName('tenant:local'));
        await runInDurableObject(stub, (_instance, durable) => {
          const stored = sqlState(durable.storage.sql);
          const intent = Object.values(stored.get<Record<string, ProvisioningIntent>>('module:repos:provisioning') ?? {})
            .find(item => item.storageName.startsWith('concord-r-') && item.storageName ===
              (stored.get<Array<{ repoId: string; canonicalStorageName: string }>>('module:repos:catalog:index') ?? []).find(repo => repo.repoId === body.name)?.canonicalStorageName);
          expect(intent).toMatchObject({ polls: poll === 31 ? 1 : poll, state: poll === 30 ? 'failed' : 'creating' });
        });
      }
      expect(ensure).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      ensure.mockRestore();
    }
  });
});
