import { describe, expect, it, vi } from 'vitest';
import { authenticate } from '../../src/auth';
import type { Principal } from '../../src/contracts';
import { apiRequest } from '../helpers';

describe('delegated principal lookup', () => {
  it('checks revocation on every request without caching the principal', async () => {
    let now = 1_800_000_000_000;
    const principal: Principal = { tenantId: 'cachetenant', principalId: 'cached-agent', roles: ['agent'], repoIds: '*', expiresAt: now + 120_000 };
    let lookups = 0;
    let revoked = false;
    const fetch = vi.fn(async () => {
      lookups++;
      return Response.json({ data: revoked ? null : { ...principal, expiresAt: now + 120_000 } });
    });
    const env = { CONCORD_MODE: 'production', AUTH_TOKENS: JSON.stringify({ owner: { ...principal, principalId: 'owner', roles: ['owner'] } }),
      TENANT_CATALOG: { idFromName: (name: string) => name, get: () => ({ fetch }) } } as unknown as Env;
    const token = `cct_cachetenant_${'c'.repeat(64)}`;
    const request = apiRequest('/v1/repos', token);
    const clock = () => now;

    await expect(authenticate(request, env, clock)).resolves.toMatchObject({ principalId: 'cached-agent' });
    await expect(authenticate(request, env, clock)).resolves.toMatchObject({ principalId: 'cached-agent' });
    expect(lookups).toBe(2);
    revoked = true;
    await expect(authenticate(request, env, clock)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(lookups).toBe(3);
  });
});
