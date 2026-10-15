import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { Change } from '../../src/contracts';
import { issuesFeature } from '../../src/features/issues';
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
  it('lets agents create milestones by default and lets owners lock creation with versioned settings', async () => {
    const repo = 'milestone_settings_case'; await setup(repo);
    expect((await get(repo, '/milestone-settings')).body.data).toEqual({ create: 'agents', version: 0 });
    expect((await get(repo, '/snapshot')).body.data.projections.issues.milestoneSettings).toEqual({ create: 'agents', version: 0 });
    expect((await post(repo, '/milestones', { title: 'Agent release' }, 'agent-default', 'local-agent-a')).status).toBe(201);
    const invalidSetting = await patch(repo, '/milestone-settings', { create: 'invalid' }, 'invalid-setting');
    expect(invalidSetting.status).toBe(422);
    expect(invalidSetting.body.error.code).toBe('INVALID_CREATE');
    expect((await patch(repo, '/milestone-settings', { create: 'owners', expectedVersion: 0 }, 'agent-setting', 'local-agent-a')).status).toBe(403);
    const locked = await patch(repo, '/milestone-settings', { create: 'owners', expectedVersion: 0 }, 'owner-setting');
    expect(locked.status).toBe(200);
    expect(locked.body.data).toMatchObject({ create: 'owners', version: expect.any(Number) });
    expect((await get(repo, '/snapshot')).body.data.projections.issues.milestoneSettings).toEqual(locked.body.data);
    expect((await get(repo, '/events')).body.data.items.map((event: { kind: string }) => event.kind)).toContain('milestone.settings_updated');
    expect((await post(repo, '/milestone-settings', {}, 'post-settings')).status).toBe(404);
    const missingVersion = await patch(repo, '/milestone-settings', { create: 'agents' }, 'missing-setting-version');
    expect(missingVersion.body.error.code).toBe('EXPECTED_VERSION_REQUIRED');
    expect((await patch(repo, '/milestone-settings', { create: 'agents', expectedVersion: 0 }, 'stale-setting')).body.error.code).toBe('STALE_VERSION');
    expect((await post(repo, '/milestones', { title: 'Agent denied' }, 'agent-locked', 'local-agent-a')).body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Owner required' });
    const ownerMilestone = await post(repo, '/milestones', { title: 'Owner release' }, 'owner-locked');
    expect(ownerMilestone.status).toBe(201);
    expect((await post(repo, '/milestones', { title: 'Reviewer denied' }, 'reviewer-milestone', 'local-reviewer')).status).toBe(403);
    expect((await post(repo, `/milestones/${ownerMilestone.body.data.milestoneId}/close`, { expectedVersion: ownerMilestone.body.data.version }, 'agent-close-milestone', 'local-agent-a')).status).toBe(403);
    const issue = await post(repo, '/issues', { title: 'Close check' }, 'milestone-close-issue', 'local-agent-a');
    expect((await post(repo, `/issues/${issue.body.data.number}/close`, { expectedVersion: issue.body.data.version, reason: 'Done' }, 'agent-close-issue', 'local-agent-a')).status).toBe(200);
  });

  it('creates sequential issues, filters and pages, and rejects stale edits', async () => {
    const repo = 'issue_crud_case'; await setup(repo);
    const first = await post(repo, '/issues', { title: 'First task', body: '## Spec', labels: ['needs-review'] }, 'i1', 'local-agent-a');
    expect(first.status).toBe(201); expect(first.body.data).toMatchObject({ number: 1, authorId: 'agent-a', state: 'open', closedAt: null });
    expect(first.body.data.createdAt).toEqual(expect.any(Number));
    expect(first.body.data.updatedAt).toBe(first.body.data.createdAt);
    const second = await post(repo, '/issues', { title: 'Second task', body: '', labels: [] }, 'i2');
    expect(second.body.data.number).toBe(2);
    const page = await get(repo, '/issues?limit=1');
    expect(page.body.data.items.map((item: { number: number }) => item.number)).toEqual([1]);
    expect((await get(repo, `/issues?cursor=${page.body.data.nextCursor}`)).body.data.items[0].number).toBe(2);
    expect((await get(repo, '/issues?label=needs-review')).body.data.items).toHaveLength(1);
    const edited = (await patch(repo, '/issues/1', { expectedVersion: first.body.data.version, title: 'Revised' }, 'edit', 'local-agent-a')).body.data;
    expect(edited.title).toBe('Revised');
    expect(edited.updatedAt).toEqual(expect.any(Number));
    expect(edited.updatedAt).toBeGreaterThanOrEqual(first.body.data.createdAt);
    expect((await patch(repo, '/issues/1', { expectedVersion: first.body.data.version, title: 'Stale' }, 'stale', 'local-agent-a')).body.error.code).toBe('STALE_VERSION');
    expect((await patch(repo, '/issues/1', { expectedVersion: first.body.data.version, title: 'Other' }, 'other', 'local-agent-b')).status).toBe(403);
    expect((await post(repo, '/issues', { title: 'Denied', body: '' }, 'denied', 'local-reviewer')).status).toBe(403);
    expect((await post(repo, '/issues', { title: 'Oversized', body: 'é'.repeat(32769) }, 'oversized')).body.error.code).toBe('INVALID_BODY');
    const revised = (await get(repo, '/issues/1')).body.data;
    const closed = await post(repo, '/issues/1/close', { expectedVersion: revised.version, reason: 'Done' }, 'close', 'local-agent-a');
    expect(closed.body.data.state).toBe('closed');
    expect(closed.body.data.closedAt).toEqual(expect.any(Number));
    expect(closed.body.data.updatedAt).toBe(closed.body.data.closedAt);
    expect((await get(repo, '/snapshot')).body.data.projections.issues.items[0]).toMatchObject({
      createdAt: first.body.data.createdAt, updatedAt: closed.body.data.updatedAt, closedAt: closed.body.data.closedAt,
    });
    const reopened = await post(repo, '/issues/1/reopen', { expectedVersion: closed.body.data.version, reason: 'More work' }, 'reopen', 'local-agent-a');
    expect(reopened.body.data.state).toBe('open');
    expect(reopened.body.data.closedAt).toBeNull();
    expect(reopened.body.data.updatedAt).toEqual(expect.any(Number));
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
    expect((await get(repo, '/issues/1')).body.data).toMatchObject({ state: 'closed', closedAt: expect.any(Number), updatedAt: expect.any(Number), closedBy: { changeId: 'linked-change', canonicalOid: 'a'.repeat(40) } });
    expect((await get(repo, `/milestones/${milestoneId}`)).body.data.progress).toEqual({ openIssues: 0, closedIssues: 1, landedChanges: 1 });
    expect((await post(repo, `/milestones/${milestoneId}/close`, { expectedVersion: created.body.data.version }, 'stale-milestone')).body.error.code).toBe('STALE_VERSION');
    const milestone = (await get(repo, `/milestones/${milestoneId}`)).body.data;
    expect((await post(repo, `/milestones/${milestoneId}/close`, { expectedVersion: milestone.version }, 'close-milestone')).body.data.state).toBe('closed');
  });

  it('reads the changes and queue blobs once for issue and milestone views', async () => {
    const repo = 'issue_parse_once'; await setup(repo);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    const principal = { tenantId: 'local', principalId: 'system', roles: [], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
    await runInDurableObject(stub, (instance, durable) => {
      const state = sqlState(durable.storage.sql);
      state.put('items', Array.from({ length: 50 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`,
        body: '', labels: [], milestoneId: 'milestone', allowedFiles: null, state: 'open', authorId: 'system', version: 1,
        reason: null, closedBy: null })));
      state.put('milestones', [{ milestoneId: 'milestone', title: 'Milestone', description: '', dueDate: null, state: 'open', version: 1 }]);
      const changes: Change[] = Array.from({ length: 100 }, (_, index) => ({
        changeId: `change-${index + 1}`, repoId: repo, authorId: 'agent', intentKey: `intent-${index + 1}`, intentText: 'task',
        candidateStorageName: 'fork', branch: 'main', baseOid: 'base', headOid: 'head', revision: 1, unitKeys: [],
        dependencyChangeIds: [], status: 'ready', issueNumber: Math.floor(index / 2) + 1, version: 1,
      }));
      state.put('module:repos:changes', changes);
      state.put('module:queue:data', { entries: changes.map(change => ({ changeId: change.changeId, state: 'admitted' })) });
      const coordinator = instance as unknown as { context: (name: 'issues', principal: object, repoId: string) => any };
      const counted = (action: (context: any) => unknown) => {
        const context = coordinator.context('issues', principal, repo);
        const counts = new Map<string, number>();
        const sql = context.sql;
        Object.defineProperty(context, 'sql', { value: new Proxy(sql, { get(target, property) {
          if (property !== 'exec') return Reflect.get(target, property, target);
          return (query: string, ...args: unknown[]) => {
            const key = args[0];
            if (typeof key === 'string' && ['module:repos:changes', 'module:queue:data'].includes(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
            return Reflect.apply(Reflect.get(target, property, target), target, [query, ...args]);
          };
        } }) });
        const value = action(context);
        expect(counts.get('module:repos:changes') ?? 0).toBeLessThanOrEqual(1);
        expect(counts.get('module:queue:data') ?? 0).toBeLessThanOrEqual(1);
        return value;
      };
      const issuesRoute = issuesFeature.routes.find(route => route.method === 'GET' && route.pattern.source.includes('issues'))!;
      const milestonesRoute = issuesFeature.routes.find(route => route.method === 'GET' && route.pattern.source.includes('milestones$'))!;
      for (const [route, url] of [[issuesRoute, `https://concord.test${path(repo)}/issues`], [milestonesRoute, `https://concord.test${path(repo)}/milestones`]] as const) {
        counted(context => route.handle(context, new Request(url), [] as unknown as RegExpMatchArray, undefined));
      }
      counted(context => issuesFeature.snapshot!(context));
    });
  });
});
