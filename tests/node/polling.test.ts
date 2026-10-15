import { describe, expect, it } from 'vitest';
import { ConcordClient } from '../../cli/client';

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
});
