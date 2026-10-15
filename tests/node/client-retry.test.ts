import { describe, expect, it } from 'vitest';
import { ConcordClient } from '../../cli/client';

describe('ConcordClient retry backoff', () => {
  it('waits at least one second after a 503 response', async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new ConcordClient({
      url: 'https://concord.invalid',
      fetch: async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response('{"data":true}', { status: 200 }),
      sleep: async ms => { waits.push(ms); },
      random: () => 0,
    });

    await client.request('GET', '/repos');

    expect(waits).toEqual([expect.any(Number)]);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
  });

  it('honors Retry-After values of at least five seconds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new ConcordClient({
      url: 'https://concord.invalid',
      fetch: async () => ++calls === 1
        ? new Response('', { status: 503, headers: { 'Retry-After': '5' } })
        : new Response('{"data":true}', { status: 200 }),
      sleep: async ms => { waits.push(ms); },
      random: () => 0,
    });

    await client.request('GET', '/repos');

    expect(waits).toEqual([5000]);
  });

  it('backs off one then two seconds after consecutive transport failures', async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new ConcordClient({
      url: 'https://concord.invalid',
      fetch: async () => {
        if (++calls < 3) throw new Error('connection reset');
        return new Response('{"data":true}', { status: 200 });
      },
      sleep: async ms => { waits.push(ms); },
      random: () => 0,
    });

    await client.request('GET', '/repos');

    expect(waits).toEqual([1000, 2000]);
  });
});
