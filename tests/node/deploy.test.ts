import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { checkLocal, checkRemote, main } from '../../deploy/preflight.ts';

describe('deployment preflight', () => {
  it('accepts the checked-in local and production configurations without account credentials', async () => {
    const result = await checkLocal(process.cwd(), { ...process.env, CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined });
    expect(result).toMatchObject({ status: 'ready', reason: 'remote deployment unavailable: owner credentials required' });
    expect(result.checks).toContain('content and credentials: safe defaults');
  });

  it('rejects unsafe content and bridge use in production mode', async () => {
    expect((await checkLocal(process.cwd(), { ...process.env, CONCORD_SHOW_DECOMPILED_C: '1' })).reason).toMatch(/decompiled C/);
    expect((await checkLocal(process.cwd(), { ...process.env, CONCORD_MODE: 'production', STORAGE_BACKEND: 'bridge', BRIDGE_URL: 'http://127.0.0.1:8788' })).reason).toMatch(/local Git bridge/);
    expect((await checkLocal(process.cwd(), { ...process.env, AUTH_TOKENS: 'local-owner' })).reason).toMatch(/fixture credentials/);
    const fixtureDigest = createHash('sha256').update('local-owner').digest('hex');
    expect((await checkLocal(process.cwd(), { ...process.env, AUTH_TOKENS: JSON.stringify({ [fixtureDigest]: { principalId: 'owner' } }) })).reason).toMatch(/fixture credentials/);
  });

  it('reports missing owner credentials without probing the network', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await checkRemote({ ...process.env, CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined }, fetcher);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'owner credentials required' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks the owner account Artifacts namespace using only supplied credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, result: { namespace: 'concord-demo' } }), { status: 200 }));
    const result = await checkRemote({ ...process.env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-token' }, fetcher);
    expect(result.status).toBe('ready');
    expect(fetcher).toHaveBeenCalledWith('https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/artifacts/namespaces/concord-demo',
      expect.objectContaining({ headers: { Authorization: 'Bearer private-token' } }));
  });

  it('reports an unavailable namespace without exposing provider response content', async () => {
    const result = await checkRemote({ ...process.env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-token' },
      async () => new Response('private-token', { status: 403 }));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'Artifacts namespace unavailable (HTTP 403)' });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('requires one explicit mode', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(await main([])).toBe(2); expect(await main(['--local', '--remote'])).toBe(2); }
    finally { error.mockRestore(); }
  });
});
