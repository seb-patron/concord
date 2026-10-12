import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { Change } from '../../src/contracts';
import { sqlState } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);
const path = (repo: string) => `/v1/repos/${repo}`;
async function setup(repo: string) {
  expect((await fetchApi(mutation('/v1/repos', { name: repo, policyId: 'local-demo', profileId: 'local-demo' }, `create-${repo}`))).status).toBe(201);
}
async function post(repo: string, suffix: string, body: Record<string, unknown>, key: string, token = 'local-owner') {
  const response = await fetchApi(mutation(`${path(repo)}${suffix}`, body, key, token));
  return { status: response.status, body: await responseBody(response) };
}
async function patch(repo: string, suffix: string, body: Record<string, unknown>, key: string, token = 'local-owner') {
  const response = await fetchApi(apiRequest(`${path(repo)}${suffix}`, token, { method: 'PATCH', headers: { 'idempotency-key': key }, body: JSON.stringify(body) }));
  return { status: response.status, body: await responseBody(response) };
}
async function get(repo: string, suffix: string, token = 'local-viewer') {
  const response = await fetchApi(apiRequest(`${path(repo)}${suffix}`, token));
  return { status: response.status, body: await responseBody(response) };
}

describe('Concord issues and milestones', () => {
  it('creates sequential issues, filters and pages, and rejects stale edits', async () => {
    const repo = 'issue_crud_case'; await setup(repo);
    const first = await post(repo, '/issues', { title: 'First task', body: '## Spec', labels: ['needs-review'] }, 'i1', 'local-agent-a');
    expect(first.status).toBe(201); expect(first.body.data).toMatchObject({ number: 1, authorId: 'agent-a', state: 'open' });
    const second = await post(repo, '/issues', { title: 'Second task', body: '', labels: [] }, 'i2');
    expect(second.body.data.number).toBe(2);
    const page = await get(repo, '/issues?limit=1');
    expect(page.body.data.items.map((item: { number: number }) => item.number)).toEqual([1]);
    expect((await get(repo, `/issues?cursor=${page.body.data.nextCursor}`)).body.data.items[0].number).toBe(2);
    expect((await get(repo, '/issues?label=needs-review')).body.data.items).toHaveLength(1);
    expect((await patch(repo, '/issues/1', { expectedVersion: first.body.data.version, title: 'Revised' }, 'edit', 'local-agent-a')).body.data.title).toBe('Revised');
    expect((await patch(repo, '/issues/1', { expectedVersion: first.body.data.version, title: 'Stale' }, 'stale', 'local-agent-a')).body.error.code).toBe('STALE_VERSION');
    expect((await patch(repo, '/issues/1', { expectedVersion: first.body.data.version, title: 'Other' }, 'other', 'local-agent-b')).status).toBe(403);
    expect((await post(repo, '/issues', { title: 'Denied', body: '' }, 'denied', 'local-reviewer')).status).toBe(403);
    expect((await post(repo, '/issues', { title: 'Oversized', body: 'é'.repeat(32769) }, 'oversized')).body.error.code).toBe('INVALID_BODY');
    const revised = (await get(repo, '/issues/1')).body.data;
    const closed = await post(repo, '/issues/1/close', { expectedVersion: revised.version, reason: 'Done' }, 'close', 'local-agent-a');
    expect(closed.body.data.state).toBe('closed');
    const reopened = await post(repo, '/issues/1/reopen', { expectedVersion: closed.body.data.version, reason: 'More work' }, 'reopen', 'local-agent-a');
    expect(reopened.body.data.state).toBe('open');
    expect((await get(repo, '/events')).body.data.items.map((event: { kind: string }) => event.kind)).toContain('issue.reopened');
  });

  it('tracks milestone progress and closes only the issue linked to a landed change', async () => {
    const repo = 'issue_land_case'; await setup(repo);
    const created = await post(repo, '/milestones', { title: 'Release', description: '', dueDate: '2026-12-01' }, 'milestone');
    expect(created.status).toBe(201);
    const milestoneId = created.body.data.milestoneId;
    const issue = await post(repo, '/issues', { title: 'Task', body: 'Ship', milestoneId }, 'task');
    const draft = await post(repo, '/changes', { intentKey: 'linked-task', intentText: 'Task', baseOid: null, branch: 'refs/heads/task', unitKeys: [], dependencyChangeIds: [], issueNumber: issue.body.data.number }, 'change-draft');
    expect(draft.status, JSON.stringify(draft.body.error)).toBe(201);
    expect(draft.body.data.issueNumber).toBe(1);
    expect((await post(repo, '/changes', { intentKey: 'bad-task', intentText: 'Task', baseOid: null, branch: 'refs/heads/task', unitKeys: [], dependencyChangeIds: [], issueNumber: 999 }, 'bad-change')).body.error.code).toBe('ISSUE_NOT_OPEN');
    expect((await get(repo, `/milestones/${milestoneId}`)).body.data.progress).toEqual({ openIssues: 1, closedIssues: 0, landedChanges: 0 });
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject(stub, (instance, durable) => {
      const state = sqlState(durable.storage.sql);
      const change: Change = { changeId: 'linked-change', repoId: repo, authorId: 'agent-a', intentKey: 'task', intentText: 'Task', candidateStorageName: 'fork', branch: 'main', baseOid: 'base', headOid: 'head', revision: 1, unitKeys: [], dependencyChangeIds: [], status: 'ready', issueNumber: 1, version: 1 };
      state.put('module:repos:changes', [change]);
      const coordinator = instance as unknown as { context: (name: 'issues', principal: object, repoId: string) => any };
      const principal = { tenantId: 'local', principalId: 'system', roles: [], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
      expect(coordinator.context('issues', principal, repo).call('issues.validate', 1).status).toBe('eligible');
    });
    const linked = await get(repo, '/issues/1');
    expect(linked.status, JSON.stringify(linked.body.error)).toBe(200);
    expect(linked.body.data.changes).toMatchObject([{ changeId: 'linked-change', status: 'ready' }]);
    expect((await get(repo, `/milestones/${milestoneId}`)).body.data.progress.openIssues).toBe(1);
    await runInDurableObject(stub, (instance, durable) => {
      const state = sqlState(durable.storage.sql);
      state.put('module:queue:data', { generation: 0, observedMain: null, entries: [{ changeId: 'linked-change', state: 'landed' }], jobs: [], contests: [], ticket: null, bootstrap: null, activeStackJobId: null, diagnosis: null, diagnosticResults: [], finalCanonicalOid: null, coalesceUntil: null, blockedReason: null });
      const coordinator = instance as unknown as { context: (name: 'issues', principal: object, repoId: string) => any };
      const principal = { tenantId: 'local', principalId: 'system', roles: [], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
      expect(coordinator.context('issues', principal, repo).call('issues.land', 'linked-change', 'a'.repeat(40)).status).toBe('eligible');
    });
    expect((await get(repo, '/issues/1')).body.data).toMatchObject({ state: 'closed', closedBy: { changeId: 'linked-change', canonicalOid: 'a'.repeat(40) } });
    expect((await get(repo, `/milestones/${milestoneId}`)).body.data.progress).toEqual({ openIssues: 0, closedIssues: 1, landedChanges: 1 });
    expect((await post(repo, `/milestones/${milestoneId}/close`, { expectedVersion: created.body.data.version }, 'stale-milestone')).body.error.code).toBe('STALE_VERSION');
    const milestone = (await get(repo, `/milestones/${milestoneId}`)).body.data;
    expect((await post(repo, `/milestones/${milestoneId}/close`, { expectedVersion: milestone.version }, 'close-milestone')).body.data.state).toBe('closed');
  });
});
