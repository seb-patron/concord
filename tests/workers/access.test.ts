import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { authenticateWithExpiry } from '../../src/auth';
import { loadTrustedConfig, localFixtureConfig } from '../../src/state';

const team = 'concord-test.cloudflareaccess.com';
const aud = 'test-access-audience';
const now = 1_800_000_000_000;
const url = 'https://concord.test/v1/session';
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const baseConfig = { ...localFixtureConfig('local'), humans: [
  { email: 'Human@Example.com', tenantId: 'local', principalId: 'phone-owner', roles: ['owner'], repoIds: ['alpha'],
    avatarUrl: 'https://avatars.example.com/human.png' },
] };
const configured = (teamDomain = team) => ({ ...env, ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud,
  TRUSTED_CONFIG: JSON.stringify(baseConfig) } as Env);

async function signer(teamDomain = team) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: crypto.randomUUID(), alg: 'RS256', use: 'sig' };
  const make = async (claims: Record<string, unknown>, privateKey = pair.privateKey, kid: string = jwk.kid) => {
    const unsigned = `${encode({ alg: 'RS256', kid })}.${encode({ iss: `https://${teamDomain}`, aud: [aud],
      exp: now / 1000 + 300, nbf: now / 1000 - 60, email: 'human@example.com', ...claims })}`;
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned)));
    return `${unsigned}.${btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`;
  };
  return { jwk, make };
}

afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare Access human authentication', () => {
  it('verifies an assertion, maps case-insensitive email, and exposes a session', async () => {
    const { jwk, make } = await signer();
    const certs = vi.fn(async () => Response.json({ keys: [jwk] }));
    vi.stubGlobal('fetch', certs);
    const assertion = await make({});
    const request = new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': assertion } });
    const result = await authenticateWithExpiry(request, configured(), () => now);
    expect(result).toMatchObject({ principal: { principalId: 'phone-owner', tenantId: 'local',
      roles: ['owner'], repoIds: ['alpha'], authMethod: 'access', expiresAt: now + 300_000 },
    expiresAt: now + 300_000 });
    expect(certs).toHaveBeenCalledWith(`https://${team}/cdn-cgi/access/certs`);
    const currentSeconds = Math.floor(Date.now() / 1000);
    const live = await make({ exp: currentSeconds + 300, nbf: currentSeconds - 60 });
    const session = await worker.fetch(new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': live } }), configured());
    expect(session.status).toBe(200);
    expect((await session.json() as { data: unknown }).data).toMatchObject({ principalId: 'phone-owner',
      roles: ['owner'], authMethod: 'access', expiresAt: (currentSeconds + 300) * 1000,
      logoutUrl: '/v1/session/signout' });
    const me = await worker.fetch(new Request('https://concord.test/v1/me', {
      headers: { 'Cf-Access-Jwt-Assertion': live },
    }), configured());
    expect((await me.json() as { data: unknown }).data).toMatchObject({ principalId: 'phone-owner',
      avatarUrl: 'https://avatars.example.com/human.png' });
    const cookie = new Request(url, { headers: { cookie: `CF_Authorization=${assertion}` } });
    expect((await authenticateWithExpiry(cookie, configured(), () => now)).principal.authMethod).toBe('access');
  });

  it('accepts only bounded HTTPS avatar URLs in trusted human mappings', () => {
    expect(loadTrustedConfig(configured()).humans?.[0].avatarUrl).toBe('https://avatars.example.com/human.png');
    for (const avatarUrl of ['http://avatars.example.com/a.png', 'not a URL', `https://${'a'.repeat(510)}`]) {
      const invalid = { ...baseConfig, humans: [{ ...baseConfig.humans[0], avatarUrl }] };
      expect(() => loadTrustedConfig({ ...configured(), TRUSTED_CONFIG: JSON.stringify(invalid) })).toThrow('TRUSTED_CONFIG_INVALID');
    }
  });

  it('rejects invalid claims, signatures, unknown keys, and unmapped humans', async () => {
    const { jwk, make } = await signer();
    const other = await signer();
    const certs = vi.fn(async () => Response.json({ keys: [jwk] }));
    vi.stubGlobal('fetch', certs);
    const authenticate = (token: string, envValue = configured()) => authenticateWithExpiry(
      new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': token } }), envValue, () => now);
    for (const claims of [
      { aud: ['wrong'] }, { iss: 'https://wrong.cloudflareaccess.com' },
      { exp: now / 1000 - 61 }, { nbf: now / 1000 + 61 },
    ]) await expect(authenticate(await make(claims))).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    await expect(authenticate(await other.make({ iss: `https://${team}` }, undefined, jwk.kid))).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    await expect(authenticate(await make({}, undefined, 'missing-kid'))).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    await expect(authenticate(await make({ email: 'nobody@example.com' }))).rejects.toMatchObject({ status: 403, code: 'HUMAN_NOT_MAPPED' });
  });

  it('keeps bearer precedence and leaves the feature off without both vars', async () => {
    const { jwk, make } = await signer();
    const certs = vi.fn(async () => Response.json({ keys: [jwk] }));
    vi.stubGlobal('fetch', certs);
    const assertion = await make({ exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) - 60 });
    const bearer = new Request(url, { headers: { authorization: 'Bearer local-owner', 'Cf-Access-Jwt-Assertion': assertion } });
    expect((await authenticateWithExpiry(bearer, configured(), () => now)).principal.principalId).toBe('owner');
    expect(certs).not.toHaveBeenCalled();
    await expect(authenticateWithExpiry(new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      { ...configured(), ACCESS_AUD: undefined }, () => now)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('sets a scoped Access cookie at sign-in and clears it before authentication at sign-out', async () => {
    const signinTeam = 'signin-test.cloudflareaccess.com';
    const { jwk, make } = await signer(signinTeam);
    vi.stubGlobal('fetch', async () => Response.json({ keys: [jwk] }));
    const assertion = await make({ exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) - 60 });
    const signin = await worker.fetch(new Request('https://concord.test/v1/session/signin', {
      headers: { 'Cf-Access-Jwt-Assertion': assertion },
    }), configured(signinTeam));
    expect(signin.status).toBe(302);
    expect(signin.headers.get('location')).toBe('/');
    expect(signin.headers.get('set-cookie')).toContain(`concord_access=${assertion}; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=`);
    expect(signin.headers.get('set-cookie')).toMatch(/Max-Age=(?:299|300)$/);
    const cookieSession = await authenticateWithExpiry(new Request(url, {
      headers: { cookie: `concord_access=${assertion}` },
    }), configured(signinTeam), () => Date.now());
    expect(cookieSession.principal.principalId).toBe('phone-owner');
    const signout = await worker.fetch(new Request('https://concord.test/v1/session/signout'), configured(signinTeam));
    expect(signout.status).toBe(302);
    expect(signout.headers.get('location')).toBe(`https://${signinTeam}/cdn-cgi/access/logout`);
    expect(signout.headers.get('set-cookie')).toContain('Path=/v1; Max-Age=0');
  });

  it('rejects cross-origin Access writes while preserving bearer writes and same-origin Access writes', async () => {
    const csrfTeam = 'csrf-test.cloudflareaccess.com';
    const { jwk, make } = await signer(csrfTeam);
    vi.stubGlobal('fetch', async () => Response.json({ keys: [jwk] }));
    const assertion = await make({ exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) - 60 });
    const call = (headers: Record<string, string>) => worker.fetch(new Request('https://concord.test/v1/repos', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
    }), configured(csrfTeam));
    const foreign = await call({ cookie: `concord_access=${assertion}`, origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    expect((await foreign.json() as any).error.code).toBe('ORIGIN_REJECTED');
    const missing = await call({ cookie: `concord_access=${assertion}` });
    expect(missing.status).toBe(403);
    expect((await missing.json() as any).error.code).toBe('ORIGIN_REJECTED');
    const same = await call({ cookie: `concord_access=${assertion}`, origin: 'https://concord.test' });
    expect((await same.json() as any).error?.code).not.toBe('ORIGIN_REJECTED');
    const bearer = await worker.fetch(new Request('https://concord.test/v1/repos', {
      method: 'POST', headers: { authorization: 'Bearer local-owner', 'content-type': 'application/json' }, body: '{}',
    }), env);
    expect((await bearer.json() as any).error?.code).not.toBe('ORIGIN_REJECTED');
  });

  it('limits refreshes for an unknown key to once per team in thirty seconds', async () => {
    const { jwk, make } = await signer();
    const certs = vi.fn(async () => Response.json({ keys: [jwk] }));
    vi.stubGlobal('fetch', certs);
    const first = await make({}, undefined, 'unknown-a');
    const second = await make({}, undefined, 'unknown-b');
    const authenticate = (token: string) => authenticateWithExpiry(new Request(url, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }), configured(), () => now + 31_000);
    await expect(authenticate(first)).rejects.toMatchObject({ status: 401 });
    await expect(authenticate(second)).rejects.toMatchObject({ status: 401 });
    expect(certs).toHaveBeenCalledTimes(1);
  });
});
