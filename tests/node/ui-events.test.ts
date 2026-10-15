import { describe, expect, it, vi } from 'vitest';
// @ts-ignore web/api.js is a browser JavaScript module without declarations.
import { getEvents } from '../../web/api.js';

describe('UI event reads', () => {
  it('requests one bounded event page from the supplied cursor', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ data: { items: [] }, version: 2 }));
    await getEvents('demo', 90, fetcher);
    expect(fetcher.mock.calls[0][0]).toBe('/v1/repos/demo/events?after=90&limit=100');
  });
});
