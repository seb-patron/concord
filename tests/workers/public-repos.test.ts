import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { TenantCatalog } from '../../src/catalog';
import { PUBLIC_DIRECTORY_NAME } from '../../src/contracts';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);
// A distinct IP per test keeps each anonymous read bucket fresh.
let bucket = 0;
const freshIp = () => `10.9.9.${++bucket}`;
const anonymousGet = (path: string, ip: string) => new Request(`https://concord.test${path}`, {
  headers: { 'cf-connecting-ip': ip },
});

async function createRepo(name: string, publicFlag?: boolean) {
  const body: Record<string, unknown> = { name, policyId: 'local-demo', profileId: 'local-demo' };
  if (publicFlag !== undefined) body.public = publicFlag;
  const response = await fetchApi(mutation('/v1/repos', body, `create-${name}-${String(publicFlag)}`));
  expect(response.status).toBe(201);
  return (await responseBody(response)).data;
}

describe('per-repository public flag', () => {
  it('returns the current public flag in a snapshot before any repo detail read', async () => {
    const name = 'public_flag_snapshot_first';
    await createRepo(name, true);
    const snapshot = await fetchApi(anonymousGet(`/v1/repos/${name}/snapshot`, freshIp()));
    expect(snapshot.status).toBe(200);
    const body = await responseBody(snapshot);
    expect(body.data.projections.repos.repo.public).toBe(true);
  });

  it('defaults repositories to private and lets the owner mark one public for anonymous viewers', async () => {
    const ip = freshIp();
    const name = 'public_flag_basic';
    const repo = await createRepo(name);
    expect(repo.public).toBe(false);

    // Credentialless reads on a private repo are unauthorized.
    for (const suffix of ['', '/snapshot', '/issues', '/changes']) {
      expect((await fetchApi(anonymousGet(`/v1/repos/${name}${suffix}`, ip))).status).toBe(401);
    }

    // The owner flips the flag through the repo settings path.
    const updated = await createRepo(name, true);
    expect(updated.public).toBe(true);

    // The repo detail read also warms the coordinator's cached repo record.
    const detail = await fetchApi(anonymousGet(`/v1/repos/${name}`, ip));
    expect(detail.status).toBe(200);
    const detailBody = await responseBody(detail);
    expect(detailBody.data.public).toBe(true);
    expect(detailBody.data.canonicalStorageName).toBeUndefined();

    const snapshot = await fetchApi(anonymousGet(`/v1/repos/${name}/snapshot`, ip));
    expect(snapshot.status).toBe(200);
    const snapshotBody = await responseBody(snapshot);
    expect(snapshotBody.data.projections.repos.repo.public).toBe(true);

    // Secret-bearing fields are omitted from anonymous responses.
    const snapshotText = JSON.stringify(snapshotBody).toLowerCase();
    for (const forbidden of ['storagename', 'concord-r-', 'storageremotes',
      'expectedrefs', 'unitpolicy', 'checkerid', 'checkerdigest', 'oracledigest', 'toolchaindigest',
      'environmentdigest', 'remote', 'token', 'secret', 'credential', '"jobs"', '"runners"', '"log"']) {
      expect(snapshotText).not.toContain(forbidden);
    }

    expect((await fetchApi(anonymousGet(`/v1/repos/${name}/issues`, ip))).status).toBe(200);
    expect((await fetchApi(anonymousGet(`/v1/repos/${name}/changes`, ip))).status).toBe(200);
  });

  it('returns the identical 401 error for private and unknown repositories', async () => {
    const ip = freshIp();
    const privateName = 'public_flag_private';
    await createRepo(privateName);
    for (const suffix of ['', '/snapshot', '/issues', '/changes']) {
      const privateResponse = await fetchApi(anonymousGet(`/v1/repos/${privateName}${suffix}`, ip));
      const unknownResponse = await fetchApi(anonymousGet(`/v1/repos/public_flag_unknown_zz${suffix}`, ip));
      expect(privateResponse.status).toBe(401);
      expect(unknownResponse.status).toBe(401);
      const privateBody = await privateResponse.json() as { error: unknown };
      const unknownBody = await unknownResponse.json() as { error: unknown };
      expect(privateBody.error).toEqual(unknownBody.error);
    }
  });

  it('rejects credentialless mutations on a public repository', async () => {
    const ip = freshIp();
    const name = 'public_flag_mutation';
    await createRepo(name, true);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const response = await fetchApi(new Request(`https://concord.test/v1/repos/${name}/changes`, {
        method, headers: { 'content-type': 'application/json', 'idempotency-key': `anon-${method}`, 'cf-connecting-ip': ip },
        body: JSON.stringify({}),
      }));
      expect(response.status).toBe(401);
    }
  });

  it('keeps tenant-wide routes credential-required even when a repo is public', async () => {
    const ip = freshIp();
    const name = 'public_flag_scope';
    await createRepo(name, true);
    for (const path of ['/v1/events', '/v1/repos', '/v1/principals', '/v1/me']) {
      expect((await fetchApi(anonymousGet(path, ip))).status).toBe(401);
    }
  });

  it('rejects a non-owner attempt to set the flag', async () => {
    const response = await fetchApi(mutation('/v1/repos',
      { name: 'public_flag_agent', policyId: 'local-demo', profileId: 'local-demo', public: true },
      'agent-public-create', 'local-agent-a'));
    expect(response.status).toBe(403);
  });

  it('rejects an invalid credential on a public repo instead of downgrading to anonymous', async () => {
    const ip = freshIp();
    const name = 'public_flag_badcred';
    await createRepo(name, true);
    const response = await fetchApi(new Request(`https://concord.test/v1/repos/${name}/snapshot`, {
      headers: { authorization: 'Bearer local-bogus', 'cf-connecting-ip': ip },
    }));
    expect(response.status).toBe(401);
    expect((await responseBody(response)).error.code).toBe('UNAUTHORIZED');
  });

  it('serves credentialed principals exactly as before on a public repo', async () => {
    const name = 'public_flag_credentialed';
    await createRepo(name, true);
    const response = await fetchApi(apiRequest(`/v1/repos/${name}`, 'local-agent-a'));
    expect(response.status).toBe(200);
    const body = await responseBody(response);
    expect(body.data.public).toBe(true);
    // Credentialed reads keep the full record, including storage locations.
    expect(body.data.canonicalStorageName).toMatch(/^concord-r-/);
  });

  it('restores private access when the owner turns the flag back off', async () => {
    const ip = freshIp();
    const name = 'public_flag_toggle';
    await createRepo(name, true);
    expect((await fetchApi(anonymousGet(`/v1/repos/${name}/snapshot`, ip))).status).toBe(200);
    const off = await createRepo(name, false);
    expect(off.public).toBe(false);
    expect((await fetchApi(anonymousGet(`/v1/repos/${name}/snapshot`, ip))).status).toBe(401);
  });

  it('fails closed when directory removal fails after catalog revocation', async () => {
    const ip = freshIp();
    const name = 'public_flag_failed_revoke';
    await createRepo(name, true);
    const originalFetch = TenantCatalog.prototype.fetch;
    const spy = vi.spyOn(TenantCatalog.prototype, 'fetch').mockImplementation(function (this: TenantCatalog, request) {
      if (new URL(request.url).pathname === '/internal/repo-directory' && request.method === 'POST') {
        return Promise.resolve(new Response('directory unavailable', { status: 503 }));
      }
      return originalFetch.call(this, request);
    });
    try {
      const revoked = await fetchApi(mutation('/v1/repos',
        { name, policyId: 'local-demo', profileId: 'local-demo', public: false }, `revoke-${name}`));
      expect(revoked.status).toBe(503);
      const listed = await fetchApi(apiRequest('/v1/repos'));
      expect((await responseBody(listed)).data.items.find((repo: { repoId: string }) => repo.repoId === name).public).toBe(false);
      const read = await fetchApi(anonymousGet(`/v1/repos/${name}/snapshot`, ip));
      expect(read.status).toBe(401);
    } finally { spy.mockRestore(); }
    const retry = await fetchApi(mutation('/v1/repos',
      { name, policyId: 'local-demo', profileId: 'local-demo', public: false }, `retry-revoke-${name}`));
    expect(retry.status).toBe(201);
  });

  it('keeps another tenant from replacing or deleting a public directory entry', async () => {
    const name = 'public_flag_global_name';
    await createRepo(name, true);
    const directory = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(PUBLIC_DIRECTORY_NAME));
    for (const publicFlag of [true, false]) {
      const response = await directory.fetch(new Request('https://concord.internal/internal/repo-directory', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-concord-tenant': 'other-tenant' },
        body: JSON.stringify({ repoId: name, public: publicFlag }),
      }));
      expect(response.status).toBe(409);
    }
    expect((await fetchApi(anonymousGet(`/v1/repos/${name}/snapshot`, freshIp()))).status).toBe(200);
  });

  it('publishes an own-key-sensitive but valid repository name', async () => {
    await createRepo('__proto__', true);
    expect((await fetchApi(anonymousGet('/v1/repos/__proto__/snapshot', freshIp()))).status).toBe(200);
  });

  it('allows 25 anonymous reads while the failed-auth limiter is exhausted', async () => {
    const name = 'public_flag_separate_limits';
    await createRepo(name, true);
    const authLimit = vi.fn(async () => ({ success: false }));
    const seen = new Map<string, number>();
    const anonLimit = vi.fn(async ({ key }: { key: string }) => {
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return { success: count <= 300 };
    });
    const limitedEnv = { ...env, AUTH_RATE_LIMIT: { limit: authLimit }, ANON_READ_LIMIT: { limit: anonLimit } } as Env;
    const ip = freshIp();
    for (let i = 0; i < 25; i++) {
      expect((await worker.fetch(anonymousGet(`/v1/repos/${name}/snapshot`, ip), limitedEnv)).status).toBe(200);
    }
    expect(authLimit).not.toHaveBeenCalled();
    expect(anonLimit).toHaveBeenCalledTimes(25);
    expect(anonLimit).toHaveBeenCalledWith({ key: `${ip}:${name}` });
  });

  it('returns a retry hint when the anonymous read limiter is exhausted', async () => {
    const name = 'public_flag_read_limited';
    await createRepo(name, true);
    const authLimit = vi.fn(async () => ({ success: true }));
    const anonLimit = vi.fn(async () => ({ success: false }));
    const limitedEnv = { ...env, AUTH_RATE_LIMIT: { limit: authLimit }, ANON_READ_LIMIT: { limit: anonLimit } } as Env;
    const response = await worker.fetch(anonymousGet(`/v1/repos/${name}/snapshot`, freshIp()), limitedEnv);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect((await responseBody(response)).error.code).toBe('READ_RATE_LIMITED');
    expect(authLimit).not.toHaveBeenCalled();
  });
});
