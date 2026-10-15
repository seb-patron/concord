import { describe, expect, it, vi } from 'vitest';
import { ConcordClient } from '../../cli/client';
import { repoVersion } from '../../cli/version';

describe('repository version probe', () => {
  it('reads the version from an empty events page', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json({ data: { items: [] }, version: 42 }));
    const client = new ConcordClient({ url: 'https://concord.invalid', fetch: fetcher as typeof fetch });
    await expect(repoVersion(client, '/repos/demo')).resolves.toBe(42);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://concord.invalid/v1/repos/demo/events?after=9007199254740991&limit=1');
  });
});
