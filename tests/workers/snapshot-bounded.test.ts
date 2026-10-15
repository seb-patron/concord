import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { sqlState } from '../../src/state';
import { apiRequest, responseBody } from '../helpers';

describe('bounded snapshot history', () => {
  it('returns all live changes and only the newest 50 terminal changes until history is requested', async () => {
    const repo = `bounded_snapshot_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const path = `/v1/repos/${repo}/snapshot`;
    await worker.fetch(apiRequest(path), env);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject(stub, (_instance, state) => {
      const records = Array.from({ length: 300 }, (_, index) => ({
        changeId: `change-${index}`, status: index < 10 ? 'ready' : 'merged',
        revision: 1, authorId: 'agent', candidateStorageName: `candidate-${index}`,
      }));
      sqlState(state.storage.sql).put('module:repos:changes', records);
      const store = sqlState(state.storage.sql);
      store.put('repo:version', (store.get<number>('repo:version') ?? 0) + 1);
    });

    const bounded = await responseBody(await worker.fetch(apiRequest(path), env));
    const projection = bounded.data.projections.repos;
    expect(projection.changes).toHaveLength(60);
    expect(projection.changes.filter((change: { status: string }) => change.status === 'ready')).toHaveLength(10);
    expect(projection.olderChanges).toBe(240);

    const full = await responseBody(await worker.fetch(apiRequest(`${path}?history=1`), env));
    expect(full.data.projections.repos.changes).toHaveLength(300);
    expect(full.data.projections.repos.olderChanges).toBeUndefined();
  });
});
