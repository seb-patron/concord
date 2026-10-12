import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { RepoCoordinator } from '../../src/coordinator';
import type { Change, Digest, Finding, ModuleRoute, ReviewManifest } from '../../src/contracts';
import { findings } from '../../src/features/findings';
import type { InspectedRevision } from '../../src/features/verdicts';
import { json } from '../../src/http';
import { localFixtureConfig, sqlState } from '../../src/state';
import { manifestDigest } from '../../src/verdicts/manifest';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);
const d = (char: string): Digest => `sha256:${char.repeat(64)}`;
const head = (char: string) => char.repeat(40);
const previousTrustedConfig = (env as Env).TRUSTED_CONFIG;
afterEach(() => { (env as Env).TRUSTED_CONFIG = previousTrustedConfig; });

async function fixture(repoId: string) {
  const created = await fetchApi(mutation('/v1/repos', { name: repoId, policyId: 'local-demo', profileId: 'local-demo' }, `${repoId}-repo`));
  expect(created.status).toBe(201);
  const changeResponse = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
    intentKey: 'seed', intentText: 'finding test', baseOid: null, branch: 'refs/heads/work', unitKeys: ['row:alpha'], dependencyChangeIds: [],
  }, `${repoId}-change`));
  expect(changeResponse.status).toBe(201);
  const change = (await responseBody(changeResponse)).data as Change;
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repoId}`));
  async function setHead(nextHead: string, revision: number) {
    await runInDurableObject(stub, (_instance, state) => {
      const store = sqlState(state.storage.sql);
      const changes = store.get<Change[]>('module:repos:changes')!;
      store.put('module:repos:changes', changes.map(item => item.changeId === change.changeId ?
        { ...item, headOid: nextHead, revision, status: 'ready' as const } : item));
      store.put('repo:version', (store.get<number>('repo:version') ?? 0) + 1);
    });
  }
  await setHead(head('a'), 1);
  const root = `/v1/repos/${repoId}/changes/${change.changeId}`;
  const api = async (path: string, token = 'local-owner') => responseBody(await fetchApi(apiRequest(path, token)));
  const post = async (suffix: string, body: Record<string, unknown>, key: string, token = 'local-owner') => {
    const version = (await api(`/v1/repos/${repoId}/snapshot`)).version;
    const response = await fetchApi(mutation(`${root}/${suffix}`, { expectedVersion: version, ...body }, key, token));
    return { status: response.status, body: await responseBody(response) };
  };
  const add = async (name: string, options: Record<string, unknown> = {}) => post('findings', {
    revision: 1, unitKey: 'row:alpha', text: name, evidenceDigest: d('1'), ...options,
  }, `${repoId}-finding-${crypto.randomUUID()}`, 'local-reviewer');
  const list = async () => (await api(`${root}/findings`)).data as { items: Finding[]; findingSetVersion: number };
  const submit = async (findingSetVersion: number, dispositions: unknown[], key = 'repair', revision = 1) =>
    post('repairs', { revision, findingSetVersion, dispositions }, `${repoId}-${key}`);
  const review = async (number: number, findingSetVersion: number, decision: 'accept' | 'reject', key = 'review', revision = 1) =>
    post(`repairs/${number}/review`, { revision, findingSetVersion, decision, evidenceDigest: d('9') }, `${repoId}-${key}`, 'local-reviewer');
  const disposition = (item: Finding) => ({ findingId: item.findingId, explanation: `fixed ${item.text}`, evidenceDigest: d('2') });
  return { repoId, change, root, stub, api, post, add, list, submit, review, disposition, setHead };
}

describe('persistent findings and atomic repair rounds', () => {
  it('rejects unit anchors outside the trusted change scope and permits an unknown anchor', async () => {
    const h = await fixture('find_unknown_unit');
    const before = (await h.api(`/v1/repos/${h.repoId}/snapshot`)).version;
    for (const semanticAnchor of [undefined, { kind: 'unit', key: 'row:typo' }]) {
      const attempt = await h.add('unmapped row', { unitKey: 'row:typo', ...(semanticAnchor ? { semanticAnchor } : {}) });
      expect(attempt.status).toBe(422);
      expect(attempt.body.error.code).toBe('UNKNOWN_UNIT');
    }
    expect((await h.api(`/v1/repos/${h.repoId}/snapshot`)).version).toBe(before);
    expect(await h.list()).toMatchObject({ items: [], findingSetVersion: 0 });

    const accepted = await h.add('unmapped row', {
      unitKey: 'row:typo', semanticAnchor: { kind: 'unknown', key: 'unmapped row' },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.semanticAnchor).toEqual({ kind: 'unknown', key: 'unmapped row' });
  });

  it('rejects an omitted or duplicate finding without creating a round', async () => {
    const h = await fixture('find_omission');
    const first = (await h.add('first')).body.data as Finding;
    const second = (await h.add('second')).body.data as Finding;
    expect((await h.list()).findingSetVersion).toBe(2);
    const before = (await h.api(`/v1/repos/${h.repoId}/snapshot`)).version;
    const omitted = await h.submit(2, [h.disposition(first)], 'omitted');
    expect(omitted.status).toBe(409);
    expect(omitted.body.error.code).toBe('FINDINGS_MISMATCH');
    const duplicate = await h.submit(2, [h.disposition(first), { ...h.disposition(first), explanation: 'different' }, h.disposition(second)], 'duplicate');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('FINDINGS_MISMATCH');
    const extra = await h.submit(2, [h.disposition(first), h.disposition(second), { findingId: 'unknown', explanation: 'extra', evidenceDigest: d('2') }], 'extra');
    expect(extra.status).toBe(409);
    expect((await h.api(`/v1/repos/${h.repoId}/snapshot`)).version).toBe(before);
    expect((await h.list()).items.map(item => item.status)).toEqual(['open', 'open']);
    const submitted = await h.submit(2, [h.disposition(second), h.disposition(first)], 'whole');
    expect(submitted.status).toBe(201);
    expect(submitted.body.data).toMatchObject({ number: 1, findingSetVersion: 2, revision: 1, headOid: head('a'), status: 'pending' });
    expect((await h.list()).items.map(item => item.status)).toEqual(['open', 'open']);
    const accepted = await h.review(1, 2, 'accept');
    expect(accepted.status).toBe(200);
    expect((await h.list()).items.map(item => item.status)).toEqual(['resolved', 'resolved']);
    expect((await h.list()).findingSetVersion).toBe(3);
  });

  it('invalidates a pending round when a third finding arrives, then accepts a new complete round', async () => {
    const h = await fixture('find_concurrent');
    const first = (await h.add('first')).body.data as Finding;
    const second = (await h.add('second')).body.data as Finding;
    expect((await h.submit(2, [h.disposition(first), h.disposition(second)])).status).toBe(201);
    const third = (await h.add('third')).body.data as Finding;
    const oldReview = await h.review(1, 3, 'accept', 'stale-review');
    expect(oldReview.status).toBe(409);
    expect(oldReview.body.error.code).toBe('ROUND_STALE');
    expect((await h.list()).items.every(item => item.status === 'open')).toBe(true);
    expect((await h.submit(2, [h.disposition(first), h.disposition(second)], 'stale-set')).status).toBe(409);
    const next = await h.submit(3, [first, second, third].map(h.disposition), 'next');
    expect(next.status).toBe(201);
    expect(next.body.data.number).toBe(2);
    expect((await h.review(2, 3, 'accept', 'accept-next')).status).toBe(200);
    expect((await h.list()).items.every(item => item.status === 'resolved')).toBe(true);
  });

  it('rejects changed head, preserves moved anchors and open findings, and permits a new numbered round', async () => {
    const h = await fixture('find_head');
    const item = (await h.add('moved line', { semanticAnchor: { kind: 'unit', key: 'row:alpha', path: 'old.tsv', line: 10 } })).body.data as Finding;
    expect((await h.submit(1, [h.disposition(item)])).status).toBe(201);
    await h.setHead(head('b'), 2);
    const stale = await h.review(1, 1, 'accept', 'stale-head', 2);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('ROUND_STALE');
    const moved = (await h.list()).items[0];
    expect(moved).toMatchObject({ findingId: item.findingId, status: 'open', originRevision: 1,
      semanticAnchor: { kind: 'unit', key: 'row:alpha', path: 'old.tsv', line: 10 } });
    const next = await h.submit(1, [h.disposition(item)], 'new-head', 2);
    expect(next.body.data.number).toBe(2);
    expect((await h.review(2, 1, 'accept', 'review-new-head', 2)).status).toBe(200);
    expect((await h.list()).items[0].resolvedAtRevision).toBe(2);
  });

  it('rejects a whole round, prevents repeated review, and retains audit events', async () => {
    const h = await fixture('find_reject');
    const first = (await h.add('first')).body.data as Finding;
    const second = (await h.add('second')).body.data as Finding;
    await h.submit(2, [h.disposition(first), h.disposition(second)]);
    const rejected = await h.review(1, 2, 'reject');
    expect(rejected.status).toBe(200);
    expect((await h.list()).items.every(item => item.status === 'open')).toBe(true);
    const repeat = await h.review(1, 2, 'reject', 'repeat');
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('ROUND_CLOSED');
    const secondRound = await h.submit(2, [h.disposition(first), h.disposition(second)], 'retry');
    expect(secondRound.body.data.number).toBe(2);
    const expectedVersion = (await h.api(`/v1/repos/${h.repoId}/snapshot`)).version;
    const reviewBody = { expectedVersion, revision: 1, findingSetVersion: 2, decision: 'accept', evidenceDigest: d('9') };
    const reviewPath = `${h.root}/repairs/2/review`;
    const accepted = await fetchApi(mutation(reviewPath, reviewBody, 'accept-retry', 'local-reviewer'));
    expect(accepted.status).toBe(200);
    const replay = await fetchApi(mutation(reviewPath, reviewBody, 'accept-retry', 'local-reviewer'));
    expect(replay.status).toBe(200);
    expect((await responseBody(replay)).eventSeq).toBe((await responseBody(accepted)).eventSeq);
    const newKeyRepeat = await fetchApi(mutation(reviewPath, reviewBody, 'new-key', 'local-reviewer'));
    expect(newKeyRepeat.status).toBe(409);
    const history = (await h.api(`/v1/repos/${h.repoId}/events`)).data.items as Array<{ kind: string; payload: Record<string, unknown> }>;
    expect(history.map(event => event.kind)).toContain('repair.rejected');
    expect(history.map(event => event.kind)).toContain('repair.accepted');
    expect(history.find(event => event.kind === 'repair.submitted')?.payload.dispositions).toHaveLength(2);
  });

  it('forbids author self review even with both roles and reopens an old stable ID with new evidence', async () => {
    const h = await fixture('find_reopen');
    const item = (await h.add('unknown scope', { semanticAnchor: { kind: 'unknown', key: 'unmapped syntax' } })).body.data as Finding;
    await h.submit(1, [h.disposition(item)]);
    const selfPath = `${h.root}/repairs/1/review`;
    const version = (await h.api(`/v1/repos/${h.repoId}/snapshot`)).version;
    const self = await runInDurableObject(h.stub, instance => instance.fetch(new Request(`https://concord.test${selfPath}`, {
      method: 'POST', headers: { 'x-concord-principal': JSON.stringify({ tenantId: 'local', principalId: 'owner', roles: ['owner', 'reviewer'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER }),
        'idempotency-key': 'dual-role-review', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: version, revision: 1, findingSetVersion: 1, decision: 'accept', evidenceDigest: d('9') }),
    })));
    expect(self.status).toBe(403);
    expect((await responseBody(self)).error.code).toBe('SELF_REVIEW');
    expect((await h.review(1, 1, 'accept')).status).toBe(200);
    await h.setHead(head('b'), 2);
    expect((await h.list()).items[0]).toMatchObject({ findingId: item.findingId, status: 'resolved', originRevision: 1 });
    expect((await h.list()).findingSetVersion).toBe(2);
    const reopened = await h.add('new evidence', { revision: 2, reopenFindingId: item.findingId,
      semanticAnchor: { kind: 'unknown', key: 'unmapped syntax', path: 'renamed.tsv', line: 90 }, evidenceDigest: d('3') });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ findingId: item.findingId, originRevision: 1, evidenceDigest: d('3'), status: 'open' });
    const current = await h.list();
    expect(current.items).toHaveLength(1);
    expect(current.findingSetVersion).toBe(3);
    const events = (await h.api(`/v1/repos/${h.repoId}/events`)).data.items as Array<{ kind: string; payload: Record<string, unknown> }>;
    expect(events.find(event => event.kind === 'finding.created')?.payload.evidenceDigest).toBe(d('1'));
    expect(events.find(event => event.kind === 'finding.reopened')?.payload.previousEvidenceDigest).toBe(d('1'));
    expect(events.find(event => event.kind === 'finding.reopened')?.payload.previousResolution).toEqual({
      repairRound: 1, resolvedAtRevision: 1, resolvingReviewerId: 'reviewer',
    });
  });

  it('exposes the live gate snapshot to other modules and freezes findings mutations', async () => {
    const h = await fixture('find_gate');
    const path = `/v1/repos/${h.repoId}/test-findings-gate`;
    const route: ModuleRoute = { method: 'GET', pattern: /^\/v1\/repos\/find_gate\/test-findings-gate$/,
      handle: context => json(context.call('findings.gate', h.change.changeId, context.readChange!(h.change.changeId).status === 'eligible' ?
        (context.readChange!(h.change.changeId) as { value: { revision: number } }).value.revision : 0)) };
    findings.routes.unshift(route);
    try {
      const item = (await h.add('gate')).body.data as Finding;
      const projection = (await h.api(`/v1/repos/${h.repoId}/snapshot`)).data.projections.findings;
      expect(projection.items).toMatchObject([{ findingId: item.findingId, status: 'open' }]);
      expect(projection.findingSetVersions[h.change.changeId]).toBe(1);
      expect((await h.api(path)).data.value).toEqual({ findingSetVersion: 1, unresolvedIds: [item.findingId], pendingRound: null });
      await h.submit(1, [h.disposition(item)]);
      expect((await h.api(path)).data.value.pendingRound).toBe(1);
      await h.setHead(head('b'), 2);
      expect((await h.api(path)).data.value).toEqual({ findingSetVersion: 1, unresolvedIds: [item.findingId], pendingRound: null });
      expect((await h.api(`/v1/repos/${h.repoId}/snapshot`)).data.projections.findings.rounds[0].status).toBe('invalidated');
      await runInDurableObject(h.stub, (_instance, state) => {
        const store = sqlState(state.storage.sql);
        const changes = store.get<Change[]>('module:repos:changes')!;
        store.put('module:repos:changes', changes.map(change => change.changeId === h.change.changeId ? { ...change, status: 'queued' as const } : change));
      });
      const blocked = await h.add('blocked', { revision: 2 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('PROMOTION_IN_PROGRESS');
    } finally { findings.routes.splice(findings.routes.indexOf(route), 1); }
  });

  it('blocks a real verdict while findings are open and admits it after independent whole-round acceptance', async () => {
    const config = localFixtureConfig('local');
    config.policies['local-demo'].units['row:alpha'] = {
      canonicalKey: 'row:alpha', file: 'alpha.tsv', resources: [], dependencyKeys: [],
    };
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    const h = await fixture('find_verdict');
    const policy = config.policies['local-demo'];
    const profile = config.profiles['local-demo'];
    const manifest: ReviewManifest = {
      changedUnits: [{ unitKey: 'row:alpha', beforePath: 'alpha.tsv', afterPath: 'alpha.tsv',
        beforeMode: '100644', afterMode: '100644', beforeDigest: d('4'), afterDigest: d('5') }],
      policyVersion: policy.version, policyDigest: policy.digest, checkerDigest: policy.checkerDigest,
      oracleDigest: profile.oracleDigest, toolchainDigest: profile.toolchainDigest,
      coverage: 'complete', dependencyScope: [],
    };
    const digest = manifestDigest(manifest, policy, ['row:alpha']);
    await runInDurableObject(h.stub, (_instance, state) => {
      const store = sqlState(state.storage.sql);
      store.put(`module:verdicts:inspection:${h.change.changeId}`, {
        changeId: h.change.changeId, revision: 1,
        candidate: { changeId: h.change.changeId, revision: 1, baseOid: head('0'), headOid: head('a'),
          storageName: h.change.candidateStorageName, ref: h.change.branch },
        canonicalStorageName: 'canonical', policyId: 'local-demo', profileId: 'local-demo',
        reviewManifest: manifest, reviewManifestDigest: digest, outcome: 'PASS',
      } satisfies InspectedRevision);
    });
    const item = (await h.add('review concern')).body.data as Finding;
    const verdictBody = { revision: 1, reviewManifestDigest: digest, findingSetVersion: 1, decision: 'approve', evidenceDigest: d('6') };
    const pending = await h.post('verdicts', verdictBody, 'verdict-open', 'local-reviewer');
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('REVIEW_REQUIRED');
    await h.submit(1, [h.disposition(item)]);
    const stillPending = await h.post('verdicts', verdictBody, 'verdict-pending', 'local-reviewer');
    expect(stillPending.status).toBe(409);
    expect((await h.review(1, 1, 'accept')).status).toBe(200);
    const readyBody = { ...verdictBody, findingSetVersion: 2 };
    const carriedFrom = { sourceOid: head('b'), method: 'patch-id' };
    for (const [name, invalid] of Object.entries({
      oid: { sourceOid: 'bad', method: 'patch-id' },
      arrayOid: { sourceOid: [head('b')], method: 'patch-id' },
      numberOid: { sourceOid: 123, method: 'patch-id' },
      objectOid: { sourceOid: { oid: head('b') }, method: 'patch-id' },
      arrayMethod: { sourceOid: head('b'), method: ['patch-id'] },
      numberMethod: { sourceOid: head('b'), method: 123 },
      objectMethod: { sourceOid: head('b'), method: { value: 'patch-id' } },
      method: { sourceOid: head('b'), method: 'tree' },
      sameHead: { sourceOid: head('a'), method: 'patch-id' },
    })) {
      const rejected = await h.post('verdicts', { ...readyBody, carriedFrom: invalid }, `verdict-invalid-${name}`, 'local-reviewer');
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('INVALID_CARRIED_FROM');
    }
    const rejectedCarry = await h.post('verdicts', { ...readyBody, decision: 'reject', carriedFrom }, 'verdict-reject-carry', 'local-reviewer');
    expect(rejectedCarry.status).toBe(400);
    const approved = await h.post('verdicts', { ...readyBody, carriedFrom }, 'verdict-clear', 'local-reviewer');
    expect(approved.status).toBe(201);
    expect(approved.body.data.findingSetVersion).toBe(2);
    expect(approved.body.data.carriedFrom).toEqual(carriedFrom);
    const full = await h.api(`${h.root}/verdicts`, 'local-owner');
    expect(full.data.items[0].carriedFrom).toEqual(carriedFrom);
    const reduced = await h.api(`${h.root}/verdicts`, 'local-agent-a');
    expect(reduced.data.items[0]).not.toHaveProperty('carriedFrom');
  });
});
