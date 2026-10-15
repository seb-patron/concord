import { describe, expect, it } from 'vitest';
// @ts-ignore web/api.js is a browser JavaScript module without declarations.
import { clearSessionToken, getSnapshot, setSessionToken } from '../../web/api.js';

describe('UI snapshot loading', () => {
  it('shares one in-flight snapshot fetch', async () => {
    let calls = 0;
    const fetcher = async (_input: RequestInfo | URL) => { calls++; await Promise.resolve(); return Response.json({ data: {}, version: 1 }, { headers: { etag: '"v1"' } }); };
    setSessionToken('ui-test');
    try {
      await Promise.all([getSnapshot('demo', fetcher), getSnapshot('demo', fetcher)]);
      expect(calls).toBe(1);
    } finally { clearSessionToken(); }
  });
});
