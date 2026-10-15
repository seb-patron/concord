import { describe, expect, it } from 'vitest';
import { ConcordClient } from '../../cli/client';
import { post } from '../../cli/start';

describe('bounded client polling retries', () => {
  it('waits at least the advertised Retry-After on a transient failure', async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new ConcordClient({ url: 'https://concord.invalid', random: () => 0,
      sleep: async ms => { waits.push(ms); }, fetch: async () => ++calls === 1
        ? new Response('', { status: 503, headers: { 'Retry-After': '20' } })
        : Response.json({ data: true }) });
    await client.request('GET', '/repos/demo/events');
    expect(waits[0]).toBeGreaterThanOrEqual(20_000);
  });

  it('backs off promotion retries from 500 ms to an 8 s ceiling', async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new ConcordClient({ url: 'https://concord.invalid', random: () => 0, sleep: async () => {},
      fetch: async () => ++calls <= 7
        ? Response.json({ error: { code: 'PROMOTION_IN_PROGRESS', message: 'frozen' } }, { status: 409 })
        : Response.json({ data: { ok: true }, version: 3 }) });
    const result = await post(client, '/repos/demo/leases', { changeId: 'c1' }, undefined, async ms => { waits.push(ms); });
    expect(result.data).toEqual({ ok: true });
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});
