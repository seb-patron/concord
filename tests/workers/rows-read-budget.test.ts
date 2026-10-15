import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import { apiRequest } from '../helpers';

describe('snapshot cache read guard', () => {
  it('serves a snapshot and an ETag 304 without changing the response contract', async () => {
    const repo = `rows_budget_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const first = await worker.fetch(apiRequest(`/v1/repos/${repo}/snapshot`), env);
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    const cached = await worker.fetch(new Request(`https://concord.test/v1/repos/${repo}/snapshot`, {
      headers: { authorization: 'Bearer local-owner', 'if-none-match': etag! },
    }), env);
    expect(cached.status).toBe(304);
  });
});
