import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { FakeStorage } from '../../src/storage/fake';
import { sqlState } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';
import { runInDurableObject } from 'cloudflare:test';
import type { RepoCoordinator } from '../../src/coordinator';

const fetchApi = (request: Request) => worker.fetch(request, env);
const firstOid = '1'.repeat(40);
const secondOid = '2'.repeat(40);
const treeOid = 'a'.repeat(40);

async function createRepo(name: string) {
  const response = await fetchApi(mutation('/v1/repos', { name, policyId: 'local-demo', profileId: 'local-demo' }, `canonical-cache-${name}`));
  expect(response.status).toBe(201);
  return (await responseBody(response)).data as { canonicalStorageName: string };
}

async function setMain(name: string, storageName: string, oid: string, content: string) {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`));
  await runInDurableObject<RepoCoordinator, void>(stub, (_instance, state) => {
    const provider = new FakeStorage(sqlState(state.storage.sql));
    provider.putCommit(storageName, { oid, treeOid, parents: [] }, { 'README.md': new TextEncoder().encode(content) });
    expect(provider.conditionalUpdateRef(storageName, 'refs/heads/main', oid === firstOid ? null : firstOid, oid)).toBe(true);
  });
}

describe('canonical read cache', () => {
  it('uses the recorded main OID and avoids storage reads after the first README request', async () => {
    const name = 'canonical_read_cache_same_oid';
    const repo = await createRepo(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await setMain(name, repo.canonicalStorageName, firstOid, 'first README');
    const detail = await fetchApi(apiRequest(`/v1/repos/${name}`));
    expect((await responseBody(detail)).data.observedCanonicalOid).toBe(firstOid);

    const readFile = vi.spyOn(FakeStorage.prototype, 'readFile');
    const readCommit = vi.spyOn(FakeStorage.prototype, 'readCommit');
    const resolveRef = vi.spyOn(FakeStorage.prototype, 'resolveRef');
    try {
      const first = await fetchApi(apiRequest(`/v1/repos/${name}/readme`));
      const second = await fetchApi(apiRequest(`/v1/repos/${name}/readme`));
      expect((await responseBody(first)).data.content).toBe('first README');
      expect((await responseBody(second)).data.content).toBe('first README');
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(readCommit).not.toHaveBeenCalled();
      expect(resolveRef).not.toHaveBeenCalled();
      expect((await fetchApi(apiRequest(`/v1/repos/${name}/readme`, 'invalid-token'))).status).toBe(401);
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      readFile.mockRestore();
      readCommit.mockRestore();
      resolveRef.mockRestore();
    }
  });

  it('serves new content after repo detail records a moved main OID', async () => {
    const name = 'canonical_read_cache_main_moves';
    const repo = await createRepo(name);
    await fetchApi(apiRequest(`/v1/repos/${name}`));
    await setMain(name, repo.canonicalStorageName, firstOid, 'old README');
    expect((await fetchApi(apiRequest(`/v1/repos/${name}`))).status).toBe(200);
    expect((await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/readme`)))).data.content).toBe('old README');

    await setMain(name, repo.canonicalStorageName, secondOid, 'new README');
    const detail = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}`)));
    expect(detail.data.observedCanonicalOid).toBe(secondOid);
    const moved = await responseBody(await fetchApi(apiRequest(`/v1/repos/${name}/readme`)));
    expect(moved.data).toMatchObject({ oid: secondOid, content: 'new README' });
  });
});
