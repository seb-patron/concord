import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { modules } from '../../src/coordinator';
import { repos } from '../../src/features/repos';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);

afterEach(() => vi.restoreAllMocks());

async function createRepo(repoId: string) {
  const response = await fetchApi(mutation('/v1/repos', {
    name: repoId, policyId: 'local-demo', profileId: 'local-demo',
  }, `create-${repoId}`));
  expect(response.status).toBe(201);
}

describe('repository snapshot cache', () => {
  it('computes projections once per version and returns 304 for the current ETag', async () => {
    const repoId = `snapshot_cache_${crypto.randomUUID().replaceAll('-', '')}`;
    await createRepo(repoId);
    const spies = modules.map(module => vi.spyOn(module, 'snapshot'));
    const path = `/v1/repos/${repoId}/snapshot`;

    const first = await fetchApi(apiRequest(path));
    expect(first.status).toBe(200);
    const firstBody = await responseBody(first);
    const etag = first.headers.get('etag');
    expect(etag).toBe(`"v${firstBody.version}-owner-t${Math.floor(Date.now() / 15_000)}"`);
    const second = await fetchApi(apiRequest(path));
    expect(second.status).toBe(200);
    expect(await responseBody(second)).toEqual(firstBody);
    expect(spies.map(spy => spy.mock.calls.length)).toEqual(modules.map(() => 1));

    const notModified = await fetchApi(apiRequest(path, 'local-owner', { headers: { 'if-none-match': etag! } }));
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    expect(notModified.headers.get('etag')).toBe(etag);

    const changed = await fetchApi(apiRequest(`/v1/repos/${repoId}/milestone-settings`, 'local-owner', {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': `settings-${repoId}` },
      body: JSON.stringify({ create: 'owners', expectedVersion: 0 }),
    }));
    expect(changed.status).toBe(200);
    const afterMutation = await fetchApi(apiRequest(path));
    expect(afterMutation.status).toBe(200);
    expect(spies.map(spy => spy.mock.calls.length)).toEqual(modules.map(() => 2));
    expect(afterMutation.headers.get('etag')).not.toBe(etag);
  });

  it('never serves the owner visibility body to a viewer', async () => {
    const repoId = `snapshot_visibility_${crypto.randomUUID().replaceAll('-', '')}`;
    await createRepo(repoId);
    vi.spyOn(repos, 'snapshot').mockImplementation(context => ({ visibleTo: context.principal.roles[0] }));
    const path = `/v1/repos/${repoId}/snapshot`;

    const owner = await fetchApi(apiRequest(path, 'local-owner'));
    expect((await responseBody(owner)).data.projections.repos).toEqual({ visibleTo: 'owner' });
    const viewer = await fetchApi(apiRequest(path, 'local-viewer'));
    expect((await responseBody(viewer)).data.projections.repos).toEqual({ visibleTo: 'viewer' });
    expect(owner.headers.get('etag')).not.toBe(viewer.headers.get('etag'));
  });

  it('refreshes a time-dependent runner state after the offline threshold at the same version', async () => {
    const runtime = env as Env;
    const originalTestNow = runtime.CONCORD_TEST_NOW;
    runtime.CONCORD_TEST_NOW = undefined;
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const repoId = `snapshot_runner_${crypto.randomUUID().replaceAll('-', '')}`;
      await createRepo(repoId);
      const poll = await fetchApi(mutation(`/v1/repos/${repoId}/runner/poll`, {
        runnerId: 'snapshot-clock-checker', role: 'checker', supportedProfileDigests: [],
      }, `poll-${repoId}`, 'local-checker'));
      expect(poll.status).toBe(204);
      const path = `/v1/repos/${repoId}/snapshot`;
      const idle = await fetchApi(apiRequest(path));
      const idleBody = await responseBody(idle);
      expect(idleBody.data.projections.runners.runners[0].state).toBe('idle');

      now += 60_001;
      const offline = await fetchApi(apiRequest(path));
      const offlineBody = await responseBody(offline);
      expect(offlineBody.version).toBe(idleBody.version);
      expect(offlineBody.data.projections.runners.runners[0].state).toBe('offline');
      expect(offline.headers.get('etag')).not.toBe(idle.headers.get('etag'));
    } finally {
      runtime.CONCORD_TEST_NOW = originalTestNow;
    }
  });
});
