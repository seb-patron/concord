import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { apiRequest } from '../helpers';

describe('lease list query indexes', () => {
  it('uses the version and terminal paging indexes', async () => {
    const repo = `lease_cost_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await worker.fetch(apiRequest(`/v1/repos/${repo}/snapshot`), env);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject(stub, (_instance, state) => {
      const plans = [
        state.storage.sql.exec<{ detail: string }>('EXPLAIN QUERY PLAN SELECT version FROM leases_claims ORDER BY version DESC LIMIT 1').toArray(),
        state.storage.sql.exec<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM leases_claims WHERE version <= ? AND NOT (state IN ('active','reserved') AND expires_at > ?) ORDER BY created_at DESC, lease_id DESC LIMIT ?", 1, Date.now(), 100).toArray(),
      ].flat().map(row => row.detail).join(' ');
      expect(plans).toMatch(/leases_claims_(version|terminal)/);
    });
  });
});
