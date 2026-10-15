import { describe, expect, it, vi } from 'vitest';
// @ts-ignore web/api.js is a browser JavaScript module without declarations.
import { getRepoTree } from '../../web/api.js';

describe('UI repository reads', () => {
  it('requests only the selected tree path and commit', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ data: { entries: [] }, version: 1 }));
    await getRepoTree('demo', 'src', 'a'.repeat(40), fetcher);
    expect(String(fetcher.mock.calls[0][0])).toContain('/v1/repos/demo/tree?path=src&oid=');
  });
});
